// Punto 86 (b): scelta del backend nella pagina, funzioni pure di public/ais-logic.js.
// apiList legge config.js (window.BOATRADAR_APIS / BOATRADAR_API); createFailover decide quando passare al
// server successivo (solo su errore della richiesta della vista: sulla VM dopo due errori di fila), quanto aspettare prima
// di riprovare e quando provare il primo per tornarci (shouldRecheck, recheckOk, recheckFailed); networkDown dice quando
// l'errore è della rete dell'utente e non deve contare.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiList, createFailover, createRecheck, networkDown } = require('../public/ais-logic');

const VM = { url: 'https://boatradar.130-61-10-20.sslip.io/api', name: 'VM Oracle', sleeps: false };
const RENDER = { url: 'https://boatradar-x.onrender.com/api', name: 'Render', sleeps: true };
const urls = list => list.map(b => b.url);

test('apiList: senza configurazione il server della pagina stessa (/api)', () => {
  for (const cfg of [undefined, null, {}, { BOATRADAR_APIS: [] }, { BOATRADAR_APIS: 'x' }, { BOATRADAR_API: '' }]) {
    const list = apiList(cfg);
    assert.equal(list.length, 1);
    assert.equal(list[0].url, '/api');
    assert.equal(list[0].sleeps, false);
  }
});

test('apiList: elenco di oggetti di config.js, ordine conservato, / finale tolta', () => {
  const list = apiList({ BOATRADAR_APIS: [{ ...VM, url: VM.url + '/' }, { ...RENDER, url: RENDER.url + '//' }] });
  assert.deepEqual(list, [VM, RENDER]);
});

test('apiList: stringhe e oggetti misti; nome mancante = null, sleeps solo se true', () => {
  const list = apiList({ BOATRADAR_APIS: ['https://a.example/api', { url: 'https://b.example/api', sleeps: 'sì' }, RENDER] });
  assert.deepEqual(list, [
    { url: 'https://a.example/api', name: null, sleeps: false },
    { url: 'https://b.example/api', name: null, sleeps: false },
    RENDER]);
});

test('apiList: doppioni (anche con la / finale) contati una volta sola', () => {
  assert.deepEqual(urls(apiList({ BOATRADAR_APIS: [VM, VM.url + '/', RENDER, { ...VM, name: 'altro' }] })), [VM.url, RENDER.url]);
});

test('apiList: voci non valide scartate', () => {
  const list = apiList({ BOATRADAR_APIS: [null, 3, {}, { url: 5 }, '', '   ', 'javascript:alert(1)', 'https://x y/api',
    'https://x"y/api', 'ftp://x/api', '/', RENDER] });
  assert.deepEqual(list, [RENDER]);
});

test('apiList: senza BOATRADAR_APIS valido si usa BOATRADAR_API, poi /api', () => {
  assert.deepEqual(urls(apiList({ BOATRADAR_API: 'https://solo.example/api/' })), ['https://solo.example/api']);
  assert.deepEqual(urls(apiList({ BOATRADAR_APIS: [], BOATRADAR_API: 'https://solo.example/api' })), ['https://solo.example/api']);
  assert.deepEqual(urls(apiList({ BOATRADAR_APIS: ['bad url'], BOATRADAR_API: 'https://solo.example/api' })), ['https://solo.example/api']);
  assert.deepEqual(urls(apiList({ BOATRADAR_APIS: [VM], BOATRADAR_API: 'https://altro.example/api' })), [VM.url]);
  assert.deepEqual(urls(apiList({ BOATRADAR_API: 'non valido' })), ['/api']);
});

test('createFailover: parte dal primo, o dal server salvato nella sessione se è nell\'elenco', () => {
  assert.equal(createFailover([VM, RENDER]).current().url, VM.url);
  assert.equal(createFailover([VM, RENDER], { saved: RENDER.url }).current().url, RENDER.url);
  assert.equal(createFailover([VM, RENDER], { saved: 'https://sconosciuto/api' }).current().url, VM.url);
  assert.equal(createFailover([VM, RENDER], { saved: null }).current().url, VM.url);
  const f = createFailover([VM, RENDER]);
  assert.equal(f.canTry(0), true);
  assert.equal(f.retryIn(0), 0);
  assert.equal(f.waking(), false);
});

// La VM (sleeps false) si lascia solo dopo due errori di fila della vista: il primo la fa riprovare dopo 3 s
// (correzione da revisione: un errore isolato non deve far consumare la quota di Render).
const SEC3 = 3000;
const downVM = (f, t) => { f.fail(VM.url, t); f.fail(VM.url, t + SEC3); return t + SEC3; };

