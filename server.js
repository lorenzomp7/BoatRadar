// BoatRadar: server locale. Riceve l'AIS del Mediterraneo da aisstream.io (WebSocket),
// tiene in memoria l'ultima posizione di ogni nave e la serve alla pagina.
// Richiede Node 22+ (WebSocket integrato), nessuna dipendenza.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const BBOX = [[[30.0, -6.0], [46.0, 36.5]]]; // Mediterraneo: [lat, lon] sud-ovest, nord-est
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
function connect() {
  const key = readKey();
  status.hasKey = !!key;
  if (!key) { setTimeout(connect, 5000); return; } // riprova: la chiave può essere aggiunta a server avviato

  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    status.connected = true;
    ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: BBOX, FilterMessageTypes: ['PositionReport',
      'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'] }));
  };
  ws.onmessage = e => {
    try {
      handle(JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8')));
      retry = 1000;
    } catch (err) { console.error('messaggio non valido:', err.message); }
  };
  ws.onerror = () => { status.error = status.error || 'Connessione ad aisstream.io non riuscita'; };
  ws.onclose = () => {
    status.connected = false;
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 60000);
  };
}

setInterval(() => {
  const limit = Date.now() - STALE_MS;
  for (const [mmsi, p] of positions) if (p.ts < limit) positions.delete(mmsi);
  for (const mmsi of vessels.keys()) if (!positions.has(mmsi)) vessels.delete(mmsi);
}, 60000);

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/locations') {
    return json(res, { type: 'FeatureCollection', features: [...positions].map(([mmsi, p]) => ({
      type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { mmsi, sog: p.sog, cog: p.cog, navStat: p.navStat, timestampExternal: p.ts } })) });
  }
  if (url === '/api/vessels') return json(res, [...vessels.values()]);
  if (url === '/api/status') return json(res, { ...status, vessels: positions.size });
  if (url === '/' || url === '/boatradar.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'boatradar.html')).pipe(res);
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => {
  console.log(`BoatRadar su http://localhost:${PORT}`);
  connect();
});
