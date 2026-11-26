// Test d'integrazione delle risorse e API usate dalla pagina: avvia un server.js tutto suo
// (startServer di helpers.js) contro un finto aisstream locale. Esegui con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, waitFor } = require('./helpers');

let srv;
// LOCATIONS_CACHE_MS=0: ogni messaggio si vede subito in /api/locations (la cache vale solo a dati fermi)
before(async () => { srv = await startServer({ LOCATIONS_CACHE_MS: '0' }); });

// Invia messaggi AIS al server e aspetta che siano stati contati
async function sendAll(server, ...msgs) {
  const start = (await server.getJson('/api/status')).messages;
  for (const m of msgs) server.socket.send(JSON.stringify(m));
  await waitFor(async () => (await server.getJson('/api/status')).messages >= start + msgs.length, 'messaggi elaborati');
}
const report = (mmsi, lat, lon, extra = {}, type = 'PositionReport') => ({ MessageType: type, MetaData: { MMSI: mmsi },
  Message: { [type]: { Latitude: lat, Longitude: lon, Sog: 0, Cog: 90, NavigationalStatus: 5, ...extra } } });
const feature = async (mmsi, q = '') => (await srv.getJson('/api/locations' + q)).features.find(f => f.mmsi === mmsi);
after(async () => { await srv?.stop(); });