test('createFailover: un errore isolato della VM non fa passare a Render; la VM si riprova dopo 3 s', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  assert.equal(f.current().url, VM.url, 'primo errore: resta sulla VM');
  assert.equal(f.retryIn(0), SEC3);
  assert.equal(f.canTry(SEC3 - 1), false);
  assert.equal(f.canTry(SEC3), true);
  assert.equal(f.waking(), false);
  f.ok(VM.url, SEC3);
  assert.equal(f.current().url, VM.url);
  f.fail(VM.url, 60000);           // un altro errore isolato più tardi: di nuovo il primo della serie
  assert.equal(f.current().url, VM.url, 'la risposta in mezzo azzera la serie');
  assert.deepEqual(changes, []);
});

test('createFailover: due errori di fila della VM → Render', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  f.fail(VM.url, SEC3);
  assert.equal(f.current().url, RENDER.url);
  assert.deepEqual(changes, [RENDER.url]);
  assert.equal(f.retryIn(SEC3), 0, 'Render si prova subito');
});

test('createFailover: errori che non contano (rete assente) → attesa crescente separata (3, 5, 10, 20, 40, 60 s), mai a Render', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  const waits = [];
  let t = 0;
  for (let i = 0; i < 40; i++) { f.fail(VM.url, t, { counts: false }); waits.push(f.retryIn(t)); t += f.retryIn(t); }
  assert.deepEqual(waits.slice(0, 7), [3000, 5000, 10000, 20000, 40000, 60000, 60000]);
  assert.ok(waits.slice(6).every(w => w === 60000), 'poi sempre 60 s');
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, []);
  f.fail(VM.url, t);               // poi un errore vero: è il primo della serie (conferma dopo 3 s)
  assert.equal(f.current().url, VM.url);
  assert.equal(f.retryIn(t), SEC3);
  f.fail(VM.url, t + SEC3, { counts: false });   // in mezzo un errore che non conta: la serie resta a 1, attesa da capo
  assert.equal(f.current().url, VM.url);
  assert.equal(f.retryIn(t + SEC3), SEC3, 'dopo un errore vero l\'attesa della rete assente riparte da 3 s');
  f.fail(VM.url, t + 2 * SEC3);
  assert.equal(f.current().url, RENDER.url, 'secondo errore vero');
});

test('createFailover: una risposta azzera l\'attesa della rete assente', () => {
  const f = createFailover([VM]);
  f.fail(VM.url, 0, { counts: false });
  f.fail(VM.url, 3000, { counts: false });
  assert.equal(f.retryIn(3000), 5000);
  f.ok(VM.url, 8000);
  f.fail(VM.url, 9000, { counts: false });
  assert.equal(f.retryIn(9000), 3000);
});

test('createFailover: networkBack (evento online) → si riprova subito, solo dopo errori che non contano', () => {
  const f = createFailover([VM, RENDER]);
  let t = 0;
  for (let i = 0; i < 5; i++) { f.fail(VM.url, t, { counts: false }); t += f.retryIn(t); }
  f.fail(VM.url, t, { counts: false });
  assert.equal(f.retryIn(t), 60000);
  assert.equal(f.networkBack(t + 1000), true);
  assert.equal(f.canTry(t + 1000), true, 'rete tornata: subito');
  f.fail(VM.url, t + 2000, { counts: false });
  assert.equal(f.retryIn(t + 2000), 3000, 'l\'attesa della rete assente riparte da 3 s');
  assert.equal(f.networkBack(t + 2100), true);
  // dopo un errore vero networkBack non tocca l'attesa (il server ha sbagliato, la rete c'era)
  const g = createFailover([VM]);
  g.fail(VM.url, 0); g.fail(VM.url, 3000);
  assert.equal(g.retryIn(3000), 5000);
  assert.equal(g.networkBack(4000), false);
  assert.equal(g.canTry(4000), false);
  assert.equal(createFailover([VM]).networkBack(0), false, 'nessun errore: niente da fare');
});

test('createFailover: VM giù → Render, che si sveglia con attese crescenti; dopo 90 s senza risposta torna alla VM', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  const t0 = downVM(f, 0);   // 3000: passaggio; la VM si riprova da 3000 + 5000
  assert.equal(f.current().url, RENDER.url, 'passa a Render');
  assert.deepEqual(changes, [RENDER.url]);
  assert.equal(f.canTry(t0), true);
  assert.equal(f.waking(), false);
  f.fail(RENDER.url, t0 + 1000);
  assert.equal(f.current().url, RENDER.url, 'Render si addormenta: entro 90 s dal primo errore resta (niente conferma)');
  assert.equal(f.waking(), true);
  assert.equal(f.retryIn(t0 + 1000), 5000);
  f.fail(RENDER.url, t0 + 7000);
  assert.equal(f.retryIn(t0 + 7000), 10000, 'attesa doppia');
  assert.equal(f.waking(), true);
  f.fail(RENDER.url, t0 + 95000);
  assert.equal(f.current().url, VM.url, 'oltre 90 s dal primo errore: torna alla VM (attesa scaduta da tempo)');
  assert.equal(f.waking(), false);
  assert.equal(f.retryIn(t0 + 95000), 0);
  assert.deepEqual(changes, [RENDER.url, VM.url], 'onChange solo ai cambi');
});

