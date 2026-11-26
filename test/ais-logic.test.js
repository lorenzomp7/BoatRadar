// Test unitari di public/ais-logic.js: le funzioni pure usate dalla pagina (e, più avanti, dal server).
// Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AL = require('../public/ais-logic');

const ROOT = path.join(__dirname, '..');

test('typeOf: categorie dai codici AIS', () => {
  assert.equal(AL.typeOf(70).key, 'cargo');
  assert.equal(AL.typeOf(89).key, 'tanker');
  assert.equal(AL.typeOf(60).key, 'passenger');
  assert.equal(AL.typeOf(30).key, 'fishing');
  assert.equal(AL.typeOf(36).key, 'pleasure');
  assert.equal(AL.typeOf(37).key, 'pleasure');
  assert.equal(AL.typeOf(31).key, 'service');
  assert.equal(AL.typeOf(55).key, 'service');
  assert.equal(AL.typeOf(undefined).key, 'other');
  assert.equal(AL.typeOf(null).key, 'other');
  assert.equal(AL.typeOf(99).key, 'other');
  for (const t of AL.TYPES) assert.match(t.color, /^#[0-9a-f]{6}$/i, t.key);
});

test('typeName: nome preciso o null', () => {
  assert.equal(AL.typeName(52), 'Rimorchiatore');
  assert.equal(AL.typeName(45), 'Unità veloce');
  assert.equal(AL.typeName(36), 'Barca a vela');
  assert.equal(AL.typeName(75), 'Nave cargo');
  assert.equal(AL.typeName(99), null);
  assert.equal(AL.typeName(undefined), null);
});

test('heading: rotta solo per navi in movimento (comportamento attuale)', () => {
  assert.equal(AL.heading({ sog: 10, cog: 90 }), 90);
  assert.equal(AL.heading({ sog: 0.3, cog: 90 }), null);
  assert.equal(AL.heading({ sog: 102.3, cog: 90 }), null);
  assert.equal(AL.heading({ sog: 10, cog: 360 }), null);
  assert.equal(AL.heading({ sog: 10 }), null);
});

test('decodeEta: codifica Digitraffic (mese<<16 | giorno<<11 | ora<<6 | minuto)', () => {
  assert.deepEqual(AL.decodeEta((11 << 16) | (23 << 11) | (14 << 6) | 30), { month: 11, day: 23, hour: 14, minute: 30 });
  assert.deepEqual(AL.decodeEta(768926), { month: 11, day: 23, hour: 14, minute: 30 });
  assert.deepEqual(AL.decodeEta(77372), { month: 1, day: 5, hour: null, minute: null }, 'ora 24 e minuto 60 = n.d.');
  assert.equal(AL.decodeEta((0 << 16) | (5 << 11)), null, 'mese 0 = n.d.');
  assert.equal(AL.decodeEta((13 << 16) | (5 << 11)), null, 'mese 13 non valido');
  assert.equal(AL.decodeEta(3 << 16), null, 'giorno 0 = n.d.');
  assert.equal(AL.decodeEta(undefined), null);
  assert.equal(AL.decodeEta(null), null);
});

test('matchesQuery: nome, inizio MMSI o IMO (q già in maiuscolo)', () => {
  assert.equal(AL.matchesQuery({ name: 'Laguna' }, 247000001, 'LAG'), true);
  assert.equal(AL.matchesQuery({ name: 'Laguna' }, 247000001, 'GUN'), true, 'il nome può contenere q in mezzo');
  assert.equal(AL.matchesQuery({}, 247000001, '2470'), true);
  assert.equal(AL.matchesQuery({}, 247000001, '0001'), false, 'l\'MMSI deve iniziare con q');
  assert.equal(AL.matchesQuery({ imo: 9074729 }, 1, '9074'), true);
  assert.equal(AL.matchesQuery({ name: 'Laguna', imo: 9074729 }, 247000001, 'XYZ'), false);
  assert.equal(AL.matchesQuery(undefined, 247000001, '247'), true, 'senza dati statici conta solo l\'MMSI');
});

test('il modulo non crea variabili globali oltre AisLogic', () => {
  const vm = require('node:vm');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'ais-logic.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['AisLogic']);
  assert.equal(typeof ctx.AisLogic.typeOf, 'function');
});

// pages.yml con le virgolette del comando shell (\") lette come virgolette semplici
const readPagesYml = () => fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8').replace(/\\"/g, '"');

test('ogni script locale della pagina è pubblicato su Pages e copiato nell\'immagine Docker', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  // la querystring (?v=…, aggiunta da pages.yml) non fa parte del percorso del file
  const local = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1].split('?')[0])
    .filter(src => !/^https?:/.test(src) && src !== 'config.js');
  assert.ok(local.includes('public/ais-logic.js'), 'la pagina carica public/ais-logic.js');
  const copied = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').split('\n')
    .filter(l => /^\s*COPY\s/i.test(l)).flatMap(l => l.trim().split(/\s+/).slice(1, -1));
  const pages = readPagesYml();
  const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const src of local) {
    assert.ok(copied.includes(src), `${src} manca in una riga COPY del Dockerfile`);
    // cartella di arrivo: _site/ + la cartella del file (public/ais-logic.js → _site/public/)
    const dir = path.posix.dirname(src) === '.' ? '_site/' : `_site/${path.posix.dirname(src)}/`;
    assert.match(pages, new RegExp(`cp ${re(src)} ${re(dir)}(${re(path.posix.basename(src))})?(\\s|$)`, 'm'),
      `${src} non è copiato in ${dir} da pages.yml`);
    // versione nello script di index.html, così pagina e modulo non restano disallineati nella cache
    assert.ok(pages.includes(`src="${src}?v=\${GITHUB_SHA}"`), `${src} senza ?v=\${GITHUB_SHA} in pages.yml`);
  }
  // la pagina lo carica prima del proprio script, che usa AisLogic subito
  const at = html.search(/src="public\/ais-logic\.js(\?[^"]*)?"/);
  assert.ok(at >= 0 && at < html.indexOf('= AisLogic'), 'ais-logic.js caricato prima dell\'uso');
});

