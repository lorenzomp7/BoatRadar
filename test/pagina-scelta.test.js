// Punto 10: area toccabile più ampia e scelta tra navi sovrapposte nella pagina (boatradar.html), senza browser
// (test/pagina-helpers.js). Un clic sulla mappa raccoglie le navi entro pickRadius (8 px, 20 px su schermo touch):
// nessuna → niente, una → scheda, più di una → popup «N navi qui» con una riga per nave. La verifica nel browser vero è
// lo scenario «navi sovrapposte» di tools/smoke-browser.sh (le due GEMELLA della fixture di esempio, a Genova).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

// Proiezione della mappa finta: 1 px ogni 0,00001° attorno a Genova (44,42 N, 8,9 E → punto 500, 400)
const project = ll => ({ x: 500 + (ll.lng - 8.9) * 1e5, y: 400 - (ll.lat - 44.42) * 1e5 });
const ship = (mmsi, lat, lon, props) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, ...props } });
// GEMELLA 1 in 500,400; GEMELLA 2 9 px sopra (10 m); A<B 12 px a destra, senza tipo né velocità; LAGUNA lontana
const features = now => [
  ship(247555001, 44.42, 8.9, { name: 'GEMELLA', shipType: 70, sog: 0, navStat: 5, timestampExternal: now() - 1000 }),
  ship(247555002, 44.42009, 8.9, { name: 'GEMELLA', shipType: 70, sog: 0, navStat: 5, timestampExternal: now() - 1000 }),
  ship(247555003, 44.42, 8.90012, { name: 'A<B', timestampExternal: now() - 1000 }),
  ship(247123450, 45.4312, 12.3355, { name: 'LAGUNA PRIMA', shipType: 70, sog: 12.34, cog: 87, timestampExternal: now() - 1000 }),
];
const routes = (url, now) => {
  if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 4, serverTime: now() }) };
  if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 4, features: features(now) }) };
};

async function ready(opts = {}) {
  const page = startPage({ routes, project, ...opts });
  await until(() => page.markers().size === 4, 'quattro navi in mappa');
  return page;
}
// clic (o tocco) vero sulla mappa nel punto x, y del contenitore: come Leaflet, l'evento porta il mouse in originalEvent
// e, se è sopra un marker, containerPoint è il centro del marker (qui volutamente diverso, per vedere quale si usa)
const click = (page, x, y) => page.map.fire('click', { originalEvent: { clientX: x, clientY: y }, containerPoint: { x: -999, y: -999 } });
const popup = page => page.map._popup;
const panelOpen = page => page.el('panel').style.display === 'block';

test('pagina: renderer canvas con tolleranza 4 px, 12 px su schermo touch', async () => {
  const desk = await ready();
  assert.equal(JSON.stringify(desk.canvasOptions), JSON.stringify([{ padding: 0.5, tolerance: 4 }]));
  const touch = await ready({ media: { '(pointer: coarse)': true } });
  assert.equal(JSON.stringify(touch.canvasOptions), JSON.stringify([{ padding: 0.5, tolerance: 12 }]));
});

test('pagina (desktop, 8 px): una sola nave vicina → scheda subito, senza popup; nessuna → niente', async () => {
  const page = await ready();
  click(page, 100, 100);   // mare vuoto
  assert.equal(popup(page), null);
  assert.equal(page.get('selected'), null);
  assert.equal(panelOpen(page), false);
  click(page, 500, 400);   // su GEMELLA 1; GEMELLA 2 è a 9 px, oltre gli 8 del mouse
  assert.equal(popup(page), null, 'nessun popup per una nave sola');
  assert.equal(page.get('selected'), 247555001);
  assert.ok(panelOpen(page), 'scheda aperta');
  assert.equal(page.markers().get(247555001).marker.options.color, '#ffc83d', 'bordo giallo della nave selezionata');
});

