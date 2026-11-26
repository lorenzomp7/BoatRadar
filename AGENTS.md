# BoatRadar

Mappa live delle imbarcazioni (AIS). Un server Node senza framework riceve i
dati da aisstream.io via WebSocket, tiene in memoria l'ultima posizione di ogni
nave e li serve alla pagina. La pagina è su GitHub Pages, il server su una VM Oracle
Cloud Always Free con Docker e Caddy (`deploy/`, workflow in `.github/workflows/`) e, di riserva,
su Render Free (`render.yaml`, si addormenta dopo 15 minuti senza visite). Ruoli, costi e come
cambiare backend: `deploy/README.md`, sezione «Due backend».
Render include solo 5 GB al mese di traffico in uscita (circa 90 ore di una scheda sulla vista mondo):
la VM resta il server principale, Render solo la riserva.
Lavora su `main_claude` salvo indicazione diversa.

## Struttura

- `server.js`: connessione aisstream.io (riconnessione, backoff che torna a 1 s solo con un vero
  messaggio AIS, 429), stato in
  memoria, API `/api/locations` (GeoJSON, filtro `bbox`, campione per importanza con `limit` (`sample.js`), in cache; con
  `include=mmsi,…`, al massimo 50, solo quelle navi, fuori dalla cache),
  `/api/vessel`, `/api/search`, `/api/status`. Conservazione (punto 8): posizioni di navi in moto 30 min, ferme
  (`isStill`) 6 h (`STALE_MOVING_MS`, `STALE_STILL_MS`, `limits` effettivi in `/api/status`, usati anche dalla pagina
  per le navi del server); le risposte escludono le scadute
  anche prima della pulizia e una voce della cache «a dati fermi» vale solo fino alla prima scadenza delle sue navi.
- `sample.js`: funzioni pure del campione di `/api/locations` (punto 4): oltre `limit` restano le navi più
  importanti (classe A, in moto, lunghe, cargo/petroliere/passeggeri, posizione recente: -1 ogni 10 min fino a 30 min,
  poi -1 per ora o frazione fino a -8), al massimo
  `ceil(limit / 64²)` per cella di una griglia 64 × 64 sul bbox prima di riempire con le altre; la parte statica del
  punteggio (`staticScore`) la calcola `handle()`. Test in `test/sample.test.js` e `test/campione.test.js`. Va nella
  `COPY` del `Dockerfile`, nei `paths` di `deploy-backend.yml` e `browser.yml` e in `node --check` di `test.yml`
  (lo controlla un test).
- `position-check.js`: funzioni pure usate da `server.js` per scartare posizioni non valide e
  salti impossibili (accettati se confermati da una seconda posizione); il conteggio degli scarti
  è `rejected` in `/api/status`. Va nella riga `COPY` del `Dockerfile` (lo controlla un test).
- `boatradar.html`: tutta l'interfaccia (mappa, scheda nave, ricerca proprietari).
- `public/ais-logic.js`: funzioni pure della pagina (tipi di nave, ETA, ricerca locale, età della posizione…), modulo UMD
  (`window.AisLogic` nel browser, `require` in Node) con test in `test/ais-logic.test.js`. server.js lo
  usa per i limiti di conservazione (`retentionMs`) e lo serve da un elenco fisso; va nella `COPY` del `Dockerfile` e in `pages.yml`, che nella pagina pubblicata
  aggiunge `?v=<commit>` allo script contro la cache (lo controlla un test).
- `vesselfinder.html`: mappa alternativa con il widget VesselFinder.
- `config.js` (solo su Pages, scritto da `tools/config-pages.js` in `pages.yml` con le variabili
  `API_HOST`/`VM_HOST` e `RENDER_HOST`): elenco dei server in `window.BOATRADAR_APIS`
  (`{url, name, sleeps}`, prima la VM poi Render) e il primo in `window.BOATRADAR_API`. Servito vuoto da
  `server.js` in locale. Test in `test/backend.test.js`. La pagina (punto 86) parte dal primo e passa al
  successivo solo quando sbaglia la richiesta della vista (`apiList` e `createFailover` di `public/ais-logic.js`,
  test in `test/backend-pagina.test.js` e `test/pagina-backend.test.js`, che usa `test/pagina-helpers.js`);
  non torna da sola alla VM e ricorda il server per la sessione della scheda (`sessionStorage`): per la quota di
  Render vedi `deploy/README.md`, «Passaggio automatico nella pagina».
- `Dockerfile`, `deploy/`: immagine e avvio sulla VM; `deploy/README.md` spiega la configurazione.
- `render.yaml`: Blueprint del servizio Render (Docker, piano Free, `AISSTREAM_KEY` con `sync: false`,
  da impostare solo su Render). Ogni file nelle `COPY` del `Dockerfile` va nei `paths` di
  `deploy-backend.yml` e nel `buildFilter` di `render.yaml` (lo controlla un test). La VM e Render
  usano due chiavi aisstream diverse.
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
  `aisstream.io: connesso (compressione: sì|no)` e poi `sottoscrizione confermata (compressione: sì|no)`,
  e la riporta `compression` in `/api/status` (`negotiated`: accettata all'apertura; `confirmed`:
  `CompressionEnabled` della conferma di aisstream, `null` finché non arriva). Via Proxelar risulta
  sempre `negotiated: false` e la pagina mostra l'avviso di connessione non compressa. Poiché aisstream limita la banda delle
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
  a 1280×800 e 390×844, controlla navi in mappa, apertura della scheda con un clic vero del mouse,
  chiusura con un clic vero sulla × (almeno 44×44 px, non coperta dall'header) e con Esc, e assenza di
  errori JavaScript; poi, con l'orologio della pagina e `serverTime` 40 min avanti, che le navi in moto spariscano e
  quella ormeggiata resti tratteggiata con il pallino rosso in scheda (punto 8); infine, con `window.BOATRADAR_APIS`
  di prova (primo server morto su 127.0.0.1:9, secondo il server di prova; `SMOKE_APIS` per cambiarli), che la pagina
  passi al secondo con «server di riserva (Render)» nella riga di stato, e che con il primo buono non chieda nulla al
  secondo (punto 86). Esce con 1 al primo problema; screenshot in `diagnosi/smoke/`.
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
