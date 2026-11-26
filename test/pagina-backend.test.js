// Punto 86 (b): passaggio automatico fra VM Oracle e Render nella pagina (boatradar.html), senza browser
// (test/pagina-helpers.js). Lo decide solo la richiesta della vista (locations?bbox=); /status e include= vanno al
// server attivo; un server che risponde non fa mai passare all'altro (quota di traffico di Render, deploy/README.md).
// La verifica nel browser vero è lo scenario «server di riserva» di tools/smoke-browser.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until, TIME_SCALE } = require('./pagina-helpers');
const { afterEach } = require('node:test');

// ogni pagina aperta da un test si chiude alla fine (i tentativi programmati non tengono vivo il processo)
const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const VM = { url: 'https://vm.example/api', name: 'VM Oracle', sleeps: false };
const RENDER = { url: 'https://render.example/api', name: 'Render', sleeps: true };
const APIS = { BOATRADAR_APIS: [VM, RENDER], BOATRADAR_API: VM.url };
const KEY = 'boatradar:api';

const fc = (mmsi, now) => ({ type: 'FeatureCollection', total: 1, features: [{ type: 'Feature', mmsi,
  geometry: { type: 'Point', coordinates: [11, 44] }, properties: { mmsi, sog: 5, cog: 90, timestampExternal: now() - 1000 } }] });
const status = now => ({ hasKey: true, connected: true, vessels: 1, serverTime: now() });
// server sano: /status, la vista con la nave mmsi e include= con la stessa nave
const healthy = mmsi => (path, now) => {
  if (path === '/status') return { body: () => status(now) };
  if (path.startsWith('/locations?')) return { body: () => fc(mmsi, now) };
};
// rotte per server (prefisso) + Digitraffic senza navi
const routesOf = servers => (url, now) => {
  if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
  for (const [base, route] of Object.entries(servers)) if (url.startsWith(base)) return route(url.slice(base.length), now);
};
const DEAD = () => ({ fail: true });
const on = (page, base) => page.requests.filter(r => r.url.startsWith(base));
const isView = r => r.url.includes('/locations?bbox=');

test('pagina: VM giù (errore di rete) → passa a Render, navi in mappa, «server di riserva (Render)», ricordato nella sessione', async () => {
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: healthy(111) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  assert.ok(page.markers().has(111), 'la nave di Render è in mappa');
  assert.match(page.status(), /^1 in mappa · agg\. .* · 1 nel mondo · server di riserva \(Render\)$/);
  assert.equal(page.storage.get(KEY), RENDER.url, 'sessionStorage ricorda Render');
  assert.ok(on(page, VM.url).some(isView), 'prima ha provato la VM');
  // giri successivi: tutto a Render, anche /status e include=; nessun ritorno automatico alla VM
  const before = on(page, VM.url).length;
  page.get('selected = 111; document.getElementById("panel").style.display = "block"');
  await page.tick();
  await page.tick();
  assert.equal(on(page, VM.url).length, before, 'nessuna richiesta alla VM dopo il cambio');
  assert.ok(on(page, RENDER.url).some(r => r.url === RENDER.url + '/status'), '/status a Render');
  assert.ok(on(page, RENDER.url).some(r => r.url.startsWith(RENDER.url + '/locations?include=')), 'include= a Render');
  assert.ok(on(page, RENDER.url).some(r => r.url.startsWith(RENDER.url + '/vessel?mmsi=111')), 'dati della nave a Render');
});

test('pagina: VM che risponde 503 o non risponde entro 8 s → Render', async () => {
  for (const [what, vmRoute] of [['503', () => ({ status: 503 })], ['nessuna risposta', () => ({ hang: true })]]) {
    const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: vmRoute, [RENDER.url]: healthy(222) }) });
    await page.waitStatus(/ · server di riserva \(Render\)$/, what);
    assert.ok(page.markers().has(222), what);
    if (what !== '503') {
      const view = on(page, VM.url).find(isView);
      assert.equal(view.outcome, 'annullata', 'la richiesta della vista alla VM è stata annullata');
      const firstRender = on(page, RENDER.url).find(isView);
      const waited = firstRender.at - view.at;
      assert.ok(waited >= 8000 && waited < 8000 + 300 * TIME_SCALE, `Render provato dopo il timeout di 8 s (${waited} ms)`);
    }
  }
});