test('pagina (desktop): due navi entro 8 px → popup «2 navi qui», dalla più vicina', async () => {
  const page = await ready();
  click(page, 501, 396);   // 4,1 px da GEMELLA 1, 5,1 da GEMELLA 2, 11,7 da A<B
  const p = popup(page);
  assert.ok(p, 'popup aperto');
  assert.equal(p.options.className, 'pick');
  assert.deepEqual(p.rows(), ['247555001', '247555002']);
  assert.match(p.content, /2 navi qui/);
  assert.equal(page.get('selected'), null, 'nessuna nave scelta finché non si tocca una riga');
});

test('pagina (touch, 20 px): tre navi → popup con nome, tipo, velocità e MMSI; n.d. per i dati mancanti', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.document.activeElement = page.el('map');   // il tocco sulla mappa le dà il focus (tastiera di Leaflet)
  click(page, 500, 400);
  const p = popup(page);
  assert.ok(p, 'popup aperto');
  assert.deepEqual(p.rows(), ['247555001', '247555002', '247555003'], 'dalla più vicina: 0, 9 e 12 px');
  assert.match(p.content, /3 navi qui/);
  const rows = p.content.split('class="pickrow"').slice(1);
  assert.match(rows[0], /GEMELLA/);
  assert.match(rows[0], /Nave cargo · 0,0 kn · MMSI 247555001/);
  assert.match(rows[1], /MMSI 247555002/);
  assert.match(rows[2], /A&lt;B/, 'nome con caratteri HTML protetto');
  assert.doesNotMatch(p.content, /A<B/);
  assert.match(rows[2], /tipo n\.d\. · velocità n\.d\. · MMSI 247555003/);
  assert.match(p.content, /<button type="button" class="pickrow" data-pick="247555001"/, 'righe = pulsanti veri');
  assert.equal(page.document.activeElement?.dataset?.pick, '247555001', 'focus sulla prima riga');
});

test('pagina (touch): clic sulla seconda riga → popup chiuso, scheda della seconda nave, focus restituito alla mappa', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  popup(page).clickRow(247555002);
  assert.equal(popup(page), null, 'popup chiuso');
  assert.equal(page.get('selected'), 247555002);
  assert.ok(panelOpen(page));
  assert.equal(String(page.el('content').dataset.mmsi), '247555002', 'scheda della seconda nave');
  // il focus era sulla riga (sparita): torna dove era prima del popup, e la × della scheda lo riporta lì
  assert.equal(page.document.activeElement, page.el('map'));
  page.get('closePanel()');
  assert.equal(page.document.activeElement, page.el('map'));
});

test('pagina: Esc chiude prima il popup (la scheda resta aperta), poi la scheda', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  popup(page).clickRow(247555001);        // scheda aperta sulla prima
  click(page, 500, 400);                   // di nuovo il popup, con la scheda aperta
  assert.ok(popup(page) && panelOpen(page));
  const first = page.keydown('Escape');
  assert.equal(popup(page), null, 'Esc chiude il popup');
  assert.ok(panelOpen(page), 'la scheda resta aperta');
  assert.equal(first.defaultPrevented, true, 'gli altri gestori di Esc lo ignorano');
  assert.equal(page.get('selected'), 247555001, 'la nave aperta resta selezionata');
  assert.equal(page.document.activeElement, page.el('map'), 'focus restituito');
  page.keydown('Escape');
  assert.equal(panelOpen(page), false, 'il secondo Esc chiude la scheda');
  // senza popup né scheda Esc non fa niente (e non lancia)
  assert.equal(page.keydown('Escape').defaultPrevented, false);
});

