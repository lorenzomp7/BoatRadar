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

`--registra` aggiunge una riga alla tabella qui sotto; `--json file` salva tutto. Client e server
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
| 2026-11-26 | prima punto 4 (campione per importanza), con punti 43, 5, 3 | 30000 | 0.51 | 169.3 | 5979 | 248.2 (1603.7) | 1.2 / 2.1 | 1427 | 58.2 (381.3) | 0.6 / 0.9 | v22.23.5 |
| 2026-11-26 | prima punto 4 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.51 | 168.7 | 5979 | 247.9 (1603.7) | 40.8 / 56.2 | 1427 | 58.1 (381.3) | 13.1 / 16.1 | v22.23.5 |
| 2026-11-26 | dopo punto 4 (campione per importanza; caso migliore: vista ripetuta) | 30000 | 0.55 | 169.4 | 6000 | 255 (1614.9) | 1.3 / 2.3 | 1427 | 58.1 (381.3) | 0.6 / 1 | v22.23.5 |
| 2026-11-26 | dopo punto 4 con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.55 | 171.1 | 6000 | 255.7 (1614.9) | 43.1 / 58.1 | 1427 | 58.3 (381.3) | 11 / 14.4 | v22.23.5 |
| 2026-11-26 | dopo correzioni punto 4 (ordinamento semplice) | 30000 | 0.55 | 169.7 | 6000 | 255.3 (1614.9) | 1 / 4.1 | 1427 | 58.2 (381.3) | 0.9 / 1.2 | v22.23.5 |
| 2026-11-26 | dopo correzioni punto 4 (ordinamento semplice) con LOCATIONS_CACHE_SIZE=0 (cache spenta) | 30000 | 0.55 | 171.4 | 6000 | 255.4 (1614.9) | 53.7 / 66.1 | 1427 | 58.2 (381.3) | 13.9 / 36 | v22.23.5 |
<!-- nuove righe sopra questa linea -->
