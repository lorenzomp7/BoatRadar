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
});