test('pages.yml aggiunge ?v=${GITHUB_SHA} allo script copiato e si ferma se non lo trova', () => {
  const pages = readPagesYml();
  assert.match(pages, /sed -i [^\n]*src="public\/ais-logic\.js"[^\n]*src="public\/ais-logic\.js\?v=\$\{GITHUB_SHA\}"[^\n]*_site\/index\.html/);
  assert.match(pages, /grep -q[^\n]*ais-logic\.js\?v=\$\{GITHUB_SHA\}[^\n]*_site\/index\.html/, 'controllo che la sostituzione sia avvenuta');
});

test('boatradar.html: senza AisLogic la riga di stato spiega il problema invece di un ReferenceError', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  const code = html.split('<script src="public/ais-logic.js"></script>')[1].match(/<script>([\s\S]*?)<\/script>/)[1];
  const status = { textContent: 'Caricamento…' };
  const document = { getElementById: id => (id === 'status' ? status : null) };
  const ctx = vm.createContext({ document, console: { warn() {}, error() {} } });
  ctx.window = ctx;
  assert.throws(() => vm.runInContext(code, ctx), err => err.name === 'Error' && /ais-logic\.js/.test(err.message));
  assert.match(status.textContent, /ais-logic\.js/);
  assert.match(status.textContent, /ricarica/i);
});

// --- Punto 6: unione Baltico (Digitraffic) e mondo (aisstream) -------------------------------------
const feat = (mmsi, t, coords, extra = {}) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: coords },
  properties: { mmsi, ...(t != null && { timestampExternal: t }), ...extra } });

test('mergeFeatures: per lo stesso MMSI vince la posizione più recente, in qualunque ordine', () => {
  const d = feat(247000001, 1000, [10, 60]), a = feat(247000001, 2000, [11, 60]);
  for (const groups of [
    [{ source: 'digitraffic', features: [d] }, { source: 'aisstream', features: [a] }],
    [{ source: 'aisstream', features: [a] }, { source: 'digitraffic', features: [d] }],
  ]) {
    const m = AL.mergeFeatures(groups);
    assert.equal(m.size, 1);
    assert.deepEqual(m.get(247000001).geometry.coordinates, [11, 60]);
    assert.equal(m.get(247000001).properties.source, 'aisstream');
  }
  const m = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(1, 3000, [10, 60])] },
    { source: 'aisstream', features: [feat(1, 2000, [11, 60])] }]);
  assert.equal(m.get(1).properties.source, 'digitraffic', 'orari invertiti: vince Digitraffic');
  assert.deepEqual(m.get(1).geometry.coordinates, [10, 60]);
});

test('mergeFeatures: MMSI diversi, MMSI nelle properties, parità e orario mancante', () => {
  const two = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(1, 1000, [10, 60])] },
    { source: 'aisstream', features: [feat(2, 1000, [11, 60])] }]);
  assert.equal(two.size, 2);
  assert.deepEqual([...two.keys()].sort(), [1, 2]);

  const { mmsi, ...noTop } = feat(5, 1000, [10, 60]); void mmsi;
  assert.equal(AL.mergeFeatures([{ source: 'digitraffic', features: [noTop] }]).get(5).properties.source, 'digitraffic',
    'MMSI preso da properties.mmsi');

  const tie = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(3, 1000, [10, 60])] },
    { source: 'aisstream', features: [feat(3, 1000, [11, 60])] }]);
  assert.equal(tie.get(3).properties.source, 'digitraffic', 'a parità resta il primo gruppo');

  for (const groups of [
    [{ source: 'digitraffic', features: [feat(4, null, [10, 60])] }, { source: 'aisstream', features: [feat(4, 1, [11, 60])] }],
    [{ source: 'aisstream', features: [feat(4, 1, [11, 60])] }, { source: 'digitraffic', features: [feat(4, null, [10, 60])] }],
  ]) assert.equal(AL.mergeFeatures(groups).get(4).properties.source, 'aisstream', 'senza orario perde');
});

