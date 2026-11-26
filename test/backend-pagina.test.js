// Punto 86 (b): scelta del backend nella pagina, funzioni pure di public/ais-logic.js.
// apiList legge config.js (window.BOATRADAR_APIS / BOATRADAR_API); createFailover decide quando passare al
// server successivo (solo su errore della richiesta della vista), quanto aspettare prima di riprovare e quando provare
// il primo per tornarci (shouldRecheck, recheckOk, recheckFailed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { apiList, createFailover } = require('../public/ais-logic');

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

test('createFailover: VM giù → Render, che si sveglia con attese crescenti; dopo 90 s senza risposta torna alla VM', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  assert.equal(f.current().url, RENDER.url, 'passa a Render');
  assert.deepEqual(changes, [RENDER.url]);
  // Render non ha ancora sbagliato: si prova subito (il piano diceva 5000: è l'attesa della VM, vedi sotto)
  assert.equal(f.canTry(0), true);
  assert.equal(f.retryIn(0), 0);
  assert.equal(f.waking(), false);
  f.fail(RENDER.url, 1000);
  assert.equal(f.current().url, RENDER.url, 'Render si addormenta: entro 90 s dal primo errore resta');
  assert.equal(f.waking(), true);
  assert.equal(f.retryIn(1000), 5000);
  assert.equal(f.canTry(5999), false);
  assert.equal(f.canTry(6000), true);
  f.fail(RENDER.url, 7000);
  assert.equal(f.retryIn(7000), 10000, 'attesa doppia');
  assert.equal(f.waking(), true);
  f.fail(RENDER.url, 95000);
  assert.equal(f.current().url, VM.url, 'oltre 90 s dal primo errore: torna alla VM (attesa scaduta da tempo)');
  assert.equal(f.waking(), false);
  assert.equal(f.retryIn(95000), 0);
  assert.deepEqual(changes, [RENDER.url, VM.url], 'onChange solo ai cambi');
});

test('createFailover: la risposta di Render chiude l\'avvio; dopo, un suo errore passa subito alla VM', () => {
  const f = createFailover([VM, RENDER]);
  f.fail(VM.url, 0);
  f.fail(RENDER.url, 1000);
  assert.equal(f.waking(), true);
  f.ok(RENDER.url);
  assert.equal(f.waking(), false);
  assert.equal(f.canTry(1001), true);
  assert.equal(f.retryIn(1001), 0, 'ok azzera l\'attesa');
  assert.equal(f.current().url, RENDER.url, 'la risposta di Render non riporta alla VM (lo fa solo la prova del primo)');
  f.fail(RENDER.url, 20000);
  assert.equal(f.current().url, VM.url, 'Render ha già risposto: niente attesa di avvio');
});

test('createFailover: la VM che risponde non fa mai passare a Render', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  for (let t = 0; t < 10; t++) f.ok(VM.url);
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, []);
});

test('createFailover: tutti giù → resta su quello che si può riprovare prima', () => {
  const A = { url: 'https://a/api', name: 'A', sleeps: false }, B = { url: 'https://b/api', name: 'B', sleeps: false };
  const f = createFailover([A, B]);
  f.fail(A.url, 0);       // A: riprova a 5000
  assert.equal(f.current().url, B.url);
  f.fail(B.url, 100);     // B: riprova a 5100; A non è ancora pronta → la più vicina è A
  assert.equal(f.current().url, A.url);
  assert.equal(f.canTry(100), false);
  assert.equal(f.retryIn(100), 4900, 'attesa della VM dopo il primo errore: 5000 ms');
  f.fail(A.url, 5000);    // A: 2° errore, riprova a 15000; B pronta a 5100 > 5000 → resta la più vicina, B
  assert.equal(f.current().url, B.url);
  assert.equal(f.retryIn(5000), 100);
});

test('createFailover: un solo backend resta e aspetta sempre di più, fino a 60 s', () => {
  const changes = [];
  const f = createFailover([VM], { onChange: b => changes.push(b.url) });
  const waits = [];
  let t = 0;
  for (let i = 0; i < 7; i++) { f.fail(VM.url, t); waits.push(f.retryIn(t)); t += f.retryIn(t); }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000, 60000]);
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, []);
});

