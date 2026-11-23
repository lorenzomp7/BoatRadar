# BoatRadar

Mappa live delle imbarcazioni (AIS). Un server Node senza framework riceve i
dati da aisstream.io via WebSocket, tiene in memoria l'ultima posizione di ogni
nave e li serve alla pagina. Deploy su Render (piano gratuito).
Lavora su `main_claude` salvo indicazione diversa.

## Struttura

- `server.js`: connessione aisstream.io (riconnessione, backoff, 429), stato in
  memoria, API `/api/locations` (GeoJSON, filtro `bbox`, campione con `limit`),
  `/api/vessel`, `/api/search`, `/api/status`.
- `boatradar.html`: tutta l'interfaccia (mappa, scheda nave, ricerca proprietari).
- `vesselfinder.html`: mappa alternativa con il widget VesselFinder.
- `test/server.test.js`: avvia il vero `server.js` contro un finto aisstream
  locale (`AISSTREAM_URL`), senza rete esterna.

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
   (Windows PowerShell: imposta le stesse variabili con `$env:NOME="valore"`). Senza
   `NODE_USE_ENV_PROXY=1` il server ignora il proxy e si collega diretto.
3. Lascia arrivare i dati per 2-5 minuti, poi `Ctrl+C` su Proxelar (scrive la sessione) e sul server.
4. Estrai misure e fixture: `node tools/estrai-fixture.js diagnosi/aisstream.proxelar.json --out test/fixtures/aisstream-<zona>.json`.
   Stampa messaggi al secondo, KB/s, peso medio, tipi e posizioni anomale; la fixture contiene
   fino a 100 messaggi (`--max`), con tutte le posizioni anomale, senza chiave.
5. `npm test`: `test/fixtures.test.js` rimanda al server ogni `test/fixtures/aisstream-*.json`.

Attenzione:

- La sessione `.proxelar.json` **non è redatta** e contiene la chiave: resta in `diagnosi/`
  (ignorata da git) e va cancellata dopo l'estrazione. Committa solo la fixture.
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