test('createFailover: la risposta di Render chiude l\'avvio; dopo, un suo errore passa subito alla VM', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  f.fail(RENDER.url, t0 + 1000);
  assert.equal(f.waking(), true);
  f.ok(RENDER.url, t0 + 2000);
  assert.equal(f.waking(), false);
  assert.equal(f.retryIn(t0 + 2000), 0, 'ok azzera l\'attesa');
  assert.equal(f.current().url, RENDER.url, 'la risposta di Render non riporta alla VM (lo fa solo la prova del primo)');
  f.fail(RENDER.url, t0 + 20000);
  assert.equal(f.current().url, VM.url, 'Render ha già risposto: niente attesa di avvio');
});

test('createFailover: la VM che risponde non fa mai passare a Render', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  for (let t = 0; t < 10; t++) f.ok(VM.url, t);
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, []);
});

test('createFailover: tutti giù → resta su quello che si può riprovare prima', () => {
  const A = { url: 'https://a/api', name: 'A', sleeps: false }, B = { url: 'https://b/api', name: 'B', sleeps: false };
  const f = createFailover([A, B]);
  f.fail(A.url, 0);       // A: conferma a 3000
  f.fail(A.url, 3000);    // A: secondo errore, riprova a 8000 → B
  assert.equal(f.current().url, B.url);
  f.fail(B.url, 3100);    // B: conferma a 6100
  assert.equal(f.current().url, B.url);
  f.fail(B.url, 6100);    // B: riprova a 11100; A non è ancora pronta (8000) → la più vicina è A
  assert.equal(f.current().url, A.url);
  assert.equal(f.canTry(6100), false);
  assert.equal(f.retryIn(6100), 1900);
  f.fail(A.url, 8000);    // A appena tornata attiva: di nuovo conferma (11000)
  assert.equal(f.current().url, A.url);
  f.fail(A.url, 11000);   // A: riprova a 21000; B pronta a 11100 → la più vicina, B
  assert.equal(f.current().url, B.url);
  assert.equal(f.retryIn(11000), 100);
});

test('createFailover: un solo backend resta e aspetta sempre di più: 3 s, poi 5 s fino a 60 s', () => {
  const changes = [];
  const f = createFailover([VM], { onChange: b => changes.push(b.url) });
  const waits = [];
  let t = 0;
  for (let i = 0; i < 7; i++) { f.fail(VM.url, t); waits.push(f.retryIn(t)); t += f.retryIn(t); }
  assert.deepEqual(waits, [3000, 5000, 10000, 20000, 40000, 60000, 60000]);
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, []);
});

test('createFailover: errori o risposte in ritardo di un server non più attivo non cambiano nulla', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  f.fail(VM.url, 10);     // seconda richiesta alla VM partita insieme alla prima: non conta
  assert.equal(f.current().url, VM.url);
  f.fail(VM.url, SEC3);
  assert.equal(f.current().url, RENDER.url);
  f.fail(VM.url, SEC3 + 10);   // richiesta alla VM partita prima del cambio
  assert.equal(f.current().url, RENDER.url);
  assert.equal(f.retryIn(SEC3 + 10), 0);
  f.ok(VM.url, SEC3 + 20);     // risposta tardiva della VM: non riporta alla VM (lo fa solo la prova del primo)
  assert.equal(f.current().url, RENDER.url);
  assert.deepEqual(changes, [RENDER.url]);
});

test('createFailover: un errore arrivato durante l\'attesa (richiesta partita prima) non raddoppia l\'attesa', () => {
  const f = createFailover([VM]);
  f.fail(VM.url, 0);
  f.fail(VM.url, 300);
  assert.equal(f.retryIn(300), 2700);
  f.fail(VM.url, 3000);   // tentativo programmato: conta
  assert.equal(f.retryIn(3000), 5000);
  f.fail(VM.url, 3300);
  assert.equal(f.retryIn(3300), 4700);
  f.fail(VM.url, 8000);
  assert.equal(f.retryIn(8000), 10000);
});

