// Pagina (boatradar.html) in un contesto vm con Leaflet, DOM, fetch e orologio finti, per i test della pagina che
// riguardano la rete (test/pagina-backend.test.js). Stesso approccio di test/pagina-vm.test.js, che resta com'è, con in
// più: config.js (window.BOATRADAR_APIS), sessionStorage, fetch che può fallire, non rispondere (con AbortController) o
// rispondere con un errore HTTP, ora della pagina che corre come i timer (TIME_SCALE volte più veloce) e registro dei
// setTimeout di tick() (i tentativi dopo un errore).
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
// { body, delay, status } | { fail: true } (rete giù) | { hang: true } (nessuna risposta) | undefined (404).
// timeScale: quante volte l'ora e i timer della pagina corrono più veloci di quelli veri (TIME_SCALE; di più per i test
// che devono far passare minuti, come il ritorno al server principale dopo 5 min).
// media: risposte di matchMedia per query (es. { '(pointer: coarse)': true }); size e project: dimensioni e proiezione
// della mappa finta (punto 10, scelta tra navi sovrapposte).
function startPage({ routes, config = {}, session = {}, timeScale = TIME_SCALE, media = {},
  size = { x: 1000, y: 800 }, project = ll => ({ x: 500 + (ll.lng - 11) * 1e5, y: 400 - (ll.lat - 44) * 1e5 }) }) {
  const realStart = Date.now();
  const pageNow = () => realStart + (Date.now() - realStart) * timeScale;
  const elements = new Map();
  // listener di document (keydown di Esc): docListeners in ordine di registrazione, con capture
  const docListeners = [];
  const document = { activeElement: null, getElementById: id => el(id), querySelector: sel => el(sel),
    body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } },
    addEventListener(type, fn, opts) { docListeners.push({ type, fn, capture: opts === true || !!opts?.capture }); } };
  const el = id => {
    if (!elements.has(id)) elements.set(id, { id, style: {}, dataset: {}, textContent: '', innerHTML: '', open: true,
      isConnected: true, addEventListener() {}, focus() { document.activeElement = this; }, getClientRects: () => [{}],
      contains(x) { return x === this; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });
    return elements.get(id);
  };
  // tasto premuto con il focus su target (default document.activeElement): prima i listener con capture, poi gli altri,
  // fermandosi a stopPropagation; restituisce l'evento (defaultPrevented)
  const keydown = (key, target = document.activeElement) => {
    const e = { key, target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    for (const capture of [true, false]) for (const l of docListeners) if (l.type === 'keydown' && l.capture === capture && !e.stopped) l.fn(e);
    return e;
  };
  const requests = [];
  class PageDate extends Date {
    constructor(...a) { super(...(a.length ? a : [pageNow()])); }
    static now() { return pageNow(); }
  }
  class FakeMarker {
    constructor(latlng, options) { this.latlng = latlng; this.options = { ...options }; }
    on() { return this; } addTo() { return this; } bringToFront() { return this; } redraw() { return this; }
    bindTooltip() { return this; } closeTooltip() { return this; } setLatLng(ll) { this.latlng = ll; return this; } setStyle(s) { Object.assign(this.options, s); return this; }
    getLatLng() { return { lat: this.latlng[0], lng: this.latlng[1] }; } remove() {}
  }
  // Mappa finta: eventi registrati (fire), dimensioni size e proiezione project(latlng) → punto del contenitore;
  // popup: uno aperto alla volta, popupopen e popupclose come Leaflet
  const mapHandlers = new Map();
  // views: argomenti di ogni setView (il primo è la vista iniziale della pagina)
  const views = [];
  const map = { views, setView(...a) { views.push(a); return this; }, invalidateSize() {}, getZoom: () => 6,
    on(ev, fn) { for (const e of ev.split(' ')) mapHandlers.set(e, [...(mapHandlers.get(e) || []), fn]); return this; },
    fire(ev, data = {}) { for (const fn of mapHandlers.get(ev) || []) fn({ type: ev, target: map, ...data }); return this; },
    getCenter: () => ({ lat: 44, lng: 11 }),
    getBounds: () => ({ pad: () => ({ getEast: () => 12, getWest: () => 10, getSouth: () => 43, getNorth: () => 45 }) }),
    getSize: () => ({ x: size.x, y: size.y }),
    latLngToContainerPoint: ll => project(Array.isArray(ll) ? { lat: ll[0], lng: ll[1] } : ll),
    mouseEventToContainerPoint: ev => ({ x: ev.clientX, y: ev.clientY }),
    containerPointToLatLng: p => ({ lat: null, lng: null, point: p }),
    _popup: null,
    closePopup() { const p = this._popup; if (p) { this._popup = null; this.fire('popupclose', { popup: p }); } return this; } };
  const canvasOptions = [];
  // Popup finto: content è l'HTML passato a setContent; l'elemento registra i listener e trova le righe data-pick
  class FakePopup {
    constructor(options = {}) { this.options = { ...options }; this.listeners = []; }
    setLatLng(ll) { this.latlng = ll; return this; }
    setContent(c) { this.content = c; return this; }
    openOn(m) { m.closePopup(); m._popup = this; m.fire('popupopen', { popup: this }); return this; }
    isOpen() { return map._popup === this; }
    rows() { return [...String(this.content).matchAll(/data-pick="(\d+)"/g)].map(x => x[1]); }
    getElement() {
      if (!this.el) {
        const popup = this, rows = new Map();
        const row = mmsi => { if (!rows.has(mmsi)) rows.set(mmsi, { dataset: { pick: mmsi },
          closest: sel => (sel.includes('data-pick') ? rows.get(mmsi) : null),
          focus() { document.activeElement = this; } }); return rows.get(mmsi); };
        // × del popup (Leaflet: a.leaflet-popup-close-button) con i suoi attributi; pulsante «e altre N» (data-more)
        const closeButton = { attributes: {}, setAttribute(k, v) { this.attributes[k] = String(v); } };
        const more = { closest: sel => (sel.includes('data-more') ? more : null), focus() { document.activeElement = this; } };
        this.el = { addEventListener: (type, fn) => popup.listeners.push({ type, fn }),
          querySelector: sel => (sel.includes('close-button') ? closeButton
            : sel.includes('pickrow') && popup.rows().length ? row(popup.rows()[0]) : null),
          contains: x => [...rows.values()].includes(x) || x === more, row, closeButton, more };
      }
      return this.el;
    }
    // clic vero su una riga (delegazione: il listener è sull'elemento del popup)
    clickRow(mmsi) { const target = this.getElement().row(String(mmsi)); for (const l of this.listeners) if (l.type === 'click') l.fn({ target }); }
    // clic sul pulsante «e altre N: avvicina la mappa»
    clickMore() { const target = this.getElement().more; for (const l of this.listeners) if (l.type === 'click') l.fn({ target }); }
  }
  // opzioni passate a L.map e a L.control.zoom (titoli dei pulsanti di zoom)
  const mapOptions = [], zoomOptions = [];
  const L = { map: (id, o) => { mapOptions.push(o); return map; }, tileLayer: () => ({ addTo() {} }),
    canvas: o => { canvasOptions.push(o); return {}; },
    control: { zoom: o => { zoomOptions.push(o); return { addTo() { return this; } }; } },
    popup: o => new FakePopup(o), Util: { wrapNum: x => x },
    CircleMarker: { extend(proto) { class M extends FakeMarker {} Object.assign(M.prototype, proto); return M; } } };
  const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const fetch = (url, opts = {}) => {
    const req = { url, at: pageNow(), outcome: 'in corso' };
    requests.push(req);
    const r = routes(url, pageNow);
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal?.aborted) { req.outcome = 'annullata'; return reject(abortError()); }
      signal?.addEventListener('abort', () => { req.outcome = 'annullata'; reject(abortError()); });
      if (r?.hang) return;
      setTimeout(() => {
        if (signal?.aborted) return;
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
    ResizeObserver: class { observe() {} }, matchMedia: q => ({ matches: !!media[q] }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, navigator: {},
  });
  ctx.window = ctx;
  Object.assign(ctx, config);
  vm.runInContext(logicScript, ctx);
  vm.runInContext(pageScript, ctx);
  const get = expr => vm.runInContext(expr, ctx);
  const status = () => el('status').textContent;
  const stop = () => { stopped = true; for (const id of allTimers) clearTimeout(id); allTimers.clear(); };
  return { ctx, el, get, requests, stop, storage, retryTimers, pageNow, status, tick: () => ctx.tick(), markers: () => get('markers'),
    map, canvasOptions, mapOptions, zoomOptions, keydown, document,
    waitStatus: (re, what = String(re), ms) => until(() => re.test(status()), `${what} (stato: «${status()}»)`, ms) };
}

module.exports = { startPage, until, sleep, TIME_SCALE };
