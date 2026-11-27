// Punto 71: pannello trascinabile a tre altezze con l'elenco delle navi in quest'area, nella pagina (boatradar.html) senza
// browser (test/pagina-helpers.js). Telefono (≤ 640 px): #sheet sempre in basso, chiuso (72 px) con il conteggio, a metà o
// aperto; tocco e frecce sulla maniglia; riga dell'elenco → scheda a metà sopra il pannello e nave spostata fra header e
// pannello; × → di nuovo l'elenco, con il focus sulla riga; ordine di Esc. Computer: pulsante «Elenco» nell'header.
// Il trascinamento vero (mouse giù, mosso a passi, su) è nello smoke (tools/smoke-browser.sh).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const ship = (mmsi, lat, lon, props) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, ...props } });
// tre navi nella vista della mappa finta (10…12 E, 43…45 N) e una fuori; sog di BRAVO cambiabile fra un giro e l'altro
let bravoSog = 12.3;
const ships = now => [
  ship(247000001, 44.001, 10.998, { name: 'BRAVO', shipType: 70, sog: bravoSog, timestampExternal: now() - 60000 }),
  ship(247000002, 43.997, 10.998, { name: 'ALFA', shipType: 80, sog: 3, timestampExternal: now() - 1000 }),
  ship(247000003, 44.0, 11.001, { name: 'CHARLIE', shipType: 30, timestampExternal: now() - 5000 }),
  ship(247000004, 46.0, 11.0, { name: 'FUORI', shipType: 70, sog: 1, timestampExternal: now() - 1000 }),
];
const routesFor = (features, total) => (url, now) => {
  if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 4, serverTime: now() }) };
  if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: total ?? features(now).length, features: features(now) }) };
};
const PHONE = { media: { '(max-width: 640px)': true, '(pointer: coarse)': true }, size: { x: 390, y: 844 }, viewport: { w: 390, h: 844 },
  rects: { header: { left: 56, top: 8, right: 382, bottom: 96 }, map: { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 } } };

