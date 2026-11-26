// Punto 9 (a): filtri di /api/locations (types, status, minSog, maxSog, seen, moving) applicati prima del campione,
// con chiave della cache canonica (filterKey di public/ais-logic.js) solo quando un filtro è attivo. include= e
// /api/search ignorano i filtri. Parametri non validi = nessun filtro, mai un errore.
// Avvia un server.js tutto suo con la cache accesa (LOCATIONS_CACHE_MS=0: una voce si riusa solo a dati fermi, così
// ogni invio di messaggi ricalcola) e navi in zone isolate. Esegui con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('./helpers');

let srv;
before(async () => { srv = await startServer({ LOCATIONS_CACHE_MS: '0' }); });
after(async () => { await srv?.stop(); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function sendAll(...msgs) {
  const start = (await srv.getJson('/api/status')).messages;
  for (const m of msgs) srv.socket.send(JSON.stringify(m));
  await waitFor(async () => (await srv.getJson('/api/status')).messages >= start + msgs.length, 'messaggi elaborati');
}
const ids = fc => fc.features.map(f => f.mmsi).sort((a, b) => a - b);
const xcache = async url => (await srv.get(url)).headers['x-cache'];

const classA = (mmsi, lat, lon, sog, navStat) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: 'FILTRO ' + mmsi },
  Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: sog, Cog: 90, TrueHeading: 90, NavigationalStatus: navStat } } });
const staticA = (mmsi, type, length = 100) => ({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi },
  Message: { ShipStaticData: { Name: 'FILTRO ' + mmsi, Type: type, Dimension: { A: length - 10, B: 10, C: 5, D: 5 } } } });

// Zona dei parametri: bbox 129,-31,131,-29
const CARGO = 247900001, TANKER = 247900002, FISH = 247900003, BOAT = 247900004, FERRY = 247900005, NOSOG = 247900006;
const ZONE = '/api/locations?bbox=129,-31,131,-29';

test('ogni parametro filtra le navi; total = navi nel bbox che passano', async () => {
  await sendAll(
    classA(CARGO, -30.1, 130.1, 12, 0), staticA(CARGO, 70),
    classA(TANKER, -30.2, 130.2, 0, 5), staticA(TANKER, 80),
    classA(FISH, -30.3, 130.3, 3, 7), staticA(FISH, 30),
    { MessageType: 'StandardClassBPositionReport', MetaData: { MMSI: BOAT },
      Message: { StandardClassBPositionReport: { Latitude: -30.4, Longitude: 130.4, Sog: 6, Cog: 0, TrueHeading: 511 } } },
    { MessageType: 'StaticDataReport', MetaData: { MMSI: BOAT }, Message: { StaticDataReport: { ReportB: { ShipType: 37 } } } },
    classA(FERRY, -30.5, 130.5, 0.2, 1), staticA(FERRY, 60),
    classA(NOSOG, -30.6, 130.6, 102.3, 0), staticA(NOSOG, 70),
  );
  const all = await srv.getJson(ZONE);
  assert.deepEqual(ids(all), [CARGO, TANKER, FISH, BOAT, FERRY, NOSOG]);
  const cases = [
    ['types=tanker', [TANKER]],
    ['types=cargo,passenger', [CARGO, FERRY, NOSOG]],
    ['types=cargo&types=passenger', [CARGO, FERRY, NOSOG]],   // ripetuto = unito
    ['types=pleasure', [BOAT]],
    ['status=moored', [TANKER]],
    ['status=underway', [CARGO, NOSOG]],
    ['status=anchor,fishing', [FISH, FERRY]],
    ['status=other', [BOAT]],                                 // classe B: nessuno stato
    ['minSog=5', [CARGO, BOAT]],                              // velocità non disponibile esclusa
    ['maxSog=1', [TANKER, FERRY]],
    ['minSog=3&maxSog=6', [FISH, BOAT]],
    ['moving=1', [CARGO, FISH, BOAT, NOSOG]],
    ['moving=0', [TANKER, FERRY]],
    ['seen=10', [CARGO, TANKER, FISH, BOAT, FERRY, NOSOG]],
    ['types=cargo,fishing,pleasure&status=underway,fishing&minSog=2&maxSog=15&moving=1&seen=10', [CARGO, FISH]],
  ];
  for (const [q, want] of cases) {
    const fc = await srv.getJson(`${ZONE}&${q}`);
    assert.deepEqual(ids(fc), want, q);
    assert.equal(fc.total, want.length, 'total con ' + q);
  }
});

