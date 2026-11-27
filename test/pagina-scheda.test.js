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
// COAST: un peschereccio con l'MMSI programmato male a bordo, nella forma di una stazione costiera (002470001). Il server
// riceve solo messaggi di navi (posizione e dati statici), quindi una «stazione» in mappa è sempre una nave così.
const SHIP = 247123450, COAST = 2470001, LIBERIA = 636000001;
const features = () => [
  ship(SHIP, 44.1, 11.1, { name: 'LAGUNA PRIMA', shipType: 70, sog: 8, cog: 90, navStat: 5 }),
  ship(COAST, 44.2, 11.2, { name: 'MARIA ANNA', shipType: 30, sog: 4.2, cog: 180.5, navStat: 7 }),
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
// testo di una cella come lo legge chi guarda (senza tag; «n.d.» senza il testo per i lettori di schermo)
const visible = h => h.replace(/<span class="sr-only">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '');
const cell = (html, key) => { const m = new RegExp(`<td>${key}</td><td[^>]*>(.*?)</td>`).exec(html); return m ? visible(m[1]) : undefined; };
const sub = html => visible(/<div class="sub" id="sub">(.*?)<\/div>/.exec(html)?.[1] || '');
// «n.d.» per i lettori di schermo: abbreviazione con il testo intero nascosto
const ND_HTML = '<abbr title="non disponibile"><span aria-hidden="true">n.d.</span><span class="sr-only">non disponibile</span></abbr>';

// --- Punto 27 --------------------------------------------------------------------------------------------------------
test('pagina: bandiera dall\'MMSI; MMSI con la forma di una stazione costiera = MMSI anomalo, bandiera dal MID', async () => {
  const page = await ready();
  let html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Bandiera'), 'Italia');
  assert.equal(cell(html, 'Tipo di MMSI'), undefined, 'nave: nessuna riga sul tipo di MMSI');
  assert.equal(sub(html), 'Nave cargo · bandiera Italia');
  assert.match(html, /Barca italiana/, 'registri italiani per le navi con bandiera italiana');
  html = card(page, LIBERIA, { name: 'MONROVIA', shipType: 71, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Bandiera'), 'Liberia');
  assert.doesNotMatch(html, /Barca italiana/);
  // peschereccio italiano con l'MMSI di una stazione costiera: è comunque una nave
  html = card(page, COAST, { name: 'MARIA ANNA', shipType: 30, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Tipo di MMSI'), 'MMSI anomalo per una nave (forma di stazione costiera · Italia)');
  assert.equal(cell(html, 'Bandiera'), 'Italia (dal MID, MMSI anomalo)');
  assert.equal(sub(html), 'Peschereccio · bandiera Italia (dal MID, MMSI anomalo)');
  assert.match(html, /Barca italiana/, 'MID 247: registri italiani disponibili');
  // SAR con MID 247 arrivato come nave: anche qui MMSI anomalo e registri italiani
  html = card(page, 111247001, { name: 'NAVE SAR', shipType: 51, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Tipo di MMSI'), 'MMSI anomalo per una nave (forma di aeromobile SAR · Italia)');
  assert.match(html, /Barca italiana/);
});

test('pagina: AIS-SART senza bandiera né registri italiani, con il tipo di MMSI nel sottotitolo', async () => {
  const page = await ready();
  const html = card(page, 970123456, { name: 'SART ACTIVE', staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Tipo di MMSI'), 'Trasponditore di soccorso (AIS-SART)');
  assert.equal(cell(html, 'Bandiera'), undefined);
  assert.doesNotMatch(html, /Barca italiana/);
  assert.equal(sub(html), 'Altro / sconosciuto · Trasponditore di soccorso (AIS-SART)');
});

test('pagina: bandiera nei risultati della ricerca (dal MID con l\'avviso per l\'MMSI anomalo)', async () => {
  const page = await ready();
  page.get(`meta.set(${SHIP}, { name: 'LAGUNA PRIMA', shipType: 70 }); meta.set(${COAST}, { name: 'MARIA ANNA', shipType: 30 });
    meta.set(970123456, { name: 'SART ACTIVE' });
    searchPending = false; searchHits = [{ mmsi: ${SHIP}, props: {} }, { mmsi: ${COAST}, props: {} }, { mmsi: 970123456, props: {} }];
    renderResults()`);
  const html = page.el('results').innerHTML;
  assert.match(html, /<small id="res-247123450-d">Nave cargo · Italia/);
  assert.match(html, /<small id="res-2470001-d">Peschereccio · Italia \(dal MID, MMSI anomalo\)/);
  assert.doesNotMatch(/<small id="res-970123456-d">[^<]*/.exec(html)?.[0] || '', /Italia/);
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
  assert.match(sub(html), /· ⚠ Carico pericoloso cat\. X$/);
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
test('pagina: «n.d.» per i valori mancanti (abbreviazione letta «non disponibile»), mai «—», anche nel sottotitolo', async () => {
  const page = await ready();
  // nave appena vista senza dati statici né posizione completa: nessuna velocità, rotta, prua, stato, dimensioni
  page.get(`markers.get(${COAST}).props = { mmsi: ${COAST}, timestampExternal: ${T0 - 1000} }`);
  const html = card(page, COAST, { name: 'MARIA ANNA' });
  assert.doesNotMatch(html, /—/);
  assert.ok(html.includes(`<td>Velocità / Rotta</td><td>${ND_HTML}</td>`), 'n.d. come abbreviazione');
  assert.doesNotMatch(page.get(`facts(${COAST})`), /—/, 'neanche nell\'aggiornamento periodico');
  page.get(`markers.get(${SHIP}).props = { mmsi: ${SHIP}, sog: 8, cog: 360, timestampExternal: ${T0 - 1000} }`);
  const ship = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, length: 150, staticTs: T0 - 600000 });
  assert.doesNotMatch(ship, /—/);
  assert.equal(cell(ship, 'Velocità / Rotta'), '8,0 kn / n.d.');
  assert.equal(cell(ship, 'Dimensioni'), '150 m (larghezza n.d.)');
  assert.equal(cell(card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, length: 150, width: 24, staticTs: T0 }), 'Dimensioni'), '150 × 24 m');
  // nave con MID 300 (valido, non in tabella) e senza posizione: bandiera e ultimo segnale n.d.
  const unknown = card(page, 300123456, { name: 'SENZA BANDIERA', shipType: 70, staticTs: T0 - 600000 });
  assert.equal(cell(unknown, 'Bandiera'), 'n.d.');
  assert.ok(unknown.includes(`<div class="sub" id="sub">Nave cargo · bandiera ${ND_HTML}</div>`));
  assert.equal(cell(unknown, 'Ultimo segnale'), 'n.d.', 'nessuna posizione');
});

test('pagina: i dati AIS restano passati da esc() anche accanto a «n.d.»', async () => {
  const page = await ready();
  const html = card(page, LIBERIA, { name: '<b>X</b>', destination: '<img src=x onerror=alert(1)>', shipType: 71, staticTs: T0 });
  assert.doesNotMatch(html, /<img|<b>X/);
  assert.equal(cell(html, 'Prossimo porto'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('pagina: decimali con la virgola in tutta la scheda (velocità, rotta, pescaggio)', async () => {
  const page = await ready();
  page.get(`markers.get(${COAST}).props = { mmsi: ${COAST}, sog: 4.2, cog: 180.5, heading: 181, navStat: 7, timestampExternal: ${T0 - 1000} }`);
  const html = card(page, COAST, { name: 'MARIA ANNA', shipType: 30, draught: 3.4, staticTs: T0 });
  assert.equal(cell(html, 'Velocità / Rotta'), '4,2 kn / 180,5°');
  assert.equal(cell(html, 'Pescaggio'), '3,4 m');
  assert.doesNotMatch(visible(table(html)), /\d\.\d/, 'nessun punto decimale nella tabella della scheda');
});

// gruppi della tabella: [titolo, righe] di ogni <tbody> nell'ordine della pagina
const table = html => html.slice(html.indexOf('<table'), html.indexOf('</table>'));
const groups = html => [...visible(html.replace(/<\/(td|th)>/g, '|').replace(/<tbody>/g, '§')).split('§').slice(1)]
  .map(b => b.split('|').map(x => x.trim()).filter(Boolean));
test('pagina: gruppi in <tbody> con <th scope="rowgroup">: Viaggio subito dopo il nominativo, poi Movimento', async () => {
  const page = await ready();
  const html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, destination: 'VENEZIA', draught: 7.4, callSign: 'IABC',
    eta: { month: 11, day: 27, hour: 15, minute: 20 }, staticTs: T0 - 3600000, length: 150, width: 24 });
  assert.doesNotMatch(html, /colgroup/);
  assert.match(html, /<tbody><tr class="group"><th colspan="2" scope="rowgroup">Viaggio \(dichiarato dalla nave, 1 h fa\)<\/th><\/tr>/);
  assert.match(html, /<tbody><tr class="group"><th colspan="2" scope="rowgroup">Movimento<\/th><\/tr>/);
  const g = groups(table(html));
  assert.equal(g.length, 3);
  const keys = b => b.filter((_, i) => i % 2 === 0);
  assert.deepEqual(keys(g[0]), ['Tipo', 'Dimensioni', 'Bandiera', 'IMO', 'MMSI', 'Nominativo'], 'prima: chi è');
  assert.deepEqual(keys(g[1].slice(1)), ['Prossimo porto', 'ETA', 'Pescaggio']);
  assert.equal(g[1][0], 'Viaggio (dichiarato dalla nave, 1 h fa)');
  assert.equal(g[2][0], 'Movimento');
  assert.deepEqual(keys(g[2].slice(1)), ['Velocità / Rotta', 'Prua', 'Stato', 'Posizione', 'Ultimo segnale', 'Fonte']);
  // con carico pericoloso la riga «Carico» è nel gruppo «Viaggio»
  const hz = card(page, LIBERIA, { name: 'MONROVIA', shipType: 71, destination: 'GENOVA', staticTs: T0 });
  const gh = groups(table(hz));
  assert.ok(keys(gh[1].slice(1)).includes('Carico'), 'Carico nel gruppo Viaggio');
  assert.ok(!keys(gh[2].slice(1)).includes('Carico'));
});

test('pagina: gruppo «Viaggio (dichiarato dalla nave, 1 h fa)» con prossimo porto, ETA con anno e pescaggio', async () => {
  const page = await ready();
  const html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, destination: 'VENEZIA', draught: 7.4,
    eta: { month: 11, day: 27, hour: 15, minute: 20 }, staticTs: T0 - 3600000 });
  assert.equal(cell(html, 'Prossimo porto'), 'VENEZIA');
  assert.equal(cell(html, 'ETA'), '27 nov 2026, 15:20 UTC (tra 5 h 20 min)');
  assert.equal(cell(html, 'Pescaggio'), '7,4 m');
  assert.doesNotMatch(html, /non trasmessi/);
  // ETA di 40 giorni fa: passata, non fra 11 mesi
  const old = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, destination: 'VENEZIA',
    eta: { month: 10, day: 17, hour: 12, minute: 0 }, staticTs: T0 - 3600000 });
  assert.equal(cell(old, 'ETA'), '17 ott 2026, 12:00 UTC (già passata (40 giorni fa): forse non aggiornata)');
});

test('pagina: senza destinazione, ETA né pescaggio → «Dati di viaggio non trasmessi» solo con i dati statici arrivati', async () => {
  const page = await ready();
  let html = card(page, SHIP, { name: 'LAGUNA PRIMA', shipType: 70, staticTs: T0 - 3600000, aisClass: 'A' });
  assert.match(html, /Viaggio \(dichiarato dalla nave, 1 h fa\)/);
  assert.match(html, /<td colspan="2" class="wait">Dati di viaggio non trasmessi dalla nave<\/td>/);
  assert.equal(cell(html, 'Prossimo porto'), undefined);
  html = card(page, LIBERIA, { name: 'MONROVIA' });
  assert.doesNotMatch(html, /non trasmessi/, 'dati statici non ancora arrivati');
  assert.doesNotMatch(html, /Viaggio \(/);
  assert.match(html, /non sono ancora arrivati/);
});

test('pagina: nave di classe B → «(le navi di classe B non li trasmettono)»', async () => {
  const page = await ready();
  const html = card(page, COAST, { name: 'MARIA ANNA', shipType: 37, staticTs: T0 - 3600000, aisClass: 'B' });
  assert.match(html, /<td colspan="2" class="wait">Dati di viaggio non trasmessi dalla nave \(le navi di classe B non li trasmettono\)<\/td>/);
});

// --- Punto 46 bis: il sottotitolo si rifà quando il tipo arriva dopo -------------------------------------------------
test('pagina: «⚠ Carico pericoloso» nel sottotitolo anche per una nave senza IMO il cui tipo arriva a scheda aperta', async () => {
  const page = await ready();
  let html = card(page, LIBERIA, { name: 'MONROVIA' });
  assert.doesNotMatch(html, /⚠/);
  // nel browser dataset.mmsi è una stringa (nel finto DOM resta il numero): così render() prende la via
  // dell'aggiornamento periodico, che rifà solo la tabella se i dati del sottotitolo non sono cambiati
  const browserLike = `document.getElementById('content').dataset.mmsi = '${LIBERIA}'`;
  page.get(`${browserLike}; meta.set(${LIBERIA}, { ...meta.get(${LIBERIA}), shipType: 71, staticTs: ${T0} }); render(${LIBERIA})`);
  html = page.el('content').innerHTML;
  assert.equal(sub(html), 'Nave cargo · bandiera Liberia · ⚠ Carico pericoloso cat. X');
  assert.match(html, /<h2>MONROVIA<\/h2>/);
  // stesso tipo: aggiornamento periodico, solo la tabella
  page.get(`${browserLike}; document.getElementById('content').innerHTML += '<!--prova-->'; render(${LIBERIA})`);
  assert.match(page.el('content').innerHTML, /<!--prova-->$/, 'scheda non rifatta');
});
