// Punto 8 del Piano: conservazione delle posizioni per stato della nave. In moto fino a STALE_MOVING_MS
// (default 30 min), ferma, all'ancora o ormeggiata (isStill di public/ais-logic.js) fino a STALE_STILL_MS
// (default 6 h). Qui i limiti sono brevi (600 ms e 2000 ms) per vedere le navi sparire in pochi secondi, con margini
// larghi per le CI lente: «ancora presente» si misura dall'ora prima dell'invio, «già scaduta» da quella dopo.
// /api/locations, include= e /api/search non restituiscono navi oltre il loro limite, nemmeno dalla cache;
// la pulizia periodica (POSITIONS_CLEANUP_MS) le toglie dalla memoria con lo stesso limite.
// Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { startServer, waitFor } = require('./helpers');

const MOVING_MS = 600, STILL_MS = 2000;
const LIMITS = { STALE_MOVING_MS: String(MOVING_MS), STALE_STILL_MS: String(STILL_MS) };
const GZ = { 'Accept-Encoding': 'gzip' };
const MOORED = 247800001, UNDERWAY = 247800002, ANCHOR_FAST = 247800003;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = (mmsi, name, extra) => JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: name },
  Message: { PositionReport: { Latitude: 43.5, Longitude: 10.3, Cog: 90, ...extra } } });
const body = res => JSON.parse((res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(res.body) : res.body).toString('utf8'));
const ids = fc => fc.features.map(f => f.mmsi).sort();

// Invia i messaggi e aspetta che il server li abbia contati. Restituisce { before, after }: l'ora prima dell'invio
// (le posizioni non possono essere più vecchie: «ancora presente» si controlla da qui) e quella dopo
// (non possono essere più recenti: «già scaduta» si aspetta da qui)
async function sendMessages(s, ...msgs) {
  const start = (await s.getJson('/api/status')).messages;
  const before = Date.now();
  for (const m of msgs) s.socket.send(m);
  await waitFor(async () => (await s.getJson('/api/status')).messages >= start + msgs.length, 'messaggi elaborati');
  return { before, after: Date.now() };
}
// Le tre navi (ormeggiata, in moto, «all'ancora» ma a 8 kn)
const sendShips = s => sendMessages(s, report(MOORED, 'ETA ORMEGGIATA', { Sog: 0, NavigationalStatus: 5 }),
  report(UNDERWAY, 'ETA IN MOTO', { Sog: 10, NavigationalStatus: 0 }), report(ANCHOR_FAST, 'ETA ANCORA VELOCE', { Sog: 8, NavigationalStatus: 1 }));
const until = (t0, ms) => sleep(Math.max(0, t0 + ms - Date.now()));

test('navi ferme conservate fino a STALE_STILL_MS, in moto fino a STALE_MOVING_MS; la cache non serve navi scadute (punto 8)', async () => {
  // LOCATIONS_CACHE_MS=0: vale solo la regola «dati fermi fino a 60 s», l'unica in cui una voce può durare oltre la
  // scadenza di una nave; la pulizia periodica resta a 60 s, quindi qui conta solo il filtro in lettura
  const s = await startServer({ ...LIMITS, LOCATIONS_CACHE_MS: '0' });
  try {
    const url = '/api/locations?bbox=10,43,11,44';
    const { before, after: t0 } = await sendShips(s);
    const a = await s.get(url, GZ), b = await s.get(url, GZ);
    assert.ok(Date.now() - before < MOVING_MS, 'controllo fatto prima del limite delle navi in moto');
    assert.deepEqual(ids(body(a)), [MOORED, UNDERWAY, ANCHOR_FAST].sort());
    assert.equal(body(a).total, 3);
    assert.deepEqual([a.headers['x-cache'], b.headers['x-cache']], ['miss', 'hit'], 'dati fermi: seconda richiesta dalla cache');
    assert.deepEqual(ids(await s.getJson(`/api/locations?include=${MOORED},${UNDERWAY}`)), [MOORED, UNDERWAY]);
    assert.equal((await s.getJson('/api/search?q=ETA')).length, 3);

    // oltre il limite delle navi in moto: resta solo l'ormeggiata, anche se nessun messaggio ha cambiato i dati
    await until(t0, MOVING_MS + 150);
    const c = await s.get(url, GZ);
    assert.equal(c.headers['x-cache'], 'miss', 'la voce in cache conteneva navi ora scadute: ricalcolata');
    assert.deepEqual(ids(body(c)), [MOORED], 'la nave all\'ancora a 8 kn vale come in moto');
    assert.equal(body(c).total, 1, 'total conta solo le navi ancora valide');
    assert.equal((await s.get(url, GZ)).headers['x-cache'], 'hit', 'la nuova voce si riusa fino alla prossima scadenza');
    assert.deepEqual(ids(await s.getJson(`/api/locations?include=${MOORED},${UNDERWAY}`)), [MOORED], 'include=');
    assert.deepEqual((await s.getJson('/api/search?q=ETA')).map(v => v.mmsi), [MOORED], '/api/search');
    assert.ok(Date.now() - before < STILL_MS, 'controllo fatto prima del limite delle navi ferme');

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
    await sendShips(s);
    const { before, after } = await sendMessages(s, report(MOORED, 'ETA ORMEGGIATA', { Sog: 6, NavigationalStatus: 0 }));   // riparte
    assert.ok(Date.now() - before < MOVING_MS);
    assert.ok(ids(await s.getJson('/api/locations')).includes(MOORED), 'entro il limite delle navi in moto: presente');
    await until(after, MOVING_MS + 100);
    assert.deepEqual((await s.getJson('/api/locations')).features, [], 'oltre il limite delle navi in moto: tolta');
    assert.ok(Date.now() - before < STILL_MS, 'prima del limite delle navi ferme');
    assert.deepEqual(await s.getJson('/api/search?q=ETA%20ORMEGGIATA'), []);
  } finally { await s.stop(); }
});

