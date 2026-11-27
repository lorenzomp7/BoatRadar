#!/usr/bin/env node
// Avvia il vero server.js contro un finto aisstream locale che gli invia i messaggi di una fixture,
// senza chiave e senza rete: serve alla verifica nel browser (tools/smoke-browser.sh) e alla misura della pagina
// (tools/misura-pagina.sh).
//
//   node tools/smoke-server.js [porta] [fixture] [--navi N]   (default 8799, test/fixtures/aisstream-esempio.json)
//
// I messaggi si ripetono ogni 20 s; le navi con velocità e rotta valide (punti 13, 42) si spostano coerenti con SOG e
// COG (lossodromia, rhumbDestination di public/ais-logic.js) per il tempo passato dalla prima ripetizione, così la
// pagina riceve fix veri che si susseguono come in mare. Con --navi N, al posto della fixture, le N navi sintetiche di
// tools/carico.js (stesso seme a ogni avvio), anch'esse in movimento.
// Scrive «pronto http://127.0.0.1:<porta>» quando la pagina ha dati; si ferma con Ctrl+C o SIGTERM.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { isAnomalous } = require('./estrai-fixture');
const { rhumbDestination, KN } = require('../public/ais-logic');

const ROOT = path.join(__dirname, '..');
const POSITION = /PositionReport$/;
// Posizione del messaggio m dopo ms millisecondi: spostato lungo la COG alla SOG (solo con entrambe valide e SOG > 0),
// in un messaggio nuovo (l'originale resta com'era)
function moved(m, ms) {
  const type = Object.keys(m.Message || {})[0] || '', body = m.Message[type];
  if (!POSITION.test(type) || !body) return m;
  const { Sog: sog, Cog: cog, Latitude: lat, Longitude: lon } = body;
  if (!(sog > 0 && sog < 102.3 && cog >= 0 && cog < 360 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || ms <= 0) return m;
  const to = rhumbDestination(lat, lon, cog, sog * KN * ms / 1000);
  const meta = m.MetaData && { ...m.MetaData, ...(m.MetaData.latitude != null && { latitude: to.lat }),
    ...(m.MetaData.longitude != null && { longitude: to.lon }) };
  return { ...m, ...(meta && { MetaData: meta }), Message: { [type]: { ...body, Latitude: to.lat, Longitude: to.lon } } };
}
function main() {
  const argv = process.argv.slice(2), at = argv.indexOf('--navi');
  const navi = at >= 0 ? Number(argv.splice(at, 2)[1]) : 0;
  if (at >= 0 && !(navi > 0)) { console.error('--navi vuole un numero positivo'); process.exit(2); }
  const port = Number(argv[0]) || 8799;
  const fixture = path.resolve(argv[1] || path.join(ROOT, 'test', 'fixtures', 'aisstream-esempio.json'));
  const messaggi = navi ? [...require('./carico').ships(navi)].flatMap(s => [s.position, s.static])
    : JSON.parse(fs.readFileSync(fixture, 'utf8')).messaggi;
  let firstSend = null;
  const send = ws => {
    const now = Date.now();
    firstSend ??= now;
    for (const m of messaggi) ws.send(JSON.stringify(moved(m, now - firstSend)));
  };

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

  // pronto quando /api/status conta le navi della fixture con una posizione valida (quelle anomale
  // possono essere scartate dal server, punto 1 del Piano); al massimo 15 s in tutto (60 s con --navi)
  const READY_MS = navi ? 60000 : 15000;
  const expected = new Set(messaggi.filter(m => POSITION.test(Object.keys(m.Message || {})[0] || '') && !isAnomalous(m))
    .map(m => m.MetaData?.MMSI)).size;
  function waitReady() {
    const started = Date.now();
    (function poll() {
      if (Date.now() - started > READY_MS) { console.error(`server.js non ha ricevuto le ${expected} navi della fixture in ${READY_MS / 1000} s`); stop(1); }
      http.get({ host: '127.0.0.1', port, path: '/api/status', agent: false }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try { if (JSON.parse(body).vessels >= expected) return console.log(`pronto http://127.0.0.1:${port}`); } catch { /* riprova */ }
          setTimeout(poll, 100);
        });
      }).on('error', () => setTimeout(poll, 100));
    })();
  }
}

if (require.main === module) main();
module.exports = { moved };
