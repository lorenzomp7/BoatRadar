// Dati statici delle navi fra un riavvio e l'altro (punto 22). Funzioni senza dipendenze usate da server.js:
// serialize scrive i dati statici recenti a blocchi (il ciclo degli eventi gira fra un blocco e l'altro), encode li
// comprime con gzip, decode e restore li rileggono validando ogni campo (un file rovinato o di un'altra versione non
// fa mai cadere il server: al massimo parte vuoto), merge li unisce allo stato in memoria. La destinazione è solo un
// file (SNAPSHOT_FILE, sulla VM un volume Docker): su Render Free, senza disco persistente, il server parte vuoto.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const FORMAT = 'boatradar-vessels';
const VERSION = 1;
const MAX_AGE_MS = 48 * 3600 * 1000;       // come la conservazione dei dati statici in server.js
const FUTURE_MS = 5 * 60000;               // orologio della macchina che ha scritto il file un po' avanti
const MAX_TEXT = 64;
const MAX_INFLATED = 256 * 1024 * 1024;    // tetto del JSON decompresso (circa 11 MB per 50.000 navi)
const SNAPSHOT_FIELDS = ['name', 'imo', 'callSign', 'shipType', 'destination', 'draught', 'length', 'width', 'eta', 'staticTs'];

// solo i dati statici di una nave, senza i valori mancanti (null o undefined)
function pickStatic(v) {
  const out = {};
  for (const f of SNAPSHOT_FIELDS) if (v[f] != null) out[f] = v[f];
  return out;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// AsyncIterable di stringhe che unite danno {"format","version","savedAt","vessels":[[mmsi,{…}],…]}: solo le navi con
// staticTs più recente di maxAgeMs, ordinate per staticTs (dalla più vecchia), `batch` navi per stringa e un
// setImmediate fra un blocco e l'altro. stats.vessels = navi scritte. Ogni stringa finisce su una riga sua
// (intestazione, un blocco per riga, «]}»): il file resta un JSON qualunque, ma restoreBuffer lo rilegge a righe.
async function* serialize(vessels, { now = Date.now(), maxAgeMs = MAX_AGE_MS, batch = 1000, stats = {} } = {}) {
  const since = now - maxAgeMs;
  const list = [];
  for (const [mmsi, v] of vessels) if (Number.isFinite(v?.staticTs) && v.staticTs > since) list.push([mmsi, v]);
  list.sort((a, b) => a[1].staticTs - b[1].staticTs || a[0] - b[0]);
  stats.vessels = list.length;
  yield `{"format":${JSON.stringify(FORMAT)},"version":${VERSION},"savedAt":${JSON.stringify(now)},"vessels":[\n`;
  for (let i = 0; i < list.length; i += batch) {
    if (i > 0) await tick();
    const part = list.slice(i, i + batch).map(([mmsi, v]) => JSON.stringify([mmsi, pickStatic(v)])).join(',');
    yield (i > 0 ? ',' : '') + part + '\n';
  }
  yield ']}';
}

// stringhe (anche asincrone) → Buffer gzip, compresso a pezzi nel thread pool
async function encode(chunks) {
  const out = [];
  await pipeline(Readable.from(chunks), zlib.createGzip(), async function (gz) { for await (const c of gz) out.push(c); });
  return Buffer.concat(out);
}

// Buffer gzip → oggetto; gzip o JSON rovinati = errore (chi chiama parte vuoto)
const gunzip = promisify(zlib.gunzip);
const inflate = async buf => (await gunzip(buf, { maxOutputLength: MAX_INFLATED })).toString('utf8');
async function decode(buf) {
  return JSON.parse(await inflate(buf));
}

const isInt = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const inRange = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const text = x => typeof x === 'string' && x.length <= MAX_TEXT;
// ETA come etaOf di server.js (già nella forma salvata): mese e giorno validi, ora e minuto validi o null
function etaOf(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !isInt(e.month, 1, 12) || !isInt(e.day, 1, 31)) return null;
  return { month: e.month, day: e.day, hour: isInt(e.hour, 0, 23) ? e.hour : null, minute: isInt(e.minute, 0, 59) ? e.minute : null };
}

// Una voce [mmsi, {…}] del file → [mmsi, nave] con solo i campi validi, oppure null se la voce non vale
function entryOf(e, since, until) {
  if (!Array.isArray(e) || e.length !== 2) return null;
  const [mmsi, s] = e;
  if (!isInt(mmsi, 1, 999999999) || !s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!inRange(s.staticTs, -Infinity, until) || !(s.staticTs > since)) return null;
  const v = { mmsi };
  for (const f of ['name', 'callSign', 'destination']) if (text(s[f])) v[f] = s[f];
  if (isInt(s.imo, 1000000, 9999999)) v.imo = s.imo;
  if (isInt(s.shipType, 0, 99)) v.shipType = s.shipType;
  if (inRange(s.draught, 0, 25.5)) v.draught = s.draught;
  if (inRange(s.length, 1, 1023)) v.length = s.length;
  if (inRange(s.width, 1, 126)) v.width = s.width;
  if ('eta' in s) v.eta = etaOf(s.eta);
  v.staticTs = s.staticTs;
  return [mmsi, v];
}

