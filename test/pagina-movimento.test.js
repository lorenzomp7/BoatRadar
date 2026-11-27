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
// state.skew: quanto l'orologio della pagina è avanti rispetto al server; state.statusDown: /api/status in errore (503)
function routesOf(state) {
  return (url, now) => {
    if (url.endsWith('/vessels')) return { body: [] };
    if (url.includes('digitraffic')) return { body: { type: 'FeatureCollection', features: [] } };
    if (url === '/api/status') return state.statusDown ? { status: 503 }
      : { body: () => ({ hasKey: true, connected: true, vessels: state.features.length, serverTime: now() - (state.skew || 0) }) };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: state.features.length, features: state.features }) };
  };
}
const latlng = (page, mmsi) => { const ll = page.markers().get(mmsi).marker.latlng; return { lat: ll[0], lon: ll[1] }; };
// distanza equirettangolare in metri, come approach (lon dal lato corto)
function dist(a, b) {
  const rad = Math.PI / 180, dLon = ((b.lon - a.lon + 540) % 360) - 180;
  const x = dLon * rad * Math.cos((a.lat + b.lat) / 2 * rad) * AL.R_EARTH;
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

// --- commit C: interruttore «Movimento fluido e posizione stimata» e riga «Posizione» della scheda ---
const KEY = 'boatradar:movimento';

test('pagina: interruttore in localStorage: acceso di default, spento con prefers-reduced-motion, la scelta salvata vince', async () => {
  const state = { features: [fix(A, 44, 11, T0 - 60000)] };
  let page = await ready(state);
  assert.equal(page.get('anim.enabled'), true, 'acceso di default');
  assert.equal(page.el('smooth').checked, true);
  page.stop();
  page = await ready(state, { local: { [KEY]: '0' } });
  assert.equal(page.get('anim.enabled'), false, 'spento se salvato spento');
  assert.equal(page.el('smooth').checked, false);
  assert.deepEqual(latlng(page, A), { lat: 44, lon: 11 }, 'all\'ultimo fix');
  page.stop();
  page = await ready(state, { media: { '(prefers-reduced-motion: reduce)': true } });
  assert.equal(page.el('smooth').checked, false, 'spento con prefers-reduced-motion');
  page.stop();
  page = await ready(state, { media: { '(prefers-reduced-motion: reduce)': true }, local: { [KEY]: '1' } });
  assert.equal(page.get('anim.enabled'), true, 'acceso se l\'utente l\'ha acceso');
  page.stop();
  page = await ready(state, { local: 'throw' });
  assert.equal(page.get('anim.enabled'), true, 'localStorage che lancia: default');
});

test('pagina: spegnendo l\'interruttore ogni nave torna all\'ultimo fix e il ciclo si ferma; riaccendendo riparte', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000);
  await page.tick();
  page.setNow(T0 + 40000);
  page.frame(); page.frame();
  assert.ok(dist(latlng(page, A), b) > 1, 'animata: non è sul fix');
  page.el('smooth').checked = false;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  assert.equal(page.local.get(KEY), '0');
  assert.deepEqual(latlng(page, A), b, 'esattamente all\'ultimo fix');
  page.frame();
  assert.equal(page.rafPending(), 0, 'ciclo fermo');
  page.advance(5000);
  page.frame();
  assert.deepEqual(latlng(page, A), b, 'resta lì');
  page.el('smooth').checked = true;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  assert.equal(page.local.get(KEY), '1');
  assert.equal(page.rafPending(), 1, 'ciclo ripartito');
  page.frame(); page.frame();
  assert.ok(dist(latlng(page, A), b) > 1, 'di nuovo stimata');
});