test('serve public/ais-logic.js come JavaScript e nient\'altro di public/', async () => {
  const res = await srv.get('/public/ais-logic.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.body.toString('utf8'), /AisLogic/);
  assert.equal((await srv.get('/public/x.js')).status, 404);
  assert.equal((await srv.get('/public/')).status, 404);
  assert.equal((await srv.get('/public/../server.js')).status, 404);
});

test('file statico illeggibile: risposta 500 e il server resta in piedi', async () => {
  // copia di server.js senza pagine né public/: ogni file statico manca
  const ROOT = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-statici-'));
  for (const f of ['server.js', 'position-check.js', 'sample.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const solo = await startServer({ NODE_PATH: path.join(ROOT, 'node_modules') }, {}, { cwd: dir });
  try {
    for (const p of ['/public/ais-logic.js', '/', '/vesselfinder.html']) {
      const res = await solo.get(p);
      assert.equal(res.status, 500, p);
      assert.doesNotMatch(res.body.toString('utf8'), new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'nessun percorso nella risposta');
    }
    assert.equal((await solo.get('/api/status')).status, 200, 'il processo è ancora vivo');
    assert.match(solo.log(), /ais-logic\.js/, 'errore scritto nel log');
  } finally {
    await solo.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/api/status riporta serverTime: l\'ora del server in millisecondi (punto 43)', async () => {
  const before = Date.now();
  const st = await srv.getJson('/api/status');
  const after = Date.now();
  assert.equal(typeof st.serverTime, 'number');
  assert.ok(st.serverTime >= before && st.serverTime <= after, `${st.serverTime} fra ${before} e ${after}`);
});

test('/api/locations non contiene serverTime: la risposta può venire dalla cache (punto 84)', async () => {
  const fc = await srv.getJson('/api/locations');
  assert.equal(fc.serverTime, undefined);
});

// --- Punto 5: prua vera (TrueHeading) e velocità di accostata (RateOfTurn) ---------------------------
test('TrueHeading 0-359 è la prua; 511, 496, 360 e non interi diventano null (punto 5)', async () => {
  const cases = [[511, null], [496, null], [360, null], [45, 45], [0, 0], [359, 359], [-1, null], [45.5, null], [undefined, null]];
  await sendAll(srv, ...cases.map(([h], i) => report(247500001 + i, 43.1, 10.1 + i / 100, { TrueHeading: h })));
  const fc = await srv.getJson('/api/locations?bbox=10,43,11,44');
  for (const [i, [h, want]] of cases.entries()) {
    const f = fc.features.find(x => x.mmsi === 247500001 + i);
    assert.ok(f, `nave con TrueHeading ${h}`);
    assert.equal(f.properties.heading, want, `TrueHeading ${h}`);
  }
});

test('RateOfTurn: -128 (n.d.) e non interi → null, gli altri restano; classe B senza RateOfTurn → null (punto 5)', async () => {
  const cases = [[-128, null], [0, 0], [-127, -127], [127, 127], [12, 12], [1.5, null], [undefined, null]];
  await sendAll(srv, ...cases.map(([r], i) => report(247510001 + i, 43.2, 10.1 + i / 100, { RateOfTurn: r, TrueHeading: 90 })),
    report(247510101, 43.25, 10.5, { TrueHeading: 200 }, 'StandardClassBPositionReport'));
  const fc = await srv.getJson('/api/locations?bbox=10,43,11,44');
  for (const [i, [r, want]] of cases.entries()) {
    assert.equal(fc.features.find(x => x.mmsi === 247510001 + i)?.properties.rot, want, `RateOfTurn ${r}`);
  }
  const b = fc.features.find(x => x.mmsi === 247510101);
  assert.equal(b.properties.heading, 200, 'la classe B trasmette la prua');
  assert.equal(b.properties.rot, null, 'la classe B non trasmette RateOfTurn');
});

test('un salto confermato porta in mappa la prua della posizione che lo conferma (punto 5 con punto 1)', async () => {
  const mmsi = 247520001;
  await sendAll(srv, report(mmsi, 43.3, 10.3, { TrueHeading: 10, RateOfTurn: 1, Sog: 10 }));
  await sendAll(srv, report(mmsi, 50, 20, { TrueHeading: 20, RateOfTurn: 2, Sog: 10 }));   // salto: candidato
  let f = await feature(mmsi);
  assert.deepEqual(f.geometry.coordinates, [10.3, 43.3], 'il salto non è ancora accettato');
  assert.equal(f.properties.heading, 10);
  await sendAll(srv, report(mmsi, 50.0001, 20, { TrueHeading: 30, RateOfTurn: 3, Sog: 10 }));   // conferma
  f = await feature(mmsi);
  assert.deepEqual(f.geometry.coordinates, [20, 50.0001]);
  assert.equal(f.properties.heading, 30);
  assert.equal(f.properties.rot, 3);
});

// --- Punto 3: include= in /api/locations -----------------------------------------------------------------
const pos = (mmsi, lat, lon) => report(mmsi, lat, lon, { Sog: 5, NavigationalStatus: 0 });
const ids = fc => fc.features.map(f => f.mmsi);

test('include: la nave indicata c\'è anche fuori dal campione e fuori dal bbox, una volta sola; total invariato (punto 3)', async () => {
  // 10 navi uguali nella zona: con limit=1 il campione per importanza (punto 4) a parità tiene l'MMSI più basso, 247530000
  const zone = Array.from({ length: 10 }, (_, i) => 247530000 + i);
  await sendAll(srv, ...zone.map((m, i) => pos(m, 44.1, 11.1 + i / 100)), pos(247539999, -30, -40));
  const box = '/api/locations?bbox=11,44,12,45&limit=1';
  const plain = await srv.getJson(box);
  assert.deepEqual(ids(plain), [247530000]);
  const x = 247530003;
  const inc = await srv.getJson(`${box}&include=${x}`);
  assert.deepEqual(ids(inc).sort(), [247530000, x], 'la nave inclusa si aggiunge al campione');
  assert.equal(inc.total, plain.total, 'total conta solo le navi del bbox');
  assert.deepEqual(inc.features.find(f => f.mmsi === x).geometry.coordinates, [11.1 + 3 / 100, 44.1]);
  const far = await srv.getJson(`${box}&include=247539999`);
  assert.deepEqual(ids(far).sort(), [247530000, 247539999], 'inclusa anche fuori dal bbox');
  assert.equal(far.total, plain.total);
  const dup = await srv.getJson(`${box}&include=247530000,247530000`);
  assert.deepEqual(ids(dup), [247530000], 'già nel campione: nessun doppione');
  const two = await srv.getJson(`${box}&include=${x}&include=247530005`);
  assert.deepEqual(ids(two).sort(), [247530000, x, 247530005], 'più parametri include si sommano');
});

test('include: MMSI sconosciuti o senza posizione assenti; valori non validi = come senza include (punto 3)', async () => {
  await sendAll(srv, pos(247540001, 44.3, 11.3),
    { MessageType: 'ShipStaticData', MetaData: { MMSI: 247540099 }, Message: { ShipStaticData: { Name: 'SOLO STATICA' } } });
  const url = '/api/locations?bbox=11.2,44.2,11.4,44.4';
  const plain = await srv.getJson(url);
  assert.deepEqual(ids(plain), [247540001]);
  assert.deepEqual(ids(await srv.getJson(`${url}&include=999999999,247540099`)), [247540001], 'sconosciuta e senza posizione assenti');
  for (const bad of ['abc,,-5', '', '0', '1.5', '1e3', '%20', 'abc'.repeat(100)]) {
    const res = await srv.get(`${url}&include=${bad}`);
    assert.equal(res.status, 200, bad);
    assert.deepEqual(JSON.parse(res.body), plain, `include=${bad}`);
  }
});

test('include fa parte della chiave della cache, normalizzato; la nave inclusa c\'è anche servita dalla cache (punto 3)', async () => {
  const c = await startServer();   // cache accesa con i valori di default (LOCATIONS_CACHE_MS 3000)
  try {
    const zone = Array.from({ length: 10 }, (_, i) => 247550000 + i);
    await sendAll(c, ...zone.map((m, i) => pos(m, 44.5, 11.5 + i / 100)), pos(247559999, -31, -41));
    const url = '/api/locations?bbox=11.4,44.4,11.7,44.6&limit=1';
    const get = async q => { const r = await c.get(url + q); return { cache: r.headers['x-cache'], ids: ids(JSON.parse(r.body)).sort() }; };
    assert.deepEqual(await get(''), { cache: 'miss', ids: [247550000] });
    assert.deepEqual(await get('&include=abc,,-5'), { cache: 'hit', ids: [247550000] }, 'include non valido = stessa voce di senza include');
    assert.deepEqual(await get('&include=247550003'), { cache: 'miss', ids: [247550000, 247550003] }, 'include diverso: voce diversa');
    assert.deepEqual(await get('&include=247550003'), { cache: 'hit', ids: [247550000, 247550003] }, 'servita dalla cache con la nave inclusa');
    assert.deepEqual(await get('&include=247559999'), { cache: 'miss', ids: [247550000, 247559999] });
    assert.deepEqual(await get('&include=247559999,247550003'), { cache: 'miss', ids: [247550000, 247550003, 247559999] });
    for (const q of ['&include=247550003,247559999', '&include=247559999,247550003,247559999', '&include=247550003&include=247559999',
      '&include=247559999,x,247550003']) {
      assert.deepEqual(await get(q), { cache: 'hit', ids: [247550000, 247550003, 247559999] }, `${q}: ordine e doppioni non contano`);
    }
  } finally { await c.stop(); }
});

test('include: al massimo 50 MMSI, i primi validi nell\'ordine dato (punto 3)', async () => {
  const many = Array.from({ length: 55 }, (_, i) => 247560001 + i);
  await sendAll(srv, ...many.map((m, i) => pos(m, 44.8, 11.0 + i / 1000)));
  const fc = await srv.getJson(`/api/locations?bbox=-1,-1,0,0&include=x,${[...many].reverse().join(',')}`);
  assert.deepEqual(ids(fc).sort(), [...many].reverse().slice(0, 50).sort(), 'le prime 50 della lista');
  assert.equal(fc.total, 0, 'total conta solo il bbox, anche quando il campione non riduce nulla');
});
