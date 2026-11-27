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
// media: risposte di matchMedia per query (es. { '(pointer: coarse)': true }); size e project: dimensioni e proiezione
// della mappa finta (punto 10, scelta tra navi sovrapposte).
// local: contenuto iniziale di localStorage (page.local, Map), oppure 'throw' per un localStorage che lancia (punto 9,
// filtri salvati). Gli elementi registrano i loro listener (addEventListener) e page.fireEl(id, type, event) li chiama;
// setAttribute li scrive in el.attributes.
// Punti 13, 63, 42 (animazione dei marker): manualTime = ora iniziale della pagina (ms) che resta ferma finché il test
// non la cambia (page.setNow, page.advance; Date.now e performance.now la seguono; i timer restano veri); raf = coda di
// requestAnimationFrame (vera di default con manualTime): page.frame() esegue i callback in coda. Senza raf la pagina
// non ha requestAnimationFrame e l'animazione resta spenta (marker all'ultimo segnale, come prima dei punti 13 e 42).
// zoom: zoom iniziale della mappa finta (page.setZoom); bounds: area visibile {w, s, e, n} (getBounds, anche pad());
// canvas: oggetto restituito da L.canvas() (default {}, senza _redraw). page.moves() conta le setLatLng dei marker.
// Punto 71 (pannello con l'elenco): viewport = window.innerWidth/innerHeight (default: size); rects = getBoundingClientRect
// iniziali per id (es. { header: { bottom: 96 } }), prima che parta la pagina; document.body.classList vero
// (page.bodyClasses); document.documentElement e style.setProperty (variabili CSS, page.cssVar); el.querySelector e
// el.contains per i figli [data-mmsi="N"] scritti in innerHTML (page.child; un innerHTML nuovo li scollega:
// isConnected false); map.panBy registrato in page.map.pans; page.dispatch passa anche key e altri campi dell'evento.
function startPage({ routes, config = {}, session = {}, local = {}, timeScale = TIME_SCALE, media = {},
  size = { x: 1000, y: 800 }, project = ll => ({ x: 500 + (ll.lng - 11) * 1e5, y: 400 - (ll.lat - 44) * 1e5 }),
  manualTime = null, raf = manualTime != null, zoom = 6, bounds = { w: 10, s: 43, e: 12, n: 45 }, canvas = () => ({}),
  viewport = { w: size.x, h: size.y }, rects = {} }) {
  const realStart = Date.now();
  let manual = manualTime;
  const pageNow = () => (manual != null ? manual : realStart + (Date.now() - realStart) * timeScale);
  let moves = 0;   // setLatLng dei marker (page.moves)
  const elements = new Map();
  const listeners = new Map();   // eventi di document (per visibilitychange)
  const winListeners = new Map();   // eventi di window (per online)
  // listener di document (keydown di Esc): docListeners in ordine di registrazione, con capture
  const docListeners = [];
  const bodyClasses = new Set();
  const document = { activeElement: null, hidden: false, getElementById: id => el(id), querySelector: sel => el(sel),
    body: { classList: { add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c), contains: c => bodyClasses.has(c),
      toggle: (c, on = !bodyClasses.has(c)) => (on ? bodyClasses.add(c) : bodyClasses.delete(c), on) } },
    get documentElement() { return el('html'); },
    addEventListener(type, fn, opts) {
      if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn);
      docListeners.push({ type, fn, capture: opts === true || !!opts?.capture });
    } };
  // style con setProperty/getPropertyValue (variabili CSS), metodi non enumerabili
  const newStyle = () => Object.defineProperties({}, {
    setProperty: { value(k, v) { this[k] = String(v); } }, getPropertyValue: { value(k) { return this[k] ?? ''; } },
    removeProperty: { value(k) { delete this[k]; } } });
  // figlio [data-mmsi="N"] di un elemento (riga dell'elenco del punto 71): uno per innerHTML scritto
  const childOf = (parent, mmsi) => {
    const key = parent.gen + ':' + mmsi;
    if (!parent.children.has(key)) {
      const gen = parent.gen;
      parent.children.set(key, { parentEl: parent, dataset: { mmsi: String(mmsi) }, get isConnected() { return parent.gen === gen; },
        getClientRects: () => [{}], focus() { document.activeElement = this; }, closest(sel) { return sel.includes('data-mmsi') ? this : null; } });
    }
    return parent.children.get(key);
  };
  const el = id => {
    // listeners: gestori registrati con addEventListener (dispatch li chiama); attributes: setAttribute/getAttribute
    if (!elements.has(id)) elements.set(id, { id, style: newStyle(), dataset: {}, textContent: '', html: '', gen: 0, children: new Map(),
      get innerHTML() { return this.html; }, set innerHTML(v) { this.html = String(v); this.gen++; this.children.clear(); },
      open: true, value: '', hidden: false,
      isConnected: true, listeners: [], addEventListener(type, fn) { this.listeners.push({ type, fn }); },
      attributes: {}, setAttribute(k, v) { this.attributes[k] = String(v); }, getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; }, scrollIntoView() {},
      focus() { document.activeElement = this; }, getClientRects: () => [{}],
      contains(x) { return x === this || (!!x && x.parentEl === this && x.isConnected); },
      querySelector(sel) { const m = /\[data-mmsi="(\d+)"\]/.exec(sel); return m && this.html.includes(`data-mmsi="${m[1]}"`) ? childOf(this, m[1]) : null; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, ...rects[id] }) });
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
    bindTooltip() { return this; } closeTooltip() { return this; } setLatLng(ll) { moves++; this.latlng = ll; return this; } setStyle(s) { Object.assign(this.options, s); return this; }
    getLatLng() { return { lat: this.latlng[0], lng: this.latlng[1] }; } remove() {}
  }
  // Mappa finta: eventi registrati (fire), dimensioni size e proiezione project(latlng) → punto del contenitore;
  // popup: uno aperto alla volta, popupopen e popupclose come Leaflet
  const mapHandlers = new Map();
  // views: argomenti di ogni setView (il primo è la vista iniziale della pagina)
  const views = [];
  let zoomNow = zoom;
  const box = { getEast: () => bounds.e, getWest: () => bounds.w, getSouth: () => bounds.s, getNorth: () => bounds.n };
  const map = { views, pans: [], setView(...a) { views.push(a); return this; }, panBy(...a) { this.pans.push(a); return this; },
    invalidateSize() {}, getZoom: () => zoomNow,
    on(ev, fn) { for (const e of ev.split(' ')) mapHandlers.set(e, [...(mapHandlers.get(e) || []), fn]); return this; },
    fire(ev, data = {}) { for (const fn of mapHandlers.get(ev) || []) fn({ type: ev, target: map, ...data }); return this; },
    getCenter: () => ({ lat: 44, lng: 11 }),
    getBounds: () => ({ ...box, pad: () => ({ ...box }) }),
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
    canvas: o => { canvasOptions.push(o); return canvas(); },
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
  const localMap = new Map(Object.entries(local === 'throw' ? {} : local));
  const boomLocal = () => { throw new Error('SecurityError: localStorage non disponibile'); };
  const localStorage = local === 'throw' ? { getItem: boomLocal, setItem: boomLocal, removeItem: boomLocal }
    : { getItem: k => (localMap.has(k) ? localMap.get(k) : null), setItem: (k, v) => localMap.set(k, String(v)), removeItem: k => localMap.delete(k) };
  const retryTimers = new Set();   // setTimeout(tick, …) in attesa
  const allTimers = new Set();
  let stopped = false;             // stop(): pagina chiusa, nessun timer parte più (il test può finire)
  // coda di requestAnimationFrame (raf): id → callback, eseguiti da page.frame()
  const rafQueue = new Map();
  let rafId = 0;
  const rafApi = raf ? {
    requestAnimationFrame: fn => { if (stopped) return 0; rafQueue.set(++rafId, fn); return rafId; },
    cancelAnimationFrame: id => { rafQueue.delete(id); },
  } : {};
  const ctx = vm.createContext({
    ...rafApi, performance: { now: () => pageNow() },
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
    localStorage, navigator: {}, innerWidth: viewport.w, innerHeight: viewport.h,
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
  });
  ctx.window = ctx;
  Object.assign(ctx, config);
  vm.runInContext(logicScript, ctx);
  vm.runInContext(pageScript, ctx);
  const get = expr => vm.runInContext(expr, ctx);
  const status = () => el('status').textContent;
  const stop = () => { stopped = true; for (const id of allTimers) clearTimeout(id); allTimers.clear(); rafQueue.clear(); };
  // un fotogramma: esegue i callback in coda adesso (quelli che chiedono un altro fotogramma vanno al prossimo);
  // restituisce quanti erano
  const frame = () => { const list = [...rafQueue.values()]; rafQueue.clear(); for (const fn of list) fn(pageNow()); return list.length; };
  // scheda nascosta o di nuovo visibile, come fa il browser: document.hidden e poi l'evento visibilitychange
  const setHidden = hidden => { document.hidden = hidden; for (const fn of listeners.get('visibilitychange') || []) fn({ type: 'visibilitychange' }); };
  // evento di window, come lo manda il browser (es. 'online' quando torna la rete)
  const fire = type => { for (const fn of winListeners.get(type) || []) fn({ type }); };
  // evento sull'elemento id (es. 'click' o 'change' delegati su #legend): event è il resto dell'evento (target…)
  const fireEl = (id, type, event = {}) => { for (const l of el(id).listeners) if (l.type === type) l.fn({ type, preventDefault() {}, ...event }); };
  // evento su un elemento (es. 'input' o 'keydown' sul campo di ricerca): chiama i gestori registrati, restituisce
  // l'evento (defaultPrevented) e i valori restituiti dai gestori (results, per aspettare quelli asincroni)
  const dispatch = (id, type, extra = {}) => {
    const e = { type, target: el(id), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    e.results = el(id).listeners.filter(l => l.type === type).map(l => l.fn(e));
    return e;
  };
  const cssVar = name => el('html').style[name];
  return { ctx, el, get, requests, dispatch, stop, bodyClasses, cssVar, child: childOf, frame, rafPending: () => rafQueue.size, moves: () => moves,
    setNow: t => { manual = t; }, advance: ms => { manual += ms; }, setZoom: z => { zoomNow = z; }, storage, local: localMap, fireEl, retryTimers, pageNow, status, setHidden, fire, tick: () => ctx.tick(), markers: () => get('markers'),
    map, canvasOptions, mapOptions, zoomOptions, keydown, document,
    waitStatus: (re, what = String(re), ms) => until(() => re.test(status()), `${what} (stato: «${status()}»)`, ms) };
}

module.exports = { startPage, until, sleep, TIME_SCALE };
