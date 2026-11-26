// Punto 86 (b): passaggio automatico fra VM Oracle e Render nella pagina (boatradar.html), senza browser
// (test/pagina-helpers.js). Lo decide solo la richiesta della vista (locations?bbox=): sulla VM dopo due errori di fila
// (il primo la fa riprovare dopo 3 s), e mai per un errore della rete dell'utente (navigator.onLine false, o anche il
// Baltico fallito con errore di rete); /status e include= vanno al server attivo; un server che risponde non fa mai
// passare all'altro (quota di traffico di Render, deploy/README.md). Su Render una prova leggera della VM (la stessa
// vista, dalla cache della VM) ogni 5 min, subito ricaricando la scheda e quando la scheda torna visibile, per tornarci.
// La verifica nel browser vero sono gli scenari «server di riserva» e «ritorno» di tools/smoke-browser.sh.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startPage: start, until, sleep, TIME_SCALE } = require('./pagina-helpers');
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
const views = (page, base) => on(page, base).filter(isView);
const CONFIRM = 3000, SLACK_RETRY = 250;   // attesa dopo il primo errore della VM, margine del tentativo programmato

test('pagina: VM giù (errore di rete) → due tentativi a 3 s, poi Render, navi in mappa, «server di riserva (Render)», ricordato', async () => {
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: healthy(111) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  assert.ok(page.markers().has(111), 'la nave di Render è in mappa');
  assert.match(page.status(), /^1 in mappa · agg\. .* · 1 nel mondo · server di riserva \(Render\)$/);
  assert.equal(page.storage.get(KEY), RENDER.url, 'sessionStorage ricorda Render');
  const vm = views(page, VM.url);
  assert.equal(vm.length, 2, 'la VM provata due volte prima di passare');
  const gap = vm[1].at - vm[0].end;
  assert.ok(gap >= CONFIRM && gap < CONFIRM + 300 * TIME_SCALE, `secondo tentativo dopo ~3 s (${gap} ms)`);
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

test('pagina: VM che risponde 503 o non risponde entro 8 s (due volte di fila) → Render', async () => {
  for (const [what, vmRoute] of [['503', () => ({ status: 503 })], ['nessuna risposta', () => ({ hang: true })]]) {
    const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: vmRoute, [RENDER.url]: healthy(222) }) });
    await page.waitStatus(/ · server di riserva \(Render\)$/, what);
    assert.ok(page.markers().has(222), what);
    const vm = views(page, VM.url);
    assert.equal(vm.length, 2, `${what}: due tentativi alla VM`);
    if (what !== '503') {
      assert.ok(vm.every(v => v.outcome === 'annullata'), 'le richieste della vista alla VM sono state annullate');
      assert.ok(vm[0].end - vm[0].at >= 8000, 'dopo 8 s');
      const firstRender = views(page, RENDER.url)[0];
      const waited = firstRender.at - vm[1].end;
      assert.ok(waited >= 0 && waited < 300 * TIME_SCALE, `Render provato appena scaduto il secondo timeout (${waited} ms)`);
    }
  }
});

test('pagina: errore isolato della vista della VM → riprova la VM dopo ~3 s, nessuna richiesta a Render', async () => {
  let n = 0;
  const vm = (path, now) => (path.startsWith('/locations?bbox=') && ++n === 2 ? { fail: true } : healthy(121)(path, now));
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(999) }) });
  await page.waitStatus(/ · 1 nel mondo$/);
  await page.tick();   // la seconda vista fallisce
  assert.match(page.status(), / · Mondo: server non raggiungibile, riprovo tra 3 s \(ora solo Baltico\)$/);
  await until(() => views(page, VM.url).length === 3 && views(page, VM.url)[2].outcome === 200, 'terza vista alla VM', 2000);
  await page.waitStatus(/ · 1 nel mondo$/);
  const v = views(page, VM.url);
  assert.ok(v[2].at - v[1].end >= CONFIRM, 'dopo 3 s');
  assert.equal(on(page, RENDER.url).length, 0, 'Render mai chiamato');
  assert.equal(page.storage.has(KEY), false);
});

