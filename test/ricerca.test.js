// Punto 12: /api/search ordinata con searchScore e compareSearch di public/ais-logic.js (nome esatto prima dei parziali,
// a parità la posizione più recente, poi l'MMSI), anche per nominativo radio, al massimo 25 navi scelte fra TUTTE quelle
// che corrispondono (non le prime 25 trovate). Avvia il vero server.js contro un finto aisstream locale.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('./helpers');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = (mmsi, name) => JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: name },
  Message: { PositionReport: { Latitude: 43.5, Longitude: 10.3, Sog: 8, Cog: 90, NavigationalStatus: 0 } } });
const staticData = (mmsi, name, callSign) => JSON.stringify({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi, ShipName: name },
  Message: { ShipStaticData: { Name: name, CallSign: callSign, Type: 70, ImoNumber: 0 } } });

let s;
// invia i messaggi e aspetta che il server li abbia elaborati
async function send(...msgs) {
  const start = (await s.getJson('/api/status')).messages;
  for (const m of msgs) s.socket.send(m);
  await waitFor(async () => (await s.getJson('/api/status')).messages >= start + msgs.length, 'messaggi elaborati');
}
const search = async q => s.getJson('/api/search?q=' + encodeURIComponent(q));
const ids = list => list.map(v => v.mmsi);

const XNORDX = 247120001, STELLA = 247120002, NORDIC = 247120003, NORD_A = 247120004, NORD_E = 247120005, RADIO = 247120006;

before(async () => {
  s = await startServer();
  // MMSI crescenti nell'ordine di arrivo: l'ordine di inserimento (quello di prima) è l'opposto di quello atteso
  await send(report(XNORDX, 'XNORDX'), report(STELLA, 'STELLA DEL NORD'), report(NORDIC, 'NORDIC STAR'), report(NORD_A, 'NORD'));
  await sleep(20);   // NORD (E) ha la posizione più recente di NORD (A)
  await send(report(NORD_E, 'NORD'));
  await send(report(RADIO, 'SENZA NOME UTILE'), staticData(RADIO, 'SENZA NOME UTILE', 'IBXY'));
});
after(() => s?.stop());

test('/api/search: nome esatto, inizio del nome, inizio di una parola, contenuto; a parità la posizione più recente', async () => {
  const hits = await search('nord');
  assert.deepEqual(ids(hits), [NORD_E, NORD_A, NORDIC, STELLA, XNORDX]);
  assert.deepEqual(ids(await search('  Nord ')), ids(hits), 'q normalizzata (spazi, maiuscole)');
  assert.deepEqual(ids(await search('nord')), ids(hits), 'ordine ripetibile');
  assert.ok(hits.every(v => typeof v.timestampExternal === 'number' && typeof v.lat === 'number'), 'posizione e orario per la pagina');
  assert.ok(hits[0].timestampExternal > hits[1].timestampExternal, 'NORD (E) più recente di NORD (A)');
});

test('/api/search trova il nominativo radio (esatto e inizio)', async () => {
  const exact = await search('ibxy');
  assert.deepEqual(ids(exact), [RADIO]);
  assert.equal(exact[0].callSign, 'IBXY');
  assert.deepEqual(ids(await search('IB')), [RADIO], 'inizio del nominativo');
});

test('/api/search: MMSI esatto prima degli MMSI che iniziano così', async () => {
  const hits = await search(String(NORD_A));
  assert.deepEqual(ids(hits), [NORD_A]);
  const prefix = await search('2471200');
  assert.equal(prefix.length, 6);
  assert.deepEqual(ids(prefix), [...ids(prefix)].sort((a, b) => {
    const pa = prefix.find(v => v.mmsi === a).timestampExternal, pb = prefix.find(v => v.mmsi === b).timestampExternal;
    return pb - pa || a - b;
  }), 'tutti 60: per posizione più recente, poi MMSI');
});

