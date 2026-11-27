// Lotto B (punti 27, 44, 46, 23): funzioni pure della scheda nave in public/ais-logic.js. Tipo di MMSI e bandiera
// (mmsiKind, flagOf, mmsiWords, anomalousMmsi, flagWords, italianRegistries), stato dichiarato contro velocità (effectiveStatus, statusWords), carico pericoloso
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

test('mmsiWords: null per le navi; forma di stazione su una nave = MMSI anomalo; tipo e paese per ausiliari e soccorso', () => {
  assert.equal(AL.mmsiWords(247123450), null);
  assert.equal(AL.mmsiWords(300123456), null, 'nave con MID non in tabella: comunque una nave');
  // il server riceve solo messaggi di navi (posizione e dati statici): un MMSI con la forma di una stazione costiera,
  // di un gruppo, di un aeromobile SAR o di un AtoN è stato programmato male a bordo
  assert.equal(AL.mmsiWords(2470001), 'MMSI anomalo per una nave (forma di stazione costiera · Italia)');
  assert.equal(AL.mmsiWords(24712345), 'MMSI anomalo per una nave (forma di gruppo di navi · Italia)');
  assert.equal(AL.mmsiWords(111247001), 'MMSI anomalo per una nave (forma di aeromobile SAR · Italia)');
  assert.equal(AL.mmsiWords(992471234), 'MMSI anomalo per una nave (forma di AtoN, aiuto alla navigazione · Italia)');
  assert.equal(AL.mmsiWords(3001234), 'MMSI anomalo per una nave (forma di stazione costiera)', 'MID 300 non in tabella: senza paese');
  assert.equal(AL.mmsiWords(982471234), 'Imbarcazione ausiliaria · Italia');
  assert.equal(AL.mmsiWords(824712345), 'Radio VHF portatile · Italia');
  assert.equal(AL.mmsiWords(970123456), 'Trasponditore di soccorso (AIS-SART)');
  assert.equal(AL.mmsiWords(972123456), 'Dispositivo uomo a mare (MOB)');
  assert.equal(AL.mmsiWords(974123456), 'Radiofaro di emergenza (EPIRB)');
  assert.equal(AL.mmsiWords(123456789), 'MMSI non valido');
  for (const kind of ['ship', 'coast', 'group', 'sar', 'aton', 'auxiliary', 'handheld', 'sart', 'mob', 'epirb', 'invalid'])
    assert.equal(typeof AL.MMSI_KIND_LABEL[kind], 'string', kind);
});

test('anomalousMmsi: solo le forme di stazione costiera, gruppo, SAR e AtoN', () => {
  for (const m of [2470001, 24712345, 111247001, 992471234, 3001234]) assert.equal(AL.anomalousMmsi(m), true, String(m));
  for (const m of [247123450, 982471234, 824712345, 970123456, 972123456, 974123456, 123456789, null])
    assert.equal(AL.anomalousMmsi(m), false, String(m));
});

test('flagWords: bandiera per navi e ausiliari; dal MID con l\'avviso per gli MMSI anomali; null per il resto', () => {
  assert.equal(AL.flagWords(247123450), 'Italia');
  assert.equal(AL.flagWords(982471234), 'Italia');
  assert.equal(AL.flagWords(2470001), 'Italia (dal MID, MMSI anomalo)');
  assert.equal(AL.flagWords(111247001), 'Italia (dal MID, MMSI anomalo)');
  assert.equal(AL.flagWords(992471234), 'Italia (dal MID, MMSI anomalo)');
  assert.equal(AL.flagWords(3001234), null, 'MID 300 non in tabella');
  assert.equal(AL.flagWords(300123456), null);
  for (const m of [824712345, 970123456, 972123456, 974123456, 123456789]) assert.equal(AL.flagWords(m), null, String(m));
});

test('italianRegistries: MID 247 per navi, ausiliari e MMSI anomali (non per portatili e dispositivi di soccorso)', () => {
  for (const m of [247123450, 982471234, 2470001, 24712345, 111247001, 992471234]) assert.equal(AL.italianRegistries(m), true, String(m));
  for (const m of [636000001, 824712345, 970123456, 2380001, 123456789]) assert.equal(AL.italianRegistries(m), false, String(m));
});

test('oneDecimal e knots: una cifra decimale con la virgola', () => {
  assert.equal(AL.oneDecimal(7.44), '7,4');
  assert.equal(AL.oneDecimal(90), '90,0');
  assert.equal(AL.knots(8), '8,0 kn');
});