test('createFailover: errori o risposte in ritardo di un server non più attivo non cambiano nulla', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  f.fail(VM.url, 10);     // seconda richiesta alla VM partita prima del cambio
  assert.equal(f.current().url, RENDER.url);
  assert.equal(f.retryIn(10), 0);
  f.ok(VM.url);           // risposta tardiva della VM: non riporta alla VM (lo fa solo la prova del primo)
  assert.equal(f.current().url, RENDER.url);
  assert.deepEqual(changes, [RENDER.url]);
});

test('createFailover: un errore arrivato durante l\'attesa (richiesta partita prima) non raddoppia l\'attesa', () => {
  const f = createFailover([VM]);
  f.fail(VM.url, 0);
  f.fail(VM.url, 300);    // seconda richiesta, partita insieme alla prima
  assert.equal(f.retryIn(300), 4700);
  f.fail(VM.url, 5000);   // tentativo programmato: conta
  assert.equal(f.retryIn(5000), 10000);
});

test('createFailover: tornando su Render dopo un po\' l\'attesa di avvio riparte da capo', () => {
  const f = createFailover([VM, RENDER]);
  f.fail(VM.url, 0);
  f.ok(RENDER.url);                // Render sveglio, poi la VM torna (ricaricando la scheda, per esempio)
  f.fail(RENDER.url, 1000);        // Render giù: torna alla VM
  assert.equal(f.current().url, VM.url);
  f.ok(VM.url);
  f.fail(VM.url, 3600000);         // un'ora dopo la VM cade: Render può essersi addormentato di nuovo
  assert.equal(f.current().url, RENDER.url);
  f.fail(RENDER.url, 3601000);
  assert.equal(f.current().url, RENDER.url, 'resta: Render si sta svegliando');
  assert.equal(f.waking(), true);
});

test('createFailover: parametri baseMs, maxMs e wakeGraceMs', () => {
  const f = createFailover([RENDER, VM], { baseMs: 100, maxMs: 300, wakeGraceMs: 1000 });
  f.fail(RENDER.url, 0);
  assert.equal(f.retryIn(0), 100);
  assert.equal(f.waking(), true);
  f.fail(RENDER.url, 100); assert.equal(f.retryIn(100), 200);
  f.fail(RENDER.url, 300); assert.equal(f.retryIn(300), 300);
  f.fail(RENDER.url, 1000);
  assert.equal(f.current().url, VM.url);
});

// Ritorno automatico al server principale (quota di Render): su un server diverso dal primo, ogni recheckMs (5 min) una
// sola prova leggera del primo; se va bene si torna al primo, se no si resta e si riprova dopo altri recheckMs.
const MIN5 = 5 * 60 * 1000;

test('createFailover: sul primo server nessuna prova del primo', () => {
  const f = createFailover([VM, RENDER]);
  for (const t of [0, MIN5, 10 * MIN5, 100 * MIN5]) assert.equal(f.shouldRecheck(t), false, `t = ${t}`);
  f.ok(VM.url);
  assert.equal(f.shouldRecheck(1000 * MIN5), false);
  const solo = createFailover([RENDER]);
  solo.fail(RENDER.url, 0);
  assert.equal(solo.shouldRecheck(MIN5), false, 'un solo server: è già il primo');
});

test('createFailover: su Render dopo 5 min una prova del primo; risponde → si torna al primo (onChange)', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 1000);
  f.ok(RENDER.url);
  assert.equal(f.shouldRecheck(1000), false);
  assert.equal(f.shouldRecheck(1000 + MIN5 - 1), false, 'prima di 5 min no');
  assert.equal(f.shouldRecheck(1000 + MIN5), true, 'a 5 min dal passaggio sì');
  assert.equal(f.current().url, RENDER.url, 'la prova da sola non cambia server');
  f.recheckOk(VM.url);
  assert.equal(f.current().url, VM.url, 'torna al primo');
  assert.deepEqual(changes, [RENDER.url, VM.url]);
  assert.equal(f.canTry(1000 + MIN5), true, 'il primo si può chiedere subito');
  assert.equal(f.retryIn(1000 + MIN5), 0);
  assert.equal(f.waking(), false);
  assert.equal(f.shouldRecheck(1000 + 3 * MIN5), false, 'di nuovo sul primo: niente prove');
});

