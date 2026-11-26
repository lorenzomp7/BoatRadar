// Punto 12: ricerca ordinata e riconoscibile, funzioni pure di public/ais-logic.js (norm, searchScore, compareSearch,
// homonymCounts, resultLine) usate da server.js (/api/search) e dalla pagina (unione con le navi in mappa).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');

test('norm: maiuscolo, spazi compattati e tolti ai lati; mancante = stringa vuota', () => {
  assert.equal(AL.norm('  laguna   blu \t'), 'LAGUNA BLU');
  assert.equal(AL.norm('Nordic\nStar'), 'NORDIC STAR');
  assert.equal(AL.norm(null), '');
  assert.equal(AL.norm(undefined), '');
  assert.equal(AL.norm(247000001), '247000001');
});

test('searchScore: punteggio del criterio migliore (100 … 30), 0 se nessuno', () => {
  const s = (v, q, mmsi = 247000001) => AL.searchScore(v, mmsi, q);
  assert.equal(s({ name: 'LAGUNA' }, 'LAGUNA'), 90, 'nome esatto');
  assert.equal(s({ name: 'LAGUNA BLU' }, 'LAGUNA'), 70, 'inizio del nome');
  assert.equal(s({ name: 'BLU LAGUNA' }, 'LAGUNA'), 50, 'inizio di una parola');
  assert.equal(s({ name: 'XLAGUNAX' }, 'LAGUNA'), 30, 'contenuto nel nome');
  assert.equal(s({}, '247000001'), 100, 'MMSI esatto');
  assert.equal(s({}, '2470'), 60, 'inizio dell\'MMSI');
  assert.equal(s({ imo: 9074729 }, '9074729', 1), 100, 'IMO esatto');
  assert.equal(s({ imo: 9074729 }, '9074', 1), 60, 'inizio dell\'IMO');
  assert.equal(s({ callSign: 'IBXY' }, 'IBXY'), 80, 'nominativo esatto');
  assert.equal(s({ callSign: 'IBXY' }, 'IB'), 40, 'inizio del nominativo');
  assert.equal(s({ name: 'LAGUNA', callSign: 'IBXY', imo: 9074729 }, 'XYZ'), 0, 'nessuna corrispondenza');
  assert.equal(s({}, '0001'), 0, 'l\'MMSI deve iniziare con q');
});

test('searchScore: separatori di parola, normalizzazione e casi limite', () => {
  const s = (name, q) => AL.searchScore({ name }, 1, q);
  for (const name of ['CAPO-NORD', 'CAPO.NORD', 'CAPO/NORD', 'CAPO  NORD']) assert.equal(s(name, 'NORD'), 50, name);
  assert.equal(s('  laguna  ', 'laguna'), 90, 'nome e q normalizzati');
  assert.equal(s('laguna blu', ' Laguna   Blu '), 90);
  assert.equal(s('LAGUNA', ''), 0, 'q vuota');
  assert.equal(s('LAGUNA', '   '), 0);
  assert.equal(AL.searchScore(undefined, 247000001, '247'), 60, 'senza dati statici conta solo l\'MMSI');
  assert.equal(AL.searchScore(null, 247000001, 'LAGUNA'), 0);
  assert.equal(AL.searchScore({ imo: null }, 1, 'NULL'), 0, 'IMO mancante non è la parola «null»');
  assert.equal(AL.searchScore({ name: 'NAVE' }, 247000001, '247000001'), 100, 'il massimo dei criteri');
  assert.equal(AL.searchScore({ name: '2470 SPIRIT' }, 247000001, '2470'), 70, 'nome che inizia con q vince sull\'MMSI');
});

test('matchesQuery resta: corrisponde quando searchScore > 0', () => {
  assert.equal(AL.matchesQuery({ name: 'Laguna' }, 247000001, 'LAG'), true);
  assert.equal(AL.matchesQuery({ callSign: 'IBXY' }, 1, 'IBX'), true, 'ora anche il nominativo');
  assert.equal(AL.matchesQuery({ name: 'Laguna' }, 247000001, 'XYZ'), false);
});

test('compareSearch: punteggio decrescente, poi posizione più recente, poi MMSI crescente', () => {
  const list = [
    { mmsi: 5, score: 70, ts: 100 },
    { mmsi: 3, score: 90, ts: 50 },
    { mmsi: 4, score: 70, ts: 200 },
    { mmsi: 2, score: 70, ts: 200 },
    { mmsi: 1, score: 70, ts: null },        // orario mancante = il più vecchio
    { mmsi: 6, score: 70, ts: 'boh' },       // illeggibile = il più vecchio, a parità per MMSI
    { mmsi: 7, score: 70, ts: new Date(150).toISOString() },
  ];
  assert.deepEqual([...list].sort(AL.compareSearch).map(x => x.mmsi), [3, 2, 4, 7, 5, 1, 6]);
  // stabile: qualunque ordine di partenza dà lo stesso risultato
  assert.deepEqual([...list].reverse().sort(AL.compareSearch).map(x => x.mmsi), [3, 2, 4, 7, 5, 1, 6]);
  assert.equal(AL.compareSearch({ mmsi: 1, score: 50, ts: null }, { mmsi: 1, score: 50, ts: undefined }), 0, 'mai NaN');
});

test('homonymCounts: quante navi per nome normalizzato, nomi vuoti esclusi', () => {
  const c = AL.homonymCounts([{ name: 'GEMELLA' }, { name: ' gemella ' }, { name: 'LAGUNA' }, { name: '' }, { name: null }, {}, null]);
  assert.equal(c.get('GEMELLA'), 2);
  assert.equal(c.get('LAGUNA'), 1);
  assert.equal(c.has(''), false);
  assert.equal(c.size, 2);
  assert.equal(AL.homonymCounts([]).size, 0);
  assert.equal(AL.homonymCounts(undefined).size, 0);
});

test('resultLine: tipo · bandiera · lunghezza · età · → destinazione, senza le parti mancanti', () => {
  assert.equal(AL.resultLine({ typeName: 'Nave cargo', flag: 'Italia', length: 180, age: '5 min fa', destination: 'GENOVA' }),
    'Nave cargo · Italia · 180 m · 5 min fa · → GENOVA');
  assert.equal(AL.resultLine({ typeName: 'Nave cargo', age: '5 min fa' }), 'Nave cargo · 5 min fa');
  assert.equal(AL.resultLine({ flag: 'Malta', length: 0, destination: '  ' }), 'Malta', 'lunghezza 0 e destinazione vuota omesse');
  assert.equal(AL.resultLine({ length: 179.6 }), '180 m', 'arrotondata al metro');
  assert.equal(AL.resultLine({ length: '180' }), '', 'non un numero: omessa');
  assert.equal(AL.resultLine({ typeName: null, flag: undefined, length: NaN, age: null, destination: null }), '');
  assert.equal(AL.resultLine(), '');
});
