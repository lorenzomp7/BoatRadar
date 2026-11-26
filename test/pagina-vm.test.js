// Comportamento della pagina (boatradar.html) senza browser: esegue lo script della pagina e public/ais-logic.js
// in un contesto vm con Leaflet, DOM, fetch e orologio finti. Copre le richieste di posizioni (vista in cache,
// include= della nave selezionata, la × e Esc che la tolgono, focus dopo la chiusura), la prima richiesta al
// Baltico con l'orologio sbagliato, il bordo della nave selezionata, simboli e tooltip.
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
// orari delle posizioni di prova: T0 + pochi ms, cioè posizioni appena ricevute (punto 8: le più vecchie spariscono)
const T0 = Date.now();
const TIME_SCALE = 10;   // i timer della pagina corrono 10 volte più veloci (attesa massima 3000 ms → 300 ms)

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  throw new Error('timeout in attesa di: ' + what);
}
const feature = (mmsi, lon, lat, ts) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, sog: 5, cog: 90, timestampExternal: T0 + ts } });

// Avvia la pagina. skewMs = quanto l'orologio del telefono è avanti; routes(url) → { body, delay } o undefined (404).
// Restituisce il contesto, il registro delle richieste ({ url, at, phoneAt }) e funzioni di comodo.
function startPage({ skewMs = 0, routes }) {
  const elements = new Map();
  const classes = new Set();
  const keydown = [];
  // elemento visibile = senza display:none (basta per la × e per il focus dopo la chiusura)
  const document = { activeElement: null, getElementById: id => el(id),
    body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on) } },
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); } };
  document.activeElement = document.body;
  const el = id => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, dataset: {}, textContent: '', innerHTML: '', open: true,
      isConnected: true, addEventListener() {}, focus() { document.activeElement = this; },
      // attributi ARIA della ricerca (punto 12: aria-expanded, aria-activedescendant)
      attributes: {}, setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; },
      getClientRects() { return this.style.display === 'none' ? [] : [{}]; } });
    return elements.get(id);
  };
  const press = (key, target = document.activeElement) => {
    const e = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of keydown) fn(e);
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
    setStyle(s) { this.styleCalls = (this.styleCalls || 0) + 1; Object.assign(this.options, s); return this; }
    getLatLng() { return { lat: this.latlng[0], lng: this.latlng[1] }; }
    remove() { this.removed = true; }
  }
  const map = { setView() { return this; }, on() { return this; }, invalidateSize() {}, getZoom: () => 6,
    getCenter: () => ({ lat: 44, lng: 11 }),
    getBounds: () => ({ pad: () => ({ getEast: () => 12, getWest: () => 10, getSouth: () => 43, getNorth: () => 45 }) }) };
  const L = { map: () => map, tileLayer: () => ({ addTo() {} }), canvas: () => ({}), Util: { wrapNum: x => x },
    control: { zoom: () => ({ addTo() { return this; } }) },
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
    Date: PhoneDate, fetch, L, document,
    setTimeout: (fn, ms, ...a) => setTimeout(fn, (ms || 0) / TIME_SCALE, ...a), clearTimeout,
    setInterval: () => 0,   // gli aggiornamenti periodici li fa il test chiamando tick()
    ResizeObserver: class { observe() {} }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {},
    addEventListener() {},   // eventi di window (online): non servono a questi test
  });
  ctx.window = ctx;
  vm.runInContext(logicScript, ctx);
  vm.runInContext(pageScript, ctx);
  const get = expr => vm.runInContext(expr, ctx);
  return { ctx, el, document, press, bodyClasses: classes, requests, get, tick: () => ctx.tick(), markers: () => get('markers'),
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
  const view = page.requests.find(r => isView(r.url));
  assert.ok(view.at - status.at < 10, `la vista parte subito, senza aspettare /api/status (scarto ${view.at - status.at} ms)`);
  // ora di aggiornamento nella riga di stato: quella vera, non quella del telefono (5 minuti avanti)
  const hhmm = t => new Date(t).toLocaleTimeString('it-IT').slice(0, 5);
  const shown = page.el('status').textContent.match(/agg\. (\d\d:\d\d)/)[1];
  assert.ok([hhmm(Date.now()), hhmm(Date.now() - 2000)].includes(shown), `ora mostrata ${shown}, vera ${hhmm(Date.now())}`);
  assert.notEqual(shown, hhmm(Date.now() + skewMs), 'non l\'ora del telefono');
});