const MIN = 60 * 1000;

test('createFailover: tornando su Render dopo più di 15 min dal suo ultimo contatto l\'attesa di avvio riparte da capo', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  f.ok(RENDER.url, t0 + 500);       // Render sveglio, poi la VM torna (ricaricando la scheda, per esempio)
  f.fail(RENDER.url, t0 + 1000);    // Render giù: torna alla VM
  assert.equal(f.current().url, VM.url);
  f.ok(VM.url, t0 + 2000);
  downVM(f, 60 * MIN);              // un'ora dopo la VM cade: Render può essersi addormentato di nuovo
  assert.equal(f.current().url, RENDER.url);
  f.fail(RENDER.url, 60 * MIN + 4000);
  assert.equal(f.current().url, RENDER.url, 'resta: Render si sta svegliando');
  assert.equal(f.waking(), true);
});

test('createFailover: entrambi giù, Render sbagliato da meno di 15 min → nessuna nuova attesa di avvio', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);               // Render da 3000
  f.fail(RENDER.url, t0 + 1000);         // avvio: 90 s
  assert.equal(f.waking(), true);
  f.fail(RENDER.url, t0 + 95000);        // avvio finito senza risposta → VM
  assert.equal(f.current().url, VM.url);
  let t = t0 + 95000;
  // poi per 10 min la pagina gira fra VM (due errori) e Render (un errore): Render mai più «in avvio»
  while (t < t0 + 10 * MIN) {
    t += f.retryIn(t);
    f.fail(f.current().url, t);
    assert.equal(f.waking(), false, `t = ${t}, su ${f.current().name}`);
  }
  assert.ok(t >= t0 + 10 * MIN);
});

test('createFailover: Render che ha risposto da meno di 15 min, se sbaglia dopo un ritorno, fa passare subito', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  f.ok(RENDER.url, t0 + 1000);
  assert.equal(f.shouldRecheck(t0 + 5 * MIN), true);
  f.recheckOk(VM.url, t0 + 5 * MIN);     // di nuovo sulla VM
  const t1 = downVM(f, t0 + 8 * MIN);    // la VM ricade dopo 3 min: Render ha risposto 8 min fa
  assert.equal(f.current().url, RENDER.url);
  f.fail(RENDER.url, t1 + 500);
  assert.equal(f.waking(), false, 'Render era sveglio: è un errore vero, niente «in avvio»');
  assert.equal(f.current().url, VM.url, 'passa subito al server da riprovare per primo, la VM');
  assert.equal(f.retryIn(t1 + 500), 4500);
});

test('createFailover: parametri baseMs, maxMs, confirmMs e wakeGraceMs', () => {
  const f = createFailover([RENDER, VM], { baseMs: 100, maxMs: 300, wakeGraceMs: 1000 });
  f.fail(RENDER.url, 0);
  assert.equal(f.retryIn(0), 100);
  assert.equal(f.waking(), true);
  f.fail(RENDER.url, 100); assert.equal(f.retryIn(100), 200);
  f.fail(RENDER.url, 300); assert.equal(f.retryIn(300), 300);
  f.fail(RENDER.url, 1000);
  assert.equal(f.current().url, VM.url);
  const g = createFailover([VM], { confirmMs: 50, baseMs: 100 });
  g.fail(VM.url, 0); assert.equal(g.retryIn(0), 50);
  g.fail(VM.url, 50); assert.equal(g.retryIn(50), 100);
});

// Ritorno automatico al server principale (quota di Render): su un server diverso dal primo, ogni recheckMs (5 min) una
// sola prova leggera del primo; se va bene si torna al primo, se no si resta e si riprova dopo altri recheckMs.
const MIN5 = 5 * MIN;

test('createFailover: sul primo server nessuna prova del primo', () => {
  const f = createFailover([VM, RENDER]);
  for (const t of [0, MIN5, 10 * MIN5, 100 * MIN5]) {
    assert.equal(f.shouldRecheck(t), false, `t = ${t}`);
    assert.equal(f.shouldRecheck(t, true), false, `t = ${t}, anche forzata`);
  }
  f.ok(VM.url, 0);
  assert.equal(f.shouldRecheck(1000 * MIN5), false);
  const solo = createFailover([RENDER]);
  solo.fail(RENDER.url, 0);
  assert.equal(solo.shouldRecheck(MIN5), false, 'un solo server: è già il primo');
});

