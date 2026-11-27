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
  // ordinate per staticTs, dalla più recente (una lettura fermata al tetto di navi tiene le più recenti)
  assert.deepEqual(obj.vessels.map(([m]) => m), [247123450, 538001234, 211000001]);
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
  assert.deepEqual(obj.vessels.map(([m]) => m), [5, 3]);
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
  // pescaggio 0 = non disponibile, come all'arrivo (MaximumStaticDraught || null)
  for (const bad of [{ draught: 0 }, { draught: -0 }, { draught: 25.6 }, { draught: -1 }, { draught: Infinity }, { draught: '7' }, { length: 0 }, { length: 1024 },
    { width: 0 }, { width: 127 }, { width: NaN }, { shipType: 100 }, { shipType: -1 }, { shipType: 7.5 }, { shipType: '70' }]) {
    assert.deepEqual(one(bad), { mmsi: 1, staticTs: NOW }, JSON.stringify(bad));
  }
  // IMO: intero di 7 cifre con la cifra di controllo giusta, come all'arrivo (isIMO di public/ais-logic.js)
  assert.equal(one({ imo: 9074729 }).imo, 9074729);
  assert.equal(one({ imo: 9176187 }).imo, 9176187);
  for (const imo of [9074728, 9074720, 1000000, 9999999, 999999, 10000000, 9074729.5, '9074729', null]) assert.equal(one({ imo }).imo, undefined, String(imo));
  // ETA come etaOf di server.js: mese e giorno validi, ora e minuto validi o null; altrimenti null
  assert.deepEqual(one({ eta: { month: 12, day: 2, hour: 8, minute: 30 } }).eta, { month: 12, day: 2, hour: 8, minute: 30 });
  assert.deepEqual(one({ eta: { month: 1, day: 31, hour: 24, minute: 60 } }).eta, { month: 1, day: 31, hour: null, minute: null });
  for (const eta of [{ month: 0, day: 1 }, { month: 13, day: 1 }, { month: 1, day: 0 }, { month: 1, day: 32 }, { month: '1', day: 1 }, 'x', 5, []]) {
    assert.equal(one({ eta }).eta, null, JSON.stringify(eta));
  }
  assert.equal(one({ eta: null }).eta, null);
  assert.equal('eta' in one({}), false, 'senza ETA nel file nessuna ETA');
  // testi ripuliti come all'arrivo (cleanText): niente @ di riempimento, caratteri di controllo e spazi doppi; un nome
  // che resta vuoto non c'è, nominativo e destinazione vuoti restano '' come li scrive ShipStaticData
  assert.deepEqual(one({ name: '  LAGUNA@@  PRIMA@@@@', callSign: 'IA\u0000BC ', destination: '@@@@' }),
    { mmsi: 1, name: 'LAGUNA PRIMA', callSign: 'IA BC', destination: '', staticTs: NOW });
  assert.equal('name' in one({ name: '@@@@ \t' }), false);
  // campi sconosciuti (anche mmsi dentro i dati) ignorati: vale l'MMSI della voce
  assert.deepEqual(one({ mmsi: 2, lat: 45, __proto__x: 1 }), { mmsi: 1, staticTs: NOW });
});

test('restore: al massimo le prime `max` voci (le più recenti in un file di serialize)', () => {
  const list = Array.from({ length: 10 }, (_, i) => [i + 1, { staticTs: NOW - i * 1000 }]);
  const got = S.restore(file(list), { now: NOW, max: 3 });
  assert.deepEqual(got.map(([m]) => m).sort((a, b) => a - b), [1, 2, 3]);
  // contano anche le voci non valide: la lettura si ferma comunque
  assert.deepEqual(S.restore(file([null, 'x', [1, { staticTs: NOW }]]), { now: NOW, max: 2 }), []);
});