test('pagina: un tick() durante l\'attesa del primo /api/status non chiede il Baltico con l\'ora del telefono (punto 43)', async () => {
  const skewMs = 5 * 60 * 1000;
  const page = startPage({ skewMs, routes: url => {
    if (url === '/api/status') return { delay: 150, body: () => ({ hasKey: true, connected: true, vessels: 0, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.includes('/locations')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await until(() => page.requests.some(r => isView(r.url)), 'primo giro avviato');
  await sleep(30);
  const second = page.tick();   // es. la mappa spostata subito dopo l'apertura
  await until(() => page.requests.filter(r => isView(r.url)).length === 2, 'vista del secondo giro');
  assert.equal(page.requests.some(r => r.url.includes('/locations?from=')), false, 'nessuna richiesta al Baltico prima dell\'ora vera');
  await page.firstTickDone();
  await second;
  const baltic = page.requests.filter(r => r.url.includes('/locations?from='));
  assert.equal(baltic.length, 2, 'una richiesta al Baltico per giro');
  for (const b of baltic) {
    const err = fromOf(b.url) - (b.at - WINDOW_MS);
    assert.ok(Math.abs(err) < 1000, `from con l'ora vera (scarto ${err} ms; con l'ora del telefono ${skewMs})`);
  }
});

test('pagina: se /api/status non risponde, il primo giro aspetta al massimo 3 s; poi le richieste partono insieme', async () => {
  let statusDelay = 700;   // più di CLOCK_WAIT_MS / TIME_SCALE = 300 ms
  const page = startPage({ skewMs: 5 * 60 * 1000, routes: url => {
    if (url === '/api/status') return { delay: statusDelay, body: () => ({ hasKey: true, connected: true, vessels: 0, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.includes('/locations')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await until(() => page.requests.some(r => r.url.includes('/locations?from=')), 'richiesta al Baltico', 1500);
  const status = page.requests.find(r => r.url === '/api/status');
  const baltic = page.requests.find(r => r.url.includes('/locations?from='));
  const waited = baltic.at - status.at;
  assert.ok(waited >= 250 && waited < 600, `attesa ${waited} ms: limitata a CLOCK_WAIT_MS (scalato a 300 ms), non i 700 ms di /api/status`);
  assert.ok(page.requests.find(r => isView(r.url)).at - status.at < 10, 'la vista non aspetta /api/status');
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
  let viewFeatures = [feature(A, 11, 44, 1000)], incFeatures = [feature(B, -40, -30, 1000)], incFails = false;
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 2, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (isView(url)) return { body: () => ({ type: 'FeatureCollection', total: 1234, features: viewFeatures }) };
    if (isInclude(url)) return incFails ? undefined : { body: () => ({ type: 'FeatureCollection', total: incFeatures.length, features: incFeatures }) };
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
  // marker creato mentre la nave è selezionata: nasce già con il bordo giallo (punto 1 delle correzioni)
  assert.deepEqual([page.markers().get(B).marker.options.color, page.markers().get(B).marker.options.radius,
    page.markers().get(B).marker.options.weight], ['#ffc83d', 8, 3], 'bordo giallo dalla creazione');

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
  await page.tick();
  // posizione più vecchia di quella in mappa: il marker resta dov'è
  incFeatures = [feature(B, -50, -40, 2500)];
  await page.tick();
  assert.deepEqual([...page.markers().get(B).marker.latlng], [-32, -42], 'una posizione più vecchia non sposta il marker');
  // solo la richiesta include fallisce: la nave selezionata resta in mappa, con il bordo giallo
  incFails = true;
  await page.tick();
  assert.ok(page.markers().has(B), 'include fallito: la nave selezionata non sparisce');
  assert.equal(page.markers().get(B).marker.removed, false);
  assert.equal(page.markers().get(B).marker.options.color, '#ffc83d');
  incFails = false;
  // riga «Prua» nella scheda, aggiornata a ogni giro
  incFeatures = [{ ...feature(B, -42, -32, 4000), properties: { mmsi: B, sog: 5, cog: 90, heading: 45, timestampExternal: T0 + 4000 } }];
  await page.tick();
  assert.match(page.el('content').innerHTML + page.el('facts').innerHTML, /<td>Prua<\/td><td>45°<\/td>/);

  // la ×: bordo tolto, scheda chiusa, focus sul campo di ricerca (la scheda era stata aperta da codice)
  page.el('close').onclick();
  assert.equal(page.get('selected'), null, 'la × azzera selected');
  assert.equal(page.el('panel').style.display, 'none');
  assert.deepEqual([page.markers().get(B).marker.options.color, page.markers().get(B).marker.options.radius], ['#0b1118', 4],
    'la × toglie il bordo giallo');
  assert.equal(page.document.activeElement, page.el('q'), 'dopo la × il focus va sul campo di ricerca');
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

test('pagina: Esc chiude la scheda (non dalla ricerca con i risultati aperti); focus dove si era aperta', async () => {
  const A = 247600021;
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 1, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (isView(url)) return { body: { type: 'FeatureCollection', total: 1, features: [feature(A, 11, 44, 1000)] } };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  const open = () => page.el('panel').style.display === 'block';

  // scheda aperta dal pulsante «Registri»: Esc la chiude e il focus torna sul pulsante
  page.el('registries').focus();
  page.el('registries').onclick();
  assert.ok(open());
  assert.ok(page.bodyClasses.has('panel-open'), 'classe per tenere l\'header fuori dalla scheda');
  page.press('Escape');
  assert.equal(open(), false, 'Esc chiude la scheda');
  assert.equal(page.bodyClasses.has('panel-open'), false);
  assert.equal(page.document.activeElement, page.el('registries'), 'focus sul punto da cui si era aperta');

  // Esc nel campo di ricerca con i risultati aperti: chiude i risultati, non la scheda
  // nave scelta dalla ricerca: il focus è nel campo
  page.el('q').focus();
  page.ctx.select(A);
  page.el('results').style.display = 'block';
  page.press('Escape');
  assert.equal(page.el('results').style.display, 'none', 'Esc chiude i risultati della ricerca');
  assert.ok(open(), 'la scheda resta aperta');
  assert.equal(page.get('selected'), A);
  page.press('Escape');
  assert.equal(open(), false, 'secondo Esc: chiude la scheda');
  assert.equal(page.get('selected'), null);
  assert.equal(page.document.activeElement, page.el('q'), 'focus di nuovo sul campo di ricerca');
  // scheda chiusa: Esc non fa nulla; altri tasti ignorati
  page.press('Escape');
  page.ctx.select(A);
  page.press('Enter');
  assert.ok(open(), 'Invio non chiude la scheda');
});

test('pagina: tooltip con «ferma» per le navi ferme', async () => {
  const S = 247600010, M = 247600011;
  let features = [
    { ...feature(S, 11, 44, 1000), properties: { mmsi: S, name: 'FERMA', sog: 0, heading: 90, timestampExternal: T0 + 1000 } },
    { ...feature(M, 11.5, 44, 1000), properties: { mmsi: M, name: 'IN MOTO', sog: 12, cog: 90, timestampExternal: T0 + 1000 } }];
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 2, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (isView(url)) return { body: () => ({ type: 'FeatureCollection', total: 2, features }) };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  assert.equal(page.markers().get(S).marker.tooltip(), 'FERMA · ferma · adesso');
  assert.equal(page.markers().get(M).marker.tooltip(), 'IN MOTO · adesso');
  assert.equal(page.markers().get(S).marker.options.short, true, 'freccia corta');
  assert.equal(page.markers().get(M).marker.options.heading, 90);
  // giro dopo: la nave ferma riparte, quella in moto perde rotta e prua → setSymbol aggiorna il simbolo
  features = [{ ...feature(S, 11, 44, 2000), properties: { mmsi: S, sog: 8, heading: 90, timestampExternal: T0 + 2000 } },
    { ...feature(M, 11.5, 44, 2000), properties: { mmsi: M, sog: 0, timestampExternal: T0 + 2000 } }];
  await page.tick();
  assert.deepEqual([page.markers().get(S).marker.options.short, page.markers().get(S).marker.options.heading], [false, 90]);
  assert.equal(page.markers().get(M).marker.options.heading, null, 'pallino');
  assert.equal(page.markers().get(M).marker.tooltip(), 'IN MOTO · ferma · adesso');
});

// --- Punto 8: età della posizione (opacità, tratteggio, sparizione, testo) con l'ora corretta ---------------
const MIN = 60 * 1000, H = 60 * MIN;
test('pagina: navi sbiadite con l\'età, ferme vecchie tratteggiate, oltre il limite tolte; età con l\'ora del server (punto 8)', async () => {
  const skewMs = 5 * MIN;   // telefono 5 min avanti: con la sua ora la nave di 28 min sarebbe di 33 min e sparirebbe
  const FRESH = 247610001, OLD16 = 247610002, MOORED3H = 247610003, MOVING31 = 247610004, MOORED7H = 247610005, MOVING28 = 247610006;
  const ship = (mmsi, ageMs, extra) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [11, 44] },
    properties: { mmsi, name: 'N' + mmsi, sog: 10, cog: 90, navStat: 0, timestampExternal: Date.now() - ageMs, ...extra } });
  const moored = { sog: 0, navStat: 5, heading: 90 };
  const t = Date.now();
  const all = [ship(FRESH, 0), ship(OLD16, 16 * MIN), ship(MOORED3H, 3 * H, moored), ship(MOVING31, 31 * MIN),
    ship(MOORED7H, 7 * H, moored), ship(MOVING28, 28 * MIN)].map(f => ({ ...f, properties: { ...f.properties,
    timestampExternal: f.properties.timestampExternal - (Date.now() - t) } }));
  const features = () => all;   // posizioni fisse: il tempo passa con l'ora del server (advance)
  let advance = 0;
  const page = startPage({ skewMs, routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 6, serverTime: Date.now() + advance }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (isView(url)) return { body: () => ({ type: 'FeatureCollection', total: 6, features: features() }) };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  const opt = mmsi => page.markers().get(mmsi).marker.options;
  assert.deepEqual([...page.markers().keys()].sort(), [FRESH, OLD16, MOORED3H, MOVING28].sort(),
    'in moto di 31 min e ormeggiata di 7 h non sono in mappa; quella di 28 min sì (ora del server, non del telefono)');
  assert.deepEqual([opt(FRESH).opacity, opt(FRESH).fillOpacity, opt(FRESH).dashArray], [1, 0.95, null], 'appena ricevuta: piena');
  assert.ok(Math.abs(opt(OLD16).fillOpacity - 0.675) < 0.01, `16 min: fillOpacity ${opt(OLD16).fillOpacity}`);
  assert.ok(Math.abs(opt(OLD16).opacity - 0.675) < 0.01, 'anche il bordo sbiadisce');
  assert.equal(opt(OLD16).color, '#c9d4e0', 'sbiadita: bordo chiaro (quello scuro non si vede sulla mappa scura)');
  assert.equal(opt(OLD16).dashArray, null, 'sotto i 30 min non tratteggiata');
  assert.equal(opt(MOVING28).fillOpacity >= 0.35, true, `in moto di 28 min: riempimento almeno 0,35 (${opt(MOVING28).fillOpacity})`);
  assert.ok(opt(MOVING28).opacity >= 0.55, 'bordo almeno 0,55');
  assert.equal(opt(FRESH).color, '#0b1118', 'appena ricevuta: bordo normale');
  assert.ok(Math.abs(opt(MOORED3H).fillOpacity - 0.2) < 1e-9, 'ormeggiata di 3 h: 20 %');
  assert.ok(opt(MOORED3H).dashArray, 'ormeggiata di 3 h: tratteggiata');
  assert.notEqual(opt(MOORED3H).color, '#0b1118', 'il tratteggio ha un bordo chiaro, visibile sulla mappa scura');
  // tooltip con l'età (calcolata al momento con clock.now())
  assert.equal(page.markers().get(FRESH).marker.tooltip(), `N${FRESH} · adesso`);
  assert.equal(page.markers().get(OLD16).marker.tooltip(), `N${OLD16} · 16 min fa`);
  assert.equal(page.markers().get(MOORED3H).marker.tooltip(), `N${MOORED3H} · ferma · posizione di 3 h fa`);

  // nave selezionata vecchia: bordo giallo pieno e tratteggiato, riempimento non sotto il 60 %; scheda con l'età
  page.ctx.select(MOORED3H);
  assert.deepEqual([opt(MOORED3H).color, opt(MOORED3H).radius, opt(MOORED3H).opacity], ['#ffc83d', 8, 1], 'selezionata ben visibile');
  assert.ok(opt(MOORED3H).dashArray, 'resta tratteggiata anche selezionata');
  assert.ok(opt(MOORED3H).fillOpacity >= 0.95 * 0.6 - 1e-9, `fillOpacity ${opt(MOORED3H).fillOpacity}`);
  const hms = t => new Date(t).toLocaleTimeString('it-IT');
  const html = page.el('content').innerHTML;
  const ts3h = page.markers().get(MOORED3H).props.timestampExternal;
  assert.ok(html.includes(`posizione di 3 h fa (${hms(ts3h)})`), 'scheda: «posizione di 3 h fa (ora)»');
  // deselezionata (×): torna sbiadita e tratteggiata, non lo stile normale pieno
  page.el('close').onclick();
  assert.deepEqual([opt(MOORED3H).color === '#ffc83d', opt(MOORED3H).radius], [false, 4]);
  assert.ok(opt(MOORED3H).dashArray && opt(MOORED3H).fillOpacity <= 0.2, 'dopo la × di nuovo sbiadita');
  page.ctx.select(OLD16);
  const ts16 = page.markers().get(OLD16).props.timestampExternal;
  assert.ok(page.el('content').innerHTML.includes(`16 min fa (${hms(ts16)})`), 'scheda: «16 min fa (ora)»');

  // 15 min dopo (ora del server avanti di 15 min; l'orologio la segue dopo due campioni) con le stesse posizioni: la
  // fresca sbiadisce anche se il marker non si sposta, quella di 16 min (ora 31) sparisce, l'ormeggiata resta
  advance = 15 * MIN;
  await page.tick();
  await page.tick();
  assert.deepEqual([...page.markers().keys()].sort(), [FRESH, MOORED3H].sort(), 'oltre i 30 min le navi in moto spariscono');
  assert.ok(opt(FRESH).fillOpacity < 0.75, `di 15 min: sbiadita (${opt(FRESH).fillOpacity})`);
});

test('pagina: un marker già in mappa sparisce quando la sua posizione supera il limite, anche senza posizioni nuove (punto 8)', async () => {
  const A = 247610011;
  const ts = Date.now() - 29 * MIN;
  let advance = 0;
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 1, serverTime: Date.now() + advance }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (isView(url)) return { body: () => ({ type: 'FeatureCollection', total: 1, features: [{ ...feature(A, 11, 44, 0),
      properties: { mmsi: A, sog: 9, timestampExternal: ts } }] }) };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  assert.ok(page.markers().has(A));
  const marker = page.markers().get(A).marker;
  advance = 2 * MIN;   // 2 min dopo la stessa posizione (es. la vista dalla cache del server) è di 31 min fa
  await page.tick();
  await page.tick();   // l'orologio segue l'ora nuova dopo due campioni (mediana)
  assert.equal(page.markers().has(A), false);
  assert.equal(marker.removed, true);
});

// --- Punto 62: pallino colorato dell'età, sempre con il testo ------------------------------------------------
test('pagina: pallino verde/arancio/rosso con il testo dell\'età, in scheda e nei risultati di ricerca (punto 62)', async () => {
  const G = 247620001, O = 247620002, R = 247620003, FAR = 247620004;
  const ship = (mmsi, name, ageMs) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [11, 44] },
    properties: { mmsi, name, sog: 10, cog: 90, navStat: 0, timestampExternal: Date.now() - ageMs } });
  const view = [ship(G, 'ETA VERDE', 2 * MIN), ship(O, 'ETA ARANCIO', 10 * MIN), ship(R, 'ETA ROSSO', 20 * MIN)];
  const remote = [{ mmsi: FAR, name: 'ETA LONTANA', lat: -30, lon: -40, timestampExternal: Date.now() - 7 * MIN }];
  const page = startPage({ routes: url => {
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 3, serverTime: Date.now() }) };
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (url.startsWith('/api/search')) return { body: remote };
    if (isView(url)) return { body: { type: 'FeatureCollection', total: 3, features: view } };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
  } });
  await page.firstTickDone();
  const dot = c => `<span class="age age-${c}" aria-hidden="true"></span>`;
  for (const [mmsi, c, text] of [[G, 'verde', '2 min fa'], [O, 'arancio', '10 min fa'], [R, 'rosso', '20 min fa']]) {
    page.ctx.select(mmsi);
    const row = page.el('content').innerHTML.match(/<td>Ultimo segnale<\/td><td>(.*?)<\/td>/)[1];
    assert.ok(row.startsWith(dot(c) + text + ' ('), `${c}: ${row}`);
  }

  // ricerca: risultati del server (con timestampExternal) e navi in mappa, ognuno con pallino e testo
  // ricerca senza l'attesa fra i tasti (runSearch; attesa e tastiera in test/pagina-ricerca.test.js)
  page.el('q').value = 'eta';
  await page.ctx.runSearch('eta');
  const res = page.el('results').innerHTML;
  // nome con il suo id (nome accessibile, punto 12), MMSI con l'etichetta «MMSI » solo per i lettori di schermo
  const named = (c, name) => new RegExp(`${dot(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<b id="res-\\d+-n">${name}</b>`);
  assert.match(res, named('arancio', 'ETA LONTANA'), 'risultato del server: pallino');
  assert.match(res, /<b id="res-247620004-n">ETA LONTANA<\/b><span class="mmsi" id="res-247620004-m"><span class="sr-only">MMSI <\/span>247620004<\/span><small id="res-247620004-d">[^<]*7 min fa<\/small>/, 'e il testo dell\'età');
  assert.ok(named('verde', 'ETA VERDE').test(res) && res.includes('2 min fa'), 'nave in mappa');
  assert.match(res, named('rosso', 'ETA ROSSO'));
});

// --- Correzioni dopo revisione e QA (punti 8 e 62) ---------------------------------------------------------------
const baseRoutes = (over = {}) => url => {
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 1, serverTime: Date.now() + (over.advance?.() || 0),
    ...(over.limits !== undefined && { limits: over.limits }) }) };
  if (url.endsWith('/vessels')) return { body: [] };
  if (url.startsWith('/api/vessel')) return { body: null };
  if (url.startsWith('/api/search')) return { body: () => over.search?.() || [] };
  if (isView(url)) return { body: () => ({ type: 'FeatureCollection', total: 0, features: over.view?.() || [] }) };
  if (isInclude(url)) return { body: () => ({ type: 'FeatureCollection', total: 0, features: over.include?.() || [] }) };
  if (url.includes('digitraffic')) return { body: () => ({ type: 'FeatureCollection', features: over.baltic?.() || [] }) };
};
const shipAt = (mmsi, ts, extra) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [11, 44] },
  properties: { mmsi, name: 'N' + mmsi, sog: 10, cog: 90, navStat: 0, timestampExternal: ts, ...extra } });
