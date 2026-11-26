// Punti 13, 63, 42 (commit B): animatore dei marker nella pagina (boatradar.html), senza browser (test/pagina-helpers.js
// con ora manuale e coda di requestAnimationFrame). Ogni marker tiene gli ultimi fix (m.track, pushFix) e la posizione
// disegnata (m.shown); un solo ciclo requestAnimationFrame mostra le navi all'ora di riproduzione (15 s di ritardo):
// fra due fix l'interpolazione, oltre l'ultimo la stima da velocità e rotta (al massimo 122 s sopra 3 kn), mai un
// ritorno indietro di meno di 300 m. Al massimo ANIM_MAX navi animate (scelte ogni 3 s per importanza, la selezionata
// sempre), le altre ricalcolate tutte insieme alla scelta. La verifica nel browser vero è il passo «movimento» di
// tools/smoke-browser.sh.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');
const { startPage: start, until } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const T0 = 1_800_000_000_000;   // ora della pagina (manuale) all'inizio di ogni prova
const A = 247100001;
const fix = (mmsi, lat, lon, ts, props = {}) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, sog: 10, cog: 90, heading: 90, navStat: 0, timestampExternal: ts, ...props } });
// server finto: la vista restituisce world() (modificabile dal test), Baltico vuoto, stato con l'ora della pagina
function routesOf(state) {
  return (url, now) => {
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: state.features.length, serverTime: now() }) };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: state.features.length, features: state.features }) };
  };
}
const latlng = (page, mmsi) => { const ll = page.markers().get(mmsi).marker.latlng; return { lat: ll[0], lon: ll[1] }; };
// distanza equirettangolare in metri, come approach
function dist(a, b) {
  const rad = Math.PI / 180, x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad) * AL.R_EARTH;
  return Math.hypot(x, (b.lat - a.lat) * rad * AL.R_EARTH);
}
const east = (p, m) => AL.rhumbDestination(p.lat, p.lon, 90, m);
const near = (a, b, tolM, msg) => assert.ok(dist(a, b) <= tolM, `${msg}: a ${dist(a, b).toFixed(2)} m (tolleranza ${tolM} m)`);

async function ready(state, opts = {}) {
  const page = startPage({ routes: routesOf(state), manualTime: T0 + 1000, zoom: 14, ...opts });
  await until(() => state.features.every(f => page.markers().has(f.mmsi)), 'navi in mappa');
  return page;
}

test('pagina: fra due fix (A a T0, B a T0 + 15 s) all\'ora T0 + 22,5 s la nave è a metà strada (in differita di 15 s)', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  near(latlng(page, A), a, 1e-6, 'nuova nave: al suo fix (riproduzione 15 s indietro)');
  assert.equal(page.get(`markers.get(${A}).track.length`), 1);
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000);
  await page.tick();
  assert.equal(page.get(`markers.get(${A}).track.length`), 2, 'il secondo fix entra nella traccia');
  // nessuna scelta ancora (nessun fotogramma): il giro la mette subito all'ora di riproduzione, T0 + 1 s fra A e B
  near(latlng(page, A), AL.interpolate({ ...a, ts: T0 }, { ...b, ts: T0 + 15000 }, T0 + 1000), 0.01, 'giro: posizione di adesso');
  page.setNow(T0 + 22500);
  page.frame();   // scelta delle navi da animare
  page.frame();   // passo
  const mid = AL.interpolate({ ...a, ts: T0 }, { ...b, ts: T0 + 15000 }, T0 + 7500);
  near(latlng(page, A), mid, 0.01, 'a metà fra A e B');
  near(latlng(page, A), east(a, dist(a, b) / 2), 0.05, 'cioè a metà distanza');
  assert.equal(page.get('anim.set.has(' + A + ')'), true, 'la nave è fra quelle animate');
  assert.equal(page.rafPending(), 1, 'un solo ciclo requestAnimationFrame');
  page.frame();
  assert.equal(page.rafPending(), 1, 'sempre uno solo');
});

test('pagina: senza fix nuovi per 5 minuti la stima si ferma 122 s oltre l\'ultimo fix (10 kn)', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000);
  await page.tick();
  page.setNow(T0 + 15000 + 5 * 60000 + 15000);   // riproduzione 5 min oltre B
  page.frame(); page.frame();
  const stop = east(b, 10 * AL.KN * 122);
  near(latlng(page, A), stop, 0.05, '122 s oltre B');
  page.advance(60000);
  page.frame(); page.frame(); page.frame();
  near(latlng(page, A), stop, 0.05, 'un minuto dopo è ancora lì');
});

test('pagina: un fix più vecchio dell\'ultimo non cambia la traccia né riporta indietro la nave', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000);
  await page.tick();
  page.setNow(T0 + 40000);
  page.frame(); page.frame();
  const track = page.get(`JSON.stringify(markers.get(${A}).track)`), here = latlng(page, A);
  state.features = [fix(A, a.lat - 0.01, a.lon, T0 + 10000)];   // posizione di prima, arrivata in ritardo da un'altra fonte
  await page.tick();
  assert.equal(page.get(`JSON.stringify(markers.get(${A}).track)`), track, 'traccia invariata');
  page.frame(); page.frame();
  near(latlng(page, A), here, 0.01, 'nessun ritorno');
});

