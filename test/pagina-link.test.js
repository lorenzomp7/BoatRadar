// Punto 25: link condivisibili nella pagina (boatradar.html) senza browser (test/pagina-helpers.js con href, nav e
// trackView). Formato ?mmsi=…&segui=1#lat,lon,zoom: la vista iniziale viene dal link; con un MMSI la scheda si apre
// prima del primo giro (la nave arriva già con include=) e, se il link non ha una vista, la mappa va sulla nave; l'indirizzo
// si aggiorna (history.replaceState, rallentato) spostando la mappa, scegliendo una nave e chiudendo la scheda; «Condividi»
// usa navigator.share su telefono, altrimenti copia il link. Il controllo nel browser vero è in tools/smoke-browser.sh.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until, sleep } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const ship = (mmsi, lat, lon, props) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, ...props } });
const ALFA = 247000002, BRAVO = 247000001;
const ships = now => [
  ship(BRAVO, 44.001, 10.998, { name: 'BRAVO', shipType: 70, sog: 12.3, timestampExternal: now() - 60000 }),
  ship(ALFA, 43.997, 10.998, { name: 'ALFA', shipType: 80, sog: 3, timestampExternal: now() - 1000 }),
];
// include=: solo le navi chieste (come il server); /api/vessel con i dati statici di ALFA
const routes = (list = ships) => (url, now) => {
  if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 2, serverTime: now() }) };
  if (url.startsWith('/api/vessel?')) return { body: { mmsi: ALFA, name: 'ALFA', imo: 9000001, callSign: 'IABC', staticTs: now() } };
  if (url.startsWith('/api/locations?include=')) {
    const ids = url.split('=')[1].split(',').map(Number);
    return { body: () => ({ type: 'FeatureCollection', total: 0, features: list(now).filter(f => ids.includes(f.mmsi)) }) };
  }
  if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: list(now).length, features: list(now) }) };
};
const BASE = 'https://lorenzo.example/boatradar/';
const PHONE = { media: { '(max-width: 640px)': true, '(pointer: coarse)': true }, size: { x: 390, y: 844 }, viewport: { w: 390, h: 844 },
  rects: { header: { left: 56, top: 8, right: 382, bottom: 96 }, map: { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 } } };
const panelOpen = page => page.el('panel').style.display === 'block';
const ready = page => until(() => page.markers().size > 0 && /in mappa/.test(page.status()), 'primo giro');

test('vista iniziale dal link #lat,lon,zoom; senza link la vista di sempre', async () => {
  const page = startPage({ routes: routes(), href: BASE + '#45.4312,12.3355,14' });
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.views[0])), [[45.4312, 12.3355], 14]);
  const plain = startPage({ routes: routes() });
  assert.deepEqual(JSON.parse(JSON.stringify(plain.map.views[0])), [[30, 10], 3]);
  const bad = startPage({ routes: routes(), href: BASE + '#abc' });
  assert.deepEqual(JSON.parse(JSON.stringify(bad.map.views[0])), [[30, 10], 3], 'vista non valida: quella di sempre');
  await Promise.all([ready(page), ready(plain), ready(bad)]);
});

test('?mmsi=: scheda aperta prima del primo giro, la nave già nel primo giro con include=, dati statici da /api/vessel', async () => {
  const page = startPage({ routes: routes(), href: BASE + '?mmsi=' + ALFA });
  await ready(page);
  assert.equal(page.get('selected'), ALFA);
  assert.ok(panelOpen(page));
  const locs = page.requests.filter(r => r.url.startsWith('/api/locations?'));
  assert.deepEqual(locs.map(r => r.url.split('=')[0]), ['/api/locations?bbox', '/api/locations?include'],
    'un solo giro (nessun giro in più dopo select) con vista e include=');
  assert.equal(locs[1].url, '/api/locations?include=' + ALFA);
  assert.ok(page.requests.some(r => r.url === '/api/vessel?mmsi=' + ALFA), 'dati statici');
  await until(() => /IABC/.test(page.el('content').innerHTML), 'scheda con il nominativo');
  await sleep(80);   // 800 ms della pagina: nessun giro in più programmato da select
  assert.equal(page.requests.filter(r => r.url.startsWith('/api/locations?bbox')).length, 2,
    'dopo la centratura sulla nave un solo giro per la vista nuova');
});

