// Diagnosi con Proxelar (AGENTS.md, «Diagnosi»): con NODE_USE_ENV_PROXY=1 la connessione verso aisstream
// deve passare dal proxy indicato in HTTP_PROXY/HTTPS_PROXY; senza, deve andare diretta.
// Il proxy qui è un finto proxy HTTP locale che inoltra l'upgrade WebSocket e prende nota della richiesta.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startServer, waitFor } = require('./helpers');

function fakeProxy() {
  const seen = [];
  const proxy = http.createServer();
  proxy.on('upgrade', (req, sock, head) => {   // via proxy la richiesta arriva in forma assoluta
    seen.push(req.url);
    const u = new URL(req.url);
    const up = net.connect(Number(u.port), u.hostname, () => {
      up.write(`${req.method} ${u.pathname}${u.search} HTTP/1.1\r\n` +
        Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return new Promise(resolve => proxy.listen(0, '127.0.0.1', () => resolve({ proxy, seen, url: `http://127.0.0.1:${proxy.address().port}` })));
}

test('con NODE_USE_ENV_PROXY=1 la connessione ad aisstream passa dal proxy', async () => {
  const p = await fakeProxy();
  const s = await startServer({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: p.url, HTTPS_PROXY: p.url, NO_PROXY: '' });
  try {
    assert.equal(p.seen.length, 1);
    assert.match(p.seen[0], /^http:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(s.subscription.APIKey, 'chiave-di-test');
    // i dati arrivano attraverso il proxy come senza
    s.socket.send(JSON.stringify({ MetaData: { MMSI: 247000001 },
      Message: { PositionReport: { Latitude: 45.43, Longitude: 12.33, Sog: 3, Cog: 10, NavigationalStatus: 0 } } }));
    await waitFor(async () => (await s.getJson('/api/status')).vessels === 1, 'nave ricevuta via proxy');
  } finally { await s.stop(); p.proxy.close(); }
});

test('senza NODE_USE_ENV_PROXY il proxy non viene usato', async () => {
  const p = await fakeProxy();
  const s = await startServer({ HTTP_PROXY: p.url, HTTPS_PROXY: p.url, NO_PROXY: '' });
  try {
    assert.equal(p.seen.length, 0);
    assert.equal(s.subscription.APIKey, 'chiave-di-test');
  } finally { await s.stop(); p.proxy.close(); }
});

test('il log dice se la compressione permessage-deflate è attiva', async () => {
  const s = await startServer();   // il finto aisstream non comprime
  try {
    await waitFor(() => /compressione: (sì|no)/.test(s.log()), 'riga di log sulla compressione');
    assert.match(s.log(), /connesso \(compressione: no\)/);
  } finally { await s.stop(); }
});

test('il log riporta «compressione: sì» quando aisstream la accetta', async () => {
  const s = await startServer({}, { perMessageDeflate: true });
  try {
    await waitFor(() => /compressione: (sì|no)/.test(s.log()), 'riga di log sulla compressione');
    assert.match(s.log(), /connesso \(compressione: sì\)/);
  } finally { await s.stop(); }
});