// --- Punto 44: stato dichiarato contro velocità ------------------------------------------------------------------------
test('effectiveStatus: dichiara ormeggiata ma va a 8 kn → in moto; in navigazione a 0,05 kn → ferma', () => {
  assert.deepEqual(AL.effectiveStatus(5, 8), { declared: 'Ormeggiata', still: false, mismatch: 'moving' });
  assert.deepEqual(AL.effectiveStatus(0, 0.05), { declared: 'In navigazione a motore', still: true, mismatch: 'still' });
  assert.deepEqual(AL.effectiveStatus(1, 0.1), { declared: 'All\'ancora', still: true, mismatch: null }, 'all\'ancora e ferma');
  assert.deepEqual(AL.effectiveStatus(8, 0), { declared: 'In navigazione a vela', still: true, mismatch: 'still' });
  assert.deepEqual(AL.effectiveStatus(6, 4), { declared: 'Incagliata', still: false, mismatch: 'moving' });
});

test('effectiveStatus: confini di isStill (3 kn per ancora/ormeggio/incaglio, 0,5 kn per le navi in navigazione)', () => {
  assert.equal(AL.effectiveStatus(5, 2.9).mismatch, null, '2,9 kn ormeggiata: ancora ferma per isStill');
  assert.equal(AL.effectiveStatus(5, 2.9).still, true);
  assert.equal(AL.effectiveStatus(5, 3).mismatch, 'moving', 'da 3 kn in moto');
  assert.equal(AL.effectiveStatus(0, 0.5).mismatch, 'still', '0,5 kn: ferma');
  assert.equal(AL.effectiveStatus(0, 0.6).mismatch, null, '0,6 kn: in moto, come dichiara');
  assert.equal(AL.effectiveStatus(0, 0.6).still, false);
});

test('effectiveStatus: velocità non disponibile (102,3) o mancante, stato mancante o fuori tabella → nessun contrasto', () => {
  assert.deepEqual(AL.effectiveStatus(5, 102.3), { declared: 'Ormeggiata', still: true, mismatch: null });
  assert.deepEqual(AL.effectiveStatus(0, 102.3), { declared: 'In navigazione a motore', still: false, mismatch: null });
  assert.deepEqual(AL.effectiveStatus(0, undefined), { declared: 'In navigazione a motore', still: false, mismatch: null });
  assert.deepEqual(AL.effectiveStatus(undefined, 8), { declared: null, still: false, mismatch: null });
  assert.deepEqual(AL.effectiveStatus(undefined, 0), { declared: null, still: true, mismatch: null });
  assert.equal(AL.effectiveStatus(15, 0).declared, null, '15 = non definito');
  assert.equal(AL.NAV_STATUS_LABEL[7], 'In pesca');
});

test('statusWords: il dichiarato e, se contrasta, cosa fa davvero (in parole, con la velocità)', () => {
  assert.equal(AL.statusWords(5, 8), 'Dichiara: ormeggiata · in realtà in moto a 8,0 kn');
  assert.equal(AL.statusWords(1, 12.34), 'Dichiara: all\'ancora · in realtà in moto a 12,3 kn');
  assert.equal(AL.statusWords(0, 0.05), 'Dichiara: in navigazione a motore · in realtà ferma (0,1 kn)');
  assert.equal(AL.statusWords(0, 0), 'Dichiara: in navigazione a motore · in realtà ferma (0,0 kn)');
  assert.equal(AL.statusWords(5, 0), 'Ormeggiata');
  assert.equal(AL.statusWords(0, 12), 'In navigazione a motore');
  assert.equal(AL.statusWords(undefined, 12), null);
});

// --- Punto 46: carico pericoloso -------------------------------------------------------------------------------------
test('hazardCategory: categorie X, Y, Z, OS dalle unità 1-4 delle decine 2, 4, 6, 7, 8, 9', () => {
  assert.equal(AL.hazardCategory(71), 'X');
  assert.equal(AL.hazardCategory(72), 'Y');
  assert.equal(AL.hazardCategory(83), 'Z');
  assert.equal(AL.hazardCategory(84), 'OS');
  assert.equal(AL.hazardCategory(24), 'OS', 'WIG');
  assert.equal(AL.hazardCategory(94), 'OS', 'altro tipo');
  assert.equal(AL.hazardCategory(41), 'X', 'unità veloce');
  assert.equal(AL.hazardCategory(62), 'Y', 'passeggeri');
  for (const t of [70, 80, 31, 34, 51, 95, 99, 0, 1, 14, 100, 71.5, -71, '71', null, undefined, NaN])
    assert.equal(AL.hazardCategory(t), null, String(t));
});

