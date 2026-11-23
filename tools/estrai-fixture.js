#!/usr/bin/env node
// Estrae da una sessione registrata con Proxelar (formato nativo .proxelar.json, versione 3) i messaggi
// che aisstream ha inviato a server.js e li salva come fixture per i test, senza la chiave.
// Stampa anche le misure della connessione: messaggi al secondo, peso medio, tipi di messaggio.
//
//   node tools/estrai-fixture.js diagnosi/aisstream.proxelar.json
//   node tools/estrai-fixture.js diagnosi/aisstream.proxelar.json --out test/fixtures/aisstream-porto.json --max 80
//
// Procedura completa in AGENTS.md, sezione «Diagnosi».
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const POSITION_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'];

// Minimo e massimo con un ciclo: Math.min(...xs) va in errore oltre circa 100.000 valori.
function range(xs) {
  let min = Infinity, max = -Infinity;
  for (const x of xs) if (Number.isFinite(x)) { if (x < min) min = x; if (x > max) max = x; }
  return min <= max ? { min, max } : null;
}

// Proxelar serializza il contenuto dei frame come array di byte; per prudenza accetta anche testo o base64.
function payloadText(payload) {
  if (Array.isArray(payload)) return Buffer.from(payload).toString('utf8');
  if (typeof payload !== 'string') return '';
  if (/^[\s{[]/.test(payload)) return payload;
  return Buffer.from(payload, 'base64').toString('utf8');
}

function headerValue(headers, name) {
  name = name.toLowerCase();
  if (Array.isArray(headers)) {
    const h = headers.find(x => String(x.name).toLowerCase() === name);
    if (!h) return null;
    return h.value ?? (h.value_base64 ? Buffer.from(h.value_base64, 'base64').toString('utf8') : null);
  }
  if (headers && typeof headers === 'object') {
    const k = Object.keys(headers).find(x => x.toLowerCase() === name);
    return k ? String(headers[k]) : null;
  }
  return null;
}

// Toglie la chiave ovunque compaia (anche se aisstream la ripetesse in una risposta).
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = /^api_?key$/i.test(k) ? '[rimossa]' : redact(v);
    return out;
  }
  return value;
}

function messageType(msg) {
  if (msg.error) return 'error';
  if (msg.MessageType) return msg.MessageType;
  const keys = Object.keys(msg.Message || {});
  return keys[0] || Object.keys(msg).find(k => k !== 'MetaData') || 'sconosciuto';
}

// Posizione che il server dovrebbe scartare (punto 1 del Piano): valori AIS «non disponibile», 0,0, fuori scala.
function isAnomalous(msg) {
  const m = msg.Message || {};
  const pos = POSITION_TYPES.map(t => m[t]).find(Boolean);
  if (!pos) return false;
  const { Latitude: lat, Longitude: lon } = pos;
  return pos.Valid === false || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || (lat === 0 && lon === 0);
}

// Legge la sessione e restituisce le connessioni verso aisstream con i frame inviati dal server.
function readSession(session) {
  if (session?.version !== 3 || !Array.isArray(session.websockets)) {
    throw new Error('serve una sessione nativa di Proxelar versione 3 (salvata con --save-session)');
  }
  const all = session.websockets;
  const ais = all.filter(w => /aisstream/i.test(String(w.request?.uri || '')));
  return (ais.length ? ais : all).map(w => ({
    uri: String(w.request?.uri || ''),
    offered: headerValue(w.request?.headers, 'sec-websocket-extensions'),
    accepted: headerValue(w.response?.headers, 'sec-websocket-extensions'),
    frames: (w.frames || []).filter(f => f.direction === 'ServerToClient' && (f.opcode === 'Text' || f.opcode === 'Binary')),
  }));
}

function measure(connections) {
  const frames = connections.flatMap(c => c.frames);
  const types = {};
  let bytes = 0, anomalous = 0, invalid = 0;
  for (const f of frames) {
    const text = payloadText(f.payload);
    bytes += Buffer.byteLength(text);
    try {
      const msg = JSON.parse(text);
      types[messageType(msg)] = (types[messageType(msg)] || 0) + 1;
      if (isAnomalous(msg)) anomalous++;
    } catch { invalid++; }
  }
  const span = range(frames.map(f => f.time));
  const seconds = span ? (span.max - span.min) / 1000 : 0;
  return {
    connections: connections.length,
    messages: frames.length,
    seconds: Math.round(seconds),
    perSecond: seconds > 0 ? Math.round(frames.length / seconds * 10) / 10 : null,
    avgBytes: frames.length ? Math.round(bytes / frames.length) : 0,
    kbPerSecond: seconds > 0 ? Math.round(bytes / seconds / 1024 * 10) / 10 : null,
    truncated: frames.filter(f => f.truncated).length,
    invalid, anomalous, types,
    offered: connections.map(c => c.offered).find(Boolean) || null,
    accepted: connections.map(c => c.accepted).find(Boolean) || null,
  };
}

