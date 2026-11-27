// Punto 22: dati statici delle navi conservati fra un riavvio e l'altro (snapshot.js, funzioni senza server).
// Il server con SNAPSHOT_FILE è in test/snapshot-server.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const S = require('../snapshot');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const H = 3600000;
const full = (mmsi, staticTs, extra = {}) => ({ mmsi, name: 'LAGUNA PRIMA', imo: 9074729, callSign: 'IABC', shipType: 70,
  destination: 'VENEZIA', draught: 7.5, length: 120, width: 18, eta: { month: 12, day: 2, hour: 8, minute: null }, staticTs, ...extra });
const collect = async it => { const out = []; for await (const s of it) out.push(s); return out; };
const file = list => ({ format: 'boatradar-vessels', version: 1, savedAt: NOW, vessels: list });

test('SNAPSHOT_FIELDS e pickStatic: solo i dati statici, senza valori mancanti', () => {
  assert.deepEqual(S.SNAPSHOT_FIELDS, ['name', 'imo', 'callSign', 'shipType', 'destination', 'draught', 'length', 'width', 'eta', 'staticTs']);
  const v = { ...full(247123450, NOW), imo: null, lat: 45, sog: 3, extra: 'x' };
  assert.deepEqual(S.pickStatic(v), { name: 'LAGUNA PRIMA', callSign: 'IABC', shipType: 70, destination: 'VENEZIA', draught: 7.5,
    length: 120, width: 18, eta: { month: 12, day: 2, hour: 8, minute: null }, staticTs: NOW });
});

test('andata e ritorno: serialize → gzip → gunzip → restore', async () => {
  const vessels = new Map([
    [247123450, full(247123450, NOW - H)],
    [538001234, { mmsi: 538001234, name: 'FERMA', staticTs: NOW - 2 * H }],
    [211000001, full(211000001, NOW - 47 * H, { eta: null, imo: null })],
  ]);
  const buf = await S.encode(S.serialize(vessels, { now: NOW }));
  assert.equal(buf[0], 0x1f, 'gzip');
  const obj = await S.decode(buf);
  assert.equal(obj.format, 'boatradar-vessels');
  assert.equal(obj.version, 1);
  assert.equal(obj.savedAt, NOW);
  const back = S.restore(obj, { now: NOW });
  assert.deepEqual(new Map(back), new Map([...vessels].map(([m, v]) => [m, { mmsi: m, ...S.pickStatic(v) }])));
  // ordinate per staticTs, dalla più vecchia
  assert.deepEqual(obj.vessels.map(([m]) => m), [211000001, 538001234, 247123450]);
});

test('serialize: escluse le navi senza staticTs o con dati statici di oltre 48 h', async () => {
  const vessels = new Map([
    [1, { mmsi: 1, name: 'SENZA STATICI' }],
    [2, { mmsi: 2, name: 'VECCHIA', staticTs: NOW - 48 * H }],
    [3, { mmsi: 3, name: 'QUASI', staticTs: NOW - 48 * H + 1 }],
    [4, { mmsi: 4, name: 'NAN', staticTs: NaN }],
    [5, { mmsi: 5, name: 'BREVE', staticTs: NOW - H }],
  ]);
  const stats = {};
  const obj = JSON.parse((await collect(S.serialize(vessels, { now: NOW, stats }))).join(''));
  assert.deepEqual(obj.vessels.map(([m]) => m), [3, 5]);
  assert.equal(stats.vessels, 2);
  const short = JSON.parse((await collect(S.serialize(vessels, { now: NOW, maxAgeMs: 2 * H }))).join(''));
  assert.deepEqual(short.vessels.map(([m]) => m), [5]);
  const none = JSON.parse((await collect(S.serialize(new Map(), { now: NOW }))).join(''));
  assert.deepEqual(none.vessels, []);
});

test('serialize: un blocco ogni `batch` navi, e il ciclo degli eventi gira fra un blocco e l\'altro', async () => {
  const vessels = new Map(Array.from({ length: 5 }, (_, i) => [100 + i, { mmsi: 100 + i, name: 'N' + i, staticTs: NOW - i }]));
  const it = S.serialize(vessels, { now: NOW, batch: 2 });
  const chunks = [];
  let ticks = 0;
  const spin = () => { ticks++; if (ticks < 100) setImmediate(spin); };
  setImmediate(spin);
  const seen = [];
  for await (const c of it) { chunks.push(c); seen.push(ticks); }
  assert.equal(chunks.length, 1 + 3 + 1, 'intestazione, 3 blocchi da al massimo 2 navi, chiusura');
  assert.ok(seen[3] > seen[1], 'setImmediate eseguiti fra i blocchi');
  assert.equal(JSON.parse(chunks.join('')).vessels.length, 5);
});

