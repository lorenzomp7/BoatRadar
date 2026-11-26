// Punto 9 (b): filtri nella pagina (boatradar.html), senza browser (test/pagina-helpers.js). Legenda con un pulsante per
// tipo (aria-pressed), pannello «Filtri» (movimento, velocità, «ricevute negli ultimi», stato di navigazione, «Mostra
// tutte»), scelte in localStorage['boatradar:filtri'] come filterKey. Il filtro vale in pagina su tutte le fonti unite
// (anche il Baltico) e va al server solo se attivo; la nave selezionata resta sempre; nessun tipo acceso → niente vista
// né Baltico. La verifica nel browser vero è il passo «filtri» di tools/smoke-browser.sh.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until, sleep } = require('./pagina-helpers');

const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const KEY = 'boatradar:filtri';
const ship = (mmsi, lat, lon, props) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { mmsi, ...props } });
// server: un cargo in moto, una petroliera ormeggiata, una nave senza tipo né velocità; il server finto ignora i filtri
// (come uno vecchio, o una risposta col filtro di prima): la pagina li applica comunque
const world = now => [
  ship(247000001, 44.1, 11.1, { name: 'CARGO MONDO', shipType: 70, sog: 12, cog: 90, navStat: 0, timestampExternal: now() - 1000 }),
  ship(247000002, 44.2, 11.2, { name: 'PETROLIERA', shipType: 80, sog: 0, navStat: 5, timestampExternal: now() - 1000 }),
  ship(247000003, 44.3, 11.3, { name: 'SENZA TIPO', timestampExternal: now() - 1000 }),
];
// Baltico (Digitraffic): un cargo e una petroliera, con il tipo dai dati statici (/vessels)
const balticVessels = [{ mmsi: 230000001, name: 'BALTIC CARGO', shipType: 70 }, { mmsi: 230000002, name: 'BALTIC TANKER', shipType: 80 }];
const baltic = now => [
  ship(230000001, 60.1, 24.9, { sog: 8, cog: 10, navStat: 0, timestampExternal: now() - 1000 }),
  ship(230000002, 60.2, 25.0, { sog: 6, cog: 20, navStat: 0, timestampExternal: now() - 1000 }),
];
const routes = (url, now) => {
  if (url.endsWith('/vessels')) return { body: balticVessels };
  if (url.includes('digitraffic')) return { body: () => ({ type: 'FeatureCollection', features: baltic(now) }) };
  if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 3, serverTime: now() }) };
  if (url.startsWith('/api/locations?include=')) {
    const ids = url.split('include=')[1].split('&')[0].split(',').map(Number);
    return { body: () => ({ type: 'FeatureCollection', total: ids.length, features: world(now).filter(f => ids.includes(f.mmsi)) }) };
  }
  if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 3, features: world(now) }) };
};

const views = page => page.requests.filter(r => r.url.startsWith('/api/locations?bbox='));
const balticReqs = page => page.requests.filter(r => r.url.includes('digitraffic') && r.url.includes('/locations'));
const has = (page, mmsi) => page.markers().has(mmsi);
// clic su un pulsante della legenda (delegato su #legend) e cambio di un controllo del pannello
const clickType = (page, type) => page.fireEl('legend', 'click',
  { target: { closest: sel => (sel === '[data-type]' ? { dataset: { type } } : null) } });
const clickReset = page => page.fireEl('legend', 'click', { target: { closest: sel => (sel === '#f-reset' ? { id: 'f-reset' } : null) } });
const change = (page, target) => page.fireEl('legend', 'change', { target });

test('pagina: nessun filtro salvato → vista senza parametri di filtro, tutte le navi (anche del Baltico), conteggio vuoto', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  assert.match(views(page).at(-1).url, /^\/api\/locations\?bbox=[-\d.,]+$/, 'nessun parametro di filtro');
  assert.equal(page.el('filter-count').textContent, '');
  assert.doesNotMatch(page.status(), /filtri attivi/);
  for (const t of ['cargo', 'tanker', 'other']) assert.equal(page.el('lt-' + t).attributes['aria-pressed'], 'true', t);
});

