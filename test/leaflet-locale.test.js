// Punto 85: Leaflet 1.9.4 servito dalla repo (vendor/leaflet/) invece che da unpkg.com. La pagina non dipende da un
// CDN esterno: file fissati con lo SHA-256, serviti da server.js da un elenco fisso, copiati nell'immagine Docker e su Pages.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
// pages.yml con le virgolette del comando shell (\") lette come virgolette semplici
const pagesYml = () => read('.github/workflows/pages.yml').replace(/\\"/g, '"');
const copied = () => read('Dockerfile').split('\n').filter(l => /^\s*COPY\s/i.test(l))
  .map(l => l.trim().split(/\s+/).slice(1));   // [sorgenti…, destinazione]

const IMAGES = ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png'];
// SHA-256 dei file di `npm pack leaflet@1.9.4` (integrità del pacchetto: npm view leaflet@1.9.4 dist.integrity)
const SHA = {
  'vendor/leaflet/leaflet.js': 'db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a',
  'vendor/leaflet/leaflet.css': 'a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6',
};

test('la pagina non carica script né fogli di stile da https://', () => {
  const html = read('boatradar.html');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
  const links = [...html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)].map(m => m[1]);
  for (const src of [...scripts, ...links]) assert.doesNotMatch(src, /^(https?:)?\/\//, `${src} viene da un altro sito`);
  assert.ok(scripts.includes('vendor/leaflet/leaflet.js'), 'leaflet.js locale');
  assert.ok(links.includes('vendor/leaflet/leaflet.css'), 'leaflet.css locale');
  // Leaflet prima dello script della pagina; la riga di ais-logic.js resta identica (i test dividono la pagina su di lei)
  assert.ok(html.indexOf('src="vendor/leaflet/leaflet.js"') < html.indexOf('<script src="public/ais-logic.js"></script>'));
  assert.doesNotMatch(html, /unpkg\.com/);
});

test('vendor/leaflet: Leaflet 1.9.4 intero, file fissati e licenza BSD', () => {
  for (const [f, sha] of Object.entries(SHA)) assert.equal(sha256(f), sha, `${f} diverso da quello di leaflet@1.9.4`);
  assert.match(read('vendor/leaflet/leaflet.js').slice(0, 200), /Leaflet 1\.9\.4/);
  for (const img of IMAGES) {
    const buf = fs.readFileSync(path.join(ROOT, 'vendor/leaflet/images', img));
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${img} è un PNG`);
  }
  assert.match(read('vendor/leaflet/LICENSE'), /BSD/);
});

test('server: Leaflet da un elenco fisso, con tipo e cache giusti; tutto il resto 404', async t => {
  const s = await startServer();
  t.after(() => s.stop());
  const js = await s.get('/vendor/leaflet/leaflet.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'public, max-age=86400');
  assert.equal(crypto.createHash('sha256').update(js.body).digest('hex'), SHA['vendor/leaflet/leaflet.js']);
  const css = await s.get('/vendor/leaflet/leaflet.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(css.headers['cache-control'], 'public, max-age=86400');
  for (const img of IMAGES) {
    const r = await s.get('/vendor/leaflet/images/' + img);
    assert.equal(r.status, 200, img);
    assert.equal(r.headers['content-type'], 'image/png', img);
    assert.equal(r.headers['cache-control'], 'public, max-age=86400', img);
  }
  // la pagina e il modulo restano senza cache, come prima
  assert.equal((await s.get('/')).headers['cache-control'], 'no-store');
  assert.equal((await s.get('/public/ais-logic.js')).headers['cache-control'], 'no-store');
  for (const p of ['/vendor/leaflet/x.js', '/vendor/leaflet/../server.js', '/vendor/leaflet/%2e%2e/server.js',
    '/vendor/leaflet/LICENSE', '/vendor/leaflet/', '/vendor/leaflet/images/', '/vendor/leaflet/leaflet.js.map',
    '/server.js', '/package.json', '/vendor/leaflet/images/../../../server.js']) {
    assert.equal((await s.get(p)).status, 404, p);
  }
});

test('Leaflet è nell\'immagine Docker e su Pages, con la versione del commit', () => {
  const lines = copied();
  const from = lines.flatMap(l => l.slice(0, -1));
  assert.ok(from.includes('vendor/leaflet/leaflet.js') && from.includes('vendor/leaflet/leaflet.css'), 'COPY di js e css');
  const imgs = lines.find(l => l.includes('vendor/leaflet/images/'));
  assert.ok(imgs && imgs.at(-1) === './vendor/leaflet/images/', 'COPY della cartella delle immagini');
  const pages = pagesYml();
  assert.match(pages, /mkdir -p _site\/vendor\/leaflet\/images/);
  const re = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ogni foglio di stile locale della pagina va copiato su Pages e nell'immagine, con ?v= come gli script
  const html = read('boatradar.html');
  const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(m => m[1].split('?')[0]);
  assert.ok(sheets.length > 0);
  for (const f of sheets) {
    assert.ok(from.includes(f), `${f} manca in una riga COPY del Dockerfile`);
    assert.match(pages, new RegExp(`cp ${re(f)} _site/${re(path.posix.dirname(f))}/(\\s|$)`, 'm'), `${f} non copiato da pages.yml`);
    assert.ok(pages.includes(`href="${f}?v=\${GITHUB_SHA}"`), `${f} senza ?v= in pages.yml`);
    assert.match(pages, new RegExp(`grep -q[^\\n]*${re(f)}\\?v=\\$\\{GITHUB_SHA\\}[^\\n]*_site/index\\.html`), `${f}: controllo della sostituzione`);
  }
  for (const img of IMAGES) {
    assert.match(pages, new RegExp(`cp vendor/leaflet/images/${re(img)} _site/vendor/leaflet/images/(\\s|$)`, 'm'), `${img} su Pages`);
  }
  assert.match(pages, /grep -q[^\n]*vendor\/leaflet\/leaflet\.js\?v=\$\{GITHUB_SHA\}[^\n]*_site\/index\.html/);
  // la licenza BSD-2-Clause va con i file, nell'immagine e su Pages (server.js non la serve: 404, test sopra)
  assert.ok(lines.some(l => l.includes('vendor/leaflet/LICENSE') && l.at(-1) === './vendor/leaflet/'), 'COPY di LICENSE');
  assert.match(pages, /^\s*cp vendor\/leaflet\/LICENSE _site\/vendor\/leaflet\/\s*$/m, 'LICENSE su Pages');
});

test('misura della pagina e documenti: Leaflet da vendor/leaflet/, unpkg.com bloccato, niente SMOKE_LEAFLET_LOCAL', () => {
  for (const f of ['tools/misura-pagina.sh', 'tools/smoke-browser.sh', 'docs/prestazioni.md', 'AGENTS.md']) {
    assert.doesNotMatch(read(f), /SMOKE_LEAFLET_LOCAL/, f);
  }
  const misura = read('tools/misura-pagina.sh');
  const block = misura.indexOf('network route "https://unpkg.com/**" --abort'), open = misura.indexOf('open "$URL"');
  assert.ok(block > 0 && block < open, 'unpkg.com bloccato prima di aprire la pagina');
  assert.match(misura, /L\.version[^\n]*unpkg/);
});

test('vendor/** fa partire deploy della VM, Render, Pages e la verifica nel browser', () => {
  const paths = f => [...read(f).matchAll(/^\s*paths:\s*\[([^\]]*)\]/gm)].map(m => m[1].split(',').map(s => s.trim()));
  for (const f of ['.github/workflows/deploy-backend.yml', '.github/workflows/browser.yml', '.github/workflows/pages.yml', 'render.yaml']) {
    const all = paths(f);
    assert.ok(all.length > 0, `${f}: paths`);
    for (const list of all) assert.ok(list.includes('vendor/**'), `${f}: vendor/** in paths`);
  }
  assert.equal(paths('.github/workflows/browser.yml').length, 2, 'browser.yml: pull_request e push');
});

test('boatradar.html: senza Leaflet la riga di stato spiega il problema invece di un ReferenceError', () => {
  const vm = require('node:vm');
  const html = read('boatradar.html');
  const code = html.split('<script src="public/ais-logic.js"></script>')[1].match(/<script>([\s\S]*?)<\/script>/)[1];
  const status = { textContent: 'Caricamento…' };
  const document = { getElementById: id => (id === 'status' ? status : null) };
  const ctx = vm.createContext({ document, console: { warn() {}, error() {} }, AisLogic: require('../public/ais-logic') });
  ctx.window = ctx;
  assert.throws(() => vm.runInContext(code, ctx), err => err.name === 'Error' && /Leaflet/.test(err.message));
  assert.match(status.textContent, /Leaflet/);
  assert.match(status.textContent, /ricarica/i);
});