test('restore: formato e versione sconosciuti o file non valido → nessuna nave, mai un\'eccezione', () => {
  const ok = [[247123450, { name: 'A', staticTs: NOW }]];
  for (const obj of [null, undefined, 42, 'x', [], {}, { ...file(ok), format: 'altro' }, { ...file(ok), version: 2 },
    { ...file(ok), version: '1' }, { ...file('x') }, { ...file(null) }, file([null, 1, 'x', [], [1], [1, null], [1, 'x']])]) {
    assert.deepEqual(S.restore(obj, { now: NOW }), [], JSON.stringify(obj));
  }
  // anche un oggetto che lancia leggendo una proprietà
  const evil = { format: 'boatradar-vessels', version: 1, get vessels() { throw new Error('no'); } };
  assert.deepEqual(S.restore(evil, { now: NOW }), []);
  assert.deepEqual(S.restore(file(ok), { now: NOW }), [[247123450, { mmsi: 247123450, name: 'A', staticTs: NOW }]]);
});

test('restore: MMSI interi da 1 a 999999999, doppioni tenuti una volta (dati più recenti)', () => {
  const e = (m, ts = NOW) => [m, { name: 'X', staticTs: ts }];
  const got = S.restore(file([e(0), e(-1), e(1.5), e('247123450'), e(1e9), e(NaN), e(1), e(999999999), e(5, NOW - 2), e(5, NOW - 1), e(5, NOW - 3)]), { now: NOW });
  assert.deepEqual(got.map(([m]) => m).sort((a, b) => a - b), [1, 5, 999999999]);
  assert.equal(new Map(got).get(5).staticTs, NOW - 1);
});

test('restore: staticTs finito, al massimo 48 h fa e 5 min nel futuro', () => {
  const at = ts => S.restore(file([[1, { name: 'X', staticTs: ts }]]), { now: NOW }).length;
  assert.equal(at(NOW), 1);
  assert.equal(at(NOW - 48 * H + 1), 1);
  assert.equal(at(NOW - 48 * H), 0);
  assert.equal(at(NOW + 5 * 60000), 1);
  assert.equal(at(NOW + 5 * 60000 + 1), 0);
  for (const bad of [undefined, null, NaN, Infinity, '1', String(NOW)]) assert.equal(at(bad), 0, String(bad));
  assert.equal(S.restore(file([[1, { name: 'X', staticTs: NOW - 3 * H }]]), { now: NOW, maxAgeMs: 2 * H }).length, 0);
});

test('restore: ogni campo validato, i non validi tolti senza scartare la nave', () => {
  const one = fields => S.restore(file([[1, { staticTs: NOW, ...fields }]]), { now: NOW })[0][1];
  const s64 = 'A'.repeat(64);
  assert.deepEqual(one({ name: s64, callSign: '', destination: 'GENOVA' }), { mmsi: 1, name: s64, callSign: '', destination: 'GENOVA', staticTs: NOW });
  assert.deepEqual(one({ name: s64 + 'A', callSign: 5, destination: { x: 1 } }), { mmsi: 1, staticTs: NOW });
  // pescaggio 0-25,5; lunghezza 1-1023; larghezza 1-126; tipo intero 0-99
  assert.deepEqual(one({ draught: 25.5, length: 1023, width: 126, shipType: 99 }), { mmsi: 1, draught: 25.5, length: 1023, width: 126, shipType: 99, staticTs: NOW });
  assert.deepEqual(one({ draught: 0.1, length: 1, width: 1, shipType: 0 }), { mmsi: 1, draught: 0.1, length: 1, width: 1, shipType: 0, staticTs: NOW });
  for (const bad of [{ draught: 25.6 }, { draught: -1 }, { draught: Infinity }, { draught: '7' }, { length: 0 }, { length: 1024 },
    { width: 0 }, { width: 127 }, { width: NaN }, { shipType: 100 }, { shipType: -1 }, { shipType: 7.5 }, { shipType: '70' }]) {
    assert.deepEqual(one(bad), { mmsi: 1, staticTs: NOW }, JSON.stringify(bad));
  }
  // IMO: intero di 7 cifre
  assert.equal(one({ imo: 9074729 }).imo, 9074729);
  for (const imo of [999999, 10000000, 9074729.5, '9074729', null]) assert.equal(one({ imo }).imo, undefined, String(imo));
  // ETA come etaOf di server.js: mese e giorno validi, ora e minuto validi o null; altrimenti null
  assert.deepEqual(one({ eta: { month: 12, day: 2, hour: 8, minute: 30 } }).eta, { month: 12, day: 2, hour: 8, minute: 30 });
  assert.deepEqual(one({ eta: { month: 1, day: 31, hour: 24, minute: 60 } }).eta, { month: 1, day: 31, hour: null, minute: null });
  for (const eta of [{ month: 0, day: 1 }, { month: 13, day: 1 }, { month: 1, day: 0 }, { month: 1, day: 32 }, { month: '1', day: 1 }, 'x', 5, []]) {
    assert.equal(one({ eta }).eta, null, JSON.stringify(eta));
  }
  assert.equal(one({ eta: null }).eta, null);
  assert.equal('eta' in one({}), false, 'senza ETA nel file nessuna ETA');
  // campi sconosciuti (anche mmsi dentro i dati) ignorati: vale l'MMSI della voce
  assert.deepEqual(one({ mmsi: 2, lat: 45, __proto__x: 1 }), { mmsi: 1, staticTs: NOW });
});