test('mergeFeatures: non modifica gli originali e accetta gruppi vuoti', () => {
  const f = feat(1, 1000, [10, 60]);
  const m = AL.mergeFeatures([{ source: 'digitraffic', features: undefined }, { source: 'aisstream', features: [f] }]);
  assert.equal(m.get(1).properties.source, 'aisstream');
  assert.equal('source' in f.properties, false, 'l\'originale resta senza source');
  assert.notEqual(m.get(1), f);
  assert.equal(AL.mergeFeatures([]).size, 0);
  assert.equal(AL.mergeFeatures([{ source: 'aisstream', features: [{ properties: {} }] }]).size, 0, 'senza MMSI scartata');
});

test('SOURCE_LABEL: testo della riga «Fonte» per ogni fonte', () => {
  assert.equal(AL.SOURCE_LABEL.digitraffic, 'Digitraffic (Fintraffic, Baltico)');
  assert.equal(AL.SOURCE_LABEL.aisstream, 'aisstream.io');
});

test('mergeFeatures: MMSI normalizzato a numero, scartati non interi e ≤ 0, feature null ignorate', () => {
  const g = features => AL.mergeFeatures([{ source: 'aisstream', features }]);
  const m = g([null, { ...feat(247000001, 1000, [10, 60]), mmsi: '247000001' }, undefined]);
  assert.deepEqual([...m.keys()], [247000001], 'stringa numerica → numero');
  for (const bad of ['', 'abc', NaN, 0, -1, 1.5, '0', Infinity, null, undefined])
    assert.equal(g([{ type: 'Feature', mmsi: bad, geometry: { type: 'Point', coordinates: [10, 60] }, properties: { mmsi: bad } }]).size, 0,
      `MMSI ${String(bad)} scartato`);
  // stessa nave con MMSI numero in una fonte e stringa nell'altra: una sola voce
  const both = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(5, 1000, [10, 60])] },
    { source: 'aisstream', features: [{ ...feat(5, 2000, [11, 60]), mmsi: '5' }] }]);
  assert.equal(both.size, 1);
  assert.equal(both.get(5).properties.source, 'aisstream');
});

test('toMs: numeri, stringhe numeriche, ISO; il resto è -Infinity', () => {
  assert.equal(AL.toMs(1000), 1000);
  assert.equal(AL.toMs(0), 0);
  assert.equal(AL.toMs('1000'), 1000);
  assert.equal(AL.toMs(' 1500 '), 1500);
  assert.equal(AL.toMs('2026-11-26T08:00:00Z'), Date.parse('2026-11-26T08:00:00Z'));
  for (const bad of [undefined, null, '', '  ', 'ieri', NaN, Infinity, -Infinity, {}, [], true])
    assert.equal(AL.toMs(bad), -Infinity, `toMs(${String(bad)})`);
});

test('mergeFeatures: orari come stringa numerica o ISO confrontati come millisecondi', () => {
  const iso = '2026-11-26T08:00:00Z', ms = Date.parse(iso);
  const m = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(1, ms + 1, [10, 60])] },
    { source: 'aisstream', features: [feat(1, iso, [11, 60])] }]);
  assert.equal(m.get(1).properties.source, 'digitraffic', 'numero più recente della stringa ISO');
  const n = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(2, '1000', [10, 60])] },
    { source: 'aisstream', features: [feat(2, 999, [11, 60])] }]);
  assert.equal(n.get(2).properties.source, 'digitraffic', '"1000" > 999');
  const bad = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(3, 'ieri', [10, 60])] },
    { source: 'aisstream', features: [feat(3, 1, [11, 60])] }]);
  assert.equal(bad.get(3).properties.source, 'aisstream', 'orario illeggibile = il più vecchio');
});

test('mergeFeatures: nome e tipo della perdente restano se la vincente non li ha', () => {
  assert.deepEqual(AL.STATIC_FIELDS, ['name', 'shipType']);
  const d = feat(1, 3000, [10, 60]);                                       // Digitraffic: senza nome né tipo
  const a = feat(1, 2000, [11, 60], { name: 'LAGUNA', shipType: 70 });      // aisstream: più vecchia
  for (const groups of [
    [{ source: 'digitraffic', features: [d] }, { source: 'aisstream', features: [a] }],
    [{ source: 'aisstream', features: [a] }, { source: 'digitraffic', features: [d] }],
  ]) {
    const p = AL.mergeFeatures(groups).get(1).properties;
    assert.equal(p.source, 'digitraffic');
    assert.deepEqual([p.name, p.shipType, p.timestampExternal], ['LAGUNA', 70, 3000]);
  }
  assert.equal('name' in d.properties, false, 'originale intatto');
  // i campi della vincente non vengono sovrascritti; nome vuoto o tipo null = mancanti
  const own = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(2, 3000, [10, 60], { name: 'NUOVO', shipType: null })] },
    { source: 'aisstream', features: [feat(2, 2000, [11, 60], { name: 'VECCHIO', shipType: 80 })] }]).get(2).properties;
  assert.deepEqual([own.name, own.shipType], ['NUOVO', 80]);
  const empty = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(3, 3000, [10, 60], { name: '' })] },
    { source: 'aisstream', features: [feat(3, 2000, [11, 60], { name: 'LAGUNA' })] }]).get(3).properties;
  assert.equal(empty.name, 'LAGUNA');
  // tipo 0 è un valore AIS («non disponibile») trasmesso dalla nave: resta quello della vincente
  const zero = AL.mergeFeatures([{ source: 'digitraffic', features: [feat(4, 3000, [10, 60], { shipType: 0 })] },
    { source: 'aisstream', features: [feat(4, 2000, [11, 60], { shipType: 70 })] }]).get(4).properties;
  assert.equal(zero.shipType, 0);
});

