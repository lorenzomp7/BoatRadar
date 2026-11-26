// Punto 12: ricerca nella pagina (boatradar.html) senza browser (test/pagina-helpers.js). Attesa di 250 ms fra i tasti,
// richiesta precedente annullata (AbortController, senza errori), unione dei risultati del server attivo con le navi in
// mappa nello stesso ordine del server (searchScore, compareSearch), righe role="option" con nome, MMSI, «tipo ·
// bandiera · lunghezza · età · → destinazione» e «N navi con questo nome»; tastiera (frecce, Invio, Esc) e ARIA
// (combobox e listbox). La verifica nel browser vero è lo scenario «ricerca» di tools/smoke-browser.sh (le due GEMELLA).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startPage: start, until, sleep, TIME_SCALE } = require('./pagina-helpers');

const html = fs.readFileSync(path.join(__dirname, '..', 'boatradar.html'), 'utf8');
const open = [];
const startPage = opts => { const p = start(opts); open.push(p); return p; };
afterEach(() => { while (open.length) open.pop().stop(); });

const MIN = 60000;
const ship = (mmsi, props) => ({ type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [8.9, 44.42] }, properties: { mmsi, ...props } });
// in mappa: una GEMELLA (247555002) che il server non restituisce (per esempio dal Baltico) e GEMELLA BIS
const features = now => [
  ship(247555002, { name: 'GEMELLA', shipType: 70, sog: 0, navStat: 5, timestampExternal: now() - 3 * MIN }),
  ship(247555009, { name: 'GEMELLA BIS', shipType: 70, sog: 0, navStat: 5, timestampExternal: now() - MIN }),
  ship(247123450, { name: 'LAGUNA PRIMA', shipType: 70, sog: 11, timestampExternal: now() - MIN }),
];
// dal server: la GEMELLA più recente (con tipo, lunghezza e destinazione) e una che contiene il nome
const remote = now => [
  { mmsi: 247555001, name: 'GEMELLA', shipType: 70, length: 80, destination: 'GENOVA', callSign: 'IGEM1', lat: 44.42, lon: 8.9,
    sog: 0, navStat: 5, timestampExternal: now() - MIN },
  { mmsi: 636000001, name: 'XGEMELLAX', lat: 6, lon: -10, sog: 12, navStat: 0, timestampExternal: now() - 2 * MIN },
];

function routes(over = {}) {
  return (url, now) => {
    if (url.includes('digitraffic')) return url.endsWith('/vessels') ? { body: [] } : { body: { type: 'FeatureCollection', features: [] } };
    if (url === '/api/status') return { body: () => ({ hasKey: true, connected: true, vessels: 3, serverTime: now() }) };
    if (url.startsWith('/api/vessel')) return { body: null };
    if (url.startsWith('/api/search')) return over.search ? over.search(url, now) : { body: () => remote(now) };
    if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 3, features: features(now) }) };
  };
}
async function ready(over) {
  const page = startPage({ routes: routes(over) });
  await until(() => page.markers().size === 3, 'tre navi in mappa');
  return page;
}
const searches = page => page.requests.filter(r => r.url.startsWith('/api/search'));
const type = (page, text) => { page.el('q').value = text; page.dispatch('q', 'input'); };
const key = (page, k) => page.dispatch('q', 'keydown', { key: k });
const rows = page => [...page.el('results').innerHTML.matchAll(/<div role="option" id="res-(\d+)"/g)].map(m => Number(m[1]));
const shown = page => page.el('results').style.display === 'block';
// attesa in ms della pagina (i timer corrono TIME_SCALE volte più veloci)
const wait = ms => sleep(ms / TIME_SCALE);

test('pagina: campo e risultati con i ruoli ARIA di combobox e listbox', () => {
  const q = html.match(/<input id="q"[^>]*>/)[0];
  for (const a of ['role="combobox"', 'aria-autocomplete="list"', 'aria-expanded="false"', 'aria-controls="results"', 'aria-label="'])
    assert.ok(q.includes(a), `#q: ${a}`);
  assert.match(html, /<div id="results" role="listbox" aria-label="[^"]+"><\/div>/);
});

