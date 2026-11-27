# Prestazioni di server.js

Misure di memoria e tempi da ripetere prima e dopo i punti 21 (aggiornamenti incrementali),
22 e 4 del Piano, sempre con gli stessi dati. Integrazione GitHub n. 2 del Piano: flameox.

## Carico di lavoro

`tools/carico.js` carica `server.js` nello stesso processo, gli fa arrivare N navi sintetiche da
un finto aisstream locale (seme fisso: stesse navi a ogni misura; 30% addensate in sei porti, il
resto sparso sui mari), poi misura:

- memoria dopo la ricezione (heap e RSS; MB ogni 1000 navi come differenza di heap);
- `/api/locations` a zoom mondo (`bbox=-180,-90,180,90`, come la pagina a zoom basso) e a zoom
  porto (Rotterdam): navi restituite, KB gzip e non compressi, mediana e p95 di N richieste.

```
node --expose-gc tools/carico.js --navi 30000 --richieste 50
node --expose-gc tools/carico.js --navi 30000 --richieste 50 --registra "dopo punto 21"
```

`--registra` aggiunge una riga alla tabella qui sotto; `--json file` salva tutto. `--filtro "types=tanker"`
(punto 9) misura e stampa anche la vista mondo con quei filtri (nel JSON `mondoFiltrata`, non nella riga
della tabella, che resta sulle viste senza filtro). Client e server
condividono lo stesso processo: i tempi servono per confrontare due versioni sulla stessa macchina,
non come tempi assoluti visti dal browser.

## Profili con flameox

[flameox](https://github.com/morluto/flameox) (MIT, v0.2.9; richiede `uv` e Python ≥ 3.12) avvia
il carico con `--cpu-prof` / `--heap-prof` e restituisce le funzioni più costose con i limiti
della misura:

```
uvx --from flameox==0.2.9 flameox capture --provider node-cpu-profile --operation rank_cpu_hotspots \
  --cwd "$PWD" -- node --expose-gc tools/carico.js --navi 30000 --richieste 50
uvx --from flameox==0.2.9 flameox capture --provider node-heap-profile --operation rank_allocation_hotspots \
  --cwd "$PWD" -- node --expose-gc tools/carico.js --navi 30000 --richieste 50
```

Per usarlo da Claude Code come server MCP: `npx flameox@latest setup` (chiede quali client
configurare; non modifica la repo). I numeri di riga di V8 partono da 0: riga 160 = riga 161
dell'editor.

## Sul server in cloud

Il carico sintetico non sostituisce la misura reale. Con il flusso mondiale vero confronta la
memoria del processo con il limite del contenitore: su Render dal grafico Metrics del servizio;
sulla VM Oracle (branch `claude/github-pages-oracle`, limite 1 GB in `deploy/compose.yml`) con
`docker stats boatradar`. Annota qui sotto il numero di navi di `/api/status` nello stesso momento.

## Risultati

Prima misura (sessione cloud di Claude Code, 23/11/2026 UTC, 30.000 navi):

- CPU (`rank_cpu_hotspots`, 2470 campioni): la compressione gzip delle risposte
  (`zlib.gzipSync` in `json()`) è il 40% del tempo; `json()` in tutto il 59% (gzip più
  `JSON.stringify`); `locations()` il 15%; la ricezione dei messaggi AIS il 5%.
  → Il punto 21 (risposte incrementali e più leggere) e una cache della risposta compressa sono
  le leve più forti; il campionamento (punto 4) pesa poco.
- Memoria (`rank_allocation_hotspots`): l'82% delle allocazioni campionate nasce dalla ricezione
  dei messaggi (`handle()` e il parsing JSON di ogni messaggio); circa 0,5 MB ogni 1000 navi di
  heap, quindi lo stato delle navi non è il problema per il limite di 1 GB: lo diventa lo storico
  del punto 20, da dimensionare con queste misure.

Punto 84 (26/11/2026, cache di `/api/locations`): la risposta, anche compressa, si riusa per
`LOCATIONS_CACHE_MS` (default 3000 ms) o finché i dati non cambiano (al massimo 60 s); il bbox è
arrotondato verso l'esterno a un passo proporzionale alla vista (potenza di 2 ≥ 1/8 del lato maggiore,
fra 1/64° e 0,25°); `LOCATIONS_CACHE_SIZE` (default 50, 0 = spenta) viste tenute e
`LOCATIONS_CACHE_BYTES` (default 32 MB) byte al massimo; `hits`, `misses`, `compressions`, `size` e
`bytes` in `locationsCache` di `/api/status`, intestazione `X-Cache: hit|miss`. Variabili in `deploy/README.md`.

- Correzioni da revisione e QA (26/11/2026): una voce chiesta con gzip tiene solo la risposta
  compressa (vista mondo con 30.000 navi: circa 0,23 MB invece di 1,7 MB con il JSON), i client senza
  gzip la ricevono decompressa al volo; le voci non più riusabili si tolgono ogni minuto; la chiave
  contiene solo bbox arrotondato e `limit` effettivo. Riga «dopo correzioni»: stesso caso migliore di
  prima (1,1 ms mondo, 0,5 ms porto). Con `LOCATIONS_CACHE_SIZE=0`, nella stessa sessione: mondo
  35,9 / 50,6 ms, porto 10,3 / 13,8 ms (mediana / p95), come la riga con la cache spenta qui sotto.
  La vista porto di `tools/carico.js` (Rotterdam, 1,1°) ha ancora passo 0,25°: 1427 navi come prima.

- La riga «dopo punto 84» è il **caso migliore**: `tools/carico.js` chiede sempre la stessa vista
  senza messaggi AIS nel frattempo, quindi tutte le richieste tranne la prima sono servite dalla cache.
  Con il flusso vero i dati cambiano di continuo e conta la regola dei 3 s: più utenti sulla stessa
  zona (o la stessa pagina che si aggiorna) entro 3 s condividono una risposta già compressa.
