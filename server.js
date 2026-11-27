// BoatRadar: server locale. Riceve l'AIS di tutto il mondo da aisstream.io (WebSocket),
// tiene in memoria l'ultima posizione di ogni nave e serve alla pagina quelle nell'area visibile.
// Richiede Node 22+ e il pacchetto ws (npm install).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');
const { isValidFix, step, pruneOlder } = require('./position-check');
const { sampleByImportance, staticImportance } = require('./sample');
const { DEFAULT_LIMITS, retentionMs, parseFilter, filterKey, passesFilter, norm, normQuery, scoreFields, insertTop } = require('./public/ais-logic');

const PORT = Number(process.env.PORT) || 8765; // in cloud la porta la assegna l'hosting
const BBOX = [[[-90, -180], [90, 180]]]; // tutto il mondo: [lat, lon] sud-ovest, nord-est
const MAX_FEATURES = 6000; // oltre questo numero la pagina riceve un campione delle navi visibili
const MAX_INCLUDE = 50;    // navi chieste con include= (selezionata, preferite) aggiunte sempre alla risposta
const KEY_FILE = path.join(__dirname, 'aisstream-key.txt');
// Cache di /api/locations (punto 84): una risposta si riusa per LOCATIONS_CACHE_MS, oppure finché i dati
// non cambiano (al massimo LOCATIONS_CACHE_STABLE_MS, 60 s). LOCATIONS_CACHE_SIZE = numero di viste tenute
// (0 = cache spenta), LOCATIONS_CACHE_BYTES = tetto in byte (JSON + gzip tenuti). Ogni LOCATIONS_CACHE_CLEANUP_MS
// si tolgono le voci che non si possono più riusare. LOCATIONS_CACHE_FILTERED (punto 9) = quante di queste voci possono
// avere un filtro (al massimo LOCATIONS_CACHE_SIZE; 0 = le richieste filtrate non entrano in cache). Valori non validi =
// default (deploy/README.md).
const envNumber = (name, def) => {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : def;
};
const LOCATIONS_CACHE_MS = envNumber('LOCATIONS_CACHE_MS', 3000);
const LOCATIONS_CACHE_SIZE = envNumber('LOCATIONS_CACHE_SIZE', 50);
const LOCATIONS_CACHE_BYTES = envNumber('LOCATIONS_CACHE_BYTES', 32 * 1024 * 1024);
const LOCATIONS_CACHE_STABLE_MS = envNumber('LOCATIONS_CACHE_STABLE_MS', 60000);
const LOCATIONS_CACHE_CLEANUP_MS = envNumber('LOCATIONS_CACHE_CLEANUP_MS', 60000) || 60000;
const LOCATIONS_CACHE_FILTERED = Math.min(Math.floor(envNumber('LOCATIONS_CACHE_FILTERED', 20)), LOCATIONS_CACHE_SIZE);
// Conservazione delle posizioni (punto 8, retentionMs di public/ais-logic.js): navi in moto STALE_MOVING_MS
// (30 min), ferme, all'ancora o ormeggiate STALE_STILL_MS (6 h); 0 o valori non validi = default. I candidati di
// position-check.js restano movingMs, i dati statici 48 h. Ogni POSITIONS_CLEANUP_MS (60 s) la pulizia toglie dalla
// memoria le posizioni scadute; fino ad allora le risposte le escludono già (isLive).
// LIMITS sono i limiti effettivi, gli stessi riportati in /api/status e usati dalla pagina: una nave ferma si conserva
// almeno quanto una in moto (stillMs = max(STALE_STILL_MS, STALE_MOVING_MS), come fa retentionMs).
const envPositive = (name, def) => envNumber(name, def) || def;
const MOVING_MS = envPositive('STALE_MOVING_MS', DEFAULT_LIMITS.movingMs);
const LIMITS = Object.freeze({ movingMs: MOVING_MS, stillMs: Math.max(envPositive('STALE_STILL_MS', DEFAULT_LIMITS.stillMs), MOVING_MS) });
const POSITIONS_CLEANUP_MS = envPositive('POSITIONS_CLEANUP_MS', 60000);
// Ora in cui la posizione p smette di valere (scade quando now > expiresAt) e se vale ancora all'ora now
const expiresAt = p => p.ts + retentionMs(p, LIMITS);
const isLive = (p, now) => now <= expiresAt(p);