test('?mmsi= senza vista: mappa sulla nave a zoom almeno 11, senza animazione; con la vista del link la mappa resta lì', async () => {
  const page = startPage({ routes: routes(), href: BASE + '?mmsi=' + ALFA, zoom: 6 });
  await until(() => page.map.views.length === 2, 'setView sulla nave');
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.views[1])), [{ lat: 43.997, lng: 10.998 }, 11, { animate: false }]);
  const far = startPage({ routes: routes(), href: BASE + '?mmsi=' + ALFA, zoom: 14 });
  await until(() => far.map.views.length === 2, 'setView sulla nave');
  assert.equal(far.map.views[1][1], 14, 'zoom già maggiore: resta');
  const kept = startPage({ routes: routes(), href: BASE + '?mmsi=' + ALFA + '#44,11,9' });
  await ready(kept);
  await sleep(50);
  assert.equal(kept.map.views.length, 1, 'il link aveva una vista: la mappa resta lì');
  assert.equal(kept.get('selected'), ALFA);
  // telefono: con la vista del link la nave sotto la scheda aperta a metà sale fra header e scheda (spostamento minimo)
  const phone = startPage({ ...PHONE, routes: routes(), href: BASE + '?mmsi=' + ALFA + '#44,11,9' });
  await until(() => phone.map.pans.length > 0, 'spostamento minimo');
  assert.equal(phone.map.views.length, 1);
  // ALFA in 300, 700 (proiezione della mappa finta); banda libera fino a 844 − 422 − 24 = 398 → 302 px in su
  assert.equal(JSON.stringify(phone.map.pans.at(-1)[0]), '[0,302]');
});

test('nave del link senza posizione recente: avviso e scheda con i dati noti', async () => {
  const page = startPage({ routes: routes(now => ships(now).filter(f => f.mmsi !== ALFA)), href: BASE + '?mmsi=' + ALFA });
  await until(() => page.el('toast').style.display === 'block', 'avviso');
  assert.match(page.el('toast').innerHTML, /nessuna posizione recente/i);
  assert.match(page.el('toast').innerHTML, new RegExp(String(ALFA)));
  assert.ok(panelOpen(page), 'la scheda resta aperta');
  await until(() => /IABC/.test(page.el('content').innerHTML), 'dati statici in scheda');
  assert.equal(page.map.views.length, 1, 'nessuno spostamento della mappa');
});

test('indirizzo aggiornato spostando la mappa (rallentato: 300 ms, con la chiamata finale)', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true });
  await ready(page);
  assert.deepEqual(page.urls, [], 'nessuna scrittura senza spostamenti');
  page.setZoom(8);
  for (let i = 0; i < 10; i++) {
    page.setCenter({ lat: 45 + i / 1000, lng: 12.5 });
    page.map.fire('moveend');
  }
  await until(() => page.urls.length > 0, 'replaceState');
  await sleep(60);
  assert.equal(page.urls.length, 1, `una sola scrittura per 10 moveend ravvicinati: ${page.urls}`);
  assert.equal(page.urls.at(-1), '/boatradar/#45.009,12.5,8', 'la vista dell\'ultimo moveend');
  assert.equal(page.location.hash, '#45.009,12.5,8');
  assert.equal(page.history.state, null, 'history.state conservato');
  page.setZoom(12);
  page.map.fire('moveend');
  await until(() => page.urls.length === 2, 'seconda scrittura');
  assert.equal(page.urls.at(-1), '/boatradar/#45.009,12.5,12');
});

test('indirizzo con ?mmsi= scegliendo una nave, ripulito chiudendo la scheda; i registri non hanno MMSI', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true });
  await ready(page);
  page.get(`select(${BRAVO})`);
  await until(() => page.urls.length === 1, 'replaceState dopo select');
  assert.equal(page.urls[0], `/boatradar/?mmsi=${BRAVO}#30,10,3`);
  page.el('close').onclick();
  await until(() => page.urls.length === 2, 'replaceState dopo la chiusura');
  assert.equal(page.urls[1], '/boatradar/#30,10,3');
  page.get(`select(${ALFA})`);
  await until(() => page.urls.length === 3, 'replaceState');
  page.el('registries').onclick();
  await until(() => page.urls.length === 4, 'replaceState dopo i registri');
  assert.equal(page.urls[3], '/boatradar/#30,10,3');
});

