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
arrotondato verso l'esterno a 0,25°; `LOCATIONS_CACHE_SIZE` (default 50, 0 = spenta) viste tenute;
`hits`, `misses` e `size` in `locationsCache` di `/api/status`, intestazione `X-Cache: hit|miss`.

- La riga «dopo punto 84» è il **caso migliore**: `tools/carico.js` chiede sempre la stessa vista
  senza messaggi AIS nel frattempo, quindi tutte le richieste tranne la prima sono servite dalla cache.
  Con il flusso vero i dati cambiano di continuo e conta la regola dei 3 s: più utenti sulla stessa
  zona (o la stessa pagina che si aggiorna) entro 3 s condividono una risposta già compressa.
- Con la cache spenta (o a ogni miss) la risposta costa un po' di più di prima (mondo circa
  33-35 ms invece di 27-29 ms in tre ripetizioni; porto 9-11 invece di 7-8 ms): il gzip ora è
  asincrono e passa dal thread pool di libuv. In cambio non blocca più il ciclo degli eventi, quindi
  la ricezione AIS e le altre richieste vanno avanti durante la compressione (questo il carico
  sequenziale non lo misura). Un `chunkSize` più grande per `zlib.gzip` non cambia i tempi.

| Data | Versione | Navi | MB/1000 navi | RSS MB | Mondo: navi | Mondo: KB gzip (raw) | Mondo: ms mediana / p95 | Porto: navi | Porto: KB gzip (raw) | Porto: ms mediana / p95 | Node |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-23 | riferimento (prima dei punti 4, 21, 22) · cloud Claude | 30000 | 0.5 | 168.2 | 5979 | 227.1 (1459.5) | 31.5 / 38.6 | 1427 | 53.1 (346.9) | 8.3 / 9.8 | v22.23.5 |
| 2026-11-26 | prima punto 1 (scarto posizioni) | 30000 | 0.5 | 165.5 | 5979 | 227.2 (1459.5) | 39.1 / 43.7 | 1427 | 53.1 (346.9) | 8.3 / 13.9 | v22.23.5 |
| 2026-11-26 | dopo punto 1 (scarto posizioni) | 30000 | 0.5 | 166.7 | 5979 | 227.3 (1459.5) | 37 / 46.1 | 1427 | 53.1 (346.9) | 8.3 / 13.1 | v22.23.5 |
| 2026-11-26 | prima punto 84 (cache /api/locations), con punti 1, 7, 11 | 30000 | 0.5 | 169 | 5979 | 227.1 (1459.5) | 28.8 / 33.6 | 1427 | 53 (346.9) | 8.4 / 11.8 | v22.23.5 |
| 2026-11-26 | dopo punto 84 (cache /api/locations, caso migliore: vista ripetuta senza messaggi) | 30000 | 0.5 | 168.9 | 5979 | 227.8 (1459.5) | 0.9 / 1.5 | 1427 | 53.3 (346.9) | 0.5 / 0.8 | v22.23.5 |
| 2026-11-26 | dopo punto 84 con LOCATIONS_CACHE_SIZE=0 (cache spenta, gzip asincrono) | 30000 | 0.5 | 167.7 | 5979 | 227.3 (1459.5) | 34.5 / 40.6 | 1427 | 53.1 (346.9) | 11.5 / 16.2 | v22.23.5 |
<!-- nuove righe sopra questa linea -->