const positions = new Map(); // mmsi -> { lat, lon, sog, cog, heading, rot, navStat, ts, classA, staticScore }
const candidates = new Map(); // mmsi -> posizione dopo un salto, in attesa di conferma (position-check.js)
const vessels = new Map();   // mmsi -> { mmsi, name, imo, callSign, shipType, destination, draught }
const status = { hasKey: false, connected: false, error: null, messages: 0, rejected: 0 };
let dataVersion = 0;  // cresce a ogni cambio di navi o posizioni: dice se una risposta in cache è ancora attuale
// compressione con aisstream: negotiated = permessage-deflate accettato all'apertura, confirmed = CompressionEnabled
// della SubscriptionConfirmation (null finché non arriva). aisstream limita la banda delle connessioni non compresse.
status.compression = null;

function readKey() {
  if (process.env.AISSTREAM_KEY) return process.env.AISSTREAM_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

// Testo AIS: senza il riempimento (@) e i caratteri di controllo, spazi (anche interni) compattati e tolti ai lati. I nomi
// AIS sono già maiuscoli: così di solito coincidono con norm() della ricerca (punto 12) e non serve altro
const clean = s => typeof s === 'string' ? s.replace(/@/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim() : '';

// Dimensioni AIS: distanze dell'antenna da prua (A), poppa (B), sinistra (C) e dritta (D)
function setDimensions(v, d) {
  if (!d) return;
  const length = (d.A || 0) + (d.B || 0), width = (d.C || 0) + (d.D || 0);
  if (length > 0) v.length = length;
  if (width > 0) v.width = width;
}

// ETA AIS: mese, giorno, ora e minuto in UTC, senza anno (0 / 24 / 60 = non disponibile).
// Ogni campo deve essere un intero nel suo intervallo: altrimenti null (mese o giorno non validi = ETA null)
const intIn = (x, min, max) => Number.isInteger(x) && x >= min && x <= max ? x : null;
function etaOf(e) {
  const month = intIn(e?.Month, 1, 12), day = intIn(e?.Day, 1, 31);
  if (month === null || day === null) return null;
  return { month, day, hour: intIn(e.Hour, 0, 23), minute: intIn(e.Minute, 0, 59) };
}

// IMO: 7 cifre, l'ultima è la cifra di controllo (somma delle prime sei per 7, 6, 5, 4, 3, 2, modulo 10)
function isIMO(n) {
  if (!Number.isInteger(n) || n < 1000000 || n > 9999999) return false;
  const d = String(n).split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += d[i] * (7 - i);
  return sum % 10 === d[6];
}

// Prua vera AIS (TrueHeading, 9 bit): 0-359 gradi; 511 = non disponibile, gli altri valori (es. 496) non sono una prua
const hdg = h => Number.isInteger(h) && h >= 0 && h <= 359 ? h : null;
// Velocità di accostata AIS (RateOfTurn, da -127 a 127): -128 = non disponibile. La classe B non la trasmette.
const rotOf = r => Number.isInteger(r) && r >= -127 && r <= 127 ? r : null;

// Ricerca (punto 12): nome e nominativo normalizzati (norm) solo delle navi per cui sono diversi da quelli salvati (accenti,
// minuscole, - . /), così search() non li normalizza a ogni richiesta; fuori da vessels, quindi mai nelle risposte
const searchNames = new Map();   // mmsi -> { name, call }
function indexNames(mmsi, v) {
  const name = norm(v.name), call = norm(v.callSign);
  if (name !== (v.name || '') || call !== (v.callSign || '')) searchNames.set(mmsi, { name, call });
  else searchNames.delete(mmsi);
}

function vessel(mmsi) {
  let v = vessels.get(mmsi);
  if (!v) { v = { mmsi }; vessels.set(mmsi, v); }
  return v;
}

function handle(msg) {
  if (msg.error) { status.error = msg.error; return; }
  if (msg.MessageType === 'SubscriptionConfirmation') {
    // non è un messaggio AIS: non lo conto
    if (status.compression) status.compression.confirmed = msg.Message?.CompressionEnabled === true;
    status.error = null;
    return;
  }
  status.messages++;
  status.error = null;
  const md = msg.MetaData || {};
  // MMSI: intero da 1 a 9 cifre; altrimenti (stringa, 0, negativo, decimale, mancante) il messaggio non è di una nave
  const mmsi = md.MMSI;
  if (!Number.isInteger(mmsi) || mmsi <= 0 || mmsi > 999999999) return;
  dataVersion++;
  const v = vessel(mmsi), oldName = v.name, oldCall = v.callSign;
  if (clean(md.ShipName)) v.name = clean(md.ShipName);

  const m = msg.Message || {};
  const pos = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport;
  if (pos) {
    if (m.ExtendedClassBPositionReport) { v.shipType = pos.Type; setDimensions(v, pos.Dimension); }
    // heading e rot fanno parte del fix: passano anche per candidato e conferma di position-check.js
    const fix = { lat: pos.Latitude, lon: pos.Longitude, sog: pos.Sog, cog: pos.Cog,
      heading: hdg(pos.TrueHeading), rot: rotOf(pos.RateOfTurn), navStat: pos.NavigationalStatus, ts: Date.now(),
      classA: !!m.PositionReport, staticScore: staticImportance(v) };   // per il campione (sample.js), non vanno nella risposta
    // scarto posizioni non valide e salti impossibili (un salto confermato due volte è accettato)
    if (!isValidFix(pos)) status.rejected++;
    else {
      const r = step(positions.get(mmsi), candidates.get(mmsi), fix);
      if (r.accept) positions.set(mmsi, r.moving ? { ...fix, moving: true } : fix); else status.rejected++;
      if (r.candidate) candidates.set(mmsi, r.candidate); else candidates.delete(mmsi);
    }
  }
  const st = m.ShipStaticData;
  if (st) {
    if (clean(st.Name)) v.name = clean(st.Name);
    v.imo = isIMO(st.ImoNumber) ? st.ImoNumber : null;
    v.callSign = clean(st.CallSign);
    v.shipType = st.Type;
    v.destination = clean(st.Destination);
    v.draught = st.MaximumStaticDraught || null;
    setDimensions(v, st.Dimension);
    v.eta = etaOf(st.Eta);
    v.staticTs = Date.now();
  }
  const sd = m.StaticDataReport;
  if (sd) {
    if (clean(sd.ReportA?.Name)) v.name = clean(sd.ReportA.Name);
    if (clean(sd.ReportB?.CallSign)) v.callSign = clean(sd.ReportB.CallSign);
    if (sd.ReportB?.ShipType) v.shipType = sd.ReportB.ShipType;
    setDimensions(v, sd.ReportB?.Dimension);
    v.staticTs = Date.now();
  }
  if (v.name !== oldName || v.callSign !== oldCall) indexNames(mmsi, v);
  // parte statica del punteggio del campione (sample.js), ricalcolata qui perché i dati statici cambiano solo qui
  const cur = positions.get(mmsi);
  if (cur) cur.staticScore = staticImportance(v);
}

let retry = 1000;
let current = null;   // connessione aperta con aisstream.io
let lastMessage = 0;  // ora dell'ultimo messaggio ricevuto
function connect() {
  const key = readKey();
  status.hasKey = !!key;
  if (!key) { setTimeout(connect, 5000); return; } // riprova: la chiave può essere aggiunta a server avviato

  const url = process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream';
  // Diagnosi con un proxy come Proxelar (AGENTS.md): con NODE_USE_ENV_PROXY=1 Node legge HTTPS_PROXY/HTTP_PROXY,
  // ma ws apre la connessione da sé e il proxy va passato esplicitamente come agent
  const options = process.env.NODE_USE_ENV_PROXY === '1'
    ? { agent: url.startsWith('wss:') ? https.globalAgent : http.globalAgent } : {};
  const ws = current = new WebSocket(url, { ...options, perMessageDeflate: true });
  let received = false;
  ws.on('open', () => {
    lastMessage = Date.now();
    const negotiated = /permessage-deflate/.test(ws.extensions);
    status.compression = { negotiated, confirmed: null };
    console.log(`aisstream.io: connesso (compressione: ${negotiated ? 'sì' : 'no'}), invio sottoscrizione`);
    status.connected = true;
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: BBOX, FilterMessageTypes: ['PositionReport',
      'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'] }));
  });
  ws.on('message', data => {
    lastMessage = Date.now();
    try {
      const msg = JSON.parse(data.toString('utf8'));
      handle(msg);
      if (msg.error) console.error('aisstream.io rifiuta la richiesta:', msg.error);
      else if (msg.MessageType === 'SubscriptionConfirmation') {
        const on = msg.Message?.CompressionEnabled === true;
        console.log(`aisstream.io: sottoscrizione confermata (compressione: ${on ? 'sì' : 'no'})`);
        if (!on) console.warn('aisstream.io: connessione non compressa, aisstream può scartare messaggi per limitare la banda');
      } else if (!received) { received = true; console.log('aisstream.io: arrivano i dati'); }
      // l'attesa torna a 1 s solo con un vero messaggio AIS: dopo un {error} (es. chiave scaduta) o la sola
      // conferma seguiti dalla chiusura il backoff deve continuare a crescere, non riconnettersi ogni secondo
      if (!msg.error && msg.MetaData?.MMSI) retry = 1000;
    } catch (err) { console.error('messaggio non valido:', err.message); }
  });
  ws.on('error', err => {
    console.error('aisstream.io errore:', err.message);
    status.error = 'aisstream.io: ' + err.message;
    if (/\b429\b/.test(err.message)) {
      // troppe connessioni con questa chiave: aisstream va lasciato in pace per un po'
      retry = Math.max(retry, 60000);
      status.error = `aisstream.io: troppe connessioni (429), riprovo tra ${Math.round(retry / 60000)} min`;
    }
  });
  ws.on('close', (code, reason) => {
    reason = reason.toString();
    console.log(`aisstream.io: connessione chiusa (codice ${code}${reason ? ', ' + reason : ''}), riprovo tra ${retry / 1000}s`);
    if (!received && !status.error) status.error = `aisstream.io ha chiuso la connessione (codice ${code}${reason ? ': ' + reason : ''})`;
    status.connected = false;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 5 * 60000);
  });
}