test('replaceState che lancia (Safari: oltre 100 chiamate in 30 s): nessun errore, la pagina va avanti', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true });
  await ready(page);
  page.history.replaceState = () => { throw new Error('SecurityError: Attempt to use history.replaceState() more than 100 times'); };
  page.map.fire('moveend');
  page.get(`select(${BRAVO})`);
  await sleep(60);
  assert.ok(panelOpen(page));
  await page.tick();
  assert.match(page.status(), /in mappa/);
});

test('hashchange (indirizzo cambiato a mano) → setView sulla vista nuova', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true });
  await ready(page);
  page.location.hash = '#40.5,14.25,10';
  page.fire('hashchange');
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.views.at(-1))), [[40.5, 14.25], 10]);
  page.location.hash = '#abc';
  page.fire('hashchange');
  assert.equal(page.map.views.length, 2, 'vista non valida: niente');
});

test('senza location né history (contesti di test, browser particolari): nessun errore', async () => {
  const page = startPage({ routes: routes() });
  await ready(page);
  page.map.fire('moveend');
  page.get(`select(${BRAVO})`);
  page.el('close').onclick();
  page.fire('hashchange');
  await sleep(60);
  assert.match(page.status(), /in mappa/);
});

test('«Condividi» su telefono: navigator.share con il link intero; annullato senza avviso', async () => {
  const shared = [];
  let cancel = false;
  const share = async data => { shared.push(data); if (cancel) throw Object.assign(new Error('Share canceled'), { name: 'AbortError' }); };
  const page = startPage({ ...PHONE, routes: routes(), href: BASE, trackView: true, nav: { share, clipboard: { writeText: async () => assert.fail('niente copia') } } });
  await ready(page);
  page.get(`select(${ALFA})`);
  page.fireEl('share', 'click');
  await until(() => shared.length === 1, 'share');
  assert.equal(shared[0].url, `${BASE}?mmsi=${ALFA}#30,10,3`);
  assert.equal(shared[0].title, 'ALFA · BoatRadar');
  cancel = true;
  page.fireEl('share', 'click');
  await until(() => shared.length === 2, 'secondo share');
  await sleep(20);
  assert.notEqual(page.el('toast').style.display, 'block', 'annullato: nessun avviso');
});

test('«Condividi» su computer: copia il link e avvisa; senza clipboard avviso con il link selezionabile', async () => {
  const copied = [];
  const page = startPage({ routes: routes(), href: BASE, trackView: true,
    nav: { share: async () => assert.fail('su computer niente share'), clipboard: { writeText: async t => { copied.push(t); } } } });
  await ready(page);
  page.get(`select(${BRAVO})`);
  page.fireEl('share', 'click');
  await until(() => copied.length === 1, 'copia');
  assert.equal(copied[0], `${BASE}?mmsi=${BRAVO}#30,10,3`);
  await until(() => page.el('toast').style.display === 'block', 'avviso');
  assert.match(page.el('toast').innerHTML, /Link copiato/);
  // senza clipboard (o se la copia fallisce): il link in un campo di sola lettura da selezionare
  const bare = startPage({ routes: routes(), href: BASE, trackView: true, nav: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } } });
  await ready(bare);
  bare.get(`select(${BRAVO})`);
  bare.fireEl('share', 'click');
  await until(() => bare.el('toast').style.display === 'block', 'avviso con il link');
  assert.match(bare.el('toast').innerHTML, new RegExp(`<input id="share-url" readonly aria-label="Link da copiare" value="${BASE.replace(/\./g, '\\.')}\\?mmsi=${BRAVO}#30,10,3">`));
});

test('pulsanti della scheda in #panel-actions dopo il titolo (#panel-head) e fuori da #content, nascosti nei registri', async () => {
  const page = startPage({ routes: routes(), href: BASE });
  await ready(page);
  page.get(`select(${BRAVO})`);
  assert.equal(page.el('panel-actions').hidden, false);
  assert.match(page.el('panel-head').innerHTML, /^<h2>BRAVO<\/h2>\s*<div class="sub" id="sub">/);
  assert.doesNotMatch(page.el('content').innerHTML, /<h2>/, 'il titolo non è più in #content');
  page.el('registries').onclick();
  assert.equal(page.el('panel-actions').hidden, true);
  assert.match(page.el('panel-head').innerHTML, /^<h2>Registri<\/h2>/);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'boatradar.html'), 'utf8');
  // ordine nel DOM: × (prima, sempre libera), titolo e sottotitolo, pulsanti, dati
  assert.match(html, /<button id="close"[^>]*>×<\/button><div id="panel-head"><\/div><div id="panel-actions" role="group" aria-label="Azioni sulla nave" hidden>[\s\S]*?<button type="button" id="share" class="pbtn">[\s\S]*?<\/div><div id="content"><\/div><\/aside>/);
  assert.match(html, /#panel-actions \.pbtn \{[^}]*min-height:44px/, 'pulsanti da almeno 44 px');
});