test('pagina: filtro salvato types=tanker → vista con &types=tanker, solo le petroliere (anche del Baltico), stato e conteggio', async () => {
  const page = startPage({ routes, local: { [KEY]: 'types=tanker' } });
  await until(() => has(page, 247000002) && has(page, 230000002), 'le due petroliere');
  await sleep(30);
  assert.ok(views(page).every(r => r.url.endsWith('&types=tanker')), views(page).map(r => r.url).join(' '));
  assert.equal(has(page, 247000001), false, 'cargo del server tolto dalla pagina');
  assert.equal(has(page, 230000001), false, 'cargo del Baltico non diventa marker');
  assert.equal(has(page, 247000003), false, 'nave senza tipo (Altro) esclusa');
  assert.equal(page.el('lt-cargo').attributes['aria-pressed'], 'false');
  assert.equal(page.el('lt-tanker').attributes['aria-pressed'], 'true');
  assert.equal(page.el('filter-count').textContent, ' · 1 attivo');
  assert.match(page.status(), /^2 in mappa · filtri attivi · agg\./);
});

test('pagina: clic su «Cargo» nella legenda → localStorage aggiornato, marker tolti subito (tranne la nave selezionata), vista nuova', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  page.get('select(247000001)');   // cargo selezionato: resta in mappa anche spento
  const before = views(page).length;
  clickType(page, 'cargo');
  assert.equal(page.local.get(KEY), 'types=tanker,passenger,fishing,pleasure,service,other');
  assert.equal(page.el('lt-cargo').attributes['aria-pressed'], 'false');
  assert.equal(has(page, 230000001), false, 'cargo del Baltico tolto subito');
  assert.equal(has(page, 247000001), true, 'la nave selezionata resta');
  assert.equal(page.el('filter-count').textContent, ' · 1 attivo');
  assert.match(page.status(), /^4 in mappa · filtri attivi · agg\./, 'riga di stato aggiornata subito, senza aspettare il giro');
  // giro dopo il debounce: la vista porta il filtro, la nave selezionata (include=) resta
  await until(() => views(page).length > before, 'nuova richiesta della vista');
  assert.match(views(page).at(-1).url, /&types=tanker,passenger,fishing,pleasure,service,other$/);
  await sleep(30);
  assert.equal(has(page, 247000001), true, 'selezionata ancora in mappa dopo il giro');
  assert.equal(has(page, 230000001), false);
  // secondo clic: tutto di nuovo, niente in localStorage, vista senza filtro
  clickType(page, 'cargo');
  assert.equal(page.local.has(KEY), false);
  const n = views(page).length;
  await until(() => views(page).length > n && page.markers().size === 5, 'vista senza filtro e cinque navi');
  assert.match(views(page).at(-1).url, /^\/api\/locations\?bbox=[-\d.,]+$/);
});

test('pagina: nessun tipo acceso → nessuna richiesta della vista né del Baltico (include= sì), stato lo dice', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  page.get('select(247000002); document.getElementById("panel").style.display = "block"');
  for (const t of ['cargo', 'tanker', 'passenger', 'fishing', 'pleasure', 'service', 'other']) clickType(page, t);
  assert.equal(page.local.get(KEY), 'types=');
  assert.equal(page.el('filter-count').textContent, ' · 1 attivo');
  assert.deepEqual([...page.markers().keys()], [247000002], 'resta solo la selezionata');
  await sleep(60);   // il giro del debounce è passato
  const v = views(page).length, b = balticReqs(page).length, inc = page.requests.filter(r => r.url.includes('include=')).length;
  await page.tick();
  assert.equal(views(page).length, v, 'nessuna vista');
  assert.equal(balticReqs(page).length, b, 'nessun Baltico');
  assert.ok(page.requests.filter(r => r.url.includes('include=')).length > inc, 'include= della nave selezionata');
  assert.match(page.status(), /nessun tipo di nave selezionato nei filtri/);
  // ricaricando resta così
  const again = startPage({ routes, local: { [KEY]: 'types=' } });
  await again.waitStatus(/nessun tipo di nave selezionato/);
  assert.equal(views(again).length, 0);
  assert.equal(balticReqs(again).length, 0);
  assert.equal(again.el('lt-cargo').attributes['aria-pressed'], 'false');
});