test('/api/search: al massimo 25, scelte fra tutte le corrispondenze e ordinate', async () => {
  const CAPO = Array.from({ length: 30 }, (_, i) => 247130001 + i);
  await send(...CAPO.slice(0, 29).map((mmsi, i) => report(mmsi, 'CAPO ' + (i + 1))));
  await sleep(20);
  await send(report(CAPO[29], 'CAPO'));   // l'ultima arrivata ha il nome esatto: deve essere la prima, non esclusa
  const hits = await search('capo');
  assert.equal(hits.length, 25);
  assert.equal(hits[0].mmsi, CAPO[29], 'il nome esatto vince anche arrivando per ultimo');
  for (let i = 2; i < hits.length; i++) {
    const a = hits[i - 1], b = hits[i];
    assert.ok(a.timestampExternal > b.timestampExternal || (a.timestampExternal === b.timestampExternal && a.mmsi < b.mmsi),
      `ordine per orario e MMSI (${a.mmsi}, ${b.mmsi})`);
  }
  assert.deepEqual(await search('c'), [], 'meno di 2 caratteri');
  assert.deepEqual(await search('   '), []);
});

// --- Correzioni da revisione del punto 12 -------------------------------------------------------------------------------

const staticFull = (mmsi, name, callSign, imo) => JSON.stringify({ MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi, ShipName: name },
  Message: { ShipStaticData: { Name: name, CallSign: callSign, Type: 70, ImoNumber: imo } } });

test('MetaData.MMSI non intero positivo (stringa, 0, negativo, decimale, oltre 9 cifre, mancante): messaggio scartato', async () => {
  const before = (await s.getJson('/api/status')).vessels;
  await send(report('247140001', 'MMSISTRINGA'), report('ABC"<x>', 'MMSISTRINGA'), report(0, 'MMSIZERO'), report(-247140002, 'MMSINEG'),
    report(247140003.5, 'MMSIDEC'), report(1e10, 'MMSIGRANDE'), report(null, 'MMSINULL'), report(true, 'MMSIBOOL'));
  assert.equal((await s.getJson('/api/status')).vessels, before, 'nessuna nave nuova');
  for (const q of ['MMSISTRINGA', 'MMSIZERO', 'MMSINEG', 'MMSIDEC', 'MMSIGRANDE', 'MMSINULL', 'MMSIBOOL']) assert.deepEqual(await search(q), [], q);
  const fc = await s.getJson('/api/locations');
  assert.ok(fc.features.every(f => Number.isInteger(f.mmsi) && f.mmsi > 0), 'in /api/locations solo MMSI interi positivi');
  await send(report(999999999, 'MMSIMASSIMO'));
  assert.deepEqual(ids(await search('mmsimassimo')), [999999999], '9 cifre: valido');
});

test('nomi ripuliti all\'ingresso (riempimento @ e spazi interni); accenti, trattini e «IMO » nella ricerca', async () => {
  const CAPO = 247150001, ANNA = 247150002, CITTA = 247150003, IMO = 247150004;
  await send(report(CAPO, '  CAPO   NORD@@@@'), report(ANNA, 'MSC ANNA-MARIA@@'), report(CITTA, 'CITTA DI GENOVA'),
    report(IMO, 'NAVE IMO'), staticFull(IMO, 'NAVE IMO', 'IA@@B', 9074729));
  const capo = await s.getJson('/api/vessel?mmsi=' + CAPO);
  assert.equal(capo.name, 'CAPO NORD', 'senza @ e con un solo spazio fra le parole');
  assert.equal((await s.getJson('/api/vessel?mmsi=' + IMO)).callSign, 'IAB');
  assert.deepEqual(ids(await search('capo nord')), [CAPO]);
  assert.deepEqual(ids(await search('anna maria')), [ANNA], '«anna maria» trova MSC ANNA-MARIA');
  assert.deepEqual(ids(await search('anna-maria')), [ANNA]);
  assert.equal((await search('anna maria'))[0].name, 'MSC ANNA-MARIA', 'il nome mostrato resta quello AIS');
  assert.deepEqual(ids(await search('città di')), [CITTA], '«città di» trova CITTA DI GENOVA');
  assert.deepEqual(ids(await search('IMO 9074729')), [IMO], 'prefisso «IMO » tolto');
  assert.deepEqual(ids(await search('imo 9074')), [IMO]);
  assert.deepEqual(ids(await search('nave imo')), [IMO], 'senza cifre dopo «IMO» resta testo');
  const keys = Object.keys((await search('anna maria'))[0]);
  assert.ok(keys.every(k => !/norm|N$/.test(k)), `nessun campo interno nella risposta (${keys})`);
});