test('isNewer: confronta gli orari come toMs (usato dalla pagina per non far tornare indietro i marker)', () => {
  assert.equal(AL.isNewer(2000, 1000), true);
  assert.equal(AL.isNewer(1000, 2000), false);
  assert.equal(AL.isNewer(1000, 1000), false, 'a parità non è più recente');
  assert.equal(AL.isNewer('2026-11-26T08:00:01Z', Date.parse('2026-11-26T08:00:00Z')), true);
  assert.equal(AL.isNewer(1, undefined), true, 'qualsiasi orario è più recente di nessuno');
  assert.equal(AL.isNewer(undefined, 1), false);
  assert.equal(AL.isNewer(undefined, undefined), false);
});

test('mergeFeatures: duplicati nello stesso gruppo, vince il più recente; a parità il primo', () => {
  const m = AL.mergeFeatures([{ source: 'aisstream', features: [feat(1, 1000, [10, 60]), feat(1, 3000, [11, 60]), feat(1, 2000, [12, 60])] }]);
  assert.deepEqual(m.get(1).geometry.coordinates, [11, 60]);
  const tie = AL.mergeFeatures([{ source: 'aisstream', features: [feat(1, 1000, [10, 60]), feat(1, 1000, [11, 60])] }]);
  assert.deepEqual(tie.get(1).geometry.coordinates, [10, 60]);
});

test('mergeFeatures: properties null o assenti ma MMSI in cima → tenuta con properties.source', () => {
  for (const f of [{ type: 'Feature', mmsi: 7, geometry: { type: 'Point', coordinates: [10, 60] }, properties: null },
    { type: 'Feature', mmsi: 7, geometry: { type: 'Point', coordinates: [10, 60] } }]) {
    const got = AL.mergeFeatures([{ source: 'digitraffic', features: [f] }]).get(7);
    assert.deepEqual(got.properties, { source: 'digitraffic' });
    assert.deepEqual(got.geometry.coordinates, [10, 60]);
  }
});

test('typeOf e typeName per 0-99 come in test/fixtures/tipi-nave.json', () => {
  const { tipi } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tipi-nave.json'), 'utf8'));
  assert.deepEqual(tipi.map(r => r.code), Array.from({ length: 100 }, (_, i) => i));
  for (const { code, typeOf, typeName } of tipi) {
    assert.equal(AL.typeOf(code).key, typeOf, `typeOf(${code})`);
    assert.equal(AL.typeName(code), typeName, `typeName(${code})`);
  }
});

// --- Punto 43: orologio del telefono corretto con l'ora del server ---------------------------------
test('clockSample: scarto = metà della richiesta − ora del server; rtt = durata', () => {
  assert.deepEqual(AL.clockSample(1000, 1200, 500), { offset: 600, rtt: 200 });
  assert.deepEqual(AL.clockSample(1000, 1000, 1000), { offset: 0, rtt: 0 });
  for (const bad of [undefined, null, NaN, Infinity, '500', {}]) assert.equal(AL.clockSample(1000, 1200, bad), null, String(bad));
  assert.equal(AL.clockSample(NaN, 1200, 500), null, 't0 non numerico');
  assert.equal(AL.clockSample(1200, 1000, 500), null, 'fine prima dell\'inizio (orologio spostato durante la richiesta)');
});

test('createClock: telefono avanti di 5 min → now() dà l\'ora vera; senza campioni scarto 0', () => {
  let real = Date.parse('2026-11-26T08:00:00Z');
  const phone = () => real + 300000;   // orologio del telefono avanti di 5 minuti
  const clock = AL.createClock({ now: phone });
  assert.equal(clock.offset(), 0, 'senza campioni nessuna correzione');
  assert.equal(clock.now(), phone());
  for (let i = 0; i < 3; i++) {
    const t0 = phone(); real += 40; const serverTime = real; real += 40;   // 80 ms di andata e ritorno
    clock.add(AL.clockSample(t0, phone(), serverTime));
  }
  assert.equal(clock.offset(), 300000);
  assert.ok(Math.abs(clock.now() - real) <= 1, `now() ${clock.now()} contro ora vera ${real}`);
  real += 60000;   // now() chiama l'orologio a ogni uso, non lo memorizza
  assert.ok(Math.abs(clock.now() - real) <= 1);
});