- Con la cache spenta (o a ogni miss) la risposta costa un po' di più di prima (mondo circa
  33-35 ms invece di 27-29 ms in tre ripetizioni; porto 9-11 invece di 7-8 ms): il gzip ora è
  asincrono e passa dal thread pool di libuv. In cambio non blocca più il ciclo degli eventi, quindi
  la ricezione AIS e le altre richieste vanno avanti durante la compressione (questo il carico
  sequenziale non lo misura). Un `chunkSize` più grande per `zlib.gzip` non cambia i tempi.

Punto 5 (26/11/2026, `heading` e `rot` nelle properties di `/api/locations`): con le navi di
`tools/carico.js` (tutte con TrueHeading, nessuna con RateOfTurn, quindi `"rot":null`) la vista mondo
passa da 227,2 a 247,6 KB gzip (+9%; 1459,5 → 1603,7 KB non compressi) e la vista porto da 53,1 a
58 KB. Tempi a cache spenta (`LOCATIONS_CACHE_SIZE=0`, non registrati in tabella), stessa sessione:
mondo 36 / 44,4 ms prima e 36 / 46,7 ms dopo, porto 9,8 / 15,3 e 10 / 14,1 ms (mediana / p95).

Correzioni dei punti 43, 5, 3 (26/11/2026): `heading` e `rot` si omettono quando sono null. Con le navi di
`tools/carico.js` (nessuna con RateOfTurn) la vista mondo passa da 1603,7 a 1539,5 KB non compressi (−4%) e da
248,2 a 245,5 KB gzip; la vista porto da 381,3 a 366 KB (58,1 → 57,5 KB gzip). `include=` non passa più dalla
cache: la misura non lo usa. A cache spenta (non registrate), stessa sessione: prima (a298b83) mondo 39,2 / 47,1 ms
e porto 11,3 / 18,9 ms; dopo mondo 41,1 / 54 ms (un'altra prova 42,8 / 54,1) e porto 10,3 / 12,3 ms (mediana / p95):
differenze nel rumore della misura.

Punto 4 (26/11/2026, campione per importanza in `sample.js` invece di `mmsi % k`): la vista mondo
restituisce esattamente `limit` navi (6000 invece di 5979; 255 KB gzip invece di 248). A cache spenta
(`LOCATIONS_CACHE_SIZE=0`), nella stessa sessione, la mediana della vista mondo è passata da 38-42 ms
a 43-45 ms (tra +1 e +5 ms: la misura varia di ±4 ms tra un'esecuzione e l'altra), sotto la soglia di +10 ms;
p95 circa +5-10 ms; vista porto invariata (meno di `limit` navi: nessun campione). La prima versione (oggetti per nave e
`sort` con confronto) costava circa +17 ms. Le due ottimizzazioni: (1) ordinamento numerico nativo di un
`Float64Array` (chiave MMSI · 2^22 + indice), poi un counting sort stabile per punteggio arrotondato a 1/1024 (per
lunghezze intere l'ordine è identico); (2) la parte statica del punteggio (lunghezza e tipo) è calcolata in
`handle()` e tenuta nella posizione (`staticScore`), così una richiesta non rilegge `vessels`. Memoria: 0,55 MB
ogni 1000 navi invece di 0,51 (`classA` e `staticScore` in ogni posizione, circa 1 MB con 30.000 navi).

- Correzioni da revisione e QA del punto 4 (26/11/2026): l'ottimizzazione (1) è tolta per semplicità
  (decisione del coordinatore): ora un solo ordinamento di un `Uint32Array` di indici con comparatore
  (punteggio decrescente in unità di 1e-9, poi MMSI crescente; punteggi e MMSI in `Float64Array`), senza
  chiave impaccata né counting sort né ramo di riserva. La lunghezza è arrotondata al metro in
  `staticImportance`. Costo misurato in questa sessione con 30.000 navi: `sampleByImportance` da solo
  (limit 6000) 10,5-11,5 ms invece di 4,7-5,1 ms; l'ordinamento con comparatore da solo 8-11 ms (nessuna
  variante del comparatore è più veloce oltre il rumore). Vista mondo a cache spenta, mediana, cinque
  coppie alternate nella stessa sessione: prima del punto 4 (a298b83) 39 / 41 / 36,5 / 42 / 44,5 ms (media
  40,6), dopo le correzioni 51,3 / 45 / 45,7 / 53,1 / 51,1 ms (media 49,2): **+8,6 ms in media**, sotto la
  soglia di +10 ms, ma in 2 coppie su 5 la differenza è stata di +11 / +12 ms. Rispetto al punto 4 prima delle
  correzioni (251436c, due coppie) circa +5 ms. La riga registrata qui sotto con la cache spenta (53,7 ms)
  va confrontata con queste coppie, non con la riga «prima punto 4» di un'altra sessione. Vista porto e
  caso con cache invariati.
- Punto 9 (a), filtri in `/api/locations` (26/11/2026): senza filtro il ciclo di `locations()` fa solo un
  `Math.min` e un controllo in più. Righe «prima/dopo punto 9a» qui sotto (caso con cache) nel rumore. A cache
  spenta, vista mondo, mediana, quattro coppie alternate nella stessa sessione (prima = 7bf0eba): prima 47,3 /
  48,2 / 52,5 / 56,2 ms (media 51,1), dopo 58,7 / 55,2 / 50,5 / 53,2 ms (media 54,4), differenze di segno
  diverso: rumore. Vista mondo filtrata (`--filtro "types=tanker"`, 6000 petroliere su 30.000 navi, tutte
  restituite perché il filtro viene prima del campione): 0,8 / 1,5 ms con la cache, 43,9-44,5 ms di mediana a
  cache spenta, un po' meno della vista senza filtro (campione su 6000 navi invece che su 30.000).

- Punto 12, ricerca ordinata (26/11/2026): `/api/search` ora dà un punteggio a TUTTE le navi con posizione
  (`searchScore`: nome, MMSI, IMO, nominativo) e ordina le corrispondenze (`compareSearch`) prima di tenerne 25; prima si
  fermava alle prime 25 trovate. Misura con `tools/carico.js --navi 30000 --richieste 50 --cerca "<testo>"` (nomi
  sintetici «NAVE n»), mediana / p95, prima (1bb8261) e dopo nella stessa sessione:
  «NAVE» (30.000 corrispondenze) 0,9 / 1,1 → 30,6 / 49,4 ms; «NAVE 1» (11.111) 0,8 / 1,1 → 25,5 / 31,7 ms;
  «NAVE 29999» (1) 6,7 / 11,1 → 22,7 / 41,1 ms; «XYZ» (nessuna) 6,9 / 10,9 → 14,9 / 29,8 ms. In Node puro, senza
  HTTP: punteggio delle 30.000 navi 11-16 ms (circa 5 ms per `norm` di nome e nominativo), ordinamento di 30.000
  corrispondenze 2-5 ms. Il costo è uno per ricerca, non per tasto (la pagina aspetta 250 ms dopo l'ultimo tasto e
  annulla la richiesta precedente), quindi accettabile; se servisse, la leva è tenere in memoria nome e nominativo già
  normalizzati in `vessels`.
- Punto 12, correzioni da revisione (26/11/2026): la ricerca gira sul ciclo degli eventi del server, quindi per tutta
  la sua durata ogni altra richiesta (`/api/locations` delle altre schede, `/api/status`) e i messaggi di aisstream
  aspettano: il costo va tenuto basso anche se è uno per ricerca. Ora nomi e nominativi sono ripuliti all'arrivo
  (`clean`: spazi interni compattati, riempimento tolto) e quelli che `norm` cambierebbe (accenti, minuscole, `- . /`)
  sono salvati normalizzati in `searchNames`; `scoreFields` fa un solo `indexOf` sul nome per le navi che non
  corrispondono, converte MMSI e IMO in stringa solo per le query di cifre; `insertTop` tiene le prime 25 senza ordinare
  tutte le corrispondenze (con le 25 già piene basta un confronto). Stesso ordine di prima (test di equivalenza su dati
  casuali in `test/ricerca-logica.test.js` e `test/ricerca.test.js`). `tools/carico.js --navi 30000 --richieste 50
  --cerca "<testo>"`, mediana / p95, prima (2b2f80a) e dopo alternati nella stessa sessione, due giri:
  «NAVE» 17,8 / 31,7 e 23,2 / 32,8 → 6,1 / 8,1 e 5,9 / 7,8 ms; «NAVE 1» 18,5 / 31,8 e 28,4 / 40,4 → 6,2 / 8,0 e
  5,3 / 8,6 ms; «NAVE 29999» 16,7 / 25,5 e 21,0 / 33,4 → 4,1 / 9,1 e 3,9 / 7,5 ms; «XYZ» 19,1 / 24,0 e 16,7 / 23,1 →
  4,5 / 6,0 e 4,6 / 5,8 ms. Circa 4 volte meno; resta più della ricerca prima del punto 12 (0,8-6,9 ms), che si
  fermava alle prime 25 trovate. I nomi sintetici «NAVE n» non finiscono in `searchNames` (vuota, ma letta comunque per
  ogni nave): con nomi veri con accenti, trattini o punti cambia solo quante voci contiene. Righe «prima/dopo correzioni punto 12»
  qui sotto (viste senza ricerca, stessa sessione): memoria e tempi pari; i MB/1000 navi più alti delle righe
  precedenti valgono per entrambe e vengono dalla macchina di quella sessione, non dalla modifica.

- Punto 46, filtro `hazard=1` (27/11/2026): `tools/carico.js` ha ora i tipi 71 e 84 al posto di un 70 e di un 80
  (stesse categorie della legenda e stesso punteggio del campione: le righe senza filtro restano in linea, vedi «prima
  punto 46»), così 6000 navi su 30.000 hanno un carico pericoloso. `passesFilter` controlla `hazardCategory` solo con il
  filtro attivo: senza filtro nessun costo in più («dopo punto 46»: 1,3 / 1,8 ms mondo, 0,8 / 1,0 ms porto, rumore).
  Vista mondo `--filtro "hazard=1"`: 6000 navi su 6000, 248 KB gzip, 0,9 / 1,7 ms con la cache; a cache spenta
  (`LOCATIONS_CACHE_SIZE=0`, stessa sessione) 54,0 / 97,8 ms contro 51,4 / 65,2 ms di `types=tanker` e 60,6 / 73,2 ms
  della vista senza filtro.

| Data | Versione | Navi | MB/1000 navi | RSS MB | Mondo: navi | Mondo: KB gzip (raw) | Mondo: ms mediana / p95 | Porto: navi | Porto: KB gzip (raw) | Porto: ms mediana / p95 | Node |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-23 | riferimento (prima dei punti 4, 21, 22) · cloud Claude | 30000 | 0.5 | 168.2 | 5979 | 227.1 (1459.5) | 31.5 / 38.6 | 1427 | 53.1 (346.9) | 8.3 / 9.8 | v22.23.5 |
| 2026-11-26 | prima punto 1 (scarto posizioni) | 30000 | 0.5 | 165.5 | 5979 | 227.2 (1459.5) | 39.1 / 43.7 | 1427 | 53.1 (346.9) | 8.3 / 13.9 | v22.23.5 |
| 2026-11-26 | dopo punto 1 (scarto posizioni) | 30000 | 0.5 | 166.7 | 5979 | 227.3 (1459.5) | 37 / 46.1 | 1427 | 53.1 (346.9) | 8.3 / 13.1 | v22.23.5 |
| 2026-11-26 | prima punto 84 (cache /api/locations), con punti 1, 7, 11 | 30000 | 0.5 | 169 | 5979 | 227.1 (1459.5) | 28.8 / 33.6 | 1427 | 53 (346.9) | 8.4 / 11.8 | v22.23.5 |
| 2026-11-26 | dopo punto 84 (cache /api/locations, caso migliore: vista ripetuta senza messaggi) | 30000 | 0.5 | 168.9 | 5979 | 227.8 (1459.5) | 0.9 / 1.5 | 1427 | 53.3 (346.9) | 0.5 / 0.8 | v22.23.5 |
| 2026-11-26 | dopo punto 84 con LOCATIONS_CACHE_SIZE=0 (cache spenta, gzip asincrono) | 30000 | 0.5 | 167.7 | 5979 | 227.3 (1459.5) | 34.5 / 40.6 | 1427 | 53.1 (346.9) | 11.5 / 16.2 | v22.23.5 |
| 2026-11-26 | dopo correzioni revisione/QA punti 7, 11, 84 (caso migliore: vista ripetuta) | 30000 | 0.5 | 167.5 | 5979 | 227.5 (1459.5) | 1.1 / 1.8 | 1427 | 53.2 (346.9) | 0.5 / 0.8 | v22.23.5 |
| 2026-11-26 | prima punto 5 (prua vera), con punto 43 | 30000 | 0.5 | 168.9 | 5979 | 227.2 (1459.5) | 1 / 1.9 | 1427 | 53.1 (346.9) | 0.7 / 0.9 | v22.23.5 |
| 2026-11-26 | dopo punto 5 (heading e rot in /api/locations) | 30000 | 0.51 | 168.3 | 5979 | 247.6 (1603.7) | 0.9 / 5.5 | 1427 | 58 (381.3) | 0.6 / 2.8 | v22.23.5 |
| 2026-11-26 | dopo punto 3 (include=, senza include nella misura) | 30000 | 0.51 | 169.9 | 5979 | 248.2 (1603.7) | 1 / 4.3 | 1427 | 58.1 (381.3) | 0.6 / 2.4 | v22.23.5 |
| 2026-11-26 | dopo correzioni 43/5/3 (include fuori dalla cache, heading/rot omessi se null) | 30000 | 0.51 | 170.1 | 5979 | 245.5 (1539.5) | 0.8 / 1.5 | 1427 | 57.5 (366) | 0.5 / 3.9 | v22.23.5 |
| 2026-11-26 | prima punto 4 (campione per importanza), con punti 43, 5, 3 | 30000 | 0.51 | 169.3 | 5979 | 248.2 (1603.7) | 1.2 / 2.1 | 1427 | 58.2 (381.3) | 0.6 / 0.9 | v22.23.5 |
| 2026-11-26 | prima punto 4 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.51 | 168.7 | 5979 | 247.9 (1603.7) | 40.8 / 56.2 | 1427 | 58.1 (381.3) | 13.1 / 16.1 | v22.23.5 |
| 2026-11-26 | dopo punto 4 (campione per importanza; caso migliore: vista ripetuta) | 30000 | 0.55 | 169.4 | 6000 | 255 (1614.9) | 1.3 / 2.3 | 1427 | 58.1 (381.3) | 0.6 / 1 | v22.23.5 |
| 2026-11-26 | dopo punto 4 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.55 | 171.1 | 6000 | 255.7 (1614.9) | 43.1 / 58.1 | 1427 | 58.3 (381.3) | 11 / 14.4 | v22.23.5 |
| 2026-11-26 | dopo correzioni punto 4 (ordinamento semplice) | 30000 | 0.55 | 169.7 | 6000 | 255.3 (1614.9) | 1 / 4.1 | 1427 | 58.2 (381.3) | 0.9 / 1.2 | v22.23.5 |
| 2026-11-26 | dopo correzioni punto 4 (ordinamento semplice) con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.55 | 171.4 | 6000 | 255.4 (1614.9) | 53.7 / 66.1 | 1427 | 58.2 (381.3) | 13.9 / 36 | v22.23.5 |
| 2026-11-26 | prima punto 8 | 30000 | 0.55 | 170 | 6000 | 254.3 (1550.5) | 1.3 / 2.5 | 1427 | 57.6 (366) | 0.7 / 1 | v22.23.5 |
| 2026-11-26 | prima punto 8 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.55 | 169.6 | 6000 | 254.6 (1550.5) | 52.3 / 66.2 | 1427 | 57.8 (366) | 12.6 / 16.6 | v22.23.5 |
| 2026-11-26 | dopo punto 8 | 30000 | 0.54 | 171.4 | 6000 | 253.7 (1550.5) | 1.1 / 1.9 | 1427 | 57.5 (366) | 0.6 / 1.4 | v22.23.5 |
| 2026-11-26 | dopo punto 8 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.55 | 171.6 | 6000 | 254.5 (1550.5) | 49.1 / 63.6 | 1427 | 57.7 (366) | 10.3 / 12.8 | v22.23.5 |
| 2026-11-26 | dopo correzioni punti 8 e 62 (penalità d'età fino a -8) | 30000 | 0.55 | 171.7 | 6000 | 254.3 (1550.5) | 1.3 / 2 | 1427 | 57.6 (366) | 0.8 / 0.9 | v22.23.5 |
| 2026-11-26 | dopo correzioni punti 8 e 62 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.54 | 169.4 | 6000 | 253.1 (1550.5) | 46.4 / 57 | 1427 | 57.3 (366) | 11.6 / 13.7 | v22.23.5 |
| 2026-11-26 | prima punto 9a | 30000 | 0.54 | 171.1 | 6000 | 253.6 (1550.5) | 0.9 / 2.3 | 1427 | 57.5 (366) | 0.5 / 0.7 | v22.23.5 |
| 2026-11-26 | dopo punto 9a | 30000 | 0.55 | 170.2 | 6000 | 254.3 (1550.5) | 1.1 / 5.1 | 1427 | 57.6 (366) | 0.8 / 1.2 | v22.23.5 |
| 2026-11-26 | dopo quota filtrate in cache (punto 9a) | 30000 | 0.55 | 169.7 | 6000 | 254.6 (1550.5) | 0.9 / 1.7 | 1427 | 57.7 (366) | 0.7 / 1.1 | v22.23.5 |
| 2026-11-26 | prima correzioni punto 12 (2b2f80a) | 30000 | 1.73 | 175 | 6000 | 253.6 (1550.5) | 0.9 / 1.6 | 1427 | 57.4 (366) | 0.5 / 0.7 | v22.23.5 |
| 2026-11-26 | dopo correzioni punto 12 | 30000 | 1.79 | 175.3 | 6000 | 254.6 (1550.5) | 0.7 / 1.1 | 1427 | 57.8 (366) | 0.4 / 0.5 | v22.23.5 |
| 2026-11-27 | prima punto 46 (carico.js con tipi 71 e 84) | 30000 | 0.55 | 172.7 | 6000 | 255.1 (1550.5) | 1 / 1.6 | 1427 | 57.9 (366) | 0.7 / 0.9 | v22.23.5 |
| 2026-11-27 | dopo punto 46 | 30000 | 0.55 | 172.9 | 6000 | 255.8 (1550.5) | 1.3 / 1.8 | 1427 | 58.1 (366) | 0.8 / 1 | v22.23.5 |
<!-- nuove righe sopra questa linea -->

## Pagina

Misura della pagina nel browser (punti 13, 63, 42: movimento fluido e posizione stimata) con `tools/misura-pagina.sh`:
`server.js` con le navi sintetiche di `tools/carico.js` (`tools/smoke-server.js --navi 30000`, che le fa avanzare
coerenti con velocità e rotta), `boatradar.html` in agent-browser a 1280×800, per ogni scenario (mondo z3, Rotterdam z9
e z13) quattro misure da 10 s (`MISURA_SECONDI`) in ordine alternato: animazione spenta, accesa, accesa, spenta. La
deriva della macchina durante la misura (riscaldamento, altri processi) pesa così uguale sui due stati, e ogni riga della
tabella è la mediana delle due misure dello stesso stato:

- fps: fotogrammi `requestAnimationFrame` al secondo (della misura, non dell'animatore);
- ridisegni del canvas al secondo divisi per causa, con i contatori della pagina letti a ogni ridisegno: «dati» se nel
  frattempo `loadLocations` ha aggiornato i marker (`anim.stats.loads`), «animatore» se l'animatore ha spostato marker
  (`anim.stats.moved` + `pickMoved`), altrimenti «altri»; dei ridisegni dell'animatore p50 / p95 / massimo e numero di
  campioni (le due misure unite), dei ridisegni dei dati il p95 (`renderer._redraw`, metodo privato di Leaflet 1.9.4);
- long task oltre 50 ms fuori dalle finestre dei dati: da 50 ms prima di `loadLocations` (o dalla prima risposta di
  `/api/locations` o del Baltico del giro, per la lettura del JSON) a 250 ms dopo la sua fine (il ridisegno che segue).
  La pagina segna inizio e fine con `performance.mark('boatradar:load-start' / 'boatradar:load-end')` e
  `performance.measure('boatradar:load')`; in tutto, e quante risposte di dati sono arrivate;
- fotogrammi e risvegli (`setTimeout`) del ciclo dell'animatore al secondo: senza niente da muovere il ciclo non chiede
  fotogrammi, e con il prossimo passo lontano più di 100 ms aspetta con un `setTimeout`;
- passi dell'animatore e `setLatLng` dei passi al secondo (comprese le navi che, uscite dalle animate, scivolano alla loro
  posizione), p95 del passo, durata della scelta delle navi animate (`anim.stats`);
- `loadLocations`: tempo per unire le fonti e aggiornare i marker, mediana di 10 giri (5 per misura) e scarto
  interquartile (`anim.stats.loadMs`).

```
SMOKE_LEAFLET_LOCAL=1 bash tools/misura-pagina.sh --registra "dopo correzioni revisione"
MISURA_CPU=4 bash tools/misura-pagina.sh     # facoltativo: CPU rallentata 4 volte via CDP
```

Soglie, e perché (dal 2026-11-27, dopo la revisione dei punti 13, 63, 42):

- fps ≥ 55 (con la CPU 4 volte più lenta, facoltativo, ≥ 30 a zoom 13).
- Con l'animazione accesa, solo i ridisegni causati dall'animatore: vista mondo ≤ 2/s e p95 ≤ 12 ms, zoom 13 p95 ≤ 6 ms.
  La misura di prima contava ogni ridisegno: a zoom 3 l'animatore non sposta niente (meno di 0,5 px) e l'unico ridisegno
  (0,1/s) era quello dei dati arrivati, presente anche ad animazione spenta, con 19-24 ms spenta e 12-14 ms accesa; la
  soglia «mondo p95 ≤ 12 ms» misurava un solo campione di quel ridisegno, non il movimento (vedi la nota sotto la
  tabella precedente). Il costo dei dati resta in tabella («Ridisegno dati p95») ma non è del movimento. Il p95 vale con
  almeno 20 campioni; con meno si usa il massimo (più severo); nessun ridisegno dell'animatore vuol dire nessun costo.
- Nessun long task > 50 ms fuori dalle finestre dei dati (segni della pagina invece di «entro 1 s da una risposta»).
- `loadLocations` accesa al massimo 2 ms più che spenta, più metà della somma degli scarti interquartili dei due gruppi
  di 10 giri. Il test vm (`test/pagina-movimento.test.js`, «loadLocations con 6000 navi») misura il costo per marker
  senza browser: con l'animazione accesa il giro calcola in più solo `pushFix` e `positionAt` per marker, con l'ora di
  riproduzione letta una volta per giro (prima `clock.now()`, che ordinava i campioni, per ogni marker): 6,4 contro
  6,6 µs per marker, cioè nessuna differenza misurabile. Nel browser la differenza fra due misure cambiava segno (+4,0 e
  −2,4 ms a Rotterdam z9) e gli scarti interquartili dei giri sono di 1-28 ms: una differenza dentro quello scarto è
  rumore, non un costo dell'animazione.

Se le soglie dei ridisegni dell'animatore non reggono: `ANIM_MAX` 200 e `ANIM_MIN_MS` 50 in `boatradar.html`, poi di
nuovo la misura (finora non è servito: restano 500 e 16). Headless e senza GPU i numeri servono a confrontare due
versioni sulla stessa macchina.

### Misura alternata (dal 2026-11-27)

| Data | Versione | Scenario | Animazione | Marker | Animate / in moto | fps | Ridisegni/s: dati · animatore · altri | Ridisegno animatore p50 / p95 / max ms (campioni) | Ridisegno dati p95 ms | Long task > 50 ms fuori dai dati (max ms) · in tutto, risposte | Fotogrammi / risvegli del ciclo al s | Passi/s / setLatLng/s | Passo p95 ms | Scelta ms | loadLocations ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-27 | dopo correzioni revisione (51cac37+modifiche) | mondo z3 | spenta | 6000 | 0 / 0 | 59.6 | 0.1 · 0 · 0 | – (0) | 26.6 | 0 (max 0) · 3 (max 90), 4 risposte | 0 / 0 | 0 / 0 | 0 | 3.15 | 56.35 (IQR 16.1, 10 giri) |
| 2026-11-27 | dopo correzioni revisione (51cac37+modifiche) | mondo z3 | accesa | 6000 | 500 / 3578 | 59.8 | 0.1 · 0 · 0 | – (0) | 16.3 | 0 (max 0) · 2 (max 54), 4 risposte | 1.9 / 1.3 | 1 / 0 | 0.75 | 6.35 | 46.8 (IQR 25.5, 10 giri) |
| 2026-11-27 | dopo correzioni revisione (51cac37+modifiche) | Rotterdam z9 | spenta | 1437 | 0 / 0 | 60.1 | 0.1 · 0 · 0 | – (0) | 4.1 | 0 (max 0) · 0 (max 0), 4 risposte | 0 / 0 | 0 / 0 | 0 | 2.05 | 13.15 (IQR 3.6, 10 giri) |
| 2026-11-27 | dopo correzioni revisione (51cac37+modifiche) | Rotterdam z9 | accesa | 1437 | 500 / 848.5 | 60.2 | 0.1 · 1.1 · 0 | 3.5 / 5.9 / 7.8 (23) | 4.6 | 0 (max 0) · 0 (max 0), 4 risposte | 2.1 / 1 | 0.9 / 25.5 | 1.2 | 2.8 | 10.15 (IQR 4.3, 10 giri) |
| 2026-11-27 | dopo correzioni revisione (51cac37+modifiche) | Rotterdam z13 | spenta | 320 | 0 / 0 | 60.2 | 0.1 · 0 · 0 | – (0) | 1.1 | 0 (max 0) · 0 (max 0), 4 risposte | 0 / 0 | 0 / 0 | 0 | 1.1 | 3.5 (IQR 2.4, 10 giri) |
| 2026-11-27 | dopo correzioni revisione (51cac37+modifiche) | Rotterdam z13 | accesa | 319.5 | 57.5 / 57.5 | 60.1 | 0.1 · 1.8 · 0 | 0.4 / 0.6 / 1.2 (37) | 0.8 | 0 (max 0) · 0 (max 0), 4 risposte | 2.4 / 2.1 | 1.9 / 40.8 | 0.6 | 0.3 | 4.35 (IQR 2, 10 giri) |
<!-- nuove righe della pagina (misura alternata) sopra questa linea -->

Nota (2026-11-27, dopo le correzioni della revisione): soglie rispettate con il codice corretto, senza toccare
`ANIM_MAX` né `ANIM_MIN_MS`. A zoom 3 l'animatore non causa ridisegni (0 campioni: niente sotto mezzo pixel si sposta)
e il ciclo fa 1,3-1,9 fotogrammi al secondo invece di 60 (risvegli con `setTimeout`). I ridisegni dei dati a zoom 3
(16-27 ms p95) sono gli stessi ad animazione spenta e accesa. A Rotterdam z9 i `setLatLng`/s dei passi (25,5) sono più
alti della misura precedente (0,4): dipendono da quante navi superano mezzo pixel nella finestra di 10 s, cioè da quando
arrivano i fix nuovi; il codice di 51cac37 misurato a mano per 15 s con l'arrivo di fix nuovi ne fa 8,5/s. Il costo resta
nei ridisegni dell'animatore (1,1/s, p95 5,9 ms), entro le soglie.

### Misura precedente (una misura per stato, tutti i ridisegni)

| Data | Versione | Scenario | Animazione | Marker | Animate / in moto | fps | Ridisegni/s | Ridisegno p50 / p95 ms | Long task > 50 ms fuori dai dati (max ms) · in tutto, risposte nella misura | Passi/s / setLatLng/s | Passo p95 ms | Scelta ms | loadLocations ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) | mondo z3 | spenta | 6000 | 0 / 0 | 59.7 | 0.1 | 17.8 / 17.8 | 0 (max 0) · 2 (max 61), 2 risposte | 0 / 0 | 0 | 8.1 | 65.3 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) | mondo z3 | accesa | 6000 | 500 / 3578 | 59.8 | 0.1 | 11.4 / 11.4 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0 | 0.7 | 3.1 | 60.6 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) | Rotterdam z9 | spenta | 1437 | 0 / 0 | 60.2 | 0.1 | 3.2 / 3.2 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.8 | 19 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) | Rotterdam z9 | accesa | 1437 | 500 / 853 | 60 | 0.5 | 2.8 / 6.6 | 0 (max 0) · 0 (max 0), 2 risposte | 0.9 / 0.4 | 1.2 | 0.8 | 7.6 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) | Rotterdam z13 | spenta | 320 | 0 / 0 | 60.2 | 0 | 0 / 0 | 0 (max 0) · 0 (max 0), 1 risposte | 0 / 0 | 0 | 0.4 | 2.6 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) | Rotterdam z13 | accesa | 321 | 59 / 59 | 60 | 2 | 0.4 / 1.1 | 0 (max 0) · 0 (max 0), 2 risposte | 1.9 / 44.2 | 0.6 | 0.3 | 2.2 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16), seconda misura (c567540+modifiche) | mondo z3 | spenta | 6000 | 0 / 0 | 59.6 | 0.1 | 19.8 / 19.8 | 0 (max 0) · 2 (max 68), 2 risposte | 0 / 0 | 0 | 8.4 | 64.3 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16), seconda misura (c567540+modifiche) | mondo z3 | accesa | 6000 | 500 / 3578 | 59.9 | 0.1 | 9.7 / 9.7 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0 | 0.6 | 2 | 52.4 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16), seconda misura (c567540+modifiche) | Rotterdam z9 | spenta | 1437 | 0 / 0 | 60.2 | 0.1 | 2.7 / 2.7 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.5 | 13.9 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16), seconda misura (c567540+modifiche) | Rotterdam z9 | accesa | 1437 | 500 / 839 | 60.1 | 0.5 | 0.8 / 3.9 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0.4 | 1.8 | 1.5 | 9.6 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16), seconda misura (c567540+modifiche) | Rotterdam z13 | spenta | 320 | 0 / 0 | 60.2 | 0.1 | 0.7 / 0.7 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.5 | 4.2 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16), seconda misura (c567540+modifiche) | Rotterdam z13 | accesa | 321 | 59 / 59 | 60.1 | 1.5 | 0.4 / 1 | 0 (max 0) · 0 (max 0), 2 risposte | 1.9 / 43.5 | 0.7 | 0.5 | 3.1 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) · CPU 4× | mondo z3 | spenta | 6000 | 0 / 0 | 57.8 | 0.1 | 54.3 / 54.3 | 0 (max 0) · 2 (max 230), 2 risposte | 0 / 0 | 0 | 14 | 174.6 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) · CPU 4× | mondo z3 | accesa | 6000 | 500 / 3578 | 57.7 | 0.1 | 47.5 / 47.5 | 0 (max 0) · 3 (max 213), 2 risposte | 1 / 0 | 6.1 | 13.8 | 162.6 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) · CPU 4× | Rotterdam z9 | spenta | 1437 | 0 / 0 | 59.4 | 0.1 | 23 / 23 | 0 (max 0) · 2 (max 87), 2 risposte | 0 / 0 | 0 | 2.3 | 47.3 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) · CPU 4× | Rotterdam z9 | accesa | 1437 | 500 / 853 | 58.4 | 0.8 | 14.6 / 38.6 | 2 (max 77) · 3 (max 106), 2 risposte | 1 / 14.8 | 6.5 | 3.9 | 56 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) · CPU 4× | Rotterdam z13 | spenta | 320 | 0 / 0 | 60 | 0.1 | 4.5 / 4.5 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 3.2 | 21.8 |
| 2026-11-26 | punti 13, 63, 42 (ANIM_MAX 500, minMs 16) (c567540+modifiche) · CPU 4× | Rotterdam z13 | accesa | 321 | 59 / 59 | 60 | 2 | 2 / 7.3 | 0 (max 0) · 0 (max 0), 2 risposte | 1.9 / 43.6 | 2.2 | 1.5 | 26.4 |
| 2026-11-27 | dopo l'unione con il punto 12 (821d964+modifiche) | mondo z3 | spenta | 6000 | 0 / 0 | 59.6 | 0.1 | 22.6 / 22.6 | 0 (max 0) · 2 (max 66), 2 risposte | 0 / 0 | 0 | 3.3 | 60.1 |
| 2026-11-27 | dopo l'unione con il punto 12 (821d964+modifiche) | mondo z3 | accesa | 6000 | 500 / 3578 | 59.7 | 0.1 | 12.2 / 12.2 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0 | 0.8 | 4.3 | 56 |
| 2026-11-27 | dopo l'unione con il punto 12 (821d964+modifiche) | Rotterdam z9 | spenta | 1437 | 0 / 0 | 60.2 | 0.1 | 3.2 / 3.2 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.7 | 11.1 |
| 2026-11-27 | dopo l'unione con il punto 12 (821d964+modifiche) | Rotterdam z9 | accesa | 1437 | 500 / 839 | 60 | 0.5 | 1.4 / 5.5 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0.4 | 0.8 | 1.5 | 15.1 |
| 2026-11-27 | dopo l'unione con il punto 12 (821d964+modifiche) | Rotterdam z13 | spenta | 320 | 0 / 0 | 60.2 | 0.1 | 1 / 1 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 1.3 | 9 |
| 2026-11-27 | dopo l'unione con il punto 12 (821d964+modifiche) | Rotterdam z13 | accesa | 321 | 59 / 59 | 60.1 | 1.7 | 0.4 / 1.3 | 0 (max 0) · 0 (max 0), 2 risposte | 1.9 / 43.4 | 0.5 | 0.4 | 3.6 |
| 2026-11-27 | dopo l'unione con il punto 12, seconda misura (821d964+modifiche) | mondo z3 | spenta | 6000 | 0 / 0 | 59.7 | 0.1 | 19.3 / 19.3 | 0 (max 0) · 2 (max 61), 2 risposte | 0 / 0 | 0 | 3.4 | 78.3 |
| 2026-11-27 | dopo l'unione con il punto 12, seconda misura (821d964+modifiche) | mondo z3 | accesa | 6000 | 500 / 3578 | 59.7 | 0.1 | 13.6 / 13.6 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0 | 0.8 | 5.3 | 53.3 |
| 2026-11-27 | dopo l'unione con il punto 12, seconda misura (821d964+modifiche) | Rotterdam z9 | spenta | 1437 | 0 / 0 | 60.1 | 0.1 | 5.2 / 5.2 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.4 | 9.5 |
| 2026-11-27 | dopo l'unione con il punto 12, seconda misura (821d964+modifiche) | Rotterdam z9 | accesa | 1437 | 500 / 839 | 60 | 0.5 | 1 / 14.2 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0.4 | 1.1 | 2.6 | 7.1 |
| 2026-11-27 | dopo l'unione con il punto 12, seconda misura (821d964+modifiche) | Rotterdam z13 | spenta | 320 | 0 / 0 | 60.2 | 0.1 | 0.7 / 0.7 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.4 | 5.1 |
| 2026-11-27 | dopo l'unione con il punto 12, seconda misura (821d964+modifiche) | Rotterdam z13 | accesa | 321 | 59 / 59 | 60 | 2 | 0.4 / 0.8 | 0 (max 0) · 0 (max 0), 2 risposte | 1.9 / 43.1 | 0.4 | 0.2 | 4 |
| 2026-11-27 | punto 71 (pannello chiuso) (51cac37+modifiche) | mondo z3 | spenta | 6000 | 0 / 0 | 59.7 | 0.1 | 12.4 / 12.4 | 0 (max 0) · 1 (max 62), 2 risposte | 0 / 0 | 0 | 3 | 53.2 |
| 2026-11-27 | punto 71 (pannello chiuso) (51cac37+modifiche) | mondo z3 | accesa | 6000 | 500 / 3578 | 59.8 | 0.1 | 12.5 / 12.5 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0 | 2 | 3.2 | 47.5 |
| 2026-11-27 | punto 71 (pannello chiuso) (51cac37+modifiche) | Rotterdam z9 | spenta | 1437 | 0 / 0 | 60.2 | 0.1 | 2.9 / 2.9 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.5 | 12.9 |
| 2026-11-27 | punto 71 (pannello chiuso) (51cac37+modifiche) | Rotterdam z9 | accesa | 1437 | 500 / 839 | 60.1 | 0.5 | 1.7 / 4.8 | 0 (max 0) · 0 (max 0), 2 risposte | 1 / 0.4 | 3.3 | 1.1 | 8.1 |
| 2026-11-27 | punto 71 (pannello chiuso) (51cac37+modifiche) | Rotterdam z13 | spenta | 320 | 0 / 0 | 60.1 | 0.1 | 0.7 / 0.7 | 0 (max 0) · 0 (max 0), 2 risposte | 0 / 0 | 0 | 0.7 | 2.4 |
| 2026-11-27 | punto 71 (pannello chiuso) (51cac37+modifiche) | Rotterdam z13 | accesa | 321 | 59 / 59 | 60 | 1.6 | 0.5 / 1 | 0 (max 0) · 0 (max 0), 2 risposte | 1.8 / 39.9 | 0.5 | 0.2 | 3.3 |
<!-- fine della misura precedente -->

