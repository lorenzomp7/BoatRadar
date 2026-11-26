// Punto 84 del Piano: cache della risposta (anche compressa) di /api/locations.
// Una voce si riusa se ha meno di LOCATIONS_CACHE_MS, oppure se i dati non sono cambiati e ha meno di 60 s.
// Il bbox è arrotondato verso l'esterno a un passo proporzionale alla vista (da 1/64° a 0,25°): viste quasi
// uguali condividono la stessa voce. La chiave contiene solo i parametri noti (bbox arrotondato, limit effettivo).
// Ogni test usa navi e viste sue (zone diverse), così i test non dipendono dall'ordine.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
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
const cache = async (server = s) => (await server.getJson('/api/status')).locationsCache;
const assertLength = res => assert.equal(Number(res.headers['content-length']), res.body.length, 'Content-Length');

before(async () => { s = await startServer({ LOCATIONS_CACHE_MS: String(TTL) }); });
after(() => s?.stop());

test('la seconda richiesta uguale è servita dalla cache con gli stessi byte', async () => {
  await sendAll(s, position(247100001, 20, 60));
  const url = '/api/locations?bbox=59,19,61,21';
  const a = await s.get(url, GZ), b = await s.get(url, GZ);
  assert.equal(a.headers['x-cache'], 'miss');
  assert.equal(b.headers['x-cache'], 'hit');
  assert.equal(b.headers['content-encoding'], 'gzip');
  assert.match(b.headers.vary, /Accept-Encoding/);
  assert.match(b.headers['access-control-expose-headers'], /X-Cache/i, 'la pagina su Pages può leggere X-Cache');
  assertLength(a); assertLength(b);
  assert.ok(a.body.equals(b.body), 'stessi byte');
  assert.deepEqual(ids(b), [247100001]);
  const st = await cache();
  assert.ok(st.hits >= 1, 'hits in /api/status');
  assert.ok(st.misses >= 1);
  assert.ok(st.size >= 1);
});

test('la chiave contiene solo i parametri noti: ordine, parametri sconosciuti e limit equivalenti danno hit', async () => {
  await sendAll(s, position(247100011, 25, 60));
  const base = '/api/locations?bbox=59.5,24,60.5,26';
  assert.equal((await s.get(base + '&limit=10', GZ)).headers['x-cache'], 'miss');
  assert.equal((await s.get('/api/locations?limit=10&bbox=59.5,24,60.5,26', GZ)).headers['x-cache'], 'hit', 'ordine diverso');
  assert.equal((await s.get(base + '&limit=10&x=1', GZ)).headers['x-cache'], 'hit', 'parametro sconosciuto ignorato');
  assert.equal((await s.get(base, GZ)).headers['x-cache'], 'miss', 'senza limit = limit 6000, voce diversa da limit=10');
  for (const l of ['6000', '06000', 'abc', '9999', '-5', '0', '2.5']) {
    assert.equal((await s.get(`${base}&limit=${l}`, GZ)).headers['x-cache'], 'hit', `limit=${l} = limit effettivo 6000 (negativo, zero o non intero = massimo)`);
  }
  assert.equal((await s.get(`/api/locations?x=1&bbox=59.5,24,60.5,26`, GZ)).headers['x-cache'], 'hit');
});

test('due viste vicine con lo stesso arrotondamento (0,25° per viste di quasi 2°) condividono la voce', async () => {
  await sendAll(s, position(247100021, 30, 60));
  const a = await s.get('/api/locations?bbox=59.1,29.1,60.9,30.9', GZ);
  const b = await s.get('/api/locations?bbox=59.2,29.2,60.8,30.8', GZ);
  assert.equal(a.headers['x-cache'], 'miss');
  assert.equal(b.headers['x-cache'], 'hit');
  assert.deepEqual(ids(a), [247100021]);
  assert.deepEqual(ids(b), [247100021]);
});