test('pagina: il popup non finisce sotto la scheda aperta (autoPan con il pannello) né sotto l\'header', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.el('map').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
  page.el('header').getBoundingClientRect = () => ({ left: 56, top: 12, right: 600, bottom: 60, width: 544, height: 48 });
  click(page, 500, 400);
  assert.equal(JSON.stringify(popup(page).options.autoPanPaddingTopLeft), JSON.stringify([10, 70]), 'sotto l\'header');
  assert.equal(JSON.stringify(popup(page).options.autoPanPaddingBottomRight), JSON.stringify([10, 10]), 'scheda chiusa');
  page.map.closePopup();
  // desktop: scheda a destra (da x 648)
  page.el('panel').style.display = 'block';
  page.el('panel').getBoundingClientRect = () => ({ left: 648, top: 12, right: 988, bottom: 788, width: 340, height: 776 });
  click(page, 500, 400);
  assert.equal(JSON.stringify(popup(page).options.autoPanPaddingBottomRight), JSON.stringify([362, 10]), 'a sinistra della scheda');
  page.map.closePopup();
  // telefono: scheda in basso (da y 500)
  const phone = await ready({ media: { '(pointer: coarse)': true, '(max-width: 640px)': true } });
  phone.el('map').getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 });
  phone.el('panel').style.display = 'block';
  phone.el('panel').getBoundingClientRect = () => ({ left: 8, top: 500, right: 382, bottom: 836, width: 374, height: 336 });
  click(phone, 500, 400);
  assert.equal(JSON.stringify(popup(phone).options.autoPanPaddingBottomRight), JSON.stringify([10, 354]), 'sopra la scheda');
});

// --- correzioni da revisione ---------------------------------------------------------------------------------------

test('pagina: altezza del popup sullo spazio libero vero (header, scheda aperta, fondo della mappa), almeno ~3 righe', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.el('map').getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 });
  page.el('header').getBoundingClientRect = () => ({ left: 56, top: 12, right: 600, bottom: 60, width: 544, height: 48 });
  click(page, 500, 400);
  assert.equal(popup(page).options.maxHeight, 800 - 60 - 20 - 40 - 20, 'scheda chiusa: fino al fondo della mappa');
  page.map.closePopup();
  // desktop: scheda a destra, il popup ha tutta l'altezza della mappa
  page.el('panel').style.display = 'block';
  page.el('panel').getBoundingClientRect = () => ({ left: 648, top: 12, right: 988, bottom: 788, width: 340, height: 776 });
  click(page, 500, 400);
  assert.equal(popup(page).options.maxHeight, 660);
  // telefono: fino alla cima della scheda (y 500)
  const phone = await ready({ media: { '(pointer: coarse)': true, '(max-width: 640px)': true } });
  phone.el('map').getBoundingClientRect = () => ({ left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 });
  phone.el('header').getBoundingClientRect = () => ({ left: 56, top: 8, right: 382, bottom: 90, width: 326, height: 82 });
  phone.el('panel').style.display = 'block';
  phone.el('panel').getBoundingClientRect = () => ({ left: 8, top: 500, right: 382, bottom: 836, width: 374, height: 336 });
  click(phone, 500, 400);
  assert.equal(popup(phone).options.maxHeight, 500 - 90 - 20 - 40 - 20);
  phone.map.closePopup();
  // scheda alta (poco spazio sopra): il minimo, e l'elenco scorre
  phone.el('panel').getBoundingClientRect = () => ({ left: 8, top: 200, right: 382, bottom: 836, width: 374, height: 636 });
  click(phone, 500, 400);
  assert.equal(popup(phone).options.maxHeight, 168);
});

// 30 navi su una griglia di 2 px attorno a 500,400 (tutte entro i 20 px del dito); MMSI 247600000 + i
const crowd = now => Array.from({ length: 30 }, (_, i) => ship(247600000 + i, 44.42 - Math.floor(i / 6) * 2e-5,
  8.9 + (i % 6) * 2e-5, { name: `NAVE ${i}`, shipType: 70, sog: 1, timestampExternal: now() - 1000 }));
const crowdRoutes = (url, now) => {
  if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 30, features: crowd(now) }) };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 30, serverTime: now() }) };
  return routes(url, now);
};

