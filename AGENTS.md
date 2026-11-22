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
- `boatradar.html`: tutta l'interfaccia (mappa, scheda nave, ricerca proprietari).
- `vesselfinder.html`: mappa alternativa con il widget VesselFinder.
- `config.js` (solo su Pages, generato dal workflow): indirizzo del server in
  `window.BOATRADAR_API`; servito vuoto da `server.js` in locale.
- `Dockerfile`, `deploy/`: immagine e avvio sulla VM; `deploy/README.md` spiega la configurazione.
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
larghezza da telefono, e dillo esplicitamente se non hai potuto farlo.

## Regole del progetto

- Ogni modifica a parsing AIS, filtri o API va con un test in `test/`.
- Coordinate GeoJSON in ordine `[lon, lat]`; il `bbox` è `minLon,minLat,maxLon,maxLat`
  e può attraversare l'antimeridiano (minLon > maxLon).
- Rispetta i limiti di aisstream.io: una sola connessione per chiave, niente
  riconnessioni aggressive (dopo un 429 si aspetta almeno un minuto).
- Non salvare né committare mai la chiave aisstream.
- Le fonti sui proprietari sono link a registri pubblici consultati dall'utente:
  non aggiungere scraping automatico di dati personali.