// Sceglie fino a max messaggi: prima le posizioni anomale (fino a max), poi i tipi rari e il resto in proporzione,
// mantenendo l'ordine di arrivo (i test li rimandano nello stesso ordine).
function pick(connections, max = 100) {
  const parsed = [];
  for (const f of connections.flatMap(c => c.frames)) {
    if (f.truncated) continue;
    try { parsed.push(JSON.parse(payloadText(f.payload))); } catch { /* frame non JSON: escluso */ }
  }
  const chosen = new Set();
  const byType = new Map();
  parsed.forEach((m, i) => {
    if (isAnomalous(m)) chosen.add(i);
    const t = messageType(m);
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(i);
  });
  // a turno un messaggio per tipo, finché c'è posto
  const queues = [...byType.values()].map(list => [...list]);
  while (chosen.size < Math.min(max, parsed.length) && queues.some(q => q.length)) {
    for (const q of queues) {
      while (q.length && chosen.has(q[0])) q.shift();
      if (q.length && chosen.size < max) chosen.add(q.shift());
    }
  }
  return [...chosen].sort((a, b) => a - b).slice(0, max).map(i => redact(parsed[i]));
}

function report(file, m) {
  const lines = [
    `Sessione: ${file}`,
    `Connessioni verso aisstream: ${m.connections}`,
    `Messaggi ricevuti: ${m.messages} in ${m.seconds} s (${m.perSecond ?? '?'} al secondo, ${m.kbPerSecond ?? '?'} KB/s)`,
    `Peso medio di un messaggio: ${m.avgBytes} byte (non compresso)`,
    `Tipi: ${Object.entries(m.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || 'nessuno'}`,
    `Posizioni anomale (lat/lon non valide o 0,0): ${m.anomalous}`,
  ];
  if (m.truncated) lines.push(`Frame troncati da Proxelar (esclusi dalla fixture): ${m.truncated}`);
  if (m.invalid) lines.push(`Frame non JSON: ${m.invalid}`);
  lines.push(`Sec-WebSocket-Extensions offerto da server.js: ${m.offered || 'nessuno'}; accettato verso aisstream: ${m.accepted || 'nessuno'}`,
    'Nota: Proxelar toglie l\'offerta di compressione verso aisstream, quindi via proxy la connessione è sempre',
    'non compressa. La compressione reale la scrive server.js nel log («connesso (compressione: sì/no)»).');
  return lines.join('\n');
}

function main(argv) {
  const args = [...argv];
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const out = opt('--out');
  const maxArg = opt('--max');
  const max = maxArg === undefined ? 100 : Number(maxArg);
  const overwrite = args.includes('--sovrascrivi');
  if (overwrite) args.splice(args.indexOf('--sovrascrivi'), 1);
  const file = args[0];
  if (!Number.isInteger(max) || max < 1) {
    console.error('--max deve essere un numero intero positivo');
    return 2;
  }
  if (!file) {
    console.error('uso: node tools/estrai-fixture.js <sessione.proxelar.json> [--out test/fixtures/aisstream-<nome>.json] [--max 100] [--sovrascrivi]');
    return 2;
  }
  const connections = readSession(JSON.parse(fs.readFileSync(file, 'utf8')));
  const m = measure(connections);
  console.log(report(file, m));
  const messages = pick(connections, max);
  if (!messages.length) {
    console.error('nessun messaggio di aisstream nella sessione: non salvo una fixture vuota');
    return 1;
  }
  const dest = out || path.join(__dirname, '..', 'test', 'fixtures', `aisstream-${new Date().toISOString().slice(0, 10)}.json`);
  if (!/(^|[\\/])aisstream-[^\\/]+\.json$/.test(dest)) {
    console.error('il file di uscita deve chiamarsi aisstream-<nome>.json, così il test delle fixture lo trova');
    return 2;
  }
  if (fs.existsSync(dest) && !overwrite) {
    console.error(`${dest} esiste già: scegli un altro --out o aggiungi --sovrascrivi`);
    return 2;
  }
  const text = JSON.stringify({
    fonte: 'aisstream.io registrato con Proxelar (tools/estrai-fixture.js)',
    registrato: new Date(range(connections.flatMap(c => c.frames.map(f => f.time)))?.min ?? Date.now()).toISOString(),
    misure: m,
    messaggi: messages,
  }, null, 1) + '\n';
  // controllo finale: nessun campo APIKey e nessuna traccia della chiave vera, se è su questa macchina
  let key = process.env.AISSTREAM_KEY?.trim();
  if (!key) try { key = fs.readFileSync(path.join(__dirname, '..', 'aisstream-key.txt'), 'utf8').trim(); } catch { /* nessuna chiave locale */ }
  if (/"api_?key"\s*:\s*"(?!\[rimossa\])/i.test(text) || (key && key.length >= 8 && text.includes(key))) {
    console.error('la fixture sembra contenere ancora la chiave: non la salvo');
    return 1;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  console.log(`\nFixture salvata: ${path.relative(process.cwd(), dest)} (${messages.length} messaggi)`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { range, payloadText, headerValue, redact, messageType, isAnomalous, readSession, measure, pick, report, main };
