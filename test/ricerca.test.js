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