// riga «Ultimo segnale» della scheda (nel DOM finto dataset non converte in stringa, quindi render rifà sempre tutto
// il contenuto e #facts resta vuota)
const lastSeen = page => page.el('content').innerHTML.match(/<td>Ultimo segnale<\/td><td>(.*?)<\/td>/)[1];
const hms = t => new Date(t).toLocaleTimeString('it-IT');
const dotOf = c => `<span class="age age-${c}" aria-hidden="true"></span>`;
// gestori registrati con addEventListener (il DOM finto non li conserva): li ricavo rieseguendo la registrazione
function handler(page, id, from, to) {
  const got = [];
  page.el(id).addEventListener = (type, fn) => got.push(fn);
  vm.runInContext(pageScript.slice(pageScript.indexOf(from), pageScript.indexOf(to)), page.ctx);
  return got[0];
}

test('pagina: scheda aperta su una nave scaduta: «posizione scaduta (ultima: …)» con il pallino rosso; prima l\'età si aggiorna a ogni giro', async () => {
  const X = 247630001;
  let ts = Date.now() - 28 * MIN, advance = 0;
  const page = startPage({ routes: baseRoutes({ advance: () => advance, view: () => [shipAt(X, ts)], include: () => [shipAt(X, ts)] }) });
  await page.firstTickDone();
  page.ctx.select(X);
  assert.ok(lastSeen(page).startsWith(dotOf('rosso') + `28 min fa (${hms(ts)})`), lastSeen(page));
  advance = MIN;   // un minuto dopo, stessa posizione: l'età nella scheda cresce
  await page.tick(); await page.tick();
  assert.ok(lastSeen(page).includes(`29 min fa (${hms(ts)})`), lastSeen(page));
  advance = 3 * MIN;   // 31 min: oltre il limite delle navi in moto, il marker sparisce ma la scheda resta e lo dice
  await page.tick(); await page.tick(); await page.tick();   // l'orologio (mediana di 5 campioni) segue dopo tre giri
  assert.equal(page.markers().has(X), false, 'marker tolto');
  assert.equal(page.get('selected'), X, 'la nave resta selezionata');
  assert.equal(page.el('panel').style.display, 'block', 'scheda aperta');
  assert.equal(lastSeen(page), dotOf('rosso') + `posizione scaduta (ultima: ${hms(ts)})`);
  assert.match(page.el('content').innerHTML, /<td>Velocità \/ Rotta<\/td><td>10\.0 kn \/ 90\.0°<\/td>/, 'gli altri dati dell\'ultima posizione restano');
  // arriva una posizione nuova: la nave torna in mappa con il bordo giallo e la scheda torna all'età
  ts = Date.now() + advance;
  await page.tick();
  assert.ok(page.markers().has(X));
  assert.equal(page.markers().get(X).marker.options.color, '#ffc83d');
  assert.ok(lastSeen(page).startsWith(dotOf('verde') + `adesso (${hms(ts)})`), lastSeen(page));
});