// aisstream.io a volte smette di inviare dati senza chiudere la connessione: in quel caso la riapro
setInterval(() => {
  if (current?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 90000) {
    console.log('aisstream.io: nessun dato da 90s, riapro la connessione');
    current.terminate();
  }
}, 30000);

setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [mmsi, p] of positions) if (!isLive(p, now)) { positions.delete(mmsi); removed = true; }
  if (removed) dataVersion++;
  pruneOlder(candidates, now - LIMITS.movingMs);
  // i dati statici arrivano solo ogni 6 minuti: li conservo 48 ore, così una nave che riappare li ha subito
  const staticLimit = Date.now() - 48 * 3600 * 1000;
  for (const [mmsi, v] of vessels) if (!positions.has(mmsi) && !(v.staticTs > staticLimit)) { vessels.delete(mmsi); searchNames.delete(mmsi); }
}, POSITIONS_CLEANUP_MS);

// La pagina può stare su un altro dominio (GitHub Pages): le API sono pubbliche e in sola lettura,
// quindi di base le può leggere qualunque origine; CORS_ORIGIN la restringe (es. https://lorenzomp7.github.io)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const apiHeaders = () => ({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': CORS_ORIGIN, ...(CORS_ORIGIN === '*' ? {} : { Vary: 'Origin' }) });
// Accept-Encoding: «gzip» senza distinzione di maiuscole, escluso con q=0 (x-gzip e * non contano)
const acceptsGzip = req => (req.headers['accept-encoding'] || '').split(',').some(part => {
  const [name, ...params] = part.split(';').map(x => x.trim().toLowerCase());
  const q = params.find(p => p.startsWith('q='));
  return name === 'gzip' && !(q && Number(q.slice(2)) === 0);
});

