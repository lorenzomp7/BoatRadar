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
    http.get({ host: '127.0.0.1', port, path: pathname, headers, agent: false }, res => {
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
  Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: 12.5, Cog: 90, NavigationalStatus: 0, ...extra.report } },
});

const rejected = async () => (await getJson('/api/status')).rejected;
const coords = async mmsi => (await getJson('/api/locations')).features.find(f => f.mmsi === mmsi)?.geometry.coordinates;

before(async () => {
  fakeAis = new WebSocketServer({ port: 0 });
  const connected = new Promise(resolve => fakeAis.on('connection', ws => {
    aisSocket = ws;
    ws.once('message', data => { subscription = JSON.parse(data.toString()); resolve(); });
  }));
  port = await freePort();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // senza variabili di proxy: con NODE_USE_ENV_PROXY=1 server.js passerebbe dal proxy (Diagnosi)
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|no|all)_proxy$|^NODE_USE_ENV_PROXY$/i.test(k))),
      PORT: String(port), AISSTREAM_KEY: 'chiave-di-test',
      // cache di /api/locations (punto 84) senza durata minima: ogni messaggio si vede subito
      LOCATIONS_CACHE_MS: '0',
      AISSTREAM_URL: `ws://127.0.0.1:${fakeAis.address().port}` },
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
    Message: { ShipStaticData: { Name: 'LAGUNA EXPRESS@@', ImoNumber: 9074729, CallSign: 'IABC@', Type: 60,
      Destination: 'VENEZIA@@@', MaximumStaticDraught: 6.2, Dimension: { A: 100, B: 20, C: 10, D: 8 },
      Eta: { Month: 11, Day: 23, Hour: 24, Minute: 60 } } },
  });
  const v = await getJson('/api/vessel?mmsi=247000001');
  assert.equal(v.name, 'LAGUNA EXPRESS');
  assert.equal(v.imo, 9074729);
  assert.equal(v.callSign, 'IABC');
  assert.equal(v.destination, 'VENEZIA');
  assert.equal(v.length, 120, 'lunghezza = A + B');
  assert.equal(v.width, 18, 'larghezza = C + D');
  assert.deepEqual(v.eta, { month: 11, day: 23, hour: null, minute: null }, '24/60 = ora non disponibile');
});

test('un ETA non valido (mese 0) viene ignorato', async () => {
  await send({ MetaData: { MMSI: 247000002 }, Message: { ShipStaticData: { Name: 'SENZA ETA', Eta: { Month: 0, Day: 0 } } } });
  const v = await getJson('/api/vessel?mmsi=247000002');
  assert.equal(v.eta, null);
});

test('IMO e ETA validi compaiono in /api/vessel; IMO 0 ed ETA 0/0/24/60 tornano null', async () => {
  await send(position(248000010, 43.7, 7.4));
  await send({ MetaData: { MMSI: 248000010 }, Message: { ShipStaticData: { Name: 'MONACO', ImoNumber: 9074729,
    Eta: { Month: 12, Day: 1, Hour: 10, Minute: 30 } } } });
  let v = await getJson('/api/vessel?mmsi=248000010');
  assert.equal(v.imo, 9074729);
  assert.deepEqual(v.eta, { month: 12, day: 1, hour: 10, minute: 30 });
  // un nuovo messaggio con valori «non disponibili» azzera i vecchi dati
  await send({ MetaData: { MMSI: 248000010 }, Message: { ShipStaticData: { Name: 'MONACO', ImoNumber: 0,
    Eta: { Month: 0, Day: 0, Hour: 24, Minute: 60 } } } });
  v = await getJson('/api/vessel?mmsi=248000010');
  assert.equal(v.imo, null, 'IMO 0 = non disponibile');
  assert.equal(v.eta, null, 'ETA 0/0/24/60 = non disponibile');
});