test('pagina: limiti del server da /api/status per le navi del server; Baltico con i limiti normali; limiti non validi = normali', async () => {
  const MOVING = 247640001, STILL = 247640002, BALTIC = 230640003;
  const now = Date.now();
  const view = () => [shipAt(MOVING, now - 2 * MIN), shipAt(STILL, now - 90 * 1000, { sog: 0, navStat: 5 })];
  const baltic = () => [shipAt(BALTIC, now - 2 * MIN)];
  const page = startPage({ routes: baseRoutes({ view, baltic, limits: { movingMs: 60000, stillMs: 120000 } }) });
  await page.firstTickDone();
  assert.deepEqual([...page.markers().keys()].sort(), [STILL, BALTIC].sort(), 'in moto di 2 min tolta (limite del server 1 min)');
  assert.ok(page.markers().get(STILL).marker.options.dashArray, 'ferma di 90 s tratteggiata (oltre il limite delle navi in moto del server)');
  assert.equal(page.markers().get(STILL).marker.tooltip(), `N${STILL} · ferma · posizione di 1 min fa`);
  assert.equal(page.markers().get(BALTIC).marker.options.dashArray, null, 'Baltico: limiti normali, non tratteggiata');
  assert.deepEqual({ ...page.get('serverLimits') }, { movingMs: 60000, stillMs: 120000 });
  page.ctx.select(STILL);
  assert.ok(lastSeen(page).startsWith(dotOf('verde') + 'posizione di 1 min fa ('), lastSeen(page));

  for (const limits of [undefined, { movingMs: '60000', stillMs: 120000 }, { movingMs: 0, stillMs: 120000 }, null]) {
    const other = startPage({ routes: baseRoutes({ view, baltic, limits }) });
    await other.firstTickDone();
    assert.equal(other.markers().size, 3, `limiti ${JSON.stringify(limits)}: quelli normali, nessuna nave tolta`);
    assert.equal(other.markers().get(STILL).marker.options.dashArray, null);
  }
});