test('restore: al massimo `max` navi, le più recenti', () => {
  const list = Array.from({ length: 10 }, (_, i) => [i + 1, { staticTs: NOW - i * 1000 }]);
  const got = S.restore(file(list), { now: NOW, max: 3 });
  assert.deepEqual(got.map(([m]) => m).sort((a, b) => a - b), [1, 2, 3]);
});

test('merge: la nave del file entra solo se il server non ha dati statici più recenti', () => {
  const vessels = new Map([[1, { mmsi: 1, name: 'NUOVA', staticTs: NOW }], [2, { mmsi: 2, name: 'SOLO POSIZIONE' }],
    [3, { mmsi: 3, name: 'VECCHIA', staticTs: NOW - 2 * H }], [4, { mmsi: 4, name: 'UGUALE', staticTs: NOW - H }]]);
  const touched = [];
  const n = S.merge(vessels, [[1, { mmsi: 1, name: 'DAL FILE', staticTs: NOW - H }], [2, { mmsi: 2, name: 'DAL FILE', staticTs: NOW - H }],
    [3, { mmsi: 3, name: 'DAL FILE', staticTs: NOW - H }], [4, { mmsi: 4, name: 'DAL FILE', staticTs: NOW - H }],
    [5, { mmsi: 5, name: 'NUOVA DAL FILE', staticTs: NOW - H }]], (mmsi, v) => touched.push([mmsi, v.name]));
  assert.equal(n, 3);
  assert.deepEqual(touched, [[2, 'DAL FILE'], [3, 'DAL FILE'], [5, 'NUOVA DAL FILE']]);
  assert.equal(vessels.get(1).name, 'NUOVA');
  assert.equal(vessels.get(4).name, 'UGUALE');
  assert.deepEqual(vessels.get(5), { mmsi: 5, name: 'NUOVA DAL FILE', staticTs: NOW - H });
});

test('restoreBuffer: il file di serialize si rilegge a righe, uguale a decode + restore, con setImmediate fra le righe', async () => {
  const vessels = new Map(Array.from({ length: 2500 }, (_, i) => [200000000 + i, full(200000000 + i, NOW - i * 1000)]));
  const buf = await S.encode(S.serialize(vessels, { now: NOW, batch: 1000 }));
  const lines = zlib.gunzipSync(buf).toString('utf8').split('\n');
  assert.equal(lines.length, 1 + 3 + 1, 'intestazione, 3 righe di navi, chiusura');
  let ticks = 0;
  const spin = () => { ticks++; if (ticks < 1000) setImmediate(spin); };
  setImmediate(spin);
  const t0 = ticks;
  const got = await S.restoreBuffer(buf, { now: NOW });
  assert.ok(ticks - t0 >= 2, 'il ciclo degli eventi gira durante la lettura');
  assert.deepEqual(got, S.restore(await S.decode(buf), { now: NOW }));
  assert.equal(got.length, 2500);
  // vuoto, compatto su una riga sola (un altro programma) e di un altro formato
  assert.deepEqual(await S.restoreBuffer(await S.encode(S.serialize(new Map(), { now: NOW })), { now: NOW }), []);
  const compact = zlib.gzipSync(JSON.stringify(file([[1, { name: 'A', staticTs: NOW }]])));
  assert.deepEqual(await S.restoreBuffer(compact, { now: NOW }), [[1, { mmsi: 1, name: 'A', staticTs: NOW }]]);
  assert.deepEqual(await S.restoreBuffer(zlib.gzipSync(JSON.stringify({ format: 'altro', vessels: [] })), { now: NOW }), []);
  // gzip o righe rovinate = errore
  await assert.rejects(S.restoreBuffer(Buffer.from('non è gzip')));
  const broken = lines.slice(); broken[2] = broken[2].slice(0, -5);
  await assert.rejects(S.restoreBuffer(zlib.gzipSync(broken.join('\n')), { now: NOW }));
});

