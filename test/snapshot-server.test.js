// Punto 22: server.js con SNAPSHOT_FILE conserva i dati statici delle navi fra un riavvio e l'altro (vero server.js
// contro un finto aisstream). Le funzioni di snapshot.js sono in test/snapshot.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { startServer, waitFor, freePort } = require('./helpers');

// rallenta o fa fallire lettura e salvataggio dello snapshot nel server (test/snapshot-lento.js)
const SLOW = { NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, 'snapshot-lento.js'))}` };

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
  assert.equal(st.restoreError, null);
  assert.equal(st.error, null);
  assert.ok(!JSON.stringify(st).includes(path.dirname(file)), 'nessun percorso in /api/status');
  // senza posizione nessuna delle navi ripristinate è in /api/search: né per nome, né per MMSI, né per IMO
  for (const q of ['LAGUNA PRIMA', 'laguna', '247123450', '9074729', 'IMO 9074729', 'IABC', 'FERMA ACCENTATA', '538001234']) {
    assert.deepEqual(await s.getJson('/api/search?q=' + encodeURIComponent(q)), [], q);
  }
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

test('file rovinato: rinominato .bad, il server parte vuoto e restoreError resta anche dopo un salvataggio', async t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'vessels.json.gz');
  fs.writeFileSync(file, 'non è gzip');
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_INTERVAL_MS: '200' });
  t.after(() => s.stop());
  let st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.store, 'file');
  assert.equal(st.restored, 0);
  assert.equal(st.restoreError, 'file non valido (gzip non valido), rinominato .bad: si riparte vuoti');
  assert.equal((await s.getJson('/api/status')).vessels, 0);
  assert.equal(fs.readFileSync(file + '.bad', 'utf8'), 'non è gzip', 'il file di prima resta da guardare');
  await send(s, staticMsg(247123450, 'DOPO'));
  await waitFor(() => fs.existsSync(file) && readSnapshot(file).vessels.length === 1, 'salvataggio nuovo');
  await waitFor(async () => (await s.getJson('/api/status')).snapshot.savedAt > 0, 'stato del salvataggio');
  st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.error, null);
  assert.match(st.restoreError, /gzip non valido/, 'il problema del ripristino non sparisce dopo il primo salvataggio');
  assert.ok(!st.restoreError.includes(dir));
});

test('JSON valido di un altro formato o versione: nessuna nave, file rinominato .bad', async t => {
  const file = path.join(tmpDir(t), 'vessels.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ format: 'boatradar-vessels', version: 2, vessels: [[1, { name: 'X', staticTs: Date.now() }]] })));
  const s = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => s.stop());
  assert.equal(await s.getJson('/api/vessel?mmsi=1'), null);
  const st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.restored, 0);
  assert.match(st.restoreError, /formato o versione sconosciuti/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(file + '.bad'));
});

test('file oltre 16 MB: scartato con stat, senza leggerlo, e rinominato .bad', async t => {
  const file = path.join(tmpDir(t), 'vessels.json.gz');
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, 16 * 1024 * 1024 + 1);   // sparso: niente spazio vero su disco
  const s = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => s.stop());
  assert.equal((await s.getJson('/api/status')).snapshot.restoreError, 'file non valido (file oltre 16 MB), rinominato .bad: si riparte vuoti');
  assert.equal(fs.statSync(file + '.bad').size, 16 * 1024 * 1024 + 1);
});

test('gzip piccolo con decine di milioni di a capo: niente memoria esaurita, il server parte e il file diventa .bad', async t => {
  const file = path.join(tmpDir(t), 'vessels.json.gz');
  // 80 MB di '\n' (oltre il tetto di 64 MB del decompresso) in circa 80 KB di gzip, scritti a pezzi
  const gz = zlib.createGzip({ level: 9 }), out = [];
  gz.on('data', c => out.push(c));
  const chunk = Buffer.alloc(1024 * 1024, 0x0a);
  for (let i = 0; i < 80; i++) gz.write(chunk);
  await new Promise(r => gz.end(r));
  const bomb = Buffer.concat(out);
  assert.ok(bomb.length < 200 * 1024, `${bomb.length} byte`);
  fs.writeFileSync(file, bomb);
  const s = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => s.stop());
  const st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.restoreError, 'file non valido (decompresso oltre 64 MB), rinominato .bad: si riparte vuoti');
  assert.ok(fs.existsSync(file + '.bad'));
  // e con meno di 64 MB ma milioni di righe vuote: errore alla prima riga vuota, senza dividere il testo
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([Buffer.from('{"format":"boatradar-vessels","version":1,"vessels":[\n'), Buffer.alloc(20 * 1024 * 1024, 0x0a)])));
  const again = await startServer({ SNAPSHOT_FILE: file });
  t.after(() => again.stop());
  assert.match((await again.getJson('/api/status')).snapshot.restoreError, /riga vuota/);
});

test('lettura fallita per I/O (EIO): il file resta com\'è e non si salva più, né a intervalli né a SIGTERM', async t => {
  const file = path.join(tmpDir(t), 'vessels.json.gz');
  writeSnapshot(file, [[247123450, { name: 'BUONA', staticTs: Date.now() - 60000 }]]);
  const before = fs.readFileSync(file);
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_INTERVAL_MS: '100', SNAPSHOT_TEST_LOAD_ERROR: 'EIO', ...SLOW });
  t.after(() => s.stop());
  const st = (await s.getJson('/api/status')).snapshot;
  assert.equal(st.restoreError, 'lettura non riuscita (EIO): file lasciato com\'è, nessun salvataggio fino al riavvio');
  assert.ok(!st.restoreError.includes(path.dirname(file)));
  await send(s, staticMsg(538001234, 'ARRIVATA DOPO'));
  await new Promise(r => setTimeout(r, 400));
  const ms = await timed(() => s.stop());
  assert.ok(ms < 2000, `uscita in ${ms} ms`);
  assert.equal(s.child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(file), before, 'file buono intatto');
  assert.equal(fs.existsSync(file + '.bad'), false);
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('ripristino lento: dopo SNAPSHOT_RESTORE_MS il server si collega comunque, non salva prima della fine, poi le navi si uniscono', async t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'vessels.json.gz'), gate = path.join(dir, 'apri');
  const now = Date.now();
  writeSnapshot(file, [[247123450, { name: 'NOME VECCHIO', shipType: 70, destination: 'VENEZIA', staticTs: now - 3600000 }]]);
  const before = fs.readFileSync(file);
  const t0 = Date.now();
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_RESTORE_MS: '300', SNAPSHOT_INTERVAL_MS: '100', LOCATIONS_CACHE_MS: '0',
    SNAPSHOT_TEST_GATE_LOAD: gate, ...SLOW });
  t.after(() => s.stop());
  // tetto: la sottoscrizione arriva con la lettura ancora ferma
  assert.ok(Date.now() - t0 >= 300, 'non prima del tetto');
  assert.match(s.log(), /test: lettura in attesa/);
  assert.match(s.log(), /ripristino oltre 300 ms, mi collego ad aisstream intanto/);
  assert.equal((await s.getJson('/api/status')).snapshot.restored, 0);
  // nel frattempo una posizione con solo MetaData.ShipName (nessun dato statico): nome nuovo, tipo ancora sconosciuto
  await send(s, { MetaData: { MMSI: 247123450, ShipName: 'NOME NUOVO' },
    Message: { PositionReport: { Latitude: 45.4, Longitude: 12.3, Sog: 5, Cog: 90, NavigationalStatus: 0 } } });
  const props = async () => (await s.getJson('/api/locations')).features.find(f => f.properties.mmsi === 247123450).properties;
  assert.equal((await props()).name, 'NOME NUOVO');
  assert.equal((await props()).shipType, undefined);
  const hits = (await s.getJson('/api/status')).locationsCache.hits;
  assert.equal((await props()).shipType, undefined);
  assert.equal((await s.getJson('/api/status')).locationsCache.hits, hits + 1, 'a dati fermi la risposta è in cache');
  // salvataggi a intervalli già partiti, ma nessuno prima della fine del ripristino
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(fs.readFileSync(file), before, 'file non sovrascritto durante il ripristino');
  assert.equal(fs.existsSync(file + '.tmp'), false);
  fs.writeFileSync(gate, '');
  await waitFor(async () => (await s.getJson('/api/status')).snapshot.restored === 1, 'ripristino finito');
  // dataVersion++: la cache di /api/locations non vale più e la nave ha il tipo del file, con il nome appena arrivato
  const after = await props();
  assert.equal(after.shipType, 70);
  assert.equal(after.name, 'NOME NUOVO');
  const v = await s.getJson('/api/vessel?mmsi=247123450');
  assert.equal(v.name, 'NOME NUOVO');
  assert.equal(v.destination, 'VENEZIA');
  await waitFor(() => !fs.readFileSync(file).equals(before), 'primo salvataggio dopo il ripristino');
  await waitFor(() => readSnapshot(file).vessels[0]?.[1].name === 'NOME NUOVO', 'salvato con il nome nuovo');
});

test('segnale durante il ripristino: esce subito senza salvare', async t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'vessels.json.gz');
  writeSnapshot(file, [[247123450, { name: 'INTATTA', staticTs: Date.now() - 60000 }]]);
  const before = fs.readFileSync(file);
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_EXIT_MS: '20000', SNAPSHOT_TEST_GATE_LOAD: path.join(dir, 'mai'), ...SLOW },
    {}, { subscribe: false });
  t.after(() => s.stop());
  await waitFor(() => /test: lettura in attesa/.test(s.log()), 'lettura ferma');
  const ms = await timed(async () => { s.child.kill('SIGTERM'); await s.exited; });
  assert.ok(ms < 2000, `uscita in ${ms} ms`);
  assert.equal(s.child.exitCode, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.doesNotMatch(s.log(), /salvo i dati statici/);
});

test('secondo segnale durante il salvataggio finale: esce subito, senza aspettare SNAPSHOT_EXIT_MS', async t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'vessels.json.gz');
  const s = await startServer({ SNAPSHOT_FILE: file, SNAPSHOT_INTERVAL_MS: '3600000', SNAPSHOT_EXIT_MS: '20000',
    SNAPSHOT_TEST_GATE_SAVE: path.join(dir, 'mai'), ...SLOW });
  t.after(() => s.stop());
  await send(s, staticMsg(247123450, 'LAGUNA PRIMA'));
  s.child.kill('SIGTERM');
  await waitFor(() => /test: salvataggio in attesa/.test(s.log()), 'salvataggio finale fermo');
  assert.match(s.log(), /SIGTERM: salvo i dati statici prima di uscire/);
  assert.equal(s.child.exitCode, null, 'il primo segnale aspetta il salvataggio');
  const ms = await timed(async () => { s.child.kill('SIGINT'); await s.exited; });
  assert.ok(ms < 2000, `uscita in ${ms} ms`);
  assert.equal(s.child.exitCode, 0);
  assert.equal(fs.existsSync(file), false, 'nessun file scritto');
});

test('i test e lo smoke-server non usano SNAPSHOT_* dell\'ambiente (lo snapshot dello sviluppatore resta com\'è)', async t => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'dello-sviluppatore.json.gz');
  const saved = { SNAPSHOT_FILE: process.env.SNAPSHOT_FILE, SNAPSHOT_INTERVAL_MS: process.env.SNAPSHOT_INTERVAL_MS };
  Object.assign(process.env, { SNAPSHOT_FILE: file, SNAPSHOT_INTERVAL_MS: '100' });
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const s = await startServer();
  t.after(() => s.stop());
  await send(s, staticMsg(247123450, 'DI PROVA'));
  assert.equal((await s.getJson('/api/status')).snapshot.store, null);
  await s.stop();
  assert.equal(fs.existsSync(file), false, 'startServer');
  // tools/smoke-server.js
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'smoke-server.js'), String(port)],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await waitFor(() => /pronto http/.test(out), 'smoke-server pronto', 15000);
  const st = await new Promise((resolve, reject) => require('node:http').get({ host: '127.0.0.1', port, path: '/api/status', agent: false }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject));
  assert.equal(st.snapshot.store, null);
  await new Promise(r => setTimeout(r, 300));
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
  assert.equal(fs.existsSync(file), false, 'smoke-server');
});

test('senza SNAPSHOT_FILE nessun salvataggio, store null e uscita immediata a SIGTERM', async t => {
  const s = await startServer({ SNAPSHOT_FILE: '', SNAPSHOT_INTERVAL_MS: '100' });
  t.after(() => s.stop());
  await send(s, staticMsg(247123450, 'NESSUN FILE'));
  const st = (await s.getJson('/api/status')).snapshot;
  assert.deepEqual(st, { store: null, restored: 0, restoreError: null, savedAt: null, bytes: null, vessels: null, ms: null, error: null });
  await new Promise(r => setTimeout(r, 250));
  const ms = await timed(() => s.stop());
  assert.ok(ms < 1000, `uscita in ${ms} ms`);
  assert.equal(s.child.exitCode, 0);
});
