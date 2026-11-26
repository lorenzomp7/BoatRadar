// Comportamento della pagina (boatradar.html) senza browser: esegue lo script della pagina e public/ais-logic.js
// in un contesto vm con Leaflet, DOM, fetch e orologio finti. Copre le richieste di posizioni (vista in cache,
// include= della nave selezionata, la × che la toglie) e la prima richiesta al Baltico con l'orologio sbagliato.
// La verifica nel browser vero resta tools/smoke-browser.sh. Esegui con: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
const pageScript = html.split('<script src="public/ais-logic.js"></script>')[1].split('<script>')[1].split('</script>')[0];
const logicScript = fs.readFileSync(path.join(ROOT, 'public/ais-logic.js'), 'utf8');
const WINDOW_MS = 30 * 60 * 1000;
const TIME_SCALE = 10;   // i timer della pagina corrono 10 volte più veloci (attesa massima 3000 ms → 300 ms)

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  throw new Error('timeout in attesa di: ' + what);
}
const feature = (mmsi, lon, lat, ts) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, sog: 5, cog: 90, timestampExternal: ts } });

// Avvia la pagina. skewMs = quanto l'orologio del telefono è avanti; routes(url) → { body, delay } o undefined (404).
// Restituisce il contesto, il registro delle richieste ({ url, at, phoneAt }) e funzioni di comodo.
function startPage({ skewMs = 0, routes }) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, dataset: {}, textContent: '', innerHTML: '', open: true,
      addEventListener() {}, focus() {} });
    return elements.get(id);
  };
  const requests = [];
  class PhoneDate extends Date {
    constructor(...a) { super(...(a.length ? a : [Date.now() + skewMs])); }
    static now() { return Date.now() + skewMs; }
  }
  class FakeMarker {
    constructor(latlng, options) { this.latlng = latlng; this.options = { ...options }; this.removed = false; }
    on() { return this; } addTo() { return this; } bringToFront() { return this; } redraw() { return this; }
    bindTooltip(fn) { this.tooltip = fn; return this; }
    setLatLng(ll) { this.latlng = ll; return this; }
    setStyle(s) { Object.assign(this.options, s); return this; }
    getLatLng() { return { lat: this.latlng[0], lng: this.latlng[1] }; }
    remove() { this.removed = true; }
  }
  const map = { setView() { return this; }, on() { return this; }, invalidateSize() {}, getZoom: () => 6,
    getCenter: () => ({ lat: 44, lng: 11 }),
    getBounds: () => ({ pad: () => ({ getEast: () => 12, getWest: () => 10, getSouth: () => 43, getNorth: () => 45 }) }) };
  const L = { map: () => map, tileLayer: () => ({ addTo() {} }), canvas: () => ({}), Util: { wrapNum: x => x },
    CircleMarker: { extend(proto) { class M extends FakeMarker {} Object.assign(M.prototype, proto); return M; } } };
  const fetch = url => {
    requests.push({ url, at: Date.now(), phoneAt: Date.now() + skewMs });
    const r = routes(url);
    if (!r) return Promise.resolve({ ok: false, status: 404, json: async () => null });
    return new Promise(resolve => setTimeout(() => resolve({ ok: true, status: 200,
      json: async () => (typeof r.body === 'function' ? r.body() : r.body) }), r.delay || 0));
  };
  const ctx = vm.createContext({
    console, URLSearchParams, Promise, Map, Set, Math, JSON, Number, String, Array, Object, Error,
    Date: PhoneDate, fetch, L, document: { getElementById: el },
    setTimeout: (fn, ms, ...a) => setTimeout(fn, (ms || 0) / TIME_SCALE, ...a), clearTimeout,
    setInterval: () => 0,   // gli aggiornamenti periodici li fa il test chiamando tick()
    ResizeObserver: class { observe() {} }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {},
  });
  ctx.window = ctx;
  vm.runInContext(logicScript, ctx);
  vm.runInContext(pageScript, ctx);
  const get = expr => vm.runInContext(expr, ctx);
  return { ctx, el, requests, get, tick: () => ctx.tick(), markers: () => get('markers'),
    firstTickDone: () => until(() => el('status').textContent.includes('in mappa'), 'primo aggiornamento') };
}

