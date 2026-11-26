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

const PORT = Number(process.env.PORT) || 8765; // in cloud la porta la assegna l'hosting
const BBOX = [[[-90, -180], [90, 180]]]; // tutto il mondo: [lat, lon] sud-ovest, nord-est
const MAX_FEATURES = 6000; // oltre questo numero la pagina riceve un campione delle navi visibili
const MAX_INCLUDE = 50;    // navi chieste con include= (selezionata, preferite) aggiunte sempre alla risposta
const STALE_MS = 30 * 60 * 1000;
const KEY_FILE = path.join(__dirname, 'aisstream-key.txt');
// Cache di /api/locations (punto 84): una risposta si riusa per LOCATIONS_CACHE_MS, oppure finché i dati
// non cambiano (al massimo LOCATIONS_CACHE_STABLE_MS, 60 s). LOCATIONS_CACHE_SIZE = numero di viste tenute
// (0 = cache spenta), LOCATIONS_CACHE_BYTES = tetto in byte (JSON + gzip tenuti). Ogni LOCATIONS_CACHE_CLEANUP_MS
// si tolgono le voci che non si possono più riusare. Valori non validi = default (deploy/README.md).
const envNumber = (name, def) => {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : def;
};
const LOCATIONS_CACHE_MS = envNumber('LOCATIONS_CACHE_MS', 3000);
const LOCATIONS_CACHE_SIZE = envNumber('LOCATIONS_CACHE_SIZE', 50);
const LOCATIONS_CACHE_BYTES = envNumber('LOCATIONS_CACHE_BYTES', 32 * 1024 * 1024);
const LOCATIONS_CACHE_STABLE_MS = envNumber('LOCATIONS_CACHE_STABLE_MS', 60000);
const LOCATIONS_CACHE_CLEANUP_MS = envNumber('LOCATIONS_CACHE_CLEANUP_MS', 60000) || 60000;

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

const clean = s => (s || '').replace(/@/g, '').trim();

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
  const mmsi = md.MMSI;
  if (!mmsi) return;
  dataVersion++;
  const v = vessel(mmsi);
  if (clean(md.ShipName)) v.name = clean(md.ShipName);

  const m = msg.Message || {};
  const pos = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport;
  if (pos) {
    if (m.ExtendedClassBPositionReport) { v.shipType = pos.Type; setDimensions(v, pos.Dimension); }
    // heading e rot fanno parte del fix: passano anche per candidato e conferma di position-check.js
    const fix = { lat: pos.Latitude, lon: pos.Longitude, sog: pos.Sog, cog: pos.Cog,
      heading: hdg(pos.TrueHeading), rot: rotOf(pos.RateOfTurn), navStat: pos.NavigationalStatus, ts: Date.now(),
      classA: !!m.PositionReport, staticScore: 0 };   // per il campione (sample.js), non vanno nella risposta
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
  const limit = Date.now() - STALE_MS;
  let removed = false;
  for (const [mmsi, p] of positions) if (p.ts < limit) { positions.delete(mmsi); removed = true; }
  if (removed) dataVersion++;
  pruneOlder(candidates, limit);
  // i dati statici arrivano solo ogni 6 minuti: li conservo 48 ore, così una nave che riappare li ha subito
  const staticLimit = Date.now() - 48 * 3600 * 1000;
  for (const [mmsi, v] of vessels) if (!positions.has(mmsi) && !(v.staticTs > staticLimit)) vessels.delete(mmsi);
}, 60000);

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

// Parametri di /api/locations, letti solo qui: gli stessi valori filtrano le navi in locations() e formano la
// chiave della cache, quindi due richieste con la stessa chiave hanno la stessa risposta e i parametri
// sconosciuti non creano voci nuove. Ogni nuovo parametro di /api/locations va aggiunto qui (anche nella chiave).
function locationsParams(query) {
  const box = roundBox(query.get('bbox')?.split(',').map(Number));
  // limit valido: intero da 1 a MAX_FEATURES; negativo, zero o non intero vale come il massimo
  const asked = Number(query.get('limit'));
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_FEATURES) : MAX_FEATURES;
  // include=mmsi1,mmsi2 (anche ripetuto): i primi MAX_INCLUDE MMSI validi (1-9 cifre, > 0) nell'ordine dato,
  // senza doppioni; ordinati nella chiave, così ordine e doppioni non creano voci nuove. Il resto è ignorato.
  const include = [...new Set(query.getAll('include').join(',').split(',')
    .filter(x => /^\d{1,9}$/.test(x)).map(Number).filter(n => n > 0))].slice(0, MAX_INCLUDE).sort((a, b) => a - b);
  return { box, limit, include, key: `bbox=${box ? box.join(',') : ''}&limit=${limit}&include=${include.join(',')}` };
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

function locations({ box, limit, include = [] }) {
  const hits = [];
  for (const [mmsi, p] of positions) if (inBox(box, p)) hits.push([mmsi, p]);
  // campione per importanza (punto 4, sample.js): oltre limit le navi più importanti, con un massimo per cella
  const shown = [...sampleByImportance(hits, limit, box, { staticOf: (m, p) => p.staticScore, now: Date.now() })];   // copia: include= non deve toccare hits
  // navi chieste con include= (punto 3): sempre presenti se hanno una posizione, anche fuori dal bbox e oltre
  // il limite, una volta sola; total resta il numero di navi nel bbox
  if (include.length) {
    const ids = new Set(shown.map(([mmsi]) => mmsi));
    for (const mmsi of include) if (!ids.has(mmsi) && positions.has(mmsi)) shown.push([mmsi, positions.get(mmsi)]);
  }
  return { type: 'FeatureCollection', total: hits.length, features: shown.map(([mmsi, p]) => {
    const v = vessels.get(mmsi) || {};
    return { type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { mmsi, name: v.name, shipType: v.shipType, sog: p.sog, cog: p.cog, heading: p.heading, rot: p.rot, navStat: p.navStat,
        timestampExternal: p.ts } };
  }) };
}