function json(req, res, body) {
  const headers = apiHeaders();
  let data = Buffer.from(JSON.stringify(body));
  if (acceptsGzip(req)) { data = zlib.gzipSync(data); headers['Content-Encoding'] = 'gzip'; }
  res.writeHead(200, headers);
  res.end(data);
}

// bbox = "minLon,minLat,maxLon,maxLat"; con minLon > maxLon l'area attraversa l'antimeridiano
function inBox(box, p) {
  if (!box) return true;
  const [w, s, e, n] = box;
  if (p.lat < s || p.lat > n) return false;
  return w <= e ? p.lon >= w && p.lon <= e : p.lon >= w || p.lon <= e;
}

// Parametri di /api/locations, letti solo qui: gli stessi valori filtrano le navi e formano la chiave della
// cache, quindi due richieste con la stessa chiave hanno la stessa risposta e i parametri sconosciuti non creano
// voci nuove. Ogni nuovo parametro di /api/locations va aggiunto qui; nella chiave entrano bbox, limit e, solo se un
// filtro è attivo, la sua forma canonica (filterKey); non include, perché le richieste con include non passano dalla
// cache (vedi sendLocations) e ignorano i filtri. Senza filtro (o con soli filtri non validi) la chiave resta
// `bbox=…&limit=…` come prima del punto 9.
function locationsParams(query) {
  const box = roundBox(query.get('bbox')?.split(',').map(Number));
  // limit valido: intero da 1 a MAX_FEATURES; negativo, zero o non intero vale come il massimo
  const asked = Number(query.get('limit'));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_FEATURES) : MAX_FEATURES;
  // include=mmsi1,mmsi2 (anche ripetuto, spazi attorno ai valori ignorati): null se assente o vuoto, altrimenti
  // i primi MAX_INCLUDE MMSI validi (1-9 cifre, > 0) nell'ordine dato, senza doppioni ([] se nessuno è valido)
  const parts = query.getAll('include').flatMap(v => v.split(',')).map(x => x.trim()).filter(Boolean);
  const include = parts.length
    ? [...new Set(parts.filter(x => /^\d{1,9}$/.test(x)).map(Number).filter(n => n > 0))].slice(0, MAX_INCLUDE) : null;
  // filtri (punto 9, parseFilter di public/ais-logic.js): types e status anche ripetuti (valori uniti); gli altri
  // valgono solo se compaiono una volta. Non validi = nessun vincolo; nessun vincolo = filter null.
  const one = name => { const all = query.getAll(name); return all.length === 1 ? all[0] : null; };
  const filter = parseFilter({ types: query.getAll('types').join(','), status: query.getAll('status').join(','),
    minSog: one('minSog'), maxSog: one('maxSog'), seen: one('seen'), moving: one('moving') });
  return { box, limit, include, filter,
    key: `bbox=${box ? box.join(',') : ''}&limit=${limit}${filter ? '&' + filterKey(filter) : ''}` };
}