test('pagina: un solo setStyle per marker a ogni giro (colore del tipo e stile dell\'età insieme)', async () => {
  const A = 247650001, B = 247650002;
  const now = Date.now();
  const page = startPage({ routes: baseRoutes({ view: () => [shipAt(A, now), shipAt(B, now - 10 * MIN)] }) });
  await page.firstTickDone();
  const calls = () => [A, B].map(m => page.markers().get(m).marker.styleCalls || 0);
  const before = calls();
  await page.tick();
  assert.deepEqual(calls().map((c, i) => c - before[i]), [1, 1]);
  assert.equal(page.markers().get(A).marker.options.fillColor, '#9aa7b6', 'colore del tipo (sconosciuto) nello stesso setStyle');
});

test('pagina: ricerca: risultati del server scaduti segnati «posizione scaduta» (pallino rosso) e la scheda lo dice; tratteggiati «posizione di 40 min fa»', async () => {
  const EXP = 247660001, OLDM = 247660002, FRESHR = 247660003;
  const now = Date.now();
  const remote = [
    { mmsi: EXP, name: 'CERCA SCADUTA', lat: -30, lon: -40, sog: 10, navStat: 0, timestampExternal: now - 40 * MIN },
    { mmsi: OLDM, name: 'CERCA ORMEGGIATA', lat: -31, lon: -41, sog: 0, navStat: 5, timestampExternal: now - 40 * MIN },
    { mmsi: FRESHR, name: 'CERCA FRESCA', lat: -32, lon: -42, sog: 9, navStat: 0, timestampExternal: now - 2 * MIN }];
  const page = startPage({ routes: baseRoutes({ search: () => remote }) });
  await page.firstTickDone();
  page.el('q').value = 'cerca';
  await page.ctx.runSearch('cerca');
  const res = page.el('results').innerHTML;
  const row = (c, name, mmsi, age) => new RegExp(`${dotOf(c)}<b id="res-${mmsi}-n">${name}</b><span class="mmsi" id="res-${mmsi}-m">`
    + `<span class="sr-only">MMSI </span>${mmsi}</span><small id="res-${mmsi}-d">[^<]*${age}</small>`);
  assert.match(res, row('rosso', 'CERCA SCADUTA', EXP, 'posizione scaduta'), res);
  assert.match(res, row('rosso', 'CERCA ORMEGGIATA', OLDM, 'posizione di 40 min fa'), 'come tooltip e scheda');
  assert.match(res, row('verde', 'CERCA FRESCA', FRESHR, '2 min fa'));
  assert.equal(page.get('meta').get(EXP).sog, undefined, 'velocità e stato non finiscono nei dati statici');

  // clic sul risultato scaduto: la scheda si apre e dice che la posizione è scaduta
  const onClick = handler(page, 'results', "$('results').addEventListener('click'", '\nasync function tick()');
  await onClick({ target: { closest: () => ({ dataset: { mmsi: String(EXP) } }) } });
  assert.equal(page.get('selected'), EXP);
  assert.equal(page.el('panel').style.display, 'block');
  assert.equal(lastSeen(page), dotOf('rosso') + `posizione scaduta (ultima: ${hms(now - 40 * MIN)})`);
  await page.tick();   // al giro dopo (include= senza risposta) la scheda resta coerente
  assert.equal(lastSeen(page), dotOf('rosso') + `posizione scaduta (ultima: ${hms(now - 40 * MIN)})`);
});