test('mergeBatched: come merge, a blocchi', async () => {
  const list = Array.from({ length: 2500 }, (_, i) => [i + 1, { mmsi: i + 1, name: 'N' + i, staticTs: NOW }]);
  const a = new Map([[5, { mmsi: 5, staticTs: NOW + 1 }]]), b = new Map([[5, { mmsi: 5, staticTs: NOW + 1 }]]);
  const seen = [];
  assert.equal(await S.mergeBatched(a, list, m => seen.push(m), { batch: 1000 }), S.merge(b, list));
  assert.deepEqual(a, b);
  assert.equal(seen.length, 2499);
});

test('decode: gzip corrotto o JSON non valido → errore (il server parte vuoto)', async () => {
  await assert.rejects(S.decode(Buffer.from('non è gzip')));
  await assert.rejects(S.decode(zlib.gzipSync('{"format":')));
  const ok = await S.decode(zlib.gzipSync(JSON.stringify(file([]))));
  assert.equal(ok.format, 'boatradar-vessels');
});

test('fileStore: file mancante = null; salvataggio atomico (.tmp e poi rinomina), anche in una cartella nuova', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'sotto', 'vessels.json.gz');
  const store = S.fileStore(target);
  assert.equal(store.kind, 'file');
  assert.equal(await store.load(), null);
  await store.save(Buffer.from('primo'));
  assert.equal((await store.load()).toString(), 'primo');
  // durante il salvataggio il file finale resta quello di prima finché la rinomina non lo sostituisce intero
  const origWrite = fs.promises.writeFile;
  let during = null;
  fs.promises.writeFile = async (f, data, ...rest) => {
    await origWrite(f, data, ...rest);
    during = { tmp: f, finale: fs.readFileSync(target, 'utf8') };
  };
  try { await store.save(Buffer.from('secondo')); } finally { fs.promises.writeFile = origWrite; }
  assert.equal(during.finale, 'primo');
  assert.equal(during.tmp, target + '.tmp');
  assert.equal(fs.readFileSync(target, 'utf8'), 'secondo');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['vessels.json.gz'], 'nessun .tmp rimasto');
  // un errore diverso da «file mancante» non è nascosto
  fs.mkdirSync(path.join(dir, 'cartella.gz'));
  await assert.rejects(S.fileStore(path.join(dir, 'cartella.gz')).load());
});

test('storeFromEnv: SNAPSHOT_FILE, altrimenti nessuna destinazione', () => {
  assert.equal(S.storeFromEnv({}), null);
  assert.equal(S.storeFromEnv({ SNAPSHOT_FILE: '' }), null);
  assert.equal(S.storeFromEnv({ SNAPSHOT_FILE: '/data/vessels.json.gz' }).kind, 'file');
});

test('snapshot.js è nell\'immagine Docker, nei paths dei workflow e controllato da node --check', () => {
  const ROOT = path.join(__dirname, '..');
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const copied = read('Dockerfile').split('\n').filter(l => /^\s*COPY\s/i.test(l)).flatMap(l => l.trim().split(/\s+/).slice(1, -1));
  assert.ok(copied.includes('snapshot.js'), 'Dockerfile COPY');
  const paths = f => [...read(f).matchAll(/^\s*paths:\s*\[([^\]]*)\]/gm)].map(m => m[1].split(',').map(s => s.trim()));
  for (const f of ['.github/workflows/deploy-backend.yml', '.github/workflows/browser.yml', 'render.yaml']) {
    const all = paths(f);
    assert.ok(all.length > 0, `${f}: paths`);
    for (const list of all) assert.ok(list.includes('snapshot.js'), `${f}: snapshot.js in paths`);
  }
  assert.match(read('.github/workflows/test.yml'), /node --check snapshot\.js/);
  // volume dei dati sulla VM: /data dell'utente node, conservato fra un deploy e l'altro
  assert.match(read('Dockerfile'), /RUN mkdir -p \/data && chown node:node \/data\n(?:.*\n)*USER node/);
  const compose = read('deploy/compose.yml');
  assert.match(compose, /SNAPSHOT_FILE: \/data\/vessels\.json\.gz/);
  assert.match(compose, /volumes: \[boatradar-data:\/data\]/);
  assert.match(compose, /stop_grace_period: 20s/);
  assert.match(compose, /^volumes:\n\s+boatradar-data: \{\}/m);
});