test('pagina: riga «Posizione» della scheda: ultimo segnale, fra due segnali, stimata da velocità e rotta', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15), S = 247100002;
  const state = { features: [fix(A, a.lat, a.lon, T0), fix(S, 44.5, 11.5, T0, { sog: 0, navStat: 5 })] };
  const page = await ready(state);
  const row = mmsi => /<td>Posizione<\/td><td[^>]*>([^<]*)<\/td>/.exec(page.get(`facts(${mmsi})`))?.[1];
  assert.equal(row(A), 'ultimo segnale', 'prima del fix (riproduzione 15 s indietro): l\'ultimo segnale');
  state.features = [fix(A, b.lat, b.lon, T0 + 15000), fix(S, 44.5, 11.5, T0 + 15000, { sog: 0, navStat: 5 })];
  page.setNow(T0 + 20000);
  await page.tick();
  assert.equal(row(A), 'fra due segnali (in differita di 15 s)');
  page.setNow(T0 + 15000 + 15000 + 3 * 60000);
  assert.equal(row(A), 'stimata da velocità e rotta (ultimo segnale 3 min fa)');
  page.setNow(T0 + 15000 + 15000 + 30000);
  assert.equal(row(A), 'stimata da velocità e rotta (ultimo segnale meno di 1 min fa)');
  assert.equal(row(S), 'ultimo segnale', 'nave ormeggiata: mai stimata');
  page.el('smooth').checked = false;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  assert.equal(row(A), 'ultimo segnale', 'animazione spenta');
  // velocità e rotta in scheda restano quelle del fix
  assert.match(page.get(`facts(${A})`), /10,0 kn \/ 90,0°/);
});

// --- Correzioni da revisione e QA ---------------------------------------------------------------------------------
const S = 247100009;
const row = (page, mmsi) => /<td>Posizione<\/td><td[^>]*>([^<]*)<\/td>/.exec(page.get(`facts(${mmsi})`))?.[1];

test('pagina: nave stimata che si ferma (fix ormeggiato dietro la stima) torna al fix senza salti, mai bloccata avanti', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 15000 + 60000);   // riproduzione 60 s oltre A: stima ~309 m
  page.frame(); page.frame();
  const shown0 = latlng(page, A);
  near(shown0, east(a, 10 * AL.KN * 60), 0.05, 'stima di 60 s');
  // arriva il fix fermo a 100 m da A (la nave ha rallentato e si è ormeggiata)
  const c = east(a, 100);
  state.features = [fix(A, c.lat, c.lon, T0 + 75000, { sog: 0, navStat: 5 })];
  await page.tick();
  let prev = latlng(page, A), maxBack = 0;
  for (let t = T0 + 75000; t <= T0 + 75000 + 25000; t += 100) {
    page.setNow(t); page.frame();
    const p = latlng(page, A), step = dist(prev, p);
    if (p.lon < prev.lon) maxBack = Math.max(maxBack, step);
    prev = p;
  }
  assert.ok(dist(prev, c) < 1, `finisce al fix fermo (a ${dist(prev, c).toFixed(1)} m)`);
  assert.ok(maxBack < 50, `salto indietro massimo in un fotogramma: ${maxBack.toFixed(1)} m (stima a ${dist(a, shown0).toFixed(0)} m)`);
});

