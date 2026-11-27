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
  `include=mmsi,…`, al massimo 50, solo quelle navi, fuori dalla cache; filtri del punto 9 `types`, `status`, `minSog`,
  `maxSog`, `seen`, `moving` applicati prima del campione, con `parseFilter`/`passesFilter` di `public/ais-logic.js`;
  `moving=1` vuol dire «non ferma» (`!isStill`, comprese le navi con velocità non disponibile), `moving=0` ferme;
  il filtro applicato torna in `filter` della risposta; le voci filtrate hanno in cache una quota loro,
  `LOCATIONS_CACHE_FILTERED`, e non espellono mai quelle senza filtro),
  `/api/vessel`, `/api/search` (punto 12: tutte le navi con posizione valida, punteggio con `scoreFields` e ordine di
  `compareSearch` di `public/ais-logic.js` — MMSI o IMO esatto, nome esatto, nominativo esatto, inizio del nome, … — poi
  posizione più recente e MMSI, le prime 25 tenute con `insertTop`; testo confrontato con `norm`/`normQuery`: senza
  accenti, `- . /` come spazio, senza il prefisso «IMO »; nomi e nominativi normalizzati una volta all'arrivo, in
  `searchNames` solo se diversi da quelli salvati; la pagina aspetta 250 ms fra i tasti, annulla la richiesta precedente e
  fino ai risultati nuovi mostra «In aggiornamento…» senza righe sceglibili, unisce le navi in mappa e mostra righe
  `role="option"` con «(almeno) N navi con questo nome» e una regione `aria-live` con il numero di risultati; test in
  `test/ricerca*.test.js` e `test/pagina-ricerca.test.js`), `/api/status`. I messaggi con `MetaData.MMSI` non intero da 1 a
  9 cifre si scartano. Conservazione (punto 8): posizioni di navi in moto 30 min, ferme
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
- `public/ais-logic.js`: funzioni pure della pagina (tipi di nave, ETA, ricerca locale, età della posizione, filtri…), modulo UMD
  (`window.AisLogic` nel browser, `require` in Node) con test in `test/ais-logic.test.js` (filtri: `test/filtri-logica.test.js`).
  server.js lo usa per i limiti di conservazione (`retentionMs`) e i filtri (`parseFilter`, `filterKey`, `passesFilter`)
  e lo serve da un elenco fisso; va nella `COPY` del `Dockerfile` e in `pages.yml`, che nella pagina pubblicata
  aggiunge `?v=<commit>` allo script contro la cache (lo controlla un test).
- Scelta della nave toccata (punto 10): un clic sulla mappa raccoglie le navi entro `pickRadius` (8 px, 20 px su schermo
  touch; `canvasTolerance` 4/12 px per il renderer) con `nearbyMarkers` di `public/ais-logic.js`; con più navi la pagina
  apre il popup «N navi qui» (`pick()`, test in `test/pagina-scelta.test.js`): raggio del dito se l'evento viene da un
  dito (`pickTouch`), almeno il doppio del simbolo per ogni marker, al massimo 15 righe (`pickLimit`) più «e altre N:
  avvicina la mappa» (zoom + 2), altezza sullo spazio fra header e scheda (`pickMaxHeight`, almeno ~3 righe).
- Filtri nella pagina (punto 9 b): legenda «Legenda e filtri» con un pulsante per tipo (`aria-pressed`; spento = anello
  vuoto e testo barrato) e pannello «Filtri» (movimento, velocità da/a, «ricevute negli ultimi», stato di navigazione,
  «Mostra tutte»), salvati in `localStorage['boatradar:filtri']` come `filterKey` (nessun tipo acceso = `types=` davanti,
  nessuno stato di navigazione acceso = `status=` davanti; velocità e «ricevute negli ultimi» fuori dalle liste delle tendine
  portate al valore più vicino).
  Il filtro vale sempre nella pagina (`passesFilter` su tutte le fonti unite, anche il Baltico, anche su una risposta chiesta
  col filtro di prima) e, se attivo, va nella vista e nella prova della VM (`viewQuery`); la nave selezionata non si filtra
  mai; nessun tipo o nessuno stato acceso = niente vista né Baltico (`include=` sì; da un server di riserva la prova della VM
  è solo `/status`). Mappa vuota per i filtri: « · nessuna nave con questi filtri» e il pulsante «Mostra tutte» accanto alla
  riga di stato; dopo una ricarica con filtri del pannello `#filters` parte aperto. Esc con il focus nella legenda chiude
  prima «Filtri», poi la legenda (dopo gli Esc del popup e della ricerca); su telefono il titolo resta fisso in cima.
  Un cambio di filtro chiude il popup «N navi qui». I giri sono numerati (`roundSeq`): uno più vecchio dell'ultimo avviato
  non tocca marker né riga di stato. Test in `test/pagina-filtri.test.js`.
