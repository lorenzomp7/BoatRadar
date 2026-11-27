// Punto 24: «Segui» nella pagina (boatradar.html) senza browser (test/pagina-helpers.js). Con «Segui» acceso la mappa si
// sposta (panBy animato, 0,8 s) solo quando la nave selezionata esce dalla zona centrale dell'area libera (sotto
// l'header, a sinistra della scheda su computer, sopra la scheda su telefono) e la riporta al centro; premendo «Segui» la
// nave si centra subito. Uno spostamento di «Segui» ancora coperto dalla vista chiesta l'ultima volta non fa nessuna
// richiesta /locations in più; l'animatore si ferma durante lo spostamento e riparte alla fine. Si spegne trascinando la
// mappa (con l'avviso), con le frecce sulla mappa, scegliendo un'altra nave, chiudendo la scheda e aprendo i registri;
// lo zoom lo lascia acceso. Nel link come segui=1. Il controllo nel browser vero è in tools/smoke-browser.sh.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until, sleep } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const A = 247000001, B = 247000002;
const fix = (mmsi, lat, lon, ts, props = {}) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, name: mmsi === A ? 'ALFA' : 'BRAVO', shipType: 70, sog: 0, navStat: 5, timestampExternal: ts, ...props } });
// server finto: la vista e include= restituiscono state.features (modificabile dal test)
function routesOf(state) {
  return (url, now) => {
    if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 2, serverTime: now() }) };
    if (url.startsWith('/api/vessel?')) return { body: null };
    if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: state.features.length, features: state.features }) };
  };
}
// Mappa finta 1000 × 800 (computer), header fino a 60, scheda da x 648 (1000 − 352): area libera x 0…648, y 60…800,
// centro 324, 430, zona centrale x 162…486, y 245…615. Proiezione: 1e5 px per grado (lon 11, lat 44 → 500, 400) meno
// gli spostamenti panBy fatti finora (la nave si sposta sullo schermo al contrario della mappa).
const RECTS = { header: { left: 56, top: 12, right: 600, bottom: 60 }, map: { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 },
  panel: { left: 648, top: 12, right: 988, bottom: 788, width: 340, height: 776 } };
const PHONE = { media: { '(max-width: 640px)': true, '(pointer: coarse)': true }, size: { x: 390, y: 844 }, viewport: { w: 390, h: 844 },
  rects: { header: { left: 56, top: 8, right: 382, bottom: 96 }, map: { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 } } };
function startFollow(state, opts = {}) {
  let page = null;
  const base = opts.base || (ll => ({ x: 500 + (ll.lng - 11) * 1e5, y: 400 - (ll.lat - 44) * 1e5 }));
  const project = ll => {
    const p = base(ll), pans = page?.map.pans || [];
    return { x: p.x - pans.reduce((s, a) => s + a[0][0], 0), y: p.y - pans.reduce((s, a) => s + a[0][1], 0) };
  };
  page = startPage({ routes: routesOf(state), rects: RECTS, ...opts, project });
  return page;
}
const T0 = Date.now() - 5000;   // ora delle prime posizioni (la pagina senza ora manuale parte da adesso)
const pressed = page => page.el('follow').getAttribute('aria-pressed');
const clickFollow = page => page.fireEl('follow', 'click');
// fine dello spostamento animato di Leaflet: movestart all'inizio, moveend alla fine
const endPan = page => { page.map.fire('movestart'); page.map.fire('moveend'); };
const bboxRequests = page => page.requests.filter(r => r.url.startsWith('/api/locations?bbox')).length;
async function ready(state, opts) {
  const page = startFollow(state, opts);
  await until(() => state.features.every(f => page.markers().has(f.mmsi)) && /in mappa/.test(page.status()), 'navi in mappa');
  return page;
}
// nuova posizione di A (ora della pagina) e un giro
async function moveA(page, state, lon, lat = 44) {
  state.features = [fix(A, lat, lon, page.pageNow()), ...state.features.filter(f => f.mmsi !== A)];
  await page.tick();
}

test('«Segui» premuto: la nave si centra subito nell\'area libera (a sinistra della scheda), aria-pressed true', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  assert.equal(pressed(page), 'false');
  assert.equal(page.map.pans.length, 0, 'in 500, 400 la nave non è sotto la scheda');
  clickFollow(page);
  assert.equal(pressed(page), 'true');
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.pans.at(-1))), [[176, -30], { duration: 0.8 }], 'da 500, 400 al centro 324, 430');
  clickFollow(page);
  assert.equal(pressed(page), 'false', 'un secondo clic lo spegne');
  assert.equal(page.el('toast').style.display, undefined, 'spento dal pulsante: nessun avviso');
});