test('pagina: nave che esce dalle animate (perde priorità) lontana dalla sua posizione scivola fin lì, senza saltare', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 60000);   // stima di 45 s
  page.frame(); page.frame();
  const shown = latlng(page, A);
  // B 100 m dietro la stima (tenuta ferma da approach, come sopra) e 500 cargo che le passano davanti per priorità
  const b = east(a, (dist(a, shown) - 100) / 0.75), cargo = [];
  for (let i = 0; i < 500; i++) cargo.push(fix(247300000 + i, 43.2 + (i % 25) * 0.07, 10.2 + Math.floor(i / 25) * 0.08, T0 + 60000, { shipType: 70 }));
  state.features = [fix(A, b.lat, b.lon, T0 + 60000), ...cargo];
  await page.tick();
  near(latlng(page, A), shown, 1e-6, 'il giro non la sposta (era animata)');
  page.advance(3000); page.frame();   // scelta (3 s dopo): A fuori dalle 500
  assert.equal(page.get(`anim.set.has(${A})`), false, 'A non più animata');
  assert.equal(page.get(`anim.settle.has(${A})`), true, 'A scivola alla sua posizione');
  let prev = latlng(page, A), maxStep = 0;
  for (let i = 0; i < 40; i++) {
    page.advance(50); page.frame();
    const p = latlng(page, A);
    maxStep = Math.max(maxStep, dist(prev, p)); prev = p;
  }
  const target = AL.positionAt([{ ...a, sog: 10, cog: 90, navStat: 0, ts: T0 }, { ...b, sog: 10, cog: 90, navStat: 0, ts: T0 + 60000 }], page.get('anim.T'));
  assert.ok(dist(prev, target) < 10, `arrivata alla sua posizione (a ${dist(prev, target).toFixed(1)} m)`);
  assert.ok(maxStep < 30, `passo massimo ${maxStep.toFixed(1)} m (100 m in ${1500} ms)`);
  assert.equal(page.get(`anim.settle.has(${A})`), false, 'finito');
});

test('pagina: nave in moto a lat −90 esatta: nessuna coordinata non finita a setLatLng, il ciclo e i giri continuano', async () => {
  const state = { features: [fix(A, -90, 10, T0, { cog: 180 }), fix(S, -89.5, 12, T0)] };
  const page = await ready(state, { bounds: { w: 0, s: -90, e: 20, n: -80 } });
  page.setNow(T0 + 60000);
  page.frame(); page.frame();
  const p = latlng(page, A);
  assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon), `posizione mostrata ${JSON.stringify(p)}`);
  // un calcolo rotto (NaN) non arriva mai al marker
  assert.equal(page.get(`draw(markers.get(${S}), { lat: NaN, lon: 1 }, 14, true)`), false);
  assert.ok(Number.isFinite(latlng(page, S).lon));
  state.features = [fix(A, -90, 10, T0 + 15000, { cog: 180 }), fix(S, -89.5, 12.1, T0 + 15000)];
  await page.tick();
  assert.equal(page.get(`markers.get(${S}).track.length`), 2, 'il giro dopo aggiorna ancora i marker');
  assert.equal(page.rafPending(), 1, 'ciclo vivo');
});

test('pagina: COG 511 / SOG 102,3: la nave resta al fix, nessun NaN, nessuna stima', async () => {
  const state = { features: [fix(A, 44, 11, T0, { cog: 511 }), fix(S, 44.1, 11.1, T0, { sog: 102.3 })] };
  const page = await ready(state);
  page.setNow(T0 + 90000);
  page.frame(); page.frame(); page.frame();
  assert.deepEqual(latlng(page, A), { lat: 44, lon: 11 });
  assert.deepEqual(latlng(page, S), { lat: 44.1, lon: 11.1 });
  assert.equal(row(page, A), 'ultimo segnale');
});

test('pagina: antimeridiano: nave che passa 180 con la vista 170..190 è animata dal lato corto', async () => {
  const a = { lat: 0, lon: 179.9995 }, b = { lat: 0, lon: -179.9995 };
  const state = { features: [fix(A, a.lat, a.lon, T0, { sog: 14.4 })] };
  const page = await ready(state, { bounds: { w: 170, s: -10, e: 190, n: 10 } });
  state.features = [fix(A, b.lat, b.lon, T0 + 15000, { sog: 14.4 })];
  page.setNow(T0 + 16000);
  await page.tick();
  for (let t = T0 + 17000; t <= T0 + 30000; t += 500) {
    page.setNow(t); page.frame();
    const p = latlng(page, A);
    assert.ok(Math.abs(p.lon) > 179.99, `t+${t - T0}: lon ${p.lon} (mai verso 0)`);
  }
  assert.equal(page.get(`anim.set.has(${A})`), true, 'animata nella vista che attraversa 180');
  page.setNow(T0 + 15000 + 15000 + 60000); page.frame(); page.frame();
  const p = latlng(page, A);
  assert.ok(p.lon < 0 && p.lon >= -180 && Math.abs(p.lon) > 179.99, `stima oltre l'antimeridiano: ${p.lon}`);
});

