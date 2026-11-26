// Punto 86 (b): passaggio automatico fra VM Oracle e Render nella pagina (boatradar.html), senza browser
// (test/pagina-helpers.js). Lo decide solo la richiesta della vista (locations?bbox=); /status e include= vanno al
// server attivo; un server che risponde non fa mai passare all'altro (quota di traffico di Render, deploy/README.md).
// Su Render, ogni 5 min una prova leggera della VM per tornarci (quota di Render). La verifica nel browser vero sono gli
// scenari «server di riserva» e «ritorno» di tools/smoke-browser.sh.
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
  // giri successivi: tutto a Render, anche /status e include=; la VM si riprova solo dopo 5 min (test più sotto)
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

// --- ritorno automatico al server principale (PRIMARY_RECHECK_MS, 5 min) -----------------------------------------
// Ora della pagina 200 volte più veloce: 5 min = 1,5 s veri, il timeout di 8 s = 40 ms veri. I giri li fa il test
// (setInterval è finto): un tick() ogni 10 ms veri, cioè ogni 2 s della pagina.
const FAST = 200;
const MIN5 = 5 * 60 * 1000, SLACK = 3000;
const { sleep } = require('./pagina-helpers');
async function ticksUntil(page, cond, what, pageMs) {
  const end = page.pageNow() + pageMs;
  while (page.pageNow() < end) { if (cond()) return; await page.tick(); await sleep(10); }
  if (!cond()) throw new Error(`in ${pageMs / 1000} s della pagina non è successo: ${what} (stato: «${page.status()}»)`);
}
const isStatus = base => r => r.url === base + '/status';

