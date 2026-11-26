// Test unitari di sample.js (punto 4: campione per importanza in /api/locations). Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importance, staticImportance, dynamicImportance, sampleByImportance, SAMPLE_GRID } = require('../sample');

const ROOT = path.join(__dirname, '..');
const NOW = 1_800_000_000_000;
const MIN = 60 * 1000;

// petroliera: classe A, 12 kn, 250 m, tipo 80; barca: classe B, ferma, 8 m, tipo 37 (diporto)
const tanker = { p: { lat: 44, lon: 9, sog: 12, classA: true, ts: NOW }, v: { length: 250, shipType: 80 } };
const boat = { p: { lat: 44.01, lon: 9.01, sog: 0, classA: false, ts: NOW }, v: { length: 8, shipType: 37 } };

test('importance: petroliera in moto batte barca ferma; ogni criterio pesa come da piano', () => {
  assert.ok(importance(tanker.p, tanker.v, NOW) > importance(boat.p, boat.v, NOW));
  assert.equal(importance({ ts: NOW }, {}, NOW), 0, 'nessun dato: 0');
  assert.equal(importance({ ts: NOW, classA: true }, undefined, NOW), 2, 'classe A +2, senza dati statici');
  assert.equal(importance({ ts: NOW, sog: 5 }, {}, NOW), 2, 'in moto +2');
  assert.equal(importance({ ts: NOW, sog: 0.5 }, {}, NOW), 0, '0,5 kn non è in moto');
  assert.equal(importance({ ts: NOW, sog: 102.3 }, {}, NOW), 0, '102,3 = velocità non disponibile');
  assert.equal(importance({ ts: NOW, sog: NaN }, {}, NOW), 0);
  assert.equal(importance({ ts: NOW }, { length: 20 }, NOW), 1, 'log2(20/10) = 1');
  assert.equal(importance({ ts: NOW }, { length: 10000 }, NOW), 5, 'lunghezza: al massimo +5');
  assert.equal(importance({ ts: NOW }, { length: 5 }, NOW), 0, 'sotto 10 m nessun punto, mai negativo');
  for (const length of [0, undefined, null, 'x', -3]) assert.equal(importance({ ts: NOW }, { length }, NOW), 0, `length ${length}`);
  for (const t of [60, 70, 80, 89]) assert.equal(importance({ ts: NOW }, { shipType: t }, NOW), 1, `tipo ${t}`);
  for (const t of [59, 90, 37, undefined]) assert.equal(importance({ ts: NOW }, { shipType: t }, NOW), 0, `tipo ${t}`);
});

test('importance: penalità per l\'età della posizione, -1 ogni 10 min fino a 30 min, poi -1 per ora (o frazione) fino a -8', () => {
  const H = 60 * MIN;
  const at = ago => importance({ ts: NOW - ago, classA: true, sog: 5 }, {}, NOW);
  assert.equal(at(0), 4);
  assert.equal(at(9 * MIN), 4);
  assert.equal(at(10 * MIN), 3);
  assert.equal(at(25 * MIN), 2);
  assert.equal(at(30 * MIN), 1, '30 min esatti: -3, come prima');
  assert.equal(at(30 * MIN + 1), 0, 'oltre il limite delle navi in moto: subito -4');
  assert.equal(at(90 * MIN), 0, '1 h oltre i 30 min: -4');
  assert.equal(at(90 * MIN + 1), -1, '-5');
  assert.equal(at(3 * H), -2, '3 h: -6');
  assert.equal(at(4 * H + 30 * MIN), -3, '-7');
  assert.equal(at(4 * H + 30 * MIN + 1), -4, '-8');
  assert.equal(at(6 * H), -4, 'al massimo -8');
  assert.equal(at(48 * H), -4);
  assert.equal(at(-5 * MIN), 4, 'posizione «nel futuro»: nessuna penalità');
  assert.equal(importance({ classA: true }, {}, NOW), -6, 'ts mancante: penalità massima, mai NaN');
});

test('limit 1: petroliera ferma di classe A (200 m) vista 3 h fa contro barca di classe B fresca in moto: resta la barca', () => {
  const H = 60 * MIN;
  const oldTanker = { lat: 44, lon: 9, sog: 0, navStat: 5, classA: true, ts: NOW - 3 * H };
  const freshBoat = { lat: 44.01, lon: 9.01, sog: 6, classA: false, ts: NOW };
  const vessels = new Map([[1, { length: 200, shipType: 80 }], [2, { length: 8, shipType: 37 }]]);
  // MMSI più basso alla petroliera: a parità vincerebbe lei
  const got = sampleByImportance([hit(1, oldTanker), hit(2, freshBoat)], 1, null, { vesselOf: vesselsOf(vessels), now: NOW });
  assert.deepEqual(got.map(([m]) => m), [2]);
  // la stessa petroliera vista 25 min fa batte ancora la barca
  const recent = sampleByImportance([hit(1, { ...oldTanker, ts: NOW - 25 * MIN }), hit(2, freshBoat)], 1, null, { vesselOf: vesselsOf(vessels), now: NOW });
  assert.deepEqual(recent.map(([m]) => m), [1]);
});

