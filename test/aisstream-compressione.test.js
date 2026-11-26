// Punto 11 del Piano: /api/status dice se la connessione con aisstream è compressa.
// negotiated = permessage-deflate accettato nell'handshake WebSocket; confirmed = CompressionEnabled
// del messaggio SubscriptionConfirmation che aisstream manda dopo la sottoscrizione (null finché non arriva).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('./helpers');

const confirmation = enabled => JSON.stringify({ MessageType: 'SubscriptionConfirmation', Message: { CompressionEnabled: enabled } });

test('con permessage-deflate: negotiated true, poi la conferma imposta confirmed senza contare un messaggio', async () => {
  const s = await startServer({}, { perMessageDeflate: true });
  try {
    let st = await s.getJson('/api/status');
    assert.deepEqual(st.compression, { negotiated: true, confirmed: null }, 'prima della conferma');
    s.socket.send(confirmation(true));
    await waitFor(async () => (await s.getJson('/api/status')).compression?.confirmed === true, 'conferma ricevuta');
    st = await s.getJson('/api/status');
    assert.equal(st.messages, 0, 'la conferma non è un messaggio AIS');
    assert.equal(st.error, null);
    await waitFor(() => /sottoscrizione confermata \(compressione: sì\)/.test(s.log()), 'riga di log della conferma');
    assert.doesNotMatch(s.log(), /arrivano i dati/, 'la conferma non vale come dati');
  } finally { await s.stop(); }
});

test('senza compressione e con conferma false: {negotiated: false, confirmed: false} e avviso nel log', async () => {
  const s = await startServer();
  try {
    assert.deepEqual((await s.getJson('/api/status')).compression, { negotiated: false, confirmed: null });
    s.socket.send(confirmation(false));
    await waitFor(async () => (await s.getJson('/api/status')).compression?.confirmed === false, 'conferma ricevuta');
    assert.deepEqual((await s.getJson('/api/status')).compression, { negotiated: false, confirmed: false });
    await waitFor(() => /sottoscrizione confermata \(compressione: no\)/.test(s.log()), 'riga di log della conferma');
    assert.match(s.log(), /connesso \(compressione: no\)/);
  } finally { await s.stop(); }
});

test('dopo la conferma una PositionReport viene contata e la nave compare', async () => {
  const s = await startServer({}, { perMessageDeflate: true });
  try {
    s.socket.send(confirmation(true));
    await waitFor(async () => (await s.getJson('/api/status')).compression?.confirmed === true, 'conferma ricevuta');
    s.socket.send(JSON.stringify({ MessageType: 'PositionReport', MetaData: { MMSI: 247000099 },
      Message: { PositionReport: { Latitude: 45.43, Longitude: 12.33, Sog: 3, Cog: 10, NavigationalStatus: 0 } } }));
    await waitFor(async () => (await s.getJson('/api/status')).vessels === 1, 'nave ricevuta');
    const st = await s.getJson('/api/status');
    assert.equal(st.messages, 1);
    assert.equal(st.vessels, 1);
    await waitFor(() => /arrivano i dati/.test(s.log()), 'log dei dati');
  } finally { await s.stop(); }
});
