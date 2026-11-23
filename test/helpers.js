// Supporto per i test che avviano un server.js tutto loro contro un finto aisstream locale
// (proxy di diagnosi, messaggi registrati). Non è un file di test: npm test esegue solo *.test.js.
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('timeout in attesa di: ' + what);
}

// Avvia server.js contro un finto aisstream. env si aggiunge a quello del processo; le variabili
// di proxy dell'ambiente vengono tolte, così i test non dipendono dalla macchina che li esegue.
// aisOptions va al finto aisstream (es. { perMessageDeflate: true } per accettare la compressione).
async function startServer(env = {}, aisOptions = {}) {
  const fakeAis = new WebSocketServer({ port: 0, ...aisOptions });
  const connected = new Promise(resolve => fakeAis.on('connection', ws => {
    ws.once('message', data => resolve({ socket: ws, subscription: JSON.parse(data.toString()) }));
  }));
  const port = await freePort();
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(https?|no|all)_proxy$|^NODE_USE_ENV_PROXY$/i.test(k)) delete base[k];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...base, PORT: String(port), AISSTREAM_KEY: 'chiave-di-test',
      AISSTREAM_URL: `ws://127.0.0.1:${fakeAis.address().port}`, RENDER_EXTERNAL_URL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const get = pathname => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const getJson = async p => JSON.parse((await get(p)).body.toString('utf8'));

  await waitFor(() => get('/api/status').then(() => true, () => false), 'server in ascolto');
  const { socket, subscription } = await connected;
  return {
    fakeAis, socket, subscription, get, getJson, log: () => log,
    stop() { child.kill(); fakeAis.close(); },
  };
}

module.exports = { freePort, waitFor, startServer };