test('createFailover: su Render dopo 5 min una prova del primo; risponde → si torna al primo (onChange)', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  const t0 = downVM(f, 1000);
  f.ok(RENDER.url, t0);
  assert.equal(f.shouldRecheck(t0), false);
  assert.equal(f.shouldRecheck(t0 + MIN5 - 1), false, 'prima di 5 min no');
  assert.equal(f.shouldRecheck(t0 + MIN5), true, 'a 5 min dal passaggio sì');
  assert.equal(f.current().url, RENDER.url, 'la prova da sola non cambia server');
  f.recheckOk(VM.url, t0 + MIN5);
  assert.equal(f.current().url, VM.url, 'torna al primo');
  assert.deepEqual(changes, [RENDER.url, VM.url]);
  assert.equal(f.canTry(t0 + MIN5), true, 'il primo si può chiedere subito');
  assert.equal(f.retryIn(t0 + MIN5), 0);
  assert.equal(f.waking(), false);
  assert.equal(f.shouldRecheck(t0 + 3 * MIN5), false, 'di nuovo sul primo: niente prove');
});

test('createFailover: mai più di una prova in corso', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  assert.equal(f.shouldRecheck(t0 + MIN5), true);
  assert.equal(f.shouldRecheck(t0 + MIN5), false, 'stessa ora: già in corso');
  assert.equal(f.shouldRecheck(t0 + MIN5, true), false, 'anche forzata');
  assert.equal(f.shouldRecheck(t0 + 3 * MIN5), false, 'anche molto dopo, finché la prova non finisce');
  f.recheckFailed(t0 + 3 * MIN5);
  assert.equal(f.shouldRecheck(t0 + 3 * MIN5), false, 'appena fallita: si aspetta');
  assert.equal(f.shouldRecheck(t0 + 4 * MIN5), true);
});

test('createFailover: prova forzata (scheda tornata visibile) → subito, anche prima dei 5 min', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  assert.equal(f.shouldRecheck(t0 + 1000), false);
  assert.equal(f.shouldRecheck(t0 + 1000, true), true, 'forzata: subito');
  f.recheckFailed(t0 + 2000);
  assert.equal(f.shouldRecheck(t0 + 2000 + MIN5 - 1), false, 'dopo una prova forzata fallita la prossima fra 5 min');
  assert.equal(f.shouldRecheck(t0 + 2000 + MIN5), true);
});

test('createFailover: prova fallita → si resta, riprova dopo altri 5 min, e non conta come errore del server attivo', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  const t0 = downVM(f, 0);
  f.fail(RENDER.url, t0 + 1000);             // Render in avvio
  f.ok(RENDER.url, t0 + 2000);
  const t = t0 + MIN5;
  assert.equal(f.shouldRecheck(t), true);
  f.recheckFailed(t + 8000);                 // nessuna risposta in 8 s
  assert.equal(f.current().url, RENDER.url, 'resta su Render');
  assert.equal(f.canTry(t + 8000), true, 'Render non ha nuove attese');
  assert.equal(f.retryIn(t + 8000), 0);
  assert.equal(f.waking(), false);
  assert.equal(f.shouldRecheck(t + 8000 + MIN5 - 1), false);
  assert.equal(f.shouldRecheck(t + 8000 + MIN5), true, 'altri 5 min dopo la prova fallita');
  f.recheckFailed(t + 8000 + MIN5 + 50);
  assert.equal(f.shouldRecheck(t + 8000 + 2 * MIN5 + 50), true, 'e così ogni 5 min');
  assert.deepEqual(changes, [RENDER.url]);
});

test('createFailover: partendo da Render salvato nella sessione la prima prova del primo è subito', () => {
  const f = createFailover([VM, RENDER], { saved: RENDER.url });
  assert.equal(f.shouldRecheck(50000), true, 'ricaricando la scheda: prova immediata');
  f.recheckFailed(58000);
  assert.equal(f.shouldRecheck(58000 + MIN5 - 1), false);
  assert.equal(f.shouldRecheck(58000 + MIN5), true);
  const g = createFailover([VM, RENDER], { saved: RENDER.url });
  assert.equal(g.shouldRecheck(1000), true);
  g.recheckOk(VM.url, 1500);
  assert.equal(g.current().url, VM.url, 'la VM risponde: si parte dalla VM');
});

test('createFailover: prova finita quando si è già tornati al primo per un errore → nessun cambio in più', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  const t0 = downVM(f, 0);
  f.ok(RENDER.url, t0);
  assert.equal(f.shouldRecheck(t0 + MIN5), true);
  f.fail(RENDER.url, t0 + MIN5 + 100);       // intanto Render sbaglia: si torna alla VM
  assert.equal(f.current().url, VM.url);
  f.recheckOk(VM.url, t0 + MIN5 + 200);      // la prova arriva dopo
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, [RENDER.url, VM.url], 'onChange una volta sola per il ritorno');
  // la VM cade di nuovo: le prove ripartono 5 min dopo il nuovo passaggio
  const t1 = downVM(f, t0 + 2 * MIN5);
  assert.equal(f.current().url, RENDER.url);
  assert.equal(f.shouldRecheck(t1 + MIN5 - 1), false);
  assert.equal(f.shouldRecheck(t1 + MIN5), true);
});