test('restore: "__proto__" in un JSON vero (JSON.parse) resta una chiave ignorata, niente prototipi inquinati', () => {
  const entry = JSON.parse(`{"format":"boatradar-vessels","version":1,"vessels":[[1,{"__proto__":{"name":"DAL PROTO","imo":9074729},"staticTs":${NOW}}],` +
    `[2,{"name":"B","staticTs":${NOW},"constructor":{"prototype":{"x":1}}}]]}`);
  assert.ok(Object.hasOwn(entry.vessels[0][1], '__proto__'), 'JSON.parse crea una chiave «__proto__» propria');
  const got = new Map(S.restore(entry, { now: NOW }));
  assert.deepEqual(got.get(1), { mmsi: 1, staticTs: NOW });
  assert.equal(Object.getPrototypeOf(got.get(1)), Object.prototype);
  assert.equal(got.get(1).name, undefined);
  assert.deepEqual(got.get(2), { mmsi: 2, name: 'B', staticTs: NOW });
  assert.equal({}.name, undefined); assert.equal({}.imo, undefined); assert.equal({}.x, undefined);
  // anche in cima al file: formato e versione dentro "__proto__" non valgono
  const top = JSON.parse(`{"__proto__":{"format":"boatradar-vessels","version":1,"vessels":[[1,{"name":"X","staticTs":${NOW}}]]}}`);
  assert.deepEqual(S.restore(top, { now: NOW }), []);
  // e passando da merge le navi restano oggetti semplici
  const vessels = new Map();
  S.merge(vessels, [...got]);
  assert.equal(Object.getPrototypeOf(vessels.get(1)), Object.prototype);
  assert.equal(vessels.get(1).name, undefined);
});

test('merge: la nave del file entra solo se il server non ha dati statici più recenti', () => {
  const vessels = new Map([[1, { mmsi: 1, name: 'NUOVA', staticTs: NOW }], [2, { mmsi: 2, name: 'SOLO POSIZIONE' }],
    [3, { mmsi: 3, name: 'VECCHIA', staticTs: NOW - 2 * H }], [4, { mmsi: 4, name: 'UGUALE', staticTs: NOW - H }]]);
  const touched = [];
  const n = S.merge(vessels, [[1, { mmsi: 1, name: 'DAL FILE', staticTs: NOW - H }], [2, { mmsi: 2, name: 'DAL FILE', staticTs: NOW - H }],
    [3, { mmsi: 3, name: 'DAL FILE', destination: 'GENOVA', staticTs: NOW - H }], [4, { mmsi: 4, name: 'DAL FILE', staticTs: NOW - H }],
    [5, { mmsi: 5, name: 'NUOVA DAL FILE', staticTs: NOW - H }]], (mmsi, v) => touched.push([mmsi, v.name]));
  assert.equal(n, 3);
  assert.equal(vessels.get(1).name, 'NUOVA');
  assert.equal(vessels.get(4).name, 'UGUALE');
  assert.deepEqual(vessels.get(5), { mmsi: 5, name: 'NUOVA DAL FILE', staticTs: NOW - H });
  // in memoria da prima del file solo per orologi sfasati: i campi già arrivati restano, gli altri dal file
  assert.deepEqual(vessels.get(3), { mmsi: 3, name: 'VECCHIA', destination: 'GENOVA', staticTs: NOW - H });
  assert.deepEqual(touched, [[2, 'SOLO POSIZIONE'], [3, 'VECCHIA'], [5, 'NUOVA DAL FILE']]);
});

