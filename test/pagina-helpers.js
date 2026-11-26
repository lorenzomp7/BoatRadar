// Pagina (boatradar.html) in un contesto vm con Leaflet, DOM, fetch e orologio finti, per i test della pagina che
// riguardano la rete (test/pagina-backend.test.js). Stesso approccio di test/pagina-vm.test.js, che resta com'è, con in
// più: config.js (window.BOATRADAR_APIS), sessionStorage, fetch che può fallire, non rispondere (con AbortController) o
// rispondere con un errore HTTP, ora della pagina che corre come i timer (TIME_SCALE volte più veloce), registro dei
// setTimeout di tick() (i tentativi dopo un errore), scheda nascosta o visibile (setHidden, con l'evento
// visibilitychange), navigator.onLine (page.ctx.navigator) ed eventi di window (fire, per esempio 'online').
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'boatradar.html'), 'utf8');
const pageScript = html.split('<script src="public/ais-logic.js"></script>')[1].split('<script>')[1].split('</script>')[0];
const logicScript = fs.readFileSync(path.join(ROOT, 'public/ais-logic.js'), 'utf8');
const TIME_SCALE = 10;   // timer e ora della pagina 10 volte più veloci: 8 s di timeout = 0,8 s veri

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(5); }
  throw new Error('timeout in attesa di: ' + what);
}

// Avvia la pagina. config = proprietà di window scritte da config.js (es. { BOATRADAR_APIS: [...] }); session = contenuto
// iniziale di sessionStorage, oppure 'throw' per un sessionStorage che lancia (Safari privato); routes(url, pageNow) →
// { body, delay, status } | { fail: true } (rete giù) | { hang: true } (nessuna risposta) | undefined (404). delay in ms
// veri. Ogni richiesta registrata ha url, at (ora della pagina alla partenza), outcome e end (ora della pagina alla fine).
// timeScale: quante volte l'ora e i timer della pagina corrono più veloci di quelli veri (TIME_SCALE; di più per i test
// che devono far passare minuti, come il ritorno al server principale dopo 5 min).
function startPage({ routes, config = {}, session = {}, timeScale = TIME_SCALE }) {
  const realStart = Date.now();
  const pageNow = () => realStart + (Date.now() - realStart) * timeScale;
  const elements = new Map();
  const listeners = new Map();   // eventi di document (per visibilitychange)
  const winListeners = new Map();   // eventi di window (per online)
  const document = { activeElement: null, hidden: false, getElementById: id => el(id),
    body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); } };
  const el = id => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, dataset: {}, textContent: '', innerHTML: '', open: true,
      isConnected: true, addEventListener() {}, focus() { document.activeElement = this; }, getClientRects: () => [{}] });
    return elements.get(id);
  };
  const requests = [];
  class PageDate extends Date {
    constructor(...a) { super(...(a.length ? a : [pageNow()])); }
    static now() { return pageNow(); }
  }
  class FakeMarker {
    constructor(latlng, options) { this.latlng = latlng; this.options = { ...options }; }
    on() { return this; } addTo() { return this; } bringToFront() { return this; } redraw() { return this; }
    bindTooltip() { return this; } setLatLng(ll) { this.latlng = ll; return this; } setStyle(s) { Object.assign(this.options, s); return this; }
    getLatLng() { return { lat: this.latlng[0], lng: this.latlng[1] }; } remove() {}
  }
  const map = { setView() { return this; }, on() { return this; }, invalidateSize() {}, getZoom: () => 6,
    getCenter: () => ({ lat: 44, lng: 11 }),
    getBounds: () => ({ pad: () => ({ getEast: () => 12, getWest: () => 10, getSouth: () => 43, getNorth: () => 45 }) }) };
  const L = { map: () => map, tileLayer: () => ({ addTo() {} }), canvas: () => ({}), Util: { wrapNum: x => x },
    CircleMarker: { extend(proto) { class M extends FakeMarker {} Object.assign(M.prototype, proto); return M; } } };
  const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const fetch = (url, opts = {}) => {
    const req = { url, at: pageNow(), outcome: 'in corso' };
    requests.push(req);
    const r = routes(url, pageNow);
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal?.aborted) { req.outcome = 'annullata'; req.end = pageNow(); return reject(abortError()); }
      signal?.addEventListener('abort', () => { req.outcome = 'annullata'; req.end = pageNow(); reject(abortError()); });
      if (r?.hang) return;
      setTimeout(() => {
        if (signal?.aborted) return;
        req.end = pageNow();
        if (r?.fail) { req.outcome = 'rete'; return reject(new TypeError('Failed to fetch')); }
        const status = r ? r.status || 200 : 404;
        req.outcome = status;
        resolve({ ok: status < 400, status, json: async () => (r && status < 400 ? (typeof r.body === 'function' ? r.body(pageNow) : r.body) : null) });
      }, r?.delay || 0);
    });
  };
  const storage = new Map(Object.entries(session === 'throw' ? {} : session));
  const boom = () => { throw new Error('SecurityError: sessionStorage non disponibile'); };
  const sessionStorage = session === 'throw' ? { getItem: boom, setItem: boom, removeItem: boom }
    : { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  const retryTimers = new Set();   // setTimeout(tick, …) in attesa
  const allTimers = new Set();
  let stopped = false;             // stop(): pagina chiusa, nessun timer parte più (il test può finire)
  const ctx = vm.createContext({
    console, URLSearchParams, URL, Promise, Map, Set, Math, JSON, Number, String, Array, Object, Error, TypeError,
    AbortController, Date: PageDate, fetch, L, document, sessionStorage,
    setTimeout: (fn, ms, ...a) => {
      if (stopped) return 0;
      const isTick = fn === ctx.tick;
      const id = setTimeout((...b) => { retryTimers.delete(id); allTimers.delete(id); if (!stopped) fn(...b); }, (ms || 0) / timeScale, ...a);
      allTimers.add(id);
      if (isTick) retryTimers.add(id);
      return id;
    },
    clearTimeout: id => { retryTimers.delete(id); allTimers.delete(id); clearTimeout(id); },
    setInterval: () => 0,   // gli aggiornamenti periodici li fa il test chiamando tick()
    ResizeObserver: class { observe() {} }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {},
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
  });
  ctx.window = ctx;
  Object.assign(ctx, config);
  vm.runInContext(logicScript, ctx);
  vm.runInContext(pageScript, ctx);
  const get = expr => vm.runInContext(expr, ctx);
  const status = () => el('status').textContent;
  const stop = () => { stopped = true; for (const id of allTimers) clearTimeout(id); allTimers.clear(); };
  // scheda nascosta o di nuovo visibile, come fa il browser: document.hidden e poi l'evento visibilitychange
  const setHidden = hidden => { document.hidden = hidden; for (const fn of listeners.get('visibilitychange') || []) fn({ type: 'visibilitychange' }); };
  // evento di window, come lo manda il browser (es. 'online' quando torna la rete)
  const fire = type => { for (const fn of winListeners.get(type) || []) fn({ type }); };
  return { ctx, el, get, requests, stop, storage, retryTimers, pageNow, status, setHidden, fire, tick: () => ctx.tick(), markers: () => get('markers'),
    waitStatus: (re, what = String(re), ms) => until(() => re.test(status()), `${what} (stato: «${status()}»)`, ms) };
}

module.exports = { startPage, until, sleep, TIME_SCALE };
