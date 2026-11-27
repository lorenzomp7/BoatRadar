// Lotto B (punti 27, 44, 46, 23): scheda nave della pagina (boatradar.html) senza browser (test/pagina-helpers.js).
// Bandiera e tipo di MMSI, stato dichiarato contro velocità, carico pericoloso e il suo filtro, gruppo «Viaggio» con
// l'ETA e «n.d.» per i valori mancanti. La logica pura è in test/scheda-logica.test.js; la verifica nel browser vero è
// il passo «scheda» di tools/smoke-browser.sh.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

// ora fissa della pagina: 27 novembre 2026, 10:00 UTC
const T0 = Date.UTC(2026, 10, 27, 10, 0);
const ship = (mmsi, lat, lon, props) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, timestampExternal: T0 - 1000, ...props } });
const SHIP = 247123450, COAST = 2470001, LIBERIA = 636000001;
const features = () => [
  ship(SHIP, 44.1, 11.1, { name: 'LAGUNA PRIMA', shipType: 70, sog: 8, cog: 90, navStat: 5 }),
  ship(COAST, 44.2, 11.2, { name: 'GENOVA RADIO' }),
  ship(LIBERIA, 44.3, 11.3, { name: 'MONROVIA', shipType: 71, sog: 0.1, navStat: 0 }),
];
const routes = (url, now) => {
  if (url.includes('digitraffic')) return { body: url.endsWith('/vessels') ? [] : { type: 'FeatureCollection', features: [] } };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 3, serverTime: now() }) };
  if (url.startsWith('/api/vessel?')) return { body: null };
  if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 3, features: features() }) };
};
async function ready(opts = {}) {
  const page = startPage({ routes, manualTime: T0, raf: false, ...opts });
  await until(() => page.markers().size === 3, 'tre navi');
  return page;
}
// scheda della nave mmsi con i dati statici v (meta), aperta come da un clic
function card(page, mmsi, v = {}) {
  page.get(`meta.set(${mmsi}, ${JSON.stringify(v)}); select(${mmsi})`);
  return page.el('content').innerHTML;
}
const cell = (html, key) => new RegExp(`<td>${key}</td><td[^>]*>([^<]*)</td>`).exec(html)?.[1];