test('pagina: 3 s senza rete con VM sana (simulazione del Reviewer) → nessun passaggio a Render', async () => {
  for (const ms of [3000, 10000]) {   // 10 s: più dei due errori di fila, conta la regola del Baltico
    let downUntil = 0;
    const ok = routesOf({ [VM.url]: healthy(131), [RENDER.url]: healthy(999) });
    const page = startPage({ config: APIS, routes: (url, now) => (now() < downUntil ? { fail: true } : ok(url, now)) });
    await page.waitStatus(/ · 1 nel mondo$/);
    downUntil = page.pageNow() + ms;
    await page.tick();
    await until(() => page.pageNow() > downUntil + 4000, `${ms} ms di rete assente e un tentativo dopo`, 3000);
    await page.waitStatus(/^1 in mappa · .* · 1 nel mondo$/, `${ms} ms: VM di nuovo in mappa`);
    const failed = views(page, VM.url).filter(v => v.outcome === 'rete').length;
    assert.ok(failed >= (ms > 5000 ? 3 : 1), `${ms} ms: viste fallite alla VM (${failed})`);
    assert.equal(on(page, RENDER.url).length, 0, `${ms} ms: Render mai chiamato`);
    assert.equal(page.storage.has(KEY), false);
  }
});

test('pagina: navigator.onLine false → gli errori della VM non contano, nessun passaggio a Render', async () => {
  let downUntil = 0;
  const vm = (path, now) => (now() < downUntil ? { fail: true } : healthy(141)(path, now));
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(999) }) });
  await page.waitStatus(/ · 1 nel mondo$/);
  page.ctx.navigator.onLine = false;   // il Baltico (qui sempre buono) non c'entra
  downUntil = page.pageNow() + 10000;
  await page.tick();
  await until(() => page.pageNow() > downUntil + 4000, 'rete assente e un tentativo dopo', 3000);
  page.ctx.navigator.onLine = true;
  await page.waitStatus(/ · 1 nel mondo$/);
  assert.ok(views(page, VM.url).filter(v => v.outcome === 'rete').length >= 3);
  assert.equal(on(page, RENDER.url).length, 0, 'Render mai chiamato');
});