test('pagina: fix con la stessa ora e coordinate diverse (due fonti): scheda e mappa coerenti, nessun salto', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000); await page.tick();
  page.setNow(T0 + 26000); page.frame(); page.frame();
  const here = latlng(page, A), b2 = { lat: b.lat + 0.001, lon: b.lon };   // stessa ora, 111 m a nord
  state.features = [fix(A, b2.lat, b2.lon, T0 + 15000)];
  await page.tick();
  page.advance(16); page.frame();
  assert.ok(dist(here, latlng(page, A)) < 10, `nessun salto: spostata di ${dist(here, latlng(page, A)).toFixed(1)} m`);
  const track = JSON.parse(page.get(`JSON.stringify(markers.get(${A}).track)`));
  assert.equal(track.length, 2);
  assert.deepEqual([track[1].lat, track[1].lon], [b2.lat, b2.lon], 'l\'ultimo fix è quello della scheda (m.props)');
  assert.deepEqual(page.get(`markers.get(${A}).props.timestampExternal`), T0 + 15000);
  page.setNow(T0 + 30000); page.frame(); page.frame();
  page.advance(3000); page.frame(); page.frame();
  const target = AL.positionAt(track, page.get('anim.T'));
  near(latlng(page, A), target, 1, 'segue la traccia con il fix sostituito');
  assert.ok(dist(target, b2) < dist(target, b), 'oltre il fix nuovo, non quello vecchio');
});

test('pagina: riga «Posizione» prima del primo fix della traccia: «segnale precedente», non «ultimo segnale»', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15);
  const state = { features: [fix(A, a.lat, a.lon, T0 + 5000)] };   // fix più recente della riproduzione (T0 − 14 s)
  const page = await ready(state);
  assert.equal(row(page, A), 'ultimo segnale', 'un solo fix: è quello');
  state.features = [fix(A, b.lat, b.lon, T0 + 20000)];
  await page.tick();
  assert.equal(page.get(`markers.get(${A}).track.length`), 2);
  assert.equal(row(page, A), 'segnale precedente (in differita di 15 s)');
});

test('pagina: orologio avanti di 5 min e primo /api/status in errore, poi corretto: l\'ora di riproduzione riparte da quella vera', async () => {
  const SKEW = 5 * 60000;
  const state = { features: [fix(A, 44, 11, T0)], skew: SKEW, statusDown: true };
  const page = await ready(state, { manualTime: T0 + SKEW + 1000 });
  const b = AL.rhumbDestination(44, 11, 90, 10 * AL.KN * 15);
  state.statusDown = false;
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + SKEW + 16000);
  await page.tick();
  const clockNow = page.get('clock.now()');
  assert.ok(Math.abs(clockNow - (T0 + 16000)) < 50, 'orologio corretto: ' + (clockNow - T0));
  page.frame(); page.frame();
  const T = page.get('anim.T'), expectedT = clockNow - AL.ANIM_DELAY_MS;
  assert.ok(T - expectedT < 2000, `anim.T avanti di ${(T - expectedT) / 1000} s rispetto all'ora corretta − 15 s`);
  assert.equal(row(page, A), 'fra due segnali (in differita di 15 s)', 'riproduzione 1 s dopo il primo fix (prima: 285 s avanti, stimata)');
});

