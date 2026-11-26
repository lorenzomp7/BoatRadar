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

test('ogni script locale della pagina è pubblicato su Pages e copiato nell\'immagine Docker', () => {
  const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
  const local = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1])
    .filter(src => !/^https?:/.test(src) && src !== 'config.js');
  assert.ok(local.includes('public/ais-logic.js'), 'la pagina carica public/ais-logic.js');
  const copied = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').split('\n')
    .filter(l => /^\s*COPY\s/i.test(l)).flatMap(l => l.trim().split(/\s+/).slice(1, -1));
  const pages = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8');
  for (const src of local) {
    assert.ok(copied.includes(src), `${src} manca in una riga COPY del Dockerfile`);
    assert.ok(new RegExp(`cp ${src.replace(/[.]/g, '\\.')} _site/`).test(pages), `${src} non è copiato in _site da pages.yml`);
  }
  // la pagina lo carica prima del proprio script, che usa AisLogic subito
  assert.ok(html.indexOf('src="public/ais-logic.js"') < html.indexOf('= AisLogic'), 'ais-logic.js caricato prima dell\'uso');
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
