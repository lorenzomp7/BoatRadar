// Punto 71: pannello trascinabile a tre altezze con l'elenco delle navi in quest'area, nella pagina (boatradar.html) senza
// browser (test/pagina-helpers.js). Telefono (≤ 640 px): #sheet sempre in basso, chiuso (72 px) con il conteggio, a metà o
// aperto; tocco e frecce sulla maniglia; riga dell'elenco → scheda a metà sopra il pannello e nave spostata fra header e
// pannello; × → di nuovo l'elenco, con il focus sulla riga; ordine di Esc. Computer: pulsante «Elenco» nell'header.
// Trascinamento con pointer event finti e ora manuale (performance.now); quello vero (mouse giù, mosso a passi, su; lancio
// veloce) è nello smoke (tools/smoke-browser.sh).
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
const routesFor = (features, total, { baltic = () => [], hang = () => false } = {}) => (url, now) => {
  if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: () => ({ type: 'FeatureCollection', features: baltic(now) }) };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 4, serverTime: now() }) };
  if (url.startsWith('/api/locations?')) return hang(url) ? { hang: true }
    : { body: () => ({ type: 'FeatureCollection', total: total ?? features(now).length, features: features(now) }) };
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
  await until(() => page.cssVar('--sheet-h') === '72px', '72 px a fine discesa');
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
  assert.ok(page.bodyClasses.has('sheet-full'), 'la legenda resta nascosta finché il pannello scende');
  await until(() => !page.bodyClasses.has('sheet-full'), 'sheet-full tolta a fine discesa');
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

// Trascinamento della maniglia con pointer event finti e ora manuale (perfNow = performance.now = ora della pagina).
// Altezze [72, 422, 740]; pointerdown a y 800 dal pannello chiuso: h = 72 + (800 − y).
const T0 = Date.UTC(2026, 10, 27, 12);
const DRAG = { ...PHONE, manualTime: T0, raf: false };
const ptr = (page, type, y, pointerId = 1, id = 'sheet-handle') => page.dispatch(id, type, { pointerId, clientY: y, button: 0 });
const dragging = page => page.get('!!sheet.drag');

test('trascinamento lento: il pannello si ferma all\'altezza più vicina', async () => {
  const page = await ready(DRAG);
  ptr(page, 'pointerdown', 800);
  assert.ok(dragging(page));
  page.advance(500); ptr(page, 'pointermove', 650);
  page.advance(500); ptr(page, 'pointermove', 500);   // h = 372
  assert.match(page.el('sheet').style.transform, /translateY\(368px\)/, '740 − 372: solo transform');
  page.advance(500); ptr(page, 'pointerup', 500);
  assert.equal(dragging(page), false);
  assert.equal(stop(page), 1, '372 → 422 (metà)');
  page.advance(500);
  // da metà, piano verso il basso fino a h 200: più vicina 72
  ptr(page, 'pointerdown', 500);
  page.advance(800); ptr(page, 'pointermove', 722);
  page.advance(800); ptr(page, 'pointerup', 722);
  assert.equal(stop(page), 0);
});

test('lancio veloce: una tappa in più di quella più vicina, mai due', async () => {
  const page = await ready(DRAG);
  ptr(page, 'pointerdown', 800);
  page.advance(10); ptr(page, 'pointermove', 780);
  page.advance(30); ptr(page, 'pointermove', 700);   // h = 172: più vicina 72
  page.advance(10); ptr(page, 'pointerup', 700);     // 100 px in 50 ms verso l'alto
  assert.equal(stop(page), 1, 'lancio verso l\'alto: metà');
  page.advance(1000);
  // dal chiuso un lancio velocissimo (2 px/ms × 200 ms arriverebbe oltre l'aperto) si ferma comunque a una tappa
  page.get('setStop(0)');
  ptr(page, 'pointerdown', 800);
  page.advance(5); ptr(page, 'pointermove', 750);
  page.advance(5); ptr(page, 'pointerup', 700);
  assert.equal(stop(page), 1, 'al massimo una tappa più in là della più vicina');
  page.advance(1000);
  // da metà un lancio veloce verso il basso: chiuso
  ptr(page, 'pointerdown', 400);
  page.advance(20); ptr(page, 'pointermove', 440);
  page.advance(20); ptr(page, 'pointerup', 480);     // h = 342: più vicina 422, velocità −2 px/ms
  assert.equal(stop(page), 0);
});

