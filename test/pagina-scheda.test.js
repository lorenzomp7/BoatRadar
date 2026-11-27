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