const isView = u => u.startsWith('/api/locations?bbox=');
const isInclude = u => u.startsWith('/api/locations?include=');
const fromOf = u => Number(new URL(u, 'http://x').searchParams.get('from'));

test('pagina: con l\'orologio del telefono avanti di 5 min la prima richiesta al Baltico usa l\'ora vera (punto 43)', async () => {
  const skewMs = 5 * 60 * 1000;
  const page = startPage({ skewMs, routes: url => {
    if (url === '/api/status') return { delay: 20, body: () => ({ hasKey: true, connected: true, vessels: 0, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.includes('/locations')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  const baltic = page.requests.find(r => r.url.includes('digitraffic') && r.url.includes('/locations?from='));
  assert.ok(baltic, 'richiesta al Baltico');
  const err = fromOf(baltic.url) - (baltic.at - WINDOW_MS);
  assert.ok(Math.abs(err) < 1000, `from = ora vera − finestra (scarto ${err} ms; senza correzione sarebbe ${skewMs})`);
  const status = page.requests.find(r => r.url === '/api/status');
  assert.ok(status.at <= baltic.at - 15, 'il primo giro aspetta /api/status prima di chiedere il Baltico');
});

test('pagina: se /api/status non risponde, il primo giro aspetta al massimo 3 s; poi le richieste partono insieme', async () => {
  let statusDelay = 2000;   // più di CLOCK_WAIT_MS / TIME_SCALE = 300 ms
  const page = startPage({ skewMs: 5 * 60 * 1000, routes: url => {
    if (url === '/api/status') return { delay: statusDelay, body: () => ({ hasKey: true, connected: true, vessels: 0, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.includes('/locations')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await until(() => page.requests.some(r => r.url.includes('/locations?from=')), 'richiesta al Baltico', 1500);
  const status = page.requests.find(r => r.url === '/api/status');
  const baltic = page.requests.find(r => r.url.includes('/locations?from='));
  const waited = baltic.at - status.at;
  assert.ok(waited >= 250 && waited < 1000, `attesa ${waited} ms: limitata a CLOCK_WAIT_MS (scalato a 300 ms)`);
  await page.firstTickDone();
  // secondo giro: nessuna attesa, stato e posizioni partono insieme
  statusDelay = 200;
  const n = page.requests.length;
  const second = page.tick();
  await until(() => page.requests.slice(n).some(r => r.url.includes('/locations?from=')), 'secondo giro', 100);
  const next = page.requests.slice(n);
  const gap = next.find(r => r.url.includes('/locations?from=')).at - next.find(r => r.url === '/api/status').at;
  assert.ok(gap < 50, `secondo giro in parallelo (scarto ${gap} ms)`);
  await second;
  // ora l'orologio è corretto: from con l'ora vera
  const third = page.requests.length;
  await page.tick();
  const b3 = page.requests.slice(third).find(r => r.url.includes('/locations?from='));
  assert.ok(Math.abs(fromOf(b3.url) - (b3.at - WINDOW_MS)) < 1000, 'dopo il primo campione from usa l\'ora vera');
});

test('pagina: include= solo con una nave selezionata e la scheda aperta; la nave resta in mappa lontano dalla vista; la × la toglie', async () => {
  const A = 247600001, B = 247600002;   // A nella vista, B lontana
  let viewFeatures = [feature(A, 11, 44, 1000)], incFeatures = [feature(B, -40, -30, 1000)];
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 2, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (isView(url)) return { body: () => ({ type: 'FeatureCollection', total: 1234, features: viewFeatures }) };
    if (isInclude(url)) return { body: () => ({ type: 'FeatureCollection', total: incFeatures.length, features: incFeatures }) };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  assert.equal(page.requests.some(r => r.url.includes('include')), false, 'senza nave selezionata niente include');
  assert.ok(page.requests.some(r => r.url === '/api/locations?bbox=10.000,43.000,12.000,45.000'), 'vista senza include');
  assert.deepEqual([...page.markers().keys()], [A]);

  // nave scelta dalla ricerca, lontana dalla vista: scheda aperta, include al giro dopo
  page.ctx.select(B);
  assert.equal(page.el('panel').style.display, 'block');
  let n = page.requests.length;
  await page.tick();
  const inc = page.requests.slice(n).filter(r => isInclude(r.url));
  assert.deepEqual(inc.map(r => r.url), [`/api/locations?include=${B}`], 'una richiesta con solo include=');
  assert.ok(page.requests.slice(n).some(r => isView(r.url) && !r.url.includes('include')), 'la vista resta senza include');
  assert.deepEqual([...page.markers().keys()].sort(), [A, B], 'la nave selezionata è in mappa anche fuori dalla vista');
  assert.deepEqual([...page.markers().get(B).marker.latlng], [-30, -40]);
  assert.equal(page.get('worldTotal'), 1234, 'total di include non sostituisce quello della vista');

  // la stessa nave nella vista (dalla cache, più vecchia) e in include (più recente): vince la più recente
  viewFeatures = [feature(A, 11, 44, 1000), feature(B, -40, -30, 1000)];
  incFeatures = [feature(B, -41, -31, 2000)];
  await page.tick();
  assert.deepEqual([...page.markers().get(B).marker.latlng], [-31, -41], 'la nave inclusa vince se più recente');
  viewFeatures = [feature(A, 11, 44, 1000), feature(B, -42, -32, 3000)];
  await page.tick();
  assert.deepEqual([...page.markers().get(B).marker.latlng], [-32, -42], 'la vista vince se è lei la più recente');
  viewFeatures = [feature(A, 11, 44, 1000)];
  incFeatures = [feature(B, -42, -32, 3000)];

  // bordo giallo sulla nave selezionata, poi la ×
  page.ctx.select(B);
  assert.equal(page.markers().get(B).marker.options.color, '#ffc83d');
  page.el('close').onclick();
  assert.equal(page.get('selected'), null, 'la × azzera selected');
  assert.equal(page.el('panel').style.display, 'none');
  assert.deepEqual([page.markers().get(B).marker.options.color, page.markers().get(B).marker.options.radius], ['#0b1118', 4],
    'la × toglie il bordo giallo');
  n = page.requests.length;
  await page.tick();
  assert.equal(page.requests.slice(n).some(r => r.url.includes('include')), false, 'dopo la × niente include');
  assert.deepEqual([...page.markers().keys()], [A], 'la nave lontana esce dalla mappa');

  // selected rimasto ma scheda chiusa (es. da codice): niente include
  page.get(`selected = ${A}`);
  page.el('panel').style.display = 'none';
  n = page.requests.length;
  await page.tick();
  assert.equal(page.requests.slice(n).some(r => r.url.includes('include')), false, 'scheda chiusa: niente include');
});

test('pagina: tooltip con «ferma» per le navi ferme', async () => {
  const S = 247600010, M = 247600011;
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 2, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (isView(url)) return { body: { type: 'FeatureCollection', total: 2, features: [
      { ...feature(S, 11, 44, 1000), properties: { mmsi: S, name: 'FERMA', sog: 0, heading: 90, timestampExternal: 1000 } },
      { ...feature(M, 11.5, 44, 1000), properties: { mmsi: M, name: 'IN MOTO', sog: 12, cog: 90, timestampExternal: 1000 } }] } };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  assert.equal(page.markers().get(S).marker.tooltip(), 'FERMA · ferma');
  assert.equal(page.markers().get(M).marker.tooltip(), 'IN MOTO');
  assert.equal(page.markers().get(S).marker.options.short, true, 'freccia corta');
});