test('pagina: VM che risponde → nessuna richiesta a Render, neanche se falliscono /status o include= (quota di Render)', async () => {
  let n = 0;
  const vm = (path, now) => {
    if (path === '/status') return ++n % 2 ? { fail: true } : { body: () => status(now) };
    if (path.startsWith('/locations?include=')) return { status: 500 };
    if (path.startsWith('/locations?bbox=')) return { body: () => fc(333, now) };
  };
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(999) }) });
  await page.waitStatus(/in mappa/);
  page.get('selected = 333; document.getElementById("panel").style.display = "block"');
  for (let i = 0; i < 4; i++) await page.tick();
  assert.equal(on(page, RENDER.url).length, 0, 'Render mai chiamato');
  assert.ok(page.markers().has(333));
  assert.doesNotMatch(page.status(), /riserva/);
  assert.equal(page.storage.has(KEY), false, 'niente da ricordare');
  assert.equal(page.retryTimers.size, 0, 'nessun nuovo tentativo programmato');
});

test('pagina: Render che si sveglia → «in avvio, circa un minuto…», riprova con attese crescenti, poi le navi', async () => {
  const wakeAt = Date.now() + 2000 * 1;   // Render pronto dopo ~2 s veri (20 s della pagina)
  const render = (path, now) => (Date.now() < wakeAt ? { hang: true } : healthy(444)(path, now));
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: render }) });
  await page.waitStatus(/ · Mondo: server di riserva in avvio, circa un minuto…/, 'messaggio di avvio', 4000);
  assert.equal(page.markers().size, 0);
  assert.ok(page.retryTimers.size <= 1, 'un solo tentativo in attesa');
  await page.waitStatus(/ · server di riserva \(Render\)$/, 'navi da Render', 8000);
  assert.ok(page.markers().has(444));
  const views = on(page, RENDER.url).filter(isView);
  assert.ok(views.length >= 2, `più tentativi (${views.length})`);
  // attese fra la fine (timeout 8 s) di un tentativo e il successivo: 5 s, poi 10 s…
  const gaps = views.slice(1).map((v, i) => v.at - (views[i].at + 8000));
  assert.ok(gaps[0] >= 5000 && gaps[0] < 5000 + 200 * TIME_SCALE, `prima attesa ~5 s (${gaps[0]} ms)`);
  if (gaps[1] != null) assert.ok(gaps[1] >= 10000, `seconda attesa ~10 s (${gaps[1]} ms)`);
  assert.equal(on(page, VM.url).filter(isView).length, 1, 'la VM provata una volta sola (entro 90 s Render resta)');
});

test('pagina: nessun server raggiungibile → «riprovo tra N s (ora solo Baltico)», giri intermedi senza richieste, un solo tentativo', async () => {
  const page = startPage({ routes: (url, now) => {
    if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: () => fc(555, now) };
    return { fail: true };
  } });
  await page.waitStatus(/ · Mondo: server non raggiungibile, riprovo tra 5 s \(ora solo Baltico\)$/);
  assert.ok(page.markers().has(555), 'il Baltico resta');
  const views = () => page.requests.filter(r => r.url.startsWith('/api/locations?bbox=')).length;
  assert.equal(views(), 1);
  assert.equal(page.retryTimers.size, 1, 'un tentativo programmato');
  await page.tick();   // es. la mappa spostata durante l'attesa
  await page.tick();
  assert.equal(views(), 1, 'durante l\'attesa niente richieste al server');
  assert.equal(page.requests.filter(r => r.url === '/api/status').length, 1, 'neanche /status');
  assert.equal(page.retryTimers.size, 1, 'nessun tentativo in più');
  assert.match(page.status(), /riprovo tra [1-5] s \(ora solo Baltico\)$/);
  await until(() => views() === 2, 'secondo tentativo dopo 5 s', 2000);
  await page.waitStatus(/riprovo tra 10 s/);
  assert.equal(page.retryTimers.size, 1);
});

test('pagina: con Render salvato nella sessione si parte da Render; sessionStorage che lancia non blocca la pagina', async () => {
  const page = startPage({ config: APIS, session: { [KEY]: RENDER.url },
    routes: routesOf({ [VM.url]: healthy(666), [RENDER.url]: healthy(777) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  assert.equal(on(page, VM.url).length, 0, 'la VM non viene chiamata');
  assert.ok(page.markers().has(777));

  const safari = startPage({ config: APIS, session: 'throw', routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: healthy(888) }) });
  await safari.waitStatus(/ · server di riserva \(Render\)$/);
  assert.ok(safari.markers().has(888));
});

test('pagina: solo BOATRADAR_API (config.js vecchio) o niente config → un solo server, senza «riserva»', async () => {
  const one = startPage({ config: { BOATRADAR_API: 'https://uno.example/api/' }, routes: routesOf({ 'https://uno.example/api': healthy(121) }) });
  await one.waitStatus(/in mappa/);
  assert.ok(one.markers().has(121));
  assert.doesNotMatch(one.status(), /riserva/);
  const local = startPage({ routes: routesOf({ '/api': healthy(131) }) });
  await local.waitStatus(/in mappa/);
  assert.ok(local.markers().has(131));
  assert.ok(local.requests.some(r => r.url.startsWith('/api/locations?bbox=')));
});
