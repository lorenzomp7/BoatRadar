// Test unitari di position-check.js (punto 1 del Piano): posizioni AIS non valide e salti impossibili.
// Orari espliciti in millisecondi, nessun server e nessuna rete. Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isValidFix, distanceNm, judge, step, pruneOlder } = require('../position-check');

const ROOT = path.join(__dirname, '..');
const NM_PER_DEG = 3440.065 * Math.PI / 180; // miglia nautiche in un grado di latitudine
const S = 1000, MIN = 60 * S;
const fix = (lat, lon, ts, sog = 12) => ({ lat, lon, sog, ts });
const M = 1 / 111195; // gradi di latitudine in un metro (raggio di distanceNm)

// Rimanda a step() una sequenza di posizioni come fa server.js e restituisce gli esiti
function run(fixes) {
  let prev, candidate;
  return fixes.map(f => {
    const r = step(prev, candidate, f);
    if (r.accept) prev = f;
    candidate = r.candidate || undefined;
    return r.accept;
  });
}

test('distanceNm: un grado di latitudine ≈ 60 NM, e attraverso l\'antimeridiano la via corta', () => {
  assert.ok(Math.abs(distanceNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 60) < 0.1);
  assert.ok(Math.abs(distanceNm({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }) - 12) < 0.1);
});

test('judge: 500 NM in 10 s è un salto', () => {
  assert.equal(judge(fix(43, 10, 0), fix(43 + 500 / 60, 10, 10 * S)), 'jump');
});

test('judge: stesso punto dopo 10 s va bene; soglia a 10 s = 0,6833 NM', () => {
  assert.equal(judge(fix(43, 10, 0), fix(43, 10, 10 * S)), 'ok');
  assert.equal(judge(fix(43, 10, 0), fix(43 + 0.68 / NM_PER_DEG, 10, 10 * S)), 'ok');
  assert.equal(judge(fix(43, 10, 0), fix(43 + 0.69 / NM_PER_DEG, 10, 10 * S)), 'jump');
});

test('judge: nave ferma che si sposta di 1 km in 1 minuto è un salto', () => {
  assert.equal(judge(fix(45, 12, 0, 0), fix(45 + 1 / 111.2, 12, MIN)), 'jump');
});

test('judge: nave ferma, 150 m in 1 minuto o 1 km in 16 minuti vanno bene', () => {
  assert.equal(judge(fix(45, 12, 0, 0), fix(45 + 0.15 / 111.2, 12, MIN)), 'ok');
  assert.equal(judge(fix(45, 12, 0, 0), fix(45 + 1 / 111.2, 12, 16 * MIN)), 'ok');
});

test('judge: velocità 102,3 (non disponibile) non conta come nave ferma', () => {
  assert.equal(judge(fix(45, 12, 0, 102.3), fix(45 + 1 / 111.2, 12, MIN)), 'ok');
});

test('judge: da 179,999 a -179,999 in 10 s va bene (antimeridiano)', () => {
  assert.equal(judge(fix(-17.5, 179.999, 0), fix(-17.5, -179.999, 10 * S)), 'ok');
});

test('judge: Sog undefined o null non attiva la regola della nave ferma', () => {
  for (const sog of [undefined, null]) {
    assert.equal(judge({ lat: 45, lon: 12, sog, ts: 0 }, { lat: 45 + 1 / 111.2, lon: 12, sog, ts: MIN }), 'ok', String(sog));
  }
});

test('judge: dopo più di 30 minuti il confronto non si può fare', () => {
  assert.equal(judge(fix(43, 10, 0), fix(43 + 500 / 60, 10, 31 * MIN)), 'unknown');
});

test('step: senza posizione precedente accetta', () => {
  assert.deepEqual(step(undefined, undefined, fix(43, 10, 0)), { accept: true, candidate: null });
});

test('step: un salto senza candidato viene rifiutato e diventa candidato', () => {
  const next = fix(43 + 500 / 60, 10, 10 * S);
  assert.deepEqual(step(fix(43, 10, 0), undefined, next), { accept: false, candidate: next });
});

test('step: un salto confermato da un candidato nello stesso punto viene accettato', () => {
  const candidate = fix(43 + 500 / 60, 10, 10 * S);
  const next = fix(43 + 500 / 60, 10, 20 * S);
  assert.deepEqual(step(fix(43, 10, 0), candidate, next), { accept: true, candidate: null });
});