test('pagina: un fix nuovo che mette la nave 100 m dietro la stima la tiene ferma (niente ritorno indietro)', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 60000);   // riproduzione a T0 + 45 s: stima 45 s oltre A
  page.frame(); page.frame();
  const shown = latlng(page, A);
  near(shown, east(a, 10 * AL.KN * 45), 0.05, 'stima di 45 s');
  // B arriva adesso (ts T0 + 60 s) più corto della stima: a T0 + 45 s l'interpolazione A→B è 100 m dietro
  const ahead = dist(a, shown), b = east(a, (ahead - 100) / 0.75);
  state.features = [fix(A, b.lat, b.lon, T0 + 60000)];
  await page.tick();
  near(latlng(page, A), shown, 1e-6, 'il giro non la sposta');
  for (let i = 0; i < 2; i++) {
    page.advance(16);
    page.frame();
    near(latlng(page, A), shown, 1e-6, `fotogramma ${i + 1}: ferma`);
  }
  page.advance(40000);   // l'interpolazione la supera: riparte in avanti
  page.frame(); page.frame();
  assert.ok(dist(a, latlng(page, A)) > ahead, 'poi riparte in avanti');
});

test('pagina: con prefers-reduced-motion niente animazione, il marker è esattamente all\'ultimo fix', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0 - 60000)] };
  const page = await ready(state, { media: { '(prefers-reduced-motion: reduce)': true } });
  assert.equal(page.get('anim.enabled'), false);
  assert.deepEqual(latlng(page, A), a, 'al fix, nessuna stima anche se vecchio di un minuto');
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000);
  await page.tick();
  assert.deepEqual(latlng(page, A), b, 'all\'ultimo fix');
  page.advance(5000);
  page.frame();
  assert.deepEqual(latlng(page, A), b);
  assert.equal(page.rafPending(), 0, 'nessun ciclo');
});

test('pagina: senza requestAnimationFrame (browser molto vecchi) l\'animazione resta spenta', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0 - 60000)] };
  const page = await ready(state, { raf: false });
  assert.equal(page.get('anim.enabled'), false);
  assert.deepEqual(latlng(page, A), a);
});

test('pagina: 600 navi in moto nella vista → al massimo 500 animate e 500 setLatLng per fotogramma, la selezionata sempre', async () => {
  const features = [];
  for (let i = 0; i < 600; i++) features.push(fix(247200000 + i, 43.1 + (i % 30) * 0.06, 10.1 + Math.floor(i / 30) * 0.09, T0));
  const far = 247299999;   // selezionata, fuori dalla vista
  features.push(fix(far, 30, -40, T0));
  const state = { features };
  const page = await ready(state);
  page.get(`select(${far})`);
  page.setNow(T0 + 20000);   // riproduzione 5 s oltre i fix: tutte stimate, 25 m più avanti (più di 0,5 px a zoom 14)
  const before = page.moves();
  page.frame();   // scelta: le non scelte ricalcolate insieme
  const pickMoves = page.moves() - before;
  assert.equal(page.get('anim.set.size'), 500, 'ANIM_MAX navi animate');
  assert.equal(page.get(`anim.set.has(${far})`), true, 'la selezionata anche fuori dalla vista');
  assert.ok(pickMoves <= 500, `fotogramma della scelta: ${pickMoves} setLatLng`);
  assert.equal(pickMoves, 101, 'le 101 navi in vista non scelte, ricalcolate tutte insieme');
  for (let i = 0; i < 3; i++) {   // 3 passi in meno di 3 s (PICK_MS): nessuna nuova scelta
    const n = page.moves();
    page.advance(900);
    page.frame();
    const step = page.moves() - n;
    assert.ok(step <= 500, `passo ${i + 1}: ${step} setLatLng`);
    assert.ok(step > 400, `passo ${i + 1}: le animate si muovono (${step})`);
  }
  const s = page.get('JSON.stringify(anim.stats)');
  assert.match(s, /"steps":[1-9]/, s);
});

test('pagina: piccoli spostamenti sotto 0,5 px non chiamano setLatLng', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state, { zoom: 3 });   // a zoom 3 un pixel è ~14 km: 10 kn per 20 s non si vedono
  page.setNow(T0 + 35000);
  page.frame();
  const n = page.moves();
  for (let i = 0; i < 5; i++) { page.advance(1000); page.frame(); }
  assert.equal(page.moves() - n, 0);
});

test('pagina: pausa durante lo spostamento della mappa e con la scheda nascosta; tornando visibile la nave salta alla sua posizione', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 20000);
  page.frame(); page.frame();
  page.map.fire('movestart');
  page.frame();
  assert.equal(page.rafPending(), 0, 'in pausa: il ciclo si ferma');
  page.map.fire('moveend');
  assert.equal(page.rafPending(), 1, 'riparte a fine spostamento');
  page.setHidden(true);
  page.frame();
  assert.equal(page.rafPending(), 0, 'scheda nascosta: il ciclo si ferma');
  page.setNow(T0 + 60000);
  page.setHidden(false);
  near(latlng(page, A), east(a, 10 * AL.KN * 45), 0.05, 'subito alla posizione di adesso (stima di 45 s), senza scivolare');
  assert.equal(page.rafPending(), 1, 'e il ciclo riparte');
});

test('pagina: il tempo di ridisegno del renderer (renderer._redraw avvolto) entra in anim.redrawMs', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  let page = null;
  const canvas = () => ({ _redraw() { page.advance(8); return 'ok'; } });
  page = await ready(state, { canvas });
  assert.equal(page.get('renderer._redraw()'), 'ok', 'il ridisegno vero viene chiamato');
  assert.equal(page.get('anim.redrawMs'), 8);
  assert.equal(page.get('anim.stats.redraws'), 1);
});
