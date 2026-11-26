# BoatRadar

Mappa live delle imbarcazioni (AIS). Un server Node senza framework riceve i
dati da aisstream.io via WebSocket, tiene in memoria l'ultima posizione di ogni
nave e li serve alla pagina. La pagina è su GitHub Pages, il server su una VM Oracle
Cloud Always Free con Docker e Caddy (`deploy/`, workflow in `.github/workflows/`).
Lavora su `main_claude` salvo indicazione diversa.

## Struttura

- `server.js`: connessione aisstream.io (riconnessione, backoff, 429), stato in
  memoria, API `/api/locations` (GeoJSON, filtro `bbox`, campione con `limit`),
  `/api/vessel`, `/api/search`, `/api/status`.
- `position-check.js`: funzioni pure usate da `server.js` per scartare posizioni non valide e
  salti impossibili (accettati se confermati da una seconda posizione); il conteggio degli scarti
  è `rejected` in `/api/status`. Va nella riga `COPY` del `Dockerfile` (lo controlla un test).
- `boatradar.html`: tutta l'interfaccia (mappa, scheda nave, ricerca proprietari).
- `public/ais-logic.js`: funzioni pure della pagina (tipi di nave, ETA, ricerca locale…), modulo UMD
  (`window.AisLogic` nel browser, `require` in Node) con test in `test/ais-logic.test.js`. server.js lo
  serve da un elenco fisso; va nella `COPY` del `Dockerfile` e in `pages.yml` (lo controlla un test).
- `vesselfinder.html`: mappa alternativa con il widget VesselFinder.
- `config.js` (solo su Pages, generato dal workflow): indirizzo del server in
  `window.BOATRADAR_API`; servito vuoto da `server.js` in locale.
- `Dockerfile`, `deploy/`: immagine e avvio sulla VM; `deploy/README.md` spiega la configurazione.
- `test/server.test.js`: avvia il vero `server.js` contro un finto aisstream
  locale (`AISSTREAM_URL`), senza rete esterna. `test/position-check.test.js`: test unitari.

## Comandi (Node ≥ 22)

| Scopo | Comando |
|---|---|
| Dipendenze | `npm install` |
| **Verifica standard** | `npm test` (meno di un secondo, gira anche in CI) |
| Avvio | `node server.js` → http://localhost:8765 |
| Dati mondiali | `AISSTREAM_KEY=...` oppure file `aisstream-key.txt` (ignorato da git) |

Esegui la verifica standard prima di dichiarare finito un cambio a `server.js`.
Per modifiche a `boatradar.html` verifica la pagina nel browser, anche su
larghezza da telefono (`bash tools/smoke-browser.sh`, sezione «Verifica nel browser»),
e dillo esplicitamente se non hai potuto farlo.

## Regole del progetto

- Ogni modifica a parsing AIS, filtri o API va con un test in `test/`.
- Coordinate GeoJSON in ordine `[lon, lat]`; il `bbox` è `minLon,minLat,maxLon,maxLat`
  e può attraversare l'antimeridiano (minLon > maxLon).
- Rispetta i limiti di aisstream.io: una sola connessione per chiave, niente
  riconnessioni aggressive (dopo un 429 si aspetta almeno un minuto).
- Non salvare né committare mai la chiave aisstream.
- Le fonti sui proprietari sono link a registri pubblici consultati dall'utente:
  non aggiungere scraping automatico di dati personali.

## Diagnosi del flusso aisstream (Proxelar)

