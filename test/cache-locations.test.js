// Punto 84 del Piano: cache della risposta (anche compressa) di /api/locations.
// Una voce si riusa se ha meno di LOCATIONS_CACHE_MS, oppure se i dati non sono cambiati e ha meno di 60 s.
// Il bbox è arrotondato verso l'esterno a 0,25°: viste quasi uguali condividono la stessa voce.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer, waitFor } = require('./helpers');

const TTL = 300;
const GZ = { 'Accept-Encoding': 'gzip' };
let s;

const position = (mmsi, lat, lon) => JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi },
  Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: 5, Cog: 90, NavigationalStatus: 0 } } });

async function sendAll(server, ...msgs) {
  const start = (await server.getJson('/api/status')).messages;
  for (const m of msgs) server.socket.send(m);
  await waitFor(async () => (await server.getJson('/api/status')).messages >= start + msgs.length, 'messaggi elaborati');
}

const body = res => JSON.parse((res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body).toString('utf8'));
const ids = res => body(res).features.map(f => f.mmsi).sort();
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  s = await startServer({ LOCATIONS_CACHE_MS: String(TTL) });
  await sendAll(s, position(247100001, 45.43, 12.33));
});
after(() => s?.stop());

test('la seconda richiesta uguale è servita dalla cache con gli stessi byte', async () => {
  const url = '/api/locations?bbox=10,40,15,50';
  const a = await s.get(url, GZ), b = await s.get(url, GZ);
  assert.equal(a.headers['x-cache'], 'miss');
  assert.equal(b.headers['x-cache'], 'hit');
  assert.equal(b.headers['content-encoding'], 'gzip');
  assert.match(b.headers.vary, /Accept-Encoding/);
  assert.ok(a.body.equals(b.body), 'stessi byte');
  assert.deepEqual(ids(b), [247100001]);
  const st = await s.getJson('/api/status');
  assert.ok(st.locationsCache.hits >= 1, 'hits in /api/status');
  assert.ok(st.locationsCache.misses >= 1);
  assert.ok(st.locationsCache.size >= 1);
});

test('due bbox vicini arrotondati allo stesso 0,25° condividono la voce', async () => {
  const a = await s.get('/api/locations?bbox=12.30,45.40,12.36,45.46', GZ);
  const b = await s.get('/api/locations?bbox=12.31,45.41,12.35,45.45', GZ);
  assert.equal(a.headers['x-cache'], 'miss');
  assert.equal(b.headers['x-cache'], 'hit');
  assert.deepEqual(ids(a), [247100001]);
  assert.deepEqual(ids(b), [247100001]);
});

test('una nave nuova compare entro circa 1 s, con una risposta ricalcolata', async () => {
  const url = '/api/locations?bbox=12,45,13,46';
  await s.get(url, GZ);
  await sendAll(s, position(247100002, 45.5, 12.5));
  let res;
  await waitFor(async () => (res = await s.get(url, GZ), ids(res).includes(247100002)), 'nave nuova nella risposta', 1000);
  assert.equal(res.headers['x-cache'], 'miss', 'la prima risposta con la nave nuova è ricalcolata');
});

test('con i dati fermi la voce resta valida anche oltre LOCATIONS_CACHE_MS', async () => {
  const url = '/api/locations?bbox=0,30,20,50';
  assert.equal((await s.get(url, GZ)).headers['x-cache'], 'miss');
  await sleep(TTL + 200);
  assert.equal((await s.get(url, GZ)).headers['x-cache'], 'hit');
});

test('con e senza gzip la stessa voce dà lo stesso JSON', async () => {
  const url = '/api/locations?bbox=11,44,14,47';
  const plain = await s.get(url), gz = await s.get(url, GZ);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers['x-cache'], 'hit');
  assert.equal(zlib.gunzipSync(gz.body).toString('utf8'), plain.body.toString('utf8'));
});

test('richieste contemporanee ricevono la stessa risposta compressa', async () => {
  const url = '/api/locations?bbox=-20,20,40,60';
  const all = await Promise.all(Array.from({ length: 5 }, () => s.get(url, GZ)));
  for (const r of all) assert.ok(r.body.equals(all[0].body));
  assert.deepEqual(ids(all[0]), [247100001, 247100002]);
});

test('bbox non valido usa la voce del mondo; limit resta nella chiave', async () => {
  await s.get('/api/locations', GZ);
  assert.equal((await s.get('/api/locations?bbox=a,b,c,d', GZ)).headers['x-cache'], 'hit');
  const lim = await s.get('/api/locations?limit=1', GZ);
  assert.equal(lim.headers['x-cache'], 'miss');
  assert.equal(body(lim).features.length, 1);
  assert.equal(body(lim).total, 2);
});

test('il bbox che attraversa l\'antimeridiano resta corretto dopo l\'arrotondamento', async () => {
  await sendAll(s, position(311100001, -17.5, 179.5), position(311100002, -17.5, -179.5), position(311100003, -17.5, 0));
  const res = await s.get('/api/locations?bbox=179.1,-20,-179.1,-15', GZ);
  assert.deepEqual(ids(res), [311100001, 311100002]);
});

test('LOCATIONS_CACHE_SIZE=0 spegne la cache', async () => {
  const off = await startServer({ LOCATIONS_CACHE_SIZE: '0' });
  try {
    await sendAll(off, position(247100001, 45.43, 12.33));
    for (let i = 0; i < 3; i++) assert.equal((await off.get('/api/locations?bbox=10,40,15,50', GZ)).headers['x-cache'], 'miss');
    const st = await off.getJson('/api/status');
    assert.equal(st.locationsCache.hits, 0);
    assert.equal(st.locationsCache.size, 0);
  } finally { await off.stop(); }
});

test('oltre LOCATIONS_CACHE_SIZE esce la voce inserita per prima', async () => {
  const one = await startServer({ LOCATIONS_CACHE_SIZE: '1' });
  try {
    const x = '/api/locations?bbox=10,40,15,50', y = '/api/locations?bbox=0,0,5,5';
    assert.equal((await one.get(x)).headers['x-cache'], 'miss');
    assert.equal((await one.get(x)).headers['x-cache'], 'hit');
    assert.equal((await one.get(y)).headers['x-cache'], 'miss');
    assert.equal((await one.get(x)).headers['x-cache'], 'miss', 'x è uscita quando è entrata y');
    assert.equal((await one.getJson('/api/status')).locationsCache.size, 1);
  } finally { await one.stop(); }
});
