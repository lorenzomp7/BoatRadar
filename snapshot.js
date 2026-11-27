// Dati statici delle navi fra un riavvio e l'altro (punto 22). Funzioni usate da server.js (dipendono solo da Node e da
// public/ais-logic.js, per le stesse regole dei dati in arrivo): serialize scrive i dati statici recenti a blocchi (il
// ciclo degli eventi gira fra un blocco e l'altro), encode li comprime con gzip, restoreBuffer li rilegge validando ogni
// campo, con tetti su file, dati decompressi, righe e navi (un file rovinato o costruito apposta non fa mai cadere il
// server: errore SnapshotFormatError, il server lo rinomina .bad e parte vuoto), merge li unisce allo stato in memoria.
// La destinazione è solo un file (SNAPSHOT_FILE, sulla VM un volume Docker): su Render Free, senza disco persistente,
// il server parte vuoto.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { cleanText, isIMO } = require('./public/ais-logic');

const FORMAT = 'boatradar-vessels';
const VERSION = 1;
const MAX_AGE_MS = 48 * 3600 * 1000;       // come la conservazione dei dati statici in server.js
const FUTURE_MS = 5 * 60000;               // orologio della macchina che ha scritto il file un po' avanti
const MAX_TEXT = 64;
// Tetti del ripristino (misure del 2026-11-27, tools/carico.js --snapshot e navi con tutti i campi lunghi: 50.000 navi =
// 12,1 MB decompressi, 243 byte per nave, 0,4-2 MB gzip). Oltre un tetto il file non vale (SnapshotFormatError).
const MB = 1024 * 1024;
const MAX_FILE = 16 * MB;                  // file gzip letto dal disco: controllato con stat prima di leggerlo
const MAX_INFLATED = 64 * MB;              // JSON decompresso: circa 5 volte 50.000 navi
const MAX_COMPACT = 4 * MB;                // JSON non a righe (un altro programma): letto con un solo JSON.parse
const BATCH = 1000;                        // navi per riga, in scrittura e in lettura
const LINE_BYTES = 2048;                   // byte per nave al massimo in una riga (testi di 64 caratteri tutti \uXXXX)
const MAX_VESSELS = 250000;                // navi lette al massimo: circa quante ne stanno in MAX_INFLATED
const SNAPSHOT_FIELDS = ['name', 'imo', 'callSign', 'shipType', 'destination', 'draught', 'length', 'width', 'eta', 'staticTs'];

