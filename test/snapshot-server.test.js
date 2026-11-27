// Punto 22: server.js con SNAPSHOT_FILE conserva i dati statici delle navi fra un riavvio e l'altro (vero server.js
// contro un finto aisstream). Le funzioni di snapshot.js sono in test/snapshot.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { startServer, waitFor } = require('./helpers');

const tmpDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-snap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const writeSnapshot = (file, vessels, savedAt = Date.now()) =>
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ format: 'boatradar-vessels', version: 1, savedAt, vessels })));
const readSnapshot = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
// messaggio AIS e attesa che il server l'abbia contato
async function send(s, msg) {
  const before = (await s.getJson('/api/status')).messages;
  s.socket.send(JSON.stringify(msg));
  await waitFor(async () => (await s.getJson('/api/status')).messages > before, 'messaggio elaborato');
}
const staticMsg = (mmsi, name, extra = {}) => ({ MetaData: { MMSI: mmsi, ShipName: name },
  Message: { ShipStaticData: { Name: name, ImoNumber: 9074729, CallSign: 'IABC', Type: 70, Destination: 'VENEZIA',
    MaximumStaticDraught: 7.5, Dimension: { A: 100, B: 20, C: 10, D: 8 }, Eta: { Month: 12, Day: 2, Hour: 8, Minute: 30 }, ...extra } } });
const timed = async fn => { const t0 = Date.now(); await fn(); return Date.now() - t0; };

test('all\'avvio i dati statici del file tornano in /api/vessel, senza posizioni in /api/locations', async t => {
  const file = path.join(tmpDir(t), 'vessels.json.gz');
  const now = Date.now();
  writeSnapshot(file, [
    [247123450, { name: 'LAGUNA PRIMA', imo: 9074729, callSign: 'IABC', shipType: 70, destination: 'VENEZIA', draught: 7.5,
      length: 120, width: 18, eta: { month: 12, day: 2, hour: 8, minute: null }, staticTs: now - 3600000 }],
    [538001234, { name: 'FERMA ÀCCENTATA', staticTs: now - 60000 }],
    [211000001, { name: 'TROPPO VECCHIA', staticTs: now - 49 * 3600000 }],
  ]);
  const s = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => s.stop());
  const v = await s.getJson('/api/vessel?mmsi=247123450');
  assert.equal(v.mmsi, 247123450);
  assert.equal(v.name, 'LAGUNA PRIMA');
  assert.equal(v.imo, 9074729);
  assert.equal(v.destination, 'VENEZIA');
  assert.deepEqual(v.eta, { month: 12, day: 2, hour: 8, minute: null });
  assert.equal(v.staticTs, now - 3600000);
  assert.equal(await s.getJson('/api/vessel?mmsi=211000001'), null, 'oltre 48 h non torna');
  const fc = await s.getJson('/api/locations');
  assert.equal(fc.features.length, 0, 'nessuna posizione dal file');
  const st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.store, 'file');
  assert.equal(st.restored, 2);
  assert.equal(st.error, null);
  assert.ok(!JSON.stringify(st).includes(path.dirname(file)), 'nessun percorso in /api/status');
  // nomi della ricerca normalizzati anche per le navi ripristinate: con una posizione la si trova senza accento
  await send(s, { MetaData: { MMSI: 538001234 }, Message: { PositionReport: { Latitude: 44.4, Longitude: 8.9, Sog: 0, Cog: 0, NavigationalStatus: 5 } } });
  const found = await s.getJson('/api/search?q=' + encodeURIComponent('ferma accentata'));
  assert.deepEqual(found.map(r => r.mmsi), [538001234]);
});

test('SIGTERM salva i dati statici ed esce subito; al riavvio la nave c\'è', async t => {
  const file = path.join(tmpDir(t), 'vessels.json.gz');
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_INTERVAL_MS: '3600000' });
  t.after(() => s.stop());
  await send(s, staticMsg(247123450, 'LAGUNA PRIMA'));
  assert.equal(fs.existsSync(file), false, 'nessun salvataggio prima del segnale');
  const ms = await timed(() => s.stop());
  assert.ok(ms < 2000, `uscita in ${ms} ms`);
  assert.equal(s.child.exitCode, 0);
  const obj = readSnapshot(file);
  assert.equal(obj.format, 'boatradar-vessels');
  assert.deepEqual(obj.vessels.map(([m]) => m), [247123450]);
  assert.equal(obj.vessels[0][1].destination, 'VENEZIA');
  assert.equal(fs.existsSync(file + '.tmp'), false);

  const again = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => again.stop());
  const v = await again.getJson('/api/vessel?mmsi=247123450');
  assert.equal(v.name, 'LAGUNA PRIMA');
  assert.equal(v.destination, 'VENEZIA');
  assert.equal(v.draught, 7.5);
  assert.equal(v.length, 120);
  assert.deepEqual(v.eta, { month: 12, day: 2, hour: 8, minute: 30 });
  assert.equal((await again.getJson('/api/status')).snapshot.restored, 1);
});

test('con SNAPSHOT_INTERVAL_MS il server salva a intervalli e lo riporta in /api/status', async t => {
  const file = path.join(tmpDir(t), 'sotto', 'vessels.json.gz');
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_INTERVAL_MS: '300' });
  t.after(() => s.stop());
  await send(s, staticMsg(247123450, 'PRIMA'));
  await waitFor(() => fs.existsSync(file) && readSnapshot(file).vessels.length === 1, 'primo salvataggio');
  await send(s, staticMsg(247123451, 'SECONDA'));
  await waitFor(() => readSnapshot(file).vessels.length === 2, 'salvataggio dopo la seconda nave');
  await waitFor(async () => (await s.getJson('/api/status')).snapshot.vessels === 2, 'stato aggiornato');
  const st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.store, 'file');
  assert.ok(st.savedAt > 0 && st.bytes > 0 && st.ms >= 0, JSON.stringify(st));
  assert.equal(st.error, null);
});

test('file rovinato: il server parte vuoto e lo dice in snapshot.error, senza percorsi', async t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'vessels.json.gz');
  fs.writeFileSync(file, 'non è gzip');
  const s = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => s.stop());
  const st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.store, 'file');
  assert.equal(st.restored, 0);
  assert.match(st.error, /ripristino/);
  assert.ok(!st.error.includes(dir), st.error);
  assert.equal((await s.getJson('/api/status')).vessels, 0);
  // JSON valido ma di un altro formato: nessuna nave, nessun errore
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ format: 'altro', vessels: [[1, { name: 'X', staticTs: Date.now() }]] })));
  const other = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => other.stop());
  assert.equal(await other.getJson('/api/vessel?mmsi=1'), null);
  assert.equal((await other.getJson('/api/status')).snapshot.restored, 0);
});

test('senza SNAPSHOT_FILE nessun salvataggio, store null e uscita immediata a SIGTERM', async t => {
  const s = await startServer({ SNAPSHOT_FILE: '', SNAPSHOT_INTERVAL_MS: '100' });
  t.after(() => s.stop());
  await send(s, staticMsg(247123450, 'NESSUN FILE'));
  const st = (await s.getJson('/api/status')).snapshot;
  assert.deepEqual(st, { store: null, restored: 0, savedAt: null, bytes: null, vessels: null, ms: null, error: null });
  await new Promise(r => setTimeout(r, 250));
  const ms = await timed(() => s.stop());
  assert.ok(ms < 1000, `uscita in ${ms} ms`);
  assert.equal(s.child.exitCode, 0);
});