async function ready(opts = {}, n = 4) {
  bravoSog = 12.3;
  const page = startPage({ routes: routesFor(ships), ...opts });
  await until(() => page.markers().size === n && /in quest'area/.test(page.el('sheet-count').textContent), `${n} navi e conteggio`);
  return page;
}
const stop = page => page.get('sheet.stop');
const tap = page => page.fireEl('sheet-handle', 'click', { detail: 1 });
const key = (page, k, id = 'sheet-handle') => page.dispatch(id, 'keydown', { key: k });
const rows = page => [...page.el('list').innerHTML.matchAll(/data-mmsi="(\d+)"/g)].map(m => Number(m[1]));
const panelOpen = page => page.el('panel').style.display === 'block';
const row = (page, mmsi) => page.el('list').querySelector(`[data-mmsi="${mmsi}"]`);
const clickRow = (page, mmsi) => { const r = row(page, mmsi); r.focus(); page.fireEl('list', 'click', { target: r }); };

test('telefono: all\'avvio pannello chiuso (72 px) con il numero di navi nella vista, senza righe', async () => {
  const page = await ready(PHONE);
  assert.equal(stop(page), 0);
  assert.equal(page.el('sheet-count').textContent, '3 navi in quest\'area', 'la nave fuori dalla vista non conta');
  assert.equal(page.el('sheet-handle').getAttribute('aria-expanded'), 'false');
  assert.equal(page.cssVar('--sheet-h'), '72px');
  assert.equal(page.el('sheet-body').hidden, true, 'da chiuso il contenuto non si raggiunge col Tab');
  assert.deepEqual(rows(page), [], 'righe solo da metà o aperto');
  assert.equal(page.get('JSON.stringify(sheet.stops)'), '[72,422,740]');
});

test('telefono: un tocco sulla maniglia apre a metà con le righe (nome, tipo, velocità, età), un altro richiude', async () => {
  const page = await ready(PHONE);
  tap(page);
  assert.equal(stop(page), 1);
  assert.equal(page.el('sheet-handle').getAttribute('aria-expanded'), 'true');
  assert.equal(page.cssVar('--sheet-h'), '422px');
  assert.equal(page.el('sheet-body').hidden, false);
  assert.deepEqual(rows(page), [247000002, 247000001, 247000003], 'per nome');
  const html = page.el('list').innerHTML;
  assert.match(html, /<button type="button" class="row" data-mmsi="247000001"><span class="age age-verde" aria-hidden="true"><\/span><b>BRAVO<\/b><small>Cargo · 12,3 kn · 1 min fa<\/small><\/button>/);
  assert.match(html, /<b>CHARLIE<\/b><small>Pesca · velocità n\.d\. · adesso<\/small>/);
  tap(page);
  assert.equal(stop(page), 0);
  assert.equal(page.cssVar('--sheet-h'), '72px');
  // da aperto un tocco torna a metà
  key(page, 'ArrowUp'); key(page, 'ArrowUp');
  assert.equal(stop(page), 2);
  tap(page);
  assert.equal(stop(page), 1);
});

test('telefono: frecce su e giù sulla maniglia; aperto = classe sheet-full (legenda nascosta)', async () => {
  const page = await ready(PHONE);
  assert.equal(key(page, 'ArrowUp').defaultPrevented, true);
  assert.equal(stop(page), 1);
  key(page, 'ArrowUp');
  assert.equal(stop(page), 2);
  assert.equal(page.cssVar('--sheet-h'), '740px');
  assert.ok(page.bodyClasses.has('sheet-full'));
  key(page, 'ArrowUp');
  assert.equal(stop(page), 2, 'non oltre aperto');
  key(page, 'ArrowDown');
  assert.equal(stop(page), 1);
  assert.equal(page.bodyClasses.has('sheet-full'), false);
  key(page, 'ArrowDown'); key(page, 'ArrowDown');
  assert.equal(stop(page), 0, 'non sotto chiuso');
  assert.equal(key(page, 'Tab').defaultPrevented, false, 'gli altri tasti non si toccano');
});

test('telefono: Esc chiude il pannello e porta il focus sulla maniglia; ricalcolo delle altezze girando lo schermo', async () => {
  const page = await ready(PHONE);
  tap(page);
  clickRow(page, 247000001);
  page.el('close').onclick();   // scheda chiusa: resta l'elenco a metà
  assert.equal(stop(page), 1);
  page.keydown('Escape');
  assert.equal(stop(page), 0);
  assert.equal(page.document.activeElement, page.el('sheet-handle'));
  key(page, 'ArrowUp');
  page.ctx.innerHeight = 600;
  page.fire('resize');
  assert.equal(page.get('JSON.stringify(sheet.stops)'), '[72,300,496]');
  assert.equal(page.cssVar('--sheet-h'), '300px', 'resta a metà');
});

test('ordinamento: tendina «Ordina per», salvato in localStorage e ripreso ricaricando', async () => {
  const page = await ready(PHONE);
  tap(page);
  const sort = page.el('list-sort');
  assert.match(sort.innerHTML, /<option value="name">Nome<\/option><option value="speed">Velocità<\/option><option value="age">Ultimo segnale<\/option><option value="type">Tipo<\/option>/);
  sort.value = 'speed';
  page.fireEl('list-sort', 'change', { target: sort });
  assert.deepEqual(rows(page), [247000001, 247000002, 247000003], 'velocità decrescente, n.d. in fondo');
  assert.equal(page.local.get('boatradar:ordine'), 'speed');
  sort.value = 'age';
  page.fireEl('list-sort', 'change', { target: sort });
  assert.deepEqual(rows(page), [247000002, 247000003, 247000001]);
  sort.value = 'type';
  page.fireEl('list-sort', 'change', { target: sort });
  assert.deepEqual(rows(page), [247000001, 247000003, 247000002], 'Cargo, Pesca, Petroliera');
  const again = await ready({ ...PHONE, local: { 'boatradar:ordine': 'speed' } });
  assert.equal(again.el('list-sort').value, 'speed');
  const bad = await ready({ ...PHONE, local: { 'boatradar:ordine': 'boh' } });
  assert.equal(bad.el('list-sort').value, 'name', 'valore sconosciuto → nome');
});

test('telefono: tocco su una riga → scheda a metà, zoom 11, nave spostata fra header e pannello', async () => {
  const page = await ready({ ...PHONE, zoom: 8 });
  key(page, 'ArrowUp'); key(page, 'ArrowUp');
  assert.equal(stop(page), 2);
  clickRow(page, 247000002);
  assert.equal(page.get('selected'), 247000002);
  assert.ok(panelOpen(page));
  assert.equal(stop(page), 1, 'la scheda si apre a metà');
  assert.equal(page.cssVar('--sheet-h'), '422px');
  const view = page.map.views.at(-1);
  assert.deepEqual([view[0].lat, view[0].lng, view[1]], [43.997, 10.998, 11], 'zoom 11 sulla nave');
  // nave in 300, 700 (proiezione della mappa finta); banda libera y 96 + 24 … 844 − 422 − 24 = 398 → 302 px in su
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), '[0,302]');
  // a zoom già 11 o più niente setView, solo lo spostamento
  page.el('close').onclick();
  page.setZoom(13);
  const nViews = page.map.views.length, nPans = page.map.pans.length;
  clickRow(page, 247000001);
  assert.equal(page.map.views.length, nViews);
  assert.equal(page.map.pans.length, nPans, 'BRAVO in 300, 300: già fra header e pannello, nessuno spostamento');
});