test('merge dopo i primi messaggi: una nave con solo MetaData.ShipName tiene il nome appena arrivato', () => {
  // ripristino finito dopo il tetto di 5 s: nel frattempo aisstream ha mandato una posizione con MetaData.ShipName
  // (nome, nessun staticTs) e un ShipStaticData con IMO non valido (imo: null, staticTs più vecchio del file solo qui)
  const vessels = new Map([[1, { mmsi: 1, name: 'NOME NUOVO', shipType: 37 }]]);
  const fromFile = [[1, { mmsi: 1, name: 'NOME VECCHIO', imo: 9074729, callSign: 'IABC', shipType: 70, destination: 'VENEZIA',
    draught: 7.5, length: 120, width: 18, eta: { month: 12, day: 2, hour: 8, minute: null }, staticTs: NOW - H }]];
  assert.equal(S.merge(vessels, fromFile), 1);
  assert.deepEqual(vessels.get(1), { mmsi: 1, name: 'NOME NUOVO', shipType: 37, imo: 9074729, callSign: 'IABC', destination: 'VENEZIA',
    draught: 7.5, length: 120, width: 18, eta: { month: 12, day: 2, hour: 8, minute: null }, staticTs: NOW - H });
  // un null arrivato da un messaggio (IMO non valido, pescaggio non disponibile) non torna il valore vecchio del file
  const withNull = new Map([[2, { mmsi: 2, name: 'X', imo: null, draught: null, staticTs: NOW - 2 * H }]]);
  S.merge(withNull, [[2, { mmsi: 2, imo: 9074729, draught: 7.5, destination: 'GENOVA', staticTs: NOW - H }]]);
  assert.deepEqual(withNull.get(2), { mmsi: 2, name: 'X', imo: null, draught: null, destination: 'GENOVA', staticTs: NOW - H });
});

// Turni del ciclo degli eventi (fasi check, setImmediate) mentre la promessa p è in corso
async function turnsDuring(p) {
  let turns = 0, done = false;
  const spin = () => { if (!done) { turns++; setImmediate(spin); } };
  setImmediate(spin);
  await p;
  done = true;
  return turns;
}

test('restoreBuffer: il file di serialize si rilegge a righe, uguale a decode + restore', async () => {
  const vessels = new Map(Array.from({ length: 2500 }, (_, i) => [200000000 + i, full(200000000 + i, NOW - i * 1000)]));
  const buf = await S.encode(S.serialize(vessels, { now: NOW, batch: 1000 }));
  const lines = zlib.gunzipSync(buf).toString('utf8').split('\n');
  assert.equal(lines.length, 1 + 3 + 1, 'intestazione, 3 righe di navi, chiusura');
  const got = await S.restoreBuffer(buf, { now: NOW });
  assert.deepEqual(got, S.restore(await S.decode(buf), { now: NOW }));
  assert.equal(got.length, 2500);
  // vuoto e compatto su una riga sola (un altro programma)
  assert.deepEqual(await S.restoreBuffer(await S.encode(S.serialize(new Map(), { now: NOW })), { now: NOW }), []);
  const compact = zlib.gzipSync(JSON.stringify(file([[1, { name: 'A', staticTs: NOW }]])));
  assert.deepEqual(await S.restoreBuffer(compact, { now: NOW }), [[1, { mmsi: 1, name: 'A', staticTs: NOW }]]);
});

test('restoreInflated: setImmediate fra una riga e l\'altra (turni contati dopo la decompressione)', async () => {
  const vessels = new Map(Array.from({ length: 50 }, (_, i) => [200000000 + i, full(200000000 + i, NOW - i * 1000)]));
  const raw = zlib.gunzipSync(await S.encode(S.serialize(vessels, { now: NOW, batch: 10 })));
  assert.equal(raw.toString('utf8').split('\n').length, 1 + 5 + 1);
  // la decompressione è già fatta: senza i setImmediate fra le righe la lettura finirebbe in 0 turni
  const turns = await turnsDuring(S.restoreInflated(raw, { now: NOW, batch: 10 }));
  // 4 setImmediate fra 5 righe; il conteggio parte dopo il primo (già in coda), quindi almeno 3 turni
  assert.ok(turns >= 3, `${turns} turni del ciclo degli eventi per 5 righe di navi`);
  // e restoreBuffer passa da lì: stesso risultato
  assert.deepEqual(await S.restoreInflated(raw, { now: NOW, batch: 10 }), await S.restoreBuffer(zlib.gzipSync(raw), { now: NOW, batch: 10 }));
});