test('pagina: con 30 navi al massimo 15 righe, le più vicine, e «e altre 15: avvicina la mappa» che ingrandisce di 2', async () => {
  const page = startPage({ routes: crowdRoutes, project, media: { '(pointer: coarse)': true } });
  await until(() => page.markers().size === 30, 'trenta navi in mappa');
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  const p = popup(page);
  assert.match(p.content, /30 navi qui/, 'il titolo conta tutte le navi');
  // le 15 più vicine al punto, dalla più vicina (a parità di distanza per MMSI)
  // (distanze con la stessa proiezione della mappa finta, arrotondamenti compresi)
  const d = f => { const q = project({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }); return Math.hypot(q.x - 500, q.y - 400); };
  const expected = crowd(Date.now).sort((a, b) => d(a) - d(b) || a.mmsi - b.mmsi).slice(0, 15).map(f => String(f.mmsi));
  assert.equal(expected[0], '247600000');
  assert.deepEqual(p.rows(), expected);
  assert.match(p.content, /<button type="button" class="pickrow pickmore" data-more="15">e altre 15: avvicina la mappa<\/button>/);
  assert.ok(p.content.indexOf('data-more') > p.content.lastIndexOf('data-pick'), 'riga finale');
  const before = page.map.views.length;
  p.clickMore();
  assert.equal(popup(page), null, 'popup chiuso');
  assert.equal(page.get('selected'), null, 'nessuna nave scelta');
  assert.equal(page.map.views.length, before + 1, 'un setView');
  const [center, zoom] = page.map.views.at(-1);
  assert.deepEqual(center.point, { x: 500, y: 400 }, 'sul punto toccato');
  assert.equal(zoom, 6 + 2);
  assert.equal(page.document.activeElement, page.el('map'), 'focus restituito alla mappa');
});

test('pagina: 15 navi esatte → 15 righe senza «e altre»', async () => {
  const fifteen = (url, now) => (url.startsWith('/api/locations?')
    ? { body: () => ({ type: 'FeatureCollection', total: 15, features: crowd(now).slice(0, 15) }) } : crowdRoutes(url, now));
  const page = startPage({ routes: fifteen, project, media: { '(pointer: coarse)': true } });
  await until(() => page.markers().size === 15, 'quindici navi in mappa');
  click(page, 502, 402);
  assert.equal(popup(page).rows().length, 15);
  assert.doesNotMatch(popup(page).content, /data-more|e altre/);
});

test('pagina: il raggio segue il puntatore dell\'evento (dito su PC, mouse su tablet), ripiego sul tipo di schermo', async () => {
  const desk = await ready();
  // schermo da mouse, ma il clic arriva da un dito (PointerEvent touch): 20 px → tre navi
  desk.map.fire('click', { originalEvent: { clientX: 500, clientY: 400, pointerType: 'touch' }, containerPoint: { x: -999, y: -999 } });
  assert.deepEqual(popup(desk).rows(), ['247555001', '247555002', '247555003']);
  desk.map.closePopup();
  desk.map.fire('click', { originalEvent: { clientX: 500, clientY: 400, pointerType: 'mouse' }, containerPoint: { x: -999, y: -999 } });
  assert.equal(popup(desk), null, 'mouse: 8 px, GEMELLA 2 a 9 px esclusa');
  assert.equal(desk.get('selected'), 247555001);
  // schermo touch, clic del mouse: 8 px
  const touch = await ready({ media: { '(pointer: coarse)': true } });
  touch.map.fire('click', { originalEvent: { clientX: 500, clientY: 400, pointerType: 'mouse' }, containerPoint: { x: -999, y: -999 } });
  assert.equal(popup(touch), null);
  assert.equal(touch.get('selected'), 247555001);
});

test('pagina: Esc chiude il popup solo con il focus nel popup, sulla mappa o sul body; nella ricerca chiude i risultati', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  assert.ok(popup(page));
  // focus nel campo di ricerca con i risultati aperti: Esc chiude i risultati, il popup resta
  page.el('results').style.display = 'block';
  page.el('q').focus();
  const e = page.keydown('Escape');
  assert.equal(page.el('results').style.display, 'none', 'risultati chiusi');
  assert.ok(popup(page), 'il popup resta aperto');
  assert.equal(e.defaultPrevented, false);
  // focus sul body (nessun elemento): Esc chiude il popup
  page.document.activeElement = page.document.body;
  page.keydown('Escape');
  assert.equal(popup(page), null);
  // focus sulla mappa
  click(page, 500, 400);
  page.document.activeElement = page.el('map');
  assert.equal(page.keydown('Escape').defaultPrevented, true);
  assert.equal(popup(page), null);
});