test('step: un candidato lontano non conferma il salto e viene sostituito', () => {
  const candidate = fix(43 - 300 / 60, 10, 10 * S);
  const next = fix(43 + 500 / 60, 10, 20 * S);
  assert.deepEqual(step(fix(43, 10, 0), candidate, next), { accept: false, candidate: next });
});

test('step: un candidato di più di 30 minuti prima non conferma il salto', () => {
  const candidate = fix(43 + 500 / 60, 10, 0);
  const next = fix(43 + 500 / 60, 10, 31 * MIN);
  const prev = fix(43, 10, 30 * MIN);
  assert.deepEqual(step(prev, candidate, next), { accept: false, candidate: next });
});

test('step: nave in moto che trasmette sempre SOG 0 (ogni 3 min, ~555 m) viene confermata', () => {
  const prev = fix(45, 12, 0, 0);
  const candidate = fix(45 + 555 * M, 12, 3 * MIN, 0);
  const next = fix(45 + 1110 * M, 12, 6 * MIN, 0);
  assert.equal(judge(prev, next), 'jump', 'per la regola della nave ferma è un salto');
  assert.deepEqual(step(prev, candidate, next), { accept: true, candidate: null });
});

test('step: tre salti diversi di fila, poi la conferma del terzo', () => {
  const far = nm => fix(43 + nm / 60, 10, 0);
  const seq = [fix(43, 10, 0), far(500), far(-300), far(200), far(200)]
    .map((f, i) => ({ ...f, ts: i * 10 * S }));
  assert.deepEqual(run(seq), [true, false, false, false, true]);
});

test('step: nave ferma che riparte: 300 m dopo 3 min rifiutato, il fix successivo vicino accettato', () => {
  const seq = [fix(45, 12, 0, 0), fix(45 + 300 * M, 12, 3 * MIN, 3), fix(45 + 600 * M, 12, 6 * MIN, 3)];
  assert.deepEqual(run(seq), [true, false, true]);
});

test('pruneOlder: toglie le voci con ts precedente al limite', () => {
  const map = new Map([[1, { ts: 5 }], [2, { ts: 10 }], [3, { ts: 15 }]]);
  assert.equal(pruneOlder(map, 10), map);
  assert.deepEqual([...map.keys()], [2, 3]);
});

test('isValidFix: scarta Valid false, fuori scala, (0,0) e valori mancanti', () => {
  const bad = [
    { Latitude: 45, Longitude: 12, Valid: false },
    { Latitude: 91, Longitude: 181 },
    { Latitude: 0, Longitude: 0 },
    { Latitude: 90.5, Longitude: 10 },
    { Latitude: 10, Longitude: -180.5 },
    { Longitude: 10 },
    { Latitude: NaN, Longitude: 10 },
    { Latitude: null, Longitude: null },
    { Latitude: null, Longitude: 10 },
    { Latitude: '45', Longitude: '12' },
    { Latitude: '0', Longitude: '0' },
    { Latitude: Infinity, Longitude: 10 },
    { Latitude: true, Longitude: 10 },
    { Latitude: [45], Longitude: 12 },
    {},
  ];
  for (const p of bad) assert.equal(isValidFix(p), false, JSON.stringify(p));
});

test('isValidFix: accetta i confini e le posizioni senza Valid', () => {
  for (const p of [{ Latitude: 90, Longitude: 180 }, { Latitude: -90, Longitude: -180 },
    { Latitude: -33.9, Longitude: 151.2 }, { Latitude: 45, Longitude: 12, Valid: true }]) {
    assert.equal(isValidFix(p), true, JSON.stringify(p));
  }
});

test('ogni modulo locale richiesto da server.js è copiato nell\'immagine Docker', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const locals = [...src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)]
    .map(m => (path.extname(m[1]) ? m[1] : m[1] + '.js'));
  assert.ok(locals.includes('position-check.js'), 'server.js usa position-check.js');
  const copied = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').split('\n')
    .filter(l => /^\s*COPY\s/i.test(l)).flatMap(l => l.trim().split(/\s+/).slice(1, -1));
  for (const f of locals) assert.ok(copied.includes(f), `${f} manca nella riga COPY del Dockerfile`);
});
