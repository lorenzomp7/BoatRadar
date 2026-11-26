// BoatRadar: campione per importanza di /api/locations (punto 4 del Piano). Funzioni pure, senza stato.
// Quando le navi nel bbox sono più di limit, server.js tiene le più importanti (come OpenCPN e Vesseltracker:
// a zoom basso precedenza alle navi grandi) con un massimo per cella di una griglia sul bbox, così anche le
// zone poco dense restano rappresentate. Il campione è stabile: a parità di dati, stesse navi nello stesso ordine.
'use strict';

const SAMPLE_GRID = 64;                 // griglia SAMPLE_GRID × SAMPLE_GRID sul bbox
const AGE_STEP_MS = 10 * 60 * 1000;     // un punto in meno ogni 10 min di età della posizione...
const AGE_MAX_PENALTY = 3;              // ...fino a 3 (30 min, il limite delle navi in moto);
const AGE_OLD_MS = AGE_STEP_MS * AGE_MAX_PENALTY;
const AGE_HOUR_MS = 60 * 60 * 1000;     // oltre (solo navi ferme, conservate fino a 6 h) uno in meno per ogni ora o
const AGE_OLD_MAX_PENALTY = 8;          // frazione d'ora in più, fino a 8 in tutto
const WORLD = [-180, -90, 180, 90];

// Punteggio di una nave: p = posizione (classA, sog, ts), v = dati statici (length, shipType), now in ms.
// Classe A +2; in moto +2 (oltre 0,5 kn; 102,3 = non disponibile); lunghezza log2(m / 10), da 0 a 5;
// cargo, petroliera, passeggeri, alta velocità, rimorchiatori e simili (tipi 60-89) +1; età: -1 ogni 10 min fino a -3
// (30 min), poi -1 per ogni ora o frazione in più fino a -8 (agePenalty): una posizione di ore fa passa dopo le navi fresche.
function importance(p, v, now) {
  return dynamicImportance(p, now) + staticImportance(v);
}

// Parte che dipende solo dai dati statici (lunghezza e tipo): server.js la calcola alla ricezione dei messaggi
// e la tiene nella posizione (staticScore), così una richiesta non rilegge i dati statici di ogni nave.
// La lunghezza è arrotondata al metro: così il punteggio dipende solo da metri interi e i pari matematici
// (es. 100 e 100,05 m, oppure 172 m e 86 m + tipo 89) restano pari nel confronto di sampleByImportance.
function staticImportance(v) {
  if (!v) return 0;
  let s = 0;
  const length = Math.round(v.length);
  if (length > 0) s += Math.min(5, Math.max(0, Math.log2(length / 10)));
  if (v.shipType >= 60 && v.shipType <= 89) s += 1;
  return s;
}

// Parte che dipende dalla posizione: classe, movimento ed età (cambia col passare del tempo)
function dynamicImportance(p, now) {
  let s = 0;
  if (p.classA) s += 2;
  if (Number.isFinite(p.sog) && p.sog > 0.5 && p.sog < 102.3) s += 2;
  const age = Number.isFinite(p.ts) ? Math.max(0, now - p.ts) : Infinity;
  return s - agePenalty(age);
}

// Penalità (intera, 0-8) per l'età in ms: 30 min esatti = 3, 30 min + 1 ms = 4, 1 h 30 min + 1 ms = 5… Infinity = 8
function agePenalty(age) {
  if (age <= AGE_OLD_MS) return Math.floor(age / AGE_STEP_MS);
  return Math.min(AGE_OLD_MAX_PENALTY, AGE_MAX_PENALTY + Math.ceil((age - AGE_OLD_MS) / AGE_HOUR_MS));
}

// Pari quasi uguali: i punteggi si confrontano in unità di 1e-9 (Math.round(score · SCORE_UNITS), un intero
// esatto in un Float64). Due punteggi uguali in matematica ma diversi nell'ultimo bit del float (log2(17,2) e
// log2(8,6) + 1) diventano lo stesso intero. Con lunghezze intere fra 10 e 320 m e parte intera fra -8 e +5 due
// punteggi diversi distano almeno 1,7e-5 e nessuno cade a meno di 8e-5 unità da un bordo di arrotondamento
// (test in test/sample.test.js): l'arrotondamento non separa mai due pari né unisce due punteggi diversi.
const SCORE_UNITS = 1e9;

// hits = [[mmsi, p]] (le navi nel bbox, MMSI numerici), limit ≥ 1, box = [w, s, e, n] o null (mondo; w > e attraversa
// l'antimeridiano). vesselOf(mmsi) → dati statici; staticOf(mmsi, p) → staticImportance già calcolata (di base
// la calcola da vesselOf). Restituisce al massimo limit voci di hits in ordine di
// punteggio (poi MMSI crescente); con hits.length <= limit restituisce hits stesso. Non modifica hits.
function sampleByImportance(hits, limit, box, { vesselOf = () => undefined, staticOf = mmsi => staticImportance(vesselOf(mmsi)),
  now = Date.now(), grid = SAMPLE_GRID } = {}) {
  const n = hits.length;
  if (n <= limit) return hits;
  const [w, s, e, n0] = box || WORLD;
  const width = w <= e ? e - w : e - w + 360, height = n0 - s;
  // array tipizzati: con decine di migliaia di navi (vista mondo a ogni miss della cache) niente oggetti per nave
  const score = new Float64Array(n), mmsiOf = new Float64Array(n), cell = new Uint32Array(n), order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const mmsi = hits[i][0], p = hits[i][1];
    score[i] = Math.round((dynamicImportance(p, now) + (staticOf(mmsi, p) || 0)) * SCORE_UNITS);
    mmsiOf[i] = mmsi;
    const dx = ((p.lon - w) % 360 + 360) % 360;
    const x = width > 0 ? Math.max(0, Math.min(grid - 1, Math.floor(dx / width * grid))) : 0;
    const y = height > 0 ? Math.max(0, Math.min(grid - 1, Math.floor((p.lat - s) / height * grid))) : 0;
    cell[i] = (y * grid + x) || 0;   // || 0: coordinate NaN in una cella qualsiasi, mai un indice non valido
    order[i] = i;
  }
  // order = indici di hits per punteggio decrescente, poi MMSI crescente (poi indice: ordine totale)
  order.sort((a, b) => score[b] - score[a] || mmsiOf[a] - mmsiOf[b] || a - b);

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

module.exports = { importance, staticImportance, dynamicImportance, agePenalty, sampleByImportance, SAMPLE_GRID, AGE_STEP_MS, AGE_MAX_PENALTY,
  AGE_OLD_MAX_PENALTY };
