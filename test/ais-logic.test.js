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

test('boatradar.html non sposta un marker su una posizione più vecchia di quella che mostra', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  assert.match(html, /isNewer\(m\.props\?\.timestampExternal, f\.properties\.timestampExternal\)/);
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

test('boatradar.html: età e finestre con clock.now(); Date.now() solo per misurare /api/status', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  const code = html.split('<script src="public/ais-logic.js"></script>')[1];
  assert.match(code, /const clock = createClock\(\)/);
  assert.match(code, /clock\.add\(clockSample\(/);
  assert.match(code, /from=\$\{clock\.now\(\) - WINDOW_MS\}/, 'finestra del Baltico con l\'ora corretta');
  assert.match(code, /new Date\(clock\.now\(\)\)\.toLocaleTimeString/, 'ora di aggiornamento con l\'ora corretta');
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

test('boatradar.html: simbolo da symbol(), freccia corta e riga «Prua» nella scheda', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  assert.match(html, /symbol\(f\.properties\)/);
  assert.match(html, /options\.short/);
  assert.match(html, /row\('Prua'/);
});
