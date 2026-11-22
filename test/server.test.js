// Test d'integrazione: avvia il vero server.js contro un finto aisstream.io locale
// (variabile AISSTREAM_URL) e controlla le API che usa la pagina.
// Nessuna rete esterna e nessuna chiave reale. Esegui con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');
let server, fakeAis, aisSocket, port, subscription;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function get(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const getJson = async p => JSON.parse((await get(p)).body.toString('utf8'));

async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('timeout in attesa di: ' + what);
}

// Invia un messaggio AIS e aspetta che il server l'abbia contato.
async function send(msg) {
  const before = (await getJson('/api/status')).messages;
  aisSocket.send(JSON.stringify(msg));
  await waitFor(async () => (await getJson('/api/status')).messages > before || msg.error, 'messaggio elaborato');
}

const position = (mmsi, lat, lon, extra = {}) => ({
  MetaData: { MMSI: mmsi, ShipName: extra.name || '' },
  Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: 12.5, Cog: 90, NavigationalStatus: 0 } },
});

before(async () => {
  fakeAis = new WebSocketServer({ port: 0 });
  const connected = new Promise(resolve => fakeAis.on('connection', ws => {
    aisSocket = ws;
    ws.once('message', data => { subscription = JSON.parse(data.toString()); resolve(); });
  }));
  port = await freePort();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), AISSTREAM_KEY: 'chiave-di-test',
      AISSTREAM_URL: `ws://127.0.0.1:${fakeAis.address().port}`, RENDER_EXTERNAL_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(() => get('/api/status').then(() => true, () => false), 'server in ascolto');
  await connected;
});

after(() => {
  server?.kill();
  fakeAis?.close();
});

test('si abbona ad aisstream con la chiave e i tipi di messaggio attesi', async () => {
  assert.equal(subscription.APIKey, 'chiave-di-test');
  assert.deepEqual(subscription.BoundingBoxes, [[[-90, -180], [90, 180]]]);
  for (const type of ['PositionReport', 'ShipStaticData', 'StaticDataReport']) {
    assert.ok(subscription.FilterMessageTypes.includes(type), type);
  }
  const status = await getJson('/api/status');
  assert.equal(status.hasKey, true);
  assert.equal(status.connected, true);
});

test('una posizione compare in /api/locations come Feature GeoJSON [lon, lat]', async () => {
  await send(position(247000001, 45.43, 12.33, { name: 'LAGUNA@@  ' }));
  const fc = await getJson('/api/locations');
  assert.equal(fc.type, 'FeatureCollection');
  const f = fc.features.find(x => x.mmsi === 247000001);
  assert.ok(f, 'nave presente');
  assert.deepEqual(f.geometry.coordinates, [12.33, 45.43]);
  assert.equal(f.properties.name, 'LAGUNA', 'toglie le @ di riempimento AIS e gli spazi');
  assert.equal(f.properties.sog, 12.5);
});

test('i dati statici arricchiscono la scheda nave (dimensioni, ETA, IMO)', async () => {
  await send({
    MetaData: { MMSI: 247000001 },
    Message: { ShipStaticData: { Name: 'LAGUNA EXPRESS@@', ImoNumber: 9123456, CallSign: 'IABC@', Type: 60,
      Destination: 'VENEZIA@@@', MaximumStaticDraught: 6.2, Dimension: { A: 100, B: 20, C: 10, D: 8 },
      Eta: { Month: 11, Day: 23, Hour: 24, Minute: 60 } } },
  });
  const v = await getJson('/api/vessel?mmsi=247000001');
  assert.equal(v.name, 'LAGUNA EXPRESS');
  assert.equal(v.imo, 9123456);
  assert.equal(v.callSign, 'IABC');
  assert.equal(v.destination, 'VENEZIA');
  assert.equal(v.length, 120, 'lunghezza = A + B');
  assert.equal(v.width, 18, 'larghezza = C + D');
  assert.deepEqual(v.eta, { month: 11, day: 23, hour: null, minute: null }, '24/60 = ora non disponibile');
});

test('un ETA non valido (mese 0) viene ignorato', async () => {
  await send({ MetaData: { MMSI: 247000002 }, Message: { ShipStaticData: { Name: 'SENZA ETA', Eta: { Month: 0, Day: 0 } } } });
  const v = await getJson('/api/vessel?mmsi=247000002');
  assert.equal(v.eta, undefined);
});

test('il filtro bbox gestisce anche l\'antimeridiano', async () => {
  await send(position(311000001, -17.5, 179.5));   // Figi, a est dell'antimeridiano
  await send(position(311000002, -17.5, -179.5));  // a ovest dell'antimeridiano
  const ids = async bbox => (await getJson('/api/locations?bbox=' + bbox)).features.map(f => f.mmsi).sort();
  assert.deepEqual(await ids('179,-20,-179,-15'), [311000001, 311000002], 'area che attraversa ±180°');
  assert.deepEqual(await ids('179,-20,180,-15'), [311000001]);
  assert.ok(!(await ids('10,40,15,50')).includes(311000001), 'fuori dall\'area');
});

test('bbox non valido = nessun filtro', async () => {
  const all = await getJson('/api/locations');
  const bad = await getJson('/api/locations?bbox=a,b,c,d');
  assert.equal(bad.total, all.total);
});

test('limit riduce le navi mostrate ma total resta il conteggio reale', async () => {
  const fc = await getJson('/api/locations?limit=1');
  assert.ok(fc.total >= 3);
  assert.ok(fc.features.length < fc.total);
});

test('la ricerca trova per nome, MMSI e IMO e ignora query troppo corte', async () => {
  const names = async q => (await getJson('/api/search?q=' + encodeURIComponent(q))).map(v => v.mmsi);
  assert.deepEqual(await names('laguna'), [247000001], 'nome, senza distinzione maiuscole');
  assert.deepEqual(await names('2470000'), [247000001], 'inizio MMSI (247000002 non ha posizione)');
  assert.deepEqual(await names('9123'), [247000001], 'inizio IMO');
  assert.deepEqual(await names('L'), [], 'meno di 2 caratteri');
});

test('risponde compresso in gzip quando il browser lo accetta', async () => {
  const res = await get('/api/locations', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(res.body)).type, 'FeatureCollection');
});

test('un errore di aisstream viene mostrato in /api/status', async () => {
  aisSocket.send(JSON.stringify({ error: 'Api Key Is Not Valid' }));
  await waitFor(async () => (await getJson('/api/status')).error === 'Api Key Is Not Valid', 'errore in status');
});

test('serve le pagine e risponde 404 al resto', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  assert.match(home.body.toString(), /<html/i);
  assert.equal((await get('/vesselfinder.html')).status, 200);
  assert.equal((await get('/server.js')).status, 404, 'il codice del server non è esposto');
  assert.equal((await getJson('/api/vessel?mmsi=1')), null);
});