[Proxelar](https://github.com/emanuele-em/proxelar) (MIT, v0.7.0) è un proxy locale che mostra
i frame WebSocket fra `server.js` e aisstream: serve a misurare peso e frequenza dei messaggi e a
registrare messaggi veri per i test. Si usa solo in locale, mai sul server in cloud.

1. Installa Proxelar (`brew install proxelar`, `cargo install proxelar` o l'immagine Docker
   `ghcr.io/emanuele-em/proxelar`) e avvialo in modo forward salvando la sessione:
   `mkdir -p diagnosi && proxelar -i terminal --save-session diagnosi/aisstream.proxelar.json`
   (porta 8080; al primo avvio crea la CA in `~/.proxelar/proxelar-ca.pem`).
2. In un altro terminale avvia il server attraverso il proxy:
   `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8080 NODE_EXTRA_CA_CERTS=~/.proxelar/proxelar-ca.pem node server.js`
   (Windows PowerShell: imposta le stesse variabili con `$env:NOME="valore"` e toglile con
   `Remove-Item Env:NOME` quando hai finito). Senza `NODE_USE_ENV_PROXY=1` il server ignora il
   proxy e si collega diretto. Provato con Node 22.23; con versioni di Node che non conoscono
   `NODE_USE_ENV_PROXY` il server va diretto e Proxelar non mostra connessioni.
3. Lascia arrivare i dati per 2-5 minuti, poi `Ctrl+C` prima sul server e poi su Proxelar
   (che alla chiusura scrive la sessione).
4. Estrai misure e fixture: `node tools/estrai-fixture.js diagnosi/aisstream.proxelar.json --out test/fixtures/aisstream-<zona>.json`.
   Stampa messaggi al secondo, KB/s, peso medio, tipi e posizioni anomale; la fixture contiene
   fino a 100 messaggi (`--max`), prima le posizioni anomale e poi un po' di ogni tipo, senza
   chiave. Non sovrascrive una fixture esistente se non aggiungi `--sovrascrivi`.
5. `npm test`: `test/fixtures.test.js` rimanda al server ogni `test/fixtures/aisstream-*.json`.

Attenzione:

- La sessione `.proxelar.json` **non è redatta** e contiene la chiave: resta in `diagnosi/`
  (ignorata da git) e va cancellata dopo l'estrazione. Committa solo la fixture. Anche
  l'interfaccia di Proxelar mostra a schermo il messaggio di sottoscrizione con la chiave: non
  registrare né condividere lo schermo durante la diagnosi.
- Proxelar toglie l'offerta `permessage-deflate` verso aisstream: via proxy la connessione è
  sempre non compressa, quindi le misure sono sul peso non compresso e la compressione reale non
  si vede da lì. La dice il log di `server.js` collegato diretto:
  `aisstream.io: connesso (compressione: sì|no)`. Poiché aisstream limita la banda delle
  connessioni non compresse, tieni brevi le registrazioni: se il conteggio al secondo è molto
  più basso di quello del server collegato diretto, aisstream sta scartando messaggi.
- Una sola connessione per chiave: ferma ogni altro `server.js` con la stessa chiave (anche quello in cloud)
  durante la registrazione, oppure usa una chiave separata.

## Verifica nel browser (agent-browser)

Per le verifiche nel browser usa [agent-browser](https://github.com/vercel-labs/agent-browser)
(Apache-2.0, v0.44.0): prima del primo uso esegui `agent-browser skills get core` e seguilo.
Funziona anche nelle sessioni cloud e in GitHub Actions.

- Installazione: `npm install -g agent-browser@0.44.0 && agent-browser install`
  (su Linux `--with-deps`). Se c'è già un Chrome, `AGENT_BROWSER_EXECUTABLE_PATH=/percorso/chrome`.
- Verifica completa: `bash tools/smoke-browser.sh` (su Windows da Git Bash o WSL). Avvia
  `server.js` con la fixture di esempio (`tools/smoke-server.js`, senza chiave), apre la pagina
  a 1280×800 e 390×844, controlla navi in mappa, apertura della scheda con un clic vero del mouse
  e assenza di errori JavaScript. Esce con 1 al primo problema; screenshot in `diagnosi/smoke/`.
- Pagina già pubblicata: `SMOKE_URL=https://... bash tools/smoke-browser.sh` (usa le navi vere).
- Rete senza unpkg.com (alcune sessioni cloud): `SMOKE_LEAFLET_LOCAL=1` carica Leaflet 1.9.4 dal
  registro npm. Senza tile la mappa resta scura: è normale.
- In CI il workflow `Browser` la esegue quando cambiano pagina, server, fixture o la verifica.

## Prestazioni (flameox)

Prima di ottimizzare `server.js` misura con `tools/carico.js` (stesse navi a ogni misura) e, per
sapere dove vanno CPU e memoria, con [flameox](https://github.com/morluto/flameox) (MIT, v0.2.9).
Comandi, interpretazione e tabella dei risultati in `docs/prestazioni.md`: aggiungi una riga con
`--registra` prima e dopo ogni modifica che tocca `/api/locations` o lo stato in memoria.

## App di riferimento (REA)

Per studiare le app di tracciamento navi del Piano dall'APK usa
[REA](https://github.com/morluto/rea) (MIT, v6.10.1) con `bash tools/analizza-apk.sh`.
Procedura, strumenti e app da analizzare in `docs/app-analizzate/README.md`. Gli APK restano
fuori dalla repo (`diagnosi/apk/`); si committa solo la scheda `docs/app-analizzate/<pacchetto>.md`.
Dalla chat: server MCP `rea` in `.mcp.json` e skill `rea` (Claude installa JADX e Apktool da solo).