- Movimento fluido (punti 13, 63, 42): ogni marker tiene gli ultimi 3 fix (`m.track`, `pushFix`: stessa ora con
  coordinate diverse sostituisce l'ultimo, come `m.props`) e la posizione disegnata (`m.shown`); la mappa mostra le navi
  all'ora di riproduzione (ora corretta − 15 s, `ANIM_DELAY_MS`; `playbackTime` riparte dall'ora vera se è avanti più di
  2 s, es. orologio corretto dopo un primo `/api/status` in errore), calcolata una volta per fotogramma o giro:
  fra due fix l'interpolazione (rotta mai 360/511: quella valida di b o di a, o null), oltre l'ultimo la stima da velocità
  e rotta (`positionAt`: al massimo 242 s fino a 3 kn, 122 s oltre, mai per le navi ferme; `final` quando non si sposta
  più; `rhumbDestination` sempre finita anche ai poli). Età e dissolvenza del punto 8 restano del fix. Un solo ciclo
  (oggetto `anim`, con `anim.stats`): ogni 3 s sceglie nella vista al massimo `ANIM_MAX` (500) navi in movimento per
  `animPriority` (la selezionata sempre) e ricalcola le altre in un colpo; negli altri fotogrammi, ogni `frameInterval` ms
  (ridisegno misurato avvolgendo `renderer._redraw`), muove le scelte con `approach` (mai indietro sotto 300 m verso un
  bersaglio che avanzerà; verso uno `final` torna senza salti); le navi che escono dalle scelte scivolano alla loro
  posizione in al più `SETTLE_MS` (`anim.settle`). `setLatLng` solo da 0,5 px e mai con coordinate non finite. Senza navi
  da muovere nessun fotogramma (un `setTimeout` alla prossima scelta); con il prossimo passo oltre 100 ms un `setTimeout`
  (`animWake`) e poi un solo `requestAnimationFrame`. Pausa con mappa in movimento e scheda nascosta. Interruttore
  «Movimento fluido e posizione stimata» (`#smooth` nella legenda, `localStorage['boatradar:movimento']` '1'/'0'; senza
  scelta acceso, spento con `prefers-reduced-motion`, anche se cambia a pagina aperta; la casella mostra lo stato vero):
  spento, o senza `requestAnimationFrame`, marker all'ultimo fix e ciclo fermo. Riga «Posizione» in scheda (ultimo
  segnale / fra due segnali / stimata / segnale precedente, `positionWords`). Test in `test/movimento.test.js` e
  `test/pagina-movimento.test.js` (ora manuale, coda di `requestAnimationFrame`, risvegli `animWake` e `page.setMedia` di
  `test/pagina-helpers.js`). `tools/smoke-server.js` fa avanzare le navi lungo la rotta a ogni ripetizione (`--navi N`:
  navi di `tools/carico.js`; test in `test/smoke-server.test.js`); misura nel browser con `tools/misura-pagina.sh`
  (ordine alternato spenta/accesa/accesa/spenta e mediane, ridisegni divisi per causa, finestre dei dati dai segni
  `boatradar:load-start`/`-end`; soglie e perché in `docs/prestazioni.md`, «Pagina»). `ANIM_MAX` 500 e `ANIM_MIN_MS` 16
  restano finché reggono le soglie sui ridisegni causati dall'animatore; altrimenti `ANIM_MAX` 200 e `ANIM_MIN_MS` 50.