// solo i dati statici di una nave, senza i valori mancanti (null o undefined)
function pickStatic(v) {
  const out = {};
  for (const f of SNAPSHOT_FIELDS) if (v[f] != null) out[f] = v[f];
  return out;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// AsyncIterable di stringhe che unite danno {"format","version","savedAt","vessels":[[mmsi,{…}],…]}: solo le navi con
// staticTs più recente di maxAgeMs, ordinate per staticTs dalla più recente (se un giorno le navi superassero il tetto
// della lettura, restoreInflated terrebbe le più recenti), `batch` navi per stringa e un
// setImmediate fra un blocco e l'altro. stats.vessels = navi scritte. Ogni stringa finisce su una riga sua
// (intestazione, un blocco per riga, «]}»): il file resta un JSON qualunque, ma restoreBuffer lo rilegge a righe.
async function* serialize(vessels, { now = Date.now(), maxAgeMs = MAX_AGE_MS, batch = BATCH, stats = {} } = {}) {
  const since = now - maxAgeMs;
  const list = [];
  for (const [mmsi, v] of vessels) if (Number.isFinite(v?.staticTs) && v.staticTs > since) list.push([mmsi, v]);
  list.sort((a, b) => b[1].staticTs - a[1].staticTs || a[0] - b[0]);
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

// File che non vale: rovinato, troppo grande, di un altro formato o costruito apposta. Il server lo rinomina .bad e
// parte vuoto; ogni altro errore (I/O: EIO, EACCES…) lascia il file com'è. Il messaggio non contiene mai percorsi.
class SnapshotFormatError extends Error {
  constructor(message) { super(message); this.name = 'SnapshotFormatError'; this.code = 'EFORMAT'; }
}
const isFormatError = err => err instanceof SnapshotFormatError;
const mb = n => Math.round(n / MB * 10) / 10;

// Buffer gzip → Buffer decompresso, al massimo maxInflated byte (zlib si ferma lì: niente memoria esaurita)
const gunzip = promisify(zlib.gunzip);
async function inflate(buf, maxInflated = MAX_INFLATED) {
  try { return await gunzip(buf, { maxOutputLength: maxInflated }); } catch (err) {
    throw new SnapshotFormatError(err?.code === 'ERR_BUFFER_TOO_LARGE' ? `decompresso oltre ${mb(maxInflated)} MB` : 'gzip non valido');
  }
}
const parse = text => { try { return JSON.parse(text); } catch { throw new SnapshotFormatError('JSON non valido'); } };
// Buffer gzip → oggetto (test e strumenti; il server usa restoreBuffer)
async function decode(buf) {
  return parse((await inflate(buf)).toString('utf8'));
}

const isInt = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const inRange = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const text = x => typeof x === 'string' && x.length <= MAX_TEXT;
// ETA come etaOf di server.js (già nella forma salvata): mese e giorno validi, ora e minuto validi o null
function etaOf(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !isInt(e.month, 1, 12) || !isInt(e.day, 1, 31)) return null;
  return { month: e.month, day: e.day, hour: isInt(e.hour, 0, 23) ? e.hour : null, minute: isInt(e.minute, 0, 59) ? e.minute : null };
}

// Una voce [mmsi, {…}] del file → [mmsi, nave] con solo i campi validi, oppure null se la voce non vale. Stesse regole di
// handle() in server.js: testi ripuliti con cleanText (nome vuoto = nessun nome), IMO con la cifra di controllo, pescaggio
// maggiore di 0. Si leggono solo proprietà note di un oggetto nuovo: un "__proto__" del JSON resta una chiave ignorata.
function entryOf(e, since, until) {
  if (!Array.isArray(e) || e.length !== 2) return null;
  const [mmsi, s] = e;
  if (!isInt(mmsi, 1, 999999999) || !s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!inRange(s.staticTs, -Infinity, until) || !(s.staticTs > since)) return null;
  const v = { mmsi };
  for (const f of ['name', 'callSign', 'destination']) {
    if (!text(s[f])) continue;
    const t = cleanText(s[f]);
    if (t || f !== 'name') v[f] = t;
  }
  if (isIMO(s.imo)) v.imo = s.imo;
  if (isInt(s.shipType, 0, 99)) v.shipType = s.shipType;
  if (inRange(s.draught, 0, 25.5) && s.draught > 0) v.draught = s.draught;
  if (inRange(s.length, 1, 1023)) v.length = s.length;
  if (inRange(s.width, 1, 126)) v.width = s.width;
  if ('eta' in s) v.eta = etaOf(s.eta);
  v.staticTs = s.staticTs;
  return [mmsi, v];
}

// Raccoglie le voci valide: un MMSI una volta sola, con i dati più recenti. add() restituisce false quando le voci lette
// (valide o no) superano `max`: chi legge si ferma lì, senza leggere il resto del file.
function collector({ now = Date.now(), maxAgeMs = MAX_AGE_MS, max = MAX_VESSELS } = {}) {
  const since = now - maxAgeMs, until = now + FUTURE_MS, out = new Map();
  let seen = 0;
  return {
    add(e) {
      if (++seen > max) return false;
      const r = entryOf(e, since, until);
      if (r && !(out.get(r[0])?.staticTs >= r[1].staticTs)) out.set(r[0], r[1]);
      return true;
    },
    result: () => [...out],
  };
}
const knownHeader = o => !!o && typeof o === 'object' && o.format === FORMAT && o.version === VERSION;

// Oggetto letto dal file → [[mmsi, nave]] validate (al massimo le prime `max` voci, le più recenti in un file di
// serialize; un MMSI una volta sola, con i dati più recenti). Formato o versione sconosciuti, o qualunque altro problema, = []. Mai eccezioni.
function restore(obj, opts = {}) {
  try {
    if (!knownHeader(obj) || !Array.isArray(obj.vessels)) return [];
    const c = collector(opts);
    for (const e of obj.vessels) if (!c.add(e)) break;
    return c.result();
  } catch {
    return [];
  }
}

// Buffer gzip → [[mmsi, nave]], come restoreInflated dopo inflate (al massimo maxInflated byte decompressi)
async function restoreBuffer(buf, opts = {}) {
  return restoreInflated(await inflate(buf, opts.maxInflated), opts);
}

// JSON già decompresso (Buffer) → [[mmsi, nave]]. Un file scritto da serialize si rilegge una riga (un blocco di navi)
// alla volta, cercando i '\n' con indexOf e con un setImmediate fra una riga e l'altra: con decine di migliaia di navi
// JSON.parse e convalida di tutto il file in un colpo fermerebbero il ciclo degli eventi per circa 100 ms. Tetti: al
// massimo ceil(max / batch) + 2 righe, ognuna di al massimo batch × lineBytes byte, nessuna riga vuota, lettura ferma
// appena le voci superano `max`. Un altro JSON (non a righe) si legge intero, solo fino a maxCompact byte. Ogni problema
// (righe, JSON, formato o versione sconosciuti) = SnapshotFormatError.
async function restoreInflated(raw, { batch = BATCH, lineBytes = LINE_BYTES, maxCompact = MAX_COMPACT, ...opts } = {}) {
  const max = opts.max ?? MAX_VESSELS;
  const nl = raw.indexOf(0x0a);
  let head = null;
  if (nl > 0 && nl <= 1024) { try { head = JSON.parse(raw.toString('utf8', 0, nl) + ']}'); } catch { head = null; } }
  if (!knownHeader(head) || !Array.isArray(head.vessels) || head.vessels.length) {
    if (raw.length > maxCompact) throw new SnapshotFormatError(`JSON non a righe oltre ${mb(maxCompact)} MB`);
    const obj = parse(raw.toString('utf8'));
    if (!knownHeader(obj)) throw new SnapshotFormatError('formato o versione sconosciuti');
    return restore(obj, { ...opts, max });
  }
  const c = collector({ ...opts, max });
  const maxLines = Math.ceil(max / batch) + 2, maxLine = batch * lineBytes;
  let start = nl + 1, lines = 1;
  for (;;) {
    const end = raw.indexOf(0x0a, start);
    if (end < 0) {
      if (raw.length - start !== 2 || raw[start] !== 0x5d || raw[start + 1] !== 0x7d) throw new SnapshotFormatError('chiusura mancante');
      return c.result();
    }
    if (++lines + 1 > maxLines) throw new SnapshotFormatError(`oltre ${maxLines} righe`);
    if (end === start) throw new SnapshotFormatError('riga vuota');
    if (end - start > maxLine) throw new SnapshotFormatError(`riga oltre ${mb(maxLine)} MB`);
    if (lines > 2) await tick();
    const first = raw[start] === 0x2c ? start + 1 : start;   // ',' fra un blocco e l'altro
    const list = parse('[' + raw.toString('utf8', first, end) + ']');
    for (const e of list) if (!c.add(e)) return c.result();
    start = end + 1;
  }
}

// Unisce le navi del file a vessels (Map mmsi -> nave). Una nave del file entra solo se in memoria non ci sono già dati
// statici almeno altrettanto recenti; se in memoria c'è già (il ripristino può finire dopo i primi messaggi di aisstream,
// oltre il tetto di 5 s di server.js) i suoi campi sono arrivati dopo l'avvio, quindi più nuovi di quelli del file: dal
// file si prendono solo i campi che in memoria mancano del tutto (es. una nave con solo MetaData.ShipName tiene il nome
// appena arrivato e prende destinazione, tipo e misure dal file; un null scritto da un ShipStaticData resta null).
// onRestored(mmsi, v) per ognuna; restituisce quante. mergeBatched fa lo stesso a blocchi di `batch` navi, con un
// setImmediate fra l'uno e l'altro.
function merge(vessels, list, onRestored = () => {}) {
  let n = 0;
  for (const [mmsi, s] of list) {
    let v = vessels.get(mmsi);
    if (v?.staticTs >= s.staticTs) continue;
    if (!v) { v = { mmsi }; vessels.set(mmsi, v); }
    for (const f of SNAPSHOT_FIELDS) if (f !== 'staticTs' && v[f] === undefined && s[f] !== undefined) v[f] = s[f];
    v.staticTs = s.staticTs;
    onRestored(mmsi, v);
    n++;
  }
  return n;
}
async function mergeBatched(vessels, list, onRestored, { batch = BATCH } = {}) {
  let n = 0;
  for (let i = 0; i < list.length; i += batch) {
    if (i > 0) await tick();
    n += merge(vessels, list.slice(i, i + batch), onRestored);
  }
  return n;
}

// File locale. load() → Buffer, o null se manca: prima stat (oltre maxFile = SnapshotFormatError, senza leggerlo; non un
// file normale = errore EISDIR/ENOTFILE), poi la lettura. save(buf): open → write → sync del file.tmp, poi rename (un
// riavvio o un calo di corrente a metà salvataggio lasciano il file di prima intero). quarantine(): rinomina il file in
// file.bad (sostituendo un .bad di prima), così il salvataggio successivo non cancella il file che non si è potuto leggere.
function fileStore(file, { maxFile = MAX_FILE } = {}) {
  return {
    kind: 'file',
    async load() {
      let st;
      try { st = await fs.promises.stat(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
      if (!st.isFile()) throw Object.assign(new Error('non è un file'), { code: st.isDirectory() ? 'EISDIR' : 'ENOTFILE' });
      if (st.size > maxFile) throw new SnapshotFormatError(`file oltre ${mb(maxFile)} MB`);
      const buf = await fs.promises.readFile(file);
      if (buf.length > maxFile) throw new SnapshotFormatError(`file oltre ${mb(maxFile)} MB`);
      return buf;
    },
    async save(buf) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      const fh = await fs.promises.open(tmp, 'w');
      try {
        await fh.writeFile(buf);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.promises.rename(tmp, file);
    },
    async quarantine() {
      await fs.promises.rename(file, file + '.bad');
    },
  };
}

// destinazione dalle variabili d'ambiente: SNAPSHOT_FILE, altrimenti nessuna (il server parte vuoto come prima)
const storeFromEnv = env => (env.SNAPSHOT_FILE ? fileStore(env.SNAPSHOT_FILE) : null);

module.exports = { FORMAT, VERSION, MAX_AGE_MS, MAX_FILE, MAX_INFLATED, MAX_COMPACT, BATCH, LINE_BYTES, MAX_VESSELS,
  SNAPSHOT_FIELDS, SnapshotFormatError, isFormatError, pickStatic, serialize, encode, inflate, decode, restore, restoreBuffer,
  restoreInflated, merge, mergeBatched, fileStore, storeFromEnv };