test('createFailover: recheckOk di un indirizzo che non è il primo non sposta nulla', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  assert.equal(f.shouldRecheck(t0 + MIN5), true);
  f.recheckOk('https://altro.example/api', t0 + MIN5);
  assert.equal(f.current().url, RENDER.url);
  assert.equal(f.shouldRecheck(t0 + MIN5 + 1), false, 'la prova è finita: si riprova dopo altri 5 min');
  assert.equal(f.shouldRecheck(t0 + 2 * MIN5 + 1), true);
});

test('createFailover: con tre server le prove riguardano solo il primo e non ripartono da capo fra secondo e terzo', () => {
  const A = { url: 'https://a/api', name: 'A', sleeps: false }, B = { url: 'https://b/api', name: 'B', sleeps: false },
    C = { url: 'https://c/api', name: 'C', sleeps: false };
  const f = createFailover([A, B, C]);
  f.fail(A.url, 0);
  f.fail(A.url, SEC3);                       // A → B a 3000
  f.fail(B.url, 4000);
  f.fail(B.url, 7000);                       // B → C: l'ora della prova resta quella del passaggio da A
  assert.equal(f.current().url, C.url);
  assert.equal(f.shouldRecheck(SEC3 + MIN5), true);
  f.recheckOk(A.url, SEC3 + MIN5);
  assert.equal(f.current().url, A.url);
});

test('createFailover: parametro recheckMs', () => {
  const f = createFailover([VM, RENDER], { recheckMs: 1000 });
  const t0 = downVM(f, 0);
  assert.equal(f.shouldRecheck(t0 + 999), false);
  assert.equal(f.shouldRecheck(t0 + 1000), true);
});

// Oscillazione: la VM risponde alla prova ma ricade poco dopo. Ricadute entro 10 min dal ritorno raddoppiano l'intervallo
// delle prove (5, 10, 20, al massimo 40 min); 30 min di VM stabile lo riportano a 5 min.
// Su Render da t; la prossima prova arriva dopo «every»: true a t + every, false un istante prima.
function nextRecheckAfter(f, t, every) {
  assert.equal(f.shouldRecheck(t + every - 1), false, `nessuna prova prima di ${every / MIN} min`);
  assert.equal(f.shouldRecheck(t + every), true, `prova a ${every / MIN} min`);
  return t + every;
}

test('createFailover: la VM che ricade entro 10 min dal ritorno raddoppia l\'intervallo delle prove fino a 40 min', () => {
  const f = createFailover([VM, RENDER]);
  let t = downVM(f, 0);
  const seen = [];
  for (const every of [5, 10, 20, 40, 40].map(m => m * MIN)) {
    t = nextRecheckAfter(f, t, every);
    seen.push(every / MIN);
    f.recheckOk(VM.url, t);                  // torna alla VM…
    assert.equal(f.current().url, VM.url);
    t = downVM(f, t + 2 * MIN);              // …che ricade dopo 2 min
    assert.equal(f.current().url, RENDER.url);
  }
  assert.deepEqual(seen, [5, 10, 20, 40, 40]);
  // anche una prova fallita aspetta l'intervallo raddoppiato
  t = nextRecheckAfter(f, t, 40 * MIN);
  f.recheckFailed(t + 8000);
  nextRecheckAfter(f, t + 8000, 40 * MIN);
});

test('createFailover: dopo 30 min di VM stabile l\'intervallo torna a 5 min; fra 10 e 30 min resta com\'era', () => {
  const f = createFailover([VM, RENDER]);
  let t = downVM(f, 0);
  t = nextRecheckAfter(f, t, MIN5);
  f.recheckOk(VM.url, t);
  t = downVM(f, t + 2 * MIN);                // ricaduta: 10 min
  t = nextRecheckAfter(f, t, 10 * MIN);
  f.recheckOk(VM.url, t);
  t = downVM(f, t + 15 * MIN);               // ricade dopo 15 min: né oscillazione né VM stabile, resta 10 min
  t = nextRecheckAfter(f, t, 10 * MIN);
  f.recheckOk(VM.url, t);
  t = downVM(f, t + 31 * MIN);               // 31 min di VM stabile: si riparte da 5 min
  nextRecheckAfter(f, t, MIN5);
});