- Pannello con l'elenco (punto 71): `#sheet` «Navi in quest'area». Telefono (≤ 640 px): sempre in basso a tre altezze
  (`sheetStops`: chiuso 72 px con il conteggio, metà, aperto fin sotto l'header; `sheet.stop`, `--sheet-h` su `:root` per
  scheda, attribuzione, toast e legenda); maniglia (`#sheet-handle`, e `#panel-handle` della scheda, che ha la stessa
  altezza e si apre a metà): tocco/Invio/Spazio, frecce, trascinamento con pointer event e solo `transform` (`snapStop` sulla
  velocità degli ultimi 100 ms; durante il trascinamento click, frecce ed Esc non fanno niente e `setStop` lo annulla;
  `pointercancel` e `lostpointercapture` all'altezza più vicina). Salendo `--sheet-h` cambia subito, scendendo a fine
  discesa (`sheet.hold`). Chiudendo la scheda il pannello torna all'altezza di prima (anche dopo una rotazione), con il
  focus sulla riga; aprendola si chiudono il popup «N navi qui» (anche quando il pannello sale) e, su telefono, la legenda.
  Computer: `#listbtn` «☰ Elenco» (`aria-pressed`, `body.list-open`) lo apre a destra, sotto la scheda. Righe (`listRows`,
  al massimo 100, «e altre N») delle navi in mappa già filtrate nella vista, ordinate per nome/velocità/ultimo segnale/tipo
  (senza tipo in fondo; `localStorage['boatradar:ordine']`, solo chiavi proprie con `Object.hasOwn`), ridisegnate a ogni
  giro e `moveend` solo se visibili, cambiate e senza un puntatore premuto nell'elenco (focus sulla stessa nave, se sparisce
  sulla prima riga o sulla maniglia); a elenco chiuso solo il conteggio. Nota « · M di N nei dintorni: avvicina…» solo se
  il server ha mandato un campione (`worldShown` < `worldTotal`) per il filtro di adesso (`worldKey`, `activeFilterKey`).
  Nave scelta: su telefono zoom almeno 11 (da una riga); `keepVisible` → `panBy(panToKeepVisible(…))` (senza animazione con
  `prefers-reduced-motion`): sotto l'header, su telefono sopra la cima più alta di pannello, legenda e attribuzione, su
  computer a sinistra della scheda o dell'elenco (`rightInset`). Esc: popup, risultati, scheda, pannello. Test in
  `test/pannello-logica.test.js` e `test/pagina-pannello.test.js` (anche il trascinamento con pointer event finti).
- Scheda nave (lotto B, punti 27, 44, 46, 23; funzioni pure dopo `filterCount` in `public/ais-logic.js`, test in
  `test/scheda-logica.test.js` e `test/pagina-scheda.test.js`). Punto 27: `mmsiKind` (ITU-R M.585: nave, stazione
  costiera `00`, gruppo `0`, SAR `111`, AtoN `99`, ausiliaria `98`, portatile `8`, SART/MOB/EPIRB `970`/`972`/`974`, MID
  fuori da 201-775 = non valido), `MID_NAMES` (tabella spostata dalla pagina), `flagOf` (paese solo per navi e ausiliarie)
  e `mmsiWords`; in scheda riga «Bandiera» per le navi, «Tipo di MMSI» per le altre (anche nel sottotitolo); i registri
  italiani e la bandiera dei risultati usano `flagOf`. Il server non scarta gli MMSI non validi: la scheda li marca.
  Punto 44: `NAV_STATUS_LABEL` (spostato dalla pagina), `effectiveStatus(navStat, sog)` (`mismatch` 'moving' se dichiara
  all'ancora, ormeggiata o incagliata ma per `isStill` non è ferma, cioè va da 3 kn; 'still' se dichiara in navigazione
  con velocità nota fino a 0,5 kn) e `statusWords` per la riga «Stato» («Dichiara: ormeggiata · in realtà in moto a
  8,0 kn»). Conservazione (punto 8) e filtro `moving` usano già `isStill`, cioè lo stato reale; il filtro «Stato di
  navigazione» (`status`) resta sullo stato dichiarato.