test('seen=0.01 (0,6 s): dopo 1 s la nave A non passa più, B appena arrivata sì', async () => {
  const A = 247901001, B = 247901002, url = '/api/locations?bbox=139,-31,141,-29&seen=0.01';
  await sendAll(classA(A, -30, 140, 5, 0));
  await sleep(1000);
  await sendAll(classA(B, -30, 140.5, 5, 0));
  const fc = await srv.getJson(url);
  assert.deepEqual(ids(fc), [B]);
  assert.equal(fc.total, 1);
  assert.deepEqual(ids(await srv.getJson('/api/locations?bbox=139,-31,141,-29')), [A, B], 'senza filtro ci sono tutte e due');
});

test('seen e cache: a dati fermi la voce vale solo finché la prima nave non esce dal filtro (expires)', async () => {
  const A = 247902001, url = '/api/locations?bbox=149,-31,151,-29&seen=0.01';
  const t0 = Date.now();
  await sendAll(classA(A, -30, 150, 5, 0));
  const a = await srv.get(url), b = await srv.get(url);
  assert.ok(Date.now() - t0 < 600, 'controllo fatto prima di 0,6 s');
  assert.deepEqual([a.headers['x-cache'], b.headers['x-cache']], ['miss', 'hit']);
  assert.deepEqual(ids(JSON.parse(b.body)), [A]);
  await sleep(Math.max(0, t0 + 900 - Date.now()));
  const c = await srv.get(url);
  assert.equal(c.headers['x-cache'], 'miss', 'nessun messaggio nuovo, ma A non è più recente: ricalcolata');
  assert.deepEqual(JSON.parse(c.body).features, []);
  assert.equal(JSON.parse(c.body).total, 0);
  assert.equal(await xcache(url), 'hit', 'voce vuota: nessuna nave può rientrare senza dati nuovi');
  assert.deepEqual(ids(await srv.getJson('/api/locations?bbox=149,-31,151,-29')), [A], 'senza filtro resta');
});

test('filtro prima del campione: con types=tanker la petroliera piccola ferma c\'è anche con limit=2', async () => {
  const C1 = 247903001, C2 = 247903002, C3 = 247903003, T = 247903004, box = '/api/locations?bbox=159,-31,161,-29';
  await sendAll(
    classA(C1, -30.1, 160.1, 14, 0), staticA(C1, 70, 300),
    classA(C2, -30.2, 160.2, 14, 0), staticA(C2, 70, 300),
    classA(C3, -30.3, 160.3, 14, 0), staticA(C3, 70, 300),
    classA(T, -30.4, 160.4, 0, 5), staticA(T, 80, 30),
  );
  const plain = await srv.getJson(box + '&limit=2');
  assert.equal(plain.features.length, 2);
  assert.equal(plain.total, 4);
  assert.ok(!ids(plain).includes(T), 'senza filtro il campione tiene i cargo grandi in moto');
  const tankers = await srv.getJson(box + '&limit=2&types=tanker');
  assert.deepEqual(ids(tankers), [T]);
  assert.equal(tankers.total, 1);
  const cargo = await srv.getJson(box + '&limit=2&types=cargo');
  assert.equal(cargo.features.length, 2);
  assert.equal(cargo.total, 3, 'total = cargo nel bbox, non il campione');
});

