// Punti 13, 63 e 42 del Piano (commit A): funzioni pure di public/ais-logic.js per la posizione stimata
// (proiezione lossodromica lungo la COG con limiti di Boat Watch), la riproduzione in differita fra due fix veri
// (MyShipTracking) e l'animazione limitata alle navi importanti (ShipXplorer). L'animatore della pagina viene dopo.
// Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');

const MIN = 60 * 1000;
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} atteso ${expected} ±${tol}, ottenuto ${actual}`);
// 1852 m (un miglio nautico) sulla sfera di raggio medio R_EARTH: 0,99932′, non esattamente 1′
const NM_DEG = 1852 / AL.R_EARTH * 180 / Math.PI;
// Distanza equirettangolare in metri (come approach), per i controlli
function dist(a, b) {
  const rad = Math.PI / 180, dLon = ((b.lon - a.lon + 540) % 360) - 180;
  const x = dLon * rad * Math.cos((a.lat + b.lat) / 2 * rad) * AL.R_EARTH, y = (b.lat - a.lat) * rad * AL.R_EARTH;
  return Math.hypot(x, y);
}

test('costanti: nodo in m/s, raggio medio della Terra, ritardo della riproduzione 15 s', () => {
  assert.equal(AL.KN, 0.514444);
  assert.equal(AL.R_EARTH, 6371008.8);
  assert.equal(AL.ANIM_DELAY_MS, 15000);
});

// --- Punto 63: lossodromia e limiti della stima ---------------------------------------------------------
test('rhumbDestination: nord ed est all\'equatore, est a 60° (il doppio dei gradi di longitudine)', () => {
  const n = AL.rhumbDestination(0, 0, 0, 1852);
  near(n.lat, NM_DEG, 1e-9, 'lat'); near(n.lon, 0, 1e-12, 'lon');
  near(n.lat, 1 / 60, 2e-5, 'circa un primo');
  const e = AL.rhumbDestination(0, 0, 90, 1852);
  near(e.lat, 0, 1e-12, 'lat'); near(e.lon, NM_DEG, 1e-9, 'lon');
  const e60 = AL.rhumbDestination(60, 0, 90, 1852);
  near(e60.lat, 60, 1e-9, 'lat costante su una rotta est');
  near(e60.lon, 2 * NM_DEG, 1e-6, 'lon a 60°');
  near(e60.lon, 2 / 60, 1e-4, 'circa due primi');
  const s = AL.rhumbDestination(10, 20, 180, 1852);
  near(s.lat, 10 - NM_DEG, 1e-9, 'sud'); near(s.lon, 20, 1e-12, 'sud: lon invariata');
});

test('rhumbDestination: attraverso l\'antimeridiano la longitudine resta in [-180, 180)', () => {
  const p = AL.rhumbDestination(0, 179.99, 90, 5000);
  assert.ok(p.lon >= -180 && p.lon < 180, String(p.lon));
  near(p.lon, -179.965, 1e-3);
  const w = AL.rhumbDestination(0, -179.99, 270, 5000);
  near(w.lon, 179.965, 1e-3, 'verso ovest');
});

test('rhumbDestination: oltre il polo la latitudine resta finita e ≤ 90; distanza 0 = stesso punto', () => {
  const p = AL.rhumbDestination(89.999, 0, 0, 1000);
  assert.ok(Number.isFinite(p.lat) && p.lat <= 90, String(p.lat));
  assert.ok(Number.isFinite(p.lon), String(p.lon));
  const s = AL.rhumbDestination(-89.999, 0, 180, 1000);
  assert.ok(Number.isFinite(s.lat) && s.lat >= -90, String(s.lat));
  assert.deepEqual(AL.rhumbDestination(43.5, 10.3, 90, 0), { lat: 43.5, lon: 10.3 });
});

test('estimateLimitMs: nessuna stima fino a 0,5 kn e senza velocità; 242 s fino a 3 kn, 122 s oltre', () => {
  const cases = [[0.1, 0], [0.5, 0], [0.51, 242000], [2, 242000], [3, 242000], [3.1, 122000], [30, 122000],
    [102.2, 122000], [102.3, 0], [200, 0], [-1, 0], [NaN, 0], [Infinity, 0], [undefined, 0], [null, 0], ['5', 0]];
  for (const [sog, ms] of cases) assert.equal(AL.estimateLimitMs(sog), ms, String(sog));
});

test('canEstimate: velocità, COG valida (non la prua) e nave non ferma (isStill del punto 8)', () => {
  assert.equal(AL.canEstimate({ sog: 10, cog: 90 }), true);
  assert.equal(AL.canEstimate({ sog: 10, cog: 0 }), true, 'COG 0 = nord è valida');
  assert.equal(AL.canEstimate({ sog: 2, cog: 90, navStat: 5 }), false, 'ormeggiata sotto 3 kn: ferma');
  assert.equal(AL.canEstimate({ sog: 4, cog: 90, navStat: 5 }), true, 'stato ormeggiata ma va a 4 kn');
  assert.equal(AL.canEstimate({ sog: 10, cog: 360 }), false, 'COG 360 = non disponibile');
  assert.equal(AL.canEstimate({ sog: 10, cog: -1 }), false);
  assert.equal(AL.canEstimate({ sog: 10, cog: null, heading: 90 }), false, 'la prua da sola non basta');
  assert.equal(AL.canEstimate({ sog: 10 }), false);
  assert.equal(AL.canEstimate({ sog: 0.3, cog: 90 }), false);
  assert.equal(AL.canEstimate({ sog: 102.3, cog: 90 }), false);
});

test('project: 10 kn verso est con fix di 5 min fa → ferma a 122 s (627,6 m); 10 min fa stessa posizione', () => {
  const T = 1_700_000_000_000;
  const fix = { lat: 0, lon: 0, sog: 10, cog: 90, heading: 88, navStat: 0, ts: T };
  const p5 = AL.project(fix, T + 5 * MIN);
  assert.equal(p5.mode, 'estimate');
  assert.equal(p5.aheadMs, 122000);
  near(dist(fix, p5), 627.6, 1, 'distanza');
  near(p5.lat, 0, 1e-12, 'verso est la latitudine non cambia');
  assert.equal(p5.cog, 90); assert.equal(p5.sog, 10); assert.equal(p5.heading, 88);
  const p10 = AL.project(fix, T + 10 * MIN);
  assert.deepEqual(p10, p5, 'oltre il limite la stima non avanza');
  const p1 = AL.project(fix, T + 60000);
  assert.equal(p1.aheadMs, 60000);
  near(dist(fix, p1), 10 * AL.KN * 60, 1e-3, 'a 1 min');
});

test('project: niente stima a 0,1 kn, per navi ferme, ts non valido; fix nel futuro nessuno spostamento', () => {
  const T = 1_700_000_000_000;
  const slow = AL.project({ lat: 43.5, lon: 10.3, sog: 0.1, cog: 90, heading: 511, ts: T }, T + 5 * MIN);
  assert.deepEqual(slow, { lat: 43.5, lon: 10.3, cog: 90, sog: 0.1, heading: 511, mode: 'fix', aheadMs: 0 });
  assert.equal(AL.project({ lat: 43.5, lon: 10.3, sog: 2, cog: 90, navStat: 1, ts: T }, T + MIN).mode, 'fix', 'all\'ancora');
  assert.equal(AL.project({ lat: 43.5, lon: 10.3, sog: 10, cog: 90, ts: -Infinity }, T).mode, 'fix', 'ts mancante');
  assert.equal(AL.project({ lat: 43.5, lon: 10.3, sog: 10, cog: 90, ts: NaN }, T).mode, 'fix');
  const future = AL.project({ lat: 43.5, lon: 10.3, sog: 10, cog: 90, ts: T + 5000 }, T);
  assert.equal(future.aheadMs, 0);
  assert.equal(future.lat, 43.5); assert.equal(future.lon, 10.3);
});

// --- Punto 42: riproduzione in differita fra due fix veri ----------------------------------------------
test('lerpAngle: dal lato più corto, passando per 0° e non per 180°', () => {
  assert.equal(AL.lerpAngle(350, 10, 0.5), 0);
  assert.equal(AL.lerpAngle(10, 350, 0.5), 0);
  near(AL.lerpAngle(350, 10, 0.25), 355, 1e-9);
  near(AL.lerpAngle(10, 350, 0.25), 5, 1e-9);
  assert.equal(AL.lerpAngle(90, 180, 0.5), 135);
  assert.equal(AL.lerpAngle(90, 180, 0), 90);
  assert.equal(AL.lerpAngle(90, 180, 1), 180);
});

test('interpolate: a metà fra due fix il punto medio, velocità lineare, rotta dal lato corto', () => {
  const a = { lat: 43.0, lon: 10.0, sog: 10, cog: 350, heading: 350, ts: 1000 };
  const b = { lat: 43.1, lon: 10.2, sog: 12, cog: 10, heading: 10, ts: 16000 };
  const m = AL.interpolate(a, b, 8500);
  assert.equal(m.mode, 'interp');
  near(m.lat, 43.05, 1e-9); near(m.lon, 10.1, 1e-9);
  near(m.sog, 11, 1e-9); near(m.cog, 0, 1e-9); assert.equal(m.heading, 0);
  const before = AL.interpolate(a, b, 0), after = AL.interpolate(a, b, 99999);
  near(before.lat, 43.0, 1e-12, 'prima: fermo al primo'); near(after.lat, 43.1, 1e-12, 'dopo: fermo al secondo');
  const same = AL.interpolate(a, { ...b, ts: 1000 }, 1000);
  assert.equal(same.lat, 43.1); assert.equal(same.lon, 10.2);
});

test('interpolate: antimeridiano dal lato corto; rotta o prua non valida → quella di b; prua intera', () => {
  const a = { lat: 0, lon: 179.9, sog: 10, cog: 90, heading: 511, ts: 0 };
  const b = { lat: 0, lon: -179.9, sog: 102.3, cog: 360, heading: 91, ts: 10 };
  const m = AL.interpolate(a, b, 5);
  assert.ok(Math.abs(Math.abs(m.lon) - 180) < 1e-9, `lon vicino a ±180: ${m.lon}`);
  assert.ok(m.lon >= -180 && m.lon < 180, String(m.lon));
  assert.equal(m.cog, 360, 'cog di b'); assert.equal(m.heading, 91, 'prua di b'); assert.equal(m.sog, 102.3, 'sog di b');
  const h = AL.interpolate({ ...a, heading: 10 }, { ...b, heading: 13 }, 5);
  assert.equal(h.heading, 12, 'prua interpolata arrotondata al grado (resta valida per validHeading)');
});

test('pushFix: array nuovo, ignora fix non più recenti, tiene gli ultimi 3, ts non valido ricomincia', () => {
  const f = ts => ({ lat: 0, lon: 0, ts });
  const t1 = AL.pushFix([], f(1));
  assert.deepEqual(t1, [f(1)]);
  const orig = [f(1), f(2)];
  const t3 = AL.pushFix(orig, f(3));
  assert.deepEqual(orig, [f(1), f(2)], 'originale invariato');
  assert.notEqual(t3, orig);
  assert.deepEqual(t3.map(x => x.ts), [1, 2, 3]);
  assert.deepEqual(AL.pushFix(t3, f(4)).map(x => x.ts), [2, 3, 4], 'massimo 3');
  assert.deepEqual(AL.pushFix(t3, f(4), 2).map(x => x.ts), [3, 4], 'max diverso');
  assert.deepEqual(AL.pushFix(t3, f(3)).map(x => x.ts), [1, 2, 3], 'stesso ts ignorato');
  assert.deepEqual(AL.pushFix(t3, f(2)).map(x => x.ts), [1, 2, 3], 'più vecchio ignorato');
  assert.notEqual(AL.pushFix(t3, f(2)), t3, 'anche quando ignora, array nuovo');
  assert.deepEqual(AL.pushFix(t3, f(-Infinity)), [f(-Infinity)], 'fix senza ora: solo lui');
  assert.deepEqual(AL.pushFix([f(NaN)], f(5)), [f(5)], 'traccia senza ora: ricomincia');
  assert.deepEqual(AL.pushFix(undefined, f(5)), [f(5)]);
});

test('positionAt: prima del primo fix, fra due, oltre l\'ultimo (stima del punto 13), ferma, vuota', () => {
  const T = 1_700_000_000_000;
  const A = { lat: 0, lon: 0, sog: 10, cog: 90, heading: 90, navStat: 0, ts: T };
  const B = { lat: 0, lon: 0.001, sog: 10, cog: 90, heading: 90, navStat: 0, ts: T + 15000 };
  assert.equal(AL.positionAt([], T), null);
  assert.equal(AL.positionAt(null, T), null);
  const first = AL.positionAt([A, B], T - 1000);
  assert.equal(first.mode, 'fix'); assert.equal(first.lon, 0);
  const mid = AL.positionAt([A, B], T + 7500);
  assert.equal(mid.mode, 'interp'); near(mid.lon, 0.0005, 1e-12);
  const beyond = AL.positionAt([A, B], T + 15000 + 60000);
  assert.equal(beyond.mode, 'estimate'); assert.equal(beyond.aheadMs, 60000);
  assert.ok(beyond.lon > B.lon);
  const capped = AL.positionAt([A, B], T + 15000 + 5 * MIN);
  assert.equal(capped.aheadMs, 122000, 'stima ferma a 122 s oltre l\'ultimo fix');
  const still = { ...B, sog: 0, navStat: 5 };
  const s = AL.positionAt([A, still], T + 5 * MIN);
  assert.equal(s.mode, 'fix'); assert.equal(s.lon, 0.001);
  assert.equal(AL.positionAt([A], T + 1000).mode, 'estimate', 'un solo fix: stima');
  const three = [A, B, { ...B, lon: 0.003, ts: T + 30000 }];
  near(AL.positionAt(three, T + 22500).lon, 0.002, 1e-12, 'fra il secondo e il terzo');
});

test('playbackTime: ora − ritardo, mai indietro rispetto al passo precedente', () => {
  assert.equal(AL.playbackTime(100000), 85000);
  assert.equal(AL.playbackTime(100000, 10000), 90000);
  assert.equal(AL.playbackTime(100000, 15000, 90000), 90000, 'orologio corretto all\'indietro: resta fermo');
  let prev = -Infinity;
  for (const now of [100000, 101000, 99000, 105000, 104000]) {
    const t = AL.playbackTime(now, 15000, prev);
    assert.ok(t >= prev, `${t} >= ${prev}`);
    prev = t;
  }
  assert.equal(prev, 90000);
});

// --- Animazione: metri per pixel, avvicinamento, priorità, frequenza ------------------------------------
test('metersPerPixel: scala di Web Mercator', () => {
  near(AL.metersPerPixel(0, 0), 156543.03392, 1e-9);
  near(AL.metersPerPixel(60, 1), 156543.03392 * 0.5 / 2, 1e-6);
  near(AL.metersPerPixel(0, 14), 9.554628535, 1e-6);
});

test('approach: non torna indietro per poco, si avvicina, salta oltre 5 km, senza posizione mostrata = target', () => {
  const target = { lat: 0, lon: 0, cog: 90, sog: 10, heading: 90, mode: 'interp' };
  const east = m => ({ lat: 0, lon: m / AL.R_EARTH * 180 / Math.PI });
  assert.deepEqual(AL.approach(null, target, { dtMs: 16 }), target);
  // mostrata 100 m più avanti (a est) del target: il target è dietro → resta ferma
  const ahead100 = east(100);
  const r1 = AL.approach(ahead100, target, { dtMs: 16 });
  assert.equal(r1.lat, ahead100.lat); assert.equal(r1.lon, ahead100.lon);
  // 600 m avanti: oltre maxBackM si avvicina (indietro) di dt/blend
  const ahead600 = east(600);
  const r2 = AL.approach(ahead600, target, { dtMs: 100 });
  near(dist(r2, target), 540, 0.01, '600 m · (1 − 0,1)');
  // mostrata dietro (a ovest) del target: si avvicina in avanti
  const behind = east(-200);
  const r3 = AL.approach(behind, target, { dtMs: 250 });
  near(dist(r3, target), 150, 0.01);
  assert.ok(r3.lon > behind.lon);
  assert.equal(r3.cog, 90); assert.equal(r3.mode, 'interp', 'gli altri campi sono del target');
  // oltre blendMs arriva al target
  const r4 = AL.approach(behind, target, { dtMs: 5000 });
  near(r4.lon, 0, 1e-12);
  // 6 km: salto diretto
  assert.deepEqual(AL.approach(east(6000), target, { dtMs: 16 }), target);
  assert.deepEqual(AL.approach(east(-6000), target, { dtMs: 16 }), target);
  // target senza rotta valida: niente controllo «indietro», si avvicina
  const r5 = AL.approach(ahead100, { ...target, cog: 360 }, { dtMs: 500 });
  near(dist(r5, target), 50, 0.01);
  // opzioni diverse
  const r6 = AL.approach(ahead600, target, { dtMs: 100, maxBackM: 1000 });
  assert.equal(r6.lon, ahead600.lon, 'maxBackM 1000: resta');
  assert.deepEqual(AL.approach(ahead600, target, { dtMs: 16, snapM: 500 }), target, 'snapM 500: salta');
});

test('approach: avvicinamento attraverso l\'antimeridiano dal lato corto', () => {
  const target = { lat: 0, lon: -179.999, cog: 90, sog: 10, heading: 90, mode: 'interp' };
  const r = AL.approach({ lat: 0, lon: 179.999 }, target, { dtMs: 500 });
  assert.ok(Math.abs(Math.abs(r.lon) - 180) < 1e-9, `metà strada vicino a ±180: ${r.lon}`);
  assert.ok(r.lon >= -180 && r.lon < 180, String(r.lon));
});

test('animPriority: selezionata prima di tutto, poi tipo 60-89, lunghezza, età (come sample.js)', () => {
  const T = 1_700_000_000_000;
  const p = { ts: T };
  assert.equal(AL.animPriority(p, {}, false, T), 0);
  assert.equal(AL.animPriority(p, {}, true, T), 1000);
  assert.equal(AL.animPriority(p, { shipType: 70 }, false, T), 1);
  assert.equal(AL.animPriority(p, { shipType: 59 }, false, T), 0);
  assert.equal(AL.animPriority(p, { length: 80 }, false, T), 3, 'log2(80/10)');
  assert.equal(AL.animPriority(p, { length: 5000 }, false, T), 5, 'al massimo 5');
  assert.equal(AL.animPriority(p, { length: 5 }, false, T), 0, 'mai negativa');
  assert.equal(AL.animPriority(p, { length: 40.4 }, false, T), 2, 'lunghezza arrotondata al metro');
  assert.equal(AL.animPriority({ ts: T - 25 * MIN }, {}, false, T), -2, '-1 ogni 10 min');
  assert.equal(AL.animPriority({ ts: T - 300 * MIN }, {}, false, T), -3, 'al massimo -3');
  assert.equal(AL.animPriority({ ts: -Infinity }, {}, false, T), -3, 'ora non valida = vecchia');
  assert.equal(AL.animPriority({ ts: T + MIN }, {}, false, T), 0, 'ora nel futuro: nessuna penalità');
  assert.equal(AL.animPriority(p, null, false, T), 0, 'senza dati statici');
});

test('pickAnimated: punteggio decrescente, poi MMSI crescente, primi n', () => {
  const items = [{ mmsi: 5, score: 1 }, { mmsi: 3, score: 2 }, { mmsi: 9, score: 2 }, { mmsi: 1, score: 1 }, { mmsi: 7, score: 1000 }];
  assert.deepEqual(AL.pickAnimated(items, 3), [7, 3, 9]);
  assert.deepEqual(AL.pickAnimated(items, 10), [7, 3, 9, 1, 5]);
  assert.deepEqual(AL.pickAnimated(items, 0), []);
  assert.deepEqual(AL.pickAnimated([], 5), []);
  assert.deepEqual(items.map(x => x.mmsi), [5, 3, 9, 1, 7], 'originale invariato');
});

test('frameInterval: ogni quanto fare un passo dell\'animazione', () => {
  assert.equal(AL.frameInterval({ redrawMs: 0, maxPxPerS: 0 }), 1000, 'nessun movimento: 1 s');
  assert.ok(AL.frameInterval({ redrawMs: 10, maxPxPerS: 100 }) >= 40, 'quattro volte il ridisegno');
  assert.equal(AL.frameInterval({ redrawMs: 10, maxPxPerS: 100 }), 40);
  near(AL.frameInterval({ redrawMs: 0, maxPxPerS: 17 }), 500 / 17, 1e-9, 'mezzo pixel per passo');
  assert.equal(AL.frameInterval({ redrawMs: 0, maxPxPerS: 1000 }), 16, 'mai sotto minMs');
  assert.equal(AL.frameInterval({ redrawMs: 1000, maxPxPerS: 1000 }), 1000, 'mai sopra maxMs');
  assert.equal(AL.frameInterval({ redrawMs: 0, maxPxPerS: 1000, minMs: 50 }), 50);
  assert.equal(AL.frameInterval({ redrawMs: NaN, maxPxPerS: 100 }), 16, 'ridisegno non misurato = 0');
});

test('inViewBox e boundsBox: area della vista, anche attraverso l\'antimeridiano', () => {
  const box = AL.boundsBox(5, 40, 15, 45);
  assert.deepEqual(box, [5, 40, 15, 45]);
  assert.equal(AL.inViewBox(box, 43, 10), true);
  assert.equal(AL.inViewBox(box, 46, 10), false);
  assert.equal(AL.inViewBox(box, 43, 16), false);
  assert.equal(AL.inViewBox(box, 40, 5), true, 'bordi inclusi');
  assert.equal(AL.inViewBox(null, 0, 0), true, 'senza area: tutto');
  const anti = AL.boundsBox(170, -10, 190, 10);
  assert.deepEqual(anti, [170, -10, -170, 10]);
  assert.equal(AL.inViewBox(anti, 0, 175), true);
  assert.equal(AL.inViewBox(anti, 0, -175), true);
  assert.equal(AL.inViewBox(anti, 0, 0), false);
  assert.deepEqual(AL.boundsBox(-400, -100, 400, 100), [-180, -90, 180, 90], 'più di un giro: mondo');
  assert.deepEqual(AL.boundsBox(-190, -95, -170, 95), [170, -90, -170, 90], 'lat limitata a ±90');
});