test('longitudine enorme nel link (#10,<400 cifre 9>,5): vista di sempre, la pagina parte; hashchange così non lancia', async () => {
  const huge = '#10,' + '9'.repeat(400) + ',5';
  const page = startPage({ routes: routes(), href: BASE + huge, trackView: true });
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.views[0])), [[30, 10], 3]);
  await ready(page);
  const n = page.map.views.length;
  for (const h of [huge, '#' + '9'.repeat(400) + ',10,5', '#10,10,' + '9'.repeat(400), '#10,-' + '9'.repeat(400) + ',5']) {
    page.location.hash = h;
    page.fire('hashchange');
  }
  assert.equal(page.map.views.length, n, 'nessun setView');
  assert.ok(page.map.views.every(v => Number.isFinite(v[0][0] ?? v[0].lat) && Number.isFinite(v[0][1] ?? v[0].lng)), 'mai coordinate non finite');
});

test('hashchange: un setView che lancia non esce dal gestore', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true });
  await ready(page);
  page.map.setView = () => { throw new Error('Invalid LatLng object'); };
  page.location.hash = '#40.5,14.25,10';
  assert.doesNotThrow(() => page.fire('hashchange'));
});

test('link con il primo giro fallito (vista e include= in errore): nessun avviso sbagliato, la mappa si centra al giro dopo', async () => {
  let fail = true;
  const base = routes();
  const page = startPage({ routes: (url, now) => (fail && url.startsWith('/api/locations?') ? { status: 503 } : base(url, now)),
    href: BASE + '?mmsi=' + ALFA, zoom: 6 });
  await until(() => page.requests.some(r => r.url.startsWith('/api/locations?include') && r.outcome === 503), 'primo giro fallito');
  await sleep(30);
  assert.notEqual(page.el('toast').style.display, 'block', 'nessun avviso dopo un giro fallito');
  assert.equal(page.map.views.length, 1);
  assert.equal(page.get('linkPending?.mmsi'), ALFA, 'link in sospeso');
  fail = false;   // il tentativo programmato dopo l'errore (backends.retryIn) trova la nave
  await until(() => page.map.views.length === 2, 'mappa sulla nave al giro riuscito', 8000);
  assert.deepEqual(JSON.parse(JSON.stringify(page.map.views[1])), [{ lat: 43.997, lng: 10.998 }, 11, { animate: false }]);
  assert.equal(page.get('linkPending'), null);
  assert.notEqual(page.el('toast').style.display, 'block');
});

test('link con include= fallito ma vista riuscita: nessun avviso finché un giro con entrambe non va a buon fine', async () => {
  let failInc = true;
  const list = now => ships(now).filter(f => f.mmsi !== ALFA);
  const base = routes(list);
  const page = startPage({ routes: (url, now) => (failInc && url.startsWith('/api/locations?include') ? { fail: true } : base(url, now)),
    href: BASE + '?mmsi=' + ALFA });
  await ready(page);
  await sleep(30);
  assert.notEqual(page.el('toast').style.display, 'block');
  failInc = false;
  await page.tick();
  await until(() => page.el('toast').style.display === 'block', 'avviso dopo il giro riuscito');
  assert.match(page.el('toast').innerHTML, /nessuna posizione recente/i);
});

