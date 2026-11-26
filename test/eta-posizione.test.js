// Punto 8 del Piano: conservazione delle posizioni per stato della nave. In moto fino a STALE_MOVING_MS
// (default 30 min), ferma, all'ancora o ormeggiata (isStill di public/ais-logic.js) fino a STALE_STILL_MS
// (default 6 h). Qui i limiti sono brevi (300 ms e 1500 ms) per vedere le navi sparire in pochi secondi.
// /api/locations, include= e /api/search non restituiscono navi oltre il loro limite, nemmeno dalla cache;
// la pulizia periodica (POSITIONS_CLEANUP_MS) le toglie dalla memoria con lo stesso limite.
// Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer, waitFor } = require('./helpers');

const MOVING_MS = 300, STILL_MS = 1500;
const LIMITS = { STALE_MOVING_MS: String(MOVING_MS), STALE_STILL_MS: String(STILL_MS) };
const GZ = { 'Accept-Encoding': 'gzip' };
const MOORED = 247800001, UNDERWAY = 247800002, ANCHOR_FAST = 247800003;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = (mmsi, name, extra) => JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: name },
  Message: { PositionReport: { Latitude: 43.5, Longitude: 10.3, Cog: 90, ...extra } } });
const body = res => JSON.parse((res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body).toString('utf8'));
const ids = fc => fc.features.map(f => f.mmsi).sort();

// Invia le tre navi (ormeggiata, in moto, «all'ancora» ma a 8 kn) e restituisce l'ora in cui il server le ha contate
async function sendShips(s) {
  const start = (await s.getJson('/api/status')).messages;
  s.socket.send(report(MOORED, 'ETA ORMEGGIATA', { Sog: 0, NavigationalStatus: 5 }));
  s.socket.send(report(UNDERWAY, 'ETA IN MOTO', { Sog: 10, NavigationalStatus: 0 }));
  s.socket.send(report(ANCHOR_FAST, 'ETA ANCORA VELOCE', { Sog: 8, NavigationalStatus: 1 }));
  await waitFor(async () => (await s.getJson('/api/status')).messages >= start + 3, 'messaggi elaborati');
  return Date.now();
}
const until = (t0, ms) => sleep(Math.max(0, t0 + ms - Date.now()));

test('navi ferme conservate fino a STALE_STILL_MS, in moto fino a STALE_MOVING_MS; la cache non serve navi scadute (punto 8)', async () => {
  // LOCATIONS_CACHE_MS=0: vale solo la regola «dati fermi fino a 60 s», l'unica in cui una voce può durare oltre la
  // scadenza di una nave; la pulizia periodica resta a 60 s, quindi qui conta solo il filtro in lettura
  const s = await startServer({ ...LIMITS, LOCATIONS_CACHE_MS: '0' });
  try {
    const url = '/api/locations?bbox=10,43,11,44';
    const t0 = await sendShips(s);
    const a = await s.get(url, GZ), b = await s.get(url, GZ);
    assert.ok(Date.now() - t0 < MOVING_MS, 'controllo fatto prima del limite delle navi in moto');
    assert.deepEqual(ids(body(a)), [MOORED, UNDERWAY, ANCHOR_FAST].sort());
    assert.equal(body(a).total, 3);
    assert.deepEqual([a.headers['x-cache'], b.headers['x-cache']], ['miss', 'hit'], 'dati fermi: seconda richiesta dalla cache');
    assert.deepEqual(ids(await s.getJson(`/api/locations?include=${MOORED},${UNDERWAY}`)), [MOORED, UNDERWAY]);
    assert.equal((await s.getJson('/api/search?q=ETA')).length, 3);

    // oltre il limite delle navi in moto: resta solo l'ormeggiata, anche se nessun messaggio ha cambiato i dati
    await until(t0, 2 * MOVING_MS);
    const c = await s.get(url, GZ);
    assert.equal(c.headers['x-cache'], 'miss', 'la voce in cache conteneva navi ora scadute: ricalcolata');
    assert.deepEqual(ids(body(c)), [MOORED], 'la nave all\'ancora a 8 kn vale come in moto');
    assert.equal(body(c).total, 1, 'total conta solo le navi ancora valide');
    assert.equal((await s.get(url, GZ)).headers['x-cache'], 'hit', 'la nuova voce si riusa fino alla prossima scadenza');
    assert.deepEqual(ids(await s.getJson(`/api/locations?include=${MOORED},${UNDERWAY}`)), [MOORED], 'include=');
    assert.deepEqual((await s.getJson('/api/search?q=ETA')).map(v => v.mmsi), [MOORED], '/api/search');
    assert.ok(Date.now() - t0 < STILL_MS, 'controllo fatto prima del limite delle navi ferme');

    // oltre il limite delle navi ferme: nessuna
    await until(t0, STILL_MS + 300);
    const d = body(await s.get(url, GZ));
    assert.deepEqual([d.features, d.total], [[], 0]);
    assert.deepEqual((await s.getJson(`/api/locations?include=${MOORED}`)).features, []);
    assert.deepEqual(await s.getJson('/api/search?q=ETA'), []);
    // vista mondo (senza bbox): stesso filtro
    assert.equal((await s.getJson('/api/locations')).total, 0);
  } finally { await s.stop(); }
});

