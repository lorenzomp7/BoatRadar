// Riconnessione ad aisstream (AGENTS.md: niente riconnessioni aggressive). L'attesa fra un tentativo e il
// successivo raddoppia (1 s, 2 s, 4 s, ...) e torna a 1 s solo con un vero messaggio AIS: un {error} o la
// sola SubscriptionConfirmation seguiti dalla chiusura non devono far riconnettere il server ogni secondo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('dopo {error} o sola conferma e chiusura il backoff cresce: al massimo 3 connessioni in 5 s', async () => {
  const s = await startServer();
  try {
    let connections = 1;   // la prima l'ha già aperta startServer
    s.fakeAis.on('connection', ws => {
      connections++;
      ws.once('message', () => {
        ws.send(JSON.stringify({ MessageType: 'SubscriptionConfirmation', Message: { CompressionEnabled: false } }));
        ws.close();
      });
    });
    s.socket.send(JSON.stringify({ error: 'Api Key Is Not Valid' }));
    s.socket.close();
    await sleep(5000);
    // con backoff: tentativi a 0, 1 e 3 s (il prossimo a 7 s); senza: uno al secondo
    assert.ok(connections <= 3, `${connections} connessioni in 5 s`);
    assert.ok(connections >= 2, 'si riconnette comunque');
  } finally { await s.stop(); }
});
