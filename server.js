// BoatRadar: server locale. Riceve l'AIS di tutto il mondo da aisstream.io (WebSocket),
// tiene in memoria l'ultima posizione di ogni nave e serve alla pagina quelle nell'area visibile.
// Richiede Node 22+ e il pacchetto ws (npm install).

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 8765; // in cloud la porta la assegna l'hosting
const BBOX = [[[-90, -180], [90, 180]]]; // tutto il mondo: [lat, lon] sud-ovest, nord-est
const MAX_FEATURES = 6000; // oltre questo numero la pagina riceve un campione delle navi visibili
const STALE_MS = 30 * 60 * 1000;
const KEY_FILE = path.join(__dirname, 'aisstream-key.txt');

const positions = new Map(); // mmsi -> { lat, lon, sog, cog, navStat, ts }
const vessels = new Map();   // mmsi -> { mmsi, name, imo, callSign, shipType, destination, draught }
const status = { hasKey: false, connected: false, error: null, messages: 0 };

function readKey() {
  if (process.env.AISSTREAM_KEY) return process.env.AISSTREAM_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; }
}

const clean = s => (s || '').replace(/@/g, '').trim();

function vessel(mmsi) {
  let v = vessels.get(mmsi);
  if (!v) { v = { mmsi }; vessels.set(mmsi, v); }
  return v;
}

function handle(msg) {
  if (msg.error) { status.error = msg.error; return; }
  status.messages++;
  status.error = null;
  const md = msg.MetaData || {};
  const mmsi = md.MMSI;
  if (!mmsi) return;
  const v = vessel(mmsi);
  if (clean(md.ShipName)) v.name = clean(md.ShipName);

  const m = msg.Message || {};
  const pos = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport;
  if (pos) {
    positions.set(mmsi, { lat: pos.Latitude, lon: pos.Longitude, sog: pos.Sog, cog: pos.Cog,
      navStat: pos.NavigationalStatus, ts: Date.now() });
    if (m.ExtendedClassBPositionReport) { v.shipType = pos.Type; }
  }
  const st = m.ShipStaticData;
  if (st) {
    if (clean(st.Name)) v.name = clean(st.Name);
    v.imo = st.ImoNumber || null;
    v.callSign = clean(st.CallSign);
    v.shipType = st.Type;
    v.destination = clean(st.Destination);
    v.draught = st.MaximumStaticDraught || null;
  }
  const sd = m.StaticDataReport;
  if (sd) {
    if (clean(sd.ReportA?.Name)) v.name = clean(sd.ReportA.Name);
    if (clean(sd.ReportB?.CallSign)) v.callSign = clean(sd.ReportB.CallSign);
    if (sd.ReportB?.ShipType) v.shipType = sd.ReportB.ShipType;
  }
}

let retry = 1000;
let current = null;   // connessione aperta con aisstream.io
let lastMessage = 0;  // ora dell'ultimo messaggio ricevuto
function connect() {
  const key = readKey();
  status.hasKey = !!key;
  if (!key) { setTimeout(connect, 5000); return; } // riprova: la chiave può essere aggiunta a server avviato

  const ws = current = new WebSocket(process.env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream');
  let received = false;
  ws.on('open', () => {
    lastMessage = Date.now();
    console.log('aisstream.io: connesso, invio sottoscrizione');
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
      else if (!received) { received = true; console.log('aisstream.io: arrivano i dati'); }
      retry = 1000;
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

// Render (piano gratuito) spegne il servizio dopo 15 minuti senza visite e le navi in memoria si perdono:
// una visita ogni 10 minuti all'indirizzo pubblico lo tiene acceso
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => fetch(process.env.RENDER_EXTERNAL_URL + '/api/status').catch(() => {}), 10 * 60 * 1000);
}

setInterval(() => {
  const limit = Date.now() - STALE_MS;
  for (const [mmsi, p] of positions) if (p.ts < limit) positions.delete(mmsi);
  for (const mmsi of vessels.keys()) if (!positions.has(mmsi)) vessels.delete(mmsi);
}, 60000);

function json(req, res, body) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  let data = Buffer.from(JSON.stringify(body));
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { data = zlib.gzipSync(data); headers['Content-Encoding'] = 'gzip'; }
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

function locations(query) {
  const box = query.get('bbox')?.split(',').map(Number);
  const limit = Math.min(Number(query.get('limit')) || MAX_FEATURES, MAX_FEATURES);
  const hits = [];
  for (const [mmsi, p] of positions) if (inBox(box?.length === 4 && !box.some(isNaN) ? box : null, p)) hits.push([mmsi, p]);
  // campione stabile per MMSI, così le navi mostrate non cambiano a ogni aggiornamento
  const k = Math.ceil(hits.length / limit);
  const shown = k > 1 ? hits.filter(([mmsi]) => mmsi % k === 0) : hits;
  return { type: 'FeatureCollection', total: hits.length, features: shown.map(([mmsi, p]) => {
    const v = vessels.get(mmsi) || {};
    return { type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { mmsi, name: v.name, shipType: v.shipType, sog: p.sog, cog: p.cog, navStat: p.navStat,
        timestampExternal: p.ts } };
  }) };
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

http.createServer((req, res) => {
  const { pathname: url, searchParams: query } = new URL(req.url, 'http://localhost');
  if (url === '/api/locations') return json(req, res, locations(query));
  if (url === '/api/vessel') return json(req, res, vessels.get(Number(query.get('mmsi'))) || null);
  if (url === '/api/search') return json(req, res, search(query.get('q') || ''));
  if (url === '/api/status') return json(req, res, { ...status, vessels: positions.size });
  const page = { '/': 'boatradar.html', '/boatradar.html': 'boatradar.html', '/vesselfinder.html': 'vesselfinder.html' }[url];
  if (page) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, page)).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  console.log(`BoatRadar in ascolto sulla porta ${PORT}`);
  connect();
});