test('pagina: una sola richiesta 250 ms dopo l\'ultimo tasto; sotto i 2 caratteri nessuna', async () => {
  const page = await ready();
  type(page, 'g');
  type(page, 'ge');
  await wait(100);
  type(page, 'gem');
  await wait(150);
  assert.equal(searches(page).length, 0, '250 ms dall\'ultimo tasto non ancora passati');
  await until(() => searches(page).length === 1 && shown(page), 'una richiesta e i risultati');
  assert.equal(searches(page)[0].url, '/api/search?q=GEM');
  type(page, 'g');
  assert.equal(shown(page), false, 'meno di 2 caratteri: elenco chiuso');
  assert.equal(page.el('q').getAttribute('aria-expanded'), 'false');
  await wait(400);
  assert.equal(searches(page).length, 1, 'nessuna richiesta per 1 carattere');
});

test('pagina: una ricerca nuova annulla quella in corso senza errori, e la risposta vecchia non arriva mai nell\'elenco', async () => {
  const errors = [];
  const page = await ready({ search: (url, now) => (url.endsWith('=GEMEL') ? { hang: true }
    : { body: () => remote(now).filter(v => v.mmsi === 636000001) }) });
  page.ctx.console = { ...console, error: (...a) => errors.push(a) };
  type(page, 'gemel');
  await until(() => searches(page).length === 1, 'prima richiesta');
  type(page, 'xgemel');
  await until(() => searches(page)[0].outcome === 'annullata', 'prima richiesta annullata subito al tasto');
  await until(() => searches(page).length === 2 && shown(page), 'seconda richiesta e risultati');
  assert.deepEqual(rows(page), [636000001]);
  assert.equal(errors.length, 0, 'nessun errore in console');
  assert.doesNotMatch(page.status(), /Errore/);
});

test('pagina: risultati del server e navi in mappa uniti e ordinati; omonimi riconoscibili', async () => {
  const page = await ready();
  type(page, 'gemella');
  await until(() => shown(page), 'risultati');
  // nome esatto (90) per posizione più recente, poi inizio del nome (70), poi contenuto (30)
  assert.deepEqual(rows(page), [247555001, 247555002, 247555009, 636000001]);
  const res = page.el('results').innerHTML;
  const row = mmsi => res.match(new RegExp(`<div role="option" id="res-${mmsi}"[^]*?</div>`))[0];
  assert.match(row(247555001), /data-mmsi="247555001"/);
  assert.match(row(247555001), /aria-selected="false"/);
  assert.match(row(247555001), /<b id="res-247555001-n">GEMELLA<\/b>/);
  assert.match(row(247555001), /247555001/, 'MMSI accanto al nome');
  assert.match(row(247555001), /Nave cargo · Italia · 80 m · 1 min fa · → GENOVA/);
  assert.match(row(247555001), /class="age age-verde"/, 'pallino dell\'età (punto 62)');
  assert.match(row(247555002), /Nave cargo · Italia · 3 min fa/, 'nave in mappa: età dal marker, parti mancanti omesse');
  for (const m of [247555001, 247555002]) assert.match(row(m), /2 navi con questo nome/, `omonima ${m}`);
  for (const m of [247555009, 636000001]) assert.doesNotMatch(row(m), /navi con questo nome/);
  assert.match(row(636000001), /<small id="res-636000001-d">Liberia · 2 min fa<\/small>/, 'senza tipo, lunghezza e destinazione: bandiera ed età');
  assert.equal(page.el('q').getAttribute('aria-expanded'), 'true');
  assert.equal(page.get('meta').get(247555001).sog, undefined, 'velocità e stato non finiscono nei dati statici');
});