test('pagina: orologio di sistema che salta avanti di 10 min e torna: dopo la correzione l\'interpolazione torna', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15), J = 600000;
  const state = { skew: 0, features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  for (let i = 1; i <= 4; i++) { page.setNow(T0 + 1000 + i * 2000); await page.tick(); }   // 5 campioni dell'orologio
  state.skew = J;   // l'orologio della pagina va avanti di 10 min, il server no
  page.setNow(T0 + 10000 + J); page.frame(); page.frame();
  let srv = T0 + 10000;   // giri successivi: la mediana dei campioni si sposta e clock.now() torna all'ora del server
  for (let i = 0; i < 5; i++) { srv += 3000; page.setNow(srv + J); await page.tick(); }
  assert.ok(Math.abs(page.get('clock.now()') - srv) < 50, 'orologio corretto');
  state.features = [fix(A, b.lat, b.lon, srv)];
  srv += 1000; page.setNow(srv + J); await page.tick();
  page.setNow(srv + 7500 + J); page.frame(); page.frame();
  assert.equal(row(page, A), 'fra due segnali (in differita di 15 s)', `anim.T − ora server = ${((page.get('anim.T') - (srv + 7500)) / 1000).toFixed(0)} s`);
});

test('pagina: orologio della pagina 10 min avanti già all\'avvio: con serverTime l\'interpolazione è giusta', async () => {
  const a = { lat: 44, lon: 11 }, b = east(a, 10 * AL.KN * 15), SK = 600000;
  const state = { skew: SK, features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state, { manualTime: T0 + 1000 + SK });
  state.features = [fix(A, b.lat, b.lon, T0 + 15000)];
  page.setNow(T0 + 16000 + SK); await page.tick();
  page.setNow(T0 + 22500 + SK); page.frame(); page.frame();
  near(latlng(page, A), AL.interpolate({ ...a, ts: T0 }, { ...b, ts: T0 + 15000 }, T0 + 7500), 0.05, 'a metà');
  assert.equal(row(page, A), 'fra due segnali (in differita di 15 s)');
});

test('pagina: senza niente da muovere (solo una nave ormeggiata) nessun fotogramma: un risveglio alla scelta ogni 3 s', async () => {
  const state = { features: [fix(S, 44, 11, T0, { sog: 0, navStat: 5 })] };
  const page = await ready(state);
  let n = 0;
  for (let i = 0; i < 600; i++) { page.advance(16); n += page.frame(); }   // 10 s a 60 Hz
  assert.ok(n <= 5, `${n} fotogrammi in 10 s senza nulla da muovere`);
  assert.equal(page.get('anim.set.size'), 0);
  assert.ok(page.get('anim.stats.picks') >= 3, 'le scelte continuano (ogni 3 s)');
  assert.equal(page.rafOnly(), 0, 'nessun requestAnimationFrame in coda');
  assert.deepEqual(page.animTimers().length, 1, 'un solo risveglio in coda');
  // arriva una nave in moto: a fine giro scelta subito, e il ciclo riparte
  state.features.push(fix(A, 44.1, 11.1, T0 + 9000));
  await page.tick();
  assert.equal(page.rafOnly(), 1, 'fotogramma subito');
  page.frame();
  assert.equal(page.get(`anim.set.has(${A})`), true);
});

test('pagina: nave lenta (passo ogni 667 ms): fra un passo e l\'altro un setTimeout e poi un solo requestAnimationFrame', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 20000);
  page.frame(); page.frame();   // scelta, passo
  const interval = page.get('anim.interval');
  assert.ok(interval > 600 && interval < 700, `intervallo ${interval}`);
  assert.equal(page.rafOnly(), 0, 'nessun fotogramma in coda fino al prossimo passo');
  assert.equal(page.rafPending(), 1, 'un solo risveglio');
  let n = 0;
  for (let i = 0; i < 40; i++) { page.advance(16); n += page.frame(); }   // 640 ms
  assert.ok(n <= 1, `${n} fotogrammi prima del passo`);
  const steps = page.get('anim.stats.steps');
  for (let i = 0; i < 10; i++) { page.advance(16); page.frame(); }
  assert.equal(page.get('anim.stats.steps'), steps + 1, 'il passo arriva con il risveglio');
});