// bbox arrotondato verso l'esterno, così viste quasi uguali (piccoli spostamenti della mappa) condividono la
// stessa voce. Passo = potenza di 2 di grado ≥ 1/8 del lato maggiore, fra 1/64° e 0,25°: una vista di porto
// si allarga di poco, una vista grande di al massimo 0,25° per lato. bbox non valido = null (tutto il mondo).
function roundBox(box) {
  if (box?.length !== 4 || box.some(isNaN)) return null;
  let [w, s, e, n] = box;
  const crosses = w > e;   // attraversa l'antimeridiano
  const side = Math.max(crosses ? e - w + 360 : e - w, n - s);
  const step = Math.min(0.25, Math.max(1 / 64, 2 ** Math.ceil(Math.log2(side / 8)))) || 0.25; // NaN con ±Infinity
  const clamp = (x, m) => Math.max(-m, Math.min(m, x));
  w = clamp(Math.floor(w / step) * step, 180); e = clamp(Math.ceil(e / step) * step, 180);
  // sud > nord non contiene navi: arrotondare potrebbe farlo diventare una striscia valida
  if (s <= n) { s = clamp(Math.floor(s / step) * step, 90); n = clamp(Math.ceil(n / step) * step, 90); }
  if (crosses && w <= e) { w = -180; e = 180; } // attraversava l'antimeridiano e ora copre tutto
  return [w, s, e, n];
}

// Feature GeoJSON di una nave; heading e rot mancanti (null) non vanno nella risposta: undefined = chiave omessa
function shipFeature(mmsi, p) {
  const v = vessels.get(mmsi) || {};
  return { type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: { mmsi, name: v.name, shipType: v.shipType, sog: p.sog, cog: p.cog, heading: p.heading ?? undefined,
      rot: p.rot ?? undefined, navStat: p.navStat, timestampExternal: p.ts } };
}