test('una nave ferma che riparte usa di nuovo il limite delle navi in moto (punto 8)', async () => {
  const s = await startServer({ ...LIMITS, LOCATIONS_CACHE_MS: '0' });
  try {
    const t0 = await sendShips(s);
    const start = (await s.getJson('/api/status')).messages;
    s.socket.send(report(MOORED, 'ETA ORMEGGIATA', { Sog: 6, NavigationalStatus: 0 }));   // riparte
    await waitFor(async () => (await s.getJson('/api/status')).messages > start, 'messaggio elaborato');
    await until(t0, 2 * MOVING_MS + 50);
    assert.deepEqual((await s.getJson('/api/locations')).features, []);
  } finally { await s.stop(); }
});

test('la pulizia periodica toglie dalla memoria ogni nave oltre il suo limite, non prima (punto 8)', async () => {
  const s = await startServer({ ...LIMITS, POSITIONS_CLEANUP_MS: '100' });
  try {
    const t0 = await sendShips(s);
    assert.equal((await s.getJson('/api/status')).vessels, 3);
    await until(t0, 2 * MOVING_MS + 150);
    assert.equal((await s.getJson('/api/status')).vessels, 1, 'resta in memoria solo l\'ormeggiata');
    await until(t0, STILL_MS + 400);
    assert.equal((await s.getJson('/api/status')).vessels, 0);
  } finally { await s.stop(); }
});

test('limiti in /api/status; valori non validi = limiti normali (30 min e 6 h) (punto 8)', async () => {
  const def = await startServer();
  try {
    assert.deepEqual((await def.getJson('/api/status')).limits, { movingMs: 30 * 60000, stillMs: 6 * 3600000 });
  } finally { await def.stop(); }
  const s = await startServer({ STALE_MOVING_MS: 'abc', STALE_STILL_MS: '-5', POSITIONS_CLEANUP_MS: 'x', LOCATIONS_CACHE_MS: '0' });
  try {
    assert.deepEqual((await s.getJson('/api/status')).limits, { movingMs: 30 * 60000, stillMs: 6 * 3600000 });
    const t0 = await sendShips(s);
    await until(t0, 2 * MOVING_MS);
    assert.equal((await s.getJson('/api/locations')).total, 3, 'con i limiti normali nessuna nave è scaduta');
  } finally { await s.stop(); }
  const zero = await startServer({ STALE_MOVING_MS: '0', STALE_STILL_MS: '' });
  try {
    assert.deepEqual((await zero.getJson('/api/status')).limits, { movingMs: 30 * 60000, stillMs: 6 * 3600000 }, '0 e vuoto non valgono');
  } finally { await zero.stop(); }
  const short = await startServer({ STALE_MOVING_MS: '1000', STALE_STILL_MS: '10' });
  try {
    assert.deepEqual((await short.getJson('/api/status')).limits, { movingMs: 1000, stillMs: 10 },
      'riportati come dati: retentionMs usa comunque almeno movingMs per le navi ferme');
  } finally { await short.stop(); }
});

test('/api/search riporta timestampExternal, per il pallino dell\'età nei risultati (punto 62)', async () => {
  const s = await startServer({ LOCATIONS_CACHE_MS: '0' });
  try {
    const before = Date.now();
    await sendShips(s);
    const hits = await s.getJson('/api/search?q=ETA%20ORMEGGIATA');
    assert.equal(hits.length, 1);
    assert.equal(typeof hits[0].timestampExternal, 'number');
    assert.ok(hits[0].timestampExternal >= before && hits[0].timestampExternal <= Date.now());
    const loc = (await s.getJson(`/api/locations?include=${MOORED}`)).features[0];
    assert.equal(hits[0].timestampExternal, loc.properties.timestampExternal, 'stesso orario di /api/locations');
  } finally { await s.stop(); }
});