const hit = (mmsi, p) => [mmsi, p];
const vesselsOf = map => mmsi => map.get(mmsi);

test('limit 1 fra petroliera e barca: resta la petroliera, anche se ha MMSI più alto', () => {
  const hits = [hit(1, boat.p), hit(2, tanker.p)];
  const vessels = new Map([[1, boat.v], [2, tanker.v]]);
  const got = sampleByImportance(hits, 1, null, { vesselOf: vesselsOf(vessels), now: NOW });
  assert.deepEqual(got.map(([m]) => m), [2]);
});

test('stesso risultato con l\'input mescolato; a parità di punteggio vince l\'MMSI più basso', () => {
  const hits = Array.from({ length: 40 }, (_, i) => hit(1000 + i, { lat: 10 + i / 10, lon: 20, sog: i % 3 ? 5 : 0, classA: i % 2 === 0, ts: NOW }));
  const a = sampleByImportance(hits, 7, null, { now: NOW });
  const shuffled = [...hits].sort((x, y) => (x[0] * 7919) % 101 - (y[0] * 7919) % 101);
  const b = sampleByImportance(shuffled, 7, null, { now: NOW });
  assert.deepEqual(b, a);
  assert.equal(a.length, 7);
  const tie = sampleByImportance([hit(9, { lat: 0, lon: 0, ts: NOW }), hit(3, { lat: 1, lon: 1, ts: NOW })], 1, null, { now: NOW });
  assert.deepEqual(tie.map(([m]) => m), [3]);
});

test('una posizione di 25 min fa perde contro una uguale ma recente', () => {
  const p = { lat: 0, lon: 0, sog: 5, classA: true };
  const got = sampleByImportance([hit(1, { ...p, ts: NOW - 25 * MIN }), hit(2, { ...p, ts: NOW })], 1, null, { now: NOW });
  assert.deepEqual(got.map(([m]) => m), [2]);
});

test('griglia: una nave poco importante in Atlantico resta accanto a quelle di Rotterdam', () => {
  const hits = Array.from({ length: 10 }, (_, i) => hit(100 + i, { lat: 51.9 + i / 100, lon: 4 + i / 100, sog: 12, classA: true, ts: NOW }));
  hits.push(hit(999, { lat: 30, lon: -40, sog: 0, classA: false, ts: NOW }));
  const vessels = new Map(hits.slice(0, 10).map(([m]) => [m, { length: 300, shipType: 70 }]));
  const got = sampleByImportance(hits, 3, null, { vesselOf: vesselsOf(vessels), now: NOW });
  assert.deepEqual(got.map(([m]) => m), [100, 101, 999], 'due di Rotterdam e l\'atlantica, in ordine di punteggio');
  const world = sampleByImportance(hits, 3, [-180, -90, 180, 90], { vesselOf: vesselsOf(vessels), now: NOW });
  assert.deepEqual(world, got, 'bbox null = mondo');
});

test('griglia: cap per cella = ceil(limit / celle); il resto riempie fino a limit', () => {
  // 3 celle diverse con griglia 2×2 sul bbox [0,0,10,10]; 6 navi in una cella e 1 in ciascuna delle altre
  const hits = [];
  for (let i = 0; i < 6; i++) hits.push(hit(10 + i, { lat: 1, lon: 1 + i / 10, sog: 5, classA: true, ts: NOW }));
  hits.push(hit(50, { lat: 8, lon: 1, ts: NOW }), hit(51, { lat: 8, lon: 8, ts: NOW }));
  const got = sampleByImportance(hits, 6, [0, 0, 10, 10], { now: NOW, grid: 2 });
  // cap = ceil(6/4) = 2: primo passaggio 10, 11, 50, 51; secondo passaggio 12, 13
  assert.deepEqual(got.map(([m]) => m), [10, 11, 12, 13, 50, 51]);
});

test('antimeridiano: 179,9° e -179,9° in celle diverse, nessun NaN', () => {
  const box = [170, -10, -170, 10];
  // stessa importanza: con limit 2 e una terza nave nella cella di 179,9° la nave a -179,9° deve restare
  const hits = [hit(1, { lat: 0, lon: 179.9, ts: NOW }), hit(2, { lat: 0, lon: 179.91, ts: NOW }), hit(3, { lat: 0, lon: -179.9, ts: NOW })];
  const got = sampleByImportance(hits, 2, box, { now: NOW });
  assert.deepEqual(got.map(([m]) => m), [1, 3]);
});