// Navi nel bbox con una posizione ancora valida (isLive: la pulizia periodica può non averle ancora tolte) che
// passano il filtro (punto 9, prima del campione: con types=tanker a zoom mondo ci sono tutte le petroliere).
// Restituisce la FeatureCollection (fc; total = navi nel bbox che passano) e expires: l'ora in cui la prima di queste
// navi scade o, con seen, smette di essere recente, cioè fino a quando la risposta resta uguale a dati fermi (la usa
// la cache, vedi sendLocations). Gli altri criteri dipendono solo dai dati: cambiano con dataVersion.
function locations({ box, limit, filter }, now = Date.now()) {
  const hits = [];
  let expires = Infinity;
  const seenMs = filter?.seen != null ? filter.seen * 60000 : Infinity;
  for (const [mmsi, p] of positions) {
    if (!inBox(box, p)) continue;
    const end = Math.min(expiresAt(p), p.ts + seenMs);
    if (now > end) continue;
    if (filter && !passesFilter(p, vessels.get(mmsi), filter, now)) continue;
    hits.push([mmsi, p]);
    if (end < expires) expires = end;
  }
  // campione per importanza (punto 4, sample.js): oltre limit le navi più importanti, con un massimo per cella
  const shown = sampleByImportance(hits, limit, box, { staticOf: (m, p) => p.staticScore, now });
  // filter: il filtro applicato in forma canonica ('' senza filtro), così chi usa l'API vede cosa è stato accettato
  return { fc: { type: 'FeatureCollection', filter: filterKey(filter), total: hits.length, features: shown.map(([mmsi, p]) => shipFeature(mmsi, p)) }, expires };
}

// Navi chieste con include= (punto 3: la nave selezionata, più avanti le preferite): solo quelle che hanno una
// posizione, nell'ordine dato, senza bbox né campione; total = navi trovate. Sempre calcolata al momento, così la
// nave selezionata è aggiornata anche quando la vista viene dalla cache.
function included(include) {
  const now = Date.now();
  const features = include.filter(mmsi => positions.has(mmsi) && isLive(positions.get(mmsi), now))
    .map(mmsi => shipFeature(mmsi, positions.get(mmsi)));
  return { type: 'FeatureCollection', total: features.length, features };
}

// Cache di /api/locations. Una voce tiene la risposta compressa (gz); il JSON (raw) resta solo finché serve
// per comprimere, oppure se la voce è nata da una richiesta senza gzip. Ai client senza gzip una voce che ha
// solo gz si serve decomprimendola. Tetti: LOCATIONS_CACHE_SIZE voci e LOCATIONS_CACHE_BYTES byte (raw + gz);
// oltre esce la voce inserita per prima. Le voci con filtro (punto 9) hanno in più una quota loro,
// LOCATIONS_CACHE_FILTERED, e una voce filtrata che supera quota o tetti espelle la filtrata più vecchia: il traffico
// filtrato (combinazioni quasi infinite) non espelle mai le viste senza filtro, quelle della maggior parte delle pagine.
const locationsCache = new Map(); // chiave -> { key, filtered, version, t, expires, raw, keepRaw, gz: Promise<Buffer> | null, gzBuf, bytes }
const filteredKeys = new Set();   // chiavi delle voci con filtro, nell'ordine di inserimento
const cacheStats = { hits: 0, misses: 0, compressions: 0 };
let cacheBytes = 0;
const gzipAsync = require('util').promisify(zlib.gzip);
const gunzipAsync = require('util').promisify(zlib.gunzip);

function cacheRemove(key) {
  const entry = locationsCache.get(key);
  if (!entry) return;
  cacheBytes -= entry.bytes;
  locationsCache.delete(key);
  filteredKeys.delete(key);
}

// ricalcola i byte di una voce ancora in cache (dopo la compressione o dopo aver lasciato il JSON) ed espelle
function cacheResize(entry) {
  if (locationsCache.get(entry.key) === entry) {
    const bytes = (entry.raw?.length || 0) + (entry.gzBuf?.length || 0);
    cacheBytes += bytes - entry.bytes;
    entry.bytes = bytes;
  }
  while (filteredKeys.size > LOCATIONS_CACHE_FILTERED) cacheRemove(filteredKeys.values().next().value);
  while (locationsCache.size && (locationsCache.size > LOCATIONS_CACHE_SIZE || cacheBytes > LOCATIONS_CACHE_BYTES)) {
    // oltre un tetto per colpa di una voce filtrata escono solo voci filtrate (al limite lei stessa)
    const oldest = entry.filtered && filteredKeys.size ? filteredKeys.values() : locationsCache.keys();
    cacheRemove(oldest.next().value);
  }
}

