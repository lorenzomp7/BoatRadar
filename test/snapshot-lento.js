// Solo per test/snapshot-server.test.js (non è un file di test): precaricato in server.js con
// NODE_OPTIONS=--require, rallenta o fa fallire lettura e salvataggio dello snapshot (punto 22) senza toccare server.js.
//   SNAPSHOT_TEST_GATE_LOAD=<file>  la lettura di SNAPSHOT_FILE aspetta che <file> esista
//   SNAPSHOT_TEST_GATE_SAVE=<file>  il salvataggio (apertura di SNAPSHOT_FILE.tmp) aspetta che <file> esista
//   SNAPSHOT_TEST_LOAD_ERROR=EIO    la lettura di SNAPSHOT_FILE fallisce con quel codice (errore di I/O)
// Quando una lettura o un salvataggio si mette in attesa scrive «test: lettura in attesa» / «test: salvataggio in attesa».
'use strict';
const fs = require('node:fs');

const { SNAPSHOT_FILE: file, SNAPSHOT_TEST_GATE_LOAD: gateLoad, SNAPSHOT_TEST_GATE_SAVE: gateSave,
  SNAPSHOT_TEST_LOAD_ERROR: loadError } = process.env;
const wait = gate => new Promise(resolve => {
  const t = setInterval(() => { if (fs.existsSync(gate)) { clearInterval(t); resolve(); } }, 20);
  t.unref();
});

const readFile = fs.promises.readFile;
fs.promises.readFile = async (p, ...rest) => {
  if (p === file && loadError) throw Object.assign(new Error(`${loadError}: errore di prova, read '${p}'`), { code: loadError });
  if (p === file && gateLoad) { console.log('test: lettura in attesa'); await wait(gateLoad); }
  return readFile(p, ...rest);
};
const open = fs.promises.open;
fs.promises.open = async (p, ...rest) => {
  if (p === file + '.tmp' && gateSave) { console.log('test: salvataggio in attesa'); await wait(gateSave); }
  return open(p, ...rest);
};