test('un IMO con cifra di controllo sbagliata o di 8 cifre diventa null e non si trova nella ricerca', async () => {
  await send(position(248000011, 43.7, 7.4));
  await send({ MetaData: { MMSI: 248000011 }, Message: { ShipStaticData: { Name: 'FALSO IMO', ImoNumber: 9123456 } } });
  assert.equal((await getJson('/api/vessel?mmsi=248000011')).imo, null, '9123456: cifra di controllo sbagliata');
  assert.deepEqual(await getJson('/api/search?q=9123'), []);
  await send({ MetaData: { MMSI: 248000011 }, Message: { ShipStaticData: { Name: 'FALSO IMO', ImoNumber: 12345679 } } });
  assert.equal((await getJson('/api/vessel?mmsi=248000011')).imo, null, '8 cifre');
});

test('ETA: mese, giorno, ora e minuto devono essere interi ≥ 0', async () => {
  const eta = async (mmsi, e) => {
    await send({ MetaData: { MMSI: mmsi }, Message: { ShipStaticData: { Name: 'ETA', Eta: e } } });
    return (await getJson('/api/vessel?mmsi=' + mmsi)).eta;
  };
  assert.equal(await eta(248000020, { Month: 1.5, Day: 3, Hour: 10, Minute: 0 }), null, 'mese 1,5');
  assert.equal(await eta(248000021, { Month: 2, Day: 2.5, Hour: 10, Minute: 0 }), null, 'giorno 2,5');
  assert.deepEqual(await eta(248000022, { Month: 3, Day: 4, Hour: -1, Minute: 30 }), { month: 3, day: 4, hour: null, minute: 30 }, 'ora -1');
  assert.deepEqual(await eta(248000023, { Month: 3, Day: 4, Hour: 1.5, Minute: -2 }), { month: 3, day: 4, hour: null, minute: null }, 'ora 1,5 e minuto -2');
  assert.deepEqual(await eta(248000024, { Month: 3, Day: 4, Hour: 0, Minute: 0 }), { month: 3, day: 4, hour: 0, minute: 0 }, 'mezzanotte');
  assert.deepEqual(await eta(248000025, { Month: 3, Day: 4, Hour: '5', Minute: 7.5 }), { month: 3, day: 4, hour: null, minute: null }, 'non numeri interi');
});

test('IMO ai limiti: 1000007 e 9999993 validi, 1000000 e 9999999 no', async () => {
  const imo = async n => {
    await send({ MetaData: { MMSI: 248000030 }, Message: { ShipStaticData: { Name: 'LIMITI', ImoNumber: n } } });
    return (await getJson('/api/vessel?mmsi=248000030')).imo;
  };
  assert.equal(await imo(1000007), 1000007);
  assert.equal(await imo(9999993), 9999993);
  assert.equal(await imo(1000000), null);
  assert.equal(await imo(9999999), null);
});

test('StaticDataReport (classe B) non tocca IMO ed ETA', async () => {
  await send({ MetaData: { MMSI: 248000040 }, Message: { ShipStaticData: { Name: 'CLASSE B', ImoNumber: 9074729,
    Eta: { Month: 5, Day: 6, Hour: 7, Minute: 8 } } } });
  await send({ MetaData: { MMSI: 248000040 }, Message: { StaticDataReport: { ReportA: { Name: 'CLASSE B NUOVO' },
    ReportB: { CallSign: 'IXYZ', ShipType: 37 } } } });
  const v = await getJson('/api/vessel?mmsi=248000040');
  assert.equal(v.name, 'CLASSE B NUOVO');
  assert.equal(v.callSign, 'IXYZ');
  assert.equal(v.imo, 9074729);
  assert.deepEqual(v.eta, { month: 5, day: 6, hour: 7, minute: 8 });
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
  assert.deepEqual(await names('9074'), [247000001], 'inizio IMO');
  assert.deepEqual(await names('L'), [], 'meno di 2 caratteri');
});