test('pagina: su Render, dopo 5 min una prova leggera della VM (/status); la VM risponde → al giro dopo torna alla VM', async () => {
  let vmUp = false;
  const vm = (path, now) => (vmUp ? healthy(101)(path, now) : { fail: true });
  const page = startPage({ timeScale: FAST, config: APIS, routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(202) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  // passaggio a Render: fra la vista fallita della VM e la prima vista di Render
  const switchedAt = on(page, VM.url).find(isView).at;
  const before = on(page, VM.url).length;
  vmUp = true;   // la VM torna, ma la pagina non lo sa finché non prova
  await ticksUntil(page, () => on(page, VM.url).length > before, 'prova della VM', MIN5 + 30000);
  const probe = on(page, VM.url)[before];
  assert.equal(probe.url, VM.url + '/status', 'la prova è /status');
  // tolleranza SLACK: con l'ora 200 volte più veloce pochi ms veri di rete spostano l'orologio della pagina di qualche s
  assert.ok(probe.at - switchedAt >= MIN5 - SLACK && probe.at - switchedAt < MIN5 + 10000, `dopo 5 min (${probe.at - switchedAt} ms)`);
  // la prova non tocca la vista: in quel giro la vista resta di Render
  await ticksUntil(page, () => on(page, VM.url).slice(before).some(isView), 'vista chiesta alla VM', 10000);
  await until(() => page.markers().has(101) && !/riserva/.test(page.status()), 'navi della VM, senza «riserva»', 1000);
  // la vista va alla VM solo dal giro dopo la prova: la prova stessa è solo /status
  assert.ok(on(page, VM.url).slice(before).findIndex(isView) > 0, 'prima la prova, poi la vista');
  assert.equal(page.storage.get(KEY), VM.url, 'sessionStorage aggiornato');
  assert.match(page.status(), / · 1 nel mondo$/);
  const renderBefore = on(page, RENDER.url).length;
  for (let i = 0; i < 3; i++) await page.tick();
  assert.equal(on(page, RENDER.url).length, renderBefore, 'dopo il ritorno niente più richieste a Render');
});

test('pagina: su Render la VM non risponde alla prova → resta su Render senza errori, riprova dopo altri 5 min, una prova alla volta', async () => {
  const page = startPage({ timeScale: FAST, config: APIS,
    routes: routesOf({ [VM.url]: () => ({ hang: true }), [RENDER.url]: healthy(303) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  const before = on(page, VM.url).length;   // la vista provata all'inizio, annullata dopo 8 s
  await until(() => on(page, VM.url)[0].outcome === 'annullata', 'vista della VM annullata', 2000);
  const probes = () => on(page, VM.url).slice(before);
  await ticksUntil(page, () => probes().length >= 1, 'prima prova', MIN5 + 30000);
  // durante gli 8 s della prova i giri continuano (su Render) senza aprire altre prove
  await ticksUntil(page, () => probes()[0].outcome === 'annullata', 'prova annullata dopo 8 s', 20000);
  assert.equal(probes().length, 1, 'una prova alla volta');
  assert.ok(probes().every(isStatus(VM.url)), 'solo /status, mai la vista');
  assert.match(page.status(), /^1 in mappa · .* · 1 nel mondo · server di riserva \(Render\)$/, 'nessun errore del server attivo');
  assert.ok(page.markers().has(303));
  assert.equal(page.retryTimers.size, 0, 'nessun tentativo programmato: Render non ha sbagliato');
  assert.equal(page.storage.get(KEY), RENDER.url);
  await ticksUntil(page, () => probes().length >= 2, 'seconda prova', MIN5 + 30000);
  const gap = probes()[1].at - (probes()[0].at + 8000);
  assert.ok(gap >= MIN5 - SLACK && gap < MIN5 + 10000, `seconda prova 5 min dopo la fine della prima (${gap} ms)`);
  assert.ok(probes().every(isStatus(VM.url)));
});

test('pagina: già sulla VM nessuna prova in più, anche dopo più di 5 min', async () => {
  const page = startPage({ timeScale: FAST, config: APIS, routes: routesOf({ [VM.url]: healthy(404), [RENDER.url]: healthy(505) }) });
  await page.waitStatus(/in mappa/);
  const end = page.pageNow() + MIN5 + 60000;
  while (page.pageNow() < end) { await page.tick(); await sleep(10); }
  const vmReq = on(page, VM.url);
  assert.equal(vmReq.filter(isStatus(VM.url)).length, vmReq.filter(isView).length, 'un /status per giro, niente prove');
  assert.equal(on(page, RENDER.url).length, 0, 'Render mai chiamato');
});

test('pagina: scheda nascosta → nessuna prova; tornata visibile → prova; hasKey false → resta, 200 senza hasKey → torna', async () => {
  let vmStatus = { body: { hasKey: false } };
  const vm = (path, now) => {
    if (path === '/status') return vmStatus;
    if (path.startsWith('/locations?')) return { body: () => fc(606, now) };
  };
  const page = startPage({ timeScale: FAST, config: APIS, session: { [KEY]: RENDER.url },
    routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(707) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  page.get('document.hidden = true');
  const end = page.pageNow() + MIN5 + 30000;
  while (page.pageNow() < end) { await page.tick(); await sleep(10); }
  assert.equal(on(page, VM.url).length, 0, 'scheda nascosta: nessuna prova');
  page.get('document.hidden = false');
  await page.tick();
  await until(() => on(page, VM.url).length === 1 && on(page, VM.url)[0].outcome === 200, 'prova appena visibile', 1000);
  for (let i = 0; i < 3; i++) await page.tick();
  assert.match(page.status(), /server di riserva \(Render\)$/, 'hasKey false: resta su Render');
  assert.equal(on(page, VM.url).length, 1);
  vmStatus = { body: () => ({ serverTime: page.pageNow() }) };   // risponde, ma senza il campo hasKey
  await ticksUntil(page, () => on(page, VM.url).some(isView), 'ritorno alla VM', MIN5 + 30000);
  assert.equal(page.storage.get(KEY), VM.url);
  await until(() => page.markers().has(606), 'navi della VM', 1000);
});
