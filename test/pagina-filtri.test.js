// Punto 9 (b): filtri nella pagina (boatradar.html), senza browser (test/pagina-helpers.js). Legenda con un pulsante per
// tipo (aria-pressed), pannello «Filtri» (movimento, velocità, «ricevute negli ultimi», stato di navigazione, «Mostra
// tutte»), scelte in localStorage['boatradar:filtri'] come filterKey. Il filtro vale in pagina su tutte le fonti unite
// (anche il Baltico) e va al server solo se attivo; la nave selezionata resta sempre; nessun tipo o nessuno stato acceso →
// niente vista né Baltico. Correzioni da revisione: Esc nella legenda, mappa vuota con «Mostra tutte», valori salvati fuori
// elenco, popup chiuso al cambio, giri sovrapposti numerati. La verifica nel browser vero è il passo «filtri» di tools/smoke-browser.sh.
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

test('pagina: stato di navigazione, si spegne anche l\'ultima casella → come senza tipi (niente vista né Baltico), salvato status=', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  page.get('select(247000002); document.getElementById("panel").style.display = "block"');
  for (const g of ['underway', 'anchor', 'moored', 'fishing', 'limited', 'other']) change(page, { name: 'f-status', value: g, checked: false });
  assert.equal(page.local.get(KEY), 'status=');
  assert.equal(page.el('fs-moored').checked, false, 'caselle spente');
  assert.equal(page.el('filter-count').textContent, ' · 1 attivo');
  assert.deepEqual([...page.markers().keys()], [247000002], 'resta solo la selezionata');
  await sleep(60);
  const v = views(page).length, b = balticReqs(page).length, inc = page.requests.filter(r => r.url.includes('include=')).length;
  await page.tick();
  assert.equal(views(page).length, v, 'nessuna vista');
  assert.equal(balticReqs(page).length, b, 'nessun Baltico');
  assert.ok(page.requests.filter(r => r.url.includes('include=')).length > inc, 'include= della nave selezionata');
  assert.match(page.status(), /nessuno stato di navigazione selezionato nei filtri/);
  // una casella riaccesa: di nuovo vista, con quello stato solo
  change(page, { name: 'f-status', value: 'moored', checked: true });
  assert.equal(page.local.get(KEY), 'status=moored');
  // ricaricando senza stati (anche con un tipo spento davanti): resta così, due criteri attivi
  const again = startPage({ routes, local: { [KEY]: 'types=&status=' } });
  await again.waitStatus(/nessun tipo di nave selezionato/);
  const third = startPage({ routes, local: { [KEY]: 'status=&minSog=5' } });
  await third.waitStatus(/nessuno stato di navigazione selezionato/);
  assert.equal(views(again).length + views(third).length, 0);
  assert.equal(balticReqs(again).length + balticReqs(third).length, 0);
  assert.equal(again.el('filter-count').textContent, ' · 2 attivi');
  assert.equal(third.el('fs-underway').checked, false);
  assert.equal(third.el('f-min').value, '5');
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

test('pagina: nessun tipo acceso su un server di riserva → la prova della VM chiede solo /status, nessuna vista', async () => {
  const VM = { url: 'https://vm.example/api', name: 'VM Oracle' }, RENDER = { url: 'https://render.example/api', name: 'Render', sleeps: true };
  const page = startPage({ config: { BOATRADAR_APIS: [VM, RENDER] }, session: { 'boatradar:api': RENDER.url },
    local: { [KEY]: 'types=' },
    routes: (url, now) => {
      for (const b of [VM, RENDER]) if (url.startsWith(b.url)) return routes('/api' + url.slice(b.url.length), now);
      return routes(url, now);
    } });
  await until(() => page.requests.some(r => r.url === VM.url + '/status'), 'prova della VM su /status');
  await sleep(60);
  await page.tick();
  assert.deepEqual(page.requests.filter(r => r.url.includes('/locations')).map(r => r.url), [], 'nessuna vista, a nessun server');
  await page.waitStatus(/nessun tipo di nave selezionato/);
  assert.equal(page.get('backends.current().url'), VM.url, 'VM pronta (/status) → si torna alla VM');
});

test('pagina: filtro salvato con valori fuori elenco → portati al più vicino delle tendine (anche nella vista)', async () => {
  const page = startPage({ routes, local: { [KEY]: 'minSog=4.2&maxSog=12&seen=50' } });
  await until(() => views(page).length > 0, 'vista');
  assert.equal(page.el('f-min').value, '5');
  assert.equal(page.el('f-max').value, '10');
  assert.equal(page.el('f-seen').value, '60');
  assert.match(views(page).at(-1).url, /&minSog=5&maxSog=10&seen=60$/);
  // parità: il minimo scende, il massimo sale (si vede di più, non di meno)
  const tie = startPage({ routes, local: { [KEY]: 'minSog=2&maxSog=25' } });
  await until(() => views(tie).length > 0, 'vista');
  assert.equal(tie.el('f-min').value, '1');
  assert.equal(tie.el('f-max').value, '30');
});

test('pagina: filtro che svuota la mappa → «nessuna nave con questi filtri» e «Mostra tutte» nella riga di stato; #filters aperto dopo una ricarica', async () => {
  const page = startPage({ routes, local: { [KEY]: 'minSog=30' } });
  await page.waitStatus(/^0 in mappa · nessuna nave con questi filtri · agg\./);
  assert.equal(page.el('status-reset').hidden, false, 'pulsante «Mostra tutte» visibile');
  assert.equal(page.el('filters').open, true, 'filtri diversi dai tipi → pannello aperto');
  page.fireEl('status-reset', 'click');
  assert.equal(page.local.has(KEY), false);
  assert.equal(page.el('status-reset').hidden, true);
  await until(() => page.markers().size === 5, 'di nuovo cinque navi');
  assert.doesNotMatch(page.status(), /nessuna nave con questi filtri|filtri attivi/);
  // solo i tipi: pannello chiuso; navi in mappa: niente pulsante
  const types = startPage({ routes, local: { [KEY]: 'types=tanker' } });
  await types.waitStatus(/^2 in mappa · filtri attivi/);
  assert.equal(types.el('filters').open, false);
  assert.equal(types.el('status-reset').hidden, true);
  // cambio nella pagina che svuota la mappa: la riga lo dice subito
  change(types, { id: 'f-min', value: '20' });
  assert.match(types.status(), /^0 in mappa · nessuna nave con questi filtri/);
  assert.equal(types.el('status-reset').hidden, false);
});

test('pagina: Esc con il focus nella legenda chiude prima «Filtri», poi la legenda (focus sul titolo), senza chiudere la scheda', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  page.get('select(247000001)');
  const legend = page.el('legend'), filters = page.el('filters'), inside = page.el('f-min');
  legend.contains = x => [legend, filters, inside, page.el('legend-sum'), page.el('filters-sum')].includes(x);
  filters.contains = x => [filters, inside, page.el('filters-sum')].includes(x);
  legend.open = true; filters.open = true;
  inside.focus();
  let e = page.keydown('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(filters.open, false, 'prima il pannello Filtri');
  assert.equal(legend.open, true);
  assert.equal(page.document.activeElement, page.el('filters-sum'), 'focus sul titolo di «Filtri»');
  assert.equal(page.el('panel').style.display, 'block', 'la scheda resta aperta');
  e = page.keydown('Escape');
  assert.equal(legend.open, false, 'poi la legenda');
  assert.equal(page.document.activeElement, page.el('legend-sum'), 'focus sul titolo della legenda');
  assert.equal(page.el('panel').style.display, 'block', 'la scheda resta aperta');
  // legenda chiusa: Esc torna a chiudere la scheda
  page.keydown('Escape');
  assert.equal(page.el('panel').style.display, 'none');
});

test('pagina: cambio di filtro con il popup «N navi qui» aperto → popup chiuso; nave scelta senza marker → subito un giro', async () => {
  const page = startPage({ routes });
  await until(() => page.markers().size === 5, 'cinque navi');
  page.get('openPick({ x: 500, y: 400 }, [247000001, 247000002])');
  assert.ok(page.map._popup, 'popup aperto');
  change(page, { id: 'f-min', value: '5' });
  assert.equal(page.map._popup, null, 'popup chiuso dal cambio di filtro');
  assert.equal(has(page, 247000002), false);
  await sleep(60);
  const n = page.requests.length;
  page.get('select(247000002)');   // la petroliera ferma, nascosta dal filtro: scelta (es. dalla ricerca) torna in mappa
  await until(() => has(page, 247000002), 'la nave scelta ricompare senza aspettare il giro periodico');
  assert.ok(page.requests.slice(n).some(r => r.url.includes('include=247000002')));
});

test('pagina: marker in mappa che al giro dopo non passa più il filtro (da 12 a 0 kn con minSog=5) → tolto', async () => {
  let sog = 12;
  const page = startPage({ routes: (url, now) => {
    if (url.startsWith('/api/locations?bbox=')) return { body: () => ({ type: 'FeatureCollection', total: 3,
      features: world(now).map(f => (f.mmsi === 247000001 ? ship(247000001, 44.1, 11.1, { ...f.properties, sog, navStat: sog ? 0 : 5 }) : f)) }) };
    return routes(url, now);
  }, local: { [KEY]: 'minSog=5' } });
  await until(() => has(page, 247000001), 'cargo a 12 kn');
  sog = 0;
  await sleep(20);
  await page.tick();
  assert.equal(has(page, 247000001), false, 'a 0 kn non passa più minSog=5');
});

test('pagina: giri sovrapposti → un giro più vecchio dell\'ultimo avviato non tocca i marker', async () => {
  let calls = 0;
  const page = startPage({ routes: (url, now) => {
    if (url.startsWith('/api/locations?bbox=')) {
      calls++;
      // la seconda vista (il giro più vecchio dei due del test) arriva dopo la terza e porta solo una nave nuova
      if (calls === 2) return { delay: 300, body: () => ({ type: 'FeatureCollection', total: 1,
        features: [ship(247000009, 44.4, 11.4, { name: 'VECCHIA', shipType: 70, sog: 5, timestampExternal: now() - 500 })] }) };
    }
    return routes(url, now);
  } });
  await until(() => page.markers().size === 5, 'cinque navi');
  const older = page.tick(), newer = page.tick();
  await newer;
  assert.equal(page.markers().size, 5);
  await older;
  assert.equal(has(page, 247000009), false, 'il giro vecchio non aggiunge');
  assert.equal(page.markers().size, 5, 'il giro vecchio non toglie');
});

test('pagina: velocità in un fieldset con legend «Velocità» (da / fino a), stati in un gruppo con nome, titolo fisso su telefono', () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'boatradar.html'), 'utf8');
  assert.match(html, /<fieldset[^>]*><legend>Velocità<\/legend>\s*<label for="f-min">da<\/label><select id="f-min"><\/select>\s*<label for="f-max">fino a<\/label><select id="f-max"><\/select>/);
  assert.match(html, /<div id="f-status" role="group" aria-label="Stato di navigazione">/);
  assert.match(html, /<summary id="legend-sum">Legenda e filtri/);
  assert.match(html, /<summary id="filters-sum">Filtri<\/summary>/);
  const phone = html.slice(html.indexOf('@media (max-width: 640px)'));
  assert.match(phone, /#legend > summary \{[^}]*position:sticky; top:0;[^}]*background:var\(--panel\)/);
  assert.match(html, /<button type="button" id="status-reset"[^>]*hidden>Mostra tutte<\/button>/);
});