test('cache: senza filtro e con filtri non validi stessa voce; filtri equivalenti stessa voce canonica', async () => {
  const S = 247904001, T = 247904002, box = '/api/locations?bbox=169,-31,171,-29';
  await sendAll(classA(S, -30.1, 170.1, 10, 0), staticA(S, 70), classA(T, -30.2, 170.2, 0, 5), staticA(T, 80));
  const size0 = (await srv.getJson('/api/status')).locationsCache.size;
  assert.equal(await xcache(box), 'miss');
  for (const junk of ['types=foo&minSog=abc', 'types=&status=', 'minSog=0', 'seen=0', 'moving=si', 'minSog=5&maxSog=2',
    'types=' + ['cargo', 'tanker', 'passenger', 'fishing', 'pleasure', 'service', 'other'].join(',')]) {
    assert.equal(await xcache(`${box}&${junk}`), 'hit', `${junk}: nessun filtro, voce senza filtro`);
  }
  assert.equal((await srv.getJson('/api/status')).locationsCache.size, size0 + 1, 'una sola voce');
  assert.equal(await xcache(box + '&types=tanker'), 'miss');
  assert.equal(await xcache(box + '&types=tanker'), 'hit');
  assert.equal(await xcache(box + '&types=tanker,foo&minSog=abc'), 'hit', 'parti non valide scartate: stessa chiave');
  assert.equal(await xcache(box + '&types=tanker,cargo'), 'miss');
  assert.equal(await xcache(box + '&types=cargo&types=tanker'), 'hit', 'ordine e ripetizione: chiave canonica');
  assert.equal(await xcache(box + '&minSog=5.04&seen=15'), 'miss');
  assert.equal(await xcache(box + '&seen=15.001&minSog=5'), 'hit', 'valori arrotondati come filterKey');
  assert.equal(await xcache(box + '&moving=0&limit=10'), 'miss');
  assert.equal(await xcache(box + '&limit=10&moving=0'), 'hit');
  assert.deepEqual(ids(await srv.getJson(box + '&moving=0&limit=10')), [T]);
});

test('include= e /api/search ignorano i filtri', async () => {
  const fc = await srv.getJson(`/api/locations?include=${CARGO},${TANKER}&types=tanker&moving=0`);
  assert.deepEqual(fc.features.map(f => f.mmsi), [CARGO, TANKER], 'il cargo c\'è anche con types=tanker');
  assert.equal(fc.total, 2);
  const found = await srv.getJson(`/api/search?q=FILTRO%202479000&types=tanker&minSog=50`);
  assert.ok(found.some(v => v.mmsi === CARGO), '/api/search non filtra');
});

test('parametri estremi o non validi: 200, nessun filtro, nessun errore', async () => {
  const plain = ids(await srv.getJson(ZONE));
  const weird = ['minSog=NaN', 'minSog=1e999', 'maxSog=-Infinity', 'types=%00', 'status=%00moored', 'seen=1e9',
    'seen=-3', 'moving=%00', 'minSog=5&minSog=6', 'maxSog=1&maxSog=1', 'seen=5&seen=5', 'moving=1&moving=0',
    'types=' + 'cargo,'.repeat(2000), 'minSog=' + '9'.repeat(400), 'seen=0x10', 'minSog=%E2%82%AC', 'types=__proto__,constructor'];
  for (const q of weird) {
    const res = await srv.get(`${ZONE}&${q}`);
    assert.equal(res.status, 200, q);
    const fc = JSON.parse(res.body);
    if (q.startsWith('types=cargo')) assert.deepEqual(ids(fc), [CARGO, NOSOG], 'tipo ripetuto molte volte = cargo');
    else assert.deepEqual(ids(fc), plain, `${q}: come senza filtro`);
  }
  assert.equal((await srv.get('/api/status')).status, 200, 'il server è ancora vivo');
});