test('vista di porto: l\'arrotondamento è proporzionale e non allarga la vista fino a 0,25°', async () => {
  // A: lato 0,1° → passo 1/64° (est 4,109375): la nave a 4,2 resta fuori. B: lato 0,2° → passo 1/32° e la include.
  await sendAll(s, position(247100031, 51.92, 4.05), position(247100032, 51.92, 4.2));
  const a = await s.get('/api/locations?bbox=4.00,51.90,4.10,51.95', GZ);
  assert.deepEqual(ids(a), [247100031], 'la nave a 4,2° non è nella vista di porto');
  assert.equal(body(a).total, 1);
  const b = await s.get('/api/locations?bbox=4.05,51.90,4.25,51.95', GZ);
  assert.equal(b.headers['x-cache'], 'miss', 'il secondo bbox ha una voce sua');
  assert.deepEqual(ids(b), [247100031, 247100032]);
});

test('una nave nuova compare entro circa 1 s, con una risposta ricalcolata', async () => {
  await sendAll(s, position(247100041, 35, 60));
  const url = '/api/locations?bbox=59,34,61,36';
  await s.get(url, GZ);
  await sendAll(s, position(247100042, 35.5, 60.5));
  let res;
  await waitFor(async () => (res = await s.get(url, GZ), ids(res).includes(247100042)), 'nave nuova nella risposta', 3000);
  assert.equal(res.headers['x-cache'], 'miss', 'la prima risposta con la nave nuova è ricalcolata');
});

test('con i dati fermi la voce resta valida anche oltre LOCATIONS_CACHE_MS', async () => {
  await sendAll(s, position(247100051, 40, 60));
  const url = '/api/locations?bbox=59,39,61,41';
  assert.equal((await s.get(url, GZ)).headers['x-cache'], 'miss');
  await sleep(TTL + 200);
  assert.equal((await s.get(url, GZ)).headers['x-cache'], 'hit');
});

test('un messaggio solo statico (senza posizione) invalida la voce', async () => {
  await sendAll(s, position(247100061, 45, 60));
  const url = '/api/locations?bbox=59,44,61,46';
  assert.equal((await s.get(url, GZ)).headers['x-cache'], 'miss');
  await sleep(TTL + 100);   // oltre LOCATIONS_CACHE_MS vale solo la regola «dati non cambiati»
  await sendAll(s, JSON.stringify({ MessageType: 'ShipStaticData', MetaData: { MMSI: 247100061 },
    Message: { ShipStaticData: { Name: 'NOME NUOVO' } } }));
  const res = await s.get(url, GZ);
  assert.equal(res.headers['x-cache'], 'miss');
  assert.equal(body(res).features[0].properties.name, 'NOME NUOVO');
});

test('con e senza gzip la stessa voce dà lo stesso JSON, con Content-Length giusto', async () => {
  await sendAll(s, position(247100071, 50, 60), position(247100072, -50, 60));
  // prima senza gzip, poi con gzip
  let url = '/api/locations?bbox=59,49,61,51';
  let plain = await s.get(url), gz = await s.get(url, GZ);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers['x-cache'], 'hit');
  assert.equal(zlib.gunzipSync(gz.body).toString('utf8'), plain.body.toString('utf8'));
  assertLength(plain); assertLength(gz);
  // prima con gzip, poi senza: il JSON si ricava dalla voce compressa
  url = '/api/locations?bbox=59,-51,61,-49';
  gz = await s.get(url, GZ); plain = await s.get(url);
  assert.equal(plain.headers['x-cache'], 'hit');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(zlib.gunzipSync(gz.body).toString('utf8'), plain.body.toString('utf8'));
  assert.deepEqual(ids(plain), [247100072]);
  assertLength(plain); assertLength(gz);
});

