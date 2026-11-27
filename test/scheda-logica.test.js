// Lotto B (punti 27, 44, 46, 23): funzioni pure della scheda nave in public/ais-logic.js. Tipo di MMSI e bandiera
// (mmsiKind, flagOf, mmsiWords), stato dichiarato contro velocità (effectiveStatus, statusWords), carico pericoloso
// (hazardCategory), ETA con l'anno e titolo del viaggio (etaTime, etaWords, voyageTitle). La pagina:
// test/pagina-scheda.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');

// --- Punto 27: tipo di MMSI -------------------------------------------------------------------------------------------
test('mmsiKind: navi, stazioni costiere, gruppi, SAR, AtoN, ausiliari, portatili e dispositivi di soccorso', () => {
  const k = m => AL.mmsiKind(m);
  assert.deepEqual(k(247123450), { kind: 'ship', mid: 247 });
  assert.deepEqual(k(636000001), { kind: 'ship', mid: 636 });
  assert.deepEqual(k(2470001), { kind: 'coast', mid: 247 }, '002470001: 00 + MID');
  assert.deepEqual(k(24712345), { kind: 'group', mid: 247 }, '024712345: 0 + MID');
  assert.deepEqual(k(111247001), { kind: 'sar', mid: 247 });
  assert.deepEqual(k(992471234), { kind: 'aton', mid: 247 });
  assert.deepEqual(k(982471234), { kind: 'auxiliary', mid: 247 });
  assert.deepEqual(k(824712345), { kind: 'handheld', mid: 247 });
  assert.deepEqual(k(970123456), { kind: 'sart', mid: null });
  assert.deepEqual(k(972123456), { kind: 'mob', mid: null });
  assert.deepEqual(k(974123456), { kind: 'epirb', mid: null });
});

test('mmsiKind: non validi (prima cifra 1 o 9 fuori dai prefissi, MID fuori da 201-775, non interi, fuori intervallo)', () => {
  for (const m of [123456789, 111111111, 999999999, 0, -247123450, 1.5, 1e9, '247123450', null, undefined, NaN, 900000000,
    199999999, 776123456, 200123456, 1200000])
    assert.deepEqual(AL.mmsiKind(m), { kind: 'invalid', mid: null }, String(m));
});

test('flagOf: paese solo per navi e ausiliari, null se il MID non è in tabella', () => {
  assert.equal(AL.flagOf(247123450), 'Italia');
  assert.equal(AL.flagOf(636000001), 'Liberia');
  assert.equal(AL.flagOf(982471234), 'Italia');
  assert.equal(AL.flagOf(2470001), null, 'stazione costiera: nessuna bandiera');
  assert.equal(AL.flagOf(111247001), null, 'SAR: nessuna bandiera');
  assert.equal(AL.flagOf(992471234), null, 'AtoN: nessuna bandiera');
  assert.equal(AL.flagOf(970123456), null);
  assert.equal(AL.flagOf(123456789), null);
  assert.equal(AL.flagOf(300123456), null, 'MID 300 valido ma non in tabella');
  assert.equal(AL.MID_NAMES[247], 'Italia');
});

test('mmsiWords: null per le navi, altrimenti tipo e paese della stazione', () => {
  assert.equal(AL.mmsiWords(247123450), null);
  assert.equal(AL.mmsiWords(300123456), null, 'nave con MID non in tabella: comunque una nave');
  assert.equal(AL.mmsiWords(2470001), 'Stazione costiera · Italia');
  assert.equal(AL.mmsiWords(24712345), 'Gruppo di navi · Italia');
  assert.equal(AL.mmsiWords(111247001), 'Aeromobile SAR · Italia');
  assert.equal(AL.mmsiWords(992471234), 'Aiuto alla navigazione (AtoN) · Italia');
  assert.equal(AL.mmsiWords(982471234), 'Imbarcazione ausiliaria · Italia');
  assert.equal(AL.mmsiWords(824712345), 'Radio VHF portatile · Italia');
  assert.equal(AL.mmsiWords(970123456), 'Trasponditore di soccorso (AIS-SART)');
  assert.equal(AL.mmsiWords(972123456), 'Dispositivo uomo a mare (MOB)');
  assert.equal(AL.mmsiWords(974123456), 'Radiofaro di emergenza (EPIRB)');
  assert.equal(AL.mmsiWords(3001234), 'Stazione costiera', 'MID 300 non in tabella: senza paese');
  assert.equal(AL.mmsiWords(123456789), 'MMSI non valido');
  for (const kind of ['ship', 'coast', 'group', 'sar', 'aton', 'auxiliary', 'handheld', 'sart', 'mob', 'epirb', 'invalid'])
    assert.equal(typeof AL.MMSI_KIND_LABEL[kind], 'string', kind);
});