test('la mappa si sposta solo quando la nave esce dalla zona centrale, e la riporta al centro', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  const n = page.map.pans.length;
  await moveA(page, state, 11.001);   // 500 + 100 − 176 = 424: nella zona (x ≤ 486)
  assert.equal(page.map.pans.length, n, 'nella zona centrale: nessuno spostamento');
  await moveA(page, state, 11.0016);   // 484: ancora dentro
  assert.equal(page.map.pans.length, n);
  await moveA(page, state, 11.002);   // 524: fuori → al centro 324
  assert.equal(page.map.pans.length, n + 1);
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([200, 0]));
  // durante lo spostamento (prima di moveend) nessun altro spostamento, anche se il giro la vede ancora fuori
  await moveA(page, state, 11.004);
  assert.equal(page.map.pans.length, n + 1, 'spostamento in corso');
  endPan(page);
  await moveA(page, state, 11.004);   // 724 − 200 = 524: di nuovo fuori
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([200, 0]));
  // in verticale: verso nord, fuori dall'alto della zona (y < 245)
  endPan(page);
  await moveA(page, state, 11.004, 44.002);   // x 900 − 576 = 324, y 200 + 30 = 230
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([0, -200]));
});

test('spostamento di «Segui» coperto dalla vista chiesta: nessuna richiesta /locations in più; uno dell\'utente sì', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const bounds = { w: 10, s: 43, e: 12, n: 45 };
  const page = await ready(state, { bounds });
  page.get(`select(${A})`);
  clickFollow(page);
  const before = bboxRequests(page);
  endPan(page);
  await sleep(60);   // 600 ms della pagina: oltre i 300 ms del giro dopo uno spostamento
  assert.equal(bboxRequests(page), before, 'vista ancora coperta: nessun giro');
  assert.equal(page.get('followStats.skipped'), 1);
  // spostamento dell'utente (non di «Segui»): un giro
  page.map.fire('movestart'); page.map.fire('moveend');
  await until(() => bboxRequests(page) === before + 1, 'giro dopo lo spostamento dell\'utente');
  // «Segui» che porta la mappa fuori dalla vista chiesta (allargata del 20 %): un giro
  await sleep(30);
  await moveA(page, state, 11.004);
  const n = bboxRequests(page);
  bounds.w = 10.5; bounds.e = 12.5;
  endPan(page);
  await until(() => bboxRequests(page) === n + 1, 'giro: vista non più coperta');
});

test('antimeridiano: dopo uno spostamento di «Segui» si fa sempre il giro', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state, { bounds: { w: 170, s: 43, e: 190, n: 45 } });
  page.get(`select(${A})`);
  clickFollow(page);
  const before = bboxRequests(page);
  endPan(page);
  await until(() => bboxRequests(page) === before + 1, 'giro');
});

test('animatore: fermo durante lo spostamento di «Segui», riparte alla fine; followCheck dopo una scelta, mai in un passo', async () => {
  const state = { features: [fix(A, 44, 11, T0, { sog: 10, cog: 90, heading: 90, navStat: 0 })] };
  const page = await ready(state, { manualTime: T0 + 1000, zoom: 14 });
  page.get(`select(${A})`);
  page.frame();   // scelta
  clickFollow(page);
  page.map.fire('movestart');
  assert.equal(page.get('anim.paused'), true);
  assert.equal(page.rafPending(), 0, 'nessun fotogramma durante lo spostamento');
  page.map.fire('moveend');
  assert.equal(page.get('anim.paused'), false);
  assert.equal(page.rafPending(), 1, 'il ciclo riparte');
  const calls = page.get('followStats.calls');
  page.frame();   // scelta subito dopo moveend
  assert.equal(page.get('followStats.calls'), calls + 1, 'dopo la scelta');
  page.advance(100);
  page.frame();   // passo
  assert.equal(page.get('followStats.calls'), calls + 1, 'nessun controllo nei passi');
});

test('con prefers-reduced-motion lo spostamento non è animato', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state, { media: { '(prefers-reduced-motion: reduce)': true } });
  page.get(`select(${A})`);
  clickFollow(page);
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.pans.at(-1))), [[176, -30], { animate: false }]);
});

test('telefono: area libera fra header e scheda a metà', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  // nave in 195, 300: sopra la scheda (cima 422), banda 96…422, centro 259
  const page = await ready(state, { ...PHONE, base: ll => ({ x: 195 + (ll.lng - 11) * 1e5, y: 300 - (ll.lat - 44) * 1e5 }) });
  page.get(`select(${A})`);
  assert.equal(page.map.pans.length, 0);
  clickFollow(page);
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([0, 41]));
  endPan(page);
  await moveA(page, state, 11, 43.999);   // y 259 + 100 = 359: dentro (zona fino a 340,5)? no: 359 > 340,5 → al centro
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([0, 100]));
});