test('createFailover: un ritorno alla VM per errore di Render non conta come ritorno della prova', () => {
  const f = createFailover([VM, RENDER]);
  let t = downVM(f, 0);
  t = nextRecheckAfter(f, t, MIN5);
  f.recheckOk(VM.url, t);                    // ritorno con la prova
  t = downVM(f, t + MIN);                    // ricade dopo 1 min: 10 min
  f.ok(RENDER.url, t);
  f.fail(RENDER.url, t + MIN);               // Render sbaglia: si torna alla VM (non è un ritorno della prova)
  assert.equal(f.current().url, VM.url);
  t = downVM(f, t + 2 * MIN);                // la VM ricade di nuovo: l'intervallo non raddoppia un'altra volta
  assert.equal(f.current().url, RENDER.url);
  nextRecheckAfter(f, t, 10 * MIN);
});

// Riapertura della scheda (prova forzata): solo se l'ultima prova è finita da almeno 60 s e l'intervallo non è
// raddoppiato; altrimenti vale l'intervallo normale. Il ricaricamento (server salvato) resta immediato.
test('createFailover: prova forzata entro 60 s dalla fine dell\'ultima prova → no, si segue l\'intervallo', () => {
  const f = createFailover([VM, RENDER]);
  const t0 = downVM(f, 0);
  assert.equal(f.shouldRecheck(t0 + MIN5), true);
  f.recheckFailed(t0 + MIN5 + 8000);
  const end = t0 + MIN5 + 8000;
  assert.equal(f.shouldRecheck(end + 59999, true), false, 'scheda riaperta dopo 59 s: niente prova');
  assert.equal(f.shouldRecheck(end + 60000, true), true, 'dopo 60 s sì');
  f.recheckFailed(end + 61000);
  assert.equal(f.shouldRecheck(end + 61000 + 30000, true), false);
  assert.equal(f.shouldRecheck(end + 61000 + MIN5), true, 'l\'intervallo normale vale comunque');
});

test('createFailover: con l\'intervallo raddoppiato (VM che oscilla) la riapertura non forza la prova', () => {
  const f = createFailover([VM, RENDER]);
  let t = downVM(f, 0);
  t = nextRecheckAfter(f, t, MIN5);
  f.recheckOk(VM.url, t);
  t = downVM(f, t + 2 * MIN);                // ricaduta: livello 1, 10 min
  assert.equal(f.shouldRecheck(t + 2 * MIN, true), false, 'riaperta dopo 2 min: niente prova');
  assert.equal(f.shouldRecheck(t + 9 * MIN, true), false);
  assert.equal(f.shouldRecheck(t + 10 * MIN, true), true, 'all\'intervallo (10 min) sì');
});

test('createFailover: ricaricando con un server salvato la prova resta immediata', () => {
  const f = createFailover([VM, RENDER], { saved: RENDER.url });
  assert.equal(f.shouldRecheck(10, true), true);
  const g = createFailover([VM, RENDER], { saved: RENDER.url });
  assert.equal(g.shouldRecheck(10), true);
});

test('createFailover: parametro forceGapMs', () => {
  const f = createFailover([VM, RENDER], { forceGapMs: 1000 });
  const t0 = downVM(f, 0);
  assert.equal(f.shouldRecheck(t0, true), true);
  f.recheckFailed(t0 + 100);
  assert.equal(f.shouldRecheck(t0 + 1099, true), false);
  assert.equal(f.shouldRecheck(t0 + 1100, true), true);
});

// Stato di avvio unificato (lastSeenAt, wakeSince): vale anche con un solo server che dorme (solo RENDER_HOST).
test('createFailover: un solo server che dorme si risveglia di nuovo dopo 15 min senza contatti', () => {
  const f = createFailover([RENDER]);
  f.fail(RENDER.url, 0);
  assert.equal(f.waking(), true, 'primo errore: in avvio');
  f.ok(RENDER.url, 20000);
  assert.equal(f.waking(), false);
  f.fail(RENDER.url, 60000);
  assert.equal(f.waking(), false, 'ha risposto 40 s fa: è sveglio, errore vero');
  f.ok(RENDER.url, 70000);
  f.fail(RENDER.url, 70000 + 16 * MIN);
  assert.equal(f.waking(), true, '16 min senza contatti: si è riaddormentato, di nuovo in avvio');
  assert.equal(f.current().url, RENDER.url);
});

