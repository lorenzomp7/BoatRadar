// Punto 9 (a): test unitari dei filtri di public/ais-logic.js (NAV_GROUPS, navGroup, parseFilter, filterKey,
// passesFilter, filterCount). Gli stessi filtri valgono in /api/locations (test/filtri.test.js) e nella pagina.
// Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');

const MIN = 60000;
// filtro con tutti i campi, null = nessun vincolo
const F = extra => ({ types: null, status: null, minSog: null, maxSog: null, seen: null, moving: null, ...extra });
// query come da URLSearchParams di una chiave
const fromKey = key => Object.fromEntries(new URLSearchParams(key));

test('NAV_GROUPS: chiavi, etichette e codici; ogni codice 0-8 in un solo gruppo, \'other\' per ultimo', () => {
  assert.deepEqual(AL.NAV_GROUPS.map(g => g.key), ['underway', 'anchor', 'moored', 'fishing', 'limited', 'other']);
  for (const g of AL.NAV_GROUPS) assert.ok(typeof g.label === 'string' && g.label.length > 0, g.key);
  const codes = AL.NAV_GROUPS.flatMap(g => g.codes).sort((a, b) => a - b);
  assert.deepEqual(codes, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(AL.NAV_GROUPS.at(-1).codes, []);
});

test('navGroup: codici AIS dello stato di navigazione', () => {
  assert.equal(AL.navGroup(0), 'underway');
  assert.equal(AL.navGroup(8), 'underway', 'a vela');
  assert.equal(AL.navGroup(1), 'anchor');
  assert.equal(AL.navGroup(5), 'moored');
  assert.equal(AL.navGroup(7), 'fishing');
  for (const c of [2, 3, 4, 6]) assert.equal(AL.navGroup(c), 'limited', String(c));
  for (const c of [9, 14, 15, undefined, null, 1.5, '5', NaN, -1]) assert.equal(AL.navGroup(c), 'other', String(c));
});

test('parseFilter: niente o tutto ciò che non è valido → null, mai eccezioni', () => {
  assert.equal(AL.parseFilter({}), null);
  assert.equal(AL.parseFilter(), null);
  assert.equal(AL.parseFilter(null), null);
  assert.equal(AL.parseFilter('types=cargo'), null, 'non un oggetto di parametri');
  assert.equal(AL.parseFilter({ types: '', status: '', minSog: '', maxSog: '', seen: '', moving: '' }), null);
  assert.equal(AL.parseFilter({ types: 'x,,' }), null, 'solo chiavi sconosciute');
  assert.equal(AL.parseFilter({ types: AL.TYPES.map(t => t.key).join(',') }), null, 'tutti i tipi = nessun filtro');
  assert.equal(AL.parseFilter({ status: AL.NAV_GROUPS.map(g => g.key).reverse().join(',') }), null, 'tutti gli stati');
  assert.equal(AL.parseFilter({ minSog: '5', maxSog: '2' }), null, 'minimo oltre il massimo: tutti e due ignorati');
  assert.equal(AL.parseFilter({ minSog: 'abc' }), null);
  assert.equal(AL.parseFilter({ minSog: '0' }), null, 'minimo 0 = nessun minimo');
  for (const s of ['0', '-3', '1e9', '1441', 'abc', '0.001']) assert.equal(AL.parseFilter({ seen: s }), null, `seen=${s}`);
  for (const m of ['si', 'true', '2', ' ', '01']) assert.equal(AL.parseFilter({ moving: m }), null, `moving=${m}`);
  for (const x of ['NaN', '1e999', '-Infinity', 'Infinity', '\0', '-1', '102.3', '103', '5kn'])
    assert.equal(AL.parseFilter({ minSog: x, maxSog: x }), null, `velocità ${JSON.stringify(x)}`);
  assert.equal(AL.parseFilter({ types: { toString() { throw new Error('no'); } } }), null, 'valore che non diventa testo');
  assert.equal(AL.parseFilter({ types: 'cargo\0' }), null, 'carattere nullo: chiave sconosciuta');
});

test('parseFilter: tipi e stati validi nell\'ordine di TYPES e NAV_GROUPS, senza doppioni, spazi ignorati', () => {
  assert.deepEqual(AL.parseFilter({ types: 'tanker,cargo' }), F({ types: ['cargo', 'tanker'] }));
  assert.deepEqual(AL.parseFilter({ types: ' tanker , x,cargo,tanker,' }), F({ types: ['cargo', 'tanker'] }));
  assert.deepEqual(AL.parseFilter({ status: 'other,moored,anchor' }), F({ status: ['anchor', 'moored', 'other'] }));
  assert.deepEqual(AL.parseFilter({ types: 'other' }), F({ types: ['other'] }));
});

test('parseFilter: velocità arrotondata a 0,1 kn fra 0 e 102,2; ricezione in minuti a 0,01; movimento 1/0', () => {
  assert.deepEqual(AL.parseFilter({ minSog: '5.04', maxSog: '20' }), F({ minSog: 5, maxSog: 20 }));
  assert.deepEqual(AL.parseFilter({ minSog: '0.05' }), F({ minSog: 0.1 }));
  assert.deepEqual(AL.parseFilter({ maxSog: '0' }), F({ maxSog: 0 }), 'massimo 0 = solo navi ferme a 0 kn');
  assert.deepEqual(AL.parseFilter({ maxSog: '-0.04' }), F({ maxSog: 0 }), '-0 diventa 0');
  assert.deepEqual(AL.parseFilter({ maxSog: '102.2' }), F({ maxSog: 102.2 }));
  assert.deepEqual(AL.parseFilter({ minSog: '3', maxSog: '3' }), F({ minSog: 3, maxSog: 3 }), 'minimo = massimo va bene');
  assert.deepEqual(AL.parseFilter({ minSog: '7', maxSog: 'abc' }), F({ minSog: 7 }), 'massimo non valido: resta il minimo');
  assert.deepEqual(AL.parseFilter({ seen: '15' }), F({ seen: 15 }));
  assert.deepEqual(AL.parseFilter({ seen: '0.014' }), F({ seen: 0.01 }));
  assert.deepEqual(AL.parseFilter({ seen: '1440' }), F({ seen: 1440 }));
  assert.deepEqual(AL.parseFilter({ moving: '1' }), F({ moving: true }));
  assert.deepEqual(AL.parseFilter({ moving: '0' }), F({ moving: false }));
  assert.deepEqual(AL.parseFilter({ minSog: 5, seen: 15 }), F({ minSog: 5, seen: 15 }), 'anche numeri, non solo testo');
});

test('filterKey: solo i campi presenti, in ordine fisso; \'\' senza filtro; andata e ritorno con parseFilter', () => {
  assert.equal(AL.filterKey(null), '');
  assert.equal(AL.filterKey(undefined), '');
  const f = AL.parseFilter({ moving: '1', seen: '15', maxSog: '20', minSog: '5', status: 'moored', types: 'tanker,cargo' });
  const key = AL.filterKey(f);
  assert.equal(key, 'types=cargo,tanker&status=moored&minSog=5&maxSog=20&seen=15&moving=1');
  assert.deepEqual(AL.parseFilter(fromKey(key)), f);
  assert.equal(AL.filterKey(AL.parseFilter({ moving: '0' })), 'moving=0');
  assert.equal(AL.filterKey(AL.parseFilter({ seen: '0.5', minSog: '0.3' })), 'minSog=0.3&seen=0.5');
  // varianti equivalenti → stessa chiave (la usa la cache del server)
  for (const q of [{ types: 'cargo,tanker' }, { types: 'tanker,cargo,cargo' }, { types: 'cargo, tanker,boh' }])
    assert.equal(AL.filterKey(AL.parseFilter(q)), 'types=cargo,tanker', JSON.stringify(q));
  // andata e ritorno per molti filtri
  const cases = [{ types: 'fishing' }, { status: 'limited,other' }, { maxSog: '0' }, { minSog: '102.2' }, { seen: '1440' },
    { seen: '0.01', moving: '0' }, { types: 'pleasure,service', status: 'underway', minSog: '0.5', maxSog: '30.25' }];
  for (const q of cases) {
    const g = AL.parseFilter(q);
    assert.ok(g, JSON.stringify(q));
    assert.deepEqual(AL.parseFilter(fromKey(AL.filterKey(g))), g, JSON.stringify(q));
    assert.equal(AL.filterKey(AL.parseFilter(fromKey(AL.filterKey(g)))), AL.filterKey(g));
  }
});

test('filterCount: quanti criteri sono attivi (la velocità da/a conta una volta)', () => {
  assert.equal(AL.filterCount(null), 0);
  assert.equal(AL.filterCount(AL.parseFilter({ types: 'cargo' })), 1);
  assert.equal(AL.filterCount(AL.parseFilter({ minSog: '5', maxSog: '20' })), 1);
  assert.equal(AL.filterCount(AL.parseFilter({ maxSog: '20' })), 1);
  assert.equal(AL.filterCount(AL.parseFilter({ types: 'cargo', status: 'moored', minSog: '1', seen: '5', moving: '0' })), 5);
});

test('passesFilter: tipo e stato di navigazione', () => {
  const now = 1e12, p = { sog: 10, navStat: 0, ts: now };
  const tanker = AL.parseFilter({ types: 'tanker' });
  assert.equal(AL.passesFilter(p, { shipType: 80 }, tanker, now), true, 'petroliera sì');
  assert.equal(AL.passesFilter(p, { shipType: 70 }, tanker, now), false, 'cargo no');
  const other = AL.parseFilter({ types: 'other' });
  assert.equal(AL.passesFilter(p, undefined, other, now), true, 'senza dati statici = altro / sconosciuto');
  assert.equal(AL.passesFilter(p, {}, tanker, now), false);
  const moored = AL.parseFilter({ status: 'moored' });
  assert.equal(AL.passesFilter({ ...p, navStat: 5 }, {}, moored, now), true);
  assert.equal(AL.passesFilter(p, {}, moored, now), false);
  const otherStatus = AL.parseFilter({ status: 'other' });
  assert.equal(AL.passesFilter({ sog: 6, ts: now }, { shipType: 37 }, otherStatus, now), true, 'classe B (senza stato) → altro');
  assert.equal(AL.passesFilter({ ...p, navStat: 15 }, {}, otherStatus, now), true);
  assert.equal(AL.passesFilter(p, { shipType: 70 }, null, now), true, 'senza filtro passa tutto');
});

test('passesFilter: velocità (sconosciuta non passa minimo né massimo), ricezione recente, movimento', () => {
  const now = 1e12;
  const at = (sog, extra) => ({ sog, navStat: 0, ts: now, ...extra });
  const min = AL.parseFilter({ minSog: '0.5' }), max = AL.parseFilter({ maxSog: '10' });
  assert.equal(AL.passesFilter(at(102.3), {}, min, now), false, '102,3 = non disponibile');
  assert.equal(AL.passesFilter(at(102.3), {}, max, now), false);
  assert.equal(AL.passesFilter(at(undefined), {}, max, now), false, 'velocità mancante');
  assert.equal(AL.passesFilter(at(0.5), {}, min, now), true, 'al minimo esatto');
  assert.equal(AL.passesFilter(at(0.4), {}, min, now), false);
  assert.equal(AL.passesFilter(at(10), {}, max, now), true, 'al massimo esatto');
  assert.equal(AL.passesFilter(at(10.1), {}, max, now), false);

  const seen = AL.parseFilter({ seen: '15' });
  assert.equal(AL.passesFilter(at(5, { ts: now - 20 * MIN }), {}, seen, now), false, 'età 20 min con seen 15');
  assert.equal(AL.passesFilter(at(5, { ts: now - 15 * MIN }), {}, seen, now), true, 'età uguale al limite');
  assert.equal(AL.passesFilter(at(5, { ts: now - 14 * MIN }), {}, seen, now), true);
  assert.equal(AL.passesFilter(at(5, { ts: undefined }), {}, seen, now), false, 'ora mancante');
  assert.equal(AL.passesFilter(at(5, { ts: NaN }), {}, seen, now), false);
  assert.equal(AL.passesFilter(at(5, { ts: new Date(now - MIN).toISOString() }), {}, seen, now), true, 'ora ISO (toMs)');
  assert.equal(AL.passesFilter(at(5), {}, seen, NaN), false, 'now non valido');

  const still = AL.parseFilter({ moving: '0' }), moving = AL.parseFilter({ moving: '1' });
  assert.equal(AL.passesFilter({ sog: 0, navStat: 5, ts: now }, {}, still, now), true, 'ormeggiata a 0 kn = ferma');
  assert.equal(AL.passesFilter({ sog: 0, navStat: 5, ts: now }, {}, moving, now), false);
  assert.equal(AL.passesFilter({ sog: 8, navStat: 1, ts: now }, {}, moving, now), true, 'all\'ancora a 8 kn = in moto (isStill)');
  assert.equal(AL.passesFilter({ ts: now }, {}, moving, now), true, 'senza dati = in moto, come il punto 8');
  for (const p of [{ sog: 0 }, { sog: 3, navStat: 0 }, { navStat: 1 }, { sog: 102.3, navStat: 6 }, {}])
    assert.notEqual(AL.passesFilter({ ...p, ts: now }, {}, still, now), AL.passesFilter({ ...p, ts: now }, {}, moving, now),
      'in moto e ferme si dividono tutte le navi: ' + JSON.stringify(p));
});

test('passesFilter: combinazione = tutti i criteri insieme', () => {
  const now = 1e12;
  const f = AL.parseFilter({ types: 'cargo,fishing', status: 'underway,fishing', minSog: '2', maxSog: '15', seen: '5', moving: '1' });
  const ok = { sog: 12, navStat: 0, ts: now - MIN };
  assert.equal(AL.passesFilter(ok, { shipType: 70 }, f, now), true);
  assert.equal(AL.passesFilter({ ...ok, navStat: 7, sog: 3 }, { shipType: 30 }, f, now), true);
  assert.equal(AL.passesFilter(ok, { shipType: 80 }, f, now), false, 'tipo');
  assert.equal(AL.passesFilter({ ...ok, navStat: 1 }, { shipType: 70 }, f, now), false, 'stato');
  assert.equal(AL.passesFilter({ ...ok, sog: 16 }, { shipType: 70 }, f, now), false, 'velocità');
  assert.equal(AL.passesFilter({ ...ok, ts: now - 6 * MIN }, { shipType: 70 }, f, now), false, 'ricezione');
});