test('trascinare la mappa spegne «Segui» a fine trascinamento (oltre 10 px) con l\'avviso; durante nessuno spostamento', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.map.fire('movestart'); page.map.fire('dragstart');
  const n = page.map.pans.length;
  await moveA(page, state, 11.004);
  assert.equal(page.map.pans.length, n, 'durante il trascinamento «Segui» non sposta la mappa');
  assert.equal(pressed(page), 'true', 'deciso a fine trascinamento');
  page.map.fire('dragend', { distance: 50 }); page.map.fire('moveend');
  assert.equal(pressed(page), 'false');
  assert.match(page.el('toast').innerHTML, /Segui disattivato: hai spostato la mappa/);
  await moveA(page, state, 11.008);
  assert.equal(page.map.pans.length, n);
});

test('trascinamento di pochi px (tocco) o pizzico a due dita (zoomstart durante il trascinamento): «Segui» resta acceso', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.map.fire('movestart'); page.map.fire('dragstart'); page.map.fire('dragend', { distance: 4 }); page.map.fire('moveend');
  assert.equal(pressed(page), 'true', '4 px: un tocco');
  // pizzico: il primo dito parte come trascinamento, poi il secondo avvia lo zoom (Leaflet: zoomstart di TouchZoom)
  page.map.fire('movestart'); page.map.fire('dragstart'); page.map.fire('zoomstart');
  page.map.fire('dragend', { distance: 80 }); page.map.fire('zoomend'); page.map.fire('moveend');
  assert.equal(pressed(page), 'true', 'pizzico: zoom, non uno spostamento');
  assert.notEqual(page.el('toast').style.display, 'block', 'nessun avviso');
  // il trascinamento dopo, senza zoom, lo spegne (lo stato del pizzico non resta)
  page.map.fire('movestart'); page.map.fire('dragstart'); page.map.fire('dragend', { distance: 80 }); page.map.fire('moveend');
  assert.equal(pressed(page), 'false');
});

test('map.stop() mai chiamato (in Leaflet manda un moveend); con la mappa in movimento (es. keepVisible) il controllo aspetta il moveend', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.map.fire('movestart');   // spostamento animato di un altro (es. keepVisible) in corso
  const n = page.map.pans.length;
  await moveA(page, state, 11.004);
  assert.equal(page.map.pans.length, n, 'mappa in movimento: nessuno spostamento sopra un altro');
  page.map.fire('moveend');
  await until(() => page.map.pans.length === n + 1, 'spostamento al moveend');
  assert.equal(page.map.stops, 0, 'nessun map.stop()');
});

test('popup «N navi qui» aperto: nessuno spostamento di «Segui»', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.get('pickPopup = { getElement() { return null; } }');
  const n = page.map.pans.length;
  await moveA(page, state, 11.004);
  assert.equal(page.map.pans.length, n);
  page.get('pickPopup = null');
  page.get('followCheck()');
  assert.equal(page.map.pans.length, n + 1);
});

test('telefono con il pannello aperto fin sotto l\'header (area libera negativa): nessuno spostamento a ogni giro', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state, { ...PHONE, base: ll => ({ x: 195 + (ll.lng - 11) * 1e5, y: 300 - (ll.lat - 44) * 1e5 }) });
  page.get(`select(${A})`);
  page.get('setStop(2)');
  const { top, bottom, size } = page.get('freeArea()');
  assert.ok(size.y - bottom - top < 88, `area libera alta ${size.y - bottom - top} px`);
  const n = page.map.pans.length;
  clickFollow(page);
  assert.equal(pressed(page), 'true');
  // ogni spostamento (se ci fosse) finisce con il suo moveend prima del giro dopo
  for (const lon of [11.001, 11.002, 11.003, 11.004, 11.005]) { endPan(page); await moveA(page, state, lon, 43.998); }
  assert.equal(page.map.pans.length, n, 'premuto e 5 giri: nessuno spostamento');
});

test('hashchange con «Segui» acceso: spento con l\'avviso se la vista cambia; stessa vista: resta', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state, { href: 'https://lorenzo.example/boatradar/', trackView: true });
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.location.hash = '#30,10,3';   // la vista di adesso
  page.fire('hashchange');
  assert.equal(pressed(page), 'true', 'stessa vista');
  page.location.hash = '#40.5,14.25,10';
  page.fire('hashchange');
  assert.equal(pressed(page), 'false');
  assert.match(page.el('toast').innerHTML, /Segui disattivato/);
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.views.at(-1))), [[40.5, 14.25], 10]);
});