test('pagina: popup chiuso con il focus altrove → pickOpener azzerato comunque, focus lasciato dov\'è', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  assert.equal(page.get('pickOpener'), page.el('map'));
  page.el('q').focus();
  page.map.closePopup();
  assert.equal(page.get('pickOpener'), null);
  assert.equal(page.document.activeElement, page.el('q'), 'il focus resta nella ricerca');
  // e con il focus nel popup, dopo la chiusura torna alla mappa e pickOpener è di nuovo null
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  page.map.closePopup();
  assert.equal(page.get('pickOpener'), null);
  assert.equal(page.document.activeElement, page.el('map'));
});

test('pagina: riaprire il popup con un popup aperto tiene come origine la mappa, non la riga del popup vecchio', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.document.activeElement = page.el('map');
  click(page, 500, 400);
  assert.equal(page.document.activeElement?.dataset?.pick, '247555001');
  click(page, 500, 400);   // secondo tocco: il popup vecchio si chiude (focus alla mappa), poi il nuovo
  assert.equal(page.get('pickOpener'), page.el('map'));
  page.map.closePopup();
  assert.equal(page.document.activeElement, page.el('map'));
});

test('pagina: durante l\'animazione dello zoom un clic non sceglie niente', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  page.map._animatingZoom = true;
  click(page, 500, 400);
  assert.equal(popup(page), null);
  assert.equal(page.get('selected'), null);
  page.map._animatingZoom = false;
  click(page, 500, 400);
  assert.ok(popup(page));
});

test('pagina: la nave selezionata (raggio 8) si sceglie fino a 16 px, la punta della freccia', async () => {
  const page = await ready();
  click(page, 500, 414);   // 14 px sotto GEMELLA 1: oltre gli 8 px del mouse
  assert.equal(page.get('selected'), null);
  click(page, 500, 400);
  assert.equal(page.get('selected'), 247555001);
  assert.equal(page.markers().get(247555001).marker.options.radius, 8);
  // 510,407: 7,3 px da A<B (raggio 4 → 8 px) e 12,2 px da GEMELLA 1 selezionata (raggio 8 → 16 px), 18,9 px da
  // GEMELLA 2 (8 px): senza il raggio per marker si aprirebbe subito A<B
  click(page, 510, 407);
  assert.ok(popup(page), 'popup: anche la selezionata è sotto il puntatore');
  assert.deepEqual(popup(page).rows(), ['247555003', '247555001']);
});

test('pagina: accessibilità del popup (× «Chiudi elenco», gruppo con aria-labelledby) e zoom in italiano', async () => {
  const page = await ready({ media: { '(pointer: coarse)': true } });
  assert.equal(page.mapOptions[0].zoomControl, false, 'il controllo di zoom predefinito (in inglese) non c\'è');
  assert.deepEqual(JSON.parse(JSON.stringify(page.zoomOptions)), [{ zoomInTitle: 'Ingrandisci', zoomOutTitle: 'Riduci' }]);
  click(page, 500, 400);
  const p = popup(page);
  assert.equal(p.getElement().closeButton.attributes['aria-label'], 'Chiudi elenco');
  const id = p.content.match(/<p class="pick-title" id="([^"]+)">3 navi qui<\/p>/)?.[1];
  assert.ok(id, 'titolo con id');
  assert.match(p.content, new RegExp(`<div class="pick-list" role="group" aria-labelledby="${id}">`));
  assert.doesNotMatch(p.content, /aria-label="/, 'il testo del titolo non è ripetuto in aria-label');
  // ogni popup ha il suo id (il vecchio può restare nel DOM durante la dissolvenza)
  page.map.closePopup();
  click(page, 500, 400);
  assert.notEqual(popup(page).content.match(/id="([^"]+)"/)[1], id);
});