- `vesselfinder.html`: mappa alternativa con il widget VesselFinder.
- `config.js` (solo su Pages, scritto da `tools/config-pages.js` in `pages.yml` con le variabili
  `API_HOST`/`VM_HOST` e `RENDER_HOST`): elenco dei server in `window.BOATRADAR_APIS`
  (`{url, name, sleeps}`, prima la VM poi Render) e il primo in `window.BOATRADAR_API`. Servito vuoto da
  `server.js` in locale. Test in `test/backend.test.js`. La pagina (punto 86) parte dal primo e passa al
  successivo solo quando sbaglia la richiesta della vista, dalla VM due volte di fila e mai per la rete
  dell'utente assente (`apiList`, `createRecheck`, `createFailover` e `networkDown` di `public/ais-logic.js`, test in
  `test/backend-pagina.test.js` e `test/pagina-backend.test.js`, che usa `test/pagina-helpers.js`); su un server di
  riserva prova la VM con la stessa vista ogni 5 min (`PRIMARY_RECHECK_MS`, di più se la VM oscilla; a scheda
  nascosta solo questa prova, niente richieste a Render), subito ricaricando e quando la scheda torna visibile (se
  l'ultima prova è di almeno 60 s prima), e ci torna se risponde; ricorda il server per la
  sessione della scheda (`sessionStorage`): per la quota di Render vedi `deploy/README.md`, «Passaggio automatico
  nella pagina».
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
| **Verifica standard** | `npm test` (circa 50 s, soprattutto i test di rete e della pagina; gira anche in CI) |
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
  chiusura con un clic vero sulla × (almeno 44×44 px, non coperta dall'header) e con Esc, la scelta fra le due navi
  sovrapposte GEMELLA della fixture a Genova (popup «2 navi qui» con righe da almeno 44 px, Esc, clic sulla seconda riga
  → scheda di 247555002; con la scheda aperta 30 navi finte nello stesso punto: 15 righe e «e altre 15», tutte
  raggiungibili; punto 10), un clic vero su «Cargo» nella legenda che toglie LAGUNA PRIMA (247123450) e salva il filtro, che
  resta ricaricando, e un secondo clic che la riporta (riga ≥ 44 px a 390; punto 9), la ricerca «GEMELLA» scritta con tasti veri (2 righe con «2 navi con questo nome», freccia
  giù + Invio apre la scheda, Esc la chiude; punto 12), a zoom 14 che LAGUNA PRIMA avanzi senza mai tornare indietro e,
  spento `#smooth` con un clic vero sulla sua riga (≥ 44 px a 390), resti sull'ultimo fix (punti 13, 63, 42), il pannello con l'elenco (punto 71: a 390 chiuso con il numero e
  l'attribuzione visibile, trascinamenti veri chiuso → metà → aperto → chiuso senza long task, lanci veloci veri, tocco, clic
  su una riga → scheda a metà con la nave fra header e scheda, Esc; a 1280 «Elenco» non coperto dall'header, riga di una nave
  sotto l'elenco → scheda e nave spostata a sinistra della scheda, Esc) e assenza
  di errori JavaScript; poi, con l'orologio della pagina e `serverTime` 40 min avanti, che le navi in moto spariscano e
  quella ormeggiata resti tratteggiata con il pallino rosso in scheda (punto 8); infine, con `window.BOATRADAR_APIS`
  di prova (primo server morto su 127.0.0.1:9, secondo il server di prova; `SMOKE_APIS` per cambiarli), che la pagina
  passi al secondo dopo due tentativi al primo, con «server di riserva (Render)» nella riga di stato, e che con il
  primo buono non chieda nulla al secondo; e che dal secondo, con il primo tornato e l'orologio 5 min avanti, la
  pagina provi il primo con la stessa vista e ci torni (punto 86). Esce con 1 al primo problema; screenshot in `diagnosi/smoke/`.
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