test('tocco: meno di 6 px e click → cambio di tappa; da 6 px il click che segue si ignora', async () => {
  const page = await ready(DRAG);
  ptr(page, 'pointerdown', 800);
  page.advance(300); ptr(page, 'pointermove', 804);
  page.advance(300); ptr(page, 'pointerup', 804);
  assert.equal(stop(page), 0, 'nessuno spostamento: lo fa il click');
  assert.equal(page.el('sheet').style.transform, '', 'stili del trascinamento tolti');
  tap(page);
  assert.equal(stop(page), 1, 'tocco: metà');
  page.advance(1000);
  ptr(page, 'pointerdown', 400);
  page.advance(500); ptr(page, 'pointermove', 394);   // 6 px: trascinamento
  page.advance(500); ptr(page, 'pointerup', 394);
  assert.equal(stop(page), 1, 'h 428: resta a metà');
  page.advance(50);
  tap(page);
  assert.equal(stop(page), 1, 'click subito dopo il trascinamento ignorato');
  page.advance(500);
  tap(page);
  assert.equal(stop(page), 0, 'più tardi il tocco torna a funzionare');
});

test('trascinamento: un secondo dito si ignora; durante il trascinamento click, frecce ed Esc non fanno niente', async () => {
  const page = await ready(DRAG);
  ptr(page, 'pointerdown', 800, 1);
  ptr(page, 'pointerdown', 300, 2);
  page.advance(200); ptr(page, 'pointermove', 100, 2);
  assert.equal(page.get('sheet.drag.h'), 72, 'il secondo puntatore non sposta');
  ptr(page, 'pointerup', 100, 2);
  assert.ok(dragging(page), 'il trascinamento del primo continua');
  page.advance(200); ptr(page, 'pointermove', 500, 1);   // h = 372
  tap(page);
  assert.equal(stop(page), 0, 'click ignorato');
  assert.equal(key(page, 'ArrowUp').defaultPrevented, true);
  assert.equal(stop(page), 0, 'freccia ignorata');
  page.get('sheet.stop = 1');   // anche da metà Esc non abbassa il pannello sotto il dito
  page.keydown('Escape');
  assert.equal(stop(page), 1, 'Esc ignorato');
  page.get('sheet.stop = 0');
  assert.ok(dragging(page));
  assert.equal(page.get('sheet.drag.h'), 372);
  page.advance(500); ptr(page, 'pointerup', 500, 1);
  assert.equal(stop(page), 1);
});

test('trascinamento: setStop (per esempio la scheda che si apre) lo termina come annullato', async () => {
  const page = await ready(DRAG);
  ptr(page, 'pointerdown', 800);
  page.advance(200); ptr(page, 'pointermove', 500);
  page.get('select(247000001)');   // scheda aperta a metà durante il trascinamento
  assert.equal(dragging(page), false);
  assert.equal(stop(page), 1);
  page.advance(200); ptr(page, 'pointermove', 100);
  ptr(page, 'pointerup', 100);
  assert.equal(stop(page), 1, 'i pointer event del trascinamento annullato non contano più');
});

test('pointercancel e lostpointercapture: altezza più vicina senza velocità; il resize torna a ricalcolare', async () => {
  const page = await ready(DRAG);
  ptr(page, 'pointerdown', 800);
  page.advance(10); ptr(page, 'pointermove', 780);
  page.advance(30); ptr(page, 'pointermove', 700);   // h 172, veloce verso l'alto
  page.advance(10); ptr(page, 'pointercancel', 700);
  assert.equal(dragging(page), false);
  assert.equal(stop(page), 0, 'annullato: più vicina, la velocità non conta');
  page.advance(1000);
  ptr(page, 'pointerdown', 800);
  page.advance(200); ptr(page, 'pointermove', 500);   // h 372
  ptr(page, 'lostpointercapture', 500);
  assert.equal(dragging(page), false, 'il trascinamento non resta bloccato');
  assert.equal(stop(page), 1);
  ptr(page, 'pointerup', 500);   // il pointerup che arriva dopo non fa niente
  assert.equal(stop(page), 1);
  page.ctx.innerHeight = 600;
  page.fire('resize');
  assert.equal(page.get('JSON.stringify(sheet.stops)'), '[72,300,496]');
  // pointercancel senza spostamento: nessun cambio
  ptr(page, 'pointerdown', 500);
  ptr(page, 'pointercancel', 500);
  assert.equal(stop(page), 1);
  assert.equal(page.el('sheet').style.transform, '');
});