test('telefono: la nave scelta resta anche sopra l\'attribuzione di Leaflet (in basso a destra, sopra il pannello)', async () => {
  const page = await ready({ ...PHONE, zoom: 12, rects: { ...PHONE.rects, '.leaflet-bottom.leaflet-right': { height: 34 } } });
  tap(page);
  clickRow(page, 247000002);
  // nave in 300, 700: banda libera fino a 844 − 422 − 34 − 24 = 364 → 336 px in su
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), '[0,336]');
});

test('telefono: × → di nuovo l\'elenco all\'altezza di prima, focus sulla riga (anche ridisegnata)', async () => {
  const page = await ready(PHONE);
  tap(page);
  clickRow(page, 247000003);
  assert.equal(page.el('content').dataset.mmsi, 247000003);
  assert.equal(page.el('sheet').inert, true, 'sotto la scheda l\'elenco non prende focus né clic');
  page.el('close').onclick();
  assert.equal(panelOpen(page), false);
  assert.equal(page.el('sheet').inert, false);
  assert.equal(stop(page), 1, 'l\'elenco è ancora lì, a metà');
  assert.equal(page.document.activeElement.dataset?.mmsi, '247000003');
  assert.ok(page.document.activeElement.isConnected);
  // riga ridisegnata mentre la scheda era aperta (velocità cambiata): focus sulla riga nuova con lo stesso MMSI
  clickRow(page, 247000001);
  const old = page.document.activeElement;
  bravoSog = 15;
  await page.tick();   // scheda aperta sopra l'elenco: l'elenco nascosto non si ridisegna
  page.el('close').onclick();   // ridisegnato chiudendo (velocità nuova): la riga di prima è scollegata
  assert.notEqual(page.document.activeElement, old);
  assert.equal(page.document.activeElement.dataset?.mmsi, '247000001');
  assert.ok(page.document.activeElement.isConnected, 'la riga nuova, non quella scollegata');
});

test('telefono: dalla mappa a pannello chiuso la scheda si apre a metà e chiudendola il pannello torna chiuso', async () => {
  const page = await ready(PHONE);
  page.get('select(247000001)');
  assert.equal(stop(page), 1);
  assert.equal(page.cssVar('--sheet-h'), '422px');
  page.el('close').onclick();
  assert.equal(stop(page), 0);
  // trascinare la scheda (maniglia della scheda, frecce) cambia la stessa altezza
  page.get('select(247000001)');
  key(page, 'ArrowUp', 'panel-handle');
  assert.equal(stop(page), 2);
  assert.match(page.el('panel-handle').getAttribute('aria-label'), /aperta/);
  page.fireEl('panel-handle', 'click', { detail: 1 });
  assert.equal(stop(page), 1);
});