test('Accept-Encoding: gzip senza distinzione di maiuscole, q=0 rispettato, x-gzip ignorato', async () => {
  await sendAll(s, position(247100081, -45, 60));
  const url = '/api/locations?bbox=59,-46,61,-44';
  const enc = async ae => (await s.get(url, { 'Accept-Encoding': ae })).headers['content-encoding'];
  assert.equal(await enc('GZIP'), 'gzip');
  assert.equal(await enc('deflate, Gzip;q=0.5'), 'gzip');
  assert.equal(await enc('gzip;q=0'), undefined, 'gzip;q=0 = non compresso');
  assert.equal(await enc('gzip; q=0.000, deflate'), undefined);
  assert.equal(await enc('x-gzip'), undefined, 'x-gzip non è gzip');
  assert.equal(await enc('identity'), undefined);
  for (const ae of ['GZIP', 'gzip;q=0']) assertLength(await s.get(url, { 'Accept-Encoding': ae }));
});

test('richieste contemporanee condividono una sola compressione', async () => {
  await sendAll(s, position(247100091, 55, 60));
  const url = '/api/locations?bbox=59,54,61,56';
  const start = (await cache()).compressions;
  assert.equal(typeof start, 'number', 'compressions in /api/status');
  const all = await Promise.all(Array.from({ length: 5 }, () => s.get(url, GZ)));
  for (const r of all) assert.ok(r.body.equals(all[0].body));
  assert.deepEqual(ids(all[0]), [247100091]);
  assert.equal((await cache()).compressions, start + 1, 'una sola chiamata a gzip per la voce');
});

test('bbox non valido usa la voce del mondo; limit resta nella chiave', async () => {
  await sendAll(s, position(247100101, -30, 60), position(247100102, -30.5, 60.5));
  const world = await s.get('/api/locations', GZ);
  assert.equal((await s.get('/api/locations?bbox=a,b,c,d', GZ)).headers['x-cache'], 'hit');
  const lim = await s.get('/api/locations?limit=1', GZ);
  assert.equal(lim.headers['x-cache'], 'miss');
  // campione per importanza (punto 4): con limit=1 esattamente una nave
  assert.equal(body(lim).features.length, 1);
  assert.equal(body(lim).total, body(world).total);
  assert.ok(body(world).total >= 2);
});

test('il bbox che attraversa l\'antimeridiano resta corretto dopo l\'arrotondamento', async () => {
  await sendAll(s, position(311100001, -17.5, 179.5), position(311100002, -17.5, -179.5), position(311100003, -17.5, 0));
  const res = await s.get('/api/locations?bbox=179.1,-20,-179.1,-15', GZ);
  assert.deepEqual(ids(res), [311100001, 311100002]);
});

test('antimeridiano su quasi tutto il mondo (bbox 10.1,-20,10.05,20): compaiono le navi a 0°, 10,1° e -170°', async () => {
  await sendAll(s, position(311100011, 5, 0), position(311100012, 5, 10.1), position(311100013, 5, -170));
  const got = ids(await s.get('/api/locations?bbox=10.1,-20,10.05,20', GZ));
  for (const mmsi of [311100011, 311100012, 311100013]) assert.ok(got.includes(mmsi), `${mmsi} presente`);
});

test('bbox con sud > nord: latitudini non arrotondate, nessuna nave come prima', async () => {
  await sendAll(s, position(247100111, 45.5, 70));
  const res = await s.get('/api/locations?bbox=69.9,45.51,70.1,45.49', GZ);
  assert.equal(body(res).total, 0);
  assert.deepEqual(ids(res), []);
});

test('HEAD risponde con le intestazioni e senza corpo', async () => {
  await sendAll(s, position(247100121, -40, 60));
  const url = '/api/locations?bbox=59,-41,61,-39';
  const get = await s.get(url, GZ);
  const head = await s.request('HEAD', url, GZ);
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0, 'nessun corpo');
  assert.equal(head.headers['content-length'], String(get.body.length));
  assert.equal(head.headers['x-cache'], 'hit');
});

test('un client che chiude durante la compressione non fa cadere il server', async () => {
  await sendAll(s, position(247100131, -35, 60));
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise(resolve => {
    const sock = net.connect(s.port, '127.0.0.1', () => {
      sock.write(`GET /api/locations?bbox=${-60 + i},-36,${-58 + i},-34 HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\n\r\n`);
      setImmediate(() => { sock.destroy(); resolve(); });
    });
    sock.on('error', resolve);
  })));
  await sleep(100);
  const res = await s.get('/api/locations?bbox=59,-36,61,-34', GZ);
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [247100131]);
});