test('createFailover: un solo server che dorme, avvio scaduto senza risposta → «riprovo» finché lo si sente', () => {
  const f = createFailover([RENDER]);
  f.fail(RENDER.url, 0);
  let t = 0;
  while (t < 90000) { t += f.retryIn(t); f.fail(RENDER.url, t); }
  assert.equal(f.waking(), false, 'oltre 90 s: non più in avvio');
  for (let i = 0; i < 5; i++) { t += f.retryIn(t); f.fail(RENDER.url, t); assert.equal(f.waking(), false); }
  t += 16 * MIN;
  f.fail(RENDER.url, t);
  assert.equal(f.waking(), true, 'dopo 15 min senza contatti un nuovo avvio');
});

test('createFailover: errori che non contano non toccano lo stato di avvio', () => {
  const f = createFailover([RENDER]);
  f.ok(RENDER.url, 0);
  f.fail(RENDER.url, 16 * MIN, { counts: false });   // rete dell'utente assente: Render non è stato sentito
  assert.equal(f.waking(), false);
  f.fail(RENDER.url, 16 * MIN + 3000);
  assert.equal(f.waking(), true, 'l\'ultimo contatto vero resta quello di 16 min fa');
});

test('createRecheck: intervallo, prova in corso, raddoppio e riapertura', () => {
  const r = createRecheck({ recheckMs: 1000, recheckMaxMs: 4000, flapMs: 500, stableMs: 3000, forceGapMs: 200 });
  assert.equal(r.due(0), false, 'sul primo: si fissa l\'ora (da 0 + 1000)');
  assert.equal(r.due(999), false);
  assert.equal(r.due(1000), true);
  assert.equal(r.due(1000, true), false, 'una prova alla volta');
  r.returned(1100);                            // la prova riesce: si torna al primo
  r.primaryLeft(1200);                         // ricade entro flapMs: raddoppia
  assert.equal(r.level(), 1);
  assert.equal(r.due(1300, true), false, 'livello 1: niente prova forzata');
  assert.equal(r.due(1200 + 1999), false);
  assert.equal(r.due(1200 + 2000), true);
  r.failed(3300);
  assert.equal(r.due(3400), false, 'prova fallita: la prossima fra un intervallo (2000)');
  assert.equal(r.due(5299), false);
  assert.equal(r.due(5300), true);
  r.end(5400);                                 // prova finita senza ritorno (es. già tornati per errore): l'ora resta
  r.primaryBack(5500);
  r.primaryLeft(5600 + 3000);                  // stabile per stableMs: si torna al livello 0
  assert.equal(r.level(), 0);
  assert.equal(r.due(8700, true), true, 'livello 0 e ultima prova finita da più di forceGapMs: riapertura subito');
  const s = createRecheck({ startNow: true, forceGapMs: 200 });
  assert.equal(s.due(5), true, 'startNow: subito');
});

// Rete assente dalla parte dell'utente (networkDown): l'errore della vista non conta per il passaggio.
test('networkDown: navigator.onLine false → rete assente solo se la vista non ha avuto risposta', () => {
  assert.equal(networkDown({ onLine: false, viewNetwork: true }), true);
  assert.equal(networkDown({ onLine: false, viewNetwork: true, balticNetwork: false }), true, 'il Baltico non c\'entra');
  assert.equal(networkDown({ onLine: false, viewNetwork: false }), false, 'un 503 dice che la rete c\'è: conta sempre');
  assert.equal(networkDown({ onLine: false }), false);
});

test('networkDown: vista e Baltico falliti con errore di rete, Baltico riuscito da poco → rete assente', () => {
  assert.equal(networkDown({ onLine: true, viewNetwork: true, balticNetwork: true, balticOkAt: 1000, t: 61000 }), true);
  assert.equal(networkDown({ viewNetwork: true, balticNetwork: true, balticOkAt: 0, t: 120000 }), true, 'onLine non noto');
});

test('networkDown: altrimenti l\'errore conta', () => {
  const base = { onLine: true, viewNetwork: true, balticNetwork: true, balticOkAt: 1000, t: 2000 };
  assert.equal(networkDown({ ...base, viewNetwork: false }), false, 'la vista ha avuto una risposta (es. 503): la rete c\'è');
  assert.equal(networkDown({ ...base, balticNetwork: false }), false, 'il Baltico risponde (o sbaglia con un codice HTTP)');
  assert.equal(networkDown({ ...base, balticOkAt: null }), false, 'Baltico mai riuscito (es. bloccato): non dice nulla della rete');
  assert.equal(networkDown({ ...base, t: 1000 + 2 * MIN + 1 }), false, 'Baltico riuscito più di 2 min fa: rete giù da troppo');
  assert.equal(networkDown({ ...base, t: 1000 + 30000, graceMs: 10000 }), false, 'parametro graceMs');
  assert.equal(networkDown({}), false);
  assert.equal(networkDown(), false);
});