test('pagina: Baltico sempre irraggiungibile (bloccato) e VM giù → passa comunque a Render', async () => {
  const servers = routesOf({ [VM.url]: DEAD, [RENDER.url]: healthy(151) });
  const page = startPage({ config: APIS, routes: (url, now) => (url.includes('digitraffic') ? { fail: true } : servers(url, now)) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  assert.ok(page.markers().has(151));
  assert.equal(views(page, VM.url).length, 2);
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

test('pagina: Render che si sveglia → «in avvio, circa un minuto…», poi la vista con 45 s di tempo, poi le navi', async () => {
  // Render risponde solo quando è sveglio, dopo ~3 s veri (30 s della pagina): fino ad allora tiene le richieste in sospeso
  const wakeAt = Date.now() + 3000;
  const render = (path, now) => { const r = healthy(444)(path, now); return Date.now() < wakeAt ? { ...r, delay: wakeAt - Date.now() } : r; };
  const page = startPage({ config: APIS, routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: render }) });
  await page.waitStatus(/ · Mondo: server di riserva in avvio, circa un minuto…/, 'messaggio di avvio', 4000);
  assert.equal(page.markers().size, 0);
  assert.ok(page.retryTimers.size <= 1, 'un solo tentativo in attesa');
  await until(() => views(page, RENDER.url).length === 2, 'secondo tentativo a Render', 4000);
  // durante la lunga attesa della vista a Render altri giri (mappa spostata) non mandano altre viste a Render
  await page.tick();
  assert.equal(views(page, RENDER.url).length, 2, 'una sola vista in attesa');
  assert.match(page.status(), /in avvio/);
  await page.waitStatus(/ · server di riserva \(Render\)$/, 'navi da Render', 8000);
  assert.ok(page.markers().has(444));
  const v = views(page, RENDER.url);
  assert.equal(v[0].outcome, 'annullata', 'primo tentativo: 8 s');
  const gap = v[1].at - v[0].end;
  assert.ok(gap >= 5000 && gap < 5000 + 200 * TIME_SCALE, `attesa ~5 s fra i tentativi (${gap} ms)`);
  assert.equal(v[1].outcome, 200);
  assert.ok(v[1].end - v[1].at > 8000, `in avvio la vista aspetta più di 8 s (${v[1].end - v[1].at} ms)`);
  assert.equal(views(page, VM.url).length, 2, 'la VM provata due volte (entro 90 s Render resta)');
});

test('pagina: nessun server raggiungibile → «riprovo tra N s (ora solo Baltico)», giri intermedi senza richieste, un solo tentativo', async () => {
  const page = startPage({ routes: (url, now) => {
    if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: () => fc(555, now) };
    return { fail: true };
  } });
  await page.waitStatus(/ · Mondo: server non raggiungibile, riprovo tra 3 s \(ora solo Baltico\)$/);
  assert.ok(page.markers().has(555), 'il Baltico resta');
  const n = () => page.requests.filter(r => r.url.startsWith('/api/locations?bbox=')).length;
  assert.equal(n(), 1);
  assert.equal(page.retryTimers.size, 1, 'un tentativo programmato');
  await page.tick();   // es. la mappa spostata durante l'attesa
  await page.tick();
  assert.equal(n(), 1, 'durante l\'attesa niente richieste al server');
  assert.equal(page.requests.filter(r => r.url === '/api/status').length, 1, 'neanche /status');
  assert.equal(page.retryTimers.size, 1, 'nessun tentativo in più');
  assert.match(page.status(), /riprovo tra [1-3] s \(ora solo Baltico\)$/);
  await until(() => n() === 2, 'secondo tentativo dopo 3 s', 2000);
  await page.waitStatus(/riprovo tra 5 s/);
  assert.equal(page.retryTimers.size, 1);
  await until(() => n() === 3, 'terzo tentativo dopo 5 s', 2000);
  await page.waitStatus(/riprovo tra 10 s/);
});

test('pagina: ricaricando con Render salvato, prova subito la VM e la aspetta; la VM risponde → si parte dalla VM, Render mai chiamato', async () => {
  const page = startPage({ config: APIS, session: { [KEY]: RENDER.url },
    routes: routesOf({ [VM.url]: healthy(666), [RENDER.url]: healthy(777) }) });
  await page.waitStatus(/ · 1 nel mondo$/);
  assert.ok(page.markers().has(666));
  assert.equal(on(page, RENDER.url).length, 0, 'nessuna richiesta a Render');
  assert.ok(isView(on(page, VM.url)[0]), 'la prova è la vista');
  assert.equal(page.storage.get(KEY), VM.url, 'sessionStorage torna alla VM');
});

test('pagina: ricaricando con Render salvato e la VM che non risponde → la prima vista aspetta la prova (8 s) e va a Render', async () => {
  const page = startPage({ config: APIS, session: { [KEY]: RENDER.url },
    routes: routesOf({ [VM.url]: () => ({ hang: true }), [RENDER.url]: healthy(777) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  assert.ok(page.markers().has(777));
  const probe = on(page, VM.url)[0];
  assert.ok(isView(probe));
  assert.equal(probe.outcome, 'annullata');
  assert.ok(on(page, RENDER.url)[0].at >= probe.at + 8000, 'Render solo dopo il timeout della prova');
  assert.equal(on(page, VM.url).length, 1, 'una sola richiesta alla VM');
  assert.equal(page.storage.get(KEY), RENDER.url);

  const safari = startPage({ config: APIS, session: 'throw', routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: healthy(888) }) });
  await safari.waitStatus(/ · server di riserva \(Render\)$/);
  assert.ok(safari.markers().has(888), 'sessionStorage che lancia non blocca la pagina');
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
async function ticksUntil(page, cond, what, pageMs) {
  const end = page.pageNow() + pageMs;
  while (page.pageNow() < end) { if (cond()) return; await page.tick(); await sleep(10); }
  if (!cond()) throw new Error(`in ${pageMs / 1000} s della pagina non è successo: ${what} (stato: «${page.status()}»)`);
}
const isStatus = base => r => r.url === base + '/status';

test('pagina: su Render, dopo 5 min una prova della VM con la stessa vista; la VM risponde → al giro dopo torna alla VM', async () => {
  let vmUp = false;
  const vm = (path, now) => (vmUp ? healthy(101)(path, now) : { fail: true });
  const page = startPage({ timeScale: FAST, config: APIS, routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(202) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  const switchedAt = views(page, VM.url)[1].end;   // secondo errore della VM: passaggio a Render
  const before = on(page, VM.url).length;
  vmUp = true;   // la VM torna, ma la pagina non lo sa finché non prova
  await ticksUntil(page, () => on(page, VM.url).length > before, 'prova della VM', MIN5 + 30000);
  const probe = on(page, VM.url)[before];
  assert.ok(isView(probe), 'la prova è la vista (servita dalla cache sulla VM), non /status');
  const query = probe.url.slice(VM.url.length);
  assert.ok(views(page, RENDER.url).some(r => r.url.slice(RENDER.url.length) === query), 'la stessa vista chiesta a Render');
  // tolleranza SLACK: con l'ora 200 volte più veloce pochi ms veri di rete spostano l'orologio della pagina di qualche s
  assert.ok(probe.at - switchedAt >= MIN5 - SLACK && probe.at - switchedAt < MIN5 + 10000, `dopo 5 min (${probe.at - switchedAt} ms)`);
  await ticksUntil(page, () => views(page, VM.url).slice(2).length >= 2, 'vista del giro dopo alla VM', 10000);
  await until(() => page.markers().has(101) && !/riserva/.test(page.status()), 'navi della VM, senza «riserva»', 1000);
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
  const before = on(page, VM.url).length;   // i due tentativi all'inizio, annullati dopo 8 s
  const probes = () => on(page, VM.url).slice(before);
  await ticksUntil(page, () => probes().length >= 1, 'prima prova', MIN5 + 30000);
  // durante gli 8 s della prova i giri continuano (su Render) senza aprire altre prove
  await ticksUntil(page, () => probes()[0].outcome === 'annullata', 'prova annullata dopo 8 s', 20000);
  assert.equal(probes().length, 1, 'una prova alla volta');
  assert.ok(probes().every(isView), 'la prova è la vista');
  assert.match(page.status(), /^1 in mappa · .* · 1 nel mondo · server di riserva \(Render\)$/, 'nessun errore del server attivo');
  assert.ok(page.markers().has(303));
  assert.equal(page.retryTimers.size, 0, 'nessun tentativo programmato: Render non ha sbagliato');
  assert.equal(page.storage.get(KEY), RENDER.url);
  await ticksUntil(page, () => probes().length >= 2, 'seconda prova', MIN5 + 30000);
  const gap = probes()[1].at - probes()[0].end;
  assert.ok(gap >= MIN5 - SLACK && gap < MIN5 + 10000, `seconda prova 5 min dopo la fine della prima (${gap} ms)`);
  assert.ok(probes().every(isView));
});

test('pagina: già sulla VM nessuna prova in più, anche dopo più di 5 min', async () => {
  const page = startPage({ timeScale: FAST, config: APIS, routes: routesOf({ [VM.url]: healthy(404), [RENDER.url]: healthy(505) }) });
  await page.waitStatus(/in mappa/);
  const end = page.pageNow() + MIN5 + 60000;
  while (page.pageNow() < end) { await page.tick(); await sleep(10); }
  const vmReq = on(page, VM.url);
  assert.equal(vmReq.filter(isStatus(VM.url)).length, vmReq.filter(isView).length, 'un /status e una vista per giro, niente prove');
  assert.equal(on(page, RENDER.url).length, 0, 'Render mai chiamato');
});

test('pagina: scheda nascosta → la prova della VM continua ogni 5 min; tornata visibile su Render → prova subito, attesa prima della vista', async () => {
  let vmUp = false;
  const vm = (path, now) => (vmUp ? healthy(606)(path, now) : { status: 503 });
  const page = startPage({ timeScale: FAST, config: APIS, session: { [KEY]: RENDER.url },
    routes: routesOf({ [VM.url]: vm, [RENDER.url]: healthy(707) }) });
  await page.waitStatus(/ · server di riserva \(Render\)$/);
  const vmViews = () => views(page, VM.url);
  assert.equal(vmViews().length, 1, 'ricaricando: una prova subito (503 → resta su Render)');
  page.setHidden(true);
  await ticksUntil(page, () => vmViews().length >= 2, 'prova con la scheda nascosta', MIN5 + 30000);
  const hiddenGap = vmViews()[1].at - vmViews()[0].end;
  assert.ok(hiddenGap >= MIN5 - SLACK && hiddenGap < MIN5 + 10000, `scheda nascosta: prova dopo 5 min (${hiddenGap} ms)`);
  await until(() => vmViews()[1].outcome === 503, 'prova finita');
  await sleep(20);
  assert.match(page.status(), /riserva/);
  vmUp = true;   // la prossima prova sarebbe fra 5 min, ma la scheda torna visibile
  const renderViews = views(page, RENDER.url).length;
  page.setHidden(false);   // visibilitychange: la pagina fa subito un giro
  await until(() => page.markers().has(606) && !/riserva/.test(page.status()), 'navi della VM', 1000);
  assert.ok(vmViews().length >= 3);
  assert.ok(vmViews()[2].at - vmViews()[1].end < 60000, 'prova subito, senza aspettare i 5 min');
  assert.equal(views(page, RENDER.url).length, renderViews, 'la vista del giro non è andata a Render: la pagina ha atteso la prova');
  assert.equal(page.storage.get(KEY), VM.url);
});

test('pagina: entrambi giù, Render sbagliato da poco → «in avvio» solo la prima volta, poi «riprovo tra N s»', async () => {
  const page = startPage({ timeScale: FAST, config: APIS, routes: routesOf({ [VM.url]: DEAD, [RENDER.url]: DEAD }) });
  const samples = [];
  const end = page.pageNow() + 10 * 60 * 1000;   // i giri li fanno i tentativi programmati
  while (page.pageNow() < end) { samples.push([page.pageNow(), page.status()]); await sleep(2); }
  const waking = samples.filter(([, s]) => /in avvio/.test(s));
  assert.ok(waking.length > 0, 'la prima volta Render è «in avvio»');
  // l'avvio finisce al primo errore di Render oltre i 90 s; poi la pagina torna a provare la VM
  const firstWake = waking[0][0];
  const back = views(page, VM.url).find(v => v.at > firstWake);
  assert.ok(back && back.at - firstWake >= 90000, 'la VM si riprova solo dopo i 90 s di avvio');
  const late = waking.filter(([t]) => t > back.end);
  assert.equal(late.length, 0, `«in avvio» di nuovo dopo il primo avvio: ${late[0]?.[1]}`);
  const rendersAfter = views(page, RENDER.url).filter(v => v.at > back.at).length;
  assert.ok(rendersAfter >= 1, `Render riprovato dopo il primo avvio (${rendersAfter})`);
  assert.ok(samples.some(([t, s]) => t > back.end
    && / · Mondo: server non raggiungibile, riprovo tra \d+ s \(ora solo Baltico\)$/.test(s)), 'poi «riprovo tra N s»');
});