// --- Punto 27 --------------------------------------------------------------------------------------------------------
test('pagina: bandiera dall\'MMSI, riga «Tipo di MMSI» per le stazioni e nessuna bandiera per la stazione costiera', async () => {
  const page = await ready();
  let html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Bandiera'), 'Italia');
  assert.equal(cell(html, 'Tipo di MMSI'), undefined, 'nave: nessuna riga sul tipo di MMSI');
  assert.match(html, /<div class="sub" id="sub">Nave cargo · bandiera Italia/);
  assert.match(html, /Barca italiana/, 'registri italiani per le navi con bandiera italiana');
  html = card(page, LIBERIA, { name: 'MONROVIA', shipType: 71, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Bandiera'), 'Liberia');
  assert.doesNotMatch(html, /Barca italiana/);
  html = card(page, COAST, { name: 'GENOVA RADIO', staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Tipo di MMSI'), 'Stazione costiera · Italia');
  assert.equal(cell(html, 'Bandiera'), undefined, 'stazione costiera: nessuna riga «Bandiera»');
  assert.doesNotMatch(html, /bandiera Italia/, 'né «bandiera» nel sottotitolo');
  assert.match(html, /<div class="sub" id="sub">[^<]*Stazione costiera · Italia/);
  assert.doesNotMatch(html, /Barca italiana/, 'una stazione costiera italiana non è una barca italiana');
});

test('pagina: bandiera nei risultati della ricerca con flagOf (nessuna per la stazione costiera)', async () => {
  const page = await ready();
  page.get(`meta.set(${SHIP}, { name: 'LAGUNA PRIMA', shipType: 70 }); meta.set(${COAST}, { name: 'GENOVA RADIO' });
    searchPending = false; searchHits = [{ mmsi: ${SHIP}, props: {} }, { mmsi: ${COAST}, props: {} }]; renderResults()`);
  const html = page.el('results').innerHTML;
  assert.match(html, /<small id="res-247123450-d">Nave cargo · Italia/);
  assert.doesNotMatch(/<small id="res-2470001-d">[^<]*/.exec(html)?.[0] || '', /Italia/);
});

// --- Punto 44 --------------------------------------------------------------------------------------------------------
test('pagina: riga «Stato» con il contrasto fra stato dichiarato e velocità', async () => {
  const page = await ready();
  let html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Stato'), 'Dichiara: ormeggiata · in realtà in moto a 8,0 kn');
  html = card(page, LIBERIA, { name: 'MONROVIA', shipType: 71, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Stato'), 'Dichiara: in navigazione a motore · in realtà ferma (0,1 kn)');
});

// --- Punto 46 --------------------------------------------------------------------------------------------------------
test('pagina: carico pericoloso in scheda (riga «Carico») e nel sottotitolo, in testo', async () => {
  const page = await ready();
  let html = card(page, LIBERIA, { name: 'MONROVIA', shipType: 71, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Carico'), 'pericoloso o inquinante, categoria X (dichiarato)');
  assert.match(html, /<div class="sub" id="sub">[^<]*· ⚠ Carico pericoloso cat\. X<\/div>/);
  html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Carico'), undefined, 'tipo 70: nessuna riga «Carico»');
  assert.doesNotMatch(html, /⚠/);
});

const KEY = 'boatradar:filtri';
const views = page => page.requests.filter(r => r.url.startsWith('/api/locations?bbox='));
test('pagina: casella «Solo carichi pericolosi o inquinanti» salvata, applicata in pagina e chiesta con &hazard=1', async () => {
  const page = await ready();
  page.get(`meta.set(${LIBERIA}, { name: 'MONROVIA', shipType: 71 }); meta.set(${SHIP}, { name: 'LAGUNA PRIMA', shipType: 70 })`);
  page.el('f-hazard').checked = true;
  page.fireEl('legend', 'change', { target: page.el('f-hazard') });
  assert.equal(page.local.get(KEY), 'hazard=1');
  assert.equal(page.el('filter-count').textContent, ' · 1 attivo');
  assert.deepEqual([...page.markers().keys()], [LIBERIA], 'restano solo i carichi pericolosi');
  const n = views(page).length;
  await until(() => views(page).length > n, 'vista con il filtro');
  assert.match(views(page).at(-1).url, /&hazard=1$/);
  page.el('f-hazard').checked = false;
  page.fireEl('legend', 'change', { target: page.el('f-hazard') });
  assert.equal(page.local.has(KEY), false);
});

test('pagina: filtro hazard=1 salvato → casella spuntata e pannello «Filtri» aperto dopo una ricarica', async () => {
  const page = startPage({ routes, manualTime: T0, raf: false, local: { [KEY]: 'hazard=1' } });
  assert.equal(page.el('f-hazard').checked, true);
  assert.equal(page.el('filters').open, true);
  await until(() => views(page).length > 0, 'vista');
  assert.match(views(page).at(-1).url, /&hazard=1$/);
});

// --- Punto 23 --------------------------------------------------------------------------------------------------------
test('pagina: «n.d.» per i valori mancanti, mai «—», anche nel sottotitolo', async () => {
  const page = await ready();
  // stazione senza dati statici: nessuna velocità, rotta, prua, stato, dimensioni
  const html = card(page, COAST, { name: 'GENOVA RADIO' });
  assert.doesNotMatch(html, /—/);
  assert.match(html, /<td>Velocità \/ Rotta<\/td><td>n\.d\.<\/td>/);
  assert.doesNotMatch(page.get(`facts(${COAST})`), /—/, 'neanche nell\'aggiornamento periodico');
  page.get(`markers.get(${SHIP}).props = { mmsi: ${SHIP}, sog: 8, cog: 360, timestampExternal: ${T0 - 1000} }`);
  const ship = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, length: 150, staticTs: T0 - 600000 });
  assert.doesNotMatch(ship, /—/);
  assert.equal(cell(ship, 'Velocità / Rotta'), '8.0 kn / n.d.');
  assert.equal(cell(ship, 'Dimensioni'), '150 × n.d. m');
  // nave con MID 300 (valido, non in tabella) e senza posizione: bandiera e ultimo segnale n.d.
  const unknown = card(page, 300123456, { name: 'SENZA BANDIERA', shipType: 70, staticTs: T0 - 600000 });
  assert.equal(cell(unknown, 'Bandiera'), 'n.d.');
  assert.match(unknown, /<div class="sub" id="sub">Nave cargo · bandiera n\.d\.<\/div>/);
  assert.equal(cell(unknown, 'Ultimo segnale'), 'n.d.', 'nessuna posizione');
});

test('pagina: gruppo «Viaggio (dichiarato dalla nave, 1 h fa)» con prossimo porto, ETA con anno e pescaggio', async () => {
  const page = await ready();
  const html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, destination: 'VENEZIA', draught: 7.4,
    eta: { month: 11, day: 27, hour: 15, minute: 20 }, staticTs: T0 - 3600000 });
  assert.match(html, /<th colspan="2" scope="colgroup">Viaggio \(dichiarato dalla nave, 1 h fa\)<\/th>/);
  assert.equal(cell(html, 'Prossimo porto'), 'VENEZIA');
  assert.equal(cell(html, 'ETA'), '27 nov 2026, 15:20 UTC (tra 5 h 20 min)');
  assert.equal(cell(html, 'Pescaggio'), '7.4 m');
  assert.doesNotMatch(html, /non trasmessi/);
});

test('pagina: senza destinazione, ETA né pescaggio → «Dati di viaggio non trasmessi» solo con i dati statici arrivati', async () => {
  const page = await ready();
  let html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, staticTs: T0 - 3600000 });
  assert.match(html, /Viaggio \(dichiarato dalla nave, 1 h fa\)/);
  assert.match(html, /<td colspan="2" class="wait">Dati di viaggio non trasmessi dalla nave<\/td>/);
  assert.equal(cell(html, 'Prossimo porto'), undefined);
  html = card(page, LIBERIA, { name: 'MONROVIA' });
  assert.doesNotMatch(html, /non trasmessi/, 'dati statici non ancora arrivati');
  assert.doesNotMatch(html, /Viaggio \(/);
  assert.match(html, /non sono ancora arrivati/);
});
