// Test d'integrazione delle risorse e API usate dalla pagina: avvia un server.js tutto suo
// (startServer di helpers.js) contro un finto aisstream locale. Esegui con: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('file statico illeggibile: risposta 500 e il server resta in piedi', async () => {
  // copia di server.js senza pagine né public/: ogni file statico manca
  const ROOT = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-statici-'));
  for (const f of ['server.js', 'position-check.js']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const solo = await startServer({ NODE_PATH: path.join(ROOT, 'node_modules') }, {}, { cwd: dir });
  try {
    for (const p of ['/public/ais-logic.js', '/', '/vesselfinder.html']) {
      const res = await solo.get(p);
      assert.equal(res.status, 500, p);
      assert.doesNotMatch(res.body.toString('utf8'), new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'nessun percorso nella risposta');
    }
    assert.equal((await solo.get('/api/status')).status, 200, 'il processo è ancora vivo');
    assert.match(solo.log(), /ais-logic\.js/, 'errore scritto nel log');
  } finally {
    await solo.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/api/status riporta serverTime: l\'ora del server in millisecondi (punto 43)', async () => {
  const before = Date.now();
  const st = await srv.getJson('/api/status');
  const after = Date.now();
  assert.equal(typeof st.serverTime, 'number');
  assert.ok(st.serverTime >= before && st.serverTime <= after, `${st.serverTime} fra ${before} e ${after}`);
});

test('/api/locations non contiene serverTime: la risposta può venire dalla cache (punto 84)', async () => {
  const fc = await srv.getJson('/api/locations');
  assert.equal(fc.serverTime, undefined);
});