test('Vary con CORS_ORIGIN: Origin e Accept-Encoding', async () => {
  const c = await startServer({ CORS_ORIGIN: 'https://lorenzomp7.github.io' });
  try {
    const res = await c.get('/api/locations', GZ);
    assert.equal(res.headers['access-control-allow-origin'], 'https://lorenzomp7.github.io');
    assert.equal(res.headers.vary, 'Origin, Accept-Encoding');
    assert.match(res.headers['access-control-expose-headers'], /X-Cache/i);
  } finally { await c.stop(); }
});

test('LOCATIONS_CACHE_SIZE=0 spegne la cache', async () => {
  const off = await startServer({ LOCATIONS_CACHE_SIZE: '0' });
  try {
    await sendAll(off, position(247100001, 45.43, 12.33));
    for (let i = 0; i < 3; i++) assert.equal((await off.get('/api/locations?bbox=10,40,15,50', GZ)).headers['x-cache'], 'miss');
    const st = await cache(off);
    assert.equal(st.hits, 0);
    assert.equal(st.size, 0);
    assert.equal(st.bytes, 0);
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
    assert.equal((await cache(one)).size, 1);
  } finally { await one.stop(); }
});

test('una voce chiesta con gzip tiene solo i byte compressi; senza gzip tiene anche il JSON', async () => {
  const b = await startServer();
  try {
    await sendAll(b, position(247100141, 45.43, 12.33));
    const gz = await b.get('/api/locations?bbox=10,40,15,50', GZ);
    assert.equal((await cache(b)).bytes, gz.body.length, 'solo gz in memoria');
    const plain = await b.get('/api/locations?bbox=0,0,5,5');
    const gz2 = await b.get('/api/locations?bbox=0,0,5,5', GZ);
    assert.equal(gz2.headers['x-cache'], 'hit');
    assert.equal((await cache(b)).bytes, gz.body.length + plain.body.length + gz2.body.length, 'raw + gz');
  } finally { await b.stop(); }
});

test('LOCATIONS_CACHE_BYTES: la cache resta sotto il tetto in byte espellendo le voci più vecchie', async () => {
  const LIMIT = 1000;
  const small = await startServer({ LOCATIONS_CACHE_BYTES: String(LIMIT) });
  try {
    await sendAll(small, position(247100151, 45.43, 12.33));
    for (let i = 0; i < 12; i++) {
      await small.get(`/api/locations?bbox=${i},40,${i + 15},50`, i % 3 ? GZ : {});
      const st = await cache(small);
      assert.ok(st.bytes <= LIMIT, `${st.bytes} byte dopo ${i + 1} viste (tetto ${LIMIT})`);
      assert.ok(st.size >= 1, 'le voci recenti restano');
    }
    assert.ok((await cache(small)).size < 12, 'qualcuna è stata espulsa');
    // l'ultima vista è ancora in cache, la prima no
    assert.equal((await small.get('/api/locations?bbox=11,40,26,50', GZ)).headers['x-cache'], 'hit');
    assert.equal((await small.get('/api/locations?bbox=0,40,15,50', GZ)).headers['x-cache'], 'miss');
  } finally { await small.stop(); }
});

test('le voci non più riusabili vengono tolte dalla pulizia periodica', async () => {
  const c = await startServer({ LOCATIONS_CACHE_MS: '50', LOCATIONS_CACHE_STABLE_MS: '100', LOCATIONS_CACHE_CLEANUP_MS: '50' });
  try {
    for (let i = 0; i < 3; i++) await c.get(`/api/locations?bbox=${i},0,${i + 1},1`, GZ);
    assert.ok((await cache(c)).size >= 1);
    await waitFor(async () => (await cache(c)).size === 0, 'voci scadute tolte', 3000);
    assert.equal((await cache(c)).bytes, 0);
  } finally { await c.stop(); }
});