test('createClock: mediana degli ultimi 5 campioni, risposte lente e campioni null ignorati', () => {
  const sample = (offset, rtt = 100) => ({ offset, rtt });
  let c = AL.createClock({ now: () => 0 });
  for (const o of [300000, 300000, 310000]) c.add(sample(o));
  assert.equal(c.offset(), 300000, 'mediana, non media');
  c.add(sample(999999, 5000));   // risposta lenta (oltre maxRtt 2000 ms): non conta
  c.add(null);                   // risposta senza serverTime
  assert.equal(c.offset(), 300000);
  c = AL.createClock({ now: () => 0 });
  for (const o of [100, 200]) c.add(sample(o));
  assert.equal(c.offset(), 150, 'numero pari: media dei due centrali');
  c = AL.createClock({ now: () => 0 });
  for (const o of [1000, 1000, 1000, 0, 0, 0]) c.add(sample(o));
  assert.equal(c.offset(), 0, 'dopo 6 campioni contano solo gli ultimi 5 (1000, 1000, 0, 0, 0)');
  c = AL.createClock({ now: () => 0, keep: 2, maxRtt: 50 });
  for (const o of [5, 7, 9]) c.add(sample(o, 10));
  c.add(sample(1, 60));
  assert.equal(c.offset(), 8, 'keep e maxRtt configurabili');
  assert.equal(AL.createClock().now() <= Date.now(), true, 'senza opzioni usa Date.now');
});

test('createClock.now(): millisecondi interi anche con scarto frazionario (from= di Digitraffic è un intero)', () => {
  const c = AL.createClock({ now: () => 1000 });
  c.add(AL.clockSample(1000, 1001, 500));   // offset 500,5
  assert.equal(c.offset(), 500.5);
  assert.ok(Number.isInteger(c.now()), `now() ${c.now()}`);
  assert.equal(c.now(), 500);
});

test('createClock.add ignora campioni con rtt negativo o non finito (punto 7)', () => {
  const c = AL.createClock({ now: () => 0, maxRtt: Infinity });
  c.add({ offset: 100, rtt: 10 });
  for (const rtt of [-1, -Infinity, NaN, Infinity, undefined, null, '10']) c.add({ offset: 999999, rtt });
  assert.equal(c.offset(), 100, 'contano solo campioni con 0 ≤ rtt ≤ maxRtt finito');
  c.add({ offset: 200, rtt: 0 });
  assert.equal(c.offset(), 150, 'rtt 0 è valido');
});

// Il comportamento (from= del Baltico e ora nella riga di stato con l'ora vera) è in test/pagina-vm.test.js;
// qui resta solo la regola sul sorgente, che vale anche per codice nuovo non ancora coperto da quel test
test('boatradar.html: nessun new Date() senza argomenti; Date.now() solo per misurare /api/status', () => {
  const code = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8').split('<script src="public/ais-logic.js"></script>')[1];
  assert.doesNotMatch(code, /new Date\(\)/, 'nessun new Date() senza argomenti (ora del telefono)');
  const uses = [...code.matchAll(/Date\.now\(\)/g)].length;
  assert.equal(uses, 2, 'Date.now() solo per t0 e t1 della misura di /api/status');
});

// --- Punto 5: prua vera --------------------------------------------------------------------------------
test('validHeading: interi 0-359, il resto null', () => {
  for (const h of [0, 45, 359]) assert.equal(AL.validHeading(h), h);
  for (const h of [511, 496, 360, -1, 45.5, null, undefined, '45', NaN]) assert.equal(AL.validHeading(h), null, String(h));
});

test('heading: prua vera se c\'è, altrimenti la rotta solo per navi in movimento', () => {
  assert.equal(AL.heading({ heading: 45, sog: 0 }), 45, 'nave ferma con prua');
  assert.equal(AL.heading({ heading: 45, sog: 10, cog: 90 }), 45, 'la prua vince sulla rotta');
  assert.equal(AL.heading({ heading: 511, sog: 10, cog: 90 }), 90, 'prua n.d.: rotta');
  assert.equal(AL.heading({ heading: 511, sog: 0.3, cog: 90 }), null, 'prua n.d. e nave ferma: pallino');
  assert.equal(AL.heading({ heading: 0, sog: 0 }), 0, 'prua 0 (nord) è valida');
  assert.equal(AL.heading({ heading: 511, sog: 102.3, cog: 90 }), null, 'velocità n.d.');
});

test('symbol: freccia corta per le navi ferme con prua, normale in moto, pallino senza direzione', () => {
  assert.deepEqual(AL.symbol({ heading: 45, sog: 0 }), { heading: 45, short: true });
  assert.deepEqual(AL.symbol({ heading: 0, sog: 0.5 }), { heading: 0, short: true }, '0,5 kn conta come ferma');
  assert.deepEqual(AL.symbol({ heading: 45, sog: 102.3 }), { heading: 45, short: true }, 'velocità n.d.: non in moto');
  assert.deepEqual(AL.symbol({ heading: 45, sog: 10, cog: 90 }), { heading: 45, short: false });
  assert.deepEqual(AL.symbol({ heading: 511, sog: 10, cog: 90 }), { heading: 90, short: false });
  assert.deepEqual(AL.symbol({ heading: 511, sog: 0 }), { heading: null, short: false });
  assert.deepEqual(AL.symbol({}), { heading: null, short: false });
});

