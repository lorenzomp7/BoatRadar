// Fuzz a seme fisso di sampleByImportance (punto 4) contro un riferimento lento e semplice scritto qui:
// punteggio ricalcolato da zero (lunghezza arrotondata al metro), ordine per punteggio decrescente con pari
// entro 1e-9, poi MMSI crescente; stessa griglia, stesso cap per cella, stessi due passaggi.
// Poche centinaia di casi, meno di un secondo. Esegui con: npm test
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sampleByImportance } = require('../sample');

const NOW = 1_800_000_000_000;
const AGE = 10 * 60 * 1000;

function refScore(p, v) {
  let s = 0;
  if (p.classA) s += 2;
  if (Number.isFinite(p.sog) && p.sog > 0.5 && p.sog < 102.3) s += 2;
  const length = v ? Math.round(v.length) : NaN;
  if (length > 0) s += Math.min(5, Math.max(0, Math.log2(length / 10)));
  if (v && v.shipType >= 60 && v.shipType <= 89) s += 1;
  const age = Number.isFinite(p.ts) ? Math.max(0, NOW - p.ts) : Infinity;
  // -1 ogni 10 min fino a 30 min; oltre, -1 per ogni ora o frazione in più, fino a -8
  const penalty = age <= 3 * AGE ? Math.floor(age / AGE) : Math.min(8, 3 + Math.ceil((age - 3 * AGE) / (6 * AGE)));
  return s - penalty;
}

function refSample(hits, limit, box, vesselOf, grid) {
  if (hits.length <= limit) return hits;
  const [w, s, e, n] = box || [-180, -90, 180, 90];
  const width = w <= e ? e - w : e - w + 360, height = n - s;
  const items = hits.map(h => {
    const [mmsi, p] = h;
    const dx = ((p.lon - w) % 360 + 360) % 360;
    const x = width > 0 ? Math.max(0, Math.min(grid - 1, Math.floor(dx / width * grid))) : 0;
    const y = height > 0 ? Math.max(0, Math.min(grid - 1, Math.floor((p.lat - s) / height * grid))) : 0;
    const cell = Number.isFinite(y * grid + x) ? y * grid + x : 0;
    return { h, mmsi, score: refScore(p, vesselOf(mmsi)), cell };
  });
  items.sort((a, b) => (Math.abs(a.score - b.score) < 1e-9 ? 0 : b.score - a.score) || a.mmsi - b.mmsi);
  const cap = Math.max(1, Math.ceil(limit / (grid * grid)));
  const perCell = new Map(), taken = new Set(), skipped = [];
  for (const it of items) {
    if (taken.size >= limit) break;
    const c = perCell.get(it.cell) || 0;
    if (c < cap) { perCell.set(it.cell, c + 1); taken.add(it); } else skipped.push(it);
  }
  for (const it of skipped) { if (taken.size >= limit) break; taken.add(it); }
  return items.filter(it => taken.has(it)).map(it => it.h);
}

// generatore deterministico (LCG), stesso seme a ogni esecuzione
let seed = 20261126;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const BOXES = [null, [-180, -90, 180, 90], [170, -10, -170, 10], [10, 40, 10, 40], [-10, 80, 10, 90],
  [99, -41, 101, -39], [100, 10, -100, 20], [-5, 30, 40, 50]];

function genPos(box) {
  const [w, s, e, n] = box || [-180, -90, 180, 90];
  const width = w <= e ? e - w : e - w + 360;
  let lon = rnd() < 0.2 ? pick([w, e, -180, 180]) : w + rnd() * width;
  if (lon > 180) lon -= 360;
  const lat = rnd() < 0.2 ? pick([s, n]) : s + rnd() * (n - s);
  const r = rnd();
  // età: in gran parte entro 50 min, il resto fino a 7 h (penalità oltre i 30 min)
  const ts = r < 0.05 ? undefined : r < 0.1 ? NOW + 60000 : NOW - ri(0, r < 0.6 ? 50 : 420) * 60000;
  return { lat: rnd() < 0.01 ? NaN : lat, lon, classA: rnd() < 0.5, sog: pick([0, 0.5, 0.51, 3, 12, 102.3, NaN, undefined]), ts };
}
function genVessel() {
  const r = rnd();
  if (r < 0.1) return undefined;
  if (r < 0.15) return {};
  // lunghezze intere, multiple fra loro (pari matematici) e non intere
  const length = pick([0, -5, undefined, 5, 10, 20, 43, 86, 172, 320, 640, ri(1, 400), rnd() * 400, ri(1, 400) + 0.5]);
  return { length, shipType: pick([undefined, 30, 37, 59, 60, 70, 80, 89, 90]) };
}

test('fuzz a seme fisso: stesso ordine del riferimento lento, anche con l\'input mescolato', () => {
  const cases = 300;
  for (let c = 0; c < cases; c++) {
    const box = pick(BOXES), grid = pick([64, 64, 4, 2, 1]);
    const n = ri(2, 300), limit = pick([1, 2, 3, ri(1, n), Math.max(1, n - 1)]);
    const used = new Set(), hits = [], vessels = new Map();
    for (let i = 0; i < n; i++) {
      const mmsi = pick([ri(1, 60), ri(100000000, 999999999), ri(2 ** 30, 2 ** 31)]);
      if (used.has(mmsi)) continue;
      used.add(mmsi);
      hits.push([mmsi, genPos(box)]);
      vessels.set(mmsi, genVessel());
    }
    const vesselOf = m => vessels.get(m);
    const snapshot = JSON.stringify(hits);
    const got = sampleByImportance(hits, limit, box, { vesselOf, now: NOW, grid });
    const want = refSample(hits, limit, box, vesselOf, grid);
    const where = `caso ${c}: n ${hits.length}, limit ${limit}, griglia ${grid}, bbox ${JSON.stringify(box)}`;
    assert.deepEqual(got.map(([m]) => m), want.map(([m]) => m), where);
    assert.equal(got.length, Math.min(limit, hits.length), where);
    assert.equal(JSON.stringify(hits), snapshot, `${where}: hits non modificato`);
    if (hits.length <= limit) continue;   // per contratto restituisce hits così com'è
    const again = sampleByImportance(shuffle(hits), limit, box, { vesselOf, now: NOW, grid });
    assert.deepEqual(again.map(([m]) => m), got.map(([m]) => m), `${where}: input mescolato`);
  }
});