test('trascinamento dal pannello chiuso: le righe si scrivono subito (l\'elenco si vede mentre sale)', async () => {
  const page = await ready(DRAG);
  assert.deepEqual(rows(page), []);
  ptr(page, 'pointerdown', 800);
  assert.equal(page.el('sheet-body').hidden, false);
  assert.deepEqual(rows(page), [247000002, 247000001, 247000003]);
  ptr(page, 'pointercancel', 800);
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
  for (const k of ['hasOwnProperty', 'constructor']) {
    const proto = await ready({ ...PHONE, local: { 'boatradar:ordine': k } });
    assert.equal(proto.el('list-sort').value, 'name', `${k} → nome`);
    tap(proto);
    assert.deepEqual(rows(proto), [247000002, 247000001, 247000003], `${k}: righe per nome`);
  }
});

test('ordine «Tipo»: le navi senza tipo in fondo (in riga «Altro / sconosciuto»)', async () => {
  const mixed = now => [
    ship(247000011, 44, 11, { name: 'ZULU', shipType: 70, sog: 1, timestampExternal: now() - 1000 }),
    ship(247000012, 44, 11, { name: 'ALFA', sog: 1, timestampExternal: now() - 1000 }),
    ship(247000013, 44, 11, { name: 'BETA', shipType: 30, sog: 1, timestampExternal: now() - 1000 }),
  ];
  const page = startPage({ routes: routesFor(mixed), ...PHONE, local: { 'boatradar:ordine': 'type' } });
  await until(() => page.markers().size === 3, '3 navi');
  tap(page);
  assert.deepEqual(rows(page), [247000011, 247000013, 247000012], 'Cargo, Pesca, poi senza tipo');
  assert.match(page.el('list').innerHTML, /<b>ALFA<\/b><small>Altro \/ sconosciuto · /);
});

test('telefono: tocco su una riga → scheda a metà, zoom 11, nave spostata fra header e pannello', async () => {
  const page = await ready({ ...PHONE, zoom: 8 });
  key(page, 'ArrowUp'); key(page, 'ArrowUp');
  assert.equal(stop(page), 2);
  clickRow(page, 247000002);
  assert.equal(page.get('selected'), 247000002);
  assert.ok(panelOpen(page));
  assert.equal(stop(page), 1, 'la scheda si apre a metà');
  assert.equal(page.cssVar('--sheet-h'), '740px', 'scendendo resta quella di prima fino alla fine');
  await until(() => page.cssVar('--sheet-h') === '422px', '422 px a fine discesa');
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
  const page = await ready({ ...PHONE, zoom: 12, rects: { ...PHONE.rects,
    '.leaflet-bottom.leaflet-right': { top: 388, bottom: 422, width: 120, height: 34 } } });
  tap(page);
  clickRow(page, 247000002);
  // nave in 300, 700: banda libera fino alla cima dell'attribuzione 388 − 24 = 364 → 336 px in su
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), '[0,336]');
  assert.equal(page.map.pans.at(-1)[1], undefined, 'spostamento animato');
});

test('telefono: la legenda si chiude aprendo la scheda e la nave resta sopra la sua cima (pillola «Legenda e filtri»)', async () => {
  // pillola della legenda a sinistra sopra il pannello (cima 340) più in alto dell'attribuzione (cima 388)
  const page = await ready({ ...PHONE, zoom: 12, rects: { ...PHONE.rects, legend: { top: 340, bottom: 384, width: 150, height: 44 },
    '.leaflet-bottom.leaflet-right': { top: 388, bottom: 422, width: 120, height: 34 } } });
  page.el('legend').open = true;
  tap(page);
  clickRow(page, 247000002);
  assert.equal(page.el('legend').open, false, 'su telefono la legenda aperta coprirebbe la nave');
  // banda libera fino a 340 − 24 = 316 → 700 − 316 = 384 px in su
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), '[0,384]');
  // con il pannello aperto (legenda nascosta da sheet-full) conta solo l'attribuzione
  key(page, 'ArrowUp', 'panel-handle');
  assert.equal(stop(page), 2);
  page.get('keepVisible(247000002)');
  // pannello aperto 740: banda vuota (96 + 24 … 844 − 740 − 24), la nave a metà
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), JSON.stringify([0, 700 - (120 + 80) / 2]));
});