// --- Punto 3: nave selezionata sempre in mappa ---------------------------------------------------------
test('includeParam: MMSI interi > 0, senza doppioni, al massimo 50, nell\'ordine dato', () => {
  assert.equal(AL.includeParam([null]), '');
  assert.equal(AL.includeParam([]), '');
  assert.equal(AL.includeParam(undefined), '');
  assert.equal(AL.includeParam([1, 1, 2]), 'include=1,2');
  assert.equal(AL.includeParam([247000002, 247000001]), 'include=247000002,247000001', 'la prima (la selezionata) resta prima');
  assert.equal(AL.includeParam(['5', 1.5, -3, 0, undefined, NaN, Infinity]), '', 'scartati stringhe, non interi, ≤ 0');
  const many = Array.from({ length: 60 }, (_, i) => i + 1);
  assert.equal(AL.includeParam(many), 'include=' + many.slice(0, 50).join(','), 'al massimo 50');
});

test('includeParam: ingresso non array → stringa vuota (punto 7)', () => {
  for (const bad of ['247000001', 247000001, { 0: 1, length: 1 }, new Set([1]), null, true, () => [1]])
    assert.equal(AL.includeParam(bad), '', String(bad));
});

// Marcatura della pagina (il comportamento è in test/pagina-vm.test.js)
test('boatradar.html: legenda dei simboli (anche su telefono), separatore e nome della × (punto 6)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  for (const t of ['freccia = in moto', 'freccia corta = ferma o velocità non nota, prua nota', 'pallino = direzione non nota'])
    assert.ok(html.includes(t), t);
  assert.match(html, /<details id="legend"[^>]*>\s*<summary>Legenda<\/summary>\s*<div id="legend-types"><\/div>\s*(<!--[\s\S]*?-->\s*)?<div class="sym">/,
    'legenda apribile (anche da tastiera), simboli subito dopo i tipi');
  assert.match(html, /#legend-types \+ \.sym \{ border-top:/, 'separatore fra tipi e simboli');
  const mobile = html.slice(html.indexOf('@media (max-width: 640px)'));
  assert.doesNotMatch(mobile.slice(0, mobile.indexOf('</style>')), /#legend \{ display:none/, 'su telefono non è nascosta');
  assert.match(html, /<button id="close" aria-label="Chiudi la scheda"/, 'la × ha un nome per i lettori di schermo');
});

test('stopped: ferma solo con velocità nota fino a 0,5 kn', () => {
  for (const sog of [0, 0.3, 0.5]) assert.equal(AL.stopped({ sog }), true, String(sog));
  for (const sog of [0.6, 10, 102.3, 102.2, -1, null, undefined, NaN, '0']) assert.equal(AL.stopped({ sog }), false, String(sog));
  assert.equal(AL.stopped({}), false);
});

// --- Punto 8: età della posizione, sparizione graduale, conservazione più lunga per le navi ferme -------------
const MIN = 60 * 1000, H = 60 * MIN;

test('DEFAULT_LIMITS: 30 min per le navi in moto, 6 h per le ferme (punto 8)', () => {
  assert.deepEqual(AL.DEFAULT_LIMITS, { movingMs: 30 * MIN, stillMs: 6 * H });
  assert.ok(Object.isFrozen(AL.DEFAULT_LIMITS), 'non modificabile per sbaglio dalla pagina o dal server');
});

test('validSog: velocità nota fra 0 e 102,2 kn (102,3 = non disponibile)', () => {
  for (const s of [0, 0.5, 3, 102.2]) assert.equal(AL.validSog(s), true, String(s));
  for (const s of [102.3, 200, -0.1, NaN, Infinity, null, undefined, '0']) assert.equal(AL.validSog(s), false, String(s));
});

test('isStill: ferma con velocità ≤ 0,5 kn, oppure all\'ancora, ormeggiata o incagliata se non va ad almeno 3 kn (punto 8)', () => {
  assert.equal(AL.isStill({ navStat: 5, sog: 0 }), true, 'ormeggiata');
  assert.equal(AL.isStill({ navStat: 1, sog: 102.3 }), true, 'all\'ancora con velocità non disponibile');
  assert.equal(AL.isStill({ navStat: 1, sog: 8 }), false, 'all\'ancora ma a 8 kn: stato non aggiornato, è in moto');
  assert.equal(AL.isStill({ navStat: 0, sog: 0.2 }), true, 'in navigazione ma a 0,2 kn');
  assert.equal(AL.isStill({}), false, 'niente dati: non si sa, vale come in moto');
  assert.equal(AL.isStill({ navStat: 6, sog: 2.9 }), true, 'incagliata sotto 3 kn');
  assert.equal(AL.isStill({ navStat: 5, sog: 3 }), false, 'ormeggiata a 3 kn');
  assert.equal(AL.isStill({ navStat: 5 }), true, 'ormeggiata senza velocità');
  assert.equal(AL.isStill({ navStat: 0, sog: 0.6 }), false);
  assert.equal(AL.isStill({ navStat: 15, sog: 102.3 }), false, 'stato non definito e velocità n.d.');
});

test('retentionMs: quanto si conserva una posizione; le ferme mai meno delle navi in moto (punto 8)', () => {
  assert.equal(AL.retentionMs({ navStat: 5, sog: 0 }), 6 * H);
  assert.equal(AL.retentionMs({ navStat: 0, sog: 10 }), 30 * MIN);
  const limits = { movingMs: 300, stillMs: 1500 };
  assert.equal(AL.retentionMs({ navStat: 5, sog: 0 }, limits), 1500);
  assert.equal(AL.retentionMs({ sog: 12 }, limits), 300);
  assert.equal(AL.retentionMs({ sog: 0 }, { movingMs: 1000, stillMs: 10 }), 1000, 'stillMs più corto di movingMs: vale movingMs');
});

test('ageMs: età da timestamp e ora (mai negativa; orario mancante = infinita)', () => {
  assert.equal(AL.ageMs(1000, 4000), 3000);
  assert.equal(AL.ageMs(5000, 4000), 0, 'posizione «nel futuro» (orologi diversi): età 0');
  assert.equal(AL.ageMs('2026-11-26T08:00:00Z', Date.parse('2026-11-26T08:12:00Z')), 12 * MIN, 'ISO di Digitraffic');
  for (const ts of [undefined, null, 'abc', NaN]) assert.equal(AL.ageMs(ts, 4000), Infinity, String(ts));
  assert.equal(AL.ageMs(1000, NaN), Infinity);
});

test('fadeOpacity: piena fino a 2 min, poi lineare fino al 35 % a 30 min (come AIS-catcher, minimo alzato dopo il QA) (punto 8)', () => {
  assert.equal(AL.fadeOpacity(0), 1);
  assert.equal(AL.fadeOpacity(2 * MIN), 1);
  assert.ok(AL.fadeOpacity(2 * MIN + 1) < 1, '2 min + 1 ms');
  assert.ok(Math.abs(AL.fadeOpacity(16 * MIN) - 0.675) < 1e-9, String(AL.fadeOpacity(16 * MIN)));
  assert.ok(Math.abs(AL.fadeOpacity(30 * MIN) - 0.35) < 1e-9);
  assert.equal(AL.fadeOpacity(3 * H), 0.35);
  assert.equal(AL.fadeOpacity(Infinity), 0.35);
  assert.equal(AL.fadeOpacity(NaN), 0.35, 'età non valida: come la più vecchia');
  assert.equal(AL.fadeOpacity(-5), 1);
  assert.equal(AL.fadeOpacity(10, { fullMs: 0, endMs: 20, min: 0.5 }), 0.75, 'curva configurabile');
});

test('fadeOpacity: ingressi non numerici = la più vecchia (minimo), anche le stringhe numeriche', () => {
  for (const a of [undefined, null, 'abc', '960000', '', true, {}]) assert.equal(AL.fadeOpacity(a), 0.35, JSON.stringify(a));
  assert.equal(AL.fadeOpacity('abc', { min: 0.2 }), 0.2);
});

test('normLimits: limiti di /api/status se sono due numeri finiti > 0, altrimenti DEFAULT_LIMITS (punto 8)', () => {
  assert.deepEqual(AL.normLimits({ movingMs: 60000, stillMs: 120000 }), { movingMs: 60000, stillMs: 120000 });
  assert.deepEqual(AL.normLimits({ movingMs: 1.5, stillMs: 2, altro: 1 }), { movingMs: 1.5, stillMs: 2 }, 'solo i due campi');
  for (const l of [undefined, null, 'x', 5, {}, { movingMs: 60000 }, { movingMs: 0, stillMs: 1 }, { movingMs: -1, stillMs: 1 },
    { movingMs: '60000', stillMs: 120000 }, { movingMs: NaN, stillMs: 1 }, { movingMs: 1, stillMs: Infinity }, { movingMs: null, stillMs: 1 }])
    assert.equal(AL.normLimits(l), AL.DEFAULT_LIMITS, JSON.stringify(l));
});

test('ageStyle: opacità, tratteggio oltre il limite delle navi in moto, gone oltre la conservazione (punto 8)', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const at = ms => now - ms;
  const moored3h = AL.ageStyle({ navStat: 5, sog: 0, timestampExternal: at(3 * H) }, now);
  assert.deepEqual(moored3h, { age: 3 * H, opacity: 0.35, dashed: true, gone: false }, 'ormeggiata di 3 h fa: tratteggiata, resta');
  assert.equal(AL.ageStyle({ navStat: 0, sog: 12, timestampExternal: at(31 * MIN) }, now).gone, true, 'in moto di 31 min fa: sparisce');
  assert.equal(AL.ageStyle({ navStat: 5, sog: 0, timestampExternal: at(7 * H) }, now).gone, true, 'ormeggiata di 7 h fa: sparisce');
  assert.deepEqual(AL.ageStyle({ sog: 12, timestampExternal: at(MIN) }, now), { age: MIN, opacity: 1, dashed: false, gone: false });
  const edge = AL.ageStyle({ sog: 12, timestampExternal: at(30 * MIN) }, now);
  assert.deepEqual([edge.dashed, edge.gone], [false, false], 'esattamente al limite: ancora normale');
  assert.equal(AL.ageStyle({ sog: 12, timestampExternal: at(30 * MIN + 1) }, now).gone, true, 'in moto: 30 min + 1 ms, tolta');
  const moored = ms => AL.ageStyle({ navStat: 5, sog: 0, timestampExternal: at(ms) }, now);
  assert.deepEqual([moored(30 * MIN).dashed, moored(30 * MIN + 1).dashed], [false, true], 'ferma: tratteggiata da 30 min + 1 ms');
  assert.equal(moored(6 * H).gone, false, 'ferma: 6 h esatte, ancora presente');
  assert.equal(moored(6 * H + 1).gone, true, 'ferma: 6 h + 1 ms, tolta');
  assert.equal(AL.ageStyle({ sog: 0.1, timestampExternal: at(3 * H) }, now).gone, false, 'classe B a 0,1 kn senza stato: ferma');
  assert.equal(AL.ageStyle({ sog: 12 }, now).gone, true, 'senza orario: sparisce');
  assert.deepEqual(AL.ageStyle({ navStat: 5, sog: 0, timestampExternal: at(1000) }, now, { movingMs: 300, stillMs: 1500 }),
    { age: 1000, opacity: 1, dashed: true, gone: false }, 'limiti dati');
});