test('telefono: ordine di Esc: risultati della ricerca, scheda, pannello', async () => {
  const page = await ready(PHONE);
  tap(page);
  clickRow(page, 247000002);
  page.el('results').style.display = 'block';
  page.keydown('Escape', page.el('q'));
  assert.equal(page.el('results').style.display, 'none', 'prima i risultati');
  assert.ok(panelOpen(page), 'la scheda resta');
  page.keydown('Escape', page.el('q'));
  assert.equal(panelOpen(page), false, 'poi la scheda');
  assert.equal(stop(page), 1);
  page.keydown('Escape');
  assert.equal(stop(page), 0, 'poi il pannello');
  assert.equal(page.keydown('Escape').defaultPrevented, false, 'poi niente');
});

test('righe: nave selezionata segnata, filtri applicati (marker già filtrati), focus mantenuto ridisegnando', async () => {
  const page = await ready(PHONE);
  tap(page);
  // Cargo spento nella legenda: BRAVO (70) sparisce da mappa, conteggio ed elenco
  page.fireEl('legend', 'click', { target: { closest: sel => (sel === '[data-type]' ? { dataset: { type: 'cargo' } } : null) } });
  await until(() => !rows(page).includes(247000001), 'BRAVO tolta dall\'elenco');
  assert.match(page.el('sheet-count').textContent, /^2 navi in quest'area/);
  page.fireEl('legend', 'click', { target: { closest: sel => (sel === '[data-type]' ? { dataset: { type: 'cargo' } } : null) } });
  await page.tick();
  assert.deepEqual(rows(page), [247000002, 247000001, 247000003]);
  // focus su CHARLIE, poi un giro con la velocità di BRAVO cambiata: la riga di CHARLIE è nuova e ha il focus
  row(page, 247000003).focus();
  const before = page.document.activeElement;
  bravoSog = 7;
  await page.tick();
  assert.notEqual(page.document.activeElement, before, 'elenco ridisegnato');
  assert.equal(page.document.activeElement.dataset.mmsi, '247000003');
  assert.ok(page.document.activeElement.isConnected);
  // giro con le stesse righe: l'elenco non si riscrive
  const gen = page.el('list').gen;
  await page.tick();
  assert.equal(page.el('list').gen, gen);
  // spostamento della mappa: elenco ricalcolato subito (moveend)
  page.get('selected = 247000002');
  page.map.fire('moveend');
  assert.match(page.el('list').innerHTML, /data-mmsi="247000002" aria-current="true"/);
});

test('conteggio con il campione del server e «e altre N» oltre 100 righe', async () => {
  const crowd = now => Array.from({ length: 130 }, (_, i) => ship(247100000 + i, 44 + i * 1e-4, 11, { name: `NAVE ${String(i).padStart(3, '0')}`,
    shipType: 70, sog: 1, timestampExternal: now() - 1000 }));
  const page = startPage({ routes: routesFor(crowd, 500), ...PHONE });
  await until(() => page.markers().size === 130, '130 navi');
  await until(() => /130 navi/.test(page.el('sheet-count').textContent), 'conteggio');
  assert.equal(page.el('sheet-count').textContent, '130 navi in quest\'area · 500 in tutto, avvicina per vederle tutte');
  tap(page);
  assert.equal(rows(page).length, 100);
  assert.equal(page.el('list-more').textContent, 'e altre 30: avvicina la mappa o usa i filtri');
  assert.equal(page.el('list-more').hidden, false);
});

test('mappa vuota: «Nessuna nave in quest\'area» e una riga che dice cosa fare', async () => {
  const page = startPage({ routes: routesFor(() => []), ...PHONE });
  await until(() => /Nessuna nave/.test(page.el('sheet-count').textContent), 'conteggio a zero');
  assert.equal(page.el('sheet-count').textContent, 'Nessuna nave in quest\'area');
  tap(page);
  assert.match(page.el('list').innerHTML, /<li class="empty">Nessuna nave in quest'area: sposta la mappa o cambia i filtri\.<\/li>/);
  assert.equal(page.el('list-more').hidden, true);
});

test('«Legenda e filtri» nel pannello: apre la legenda con il focus sul titolo, da aperto torna a metà', async () => {
  const page = await ready(PHONE);
  key(page, 'ArrowUp'); key(page, 'ArrowUp');
  page.el('legend').open = false;
  page.fireEl('list-legend', 'click');
  assert.equal(page.el('legend').open, true);
  assert.equal(page.document.activeElement, page.el('legend-sum'));
  assert.equal(stop(page), 1, 'la legenda è nascosta da aperto');
});

test('computer: pulsante «Elenco» (aria-pressed) apre l\'elenco a destra; la scheda ci si sovrappone; Esc', async () => {
  const page = await ready();
  assert.equal(page.cssVar('--sheet-h'), '0px', 'nessun pannello in basso');
  assert.equal(page.el('listbtn').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(rows(page), []);
  page.fireEl('listbtn', 'click');
  assert.ok(page.bodyClasses.has('list-open'));
  assert.equal(page.el('listbtn').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(rows(page), [247000002, 247000001, 247000003]);
  assert.equal(page.el('list-count').textContent, '3 navi in quest\'area');
  // riga → scheda sopra l'elenco, senza zoom né spostamento (solo il telefono ha il pannello in basso)
  const nViews = page.map.views.length;
  clickRow(page, 247000001);
  assert.ok(panelOpen(page));
  assert.equal(page.map.views.length, nViews);
  assert.equal(page.map.pans.length, 0);
  page.keydown('Escape');
  assert.equal(panelOpen(page), false, 'Esc chiude prima la scheda');
  assert.ok(page.bodyClasses.has('list-open'), 'l\'elenco resta');
  assert.equal(page.document.activeElement.dataset?.mmsi, '247000001', 'focus sulla riga');
  page.keydown('Escape');
  assert.equal(page.bodyClasses.has('list-open'), false, 'poi l\'elenco');
  assert.equal(page.document.activeElement, page.el('listbtn'));
  page.fireEl('listbtn', 'click');
  page.fireEl('listbtn', 'click');
  assert.equal(page.bodyClasses.has('list-open'), false, 'il pulsante alterna');
  // maniglia e frecce non fanno niente su computer
  key(page, 'ArrowUp');
  assert.equal(stop(page), 0);
});

test('marcatura: sezione con nome, maniglia con aria-controls/aria-expanded, etichetta visibile dell\'ordinamento', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'boatradar.html'), 'utf8');
  assert.match(html, /<section id="sheet" aria-label="Navi in quest'area">/);
  assert.match(html, /<button type="button" id="sheet-handle" aria-controls="sheet-body" aria-expanded="false">/);
  assert.match(html, /<label for="list-sort">Ordina per<\/label>\s*<select id="list-sort"><\/select>/);
  assert.match(html, /<ul id="list"[^>]*><\/ul>/);
  assert.match(html, /<button type="button" id="listbtn" class="hbtn" aria-pressed="false" aria-controls="sheet">/);
  assert.match(html, /<button type="button" id="panel-handle"/);
  // nessuna regione aria-live sul conteggio, che cambia a ogni giro
  assert.doesNotMatch(html.slice(html.indexOf('<section id="sheet"'), html.indexOf('</section>')), /aria-live/);
  const phone = html.slice(html.indexOf('@media (max-width: 640px)'));
  const css = phone.slice(0, phone.indexOf('</style>'));
  assert.match(css, /\.leaflet-container \.leaflet-bottom \{ bottom:var\(--sheet-h\)/, 'attribuzione sopra il pannello');
  assert.match(css, /#toast \{ bottom:calc\(var\(--sheet-h\) \+ 12px\)/);
  assert.match(css, /#sheet-handle, #panel-handle \{[^}]*touch-action:none/);
  assert.match(html, /body\.list-open:not\(\.vf\) header/, 'su computer l\'header non copre l\'elenco');
});
