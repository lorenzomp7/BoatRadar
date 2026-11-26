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
  for (const f of ['server.js', 'position-check.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
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
    assert.equal(f.properties.heading ?? null, want, `TrueHeading ${h}`);
    if (want == null) assert.equal('heading' in f.properties, false, `TrueHeading ${h}: chiave omessa (punto 4 delle correzioni)`);
  }
});

test('RateOfTurn: -128 (n.d.) e non interi → null, gli altri restano; classe B senza RateOfTurn → null (punto 5)', async () => {
  const cases = [[-128, null], [0, 0], [-127, -127], [127, 127], [12, 12], [1.5, null], [undefined, null]];
  await sendAll(srv, ...cases.map(([r], i) => report(247510001 + i, 43.2, 10.1 + i / 100, { RateOfTurn: r, TrueHeading: 90 })),
    report(247510101, 43.25, 10.5, { TrueHeading: 200 }, 'StandardClassBPositionReport'));
  const fc = await srv.getJson('/api/locations?bbox=10,43,11,44');
  for (const [i, [r, want]] of cases.entries()) {
    const props = fc.features.find(x => x.mmsi === 247510001 + i)?.properties;
    assert.equal(props.rot ?? null, want, `RateOfTurn ${r}`);
    if (want == null) assert.equal('rot' in props, false, `RateOfTurn ${r}: chiave omessa`);
  }
  const b = fc.features.find(x => x.mmsi === 247510101);
  assert.equal(b.properties.heading, 200, 'la classe B trasmette la prua');
  assert.equal(b.properties.rot == null, true, 'la classe B non trasmette RateOfTurn');
  assert.equal('rot' in b.properties, false);
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

test('salto confermato da una posizione con prua 511 e accostata -128: heading e rot null, non quelli del candidato', async () => {
  const mmsi = 247520002;
  await sendAll(srv, report(mmsi, 43.4, 10.4, { TrueHeading: 10, RateOfTurn: 1, Sog: 10 }));
  await sendAll(srv, report(mmsi, 51, 21, { TrueHeading: 20, RateOfTurn: 2, Sog: 10 }));   // salto: candidato con prua 20
  await sendAll(srv, report(mmsi, 51.0001, 21, { TrueHeading: 511, RateOfTurn: -128, Sog: 10 }));   // conferma senza prua
  const f = await feature(mmsi);
  assert.deepEqual(f.geometry.coordinates, [21, 51.0001], 'salto accettato');
  assert.equal(f.properties.heading == null, true, `heading ${f.properties.heading}: non la prua del candidato`);
  assert.equal(f.properties.rot == null, true, `rot ${f.properties.rot}: non l'accostata del candidato`);
});

test('/api/locations omette heading e rot quando mancano (payload più leggero)', async () => {
  await sendAll(srv, report(247520003, 43.45, 10.45, { TrueHeading: 511, RateOfTurn: -128 }));
  const raw = (await srv.get('/api/locations?bbox=10.44,43.44,10.46,43.46')).body.toString('utf8');
  assert.match(raw, /247520003/);
  assert.doesNotMatch(raw, /"heading"|"rot"/);
});

// --- Punto 3 (con le correzioni): include= in /api/locations, fuori dalla cache ------------------------
const pos = (mmsi, lat, lon) => report(mmsi, lat, lon, { Sog: 5, NavigationalStatus: 0 });
const ids = fc => fc.features.map(f => f.mmsi);
const cacheOf = async server => (await server.getJson('/api/status')).locationsCache;

test('include: solo le navi incluse con una posizione, anche fuori dal bbox; total = incluse trovate; niente campione', async () => {
  const zone = Array.from({ length: 10 }, (_, i) => 247530000 + i);
  await sendAll(srv, ...zone.map((m, i) => pos(m, 44.1, 11.1 + i / 100)), pos(247539999, -30, -40),
    { MessageType: 'ShipStaticData', MetaData: { MMSI: 247539998 }, Message: { ShipStaticData: { Name: 'SOLO STATICA' } } });
  const view = await srv.getJson('/api/locations?bbox=11,44,12,45&limit=1');
  assert.deepEqual(ids(view), [247530000], 'la vista ha il campione');
  const inc = await srv.getJson('/api/locations?include=247530003,247539999,999999999,247539998');
  assert.equal(inc.type, 'FeatureCollection');
  assert.deepEqual(ids(inc), [247530003, 247539999], 'solo le incluse con posizione, nell\'ordine dato');
  assert.equal(inc.total, 2, 'total = incluse trovate');
  const f = inc.features[0];
  assert.deepEqual(f.geometry, { type: 'Point', coordinates: [11.1 + 3 / 100, 44.1] });
  assert.deepEqual(Object.keys(f).sort(), ['geometry', 'mmsi', 'properties', 'type'], 'stessa forma GeoJSON della vista');
  assert.equal(f.properties.mmsi, 247530003);
  assert.equal(typeof f.properties.timestampExternal, 'number');
  const withBox = await srv.getJson('/api/locations?bbox=11,44,12,45&limit=1&include=247530003');
  assert.deepEqual(ids(withBox), [247530003], 'con include bbox e limit non contano');
  assert.equal(withBox.total, 1);
  assert.deepEqual(ids(await srv.getJson('/api/locations?include=247530003,247530003&include=247530005')), [247530003, 247530005],
    'doppioni tolti, più parametri include si sommano');
  assert.deepEqual(ids(await srv.getJson('/api/locations?include=%20247530003%20,+247530005')), [247530003, 247530005],
    'spazi attorno ai valori ignorati (punto 7)');
});

test('include non valido: risposta vuota con features []; include vuoto = vista normale', async () => {
  await sendAll(srv, pos(247540001, 44.3, 11.3));
  const url = '/api/locations?bbox=11.2,44.2,11.4,44.4';
  const plain = await srv.getJson(url);
  assert.deepEqual(ids(plain), [247540001]);
  for (const bad of ['abc', '-5', '0', '1.5', '1e3', '0x10', '1234567890', 'abc'.repeat(100), ',x,']) {
    const res = await srv.get(`${url}&include=${bad}`);
    assert.equal(res.status, 200, bad);
    assert.deepEqual(JSON.parse(res.body), { type: 'FeatureCollection', total: 0, features: [] }, `include=${bad}`);
  }
  for (const empty of ['', '%20', ',', '%20,%20']) {
    assert.deepEqual(JSON.parse((await srv.get(`${url}&include=${empty}`)).body), plain, `include=${empty}: come senza include`);
  }
});

test('include: al massimo 50 MMSI, i primi validi nell\'ordine dato', async () => {
  const many = Array.from({ length: 55 }, (_, i) => 247560001 + i);
  await sendAll(srv, ...many.map((m, i) => pos(m, 44.8, 11.0 + i / 1000)));
  const fc = await srv.getJson(`/api/locations?include=x,${[...many].reverse().join(',')}`);
  assert.deepEqual(ids(fc), [...many].reverse().slice(0, 50), 'le prime 50 della lista, nell\'ordine dato');
  assert.equal(fc.total, 50);
});

test('include non passa dalla cache: niente voci, niente X-Cache; gzip come le altre API piccole', async () => {
  const c = await startServer();   // cache accesa con i valori di default (LOCATIONS_CACHE_MS 3000)
  try {
    await sendAll(c, pos(247570001, 44.5, 11.5), pos(247570002, -31, -41));
    const before = await cacheOf(c);
    for (const q of ['include=247570002', 'include=247570002', 'bbox=11.4,44.4,11.7,44.6&include=247570002', 'include=abc']) {
      const res = await c.get(`/api/locations?${q}`, { 'Accept-Encoding': 'gzip' });
      assert.equal(res.status, 200, q);
      assert.equal(res.headers['x-cache'], undefined, `${q}: non servita dalla cache`);
      assert.equal(res.headers['content-encoding'], 'gzip', `${q}: compressa`);
    }
    const after = await cacheOf(c);
    assert.deepEqual([after.size, after.hits, after.misses], [before.size, before.hits, before.misses], 'nessuna voce creata o letta');
    const plain = await c.get('/api/locations?bbox=11.4,44.4,11.7,44.6');
    assert.equal(plain.headers['x-cache'], 'miss', 'la richiesta con bbox e include non aveva creato la voce della vista');
    assert.equal(JSON.parse(plain.body).features.some(f => f.mmsi === 247570002), false, 'la vista non contiene la nave inclusa da altri');
  } finally { await c.stop(); }
});

test('cache: viste vicine di utenti con navi selezionate diverse condividono la voce; la nave inclusa è sempre aggiornata', async () => {
  const c = await startServer();
  try {
    const zone = Array.from({ length: 10 }, (_, i) => 247580000 + i);
    await sendAll(c, ...zone.map((m, i) => pos(m, 44.5, 11.5 + i / 100)), pos(247589999, -31, -41));
    // due utenti: viste leggermente diverse (stesso bbox arrotondato), navi selezionate diverse
    const user = async (bbox, mmsi) => {
      const [view, inc] = await Promise.all([c.get(`/api/locations?bbox=${bbox}`), c.get(`/api/locations?include=${mmsi}`)]);
      return { cache: view.headers['x-cache'], view: ids(JSON.parse(view.body)).sort(), inc: JSON.parse(inc.body).features };
    };
    const a = await user('11.41,44.41,11.69,44.59', 247580003);
    const b = await user('11.40,44.40,11.70,44.60', 247589999);
    assert.equal(a.cache, 'miss');
    assert.equal(b.cache, 'hit', 'stessa voce per la vista, anche con navi selezionate diverse');
    assert.deepEqual(b.view, a.view);
    assert.deepEqual(a.inc.map(f => f.mmsi), [247580003]);
    assert.deepEqual(b.inc.map(f => f.mmsi), [247589999], 'la nave fuori vista arriva da include');
    assert.equal((await cacheOf(c)).size, 1, 'una sola voce');
    // messaggio nuovo per la nave selezionata: la vista (in cache per 3 s) è ancora vecchia, include no
    await sendAll(c, pos(247580003, 44.5001, 11.5301));   // spostamento piccolo: non è un salto da confermare
    const again = await user('11.41,44.41,11.69,44.59', 247580003);
    assert.equal(again.cache, 'hit');
    assert.deepEqual(again.inc[0].geometry.coordinates, [11.5301, 44.5001], 'la nave inclusa ha subito la posizione nuova');
    assert.deepEqual(JSON.parse((await c.get('/api/locations?bbox=11.41,44.41,11.69,44.59')).body).features
      .find(f => f.mmsi === 247580003).geometry.coordinates, [11.53, 44.5], 'mentre la vista in cache è ancora quella vecchia');
  } finally { await c.stop(); }
});