// Implementazione del commit 2b2f80a: punteggio a tutte le navi, ordinamento completo e prime 25 (norm come parametro)
function reference(items, q, norm) {
  const startsWord = (name, t) => {
    for (let i = name.indexOf(t, 1); i > 0; i = name.indexOf(t, i + 1)) if (' -./'.includes(name[i - 1])) return true;
    return false;
  };
  const score = it => {
    const id = String(it.mmsi), imo = it.imo ? String(it.imo) : '', name = norm(it.name), call = norm(it.callSign);
    if (id === q || imo === q) return 100;
    if (name === q) return 90;
    if (call === q) return 80;
    if (name.startsWith(q)) return 70;
    if (id.startsWith(q) || (imo && imo.startsWith(q))) return 60;
    if (startsWord(name, q)) return 50;
    if (call && call.startsWith(q)) return 40;
    if (name.includes(q)) return 30;
    return 0;
  };
  return items.map(it => ({ score: score(it), ts: it.ts, mmsi: it.mmsi })).filter(h => h.score > 0)
    .sort((a, b) => b.score - a.score || b.ts - a.ts || a.mmsi - b.mmsi).slice(0, 25).map(h => h.mmsi);
}

test('/api/search su navi casuali: stessi risultati e stesso ordine dell\'implementazione precedente', async () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const syl = ['RA', 'NO', 'MAR', 'IA', 'SE', 'A', '1', '20', 'É'];
  const word = () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(syl)).join('');
  const sent = new Map(), msgs = [];
  for (let i = 0; i < 300; i++) {
    const mmsi = 248000000 + Math.floor(rnd() * 999999);
    if (sent.has(mmsi)) continue;
    const name = Array.from({ length: 1 + Math.floor(rnd() * 3) }, word).join(pick([' ', ' ', ' ', '-', '.', '/'])), callSign = word() + word();
    const imo = rnd() < 0.5 ? null : [9074729, 9176187, 9321483, 9444728][Math.floor(rnd() * 4)];
    sent.set(mmsi, { mmsi, name, callSign, imo });
    msgs.push(report(mmsi, name), staticFull(mmsi, name, callSign, imo ?? 0));
  }
  for (let i = 0; i < msgs.length; i += 50) await send(...msgs.slice(i, i + 50));
  const { norm, normQuery } = require('../public/ais-logic');
  // tutte le navi vive con l'orario della posizione, anche quelle dei test precedenti (limit mai chiesto prima: voce
  // nuova della cache, non quella di un test precedente)
  const fc = await s.getJson('/api/locations?limit=4321');
  assert.equal(fc.features.length, fc.total);
  const items = await Promise.all(fc.features.map(async f => {
    const v = sent.get(f.mmsi) || await s.getJson('/api/vessel?mmsi=' + f.mmsi);
    return { mmsi: f.mmsi, name: v.name, callSign: v.callSign, imo: v.imo, ts: f.properties.timestampExternal };
  }));
  const queries = ['RA', 'MAR', 'MARIA', 'RA NO', 'RA-NO', 'IA', 'É', 'e', '20', '248', '2480', '9074729', '907', 'IMO 9176187', 'ZZ'];
  for (const v of [...sent.values()].slice(0, 15)) queries.push(v.name, v.callSign, String(v.mmsi).slice(0, 5));
  for (const q of queries) {
    const nq = normQuery(q);
    if (nq.length < 2) continue;
    assert.deepEqual(ids(await search(q)), reference(items, nq, norm), `q «${q}»`);
  }
});