test('casi limite: poli, lon 180, bbox degenere; limit 1; hits ≤ limit restituisce lo stesso array', () => {
  const edge = [hit(1, { lat: 90, lon: 180, ts: NOW }), hit(2, { lat: -90, lon: -180, ts: NOW }), hit(3, { lat: 0, lon: 0, ts: NOW })];
  assert.equal(sampleByImportance(edge, 2, null, { now: NOW }).length, 2);
  assert.equal(sampleByImportance(edge, 1, null, { now: NOW }).length, 1);
  assert.equal(sampleByImportance(edge, 2, [5, 5, 5, 5], { now: NOW }).length, 2, 'bbox degenere: una cella');
  assert.equal(sampleByImportance(edge, 2, [10, 10, 20, 20], { now: NOW }).length, 2, 'navi fuori dal bbox: celle ai bordi');
  assert.equal(sampleByImportance(edge, 3, null, { now: NOW }), edge, 'hits = limit: stesso array');
  assert.equal(sampleByImportance(edge, 6000, null, { now: NOW }), edge);
  const empty = [];
  assert.equal(sampleByImportance(empty, 1, null), empty);
  assert.equal(SAMPLE_GRID, 64);
});

test('il campione non modifica hits', () => {
  const hits = Array.from({ length: 20 }, (_, i) => hit(i + 1, { lat: i, lon: i, ts: NOW }));
  const copy = hits.map(h => [...h]);
  const got = sampleByImportance(hits, 5, null, { now: NOW });
  assert.notEqual(got, hits);
  assert.deepEqual(hits, copy);
});

test('staticOf: la parte statica già calcolata dà lo stesso campione di vesselOf', () => {
  assert.equal(staticImportance(tanker.v) + dynamicImportance(tanker.p, NOW), importance(tanker.p, tanker.v, NOW));
  assert.equal(staticImportance(undefined), 0);
  const hits = Array.from({ length: 30 }, (_, i) => hit(500 + i, { lat: i, lon: -i, sog: i % 4 ? 3 : 0, classA: i % 3 === 0, ts: NOW - i * MIN }));
  const vessels = new Map(hits.map(([m], i) => [m, { length: 5 + i * 11, shipType: 55 + i }]));
  const withVessels = sampleByImportance(hits, 8, null, { vesselOf: vesselsOf(vessels), now: NOW });
  const pre = new Map(hits.map(([m]) => [m, staticImportance(vessels.get(m))]));
  assert.deepEqual(sampleByImportance(hits, 8, null, { staticOf: m => pre.get(m), now: NOW }), withVessels);
  // staticOf prevale: la nave 529 (la meno importante) diventa la prima
  const boosted = sampleByImportance(hits, 8, null, { vesselOf: vesselsOf(vessels), staticOf: m => (m === 529 ? 100 : pre.get(m)), now: NOW });
  assert.equal(boosted[0][0], 529);
});

test('staticImportance arrotonda la lunghezza al metro: 100 e 100,05 m sono pari (vince l\'MMSI più basso), 101 m batte 100', () => {
  assert.equal(staticImportance({ length: 100.05 }), staticImportance({ length: 100 }));
  assert.equal(staticImportance({ length: 100.4 }), staticImportance({ length: 100 }));
  assert.equal(staticImportance({ length: 100.6 }), staticImportance({ length: 101 }));
  assert.equal(staticImportance({ length: 0.4 }), 0, 'sotto mezzo metro: nessuna lunghezza');
  const p = { lat: 0, lon: 0, ts: NOW };
  // la nave di 100,05 m ha l'MMSI più alto: senza arrotondamento vincerebbe lei
  const tie = new Map([[1, { length: 100 }], [2, { length: 100.05 }]]);
  assert.deepEqual(sampleByImportance([hit(2, p), hit(1, p)], 1, null, { vesselOf: vesselsOf(tie), now: NOW }).map(([m]) => m), [1]);
  const longer = new Map([[1, { length: 100 }], [2, { length: 101 }]]);
  assert.deepEqual(sampleByImportance([hit(1, p), hit(2, p)], 1, null, { vesselOf: vesselsOf(longer), now: NOW }).map(([m]) => m), [2]);
});