// Contrasto (WCAG 2.1) del bordo delle navi in moto sbiadite sulla mappa scura: tile di OpenStreetMap con il filtro
// della pagina (.tiles: invert(1) hue-rotate(180deg) brightness(.9) contrast(.9), in sRGB) e mappa senza tile
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const lum = c => { const l = c.map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const clamp = v => Math.max(0, Math.min(1, v));
function tileFilter(c) {
  c = c.map(v => 1 - v);
  const m = [[-0.574, 1.43, 0.144], [0.426, 0.43, 0.144], [0.426, 1.43, -0.856]];   // hue-rotate(180deg)
  c = m.map(r => clamp(r[0] * c[0] + r[1] * c[1] + r[2] * c[2]));
  return c.map(v => clamp((clamp(v * 0.9) - 0.5) * 0.9 + 0.5));
}
test('pagina: il bordo delle navi in moto sbiadite resta almeno 3:1 sulla mappa scura (terra, mare, bosco, senza tile)', async () => {
  const page = startPage({ routes: baseRoutes({}) });
  await page.firstTickDone();
  const backgrounds = { terra: tileFilter(rgb('#f2efe9')), mare: tileFilter(rgb('#aad3df')), bosco: tileFilter(rgb('#add19e')),
    residenziale: tileFilter(rgb('#e0dfdf')), 'senza tile': rgb('#0b1118') };
  const now = Date.now();
  for (const ageMin of [2.5, 10, 20, 29.9]) {
    const st = page.get(`markerStyle({ sog: 10, navStat: 0, timestampExternal: ${now - ageMin * MIN} }, false, ${now})`);
    assert.ok(st.fillOpacity >= 0.35, `${ageMin} min: riempimento ${st.fillOpacity}`);
    for (const [name, bg] of Object.entries(backgrounds)) {
      const seen = rgb(st.color).map((v, i) => st.opacity * v + (1 - st.opacity) * bg[i]);
      assert.ok(ratio(seen, bg) >= 3, `${ageMin} min su ${name}: ${ratio(seen, bg).toFixed(2)}:1 (bordo ${st.color} al ${st.opacity})`);
    }
  }
});