test('createFailover: mai più di una prova in corso', () => {
  const f = createFailover([VM, RENDER]);
  f.fail(VM.url, 0);
  assert.equal(f.shouldRecheck(MIN5), true);
  assert.equal(f.shouldRecheck(MIN5), false, 'stessa ora: già in corso');
  assert.equal(f.shouldRecheck(3 * MIN5), false, 'anche molto dopo, finché la prova non finisce');
  f.recheckFailed(3 * MIN5);
  assert.equal(f.shouldRecheck(3 * MIN5), false, 'appena fallita: si aspetta');
  assert.equal(f.shouldRecheck(4 * MIN5), true);
});

test('createFailover: prova fallita → si resta, riprova dopo altri 5 min, e non conta come errore del server attivo', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  f.fail(RENDER.url, 1000);                  // Render in avvio
  f.ok(RENDER.url);
  const t = MIN5;
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

test('createFailover: partendo da Render salvato nella sessione la prima prova arriva 5 min dopo il primo controllo', () => {
  const f = createFailover([VM, RENDER], { saved: RENDER.url });
  assert.equal(f.shouldRecheck(50000), false, 'primo controllo: fissa l\'ora');
  assert.equal(f.shouldRecheck(50000 + MIN5 - 1), false);
  assert.equal(f.shouldRecheck(50000 + MIN5), true);
});

test('createFailover: prova finita quando si è già tornati al primo per un errore → nessun cambio in più', () => {
  const changes = [];
  const f = createFailover([VM, RENDER], { onChange: b => changes.push(b.url) });
  f.fail(VM.url, 0);
  f.ok(RENDER.url);
  assert.equal(f.shouldRecheck(MIN5), true);
  f.fail(RENDER.url, MIN5 + 100);            // intanto Render sbaglia: si torna alla VM
  assert.equal(f.current().url, VM.url);
  f.recheckOk(VM.url);                       // la prova arriva dopo
  assert.equal(f.current().url, VM.url);
  assert.deepEqual(changes, [RENDER.url, VM.url], 'onChange una volta sola per il ritorno');
  // la VM cade di nuovo: le prove ripartono 5 min dopo il nuovo passaggio
  f.fail(VM.url, 2 * MIN5);
  assert.equal(f.current().url, RENDER.url);
  assert.equal(f.shouldRecheck(3 * MIN5 - 1), false);
  assert.equal(f.shouldRecheck(3 * MIN5), true);
});

test('createFailover: recheckOk di un indirizzo che non è il primo non sposta nulla', () => {
  const f = createFailover([VM, RENDER]);
  f.fail(VM.url, 0);
  assert.equal(f.shouldRecheck(MIN5), true);
  f.recheckOk('https://altro.example/api');
  assert.equal(f.current().url, RENDER.url);
  assert.equal(f.shouldRecheck(MIN5 + 1), false, 'la prova è finita: si riprova dopo altri 5 min');
  assert.equal(f.shouldRecheck(2 * MIN5 + 1), true);
});

test('createFailover: con tre server le prove riguardano solo il primo e non ripartono da capo fra secondo e terzo', () => {
  const A = { url: 'https://a/api', name: 'A', sleeps: false }, B = { url: 'https://b/api', name: 'B', sleeps: false },
    C = { url: 'https://c/api', name: 'C', sleeps: false };
  const f = createFailover([A, B, C]);
  f.fail(A.url, 0);
  f.fail(B.url, 1000);                       // B → C: l'ora della prova resta quella del passaggio da A
  assert.equal(f.current().url, C.url);
  assert.equal(f.shouldRecheck(MIN5), true);
  f.recheckOk(A.url);
  assert.equal(f.current().url, A.url);
});

test('createFailover: parametro recheckMs', () => {
  const f = createFailover([VM, RENDER], { recheckMs: 1000 });
  f.fail(VM.url, 0);
  assert.equal(f.shouldRecheck(999), false);
  assert.equal(f.shouldRecheck(1000), true);
});
