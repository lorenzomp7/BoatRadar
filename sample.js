// BoatRadar: campione per importanza di /api/locations (punto 4 del Piano). Funzioni pure, senza stato.
// Quando le navi nel bbox sono più di limit, server.js tiene le più importanti (come OpenCPN e Vesseltracker:
// a zoom basso precedenza alle navi grandi) con un massimo per cella di una griglia sul bbox, così anche le
// zone poco dense restano rappresentate. Il campione è stabile: a parità di dati, stesse navi nello stesso ordine.
'use strict';

const SAMPLE_GRID = 64;                 // griglia SAMPLE_GRID × SAMPLE_GRID sul bbox
const AGE_STEP_MS = 10 * 60 * 1000;     // un punto in meno ogni 10 min di età della posizione...
const AGE_MAX_PENALTY = 3;              // ...fino a 3
const WORLD = [-180, -90, 180, 90];

// Punteggio di una nave: p = posizione (classA, sog, ts), v = dati statici (length, shipType), now in ms.
// Classe A +2; in moto +2 (oltre 0,5 kn; 102,3 = non disponibile); lunghezza log2(m / 10), da 0 a 5;
// cargo, petroliera, passeggeri, alta velocità, rimorchiatori e simili (tipi 60-89) +1; età: -1 ogni 10 min, al massimo -3.
function importance(p, v, now) {
  return dynamicImportance(p, now) + staticImportance(v);
}

// Parte che dipende solo dai dati statici (lunghezza e tipo): server.js la calcola alla ricezione dei messaggi
// e la tiene nella posizione (staticScore), così una richiesta non rilegge i dati statici di ogni nave.
function staticImportance(v) {
  if (!v) return 0;
  let s = 0;
  if (v.length > 0) s += Math.min(5, Math.max(0, Math.log2(v.length / 10)));
  if (v.shipType >= 60 && v.shipType <= 89) s += 1;
  return s;
}

// Parte che dipende dalla posizione: classe, movimento ed età (cambia col passare del tempo)
function dynamicImportance(p, now) {
  let s = 0;
  if (p.classA) s += 2;
  if (Number.isFinite(p.sog) && p.sog > 0.5 && p.sog < 102.3) s += 2;
  const age = Number.isFinite(p.ts) ? Math.max(0, now - p.ts) : Infinity;
  s -= Math.min(AGE_MAX_PENALTY, Math.floor(age / AGE_STEP_MS));
  return s;
}

// Ordinamento veloce (vista mondo: decine di migliaia di navi a ogni miss della cache): il punteggio è
// arrotondato a 1/1024 (SCORE_SCALE), che per lunghezze intere in metri lascia l'ordine identico (due lunghezze
// vicine ≤ 320 m distano almeno 4,6/1024 su log2); poi un ordinamento numerico nativo per MMSI (chiave
// mmsi · 2^22 + indice in un Float64Array, esatta sotto 2^53) e un counting sort stabile per punteggio decrescente.
const SCORE_SCALE = 1024;
const Q_MAX = 10 * SCORE_SCALE, Q_MIN = -AGE_MAX_PENALTY * SCORE_SCALE;   // punteggio fra -3 e 10
const INDEX_BITS = 2 ** 22;      // fino a 4 milioni di navi per richiesta
const MMSI_LIMIT = 2 ** 30;      // un MMSI AIS ha 30 bit

// hits = [[mmsi, p]] (le navi nel bbox), limit ≥ 1, box = [w, s, e, n] o null (mondo; w > e attraversa
// l'antimeridiano). vesselOf(mmsi) → dati statici; staticOf(mmsi, p) → staticImportance già calcolata (di base
// la calcola da vesselOf). Restituisce al massimo limit voci di hits in ordine di
// punteggio (poi MMSI crescente); con hits.length <= limit restituisce hits stesso. Non modifica hits.
function sampleByImportance(hits, limit, box, { vesselOf = () => undefined, staticOf = mmsi => staticImportance(vesselOf(mmsi)),
  now = Date.now(), grid = SAMPLE_GRID } = {}) {
  const n = hits.length;
  if (n <= limit) return hits;
  const [w, s, e, n0] = box || WORLD;
  const width = w <= e ? e - w : e - w + 360, height = n0 - s;
  const q = new Int32Array(n), cell = new Uint32Array(n), keys = new Float64Array(n);
  let packed = n < INDEX_BITS;
  for (let i = 0; i < n; i++) {
    const mmsi = hits[i][0], p = hits[i][1];
    const score = Math.round((dynamicImportance(p, now) + (staticOf(mmsi, p) || 0)) * SCORE_SCALE);
    q[i] = score > Q_MAX ? Q_MAX : score < Q_MIN ? Q_MIN : score;
    const dx = ((p.lon - w) % 360 + 360) % 360;
    const x = width > 0 ? Math.max(0, Math.min(grid - 1, Math.floor(dx / width * grid))) : 0;
    const y = height > 0 ? Math.max(0, Math.min(grid - 1, Math.floor((p.lat - s) / height * grid))) : 0;
    cell[i] = (y * grid + x) || 0;   // || 0: coordinate NaN in una cella qualsiasi, mai un indice non valido
    if (Number.isInteger(mmsi) && mmsi >= 0 && mmsi < MMSI_LIMIT) keys[i] = mmsi * INDEX_BITS + i; else packed = false;
  }
  // order = indici di hits per punteggio decrescente, poi MMSI crescente
  let order;
  if (packed) {
    keys.sort();
    const counts = new Uint32Array(Q_MAX - Q_MIN + 2);
    for (let i = 0; i < n; i++) counts[Q_MAX - q[i] + 1]++;
    for (let b = 1; b < counts.length; b++) counts[b] += counts[b - 1];
    order = new Uint32Array(n);
    for (let j = 0; j < n; j++) { const i = keys[j] % INDEX_BITS; order[counts[Q_MAX - q[i]]++] = i; }
  } else {
    // MMSI fuori dallo standard o troppe navi: confronto diretto, stesso ordine
    order = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => q[b] - q[a] || (hits[a][0] < hits[b][0] ? -1 : hits[a][0] > hits[b][0] ? 1 : a - b));
  }

  // primo passaggio: in ordine di punteggio, al massimo cap navi per cella; secondo: riempie fino a limit
  const cap = Math.max(1, Math.ceil(limit / (grid * grid)));
  const perCell = new Uint32Array(grid * grid), taken = new Uint8Array(n);
  let count = 0, j = 0;
  for (; j < n && count < limit; j++) {
    const i = order[j];
    if (perCell[cell[i]] < cap) { perCell[cell[i]]++; taken[i] = 1; count++; }
  }
  for (let k = 0; k < j && count < limit; k++) if (!taken[order[k]]) { taken[order[k]] = 1; count++; }

  const out = [];
  for (let k = 0; k < n && out.length < count; k++) if (taken[order[k]]) out.push(hits[order[k]]);
  return out;
}

module.exports = { importance, staticImportance, dynamicImportance, sampleByImportance, SAMPLE_GRID, AGE_STEP_MS, AGE_MAX_PENALTY };
