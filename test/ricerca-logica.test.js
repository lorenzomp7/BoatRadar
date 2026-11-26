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

// --- Correzioni da revisione del punto 12 -------------------------------------------------------------------------------

test('norm: accenti tolti, trattino, punto e barra come spazio', () => {
  assert.equal(AL.norm('Città di Genova'), 'CITTA DI GENOVA');
  assert.equal(AL.norm('ÉTOILE  Ñandú'), 'ETOILE NANDU');
  assert.equal(AL.norm('MSC ANNA-MARIA'), 'MSC ANNA MARIA');
  assert.equal(AL.norm(' A . / - B '), 'A B');
  assert.equal(AL.norm('ST.PAUL/II'), 'ST PAUL II');
  assert.equal(AL.norm('---'), '');
  assert.equal(AL.norm('CAPO NORD'), 'CAPO NORD', 'un nome AIS già pulito resta uguale');
});

test('normQuery: come norm, senza il prefisso «IMO » davanti alle cifre', () => {
  assert.equal(AL.normQuery('IMO 9074729'), '9074729');
  assert.equal(AL.normQuery('  imo   9074729 '), '9074729');
  assert.equal(AL.normQuery('IMO-9074729'), '9074729', 'trattino come spazio');
  assert.equal(AL.normQuery('IMO 9'), '9');
  assert.equal(AL.normQuery('IMO STAR'), 'IMO STAR', 'un nome che inizia con IMO resta');
  assert.equal(AL.normQuery('IMO'), 'IMO');
  assert.equal(AL.normQuery('IMO9074729'), 'IMO9074729', 'solo il prefisso con lo spazio');
  assert.equal(AL.normQuery(null), '');
});

test('searchScore: «città di» trova CITTA DI GENOVA, «anna maria» trova MSC ANNA-MARIA, «IMO 9074729» trova l\'IMO', () => {
  assert.equal(AL.searchScore({ name: 'CITTA DI GENOVA' }, 1, 'città di'), 70);
  assert.equal(AL.searchScore({ name: 'MSC ANNA-MARIA' }, 1, 'anna maria'), 50);
  assert.equal(AL.searchScore({ name: 'MSC ANNA-MARIA' }, 1, 'anna-maria'), 50);
  assert.equal(AL.searchScore({ name: 'MSC ANNA-MARIA' }, 1, 'maria'), 50, 'dopo il trattino inizia una parola');
  assert.equal(AL.searchScore({ name: 'ST.PAUL' }, 1, 'st paul'), 90);
  assert.equal(AL.searchScore({ imo: 9074729 }, 1, 'IMO 9074729'), 100);
  assert.equal(AL.searchScore({ imo: 9074729 }, 1, 'imo 907'), 60);
});

test('scoreFields: con campi già normalizzati dà lo stesso punteggio di searchScore', () => {
  const v = { name: 'MSC ANNA-MARIA', callSign: 'IBXY', imo: 9074729 };
  for (const q of ['MSC', 'ANNA', 'MARIA', 'IBXY', 'IB', '9074729', '907', '247000001', '2470', 'XYZ', 'A'])
    assert.equal(AL.scoreFields(AL.norm(v.name), AL.norm(v.callSign), '247000001', '9074729', q), AL.searchScore(v, 247000001, q), q);
  assert.equal(AL.scoreFields('', '', '', '', 'AB'), 0, 'tutto mancante');
});

test('insertTop: tiene le prime max nell\'ordine di compareSearch, come ordinare tutto e tagliare', () => {
  const top = [];
  const hits = [{ mmsi: 5, score: 70, ts: 1 }, { mmsi: 2, score: 90, ts: 1 }, { mmsi: 9, score: 70, ts: 3 },
    { mmsi: 1, score: 30, ts: 9 }, { mmsi: 3, score: 70, ts: 3 }];
  for (const h of hits) AL.insertTop(top, h, 3);
  assert.deepEqual(top.map(h => h.mmsi), [2, 3, 9]);
  const all = [];
  for (const h of hits) AL.insertTop(all, h, 25);
  assert.deepEqual(all.map(h => h.mmsi), [...hits].sort(AL.compareSearch).map(h => h.mmsi));
});

test('twinsText: «N navi con questo nome», «almeno N» se il conteggio può essere incompleto, niente sotto 2', () => {
  assert.equal(AL.twinsText(2, true), '2 navi con questo nome');
  assert.equal(AL.twinsText(3, false), 'almeno 3 navi con questo nome');
  assert.equal(AL.twinsText(1, false), '');
  assert.equal(AL.twinsText(0, true), '');
});

