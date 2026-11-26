// Test d'integrazione delle risorse e API usate dalla pagina: avvia un server.js tutto suo
// (startServer di helpers.js) contro un finto aisstream locale. Esegui con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv?.stop(); });

test('serve public/ais-logic.js come JavaScript e nient\'altro di public/', async () => {
  const res = await srv.get('/public/ais-logic.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.body.toString('utf8'), /AisLogic/);
  assert.equal((await srv.get('/public/x.js')).status, 404);
  assert.equal((await srv.get('/public/')).status, 404);
  assert.equal((await srv.get('/public/../server.js')).status, 404);
});