test('pari matematici con errori di arrotondamento float contano come pari: 172 m contro 86 m + tipo 89', () => {
  const a = staticImportance({ length: 172 }), b = staticImportance({ length: 86, shipType: 89 });
  assert.ok(Math.abs(a - b) < 1e-9, 'log2(17,2) = log2(8,6) + 1');
  const p = { lat: 0, lon: 0, ts: NOW };
  for (const [low, high] of [[{ length: 172 }, { length: 86, shipType: 89 }], [{ length: 86, shipType: 89 }, { length: 172 }]]) {
    const vessels = new Map([[1, low], [2, high]]);
    assert.deepEqual(sampleByImportance([hit(2, p), hit(1, p)], 1, null, { vesselOf: vesselsOf(vessels), now: NOW }).map(([m]) => m), [1]);
  }
  // tutte le coppie L m + tipo 80 contro 2L m senza tipo (stesso punteggio): vince sempre l'MMSI più basso
  for (let L = 10; L <= 160; L++) {
    for (const [v1, v2] of [[{ length: L, shipType: 80 }, { length: 2 * L }], [{ length: 2 * L }, { length: L, shipType: 80 }]]) {
      const got = sampleByImportance([hit(2, p), hit(1, p)], 1, null, { vesselOf: vesselsOf(new Map([[1, v1], [2, v2]])), now: NOW });
      assert.equal(got[0][0], 1, `L = ${L}`);
    }
  }
});

test('punteggi negativi: navi ferme di classe B senza dati statici, età 0, 15 e 35 min', () => {
  // punteggi 0, -1 e -4 (35 min: oltre il limite delle navi in moto); MMSI in ordine inverso rispetto all'importanza
  const at = ago => ({ lat: 0, lon: 0, sog: 0, classA: false, ts: NOW - ago * MIN });
  assert.deepEqual([0, 15, 35].map(a => importance(at(a), undefined, NOW)), [0, -1, -4]);
  const hits = [hit(30, at(0)), hit(20, at(15)), hit(10, at(35))];
  assert.deepEqual(sampleByImportance(hits, 2, null, { now: NOW, grid: 1 }).map(([m]) => m), [30, 20]);
  // limit 1 fra 15 e 35 min, con l'MMSI più basso alla nave di 35 min: vince quella di 15
  assert.deepEqual(sampleByImportance([hit(20, at(15)), hit(10, at(35))], 1, null, { now: NOW, grid: 1 }).map(([m]) => m), [20]);
});

test('MMSI grandi (oltre 30 bit) e piccoli: stesse regole, stesso ordine', () => {
  const mk = base => Array.from({ length: 12 }, (_, i) => hit(base + (11 - i), { lat: i, lon: i, sog: i % 2 ? 5 : 0, classA: i % 3 === 0, ts: NOW }));
  const small = sampleByImportance(mk(1000), 5, null, { now: NOW }).map(([m]) => m - 1000);
  const big = sampleByImportance(mk(2 ** 31), 5, null, { now: NOW }).map(([m]) => m - 2 ** 31);
  assert.deepEqual(big, small);
});

test('sample.js è nell\'immagine Docker, nei paths dei workflow e controllato da node --check', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const copied = read('Dockerfile').split('\n').filter(l => /^\s*COPY\s/i.test(l)).flatMap(l => l.trim().split(/\s+/).slice(1, -1));
  assert.ok(copied.includes('sample.js'), 'Dockerfile COPY');
  const paths = f => [...read(f).matchAll(/^\s*paths:\s*\[([^\]]*)\]/gm)].map(m => m[1].split(',').map(s => s.trim()));
  for (const f of ['.github/workflows/deploy-backend.yml', '.github/workflows/browser.yml']) {
    const all = paths(f);
    assert.ok(all.length > 0, `${f}: paths`);
    for (const list of all) assert.ok(list.includes('sample.js'), `${f}: sample.js in paths`);
  }
  assert.match(read('.github/workflows/test.yml'), /node --check sample\.js/);
});

test('contratto dei pari: per lunghezze intere 10-320 m il confronto a 1e-9 coincide con quello esatto in interi', () => {
  // punteggio = log2(L / 10) + k con k intero fra -8 e +5: uguale in matematica se e solo se L · 2^(k+8) è uguale.
  // Stesso calcolo di sampleByImportance: parte dinamica intera + staticImportance, poi Math.round(· 1e9).
  const byExact = new Map(), byRounded = new Map();
  for (let L = 10; L <= 320; L++) for (const type of [undefined, 80]) for (let dyn = -8; dyn <= 4; dyn++) {
    const k = dyn + (type ? 1 : 0), exact = L * 2 ** (k + 8);
    const rounded = Math.round((dyn + staticImportance({ length: L, shipType: type })) * 1e9);
    if (byExact.has(exact)) assert.equal(byExact.get(exact), rounded, `L ${L}, k ${k}: pari separati`);
    else byExact.set(exact, rounded);
    if (byRounded.has(rounded)) assert.equal(byRounded.get(rounded), exact, `L ${L}, k ${k}: diversi uniti`);
    else byRounded.set(rounded, exact);
  }
});
