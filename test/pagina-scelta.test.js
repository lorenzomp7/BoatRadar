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