// gzip asincrono; la Promise è salvata subito, così le richieste contemporanee la condividono
function compress(entry) {
  if (!entry.gz) {
    cacheStats.compressions++;
    entry.gz = gzipAsync(entry.raw).then(buf => {
      entry.gzBuf = buf;
      if (!entry.keepRaw) entry.raw = null;
      cacheResize(entry);
      return buf;
    });
  }
  return entry.gz;
}

// le voci con almeno questa età non possono più essere un hit (vedi sendLocations)
setInterval(() => {
  const limit = Date.now() - Math.max(LOCATIONS_CACHE_MS, LOCATIONS_CACHE_STABLE_MS);
  for (const [key, entry] of locationsCache) if (entry.t <= limit) cacheRemove(key);
}, LOCATIONS_CACHE_CLEANUP_MS).unref();

function sendLocations(req, res, query) {
  const params = locationsParams(query);
  // include: risposta piccola e diversa per ogni utente, fuori dalla cache condivisa (non crea voci)
  if (params.include) return json(req, res, included(params.include));
  const key = params.key, now = Date.now(), gzip = acceptsGzip(req), filtered = !!params.filter;
  const cached = (filtered ? LOCATIONS_CACHE_FILTERED : LOCATIONS_CACHE_SIZE) > 0;
  let entry = cached ? locationsCache.get(key) : undefined;
  // a dati fermi la voce vale al massimo 60 s e solo finché nessuna delle sue navi è scaduta (expires): senza
  // messaggi nuovi dataVersion non cambia, ma le navi oltre il loro limite devono comunque sparire. Entro
  // LOCATIONS_CACHE_MS (3 s) invece la voce si riusa comunque, come per i dati nuovi: una nave può restare fino a 3 s
  // oltre il suo limite (legarla anche lì alla prima scadenza spegnerebbe la cache, perché fra decine di migliaia di
  // navi ne scade una di continuo).
  const hit = !!entry && (now - entry.t < LOCATIONS_CACHE_MS
    || (entry.version === dataVersion && now - entry.t < LOCATIONS_CACHE_STABLE_MS && now <= entry.expires));
  if (hit) cacheStats.hits++;
  else {
    cacheStats.misses++;
    const { fc, expires } = locations(params, now);
    entry = { key, filtered, version: dataVersion, t: now, expires, raw: Buffer.from(JSON.stringify(fc)),
      keepRaw: !gzip, gz: null, gzBuf: null, bytes: 0 };
    if (cached) {
      cacheRemove(key);   // ricalcolata: torna in fondo all'ordine di inserimento
      locationsCache.set(key, entry);
      if (filtered) filteredKeys.add(key);
      cacheResize(entry);
    }
  }
  const headers = apiHeaders();
  headers.Vary = headers.Vary ? headers.Vary + ', Accept-Encoding' : 'Accept-Encoding';
  headers['X-Cache'] = hit ? 'hit' : 'miss';
  headers['Access-Control-Expose-Headers'] = 'X-Cache';
  const send = (data, extra = {}) => {
    res.writeHead(200, { ...headers, ...extra, 'Content-Length': data.length });
    res.end(data);
  };
  if (!gzip) {
    if (entry.raw) return send(entry.raw);
    // la voce ha solo il gzip: lo decomprimo (se non riesce la tolgo e ricalcolo)
    return gunzipAsync(entry.gzBuf).then(send, () => { cacheRemove(key); sendLocations(req, res, query); });
  }
  compress(entry).then(data => send(data, { 'Content-Encoding': 'gzip' }), () => {
    // gzip non riuscito: la voce non resta in cache e rispondo non compresso
    if (locationsCache.get(key) === entry) cacheRemove(key);
    entry.gz = null;
    send(entry.raw);
  });
}