test('telefono: con prefers-reduced-motion lo spostamento della mappa non è animato', async () => {
  const page = await ready({ ...PHONE, zoom: 12, media: { ...PHONE.media, '(prefers-reduced-motion: reduce)': true } });
  tap(page);
  clickRow(page, 247000002);
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.pans.at(-1))), [[0, 302], { animate: false }]);
});

test('computer: la legenda resta aperta aprendo la scheda', async () => {
  const page = await ready();
  page.el('legend').open = true;
  page.get('select(247000001)');
  assert.equal(page.el('legend').open, true);
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
  // maniglia della scheda: il nome dice cosa fa il tocco, aria-expanded l'altezza
  assert.equal(page.el('panel-handle').getAttribute('aria-label'), 'Abbassa la scheda');
  assert.equal(page.el('panel-handle').getAttribute('aria-expanded'), 'true');
  key(page, 'ArrowUp', 'panel-handle');
  assert.equal(stop(page), 2);
  assert.equal(page.el('panel-handle').getAttribute('aria-label'), 'Abbassa la scheda a metà');
  page.fireEl('panel-handle', 'click', { detail: 1 });
  assert.equal(stop(page), 1);
  key(page, 'ArrowDown', 'panel-handle');
  assert.equal(page.el('panel-handle').getAttribute('aria-label'), 'Alza la scheda a metà');
  assert.equal(page.el('panel-handle').getAttribute('aria-expanded'), 'false');
});

test('telefono: girando lo schermo con la scheda aperta il pannello torna poi all\'altezza di prima', async () => {
  const media = { ...PHONE.media };
  const page = await ready({ ...PHONE, media });
  page.get('select(247000001)');
  assert.equal(stop(page), 1, 'scheda a metà, prima era chiuso');
  media['(max-width: 640px)'] = false;   // orizzontale: larghezza da computer
  page.fire('resize');
  page.el('close').onclick();
  media['(max-width: 640px)'] = true;    // di nuovo in verticale
  page.fire('resize');
  assert.equal(stop(page), 0, 'chiuso come prima della scheda');
  assert.equal(page.cssVar('--sheet-h'), '72px');
});

test('popup «N navi qui»: si chiude aprendo la scheda e alzando il pannello, non abbassandolo', async () => {
  const page = await ready(PHONE);
  page.get('openPick({ x: 300, y: 300 }, [247000001, 247000002])');
  assert.ok(page.map._popup, 'popup aperto');
  key(page, 'ArrowUp');
  assert.equal(page.map._popup, null, 'pannello più alto: popup chiuso');
  page.get('openPick({ x: 300, y: 300 }, [247000001, 247000002])');
  key(page, 'ArrowDown');
  assert.ok(page.map._popup, 'pannello più basso: il popup resta');
  page.get('select(247000003)');
  assert.equal(page.map._popup, null, 'scheda aperta: popup chiuso');
});

