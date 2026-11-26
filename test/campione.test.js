// Test d'integrazione del punto 4: /api/locations con limit sceglie le navi per importanza (sample.js),
// non per resto dell'MMSI. Avvia un server.js tutto suo (startServer di helpers.js) con la cache spenta,
// in una zona isolata (bbox 99,-41,101,-39). Esegui con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('./helpers');

let srv;
before(async () => { srv = await startServer({ LOCATIONS_CACHE_SIZE: '0' }); });
after(async () => { await srv?.stop(); });

async function sendAll(...msgs) {
  const start = (await srv.getJson('/api/status')).messages;
  for (const m of msgs) srv.socket.send(JSON.stringify(m));
  await waitFor(async () => (await srv.getJson('/api/status')).messages >= start + msgs.length, 'messaggi elaborati');
}
const ids = fc => fc.features.map(f => f.mmsi);

// barca con MMSI pari e petroliera con MMSI dispari: il vecchio campione (mmsi % 2 === 0) avrebbe tenuto la barca
const BOAT = 247560000, TANKER = 247560001;
const BOX = '/api/locations?bbox=99,-41,101,-39';

test('limit=1 fra una petroliera di 250 m in moto e una barca ferma: resta la petroliera; total 2', async () => {
  await sendAll(
    { MessageType: 'StandardClassBPositionReport', MetaData: { MMSI: BOAT },
      Message: { StandardClassBPositionReport: { Latitude: -40.1, Longitude: 100.1, Sog: 0, Cog: 0, TrueHeading: 511 } } },
    { MessageType: 'StaticDataReport', MetaData: { MMSI: BOAT },
      Message: { StaticDataReport: { ReportB: { ShipType: 37, CallSign: 'BARCA', Dimension: { A: 6, B: 2, C: 1, D: 1 } } } } },
    { MessageType: 'PositionReport', MetaData: { MMSI: TANKER },
      Message: { PositionReport: { Latitude: -40.2, Longitude: 100.2, Sog: 12, Cog: 90, TrueHeading: 90, NavigationalStatus: 0 } } },
    { MessageType: 'ShipStaticData', MetaData: { MMSI: TANKER },
      Message: { ShipStaticData: { Name: 'PETROLIERA', Type: 80, Dimension: { A: 200, B: 50, C: 20, D: 20 } } } },
  );
  const all = await srv.getJson(BOX);
  assert.deepEqual(ids(all).sort(), [BOAT, TANKER], 'senza limit ci sono tutte e due');
  const one = await srv.getJson(BOX + '&limit=1');
  assert.deepEqual(ids(one), [TANKER]);
  assert.equal(one.total, 2, 'total resta il numero di navi nel bbox');
  assert.equal(one.features[0].properties.classA, undefined, 'classA resta sul server: payload invariato');
});

test('due chiamate uguali danno la stessa risposta (campione stabile)', async () => {
  const a = await srv.get(BOX + '&limit=1');
  const b = await srv.get(BOX + '&limit=1');
  assert.equal(a.headers['x-cache'], 'miss', 'cache spenta: ricalcolata');
  assert.equal(b.headers['x-cache'], 'miss');
  assert.ok(a.body.equals(b.body));
});

test('con più navi che limit il campione ne restituisce esattamente limit', async () => {
  const zone = Array.from({ length: 9 }, (_, i) => 247561000 + i);
  await sendAll(...zone.map((mmsi, i) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi },
    Message: { PositionReport: { Latitude: -39.5, Longitude: 99.5 + i / 100, Sog: 3, Cog: 0, NavigationalStatus: 0 } } })));
  const fc = await srv.getJson(BOX + '&limit=4');
  assert.equal(fc.total, 11);
  assert.equal(fc.features.length, 4);
  assert.equal(new Set(ids(fc)).size, 4, 'nessun doppione');
  assert.ok(ids(fc).includes(TANKER), 'la petroliera è la più importante');
});

test('i dati statici arrivati dopo la posizione contano nel campione (parte statica ricalcolata alla ricezione)', async () => {
  // due navi di classe A in moto, uguali; la seconda (MMSI più alto) riceve poi lunghezza 300 m e tipo 70
  const A = 247562000, B = 247562001, box = '/api/locations?bbox=109,-41,111,-39&limit=1';
  const pr = (mmsi, lon) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi },
    Message: { PositionReport: { Latitude: -40, Longitude: lon, Sog: 8, Cog: 0, NavigationalStatus: 0 } } });
  await sendAll(pr(A, 110), pr(B, 110.5));
  assert.deepEqual(ids(await srv.getJson(box)), [A], 'a parità vince l\'MMSI più basso');
  await sendAll({ MessageType: 'ShipStaticData', MetaData: { MMSI: B },
    Message: { ShipStaticData: { Name: 'GRANDE', Type: 70, Dimension: { A: 250, B: 50, C: 20, D: 20 } } } });
  assert.deepEqual(ids(await srv.getJson(box)), [B], 'dopo i dati statici vince la nave grande');
  await sendAll(pr(B, 110.5001));
  assert.deepEqual(ids(await srv.getJson(box)), [B], 'e resta prima anche con una posizione nuova');
});

test('dati statici prima della posizione; lunghezza che scende e tipo che cambia aggiornano il campione', async () => {
  // A (MMSI più basso): 100 m, tipo 30 → parte statica log2(10) ≈ 3,32. B riceve i dati statici prima della posizione.
  const A = 247563000, B = 247563001, box = '/api/locations?bbox=119,-41,121,-39&limit=1';
  const pr = (mmsi, lon) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi },
    Message: { PositionReport: { Latitude: -40, Longitude: lon, Sog: 8, Cog: 0, NavigationalStatus: 0 } } });
  const st = (mmsi, length, type) => ({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi },
    Message: { ShipStaticData: { Name: 'N' + mmsi, Type: type, Dimension: { A: length - 10, B: 10, C: 10, D: 10 } } } });
  await sendAll(st(B, 300, 70), st(A, 100, 30), pr(A, 120), pr(B, 120.5));
  assert.deepEqual(ids(await srv.getJson(box)), [B], 'B: 300 m + tipo 70, dati statici arrivati prima della posizione');
  await sendAll(st(B, 40, 70));
  assert.deepEqual(ids(await srv.getJson(box)), [A], 'B scende a 40 m (2 + 1 < 3,32): vince A');
  await sendAll(st(B, 100, 70));
  assert.deepEqual(ids(await srv.getJson(box)), [B], 'B 100 m + tipo 70 batte A 100 m + tipo 30');
  await sendAll(st(B, 100, 37));
  assert.deepEqual(ids(await srv.getJson(box)), [A], 'B passa al tipo 37: pari con A, vince l\'MMSI più basso');
});