// Ricerca (punto 12): tutte le navi con una posizione ancora valida (isLive, punto 8) con punteggio > 0 (nome, MMSI, IMO,
// nominativo: scoreFields), le prime SEARCH_MAX nell'ordine di compareSearch (punteggio, posizione più recente, MMSI),
// tenute con insertTop senza ordinare tutte le corrispondenze. Gira sul ciclo degli eventi: per non rallentare le altre
// richieste il lavoro per nave è minimo (nomi già normalizzati in vessels o searchNames, MMSI e IMO in stringa solo per
// q di cifre). q < 2 caratteri (dopo normQuery: anche senza «IMO ») = nessun risultato.
const SEARCH_MAX = 25;
function search(text) {
  const q = normQuery(text);
  if (q.length < 2) return [];
  const now = Date.now(), digits = /^\d+$/.test(q), top = [];
  for (const [mmsi, p] of positions) {
    if (!isLive(p, now)) continue;
    const v = vessels.get(mmsi) || {}, alt = searchNames.get(mmsi);
    const score = scoreFields(alt ? alt.name : v.name || '', alt ? alt.call : v.callSign || '', digits ? String(mmsi) : '',
      digits && v.imo ? String(v.imo) : '', q);
    if (!score || (top.length === SEARCH_MAX && score < top[SEARCH_MAX - 1].score)) continue;
    insertTop(top, { score, ts: p.ts, mmsi, v, p }, SEARCH_MAX);
  }
  // età nei risultati della pagina (punto 62); velocità e stato per decidere, come per /api/locations, se la nave è
  // ferma (conservata più a lungo) o se la posizione è scaduta
  return top.map(({ mmsi, v, p }) => ({ mmsi, ...v, lat: p.lat, lon: p.lon, sog: p.sog, navStat: p.navStat, timestampExternal: p.ts }));
}

// File statico della repo: le intestazioni partono solo quando il file è aperto. Se non si può
// leggere (mancante, permessi) risponde 500 e scrive il motivo nel log, senza far cadere il processo.
// cache: 'no-store' per pagina e moduli che cambiano a ogni commit; Leaflet (vendor/, versione fissa) un giorno.
function sendFile(res, file, type, cache = 'no-store') {
  const stream = fs.createReadStream(path.join(__dirname, file));
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    stream.pipe(res);
  });
  stream.on('error', err => {
    console.error(`file statico ${file}: ${err.code || err.message}`);
    if (res.headersSent) return res.destroy();
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Errore del server');
  });
  res.on('close', () => stream.destroy());
}

// File statici serviti: elenco fisso url -> [file, tipo, cache]; nessun altro file della repo è raggiungibile
// (niente percorsi costruiti dall'URL, quindi niente ../). Leaflet 1.9.4 (punto 85) è in vendor/leaflet/.
const VENDOR_CACHE = 'public, max-age=86400';
const ASSETS = {
  '/': ['boatradar.html', 'text/html; charset=utf-8'],
  '/boatradar.html': ['boatradar.html', 'text/html; charset=utf-8'],
  '/vesselfinder.html': ['vesselfinder.html', 'text/html; charset=utf-8'],
  '/public/ais-logic.js': ['public/ais-logic.js', 'text/javascript; charset=utf-8'],
  '/vendor/leaflet/leaflet.js': ['vendor/leaflet/leaflet.js', 'text/javascript; charset=utf-8', VENDOR_CACHE],
  '/vendor/leaflet/leaflet.css': ['vendor/leaflet/leaflet.css', 'text/css; charset=utf-8', VENDOR_CACHE],
};
for (const img of ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
  ASSETS['/vendor/leaflet/images/' + img] = ['vendor/leaflet/images/' + img, 'image/png', VENDOR_CACHE];
}

http.createServer((req, res) => {
  const { pathname: url, searchParams: query } = new URL(req.url, 'http://localhost');
  if (url === '/api/locations') return sendLocations(req, res, query);
  if (url === '/api/vessel') return json(req, res, vessels.get(Number(query.get('mmsi'))) || null);
  if (url === '/api/search') return json(req, res, search(query.get('q') || ''));
  // serverTime: ora del server in ms, con cui la pagina corregge l'orologio del telefono (punto 43).
  // Solo qui e non in /api/locations, che può essere servita dalla cache con un'ora vecchia.
  if (url === '/api/status') return json(req, res, { ...status, vessels: positions.size,
    locationsCache: { ...cacheStats, size: locationsCache.size, filtered: filteredKeys.size, bytes: cacheBytes }, limits: LIMITS, serverTime: Date.now() });
  if (url === '/config.js') {
    // su GitHub Pages questo file indica l'indirizzo del server; qui le API sono sullo stesso server
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('// API sullo stesso server della pagina\n');
  }
  // pagine, script e Leaflet: solo l'elenco fisso ASSETS (Object.hasOwn: niente chiavi ereditate come /constructor)
  if (Object.hasOwn(ASSETS, url)) return sendFile(res, ...ASSETS[url]);
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  console.log(`BoatRadar in ascolto sulla porta ${PORT}`);
  connect();
});