// --- Punto 23: ETA con l'anno e titolo del viaggio --------------------------------------------------------------------
const U = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const E = (month, day, hour = null, minute = null) => ({ month, day, hour, minute });
test('etaTime: l\'anno è quello che mette l\'ETA fra 300 giorni fa e 65 giorni avanti', () => {
  assert.equal(AL.etaTime(E(1, 2, 8, 0), U(2026, 12, 30, 12)), U(2027, 1, 2, 8), '2 gennaio visto il 30 dicembre: anno dopo');
  assert.equal(AL.etaTime(E(12, 30, 8, 0), U(2027, 1, 2, 12)), U(2026, 12, 30, 8), '30 dicembre visto il 2 gennaio: anno prima');
  // un'ETA di 31-60 giorni fa non diventa un viaggio di 11 mesi: resta passata
  assert.equal(AL.etaTime(E(10, 17, 12, 0), U(2026, 11, 27, 10)), U(2026, 10, 17, 12), '41 giorni passati: quest\'anno');
  assert.equal(AL.etaTime(E(9, 28, 12, 0), U(2026, 11, 27, 10)), U(2026, 9, 28, 12), '60 giorni passati: quest\'anno');
  assert.equal(AL.etaTime(E(2, 1, 12, 0), U(2026, 11, 27, 10)), U(2026, 2, 1, 12), '299 giorni passati: quest\'anno');
  assert.equal(AL.etaTime(E(1, 30, 12, 0), U(2026, 11, 27, 10)), U(2027, 1, 30, 12), '301 giorni passati: l\'anno dopo, fra 64 giorni');
  // bordi: 300 giorni fa compreso, 65 giorni avanti escluso
  assert.equal(AL.etaTime(E(1, 31, 10, 0), U(2026, 11, 27, 10)), U(2026, 1, 31, 10), '300 giorni fa esatti: passata');
  assert.equal(AL.etaTime(E(12, 1, 12, 0), U(2026, 11, 27, 10)), U(2026, 12, 1, 12));
  assert.equal(AL.etaTime(E(4, 31, 0, 0), U(2026, 11, 27)), null, '31 aprile non esiste');
  assert.equal(AL.etaTime(E(12, 1), U(2026, 11, 27, 10)), U(2026, 12, 1), 'ora mancante: inizio del giorno');
  assert.equal(AL.etaTime(E(12, 1, 6), U(2026, 11, 27, 10)), U(2026, 12, 1, 6), 'minuto mancante: 0');
  for (const e of [E(0, 1, 0, 0), E(13, 1, 0, 0), E(5, 0), E(5, 32), null, undefined, {}, E(1.5, 2)])
    assert.equal(AL.etaTime(e, U(2026, 11, 27)), null, JSON.stringify(e));
  assert.equal(AL.etaTime(E(12, 1), NaN), null, 'ora attuale non valida');
});

test('etaTime: 29 febbraio e anni bisestili (fra due ricorrenze ci possono essere 366 giorni)', () => {
  assert.equal(AL.etaTime(E(4, 1), U(2027, 5, 1, 10)), U(2027, 4, 1), '1 aprile visto il 1 maggio 2027: un mese fa');
  assert.equal(AL.etaTime(E(4, 1, 0, 0), U(2027, 5, 1, 10)), U(2027, 4, 1));
  // 2 marzo visto il 27 dicembre 2027 alle 12: l'ultimo è di 300,5 giorni fa, il prossimo (2028, bisestile) fra 65,5 giorni
  assert.equal(AL.etaTime(E(3, 2, 0, 0), U(2027, 12, 27, 12)), U(2028, 3, 2), 'buco di 366 giorni: il prossimo');
  assert.equal(AL.etaTime(E(2, 29, 0, 0), U(2026, 11, 27, 10)), null, '29 febbraio senza un anno bisestile vicino');
  assert.equal(AL.etaTime(E(2, 29, 0, 0), U(2028, 1, 1)), U(2028, 2, 29), '29 febbraio 2028 fra 59 giorni');
  assert.equal(AL.etaTime(E(2, 29, 0, 0), U(2028, 11, 27)), U(2028, 2, 29), '29 febbraio 2028 passato da 272 giorni');
  assert.equal(AL.etaTime(E(2, 29, 0, 0), U(2027, 12, 1)), null, '29 febbraio 2028 fra 90 giorni: troppo avanti');
});