Nota (2026-11-27, dopo l'unione con il punto 12): a zoom 3 l'animatore non sposta nessun marker (meno di 0,5 px,
0 `setLatLng`/s), quindi l'unico ridisegno della misura (0,1/s) è quello dei dati arrivati, presente anche ad animazione
spenta (19-24 ms, più lento che accesa): la soglia «mondo p95 ≤ 12 ms» (12,2 e 13,6 ms) misura quel ridisegno, non il
movimento. Anche la differenza di `loadLocations` a Rotterdam z9 cambia segno da una misura all'altra (+4,0, −2,4 ms).
Una prova con `ANIM_MAX` 200 e `ANIM_MIN_MS` 50 dà gli stessi due scostamenti (12,8 ms; +2,3 ms): restano 500 e 16.

Nota (2026-11-27, punto 71): le righe «punto 71 (pannello chiuso)» sono la pagina con il pannello dell'elenco chiuso
(a 1280×800 l'elenco resta spento: a ogni giro si conta solo quante navi ci sono nella vista). Unico scostamento dalle
soglie quello già noto del ridisegno dei dati arrivati a zoom 3 (12,5 ms, come 12,2 e 13,6 delle misure di prima).

### Pannello con l'elenco (punto 71)

Misura a mano (non c'è uno script) con le stesse navi sintetiche: `node tools/smoke-server.js 8942 --navi 30000` e
agent-browser (Leaflet locale come in `tools/smoke-browser.sh`), vista mondo a zoom 3 (6000 marker, 3578 nella vista).

- Ridisegno dell'elenco (`renderList`, durata in `sheet.stats.renderMs`): a 1280×800 con «Elenco» acceso, 30 chiamate
  per ordinamento con l'elenco invariato (si calcola tutto ma non si riscrive il DOM) e 30 con il DOM riscritto
  (`sheet.html = ''` prima di ogni chiamata). Soglia: < 8 ms.
- Trascinamento: a 390×844, mouse giù sulla maniglia, 500 px in su in 60 passi (1 s) e 150 px in giù in 30 passi
  (0,5 s), poi su; long task (`PerformanceObserver` «longtask») e intervalli fra i fotogrammi `requestAnimationFrame`.
  Soglia: nessun long task > 50 ms. Lo smoke (`tools/smoke-browser.sh`, telefono) controlla di nuovo i long task durante
  i suoi tre trascinamenti veri.

| Data | Versione | Misura | Risultato |
|---|---|---|---|
| 2026-11-27 | punto 71 (51cac37+modifiche) | elenco per nome, 6000 marker | invariato p50 3,3 / p95 5,4 ms · riscritto p50 4,0 / p95 4,5 / max 4,6 ms |
| 2026-11-27 | punto 71 (51cac37+modifiche) | elenco per velocità | invariato 1,7 / 2,4 ms · riscritto 2,7 / 5,4 / max 5,9 ms |
| 2026-11-27 | punto 71 (51cac37+modifiche) | elenco per ultimo segnale | invariato 5,6 / 6,2 ms · riscritto 4,9 / 6,5 / max 7,3 ms |
| 2026-11-27 | punto 71 (51cac37+modifiche) | elenco per tipo | invariato 3,4 / 4,5 ms · riscritto 2,7 / 3,2 / max 3,4 ms |
| 2026-11-27 | punto 71 (51cac37+modifiche) | trascinamento 1,5 s a 390×844, 6000 marker | 59 fps, fotogramma p95 16,8 / max 16,8 ms, nessun long task (tre prove) |
| 2026-11-27 | punto 71 (51cac37+modifiche) | smoke, tre trascinamenti veri (3,2 s) | nessun long task |