test('la pulizia periodica toglie dalla memoria ogni nave oltre il suo limite, non prima (punto 8)', async () => {
  const s = await startServer({ ...LIMITS, POSITIONS_CLEANUP_MS: '100' });
  try {
    const { after: t0 } = await sendShips(s);
    assert.equal((await s.getJson('/api/status')).vessels, 3);
    await until(t0, MOVING_MS + 300);
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
    const { after: t0 } = await sendShips(s);
    await until(t0, MOVING_MS + 100);
    assert.equal((await s.getJson('/api/locations')).total, 3, 'con i limiti normali nessuna nave è scaduta');
  } finally { await s.stop(); }
  const zero = await startServer({ STALE_MOVING_MS: '0', STALE_STILL_MS: '' });
  try {
    assert.deepEqual((await zero.getJson('/api/status')).limits, { movingMs: 30 * 60000, stillMs: 6 * 3600000 }, '0 e vuoto non valgono');
  } finally { await zero.stop(); }
  const short = await startServer({ STALE_MOVING_MS: '1000', STALE_STILL_MS: '10' });
  try {
    assert.deepEqual((await short.getJson('/api/status')).limits, { movingMs: 1000, stillMs: 1000 },
      'riportati i limiti effettivi: una nave ferma si conserva almeno quanto una in moto');
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
    // velocità e stato: la pagina decide se la nave è ferma (conservata più a lungo) come per /api/locations
    assert.deepEqual([hits[0].sog, hits[0].navStat], [0, 5]);
    assert.deepEqual([hits[0].sog, hits[0].navStat], [loc.properties.sog, loc.properties.navStat]);
  } finally { await s.stop(); }
});

// --- Test consigliati dal QA -----------------------------------------------------------------------------------
const classB = (mmsi, name, sog) => JSON.stringify({ MessageType: 'StandardClassBPositionReport', MetaData: { MMSI: mmsi, ShipName: name },
  Message: { StandardClassBPositionReport: { Latitude: 43.6, Longitude: 10.4, Cog: 90, Sog: sog } } });

test('una nave in moto che si ferma passa al limite delle navi ferme; classe B a 0,1 kn conservata come ferma (punto 8)', async () => {
  const STOPS = 247800011, B_STILL = 247800012, B_MOVING = 247800013;
  const s = await startServer({ ...LIMITS, LOCATIONS_CACHE_MS: '0' });
  try {
    await sendMessages(s, report(STOPS, 'ETA SI FERMA', { Sog: 9, NavigationalStatus: 0 }));
    const { before, after } = await sendMessages(s, report(STOPS, 'ETA SI FERMA', { Sog: 0, NavigationalStatus: 5 }),
      classB(B_STILL, 'ETA B FERMA', 0.1), classB(B_MOVING, 'ETA B IN MOTO', 6));
    await until(after, MOVING_MS + 100);
    assert.ok(Date.now() - before < STILL_MS, 'prima del limite delle navi ferme');
    assert.deepEqual(ids(await s.getJson('/api/locations')), [STOPS, B_STILL].sort(), 'oltre il limite delle navi in moto restano le ferme');
    assert.deepEqual((await s.getJson('/api/search?q=ETA%20B')).map(v => v.mmsi), [B_STILL]);
    await until(after, STILL_MS + 100);
    assert.deepEqual((await s.getJson('/api/locations')).features, []);
  } finally { await s.stop(); }
});

test('cache con LOCATIONS_CACHE_MS breve: una nave scaduta resta al massimo LOCATIONS_CACHE_MS oltre il limite (punto 8)', async () => {
  const CACHE_MS = 300;
  const s = await startServer({ ...LIMITS, LOCATIONS_CACHE_MS: String(CACHE_MS) });
  try {
    await sendShips(s);
    const ts = (await s.getJson(`/api/locations?include=${UNDERWAY}`)).features[0].properties.timestampExternal;
    const url = '/api/locations?bbox=10,43,11,44';
    let late = -Infinity, hits = 0, seenGone = false;
    // richieste fitte fino a ben oltre la scadenza della nave in moto (con e senza gzip)
    while (Date.now() < ts + MOVING_MS + CACHE_MS + 300) {
      for (const headers of [GZ, {}]) {
        const res = await s.get(url, headers), now = Date.now();
        if (res.headers['x-cache'] === 'hit') hits++;
        if (ids(body(res)).includes(UNDERWAY)) late = Math.max(late, now - (ts + MOVING_MS));
        else if (now > ts + MOVING_MS) seenGone = true;
      }
      await sleep(10);
    }
    assert.ok(hits > 0, 'la cache lavora');
    assert.ok(seenGone, 'la nave scaduta sparisce');
    // late è misurato a risposta arrivata: fino a 50 ms di tolleranza per il tragitto della richiesta
    assert.ok(late <= CACHE_MS + 50, `servita fino a ${late} ms oltre il limite (al massimo LOCATIONS_CACHE_MS = ${CACHE_MS})`);
  } finally { await s.stop(); }
});
