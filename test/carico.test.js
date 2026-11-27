// tools/carico.js deve continuare a funzionare con server.js: piccola esecuzione reale e dati ripetibili.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { ships, args } = require('../tools/carico');

test('le navi sintetiche sono sempre le stesse e hanno coordinate valide', () => {
  const a = [...ships(500)], b = [...ships(500)];
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map(s => s.position.MetaData.MMSI)).size, 500);
  for (const s of a) {
    const p = s.position.Message.PositionReport;
    assert.ok(Math.abs(p.Latitude) <= 90 && Math.abs(p.Longitude) <= 180);
  }
});

test('opzioni non valide vengono rifiutate', () => {
  assert.throws(() => args(['--navi', '0']), /positivi/);
  assert.throws(() => args(['--boh', '1']), /sconosciuta/);
  assert.throws(() => args(['--filtro']), /--filtro/);
  assert.equal(args(['--filtro', 'types=tanker']).filtro, 'types=tanker');
  assert.equal(args([]).filtro, null);
  assert.throws(() => args(['--cerca']), /--cerca/);
  assert.equal(args(['--cerca', 'NAVE 1']).cerca, 'NAVE 1');
});

// senza variabili di proxy: la misura non deve dipendere dalla macchina che esegue i test
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(https?|no|all)_proxy$|^NODE_USE_ENV_PROXY$/i.test(k)) delete env[k];
  return env;
}

test('una piccola misura reale termina e riporta memoria e viste', async () => {
  const out = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, '..', 'tools', 'carico.js'), '--navi', '300', '--richieste', '3'],
    { timeout: 30000, env: cleanEnv() }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  assert.match(out, /Navi: 300 /);
  assert.match(out, /MB ogni 1000 navi/);
  assert.match(out, /Vista mondo: 300 navi su 300/);
  assert.match(out, /Vista porto: \d+ navi/);
  assert.doesNotMatch(out, /filtrata/, 'senza --filtro nessuna vista filtrata');
});

test('con --filtro stampa anche la vista mondo filtrata (punto 9)', async () => {
  const out = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, '..', 'tools', 'carico.js'), '--navi', '300', '--richieste', '2', '--filtro', 'types=tanker'],
    { timeout: 30000, env: cleanEnv() }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  assert.match(out, /Vista mondo: 300 navi su 300/);
  // TYPES di carico.js: 2 petroliere (tipi 84 e 80) ogni 10 navi
  assert.match(out, /Vista mondo filtrata \(types=tanker\): 60 navi su 60,/);
});

test('con --filtro hazard=1 la vista mondo filtrata ha solo i carichi pericolosi (punto 46)', async () => {
  const out = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, '..', 'tools', 'carico.js'), '--navi', '300', '--richieste', '2', '--filtro', 'hazard=1'],
    { timeout: 30000, env: cleanEnv() }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  // TYPES di carico.js: un tipo 71 (X) e un 84 (OS) ogni 10 navi
  assert.match(out, /Vista mondo filtrata \(hazard=1\): 60 navi su 60,/);
});

test('con --cerca misura anche /api/search (punto 12)', async () => {
  const out = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, '..', 'tools', 'carico.js'), '--navi', '300', '--richieste', '2', '--cerca', 'NAVE 1'],
    { timeout: 30000, env: cleanEnv() }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  assert.match(out, /Ricerca «NAVE 1»: 25 risultati, [\d.]+ KB gzip, [\d.]+ ms mediana, [\d.]+ ms p95/);
});