test('frecce con il focus sulla mappa spengono «Segui» con l\'avviso; zoom (tasto +, zoomstart/zoomend), altri tasti e frecce su pulsanti no', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.dispatch('map', 'keydown', { key: '+' });
  page.dispatch('map', 'keydown', { key: 'Tab' });
  // frecce con il focus su un pulsante di zoom, sul popup o sull'attribuzione (dentro #map): non spostano la mappa
  for (const id of ['zoom-in', 'popup-row', 'attribution']) page.dispatch('map', 'keydown', { key: 'ArrowLeft', target: page.el(id) });
  page.map.fire('zoomstart'); page.map.fire('zoomend'); page.map.fire('moveend');
  assert.equal(pressed(page), 'true', 'lo zoom lascia «Segui» acceso');
  page.dispatch('map', 'keydown', { key: 'ArrowLeft' });
  assert.equal(pressed(page), 'false');
  assert.match(page.el('toast').innerHTML, /Segui disattivato: hai spostato la mappa/);
});

test('zoomend: controllo subito dopo lo zoom, senza aspettare il giro', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  const n = page.map.pans.length;
  // dopo lo zoom la nave è altrove sullo schermo: qui la sposto a mano nel marker (la proiezione finta non ha zoom)
  page.markers().get(A).marker.latlng = [44, 11.004];
  page.map.fire('zoomend');
  await until(() => page.map.pans.length === n + 1, 'spostamento dopo zoomend');
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([400, 0]));
  assert.equal(pressed(page), 'true');
});

test('scegliere un\'altra nave, chiudere la scheda o aprire i registri spegne «Segui»; niente con la scheda trascinata o nascosta', async () => {
  const state = { features: [fix(A, 44, 11, T0), fix(B, 44, 11.0001, T0)] };
  const page = await ready(state);
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  page.get(`select(${A})`);
  assert.equal(pressed(page), 'true', 'la stessa nave: resta acceso');
  page.get(`select(${B})`);
  assert.equal(pressed(page), 'false', 'un\'altra nave');
  clickFollow(page);
  endPan(page);
  page.el('close').onclick();
  assert.equal(pressed(page), 'false', 'scheda chiusa');
  page.get(`select(${B})`);
  clickFollow(page);
  endPan(page);
  page.el('registries').onclick();
  assert.equal(page.get('follow'), false, 'registri');
  // scheda nascosta (document.hidden) o pannello trascinato: nessun controllo
  page.get(`select(${A})`);
  clickFollow(page);
  endPan(page);
  const n = page.map.pans.length;
  page.document.hidden = true;
  await moveA(page, state, 11.004);
  assert.equal(page.map.pans.length, n, 'scheda del browser nascosta');
  page.document.hidden = false;
  page.get('sheet.drag = { id: 1 }');
  page.get('followCheck()');
  assert.equal(page.map.pans.length, n, 'durante il trascinamento del pannello');
  page.get('sheet.drag = null');
  page.get('followCheck()');
  assert.equal(page.map.pans.length, n + 1);
});

test('link: segui=1 nell\'indirizzo con «Segui» acceso, tolto spegnendolo e chiudendo la scheda; all\'avvio da ?mmsi=…&segui=1', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const BASE = 'https://lorenzo.example/boatradar/';
  const page = await ready(state, { href: BASE, trackView: true });
  page.get(`select(${A})`);
  clickFollow(page);
  await until(() => page.urls.at(-1)?.includes('segui=1'), 'segui=1 nell\'indirizzo');
  assert.equal(page.urls.at(-1), `/boatradar/?mmsi=${A}&segui=1#30,10,3`);
  clickFollow(page);
  await until(() => !page.urls.at(-1).includes('segui'), 'segui tolto');
  clickFollow(page);
  await until(() => page.urls.at(-1).includes('segui=1'), 'di nuovo');
  page.el('close').onclick();
  await until(() => page.urls.at(-1) === '/boatradar/#30,10,3', 'scheda chiusa: niente mmsi né segui');
  const linked = startFollow(state, { href: `${BASE}?mmsi=${A}&segui=1#44,11,9`, trackView: true });
  await until(() => linked.get('follow') === true, '«Segui» acceso dal link');
  assert.equal(linked.el('follow').getAttribute('aria-pressed'), 'true');
  assert.equal(linked.get('selected'), A);
});

test('marcatura: #follow con aria-pressed prima di «Condividi» in #panel-actions; stato premuto non solo col colore', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'boatradar.html'), 'utf8');
  assert.match(html, /<div id="panel-head"><\/div><div id="panel-actions" role="group" aria-label="Azioni sulla nave" hidden><button type="button" id="follow" class="pbtn" aria-pressed="false"[^>]*>Segui<\/button><button type="button" id="share" class="pbtn">Condividi<\/button><\/div>/);
  assert.match(html, /#panel-actions \.pbtn\[aria-pressed="true"\] \{[^}]*background:var\(--accent\)/);
  assert.match(html, /#panel-actions \.pbtn\[aria-pressed="true"\]::before \{ content:'✓ '; content:'✓ ' \/ ''; \}/, 'segno di spunta, nascosto ai lettori di schermo');
});
