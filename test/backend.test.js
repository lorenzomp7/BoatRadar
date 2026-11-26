// Punto 86a: due backend (VM Oracle e Render). config.js di GitHub Pages scritto da
// tools/config-pages.js, render.yaml e i filtri dei deploy allineati al Dockerfile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { configJs } = require('../tools/config-pages');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// esegue config.js come farebbe il browser e restituisce window
function runConfig(src) {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  vm.runInContext(src, ctx);
  return ctx;
}

const cli = env => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'config-pages.js')], {
  env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('configJs: senza indirizzi nessun elenco di server, solo il commento sul Baltico', () => {
  for (const env of [{}, { API_HOST: '', VM_HOST: '', RENDER_HOST: '' }, { VM_HOST: '  ' }]) {
    const src = configJs(env);
    assert.match(src, /server non ancora configurato: solo dati del Baltico/);
    const w = runConfig(src);
    assert.equal(w.BOATRADAR_APIS, undefined);
    assert.equal(w.BOATRADAR_API, undefined);
  }
});

test('configJs: VM_HOST diventa l\'indirizzo sslip.io della VM, sempre accesa', () => {
  const w = runConfig(configJs({ VM_HOST: '130.61.10.20' }));
  assert.deepEqual(JSON.parse(JSON.stringify(w.BOATRADAR_APIS)),
    [{ url: 'https://boatradar.130-61-10-20.sslip.io/api', name: 'VM Oracle', sleeps: false }]);
  assert.equal(w.BOATRADAR_API, 'https://boatradar.130-61-10-20.sslip.io/api');
});

test('configJs: API_HOST ha la precedenza su VM_HOST', () => {
  const w = runConfig(configJs({ API_HOST: 'api.miosito.it', VM_HOST: '130.61.10.20' }));
  assert.equal(w.BOATRADAR_APIS.length, 1);
  assert.equal(w.BOATRADAR_APIS[0].url, 'https://api.miosito.it/api');
  assert.equal(w.BOATRADAR_APIS[0].name, 'VM Oracle');
});

test('configJs: solo RENDER_HOST dà un solo server, che si addormenta', () => {
  const w = runConfig(configJs({ RENDER_HOST: 'boatradar.onrender.com' }));
  assert.deepEqual(JSON.parse(JSON.stringify(w.BOATRADAR_APIS)),
    [{ url: 'https://boatradar.onrender.com/api', name: 'Render', sleeps: true }]);
  assert.equal(w.BOATRADAR_API, 'https://boatradar.onrender.com/api');
});

test('configJs: con entrambi prima la VM poi Render, BOATRADAR_API è il primo', () => {
  const src = configJs({ VM_HOST: '130.61.10.20', RENDER_HOST: 'boatradar.onrender.com' });
  const w = runConfig(src);
  assert.deepEqual(JSON.parse(JSON.stringify(w.BOATRADAR_APIS.map(b => [b.name, b.url, b.sleeps]))), [
    ['VM Oracle', 'https://boatradar.130-61-10-20.sslip.io/api', false],
    ['Render', 'https://boatradar.onrender.com/api', true],
  ]);
  assert.equal(w.BOATRADAR_API, w.BOATRADAR_APIS[0].url);
  assert.match(src, /window\.BOATRADAR_API = window\.BOATRADAR_APIS\[0\]\.url;/);
});

test('configJs: RENDER_HOST copiato con https:// e / finale viene ripulito', () => {
  for (const h of ['https://x.onrender.com/', 'https://x.onrender.com', 'x.onrender.com/', ' x.onrender.com ', 'HTTPS://x.onrender.com//']) {
    const w = runConfig(configJs({ RENDER_HOST: h }));
    assert.equal(w.BOATRADAR_APIS[0].url, 'https://x.onrender.com/api', h);
  }
});

test('configJs: lo stesso indirizzo per VM e Render compare una volta sola', () => {
  const w = runConfig(configJs({ API_HOST: 'api.miosito.it', RENDER_HOST: 'https://api.miosito.it/' }));
  assert.equal(w.BOATRADAR_APIS.length, 1);
  assert.equal(w.BOATRADAR_APIS[0].name, 'VM Oracle');
});

test('configJs: un indirizzo non valido è un errore, non finisce in config.js', () => {
  for (const env of [{ RENDER_HOST: 'x";alert(1)//' }, { API_HOST: 'a b.it' }, { VM_HOST: '1.2.3.4/x' },
    { RENDER_HOST: 'x.onrender.com/api' }, { API_HOST: 'host:porta' }]) {
    assert.throws(() => configJs(env), /non valido/, JSON.stringify(env));
  }
  assert.doesNotThrow(() => configJs({ API_HOST: 'api.miosito.it:8443' }), 'la porta è ammessa');
});

test('tools/config-pages.js da riga di comando: stampa config.js, exit 1 con un indirizzo non valido', () => {
  const ok = cli({ VM_HOST: '130.61.10.20', RENDER_HOST: 'boatradar.onrender.com' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, configJs({ VM_HOST: '130.61.10.20', RENDER_HOST: 'boatradar.onrender.com' }));
  assert.equal(runConfig(ok.stdout).BOATRADAR_APIS.length, 2);

  const none = cli({});
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /solo dati del Baltico/);

  const bad = cli({ RENDER_HOST: 'x";alert(1)//' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '', 'niente in config.js');
  assert.match(bad.stderr, /RENDER_HOST/);
});

// pages.yml con le virgolette del comando shell (\") lette come virgolette semplici
const pagesYml = () => read('.github/workflows/pages.yml').replace(/\\"/g, '"');
// elenco "paths: [a, b, …]" di una riga di un file YAML
const inlinePaths = (yml, what) => {
  const m = yml.match(/^\s*paths:\s*\[([^\]]*)\]/m);
  assert.ok(m, `paths: [...] non trovato in ${what}`);
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};
const covered = (file, globs) => globs.some(g => g === file || (g.endsWith('/**') && file.startsWith(g.slice(0, -2))));

test('pages.yml scrive config.js con tools/config-pages.js e passa RENDER_HOST', () => {
  const yml = pagesYml();
  assert.match(yml, /node tools\/config-pages\.js > _site\/config\.js/);
  assert.match(yml, /RENDER_HOST: \$\{\{ vars\.RENDER_HOST \}\}/);
  assert.match(yml, /API_HOST: \$\{\{ vars\.API_HOST \}\}/);
  assert.match(yml, /VM_HOST: \$\{\{ vars\.VM_HOST \}\}/);
  assert.ok(inlinePaths(yml, 'pages.yml').includes('tools/config-pages.js'), 'tools/config-pages.js nei paths di pages.yml');
  assert.doesNotMatch(yml, /printf 'window\.BOATRADAR_API/, 'il vecchio printf non c\'è più');
  // config.js con la versione dell'esecuzione: un nuovo RENDER_HOST non resta nella cache del browser
  assert.match(yml, /sed -i [^\n]*src="config\.js"[^\n]*src="config\.js\?v=\$\{GITHUB_RUN_ID\}"[^\n]*_site\/index\.html/);
  assert.match(yml, /grep -q[^\n]*config\.js\?v=\$\{GITHUB_RUN_ID\}[^\n]*_site\/index\.html/);
  assert.match(read('boatradar.html'), /<script src="config\.js"><\/script>/, 'la riga che sed sostituisce');
});

test('render.yaml: servizio Docker Free, chiave aisstream segreta, CORS verso Pages', () => {
  const y = read('render.yaml');
  assert.match(y, /^\s*-\s*type:\s*web\s*$/m);
  assert.match(y, /^\s*runtime:\s*docker\s*$/m);
  assert.match(y, /^\s*plan:\s*free\s*$/m);
  assert.match(y, /^\s*dockerfilePath:\s*\.\/Dockerfile\s*$/m);
  assert.match(y, /^\s*healthCheckPath:\s*\/api\/status\s*$/m);
  assert.doesNotMatch(y, /key:\s*PORT\b/, 'la porta la sceglie Render');
  const env = y.split(/^\s*-\s*key:\s*/m).slice(1).map(b => b.split(/\n(?=\s*-\s)/)[0]);
  const key = env.find(b => b.startsWith('AISSTREAM_KEY'));
  assert.ok(key, 'AISSTREAM_KEY in envVars');
  assert.match(key, /sync:\s*false/);
  assert.doesNotMatch(key, /value:/, 'la chiave non sta nel file');
  const cors = env.find(b => b.startsWith('CORS_ORIGIN'));
  assert.ok(cors, 'CORS_ORIGIN in envVars');
  assert.match(cors, /value:\s*https:\/\/lorenzomp7\.github\.io\s*$/);
});

test('ogni file copiato dal Dockerfile fa partire il deploy della VM e quello di Render', () => {
  const copied = read('Dockerfile').split('\n').filter(l => /^\s*COPY\s/i.test(l))
    .flatMap(l => l.trim().split(/\s+/).slice(1, -1));
  assert.ok(copied.includes('server.js') && copied.includes('public/ais-logic.js'));
  const vmPaths = inlinePaths(read('.github/workflows/deploy-backend.yml'), 'deploy-backend.yml');
  const renderPaths = inlinePaths(read('render.yaml'), 'render.yaml');
  for (const f of [...copied, 'Dockerfile']) {
    assert.ok(covered(f, vmPaths), `${f} manca nei paths di deploy-backend.yml`);
    assert.ok(covered(f, renderPaths), `${f} manca nel buildFilter di render.yaml`);
  }
  assert.ok(renderPaths.includes('render.yaml'));
});