test('telefono: scendendo --sheet-h e il contenuto restano fino alla fine della discesa; salendo cambiano subito', async () => {
  const page = await ready(PHONE);
  tap(page);
  assert.equal(page.cssVar('--sheet-h'), '422px', 'salendo subito');
  tap(page);
  assert.equal(stop(page), 0);
  assert.equal(page.cssVar('--sheet-h'), '422px', 'attribuzione e legenda non finiscono sotto il pannello che scende');
  assert.equal(page.el('sheet-body').hidden, false, 'il contenuto si vede mentre scende');
  await until(() => page.cssVar('--sheet-h') === '72px', 'fine della discesa');
  assert.equal(page.el('sheet-body').hidden, true);
  assert.equal(page.el('sheet').style.transform, '');
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

test('righe: filtri applicati (marker già filtrati), focus mantenuto ridisegnando', async () => {
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
  bravoSog = 9;
  await page.tick();
  page.get('sheet.html = ""');
  page.map.fire('moveend');
  assert.match(page.el('list').innerHTML, /<b>BRAVO<\/b><small>Cargo · 9,0 kn/);
  assert.doesNotMatch(page.el('list').innerHTML, /aria-current/, 'nessuna riga segnata: sotto la scheda aperta l\'elenco non si vede');
});

test('righe: la riga con il focus sparisce → focus sulla prima riga (senza righe sulla maniglia)', async () => {
  const page = await ready(PHONE);
  tap(page);
  row(page, 247000001).focus();
  const cargo = { target: { closest: sel => (sel === '[data-type]' ? { dataset: { type: 'cargo' } } : null) } };
  page.fireEl('legend', 'click', cargo);   // BRAVO (Cargo) sparisce
  assert.deepEqual(rows(page), [247000002, 247000003]);
  assert.equal(page.document.activeElement.dataset?.mmsi, '247000002', 'prima riga');
  assert.ok(page.document.activeElement.isConnected);
  const off = t => page.fireEl('legend', 'click', { target: { closest: sel => (sel === '[data-type]' ? { dataset: { type: t } } : null) } });
  off('tanker');   // ALFA sparisce
  assert.equal(page.document.activeElement.dataset?.mmsi, '247000003');
  off('fishing');  // nessuna riga: focus sulla maniglia
  assert.deepEqual(rows(page), []);
  assert.equal(page.document.activeElement, page.el('sheet-handle'));
});

test('righe: con il dito (o il mouse) premuto nell\'elenco le righe non si ridisegnano fino al rilascio', async () => {
  const page = await ready(PHONE);
  tap(page);
  const gen = page.el('list').gen;
  page.fireEl('list', 'pointerdown', { pointerId: 1 });
  bravoSog = 5;
  await page.tick();
  assert.equal(page.el('list').gen, gen, 'nessuna riga sostituita sotto il dito');
  assert.match(page.el('sheet-count').textContent, /3 navi/, 'il conteggio sì');
  page.fire('pointerup');
  await until(() => page.el('list').gen !== gen, 'ridisegnato dopo il rilascio');
  assert.match(page.el('list').innerHTML, /<b>BRAVO<\/b><small>Cargo · 5,0 kn/);
});

test('elenco chiuso: solo il conteggio, senza dati statici né tipo di ogni nave', async () => {
  const page = await ready(PHONE);
  const meta = page.get('meta');
  let reads = 0;
  const get = meta.get.bind(meta);
  meta.get = k => { reads++; return get(k); };
  page.get('renderList()');
  assert.equal(reads, 0);
  assert.equal(page.el('sheet-count').textContent, '3 navi in quest\'area');
  meta.get = get;
});

test('conteggio con il campione del server e «e altre N» oltre 100 righe', async () => {
  const crowd = now => Array.from({ length: 130 }, (_, i) => ship(247100000 + i, 44 + i * 1e-4, 11, { name: `NAVE ${String(i).padStart(3, '0')}`,
    shipType: 70, sog: 1, timestampExternal: now() - 1000 }));
  const page = startPage({ routes: routesFor(crowd, 500), ...PHONE });
  await until(() => page.markers().size === 130, '130 navi');
  await until(() => /130 navi/.test(page.el('sheet-count').textContent), 'conteggio');
  assert.equal(page.el('sheet-count').textContent, '130 navi in quest\'area · 130 di 500 nei dintorni: avvicina per vederle tutte');
  tap(page);
  assert.equal(rows(page).length, 100);
  assert.equal(page.el('list-more').textContent, 'e altre 30: avvicina la mappa o usa i filtri');
  assert.equal(page.el('list-more').hidden, false);
});

test('totale del server: dopo un cambio di filtro nessuna nota finché non arriva la risposta con il filtro nuovo', async () => {
  const crowd = now => Array.from({ length: 30 }, (_, i) => ship(247200000 + i, 44 + i * 1e-4, 11, { name: `NAVE ${i}`,
    shipType: 70, sog: 1, timestampExternal: now() - 1000 }));
  let hang = false;
  const page = startPage({ routes: routesFor(crowd, 500, { hang: () => hang }), ...PHONE });
  await until(() => /30 di 500 nei dintorni/.test(page.el('sheet-count').textContent), 'nota del totale');
  hang = true;   // la risposta con il filtro nuovo tarda
  page.fireEl('legend', 'click', { target: { closest: sel => (sel === '[data-type]' ? { dataset: { type: 'fishing' } } : null) } });
  assert.equal(page.el('sheet-count').textContent, '30 navi in quest\'area', 'il totale di 500 era del filtro di prima');
  await page.tick();
  assert.equal(page.el('sheet-count').textContent, '30 navi in quest\'area');
  hang = false;
  page.tick();
  await until(() => /nei dintorni/.test(page.el('sheet-count').textContent), 'nota con il filtro nuovo');
});

test('totale del server: la nota confronta il totale con le navi mandate dal server, non con quelle in mappa (Baltico)', async () => {
  const server = now => Array.from({ length: 20 }, (_, i) => ship(247300000 + i, 44 + i * 1e-4, 11, { name: `S ${i}`, shipType: 70, sog: 1,
    timestampExternal: now() - 1000 }));
  const baltic = now => Array.from({ length: 40 }, (_, i) => ship(230300000 + i, 44 - i * 1e-4, 11, { name: `B ${i}`, sog: 1,
    timestampExternal: now() - 1000 }));
  const page = startPage({ routes: routesFor(server, 50, { baltic }), ...PHONE });
  await until(() => page.markers().size === 60, '60 navi');
  await until(() => /60 navi/.test(page.el('sheet-count').textContent), 'conteggio');
  assert.equal(page.el('sheet-count').textContent, '60 navi in quest\'area · 20 di 50 nei dintorni: avvicina per vederle tutte',
    'il server ne ha mandate 20 su 50 anche se in mappa ce ne sono 60');
  // senza campione (il server le manda tutte) nessuna nota
  const all = startPage({ routes: routesFor(server, 20, { baltic }), ...PHONE });
  await until(() => all.markers().size === 60 && /60 navi/.test(all.el('sheet-count').textContent), '60 navi');
  assert.equal(all.el('sheet-count').textContent, '60 navi in quest\'area');
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
  // navi tutte in x 900 (sotto la scheda e l'elenco, a destra da x 648 su una mappa larga 1000)
  const page = await ready({ project: () => ({ x: 900, y: 400 }),
    rects: { map: { left: 0, top: 0, right: 1000, bottom: 800 }, panel: { left: 648, right: 988, top: 12, bottom: 788 },
      sheet: { left: 648, right: 988, top: 12, bottom: 788 } } });
  assert.equal(page.cssVar('--sheet-h'), '0px', 'nessun pannello in basso');
  assert.equal(page.el('listbtn').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(rows(page), []);
  page.fireEl('listbtn', 'click');
  assert.ok(page.bodyClasses.has('list-open'));
  assert.equal(page.el('listbtn').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(rows(page), [247000002, 247000001, 247000003]);
  assert.equal(page.el('list-count').textContent, '3 navi in quest\'area');
  // riga → scheda sopra l'elenco, senza zoom; la mappa si sposta perché la nave non resti sotto la scheda: margine destro
  // 1000 − 648 = 352, banda x 24 … 1000 − 352 − 24 = 624 → 900 − 624 = 276 px
  const nViews = page.map.views.length;
  clickRow(page, 247000001);
  assert.ok(panelOpen(page));
  assert.equal(page.map.views.length, nViews);
  assert.equal(JSON.stringify(page.map.pans.at(-1)[0]), '[276,0]');
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
  assert.match(html, /<button type="button" id="panel-handle" aria-controls="panel" aria-expanded="true" aria-label="Abbassa la scheda">/);
  assert.match(html, /id="listbtn"[^>]*><span aria-hidden="true">☰<\/span> Elenco<\/button>/, '☰ non letto dai lettori di schermo');
  assert.doesNotMatch(html, /safe-area-inset/, 'il viewport non ha viewport-fit=cover: env() sarebbe sempre 0');
  assert.doesNotMatch(html, /aria-current/, 'nessuna riga segnata (sotto la scheda l\'elenco non si vede)');
  // nessuna regione aria-live sul conteggio, che cambia a ogni giro
  assert.doesNotMatch(html.slice(html.indexOf('<section id="sheet"'), html.indexOf('</section>')), /aria-live/);
  const phone = html.slice(html.indexOf('@media (max-width: 640px)'));
  const css = phone.slice(0, phone.indexOf('</style>'));
  assert.match(css, /\.leaflet-container \.leaflet-bottom \{ bottom:var\(--sheet-h\)/, 'attribuzione sopra il pannello');
  assert.match(css, /#toast \{ bottom:calc\(var\(--sheet-h\) \+ 12px\)/);
  assert.match(css, /#sheet-handle, #panel-handle \{[^}]*touch-action:none/);
  assert.match(html, /body\.list-open:not\(\.vf\) header/, 'su computer l\'header non copre l\'elenco');
});