test('restoreBuffer: gzip, righe o JSON rovinati e formato sconosciuto = SnapshotFormatError', async () => {
  const vessels = new Map([[1, full(1, NOW)], [2, full(2, NOW - 1)], [3, full(3, NOW - 2)]]);
  const lines = zlib.gunzipSync(await S.encode(S.serialize(vessels, { now: NOW, batch: 1 }))).toString('utf8').split('\n');
  const gz = l => zlib.gzipSync(l.join('\n'));
  const fails = async (buf, re, opts = {}) => {
    await assert.rejects(S.restoreBuffer(buf, { now: NOW, batch: 1, ...opts }), err => S.isFormatError(err) && re.test(err.message), String(re));
  };
  assert.equal((await S.restoreBuffer(gz(lines), { now: NOW, batch: 1 })).length, 3);
  await fails(Buffer.from('non è gzip'), /gzip non valido/);
  await fails(zlib.gzipSync(Buffer.from('x')).subarray(0, 10), /gzip non valido/);
  const broken = lines.slice(); broken[2] = broken[2].slice(0, -5);
  await fails(gz(broken), /JSON non valido/);
  await fails(gz(lines.slice(0, -1)), /chiusura mancante/);
  await fails(gz([...lines.slice(0, -1), ']} ']), /chiusura mancante/);
  await fails(zlib.gzipSync(JSON.stringify({ format: 'altro', vessels: [] })), /formato o versione sconosciuti/);
  await fails(zlib.gzipSync(JSON.stringify({ ...file([]), version: 2 })), /formato o versione sconosciuti/);
  await fails(zlib.gzipSync('{"format":'), /JSON non valido/);
  // restore (oggetto già letto) resta senza eccezioni
  assert.deepEqual(S.restore({ format: 'altro' }), []);
});

test('tetti del ripristino: file 16 MB, decompresso 64 MB (50.000 navi ≈ 12 MB), JSON non a righe 4 MB, 1000 navi per riga', () => {
  assert.equal(S.MAX_FILE, 16 * 1024 * 1024);
  assert.equal(S.MAX_INFLATED, 64 * 1024 * 1024);
  assert.equal(S.MAX_COMPACT, 4 * 1024 * 1024);
  assert.equal(S.BATCH, 1000);
  assert.equal(S.LINE_BYTES, 2048);
  assert.equal(S.MAX_VESSELS, 250000);
  // 250.000 navi da circa 243 byte (misura di tools/carico.js) stanno nel tetto del decompresso
  assert.ok(S.MAX_VESSELS * 243 < S.MAX_INFLATED);
});

test('tetto del decompresso: zlib si ferma lì (gzip piccolo con milioni di a capo)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(200000, 0x0a));
  assert.ok(bomb.length < 1000);
  await assert.rejects(S.restoreBuffer(bomb, { maxInflated: 100000 }), err => S.isFormatError(err) && /decompresso oltre/.test(err.message));
  await assert.rejects(S.inflate(bomb, 100000), err => S.isFormatError(err));
  assert.equal((await S.inflate(bomb, 200000)).length, 200000);
});