test('risponde compresso in gzip quando il browser lo accetta', async () => {
  const res = await get('/api/locations', { 'Accept-Encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(res.body)).type, 'FeatureCollection');
});

test('le posizioni non valide non compaiono e vengono contate in /api/status', async () => {
  const start = await rejected();
  assert.equal(typeof start, 'number', 'rejected esposto in /api/status');
  await send(position(255800001, 91, 181));
  await send(position(255800002, 0, 0));
  await send(position(255800003, 45, 12, { report: { Valid: false } }));
  await send(position(255800004, -89.9, -180)); // al confine: valida
  const ids = (await getJson('/api/locations')).features.map(f => f.mmsi);
  for (const mmsi of [255800001, 255800002, 255800003]) assert.ok(!ids.includes(mmsi), `${mmsi} scartata`);
  assert.deepEqual(await coords(255800004), [-180, -89.9]);
  assert.equal(await rejected(), start + 3);
});

test('un salto impossibile viene scartato finché una seconda posizione non lo conferma', async () => {
  await send(position(255800010, 43, 10));
  const start = await rejected();
  await send(position(255800010, 43 + 500 / 60, 10)); // 500 NM in un istante
  assert.deepEqual(await coords(255800010), [10, 43], 'resta l\'ultima posizione buona');
  assert.equal(await rejected(), start + 1);
  await send(position(255800010, 43 + 500 / 60, 10)); // stessa posizione di nuovo: confermata
  assert.deepEqual(await coords(255800010), [10, 43 + 500 / 60]);
});

test('una nave ferma che si sposta di 300 m all\'improvviso viene scartata', async () => {
  const still = { report: { Sog: 0, NavigationalStatus: 5 } };
  await send(position(255800020, 45, 12, still));
  const start = await rejected();
  await send(position(255800020, 45.0027, 12, still));
  assert.deepEqual(await coords(255800020), [12, 45]);
  assert.equal(await rejected(), start + 1);
});

test('una nave in moto che avanza di poco viene aggiornata', async () => {
  await send(position(255800030, 44, 9));
  await send(position(255800030, 44.0005, 9));
  assert.deepEqual(await coords(255800030), [9, 44.0005]);
});

test('una posizione con Latitude e Longitude null viene scartata e la successiva accettata subito', async () => {
  const start = await rejected();
  await send(position(255900001, null, null));
  assert.equal(await coords(255900001), undefined, 'assente da /api/locations');
  assert.equal(await rejected(), start + 1);
  await send(position(255900001, 44.4, 8.9));
  assert.deepEqual(await coords(255900001), [8.9, 44.4], 'il null non è diventato la posizione precedente');
  assert.equal(await rejected(), start + 1);
});

test('una StandardClassBPositionReport fuori scala (91, 181) viene scartata', async () => {
  const start = await rejected();
  await send({ MetaData: { MMSI: 255900002 },
    Message: { StandardClassBPositionReport: { Latitude: 91, Longitude: 181, Sog: 5, Cog: 10 } } });
  assert.equal(await coords(255900002), undefined);
  assert.equal(await rejected(), start + 1);
});

test('una ExtendedClassBPositionReport in (0,0) viene scartata ma tipo e dimensioni restano', async () => {
  const start = await rejected();
  await send({ MetaData: { MMSI: 255900003 },
    Message: { ExtendedClassBPositionReport: { Latitude: 0, Longitude: 0, Sog: 5, Cog: 10, Type: 37,
      Dimension: { A: 8, B: 4, C: 2, D: 2 } } } });
  assert.equal(await coords(255900003), undefined);
  assert.equal(await rejected(), start + 1);
  const v = await getJson('/api/vessel?mmsi=255900003');
  assert.equal(v.shipType, 37);
  assert.equal(v.length, 12);
  assert.equal(v.width, 4);
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

test('le API si possono leggere da GitHub Pages (CORS) e config.js esiste anche in locale', async () => {
  const res = await get('/api/status', { Origin: 'https://lorenzomp7.github.io' });
  assert.equal(res.headers['access-control-allow-origin'], '*', 'senza CORS_ORIGIN qualunque origine');
  const cfg = await get('/config.js');
  assert.equal(cfg.status, 200);
  assert.match(cfg.headers['content-type'], /javascript/);
  assert.doesNotMatch(cfg.body.toString(), /BOATRADAR_API/, 'in locale la pagina usa /api dello stesso server');
});