test('variabili LOCATIONS_CACHE_* non valide: valgono i default', async () => {
  const c = await startServer({ LOCATIONS_CACHE_MS: 'abc', LOCATIONS_CACHE_SIZE: '-1', LOCATIONS_CACHE_BYTES: 'tanti',
    LOCATIONS_CACHE_STABLE_MS: '', LOCATIONS_CACHE_CLEANUP_MS: 'x' });
  try {
    await sendAll(c, position(247100161, 45.43, 12.33));
    const url = '/api/locations?bbox=10,40,15,50';
    assert.equal((await c.get(url, GZ)).headers['x-cache'], 'miss');
    await sendAll(c, position(247100162, -45, -60));   // i dati cambiano, ma entro 3 s (default) la voce vale
    assert.equal((await c.get(url, GZ)).headers['x-cache'], 'hit', 'cache accesa con LOCATIONS_CACHE_MS di default');
    assert.equal((await cache(c)).size, 1);
  } finally { await c.stop(); }
});

test('se gzip fallisce la risposta arriva non compressa e la voce non resta in cache', async () => {
  const c = await startServer({ NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'gzip-in-errore.js'))}` });
  try {
    await sendAll(c, position(247100171, 45.43, 12.33));
    for (let i = 0; i < 2; i++) {
      const res = await c.get('/api/locations?bbox=10,40,15,50', GZ);
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], undefined);
      assertLength(res);
      assert.deepEqual(ids(res), [247100171]);
    }
    const st = await cache(c);
    assert.equal(st.size, 0);
    assert.equal(st.bytes, 0);
  } finally { await c.stop(); }
});

// Punto 9 (a), correzioni: quota separata per le voci con filtro (LOCATIONS_CACHE_FILTERED, default 20, al massimo
// LOCATIONS_CACHE_SIZE; 0 = le richieste filtrate non entrano in cache). Una voce filtrata nuova espelle la più vecchia
// FILTRATA, anche quando si supera il tetto totale di voci o di byte: il traffico filtrato non espelle mai le voci senza
// filtro. locationsCache di /api/status riporta anche filtered.
const VIEW = '/api/locations?bbox=10,40,15,50';
const filtered = i => `${VIEW}&seen=${i}`;   // filtri diversi: una voce ciascuno
const xc = async (server, url, headers = GZ) => (await server.get(url, headers)).headers['x-cache'];

test('50 richieste con filtri diversi non espellono la voce senza filtro; al massimo 20 voci filtrate', async () => {
  const c = await startServer();
  try {
    await sendAll(c, position(247100181, 45.43, 12.33));
    assert.equal(await xc(c, VIEW), 'miss');
    for (let i = 1; i <= 50; i++) assert.equal(await xc(c, filtered(i)), 'miss', `seen=${i}`);
    const st = await cache(c);
    assert.equal(st.filtered, 20, 'quota di default');
    assert.equal(st.size, 21, 'la voce senza filtro più le 20 filtrate');
    assert.equal(await xc(c, VIEW), 'hit', 'la voce senza filtro è ancora in cache');
    assert.equal(await xc(c, filtered(50)), 'hit', 'le filtrate più recenti restano');
    assert.equal(await xc(c, filtered(31)), 'hit');
    assert.equal(await xc(c, filtered(30)), 'miss', 'la più vecchia filtrata è uscita');
    assert.equal((await cache(c)).filtered, 20);
  } finally { await c.stop(); }
});

test('tetto totale di voci: una voce filtrata in più espelle la filtrata più vecchia, non quelle senza filtro', async () => {
  const c = await startServer({ LOCATIONS_CACHE_SIZE: '3', LOCATIONS_CACHE_FILTERED: '2' });
  try {
    const u1 = VIEW, u2 = '/api/locations?bbox=0,0,5,5';
    for (const url of [u1, u2, filtered(1), filtered(2)]) assert.equal(await xc(c, url), 'miss', url);
    let st = await cache(c);
    assert.deepEqual([st.size, st.filtered], [3, 1], 'tre voci in tutto: è uscita la filtrata più vecchia');
    assert.equal(await xc(c, u1), 'hit');
    assert.equal(await xc(c, u2), 'hit');
    assert.equal(await xc(c, filtered(2)), 'hit');
    assert.equal(await xc(c, filtered(1)), 'miss');
    assert.equal(await xc(c, u1), 'hit', 'rientrando seen=1 è uscita seen=2, non u1');
    assert.equal(await xc(c, u2), 'hit');
    st = await cache(c);
    assert.deepEqual([st.size, st.filtered], [3, 1]);
    // una voce senza filtro oltre il tetto espelle la più vecchia in assoluto, come prima
    assert.equal(await xc(c, '/api/locations?bbox=20,20,25,25'), 'miss');
    assert.equal(await xc(c, u1), 'miss', 'u1 era la voce più vecchia');
  } finally { await c.stop(); }
});

test('tetto in byte: le voci filtrate espellono solo voci filtrate', async () => {
  const LIMIT = 1500;
  const c = await startServer({ LOCATIONS_CACHE_BYTES: String(LIMIT) });
  try {
    await sendAll(c, position(247100191, 45.43, 12.33));
    const plain = await c.get(VIEW);                 // senza gzip: la voce tiene il JSON
    assert.ok(plain.body.length < LIMIT / 3, `voce senza filtro di ${plain.body.length} byte`);
    for (let i = 1; i <= 30; i++) {
      await c.get(filtered(i), i % 2 ? GZ : {});
      assert.ok((await cache(c)).bytes <= LIMIT, `sotto il tetto dopo ${i} filtrate`);
    }
    const st = await cache(c);
    assert.ok(st.filtered < 20, `qualche filtrata espulsa per i byte (${st.filtered} restano)`);
    assert.equal(await xc(c, VIEW, {}), 'hit', 'la voce senza filtro resta');
    assert.equal(await xc(c, filtered(30)), 'hit', 'la filtrata più recente resta');
  } finally { await c.stop(); }
});

test('LOCATIONS_CACHE_FILTERED=0: le richieste filtrate non entrano in cache, le altre sì', async () => {
  const c = await startServer({ LOCATIONS_CACHE_FILTERED: '0' });
  try {
    await sendAll(c, position(247100201, 45.43, 12.33));
    for (let i = 0; i < 3; i++) assert.equal(await xc(c, filtered(5)), 'miss', 'filtrata: sempre miss');
    assert.equal(await xc(c, VIEW), 'miss');
    assert.equal(await xc(c, VIEW), 'hit');
    const st = await cache(c);
    assert.deepEqual([st.size, st.filtered], [1, 0]);
    assert.deepEqual(body(await c.get(filtered(5), GZ)).features.map(f => f.mmsi), [247100201], 'risposta comunque giusta');
  } finally { await c.stop(); }
});

test('LOCATIONS_CACHE_FILTERED non valido = 20, decimali per difetto; oltre LOCATIONS_CACHE_SIZE vale LOCATIONS_CACHE_SIZE', async () => {
  for (const [env, size, quota] of [[{ LOCATIONS_CACHE_FILTERED: 'abc' }, 50, 20], [{ LOCATIONS_CACHE_FILTERED: '-1' }, 50, 20],
    [{ LOCATIONS_CACHE_FILTERED: '' }, 50, 20], [{ LOCATIONS_CACHE_FILTERED: '2.7' }, 50, 2],
    [{ LOCATIONS_CACHE_SIZE: '4', LOCATIONS_CACHE_FILTERED: '10' }, 4, 3]]) {
    const c = await startServer(env);
    try {
      assert.equal(await xc(c, VIEW), 'miss');
      for (let i = 1; i <= 25; i++) await c.get(filtered(i), GZ);
      const st = await cache(c);
      assert.equal(st.filtered, quota, JSON.stringify(env));
      assert.equal(st.size, Math.min(size, quota + 1), JSON.stringify(env));
      assert.equal(await xc(c, VIEW), 'hit', `${JSON.stringify(env)}: la voce senza filtro resta`);
    } finally { await c.stop(); }
  }
});
