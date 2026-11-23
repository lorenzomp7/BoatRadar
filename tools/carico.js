#!/usr/bin/env node
// Carico di lavoro ripetibile per misurare memoria e tempi di server.js (Piano: punti 21, 22, 4).
// Carica server.js NELLO STESSO processo, gli fa arrivare N navi sintetiche da un finto aisstream locale,
// misura memoria e risposte di /api/locations a zoom mondo e zoom porto, poi termina: così
// `node --cpu-prof` / `--heap-prof` (e flameox, che li usa) profilano proprio server.js.
//
//   node tools/carico.js [--navi 30000] [--richieste 100] [--json risultato.json] [--registra "etichetta"]
//
// --registra aggiunge una riga alla tabella di docs/prestazioni.md. Le navi sono generate con un seme
// fisso: due misure con gli stessi parametri usano gli stessi dati. Procedura in docs/prestazioni.md.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const ROOT = path.join(__dirname, '..');
// Porti con navi addensate (30% del totale); le altre sono sparse sui mari.
const PORTS = [
  { name: 'Rotterdam', lat: 51.95, lon: 4.05 }, { name: 'Singapore', lat: 1.26, lon: 103.82 },
  { name: 'Shanghai', lat: 31.35, lon: 121.65 }, { name: 'Genova', lat: 44.40, lon: 8.92 },
  { name: 'Houston', lat: 29.60, lon: -94.95 }, { name: 'Pireo', lat: 37.94, lon: 23.62 },
];
const PORT_BBOX = '3.5,51.7,4.6,52.2';                 // vista porto: Rotterdam
const WORLD_BBOX = '-180,-90,180,90';                  // vista mondo, come la pagina a zoom basso
const TYPES = [70, 70, 70, 80, 80, 60, 30, 37, 52, 0];

function args(argv) {
  const o = { navi: 30000, richieste: 100, json: null, registra: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!(k in o)) throw new Error(`opzione sconosciuta: ${argv[i]}`);
    o[k] = ['navi', 'richieste'].includes(k) ? Number(argv[++i]) : argv[++i];
  }
  if (!(o.navi > 0) || !(o.richieste > 0)) throw new Error('--navi e --richieste devono essere numeri positivi');
  return o;
}

// Generatore pseudo-casuale con seme fisso (mulberry32): stessi dati a ogni misura.
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function* ships(n) {
  const r = rng(20261124);
  for (let i = 0; i < n; i++) {
    const mmsi = 200000000 + i * 37 + Math.floor(r() * 30);
    let lat, lon;
    if (r() < 0.3) {
      const p = PORTS[Math.floor(r() * PORTS.length)];
      lat = p.lat + (r() - 0.5) * 0.4; lon = p.lon + (r() - 0.5) * 0.8;
    } else {
      lat = -60 + r() * 130; lon = -180 + r() * 360;
    }
    const sog = r() < 0.4 ? 0 : Math.round(r() * 220) / 10;
    yield {
      position: { MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: `NAVE ${i}` },
        Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: sog, Cog: Math.round(r() * 3599) / 10,
          NavigationalStatus: sog ? 0 : 5, TrueHeading: Math.floor(r() * 360), Valid: true } } },
      static: { MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi, ShipName: `NAVE ${i}` },
        Message: { ShipStaticData: { Name: `NAVE ${i}`, ImoNumber: 9000000 + i, CallSign: `C${i}`,
          Type: TYPES[i % TYPES.length], Destination: 'PORTO', MaximumStaticDraught: 8.5,
          Dimension: { A: 100, B: 20, C: 10, D: 10 }, Eta: { Month: 12, Day: 1, Hour: 12, Minute: 0 } } } },
    };
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