// Raccoglie le voci valide: un MMSI una volta sola, con i dati più recenti; result() al massimo `max`, le più recenti
function collector({ now = Date.now(), maxAgeMs = MAX_AGE_MS, max = 500000 } = {}) {
  const since = now - maxAgeMs, until = now + FUTURE_MS, out = new Map();
  return {
    add(e) {
      const r = entryOf(e, since, until);
      if (r && !(out.get(r[0])?.staticTs >= r[1].staticTs)) out.set(r[0], r[1]);
    },
    result() {
      const list = [...out];
      return list.length > max ? list.sort((a, b) => b[1].staticTs - a[1].staticTs).slice(0, max) : list;
    },
  };
}
const knownHeader = o => !!o && typeof o === 'object' && o.format === FORMAT && o.version === VERSION;

// Oggetto letto dal file → [[mmsi, nave]] validate (al massimo `max`, le più recenti; un MMSI una volta sola, con i
// dati più recenti). Formato o versione sconosciuti, o qualunque altro problema, = []. Mai eccezioni.
function restore(obj, opts = {}) {
  try {
    if (!knownHeader(obj) || !Array.isArray(obj.vessels)) return [];
    const c = collector(opts);
    for (const e of obj.vessels) c.add(e);
    return c.result();
  } catch {
    return [];
  }
}

// Come decode + restore, ma un file scritto da serialize si rilegge una riga (un blocco di navi) alla volta, con un
// setImmediate fra una riga e l'altra: con decine di migliaia di navi JSON.parse e convalida di tutto il file in un
// colpo fermerebbero il ciclo degli eventi per circa 100 ms. Un altro JSON valido si legge intero. gzip o JSON rovinati
// = errore; formato o versione sconosciuti = [].
async function restoreBuffer(buf, opts = {}) {
  const text = await inflate(buf);
  const lines = text.split('\n');
  let head = null;
  if (lines.length >= 2 && lines[lines.length - 1] === ']}') {
    try { head = JSON.parse(lines[0] + ']}'); } catch { head = null; }
  }
  if (!knownHeader(head) || !Array.isArray(head.vessels) || head.vessels.length) return restore(JSON.parse(text), opts);
  const c = collector(opts);
  for (let i = 1; i < lines.length - 1; i++) {
    if (i > 1) await tick();
    for (const e of JSON.parse('[' + lines[i].replace(/^,/, '') + ']')) c.add(e);
  }
  return c.result();
}

// Unisce le navi del file a vessels (Map mmsi -> nave): una nave entra solo se in memoria non ci sono già dati statici
// almeno altrettanto recenti (il ripristino può finire dopo i primi messaggi di aisstream). onRestored(mmsi, v) per
// ognuna; restituisce quante. mergeBatched fa lo stesso a blocchi di `batch` navi, con un setImmediate fra l'uno e l'altro.
function merge(vessels, list, onRestored = () => {}) {
  let n = 0;
  for (const [mmsi, s] of list) {
    let v = vessels.get(mmsi);
    if (v?.staticTs >= s.staticTs) continue;
    if (!v) { v = { mmsi }; vessels.set(mmsi, v); }
    Object.assign(v, s, { mmsi });
    onRestored(mmsi, v);
    n++;
  }
  return n;
}
async function mergeBatched(vessels, list, onRestored, { batch = 1000 } = {}) {
  let n = 0;
  for (let i = 0; i < list.length; i += batch) {
    if (i > 0) await tick();
    n += merge(vessels, list.slice(i, i + batch), onRestored);
  }
  return n;
}

// File locale: load() → Buffer, o null se manca; save(buf) scrive file.tmp e lo rinomina (un riavvio a metà
// salvataggio lascia il file di prima intero)
function fileStore(file) {
  return {
    kind: 'file',
    async load() {
      try { return await fs.promises.readFile(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    async save(buf) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    },
  };
}

// destinazione dalle variabili d'ambiente: SNAPSHOT_FILE, altrimenti nessuna (il server parte vuoto come prima)
const storeFromEnv = env => (env.SNAPSHOT_FILE ? fileStore(env.SNAPSHOT_FILE) : null);

module.exports = { FORMAT, VERSION, MAX_AGE_MS, SNAPSHOT_FIELDS, pickStatic, serialize, encode, decode, restore, restoreBuffer,
  merge, mergeBatched, fileStore, storeFromEnv };