test('formatAge: età in parole, per tooltip e scheda (punto 8)', () => {
  assert.equal(AL.formatAge(20 * 1000), 'adesso');
  assert.equal(AL.formatAge(-5 * 1000), 'adesso');
  assert.equal(AL.formatAge(59 * 1000), 'adesso');
  assert.equal(AL.formatAge(60 * 1000), '1 min fa');
  assert.equal(AL.formatAge(12 * MIN + 59 * 1000), '12 min fa');
  assert.equal(AL.formatAge(59 * MIN), '59 min fa');
  assert.equal(AL.formatAge(H), '1 h fa');
  assert.equal(AL.formatAge(90 * MIN), '1 h 30 min fa');
  assert.equal(AL.formatAge(3 * H), '3 h fa');
  assert.equal(AL.formatAge(5 * H + 59 * MIN + 59 * 1000), '5 h 59 min fa');
  assert.equal(AL.formatAge(59.9 * 1000), 'adesso', '59,9 s');
  assert.equal(AL.formatAge(3599 * 1000), '59 min fa', '3599 s');
  assert.equal(AL.formatAge(6 * H - 1), '5 h 59 min fa', '6 h − 1 ms');
  assert.equal(AL.formatAge(6 * H), '6 h fa');
  for (const a of [Infinity, NaN, undefined, null]) assert.equal(AL.formatAge(a), null, String(a));
});