function request(port, pathname, gzip) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    http.get({ host: '127.0.0.1', port, path: pathname, headers: gzip ? { 'Accept-Encoding': 'gzip' } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const percentile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const mb = b => round(b / 1048576);

async function view(port, bbox, n) {
  const raw = await request(port, `/api/locations?bbox=${bbox}`, false);
  const fc = JSON.parse(raw.body.toString('utf8'));
  const times = [];
  let gz = 0;
  for (let i = 0; i < n; i++) {
    const r = await request(port, `/api/locations?bbox=${bbox}`, true);
    times.push(r.ms); gz = r.body.length;
  }
  return { navi: fc.features.length, totale: fc.total, kb: round(raw.body.length / 1024), kbGzip: round(gz / 1024),
    msMediana: round(percentile(times, 0.5)), msP95: round(percentile(times, 0.95)) };
}

function appendRow(label, res) {
  const file = path.join(ROOT, 'docs', 'prestazioni.md');
  const text = fs.readFileSync(file, 'utf8');
  const marker = '<!-- nuove righe sopra questa linea -->';
  if (!text.includes(marker)) throw new Error(`manca la riga «${marker}» in docs/prestazioni.md`);
  const w = res.mondo, p = res.porto;
  const row = `| ${res.data.slice(0, 10)} | ${label} | ${res.navi} | ${res.memoria.mbOgni1000} | ${res.memoria.rssMb} | ` +
    `${w.navi} | ${w.kbGzip} (${w.kb}) | ${w.msMediana} / ${w.msP95} | ${p.navi} | ${p.kbGzip} (${p.kb}) | ${p.msMediana} / ${p.msP95} | ${res.node} |`;
  fs.writeFileSync(file, text.replace(marker, row + '\n' + marker));
}

async function main(argv) {
  const o = args(argv);
  const list = [...ships(o.navi)];
  const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => fake.on('listening', r));
  const port = await freePort();
  Object.assign(process.env, { PORT: String(port), AISSTREAM_KEY: 'chiave-di-carico',
    AISSTREAM_URL: `ws://127.0.0.1:${fake.address().port}`, RENDER_EXTERNAL_URL: '' });
  delete process.env.NODE_USE_ENV_PROXY;

  const subscribed = new Promise(resolve => fake.on('connection', ws => ws.once('message', () => resolve(ws))));
  const log = console.log; console.log = () => {};      // i messaggi di server.js non servono qui
  require(path.join(ROOT, 'server.js'));
  const ws = await subscribed;

  global.gc?.();
  const before = process.memoryUsage();
  const t0 = Date.now();
  for (const s of list) { ws.send(JSON.stringify(s.position)); ws.send(JSON.stringify(s.static)); }
  for (;;) {
    const st = JSON.parse((await request(port, '/api/status', false)).body);
    if (st.vessels >= o.navi) break;
    if (Date.now() - t0 > 120000) throw new Error(`dopo 2 minuti il server ha solo ${st.vessels} navi su ${o.navi}`);
    await new Promise(r => setTimeout(r, 50));
  }
  const ingestMs = Date.now() - t0;
  global.gc?.();
  const after = process.memoryUsage();

  const res = {
    data: new Date().toISOString(), node: process.version, navi: o.navi, richieste: o.richieste,
    gcEsplicito: typeof global.gc === 'function',
    memoria: { heapMb: mb(after.heapUsed), rssMb: mb(after.rss),
      mbOgni1000: round((after.heapUsed - before.heapUsed) / 1048576 / o.navi * 1000, 2) },
    ricezione: { ms: ingestMs, messaggiAlSecondo: Math.round(o.navi * 2 / (ingestMs / 1000)) },
    mondo: await view(port, WORLD_BBOX, o.richieste),
    porto: await view(port, PORT_BBOX, o.richieste),
  };
  console.log = log;
  const w = res.mondo, p = res.porto;
  console.log([
    `Navi: ${res.navi} (ricevute in ${ingestMs} ms) · Node ${res.node}${res.gcEsplicito ? '' : ' · senza --expose-gc: memoria meno precisa'}`,
    `Memoria: heap ${res.memoria.heapMb} MB, RSS ${res.memoria.rssMb} MB, ${res.memoria.mbOgni1000} MB ogni 1000 navi`,
    `Vista mondo: ${w.navi} navi su ${w.totale}, ${w.kbGzip} KB gzip (${w.kb} KB), ${w.msMediana} ms mediana, ${w.msP95} ms p95`,
    `Vista porto: ${p.navi} navi su ${p.totale}, ${p.kbGzip} KB gzip (${p.kb} KB), ${p.msMediana} ms mediana, ${p.msP95} ms p95`,
  ].join('\n'));
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(res, null, 1) + '\n');
  if (o.registra) { appendRow(o.registra, res); console.log('Riga aggiunta a docs/prestazioni.md'); }
  return res;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), err => { console.error(err.message); process.exit(1); });
}
module.exports = { ships, args, percentile };
