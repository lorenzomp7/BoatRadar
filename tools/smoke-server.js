#!/usr/bin/env node
// Avvia il vero server.js contro un finto aisstream locale che gli invia i messaggi di una fixture,
// senza chiave e senza rete: serve alla verifica nel browser (tools/smoke-browser.sh).
//
//   node tools/smoke-server.js [porta] [fixture]    (default 8799, test/fixtures/aisstream-esempio.json)
//
// Scrive «pronto http://127.0.0.1:<porta>» quando la pagina ha dati; si ferma con Ctrl+C o SIGTERM.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');
const port = Number(process.argv[2]) || 8799;
const fixture = path.resolve(process.argv[3] || path.join(ROOT, 'test', 'fixtures', 'aisstream-esempio.json'));
const { messaggi } = JSON.parse(fs.readFileSync(fixture, 'utf8'));
const send = ws => { for (const m of messaggi) ws.send(JSON.stringify(m)); };

let server = null;
const fakeAis = new WebSocketServer({ port: 0, host: '127.0.0.1' });
fakeAis.on('connection', ws => ws.once('message', () => {
  send(ws);
  // ripete i messaggi ogni 20 s, così le navi non scadono e il server non riapre la connessione
  const timer = setInterval(() => send(ws), 20000);
  ws.on('close', () => clearInterval(timer));
}));

const stop = code => { server?.kill(); fakeAis.close(); process.exit(code); };
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

fakeAis.on('listening', () => {
  const env = { ...process.env, PORT: String(port), AISSTREAM_KEY: 'chiave-di-prova',
    AISSTREAM_URL: `ws://127.0.0.1:${fakeAis.address().port}`, RENDER_EXTERNAL_URL: '' };
  delete env.NODE_USE_ENV_PROXY;
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  server.on('exit', code => { console.error(`server.js terminato (codice ${code})`); fakeAis.close(); process.exit(1); });
  waitReady();
});

// pronto quando /api/status conta tutte le navi della fixture che hanno una posizione
const expected = new Set(messaggi.filter(m => /PositionReport$/.test(Object.keys(m.Message || {})[0] || ''))
  .map(m => m.MetaData?.MMSI)).size;
function waitReady() {
  const started = Date.now();
  (function poll() {
    http.get(`http://127.0.0.1:${port}/api/status`, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { if (JSON.parse(body).vessels >= expected) return console.log(`pronto http://127.0.0.1:${port}`); } catch { /* riprova */ }
        setTimeout(poll, 100);
      });
    }).on('error', () => {
      if (Date.now() - started > 15000) { console.error('server.js non risponde'); stop(1); }
      setTimeout(poll, 100);
    });
  })();
}