test('pagina: con più di 500 navi in moto decidono tipo e lunghezza (meta): cargo e navi lunghe animate per prime', async () => {
  const features = [];
  for (let i = 0; i < 520; i++) features.push(fix(247200000 + i, 43.1 + (i % 26) * 0.07, 10.1 + Math.floor(i / 26) * 0.09, T0));
  const cargo = [], long = [];
  for (let i = 0; i < 10; i++) {   // MMSI più alti: a parità di punteggio sarebbero le ultime
    cargo.push(247299900 + i); features.push(fix(247299900 + i, 44.5, 10.2 + i * 0.1, T0, { shipType: 70 }));
    long.push(247299950 + i); features.push(fix(247299950 + i, 44.6, 10.2 + i * 0.1, T0));
  }
  const page = await ready({ features });
  for (const mmsi of long) page.get(`meta.set(${mmsi}, { ...meta.get(${mmsi}), length: 250 })`);   // da /api/vessel
  page.setNow(T0 + 20000);
  page.frame();
  assert.equal(page.get('anim.set.size'), 500);
  for (const mmsi of [...cargo, ...long]) assert.equal(page.get(`anim.set.has(${mmsi})`), true, `${mmsi} animata`);
  assert.equal(page.get('anim.set.has(247200519)'), false, 'fra le altre escono quelle con MMSI più alto');
});

test('pagina: prefers-reduced-motion cambiato con la pagina aperta vale senza una scelta salvata; la casella segue lo stato', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  let page = await ready(state);
  assert.equal(page.el('smooth').checked, true);
  page.setMedia('(prefers-reduced-motion: reduce)', true);
  assert.equal(page.get('anim.enabled'), false, 'spenta');
  assert.equal(page.el('smooth').checked, false, 'casella spenta');
  assert.equal(page.local.get(KEY), undefined, 'niente salvato: non è una scelta dell\'utente');
  assert.equal(page.rafPending(), 0);
  page.setMedia('(prefers-reduced-motion: reduce)', false);
  assert.equal(page.get('anim.enabled'), true, 'riaccesa');
  assert.equal(page.el('smooth').checked, true);
  // l'utente sceglie: da lì in poi l'impostazione del sistema non conta
  page.el('smooth').checked = false;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  page.setMedia('(prefers-reduced-motion: reduce)', false);
  assert.equal(page.get('anim.enabled'), false, 'la scelta salvata vince');
  page.stop();
  // localStorage che lancia: la scelta vale in memoria
  page = await ready(state, { local: 'throw', media: { '(prefers-reduced-motion: reduce)': true } });
  page.el('smooth').checked = true;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  assert.equal(page.get('anim.enabled'), true);
  page.setMedia('(prefers-reduced-motion: reduce)', false);
  page.setMedia('(prefers-reduced-motion: reduce)', true);
  assert.equal(page.get('anim.enabled'), true, 'la scelta in memoria vince');
  page.stop();
  page = await ready(state, { raf: false });
  assert.equal(page.el('smooth').checked, false, 'senza requestAnimationFrame la casella è spenta');
  assert.equal(page.el('smooth').disabled, true, 'e disattivata');
});

test('pagina: clic sul punto mostrato (stimato) apre quella nave, non quella che sta sul vecchio fix', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0), fix(S, a.lat, a.lon, T0 - 1000, { sog: 0, navStat: 5 })] };
  const page = await ready(state);
  page.setNow(T0 + 15000 + 45000); page.frame(); page.frame();   // A stimata 231 m a est
  const shown = latlng(page, A);
  assert.ok(dist(shown, a) > 200);
  page.map.fire('click', { containerPoint: page.map.latLngToContainerPoint({ lat: shown.lat, lng: shown.lon }) });
  assert.equal(page.get('selected'), A, 'clic sulla posizione mostrata → A');
  page.get('selected = null');
  page.map.fire('click', { containerPoint: page.map.latLngToContainerPoint({ lat: a.lat, lng: a.lon }) });
  assert.equal(page.get('selected'), S, 'clic sul vecchio fix di A → la nave ormeggiata che è lì');
});