// Cache di /api/locations. Una voce tiene la risposta compressa (gz); il JSON (raw) resta solo finché serve
// per comprimere, oppure se la voce è nata da una richiesta senza gzip. Ai client senza gzip una voce che ha
// solo gz si serve decomprimendola. Tetti: LOCATIONS_CACHE_SIZE voci e LOCATIONS_CACHE_BYTES byte (raw + gz);
// oltre esce la voce inserita per prima.
const locationsCache = new Map(); // chiave -> { key, version, t, raw, keepRaw, gz: Promise<Buffer> | null, gzBuf, bytes }
const cacheStats = { hits: 0, misses: 0, compressions: 0 };
let cacheBytes = 0;
const gzipAsync = require('util').promisify(zlib.gzip);
const gunzipAsync = require('util').promisify(zlib.gunzip);

function cacheRemove(key) {
  const entry = locationsCache.get(key);
  if (!entry) return;
  cacheBytes -= entry.bytes;
  locationsCache.delete(key);
}

// ricalcola i byte di una voce ancora in cache (dopo la compressione o dopo aver lasciato il JSON) ed espelle
function cacheResize(entry) {
  if (locationsCache.get(entry.key) === entry) {
    const bytes = (entry.raw?.length || 0) + (entry.gzBuf?.length || 0);
    cacheBytes += bytes - entry.bytes;
    entry.bytes = bytes;
  }
  while (locationsCache.size && (locationsCache.size > LOCATIONS_CACHE_SIZE || cacheBytes > LOCATIONS_CACHE_BYTES)) {
    cacheRemove(locationsCache.keys().next().value);
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
  const key = params.key, now = Date.now(), gzip = acceptsGzip(req);
  let entry = LOCATIONS_CACHE_SIZE > 0 ? locationsCache.get(key) : undefined;
  const hit = !!entry && (now - entry.t < LOCATIONS_CACHE_MS
    || (entry.version === dataVersion && now - entry.t < LOCATIONS_CACHE_STABLE_MS));
  if (hit) cacheStats.hits++;
  else {
    cacheStats.misses++;
    entry = { key, version: dataVersion, t: now, raw: Buffer.from(JSON.stringify(locations(params))),
      keepRaw: !gzip, gz: null, gzBuf: null, bytes: 0 };
    if (LOCATIONS_CACHE_SIZE > 0) {
      cacheRemove(key);   // ricalcolata: torna in fondo all'ordine di inserimento
      locationsCache.set(key, entry);
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

function search(q) {
  q = q.trim().toUpperCase();
  const hits = [];
  if (q.length < 2) return hits;
  for (const v of vessels.values()) {
    const p = positions.get(v.mmsi);
    if (p && ((v.name || '').toUpperCase().includes(q) || String(v.mmsi).startsWith(q) || String(v.imo || '').startsWith(q))) {
      hits.push({ ...v, lat: p.lat, lon: p.lon });
      if (hits.length >= 25) break;
    }
  }
  return hits;
}

// File statico della repo: le intestazioni partono solo quando il file è aperto. Se non si può
// leggere (mancante, permessi) risponde 500 e scrive il motivo nel log, senza far cadere il processo.
function sendFile(res, file, type) {
  const stream = fs.createReadStream(path.join(__dirname, file));
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
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

http.createServer((req, res) => {
  const { pathname: url, searchParams: query } = new URL(req.url, 'http://localhost');
  if (url === '/api/locations') return sendLocations(req, res, query);
  if (url === '/api/vessel') return json(req, res, vessels.get(Number(query.get('mmsi'))) || null);
  if (url === '/api/search') return json(req, res, search(query.get('q') || ''));
  // serverTime: ora del server in ms, con cui la pagina corregge l'orologio del telefono (punto 43).
  // Solo qui e non in /api/locations, che può essere servita dalla cache con un'ora vecchia.
  if (url === '/api/status') return json(req, res, { ...status, vessels: positions.size,
    locationsCache: { ...cacheStats, size: locationsCache.size, bytes: cacheBytes }, serverTime: Date.now() });
  if (url === '/config.js') {
    // su GitHub Pages questo file indica l'indirizzo del server; qui le API sono sullo stesso server
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('// API sullo stesso server della pagina\n');
  }
  // script della pagina: elenco fisso, nessun altro file di public/ è servito
  const asset = { '/public/ais-logic.js': 'public/ais-logic.js' }[url];
  if (asset) return sendFile(res, asset, 'text/javascript; charset=utf-8');
  const page = { '/': 'boatradar.html', '/boatradar.html': 'boatradar.html', '/vesselfinder.html': 'vesselfinder.html' }[url];
  if (page) return sendFile(res, page, 'text/html; charset=utf-8');
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  console.log(`BoatRadar in ascolto sulla porta ${PORT}`);
  connect();
});