// Implementazione del commit 2b2f80a (prima delle correzioni), con la norm da usare come parametro: la ricerca nuova deve
// dare gli stessi risultati nello stesso ordine (con la norm nuova; con quella vecchia sui nomi a cui non cambia nulla)
const oldNorm = s => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
function oldSearch(items, text, norm) {
  const startsWord = (name, q) => {
    for (let i = name.indexOf(q, 1); i > 0; i = name.indexOf(q, i + 1)) if (' -./'.includes(name[i - 1])) return true;
    return false;
  };
  const score = (v, mmsi, q) => {
    q = norm(q);
    if (!q) return 0;
    v = v || {};
    const id = String(mmsi ?? ''), imo = v.imo ? String(v.imo) : '';
    if (id === q || imo === q) return 100;
    const name = norm(v.name), call = norm(v.callSign);
    if (name === q) return 90;
    if (call === q) return 80;
    if (name.startsWith(q)) return 70;
    if (id.startsWith(q) || (imo && imo.startsWith(q))) return 60;
    if (startsWord(name, q)) return 50;
    if (call && call.startsWith(q)) return 40;
    if (name.includes(q)) return 30;
    return 0;
  };
  const q = norm(text), hits = [];
  for (const it of items) { const s = score(it.v, it.mmsi, q); if (s > 0) hits.push({ score: s, ts: it.ts, mmsi: it.mmsi }); }
  return hits.sort(AL.compareSearch).slice(0, 25).map(h => h.mmsi);
}
// Come il ciclo di search() in server.js: nome e nominativo già normalizzati, MMSI e IMO in stringa solo per q di cifre
function newSearch(items, text) {
  const q = AL.normQuery(text), digits = /^\d+$/.test(q), top = [];
  if (!q) return top;
  for (const it of items) {
    const v = it.v || {};
    const s = AL.scoreFields(AL.norm(v.name), AL.norm(v.callSign), digits ? String(it.mmsi) : '', digits && v.imo ? String(v.imo) : '', q);
    if (s) AL.insertTop(top, { score: s, ts: it.ts, mmsi: it.mmsi }, 25);
  }
  return top.map(h => h.mmsi);
}
function randomItems(seed, n, alphabet) {
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = s => s[Math.floor(rnd() * s.length)];
  const word = () => Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(alphabet)).join('');
  const items = [], seen = new Set();
  for (let i = 0; i < n; i++) {
    const mmsi = 200000000 + Math.floor(rnd() * 600000000);
    if (seen.has(mmsi)) continue;   // MMSI distinti, come nel server: a parità di tutto l'ordine è deciso dall'MMSI
    seen.add(mmsi);
    const name = rnd() < 0.05 ? '' : Array.from({ length: 1 + Math.floor(rnd() * 3) }, word).join(rnd() < 0.8 ? ' ' : pick(' -./'));
    items.push({ mmsi, ts: rnd() < 0.05 ? null : 1e12 + Math.floor(rnd() * 50) * 1000,
      v: { name, callSign: rnd() < 0.3 ? null : word() + word(), imo: rnd() < 0.5 ? null : 9000000 + Math.floor(rnd() * 999999) } });
  }
  return { items, rnd, word };
}

test('ricerca nuova = implementazione precedente (stessi risultati, stesso ordine) su dati casuali', () => {
  for (const seed of [1, 7, 42, 2024]) {
    // con lettere, cifre, accenti e separatori: confronto con la norm nuova
    const { items, word } = randomItems(seed, 3000, ['A', 'B', 'AN', 'NA', 'MAR', 'IA', '1', '2', '20', 'À', 'É', 'ò', 'x']);
    const queries = ['A', 'AN', 'NA', 'MARIA', 'ANNA MARIA', 'A B', '20', '2', '200', '9000', '90012', 'a-b', 'XYZ', 'À', 'citta'];
    for (let i = 0; i < 40; i++) queries.push(word(), items[i].v.name, String(items[i].mmsi).slice(0, 4 + (i % 6)), items[i].v.callSign || 'Q');
    for (const q of queries) assert.deepEqual(newSearch(items, q), oldSearch(items, AL.normQuery(q), AL.norm), `seed ${seed}, q «${q}»`);
  }
  // solo maiuscole, cifre e spazi, query senza «IMO »: uguale anche alla norm di prima
  const { items, word } = randomItems(99, 3000, ['A', 'B', 'AN', 'NA', 'MAR', 'IA', '1', '2', '20']);
  for (const it of items) it.v.name = it.v.name.replace(/[-./]/g, ' ');
  for (let i = 0; i < 80; i++) {
    const q = i % 2 ? word() : String(items[i].mmsi).slice(0, 3 + (i % 7));
    assert.deepEqual(newSearch(items, q), oldSearch(items, q, oldNorm), `q «${q}»`);
  }
});