test('etaTime: per ogni giorno dal 2026 al 2029 ogni data che non sia il 29 febbraio ha un anno, fra −300 e +66 giorni', () => {
  const DAY = 86400000;
  for (let now = U(2026, 1, 1, 12); now < U(2030, 1, 1); now += 3 * DAY + 3600000) {
    for (let d = U(2027, 1, 1); d < U(2028, 1, 1); d += DAY) {
      const day = new Date(d), e = E(day.getUTCMonth() + 1, day.getUTCDate(), 6, 30), t = AL.etaTime(e, now);
      assert.ok(t != null && t >= now - 300 * DAY && t < now + 66 * DAY, `${JSON.stringify(e)} visto il ${new Date(now).toISOString()}: ${t}`);
    }
  }
});

test('etaWords: data con anno e ora UTC, quanto manca (ore e minuti sotto le 48 h, poi giorni) o da quanto è passata', () => {
  assert.deepEqual(AL.etaWords(E(1, 2, 8, 0), U(2027, 1, 2, 2, 40)), { date: '2 gen 2027, 08:00 UTC', rel: 'tra 5 h 20 min' });
  assert.deepEqual(AL.etaWords(E(12, 30, 8, 0), U(2027, 1, 2, 12)),
    { date: '30 dic 2026, 08:00 UTC', rel: 'già passata (3 giorni fa): forse non aggiornata' });
  assert.deepEqual(AL.etaWords(E(12, 1, 12, 0), U(2026, 11, 27, 10)), { date: '1 dic 2026, 12:00 UTC', rel: 'tra 4 giorni' });
  assert.equal(AL.etaWords(E(11, 29, 9, 59), U(2026, 11, 27, 10)).rel, 'tra 47 h 59 min');
  assert.equal(AL.etaWords(E(11, 29, 10, 0), U(2026, 11, 27, 10)).rel, 'tra 2 giorni');
  assert.equal(AL.etaWords(E(11, 27, 10, 30), U(2026, 11, 27, 10)).rel, 'tra 30 min');
  assert.equal(AL.etaWords(E(11, 27, 13, 0), U(2026, 11, 27, 10)).rel, 'tra 3 h');
  assert.equal(AL.etaWords(E(11, 27, 10, 0), U(2026, 11, 27, 10, 0)).rel, 'tra meno di 1 min');
  // passata: sotto un giorno solo «già passata», poi da quanti giorni
  assert.equal(AL.etaWords(E(11, 27, 8, 0), U(2026, 11, 27, 10)).rel, 'già passata');
  assert.equal(AL.etaWords(E(11, 26, 10, 1), U(2026, 11, 27, 10)).rel, 'già passata');
  assert.equal(AL.etaWords(E(11, 26, 8, 0), U(2026, 11, 27, 10)).rel, 'già passata (1 giorno fa): forse non aggiornata');
  assert.deepEqual(AL.etaWords(E(10, 17, 12, 0), U(2026, 11, 27, 10)),
    { date: '17 ott 2026, 12:00 UTC', rel: 'già passata (40 giorni fa): forse non aggiornata' });
  // senza ora: solo la data, e i giorni di calendario
  assert.deepEqual(AL.etaWords(E(12, 1), U(2026, 11, 27, 10)), { date: '1 dic 2026', rel: 'tra 4 giorni' });
  assert.equal(AL.etaWords(E(11, 27), U(2026, 11, 27, 23)).rel, 'oggi');
  assert.equal(AL.etaWords(E(11, 28), U(2026, 11, 27, 23)).rel, 'domani');
  assert.equal(AL.etaWords(E(11, 26), U(2026, 11, 27, 1)).rel, 'già passata (1 giorno fa): forse non aggiornata');
  assert.equal(AL.etaWords(E(10, 17), U(2026, 11, 27, 1)).rel, 'già passata (41 giorni fa): forse non aggiornata');
  assert.deepEqual(AL.etaWords(E(4, 1), U(2027, 5, 1, 10)), { date: '1 apr 2027', rel: 'già passata (30 giorni fa): forse non aggiornata' });
  assert.equal(AL.etaWords(E(2, 29, 0, 0), U(2026, 11, 27)), null);
});

test('voyageTitle: «Viaggio (dichiarato dalla nave, 2 h fa)», senza età se l\'ora non è valida', () => {
  const now = U(2026, 11, 27, 10);
  assert.equal(AL.voyageTitle(now - 2 * 3600000, now), 'Viaggio (dichiarato dalla nave, 2 h fa)');
  assert.equal(AL.voyageTitle(now - 5 * 60000, now), 'Viaggio (dichiarato dalla nave, 5 min fa)');
  assert.equal(AL.voyageTitle(now - 1000, now), 'Viaggio (dichiarato dalla nave, adesso)');
  assert.equal(AL.voyageTitle(undefined, now), 'Viaggio (dichiarato dalla nave)');
  assert.equal(AL.voyageTitle('x', now), 'Viaggio (dichiarato dalla nave)');
});
