// Punto 71: pannello trascinabile a tre altezze (telefono) con l'elenco delle navi in quest'area. Funzioni pure di
// public/ais-logic.js: sheetStops (le tre altezze), snapStop (altezza a cui si ferma il trascinamento), listRows
// (righe dell'elenco, ordinate e al massimo 100) e panToKeepVisible (spostamento minimo della mappa perché la nave scelta
// resti fra l'header e il pannello). Il comportamento nella pagina è in test/pagina-pannello.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');

test('sheetStops: chiuso 72 px, metà dello schermo, aperto fino a 8 px sotto l\'header', () => {
  assert.deepEqual(AL.sheetStops(844, 96), [72, 422, 740]);
  assert.deepEqual(AL.sheetStops(844, 96, { peek: 80 }), [80, 422, 740]);
  assert.deepEqual(AL.sheetStops(667, 90), [72, 334, 569], 'metà arrotondata');
});

test('sheetStops: schermo basso o header alto → sempre crescenti, chiuso almeno 56 px', () => {
  for (const [h, top] of [[400, 96], [300, 120], [200, 150], [120, 100], [0, 0], [NaN, NaN]]) {
    const s = AL.sheetStops(h, top);
    assert.equal(s.length, 3, `${h}/${top}`);
    assert.ok(s[0] >= 56, `${h}/${top}: chiuso ${s[0]}`);
    assert.ok(s[0] < s[1] && s[1] < s[2], `${h}/${top}: ${s} non crescenti`);
    assert.ok(s.every(Number.isInteger), `${h}/${top}: ${s} interi`);
  }
  assert.deepEqual(AL.sheetStops(400, 96), [72, 200, 296]);
  assert.equal(AL.sheetStops(400, 96, { peek: 20 })[0], 56, 'chiuso mai sotto 56 px');
});

test('snapStop: senza velocità la più vicina; veloce verso l\'alto o il basso al massimo una più in là', () => {
  const stops = [72, 422, 740];
  assert.equal(AL.snapStop(430, 0, stops), 1);
  assert.equal(AL.snapStop(100, 0, stops), 0);
  assert.equal(AL.snapStop(700, 0, stops), 2);
  assert.equal(AL.snapStop(247, 0, stops), 0, 'a metà strada esatta (247) la più bassa');
  assert.equal(AL.snapStop(250, 0, stops), 1);
  // velocità in px/ms, positiva = il pannello cresce (dito verso l'alto); proiezione a 200 ms
  assert.equal(AL.snapStop(430, 2, stops), 2, 'lancio verso l\'alto da metà → aperto');
  assert.equal(AL.snapStop(430, -2, stops), 0, 'lancio verso il basso da metà → chiuso');
  assert.equal(AL.snapStop(100, 5, stops), 1, 'da chiuso un lancio forte arriva a metà, non oltre');
  assert.equal(AL.snapStop(700, -5, stops), 1, 'da aperto un lancio forte arriva a metà, non oltre');
  assert.equal(AL.snapStop(430, 0.2, stops), 1, 'velocità piccola: resta la più vicina');
  assert.equal(AL.snapStop(800, 0, stops), 2, 'oltre l\'ultima');
  assert.equal(AL.snapStop(10, 0, stops), 0, 'sotto la prima');
  assert.equal(AL.snapStop(430, NaN, stops), 1, 'velocità non valida = 0');
});

const it = (mmsi, name, sog, ts, type) => ({ mmsi, name, sog, ts, type });
const mmsis = r => r.rows.map(x => x.mmsi);

test('listRows: per nome (alfabetico italiano, maiuscole e accenti come le lettere), senza nome in fondo, parità per MMSI', () => {
  const items = [it(5, 'zeta'), it(3, undefined), it(2, 'Àlfa'), it(4, 'beta'), it(1, 'ALFA'), it(6, ''), it(7, 'alfa 2'), it(8, 'ALFA 10')];
  assert.deepEqual(mmsis(AL.listRows(items, 'name')), [1, 2, 7, 8, 4, 5, 3, 6]);
  assert.deepEqual(mmsis(AL.listRows(items, 'sconosciuto')), mmsis(AL.listRows(items, 'name')), 'ordinamento sconosciuto = nome');
  // nomi delle proprietà di Object.prototype: come un ordinamento sconosciuto (prima 'hasOwnProperty' lanciava,
  // 'constructor' dava un ordine casuale)
  for (const k of ['hasOwnProperty', 'constructor', 'toString', '__proto__'])
    assert.deepEqual(mmsis(AL.listRows(items, k)), [1, 2, 7, 8, 4, 5, 3, 6], k);
});

test('listRows: per velocità decrescente, sconosciuta o non valida in fondo', () => {
  const items = [it(1, 'A', 3), it(2, 'B', null), it(3, 'C', 12.5), it(4, 'D', 102.3), it(5, 'E', 0), it(6, 'F', 12.5), it(7, 'G', -1)];
  assert.deepEqual(mmsis(AL.listRows(items, 'speed')), [3, 6, 1, 5, 2, 4, 7]);
});

test('listRows: per ultimo segnale (più recente prima, orario mancante in fondo), anche con stringhe ISO', () => {
  const items = [it(1, 'A', 1, 1000), it(2, 'B', 1, '2026-01-01T00:00:05Z'), it(3, 'C', 1, null), it(4, 'D', 1, 5000), it(5, 'E', 1, 5000)];
  assert.deepEqual(mmsis(AL.listRows(items, 'age')), [2, 4, 5, 1, 3]);
});