test('tetto delle righe: al massimo ceil(max / batch) + 2, nessuna riga vuota, righe lunghe al massimo batch × lineBytes', async () => {
  const at = n => [200000000 + n, { name: 'N' + n, staticTs: NOW - n }];
  const head = `{"format":"boatradar-vessels","version":1,"savedAt":${NOW},"vessels":[`;
  const raw = blocks => Buffer.from([head, ...blocks.map((b, i) => (i ? ',' : '') + b.map(e => JSON.stringify(e)).join(',')), ']}'].join('\n'));
  const opts = { now: NOW, max: 4, batch: 2 };   // 4 righe: intestazione, 2 blocchi, chiusura
  assert.equal((await S.restoreInflated(raw([[at(1), at(2)], [at(3), at(4)]]), opts)).length, 4);
  await assert.rejects(S.restoreInflated(raw([[at(1)], [at(2)], [at(3)]]), opts), err => S.isFormatError(err) && /oltre 4 righe/.test(err.message));
  // riga vuota fra i blocchi
  const empty = Buffer.from([head, JSON.stringify(at(1)), '', ']}'].join('\n'));
  await assert.rejects(S.restoreInflated(empty, { now: NOW }), err => S.isFormatError(err) && /riga vuota/.test(err.message));
  // riga più lunga di batch × lineBytes
  await assert.rejects(S.restoreInflated(raw([[at(1), at(2)]]), { now: NOW, batch: 2, lineBytes: 10 }),
    err => S.isFormatError(err) && /riga oltre/.test(err.message));
  assert.equal((await S.restoreInflated(raw([[at(1), at(2)]]), { now: NOW, batch: 2, lineBytes: 100 })).length, 2);
});

test('tetto delle navi: la lettura si ferma appena le voci superano max (il resto del file non si legge)', async () => {
  const at = n => JSON.stringify([200000000 + n, { name: 'N' + n, staticTs: NOW - n }]);
  const head = `{"format":"boatradar-vessels","version":1,"savedAt":${NOW},"vessels":[`;
  // dopo la terza voce una riga rovinata: con max 3 non si arriva a leggerla
  const raw = Buffer.from([head, [at(1), at(2)].join(','), ',' + [at(3), at(4)].join(','), ',{rovinata', ']}'].join('\n'));
  const got = await S.restoreInflated(raw, { now: NOW, max: 3, batch: 2 });
  assert.deepEqual(got.map(([m]) => m), [200000001, 200000002, 200000003]);
  await assert.rejects(S.restoreInflated(raw, { now: NOW, max: 10, batch: 2 }), err => S.isFormatError(err));
});

test('tetto del JSON non a righe: un solo JSON.parse solo fino a maxCompact byte', async () => {
  const compact = Buffer.from(JSON.stringify(file([[1, { name: 'A', staticTs: NOW }]])));
  assert.equal((await S.restoreInflated(compact, { now: NOW, maxCompact: compact.length })).length, 1);
  await assert.rejects(S.restoreInflated(compact, { now: NOW, maxCompact: compact.length - 1 }),
    err => S.isFormatError(err) && /non a righe oltre/.test(err.message));
  // anche un'intestazione a righe troppo lunga (oltre 1 KB) vale come JSON non a righe
  const longHead = Buffer.from(`{"format":"boatradar-vessels","version":1,"x":"${'a'.repeat(2000)}","vessels":[\n]}`);
  await assert.rejects(S.restoreInflated(longHead, { now: NOW, maxCompact: 1000 }), err => S.isFormatError(err));
  assert.deepEqual(await S.restoreInflated(longHead, { now: NOW }), []);
});

test('mergeBatched: come merge, a blocchi', async () => {
  const list = Array.from({ length: 2500 }, (_, i) => [i + 1, { mmsi: i + 1, name: 'N' + i, staticTs: NOW }]);
  const a = new Map([[5, { mmsi: 5, staticTs: NOW + 1 }]]), b = new Map([[5, { mmsi: 5, staticTs: NOW + 1 }]]);
  const seen = [];
  assert.equal(await S.mergeBatched(a, list, m => seen.push(m), { batch: 1000 }), S.merge(b, list));
  assert.deepEqual(a, b);
  assert.equal(seen.length, 2499);
});

test('mergeBatched: il ciclo degli eventi gira fra un blocco e l\'altro', async () => {
  const list = Array.from({ length: 50 }, (_, i) => [i + 1, { mmsi: i + 1, name: 'N' + i, staticTs: NOW }]);
  const turns = await turnsDuring(S.mergeBatched(new Map(), list, () => {}, { batch: 10 }));
  assert.ok(turns >= 3, `${turns} turni per 5 blocchi`);   // come sopra: 4 setImmediate, il primo già in coda
  assert.equal(await turnsDuring(S.mergeBatched(new Map(), list.slice(0, 10), () => {}, { batch: 10 })), 0, 'un blocco solo: nessuna attesa');
});