test('link verso un MMSI che non c\'è: dopo 3 giri riusciti senza la nave niente più include= né /api/vessel; sceglierla di nuovo sì', async () => {
  const list = now => ships(now).filter(f => f.mmsi !== ALFA);
  const base = routes(list);
  const page = startPage({ routes: (url, now) => (url.startsWith('/api/vessel?') ? { body: null } : base(url, now)), href: BASE + '?mmsi=' + ALFA });
  await ready(page);
  await page.tick();
  await page.tick();
  assert.equal(page.get('linkDead'), ALFA);
  const count = () => [page.requests.filter(r => r.url.startsWith('/api/locations?include')).length,
    page.requests.filter(r => r.url.startsWith('/api/vessel?')).length];
  const [inc, ves] = count();
  assert.equal(inc, 3);
  await page.tick();
  await page.tick();
  assert.deepEqual(count(), [inc, ves], 'nessuna richiesta in più per la nave del link');
  assert.equal(page.get('selected'), ALFA, 'la scheda resta con i dati noti');
  assert.equal((page.el('toast').html.match(/nessuna posizione recente/gi) || []).length, 1);
  // l'utente la sceglie (per esempio dalla ricerca): si chiede di nuovo
  page.get(`select(${ALFA})`);
  await page.tick();
  assert.ok(count()[0] > inc && count()[1] > ves, 'scelta dall\'utente: include= e /api/vessel di nuovo');
});

test('replaceState che lancia una volta: si riprova da solo dopo 1,5 s, senza altri spostamenti', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true });
  await ready(page);
  const real = page.history.replaceState.bind(page.history);
  let throws = 1;
  page.history.replaceState = (...a) => { if (throws-- > 0) throw new Error('SecurityError'); return real(...a); };
  page.setCenter({ lat: 45, lng: 12.5 }); page.setZoom(8);
  page.map.fire('moveend');
  await sleep(60);
  assert.equal(page.urls.length, 0, 'prima scrittura fallita');
  await until(() => page.urls.length === 1, 'nuovo tentativo', 3000);
  assert.equal(page.urls[0], '/boatradar/#45,12.5,8');
});

test('«Condividi» senza appunti: il campo con il link resta finché ha il focus, Esc lo chiude e il focus torna su «Condividi»; setSelectionRange per iOS', async () => {
  const page = startPage({ routes: routes(), href: BASE, trackView: true, nav: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } } });
  await ready(page);
  const ranges = [];
  page.el('share-url').setSelectionRange = (a, b) => ranges.push([a, b]);
  page.el('share-url').parentEl = page.el('toast');   // il campo è dentro l'avviso
  page.get(`select(${BRAVO})`);
  page.fireEl('share', 'click');
  await until(() => page.el('toast').style.display === 'block', 'avviso con il link');
  const url = `${BASE}?mmsi=${BRAVO}#30,10,3`;
  assert.deepEqual(ranges, [[0, url.length]]);
  assert.equal(page.document.activeElement, page.el('share-url'));
  await sleep(1700);   // oltre i 15 s della pagina
  assert.equal(page.el('toast').style.display, 'block', 'focus nel campo: l\'avviso resta');
  const e = page.keydown('Escape');
  assert.ok(e.defaultPrevented && e.stopped, 'Esc usato dall\'avviso, non dalla scheda');
  assert.equal(page.el('toast').style.display, 'none');
  assert.equal(page.document.activeElement, page.el('share'), 'focus su «Condividi»');
  assert.ok(panelOpen(page), 'la scheda resta aperta');
  // senza focus dentro l'avviso si chiude da solo dopo 15 s
  page.fireEl('share', 'click');
  await until(() => page.el('toast').style.display === 'block', 'avviso');
  page.el('q').focus();
  await until(() => page.el('toast').style.display === 'none', 'chiuso dopo 15 s', 3000);
});

test('avvisi annunciati da #toast-live (sr-only, role="status", sempre presente); #toast senza role', async () => {
  const page = startPage({ routes: routes(), href: BASE, nav: { clipboard: { writeText: async () => {} } } });
  await ready(page);
  page.get(`select(${BRAVO})`);
  page.fireEl('share', 'click');
  await until(() => page.el('toast-live').textContent === 'Link copiato', 'annuncio');
  page.get(`toast('Nessuna posizione recente per la nave con MMSI <b>1</b>: la scheda mostra i dati noti.')`);
  await until(() => page.el('toast-live').textContent === 'Nessuna posizione recente per la nave con MMSI 1: la scheda mostra i dati noti.', 'testo senza tag');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'boatradar.html'), 'utf8');
  assert.match(html, /<div id="toast"><\/div>\s*<div id="toast-live" class="sr-only" role="status" aria-live="polite"><\/div>/);
});