test('pagina: frecce, Invio ed Esc sui risultati', async () => {
  const page = await ready();
  page.el('q').focus();
  type(page, 'gemella');
  await until(() => shown(page), 'risultati');
  const q = page.el('q');
  const active = () => q.getAttribute('aria-activedescendant');
  const selected = () => [...page.el('results').innerHTML.matchAll(/id="res-(\d+)"[^>]*aria-selected="true"/g)].map(m => Number(m[1]));
  assert.equal(active(), null);
  assert.equal(key(page, 'ArrowDown').defaultPrevented, true, 'la freccia non sposta il cursore nel campo');
  assert.equal(active(), 'res-247555001');
  assert.deepEqual(selected(), [247555001]);
  key(page, 'ArrowDown');
  assert.equal(active(), 'res-247555002');
  key(page, 'ArrowUp');
  key(page, 'ArrowUp');
  assert.equal(active(), 'res-636000001', 'dal primo la freccia su va all\'ultimo');
  key(page, 'ArrowDown');
  assert.equal(active(), 'res-247555001', 'dall\'ultimo la freccia giù torna al primo');
  key(page, 'ArrowDown');

  // Invio apre la scheda della riga attiva e chiude l'elenco
  const enter = key(page, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  await enter.results[0];
  assert.equal(page.get('selected'), 247555002);
  assert.equal(page.el('panel').style.display, 'block');
  assert.equal(shown(page), false);
  assert.equal(q.getAttribute('aria-expanded'), 'false');
  assert.equal(active(), null);

  // Esc: prima l'elenco (riaperto con la freccia giù), poi la scheda
  key(page, 'ArrowDown');
  assert.equal(shown(page), true, 'la freccia riapre l\'elenco');
  page.keydown('Escape', q);
  assert.equal(shown(page), false, 'Esc chiude l\'elenco');
  assert.equal(page.el('panel').style.display, 'block', 'ma non la scheda');
  page.keydown('Escape', q);
  assert.equal(page.el('panel').style.display, 'none', 'il secondo Esc chiude la scheda');
});

test('pagina: Invio senza riga scelta apre il primo risultato; clic su una riga apre la sua scheda', async () => {
  const page = await ready();
  type(page, 'gemella');
  await until(() => shown(page), 'risultati');
  await key(page, 'Enter').results[0];
  assert.equal(page.get('selected'), 247555001);
  type(page, 'xgem');
  await until(() => shown(page), 'risultati');
  const click = page.el('results').listeners.find(l => l.type === 'click').fn;
  await click({ target: { closest: () => ({ dataset: { mmsi: '636000001' } }) } });
  assert.equal(page.get('selected'), 636000001);
  assert.equal(shown(page), false);
});

test('pagina: «Nessun risultato» non selezionabile; con il server che non risponde restano le navi in mappa', async () => {
  const page = await ready({ search: (url, now) => (url.endsWith('=ZZZ') ? { body: [] } : { fail: true }) });
  type(page, 'zzz');
  await until(() => shown(page), 'elenco');
  assert.match(page.el('results').innerHTML, /<div class="none" role="option" aria-disabled="true"[^>]*>Nessun risultato<\/div>/);
  assert.equal(key(page, 'ArrowDown').defaultPrevented, false);
  assert.equal(page.el('q').getAttribute('aria-activedescendant'), null);
  key(page, 'Enter');
  assert.equal(page.get('selected'), null);
  type(page, 'laguna');
  await until(() => rows(page).length === 1, 'nave in mappa senza il server');
  assert.deepEqual(rows(page), [247123450]);
});

// --- Correzioni da revisione del punto 12 -------------------------------------------------------------------------------

const liveText = page => page.el('search-live').textContent;

test('pagina: mentre la ricerca nuova è in corso i risultati vecchi non si scelgono (Invio, frecce, clic)', async () => {
  const page = await ready({ search: (url, now) => (url.endsWith('=XGEM') ? { hang: true } : { body: () => remote(now) }) });
  type(page, 'gemella');
  await until(() => shown(page) && rows(page).length === 4, 'risultati di «gemella»');
  type(page, 'xgem');
  assert.deepEqual(rows(page), [], 'subito al tasto: niente righe vecchie');
  assert.match(page.el('results').innerHTML, /aria-disabled="true"[^>]*>In aggiornamento…</);
  await until(() => searches(page).length === 2, 'richiesta di «xgem» partita (e appesa)');
  assert.equal(key(page, 'ArrowDown').defaultPrevented, false, 'le frecce non scelgono righe vecchie');
  assert.equal(page.el('q').getAttribute('aria-activedescendant'), null);
  await key(page, 'Enter').results[0];
  const click = page.el('results').listeners.find(l => l.type === 'click').fn;
  await click({ target: { closest: () => ({ dataset: { mmsi: '247555001' } }) } });
  assert.equal(page.get('selected'), null, 'nessuna scheda aperta da una ricerca superata');
  assert.equal(page.el('panel').style.display === 'block', false);
});

test('pagina: Invio durante l\'attesa apre il primo risultato della ricerca nuova quando arriva', async () => {
  const page = await ready({ search: (url, now) => (url.endsWith('=XGEM') ? { delay: 150, body: () => remote(now).slice(1) } : { body: () => remote(now) }) });
  type(page, 'gemella');
  await until(() => shown(page) && rows(page).length === 4, 'risultati di «gemella»');
  type(page, 'xgem');
  const enter = key(page, 'Enter');
  assert.equal(enter.defaultPrevented, true, 'Invio non invia nulla mentre si aspetta');
  await enter.results[0];
  assert.equal(page.get('selected'), null, 'non subito: la ricerca nuova non è ancora arrivata');
  await until(() => page.get('selected') === 636000001, 'scheda del primo risultato di «xgem»');
  assert.equal(shown(page), false);
  // un tasto dopo Invio annulla l'apertura
  type(page, 'gemella');
  key(page, 'Enter');
  type(page, 'gemell');
  await until(() => shown(page) && rows(page).length === 4, 'risultati di «gemell»');
  assert.equal(page.get('selected'), 636000001, 'il testo è cambiato dopo Invio: nessuna apertura');
});

test('pagina: solo risultati del server con MMSI intero positivo; testi e attributi sempre escapati', async () => {
  const page = await ready({ search: (url, now) => ({ body: () => [
    { mmsi: 247000777, name: '<img src=x onerror=alert(1)>', destination: '"><script>alert(2)</script>', lat: 1, lon: 1, timestampExternal: now() - MIN },
    { mmsi: '1" onmouseover="alert(3)', name: 'IMGX', lat: 1, lon: 1, timestampExternal: now() - MIN },
    { mmsi: '247000778', name: 'IMGSTRINGA', lat: 1, lon: 1, timestampExternal: now() - MIN },
    { mmsi: 0, name: 'IMGZERO', lat: 1, lon: 1 }, { mmsi: 2.5, name: 'IMGDEC', lat: 1, lon: 1 }, { mmsi: -3, name: 'IMGNEG', lat: 1, lon: 1 },
    null, 'IMG',
  ] }) });
  type(page, 'img');
  await until(() => shown(page), 'risultati');
  const h = page.el('results').innerHTML;
  assert.deepEqual(rows(page), [247000777]);
  assert.doesNotMatch(h, /<img|<script|onmouseover/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h, /→ &quot;&gt;&lt;script&gt;/);
  assert.equal(page.get('meta').has('1" onmouseover="alert(3)'), false, 'nessun dato salvato per MMSI non validi');
});

test('pagina: accenti e trattini nella ricerca fra le navi in mappa («città di» → CITTA DI GENOVA)', async () => {
  const page = startPage({ routes: (url, now) => {
    if (url.startsWith('/api/locations?')) return { body: () => ({ type: 'FeatureCollection', total: 2, features: [
      ship(247123460, { name: 'CITTA DI GENOVA', shipType: 60, sog: 11, timestampExternal: now() - MIN }),
      ship(247123461, { name: 'MSC ANNA-MARIA', shipType: 70, sog: 11, timestampExternal: now() - MIN })] }) };
    if (url.startsWith('/api/search')) return { body: [] };
    return routes()(url, now);
  } });
  await until(() => page.markers().size === 2, 'navi in mappa');
  type(page, 'città di');
  await until(() => shown(page) && rows(page).length, 'risultati');
  assert.deepEqual(rows(page), [247123460]);
  assert.equal(searches(page).at(-1).url, '/api/search?q=CITTA%20DI', 'al server la query normalizzata');
  type(page, 'anna maria');
  await until(() => rows(page)[0] === 247123461, 'MSC ANNA-MARIA');
  assert.match(page.el('results').innerHTML, /<b id="res-247123461-n">MSC ANNA-MARIA<\/b>/, 'il nome mostrato resta quello AIS');
  type(page, 'IMO 1234');
  await until(() => searches(page).at(-1).url === '/api/search?q=1234', 'prefisso «IMO » tolto');
});

test('pagina: «almeno N navi con questo nome» quando i risultati possono essere incompleti', async () => {
  const many = now => Array.from({ length: 25 }, (_, i) => ({ mmsi: 247700001 + i, name: 'GEMELLA', lat: 44, lon: 9, timestampExternal: now() - MIN }));
  const page = await ready({ search: (url, now) => ({ body: url.endsWith('=GEMELLA') ? many(now) : url.endsWith('=2475550') ? remote(now).slice(0, 1) : remote(now) }) });
  type(page, 'gemella');
  await until(() => shown(page), 'risultati');
  assert.equal(rows(page).length, 25, 'tetto di 25');
  assert.match(page.el('results').innerHTML, /almeno 25 navi con questo nome/, 'il server ne ha tenute 25: forse altre');
  // per MMSI: le omonime con un altro MMSI non corrispondono, quindi il conteggio può essere incompleto
  type(page, '2475550');
  await until(() => shown(page) && rows(page).length === 3, 'risultati per MMSI');
  assert.match(page.el('results').innerHTML, /almeno 2 navi con questo nome/);
  // per nome, sotto il tetto: tutte le omonime corrispondono, conteggio esatto
  type(page, 'gemell');
  await until(() => shown(page) && rows(page).length === 4, 'risultati per nome');
  assert.match(page.el('results').innerHTML, />2 navi con questo nome</);
  assert.doesNotMatch(page.el('results').innerHTML, /almeno/);
});

test('pagina: regione aria-live annuncia il numero di risultati; MMSI fuori dal nome accessibile', async () => {
  assert.match(html, /<div id="search-live" class="sr-only" aria-live="polite"[^>]*><\/div>/);
  assert.match(html, /\.sr-only\s*\{[^}]*clip/);
  const page = await ready({ search: (url, now) => ({ body: url.endsWith('=ZZZ') ? [] : url.endsWith('=XGEMELLA') ? remote(now).slice(1) : remote(now) }) });
  type(page, 'gemella');
  await until(() => shown(page), 'risultati');
  assert.equal(liveText(page), '4 risultati');
  const row = page.el('results').innerHTML.match(/<div role="option" id="res-247555001"[^>]*>/)[0];
  assert.match(row, /aria-labelledby="res-247555001-n"/, 'nome accessibile = solo il nome');
  assert.match(row, /aria-describedby="res-247555001-d res-247555001-t res-247555001-m"/);
  const bis = page.el('results').innerHTML.match(/<div role="option" id="res-247555009"[^>]*>/)[0];
  assert.match(bis, /aria-describedby="res-247555009-d res-247555009-m"/, 'solo le parti che ci sono (niente omonimi)');
  assert.match(page.el('results').innerHTML, /<span class="mmsi" id="res-247555001-m"><span class="sr-only">MMSI <\/span>247555001<\/span>/);
  type(page, 'xgemella');
  await until(() => shown(page) && rows(page).length === 1, 'un risultato');
  assert.equal(liveText(page), '1 risultato');
  type(page, 'zzz');
  await until(() => liveText(page) === 'Nessun risultato', 'nessun risultato annunciato');
  type(page, 'z');
  assert.equal(liveText(page), '', 'elenco chiuso: niente da annunciare');
});