test('pagina: filtro che esclude una nave animata: marker tolto, fotogrammi senza errori, torna al posto giusto', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0), fix(S, 44.01, 11.01, T0, { sog: 20 })] };
  const page = await ready(state);
  page.setNow(T0 + 30000); page.frame(); page.frame();
  assert.equal(page.get(`anim.set.has(${A})`), true);
  page.get('setFilter(parseFilter({ minSog: "15" }))');
  assert.equal(page.markers().has(A), false, 'A tolta dal filtro');
  for (let i = 0; i < 5; i++) { page.advance(500); page.frame(); }
  assert.equal(page.rafPending(), 1, 'ciclo vivo');
  page.get('setFilter(null)');
  page.setNow(T0 + 45000); await page.tick();
  assert.equal(page.markers().has(A), true, 'A di nuovo in mappa');
  page.frame(); page.frame();
  const exp = AL.project({ ...a, sog: 10, cog: 90, navStat: 0, ts: T0 }, T0 + 30000);
  near(latlng(page, A), exp, 0.5, 'alla stima di adesso');
});

test('pagina: interruttore spento durante lo spostamento della mappa e riacceso a scheda nascosta: nessun ciclo fuori tempo', async () => {
  const state = { features: [fix(A, 44, 11, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 30000); page.frame();
  page.map.fire('movestart');
  page.el('smooth').checked = false;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  page.map.fire('moveend');
  assert.equal(page.rafPending(), 0);
  assert.deepEqual(latlng(page, A), { lat: 44, lon: 11 });
  page.setHidden(true);
  page.el('smooth').checked = true;
  page.fireEl('smooth', 'change', { target: page.el('smooth') });
  assert.equal(page.rafPending(), 0, 'nascosta: nessun fotogramma');
  page.setHidden(false);
  assert.equal(page.rafPending(), 1, 'visibile: un solo ciclo');
});

test('pagina: giro arrivato a scheda nascosta e poi visibile: un solo ciclo, nessun ritorno', async () => {
  const a = { lat: 44, lon: 11 };
  const state = { features: [fix(A, a.lat, a.lon, T0)] };
  const page = await ready(state);
  page.setNow(T0 + 25000); page.frame(); page.frame();
  const before = latlng(page, A), T1 = page.get('anim.T');
  page.setHidden(true);   // il browser non esegue i fotogrammi a scheda nascosta
  const b = east(a, 10 * AL.KN * 30);
  state.features = [fix(A, b.lat, b.lon, T0 + 30000)];
  page.setNow(T0 + 32000); await page.tick();
  page.setNow(T0 + 50000);
  page.setHidden(false);
  assert.equal(page.rafPending(), 1, 'un solo ciclo in coda');
  const after = latlng(page, A);
  assert.ok(after.lon >= before.lon, 'nessun ritorno');
  assert.ok(page.get('anim.T') >= T1);
  page.frame(); page.frame();
  assert.ok(latlng(page, A).lon >= after.lon - 1e-9, 'il fotogramma dopo non torna indietro');
});

test('pagina: passaggio al server di riserva durante l\'animazione: il ciclo continua senza salti', async () => {
  const VM = { url: 'https://vm.example/api', name: 'VM Oracle', sleeps: false };
  const RENDER = { url: 'https://render.example/api', name: 'Render', sleeps: true };
  const a = { lat: 44, lon: 11 }, st = { vmDown: false };
  const srv = (path, now) => {
    if (path === '/status') return { body: () => ({ hasKey: true, connected: true, vessels: 1, serverTime: now() }) };
    if (path.startsWith('/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 1, features: [fix(A, a.lat, a.lon, T0)] }) };
    if (path.startsWith('/vessel')) return { body: null };
  };
  const routes = (url, now) => {
    if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
    if (url.startsWith(VM.url)) return st.vmDown ? { fail: true } : srv(url.slice(VM.url.length), now);
    if (url.startsWith(RENDER.url)) return srv(url.slice(RENDER.url.length), now);
  };
  const page = startPage({ routes, config: { BOATRADAR_APIS: [VM, RENDER], BOATRADAR_API: VM.url }, manualTime: T0 + 1000, zoom: 14 });
  await until(() => page.markers().has(A), 'nave in mappa');
  page.setNow(T0 + 40000); page.frame(); page.frame();
  const p0 = latlng(page, A);
  st.vmDown = true;
  await page.tick();
  // durante i 3 s di conferma la vista è vuota e le navi spariscono (punto 86, già prima dell'animazione)
  await until(() => { page.advance(200); return / · server di riserva \(Render\)$/.test(page.status()); }, 'Render', 8000);
  const p1 = latlng(page, A), exp = AL.project({ ...a, sog: 10, cog: 90, navStat: 0, ts: T0 }, AL.playbackTime(page.get('clock.now()')));
  assert.ok(Number.isFinite(p1.lat) && Number.isFinite(p1.lon));
  assert.ok(p1.lon >= p0.lon - 1e-9, `nessun ritorno al cambio di server (${p0.lon} → ${p1.lon})`);
  assert.ok(dist(p1, exp) < 30, `alla posizione stimata di adesso (a ${dist(p1, exp).toFixed(1)} m)`);
  page.advance(1000); page.frame(); page.frame();
  assert.equal(page.rafPending(), 1, 'ciclo vivo');
  assert.ok(latlng(page, A).lon >= p1.lon - 1e-9);
});

test('pagina: loadLocations con 6000 navi: una sola lettura dell\'orologio per giro e costo per marker con l\'animazione accesa', async () => {
  const mk = ts => Array.from({ length: 6000 }, (_, i) => fix(246000000 + i, 30 + (i % 100) * 0.3, -20 + Math.floor(i / 100) * 0.6, ts));
  const cost = {};
  for (const on of [false, true]) {
    const state = { features: mk(T0) };
    const page = await ready(state, { local: { [KEY]: on ? '1' : '0' }, zoom: 3, bounds: { w: -30, s: 25, e: 25, n: 65 } });
    assert.equal(page.get('anim.enabled'), on);
    page.get('window.__reads = 0; { const n = clock.now; clock.now = () => (window.__reads++, n()); }');
    // tempo vero per anim.stats.loadMs (l'ora della pagina è manuale): nessun fotogramma in questa prova
    page.ctx.performance.now = () => Number(process.hrtime.bigint()) / 1e6;
    const ms = [];
    for (let r = 1; r <= 5; r++) {
      state.features = mk(T0 + r * 15000);
      page.setNow(T0 + 1000 + r * 15000);
      page.get('window.__reads = 0');
      await page.tick();
      ms.push(page.get('anim.stats.loadMs'));
      assert.ok(page.get('window.__reads') < 40, `animazione ${on ? 'accesa' : 'spenta'}: ${page.get('window.__reads')} letture di clock.now() in un giro`);
    }
    ms.sort((x, y) => x - y);
    cost[on] = ms[2];
    assert.equal(page.markers().size, 6000);
    page.stop();
  }
  const per = x => (x / 6000 * 1000).toFixed(2);
  console.log(`# loadLocations 6000 marker (vm, mediana di 5): spenta ${cost[false].toFixed(1)} ms (${per(cost[false])} µs/marker), ` +
    `accesa ${cost[true].toFixed(1)} ms (${per(cost[true])} µs/marker)`);
  // soglia larga (macchine di CI lente): l'animazione accesa costa al massimo il doppio più 30 ms
  assert.ok(cost[true] <= cost[false] * 2 + 30, `accesa ${cost[true]} ms contro spenta ${cost[false]} ms`);
});