test('pagina: pannello Filtri → velocità, movimento, ricevute negli ultimi e stato in localStorage e nella vista; «Mostra tutte» azzera', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  change(page, { id: 'f-min', value: '5' });
  assert.equal(page.local.get(KEY), 'minSog=5');
  assert.equal(has(page, 247000002), false, 'ferma (0 kn) tolta');
  assert.equal(has(page, 247000003), false, 'velocità non nota tolta');
  assert.equal(has(page, 247000001), true);
  change(page, { id: 'f-max', value: '10' });
  assert.equal(page.local.get(KEY), 'minSog=5&maxSog=10');
  assert.equal(has(page, 247000001), false, '12 kn oltre il massimo');
  assert.equal(page.el('filter-count').textContent, ' · 1 attivo', 'velocità da e a contano una volta');
  change(page, { id: 'f-max', value: '' });
  change(page, { id: 'f-min', value: '0' });
  assert.equal(page.local.has(KEY), false);
  await until(() => page.markers().size === 5, 'di nuovo cinque navi al giro dopo');
  change(page, { name: 'f-moving', value: '1' });
  assert.equal(page.local.get(KEY), 'moving=1');
  assert.equal(has(page, 247000003), true, 'in moto = non ferma: velocità non nota resta');
  assert.equal(has(page, 247000002), false, 'ormeggiata a 0 kn: ferma');
  change(page, { id: 'f-seen', value: '15' });
  change(page, { name: 'f-status', value: 'moored', checked: false });
  assert.equal(page.local.get(KEY), 'status=underway,anchor,fishing,limited,other&seen=15&moving=1');
  assert.equal(page.el('filter-count').textContent, ' · 3 attivi');
  assert.equal(page.el('fs-moored').checked, false);
  const n = views(page).length;
  await until(() => views(page).length > n, 'vista con il filtro');
  assert.match(views(page).at(-1).url, /&status=underway,anchor,fishing,limited,other&seen=15&moving=1$/);
  // Baltico: from= non più indietro di «ricevute negli ultimi» (15 min)
  const from = Number(new URL('http://x' + balticReqs(page).at(-1).url.split('digitraffic.fi')[1]).searchParams.get('from'));
  assert.ok(Math.abs(balticReqs(page).at(-1).at - from - 15 * 60000) < 5000, `from= ${balticReqs(page).at(-1).at - from} ms prima`);
  clickReset(page);
  assert.equal(page.local.has(KEY), false);
  assert.equal(page.el('filter-count').textContent, '');
  assert.equal(page.el('fs-moored').checked, true);
  assert.equal(page.el('fm-all').checked, true);
  assert.equal(page.el('f-seen').value, '');
});

test('pagina: stato di navigazione, l\'ultima casella accesa non si spegne (non si resta senza navi per sbaglio)', async () => {
  const page = startPage({ routes, local: { [KEY]: 'status=moored' } });
  await until(() => has(page, 247000002), 'la petroliera ormeggiata');
  const last = { name: 'f-status', value: 'moored', checked: false };
  change(page, last);
  assert.equal(last.checked, true, 'casella riaccesa');
  assert.equal(page.local.get(KEY), 'status=moored');
});

test('pagina: localStorage che lancia o con valori non validi → nessun filtro, la pagina funziona', async () => {
  for (const local of ['throw', { [KEY]: 'types=foo&minSog=abc&seen=-3&moving=si%00' }]) {
    const page = startPage({ routes, local });
    await until(() => page.markers().size === 5, 'cinque navi con ' + JSON.stringify(local));
    assert.match(views(page).at(-1).url, /^\/api\/locations\?bbox=[-\d.,]+$/);
    assert.equal(page.el('filter-count').textContent, '');
    clickType(page, 'cargo');   // salvataggio che lancia: il filtro vale lo stesso in memoria
    assert.equal(has(page, 247000001), false);
  }
});

test('pagina: prova della VM da un server di riserva con la stessa vista filtrata', async () => {
  const VM = { url: 'https://vm.example/api', name: 'VM Oracle' }, RENDER = { url: 'https://render.example/api', name: 'Render', sleeps: true };
  const page = startPage({ config: { BOATRADAR_APIS: [VM, RENDER] }, session: { 'boatradar:api': RENDER.url },
    local: { [KEY]: 'types=tanker' },
    routes: (url, now) => {
      for (const b of [VM, RENDER]) if (url.startsWith(b.url)) return routes('/api' + url.slice(b.url.length), now);
      return routes(url, now);
    } });
  await until(() => page.requests.some(r => r.url.startsWith(VM.url + '/locations?bbox=')), 'prova della VM');
  const probe = page.requests.find(r => r.url.startsWith(VM.url + '/locations?bbox='));
  assert.match(probe.url, /&types=tanker$/, 'la prova chiede la vista con il filtro');
});