// --- Punto 62: tre colori per l'età della posizione (soglie di MyShipTracking) ---------------------------------
test('ageClass: verde sotto 5 min, arancio sotto 15 min, poi rosso (punto 62)', () => {
  assert.equal(AL.ageClass(0), 'verde');
  assert.equal(AL.ageClass(4 * MIN), 'verde');
  assert.equal(AL.ageClass(5 * MIN - 1), 'verde');
  assert.equal(AL.ageClass(5 * MIN), 'arancio');
  assert.equal(AL.ageClass(10 * MIN), 'arancio');
  assert.equal(AL.ageClass(15 * MIN - 1), 'arancio');
  assert.equal(AL.ageClass(15 * MIN), 'rosso', '15 min esatti');
  assert.equal(AL.ageClass(20 * MIN), 'rosso');
  assert.equal(AL.ageClass(3 * H), 'rosso');
  for (const a of [Infinity, NaN, undefined, null]) assert.equal(AL.ageClass(a), 'rosso', String(a));
});

test('boatradar.html: pallino dell\'età decorativo (aria-hidden) con i tre colori in CSS (punto 62)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  for (const c of ['verde', 'arancio', 'rosso']) assert.match(html, new RegExp(`\\.age-${c} \\{ background:#[0-9a-f]{6}`), c);
  assert.match(html, /<span class="age age-\$\{[^}]+\}" aria-hidden="true"><\/span>/, 'il pallino è nascosto ai lettori di schermo');
});

// Contrasto WCAG 2.1 (luminanza relativa sRGB)
const lumOf = h => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('boatradar.html: i tre colori dell\'età hanno luminanza diversa e almeno 3:1 sul pannello (punto 62, dopo il QA)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  const color = c => html.match(new RegExp(`\\.age-${c} \\{ background:(#[0-9a-f]{6})`))[1];
  const [g, o, r] = ['verde', 'arancio', 'rosso'].map(color);
  for (const [name, c] of [['verde', g], ['arancio', o], ['rosso', r]]) {
    assert.ok(contrast(c, '#17212d') >= 3, `${name} ${c} sul pannello: ${contrast(c, '#17212d').toFixed(2)}`);
    assert.ok(contrast(c, '#1f2c3b') >= 3, `${name} ${c} sul risultato evidenziato: ${contrast(c, '#1f2c3b').toFixed(2)}`);
  }
  // distinguibili anche senza vedere la tinta: dal più chiaro (fresca) al più scuro (vecchia), almeno 1,3:1 fra vicini
  assert.ok(lumOf(g) > lumOf(o) && lumOf(o) > lumOf(r), `luminanze ${[g, o, r].map(c => lumOf(c).toFixed(3))}`);
  assert.ok(contrast(g, o) >= 1.3 && contrast(o, r) >= 1.3, `verde/arancio ${contrast(g, o).toFixed(2)}, arancio/rosso ${contrast(o, r).toFixed(2)}`);
});