test('decode: gzip corrotto o JSON non valido → errore (il server parte vuoto)', async () => {
  await assert.rejects(S.decode(Buffer.from('non è gzip')), S.SnapshotFormatError);
  await assert.rejects(S.decode(zlib.gzipSync('{"format":')), S.SnapshotFormatError);
  const ok = await S.decode(zlib.gzipSync(JSON.stringify(file([]))));
  assert.equal(ok.format, 'boatradar-vessels');
});

test('fileStore: file mancante = null; salvataggio open → write → sync del .tmp, poi rinomina, anche in una cartella nuova', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'sotto', 'vessels.json.gz');
  const store = S.fileStore(target);
  assert.equal(store.kind, 'file');
  assert.equal(await store.load(), null);
  await store.save(Buffer.from('primo'));
  assert.equal((await store.load()).toString(), 'primo');
  // ordine delle operazioni e file finale intatto fino alla rinomina
  const calls = [];
  const origOpen = fs.promises.open, origRename = fs.promises.rename;
  fs.promises.open = async (f, ...rest) => {
    const fh = await origOpen(f, ...rest);
    calls.push(['open', path.basename(f)]);
    return {
      writeFile: async (...a) => { calls.push(['write']); return fh.writeFile(...a); },
      write: async (...a) => { calls.push(['write']); return fh.write(...a); },
      sync: async () => { calls.push(['sync']); return fh.sync(); },
      close: async () => { calls.push(['close']); return fh.close(); },
    };
  };
  fs.promises.rename = async (a, b) => { calls.push(['rename', path.basename(a), path.basename(b), fs.readFileSync(target, 'utf8')]); return origRename(a, b); };
  try { await store.save(Buffer.from('secondo')); } finally { fs.promises.open = origOpen; fs.promises.rename = origRename; }
  assert.deepEqual(calls, [['open', 'vessels.json.gz.tmp'], ['write'], ['sync'], ['close'],
    ['rename', 'vessels.json.gz.tmp', 'vessels.json.gz', 'primo']]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'secondo');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['vessels.json.gz'], 'nessun .tmp rimasto');
  // un errore diverso da «file mancante» non è nascosto, e non è un errore di formato
  fs.mkdirSync(path.join(dir, 'cartella.gz'));
  await assert.rejects(S.fileStore(path.join(dir, 'cartella.gz')).load(), err => err.code === 'EISDIR' && !S.isFormatError(err));
});

test('fileStore: oltre maxFile (16 MB) errore di formato con stat, senza leggere il file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = path.join(dir, 'grande.gz');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, S.MAX_FILE + 1);   // file sparso: niente spazio vero su disco
  const origRead = fs.promises.readFile;
  let reads = 0;
  fs.promises.readFile = async (...a) => { reads++; return origRead(...a); };
  try {
    await assert.rejects(S.fileStore(big).load(), err => S.isFormatError(err) && err.message === 'file oltre 16 MB');
  } finally { fs.promises.readFile = origRead; }
  assert.equal(reads, 0, 'nessuna lettura');
  const small = path.join(dir, 'piccolo.gz');
  fs.writeFileSync(small, '0123456789');
  assert.equal((await S.fileStore(small, { maxFile: 10 }).load()).length, 10);
  await assert.rejects(S.fileStore(small, { maxFile: 9 }).load(), S.SnapshotFormatError);
});

test('fileStore.quarantine: il file non valido diventa .bad (sostituisce un .bad di prima)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-snapshot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'vessels.json.gz');
  fs.writeFileSync(target + '.bad', 'vecchio');
  fs.writeFileSync(target, 'rovinato');
  await S.fileStore(target).quarantine();
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(target + '.bad', 'utf8'), 'rovinato');
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