test('listRows: per tipo (etichetta), poi nome, poi MMSI; tipo mancante in fondo', () => {
  const items = [it(1, 'ZETA', 1, 1, 'Cargo'), it(2, 'ALFA', 1, 1, 'Petroliera'), it(3, 'BETA', 1, 1, 'Cargo'), it(4, 'BETA', 1, 1, 'Cargo'),
    it(5, 'ALFA', 1, 1, null), it(6, 'ALFA', 1, 1, 'Altro / sconosciuto')];
  assert.deepEqual(mmsis(AL.listRows(items, 'type')), [6, 3, 4, 1, 2, 5]);
});

test('listRows: al massimo limit righe (100 di default), more = quante restano; stesso risultato dell\'ordinamento completo', () => {
  const many = Array.from({ length: 6000 }, (_, i) => it(1000 + ((i * 7919) % 6000), `NAVE ${(i * 31) % 997}`, (i % 300) / 10, i * 13 % 9001, ['Cargo', 'Pesca', null][i % 3]));
  for (const sort of ['name', 'speed', 'age', 'type']) {
    const r = AL.listRows(many, sort);
    assert.equal(r.rows.length, 100, sort);
    assert.equal(r.more, 5900, sort);
    assert.deepEqual(mmsis(r), mmsis(AL.listRows(many, sort, Infinity)).slice(0, 100), `${sort}: le prime 100 dell'ordine completo`);
  }
  assert.deepEqual(AL.listRows(many.slice(0, 3), 'name', 2).more, 1);
  assert.deepEqual(AL.listRows([], 'name'), { rows: [], more: 0 });
  assert.deepEqual(AL.listRows(null, 'name'), { rows: [], more: 0 });
  const r = AL.listRows([it(1, 'A')], 'name', 0);
  assert.deepEqual(r, { rows: [], more: 1 });
  // l'elenco passato non cambia
  const src = [it(2, 'B'), it(1, 'A')];
  AL.listRows(src, 'name');
  assert.deepEqual(src.map(x => x.mmsi), [2, 1]);
});

test('panToKeepVisible: nessuno spostamento se la nave è già fra header e pannello, altrimenti il minimo', () => {
  const size = { x: 390, y: 844 };
  // banda libera: x 24…366, y 96+24 = 120 … 844 − 422 − 24 = 398
  assert.deepEqual(AL.panToKeepVisible({ x: 200, y: 300 }, size, 422, 96), { dx: 0, dy: 0 });
  assert.deepEqual(AL.panToKeepVisible({ x: 200, y: 600 }, size, 422, 96), { dx: 0, dy: 202 }, 'sotto il pannello: sale');
  assert.deepEqual(AL.panToKeepVisible({ x: 200, y: 50 }, size, 422, 96), { dx: 0, dy: -70 }, 'sotto l\'header: scende');
  assert.deepEqual(AL.panToKeepVisible({ x: 5, y: 300 }, size, 422, 96), { dx: -19, dy: 0 }, 'troppo a sinistra');
  assert.deepEqual(AL.panToKeepVisible({ x: 380, y: 300 }, size, 422, 96), { dx: 14, dy: 0 }, 'troppo a destra');
  assert.deepEqual(AL.panToKeepVisible({ x: 200, y: 600 }, size, 422, 96, 0), { dx: 0, dy: 178 }, 'margine 0');
  // nuova posizione = punto − spostamento (map.panBy): sta nella banda
  const d = AL.panToKeepVisible({ x: 200.4, y: 700.6 }, size, 422, 96);
  assert.ok(700.6 - d.dy <= 398 + 0.5 && Number.isInteger(d.dy), 'arrotondato e dentro la banda');
  // banda vuota (pannello quasi aperto): la nave a metà dello spazio fra header e pannello
  assert.deepEqual(AL.panToKeepVisible({ x: 200, y: 600 }, size, 740, 96), { dx: 0, dy: 600 - 100 });
  // dati non validi: nessuno spostamento
  assert.deepEqual(AL.panToKeepVisible({ x: NaN, y: 1 }, size, 422, 96), { dx: 0, dy: 0 });
  assert.deepEqual(AL.panToKeepVisible(null, size, 422, 96), { dx: 0, dy: 0 });
});

test('panToKeepVisible: margine destro (computer, scheda o elenco a destra)', () => {
  const size = { x: 1280, y: 800 };
  // scheda a destra da x 928: margine destro 1280 − 928 = 352 → banda x 24 … 1280 − 352 − 24 = 904
  assert.deepEqual(AL.panToKeepVisible({ x: 1000, y: 400 }, size, 0, 60, 24, 352), { dx: 96, dy: 0 }, 'sotto la scheda: a sinistra');
  assert.deepEqual(AL.panToKeepVisible({ x: 600, y: 400 }, size, 0, 60, 24, 352), { dx: 0, dy: 0 }, 'già libera');
  assert.deepEqual(AL.panToKeepVisible({ x: 1000, y: 400 }, size, 0, 60), { dx: 0, dy: 0 }, 'senza margine destro come prima');
  assert.deepEqual(AL.panToKeepVisible({ x: 1000, y: 400 }, size, 0, 60, 24, NaN), { dx: 0, dy: 0 }, 'margine non valido = 0');
  // nessuno spazio libero in larghezza: a metà di quello che resta
  assert.deepEqual(AL.panToKeepVisible({ x: 300, y: 400 }, { x: 390, y: 800 }, 0, 60, 24, 352), { dx: 300 - 19, dy: 0 });
});
