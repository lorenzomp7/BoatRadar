# Backend sulla VM Oracle Cloud (Always Free)

La parte statica del progetto è su **GitHub Pages**; il server gira su una VM Oracle Cloud
*Always Free*, condivisa con gli altri progetti (BoatRadar, DressIt, QuantTradingSystem). Costo: **0 €/mese** entro i limiti Always Free (Ampere A1: 2 OCPU e
12 GB di RAM in totale, 200 GB di disco, 10 TB/mese di traffico in uscita).

## Una volta sola: crea la VM

1. Registrati su <https://www.oracle.com/cloud/free/> (serve una carta per la verifica;
   finché resti nei limiti Always Free non viene addebitato nulla). Scegli una *home region*
   vicina, per esempio Frankfurt o Milan: non si può cambiare dopo.
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04** · Shape: **VM.Standard.A1.Flex**, 2 OCPU e 12 GB.
   - Rete: lascia la VCN proposta con IP pubblico.
   - SSH keys: *Generate a key pair* e scarica la **chiave privata**.
   Se compare *Out of capacity*, riprova più tardi o scegli un altro *availability domain*.
3. **Networking → Virtual cloud networks → (la tua VCN) → Security → Security List di default →
   Add Ingress Rules**: sorgente `0.0.0.0/0`, TCP, porte di destinazione `80,443`.
   (Il firewall interno della VM lo apre da solo `deploy/bootstrap.sh`.)
4. Annota l'**IP pubblico** della VM.

Docker, firewall e Caddy (HTTPS automatico con Let's Encrypt) li installa il primo deploy.

## Per ogni repository

In **Settings → Secrets and variables → Actions**:

| Tipo | Nome | Valore |
|---|---|---|
| Variable | `VM_HOST` | IP pubblico della VM, es. `130.61.10.20` (con un nome al posto dell'IP serve anche `API_HOST`: sslip.io funziona solo con un IP). Impostala solo quando la VM esiste e risponde (vedi «Due backend») |
| Variable | `VM_USER` | facoltativa, di base `ubuntu` |
| Secret | `VM_SSH_KEY` | contenuto della chiave privata scaricata al punto 2 |
| Variable | `API_HOST` | facoltativa: tuo dominio per il server, es. `api.miosito.it` |

Gli altri secret dipendono dal progetto (vedi il README principale).

Poi in **Settings → Pages → Build and deployment → Source** scegli **GitHub Actions**
(se il progetto ha una parte su Pages) e lancia una volta da **Actions** i workflow
*Deploy backend* e *GitHub Pages* (*Run workflow*). Il primissimo deploy installa Docker sulla VM:
fallo per un progetto alla volta, poi gli altri. Dai push successivi su `main` si
aggiornano da soli.

## Variabili del server (facoltative)

Oltre a `AISSTREAM_KEY` e `CORS_ORIGIN` (già in `deploy/compose.yml`), `server.js` legge queste
variabili per la conservazione delle posizioni e per la cache di `/api/locations`. I default vanno bene per la VM; per cambiarne una
aggiungila sotto `environment:` in `deploy/compose.yml`. Un valore non valido (non numerico o
negativo) vale come il default. Lo stato della cache è in `locationsCache` di `/api/status`
(`hits`, `misses`, `compressions`, `size`, `filtered` = voci con filtro del punto 9, `bytes`).

| Variabile | Default | Significato |
|---|---|---|
| `STALE_MOVING_MS` | `1800000` (30 min) | per quanto si tiene la posizione di una nave in moto (anche i candidati di `position-check.js`) |
| `STALE_STILL_MS` | `21600000` (6 h) | per quanto si tiene la posizione di una nave ferma, all'ancora o ormeggiata (mai meno di `STALE_MOVING_MS`); i due limiti in uso (quelli effettivi, già con questo minimo) sono `limits` di `/api/status` e la pagina li usa per le navi del server. `0` vale come il default |
| `POSITIONS_CLEANUP_MS` | `60000` | ogni quanti ms si tolgono dalla memoria le posizioni scadute (le risposte le escludono già prima) |
| `LOCATIONS_CACHE_MS` | `3000` | ms per cui una risposta si riusa anche se nel frattempo i dati sono cambiati |
| `LOCATIONS_CACHE_STABLE_MS` | `60000` | ms per cui una risposta si riusa se i dati non sono cambiati |
| `LOCATIONS_CACHE_SIZE` | `50` | viste tenute al massimo; `0` = cache spenta |
| `LOCATIONS_CACHE_BYTES` | `33554432` (32 MB) | byte al massimo (JSON più gzip); oltre esce la voce più vecchia |
| `LOCATIONS_CACHE_FILTERED` | `20` | quante delle `LOCATIONS_CACHE_SIZE` voci possono avere un filtro (`types`, `status`, `minSog`, `maxSog`, `seen`, `moving`; mai più di `LOCATIONS_CACHE_SIZE`, decimali arrotondati per difetto); `0` = le richieste filtrate non entrano in cache. Una voce filtrata oltre questa quota, o oltre i tetti di voci e byte, espelle la filtrata più vecchia: il traffico filtrato non espelle mai le viste senza filtro. Una voce senza filtro oltre i tetti espelle invece la più vecchia in assoluto |
| `LOCATIONS_CACHE_CLEANUP_MS` | `60000` | ogni quanti ms si tolgono le voci che non si possono più riusare |
| `SNAPSHOT_FILE` | nessuno (in `compose.yml`: `/data/vessels.json.gz`) | file dei dati statici delle navi conservati fra un riavvio e l'altro (punto 22, sezione «Dati statici dopo un riavvio»); senza, il server parte vuoto |
| `SNAPSHOT_INTERVAL_MS` | `600000` (10 min) | ogni quanti ms si salvano i dati statici (solo con `SNAPSHOT_FILE`) |
| `SNAPSHOT_EXIT_MS` | `8000` | a SIGTERM/SIGINT, tempo massimo dell'ultimo salvataggio prima di uscire comunque (sotto il `stop_grace_period` di 20 s di `compose.yml`) |
| `SNAPSHOT_RESTORE_MS` | `5000` | tempo massimo del ripristino all'avvio prima di collegarsi comunque ad aisstream (il ripristino continua; i salvataggi aspettano la sua fine) |

`vessels` di `/api/status` conta le posizioni in memoria, non le navi in mappa: comprende anche le posizioni già
scadute che la pulizia non ha ancora tolto (al massimo `POSITIONS_CLEANUP_MS`, 60 s) e, con il punto 8, le navi ferme
fino a 6 h invece di 30 min. Dopo il deploy del punto 8 il numero cresce quindi anche senza navi nuove: annota
`vessels` sulla VM prima del deploy e confrontalo dopo qualche ora (memoria della VM e peso della vista mondo,
`docs/prestazioni.md`), per esempio con `curl -s https://<API_HOST>/api/status | jq '{vessels, limits}'`.

## Dati statici dopo un riavvio

Nome, IMO, nominativo, tipo, destinazione, pescaggio, dimensioni ed ETA arrivano da aisstream solo ogni 6 minuti
circa per nave (`ShipStaticData`), mentre le posizioni arrivano di continuo: dopo un riavvio o un deploy le schede
restavano a lungo senza nome né destinazione. Con `SNAPSHOT_FILE` (`snapshot.js`, punto 22) `server.js`:

- all'avvio rilegge il file prima di collegarsi ad aisstream (al massimo 5 s, poi si collega comunque) e ripristina
  solo i dati statici di meno di 48 h, validati campo per campo con le stesse regole dei messaggi in arrivo (testi
  ripuliti, IMO con la cifra di controllo, pescaggio maggiore di 0); nessuna posizione (le navi tornano in mappa con la
  prima posizione nuova). Se nel frattempo è arrivato qualcosa di una nave (es. il nome in `MetaData`), vale quello e
  dal file si prendono solo i campi che mancano;
- un file non valido (rovinato, di un altro formato o versione, o oltre i tetti: 16 MB su disco, controllati prima di
  leggerlo; 64 MB decompresso, dove 50.000 navi sono circa 12 MB; righe di al massimo 1000 navi e non più di quelle di
  250.000 navi; JSON non a righe fino a 4 MB) non blocca l'avvio: diventa `vessels.json.gz.bad` (sostituisce un `.bad`
  di prima, da guardare o cancellare a mano) e il server parte vuoto. Un file costruito per esaurire la memoria (es.
  pochi KB di gzip con milioni di a capo) si ferma al tetto del decompresso, così il container non riparte all'infinito;
- se invece la lettura fallisce per I/O (`EIO`, `EACCES`, non un file…) il file resta com'è e **fino al riavvio non si
  salva più** (né a intervalli né a SIGTERM): il file può essere buono e il disco in difficoltà, e un salvataggio lo
  sostituirebbe con le sole navi arrivate dopo l'avvio. Sistemato il disco, un riavvio lo rilegge;
- li salva ogni `SNAPSHOT_INTERVAL_MS` (10 min) e a `docker stop` (SIGTERM), in gzip (circa 0,5 MB per 50.000 navi
  sintetiche di `tools/carico.js`; con nomi e destinazioni veri di più), su un file `.tmp` scritto e sincronizzato su
  disco (`fsync`) e poi rinominato: un'interruzione o un calo di corrente a metà lasciano intero il file di prima. Mai
  prima della fine del ripristino; un segnale durante il ripristino esce senza salvare, un secondo segnale esce subito;
- riporta in `snapshot` di `/api/status` `store` (`file` o `null`), `restored` (navi ripristinate all'avvio),
  `restoreError` (problema del ripristino, resta fino al riavvio), `savedAt`, `bytes`, `vessels` e `ms` dell'ultimo
  salvataggio ed `error` (dell'ultimo salvataggio; solo il codice o il motivo, mai percorsi).

Sulla VM `deploy/compose.yml` imposta `SNAPSHOT_FILE: /data/vessels.json.gz` nel volume Docker `boatradar-data`
(`/data`, creato nell'immagine per l'utente `node`), con `stop_grace_period: 20s` per l'ultimo salvataggio. Il volume
resta fra un deploy e l'altro (`remote-deploy.sh` usa `up -d --build`); **`docker compose down -v` lo cancella** con i
dati salvati. Controllo: `curl -s https://<API_HOST>/api/status | jq .snapshot`. In locale:
`SNAPSHOT_FILE=diagnosi/vessels.json.gz node server.js` (`diagnosi/` è ignorata da git).

Render Free non ha un disco persistente e a ogni risveglio o deploy riparte da un'immagine pulita: lì `SNAPSHOT_FILE`
non è impostato e il server parte vuoto, come prima (decisione del 27/11/2026: 0 €, Render è solo la riserva).
Alternative, se un giorno servisse anche lì (prezzi verificati il 27/11/2026):

| Alternativa | Costo | Note |
|---|---|---|
| Nessuna persistenza su Render (scelta) | 0 € | il server di riserva parte senza dati statici |
| Cloudflare R2 come destinazione | 0 € entro 10 GB-mese di dati e 1 milione di scritture (classe A) al mese; oltre 0,015 $/GB-mese e 4,50 $ per milione di scritture | un salvataggio ogni 10 min sono circa 4.400 scritture al mese; servirebbe un `store` R2 in `snapshot.js` con chiavi d'accesso come secret di Render ([prezzi R2](https://developers.cloudflare.com/r2/pricing/)) |
| Disco persistente di Render | istanza a pagamento da 7 $/mese più 0,25 $/GB-mese | il piano Free non ha dischi; basterebbe `SNAPSHOT_FILE` sul disco ([prezzi Render](https://render.com/pricing)) |

## Indirizzi

Senza un dominio, ogni server riceve un nome gratuito di [sslip.io](https://sslip.io) che punta
all'IP della VM, con certificato HTTPS valido: `<app>.<IP con i trattini>.sslip.io`,
per esempio `boatradar.130-61-10-20.sslip.io`. Con un dominio tuo crea un record DNS `A`
verso l'IP e mettilo in `API_HOST`.

## Due backend: VM Oracle e Render

BoatRadar può avere due server con lo stesso `Dockerfile`. `tools/config-pages.js` li scrive in
`config.js` di Pages:

| Ruolo | Dove | Variabile del repo | Costo |
|---|---|---|---|
| Principale, sempre acceso, con disco | VM Oracle Always Free (questa guida) | `VM_HOST` o `API_HOST` | 0 €/mese |
| Di riserva, si addormenta | Render Free (`render.yaml`) | `RENDER_HOST` | 0 €/mese |

Render Free: 512 MB di RAM e 0,1 CPU. Si spegne dopo 15 minuti senza traffico in entrata (la
connessione verso aisstream non conta) e alla visita successiva riparte in circa un minuto **con la
memoria vuota**: le navi ricompaiono man mano che arrivano i messaggi. Anche il disco è effimero.
La seconda chiave aisstream è gratuita come la prima.

`config.js` contiene l'elenco nell'ordine VM, poi Render:

```js
window.BOATRADAR_APIS = [{"url":"https://boatradar.130-61-10-20.sslip.io/api","name":"VM Oracle","sleeps":false},{"url":"https://boatradar-xxxx.onrender.com/api","name":"Render","sleeps":true}];
window.BOATRADAR_API = window.BOATRADAR_APIS[0].url;
```

La pagina usa il primo indirizzo e passa da sola al successivo quando il primo non risponde (vedi
«Passaggio automatico nella pagina» qui sotto).

**Non impostare `VM_HOST` (né `API_HOST`) finché la VM non esiste e non risponde.** Con la variabile
impostata `config.js` mette la VM al primo posto anche se non c'è: ogni scheda nuova la prova due volte
(fino a circa 20 s senza navi del mondo se l'indirizzo non risponde) prima di passare a Render, ogni scheda
su Render ci riprova ogni 5 min e *Deploy backend* fallisce a ogni esecuzione. Finché c'è solo Render imposta
solo `RENDER_HOST`: `config.js` avrà una sola voce e la pagina userà Render direttamente. Senza nessuna variabile `config.js` resta un
commento e la pagina mostra solo il Baltico. Se `API_HOST` (o il nome sslip.io di `VM_HOST`) e
`RENDER_HOST` sono lo stesso indirizzo, in `config.js` resta una sola voce, quella della VM. Un valore
che non è un nome di host (per esempio con spazi o virgolette, una porta fuori da 1-65535, o
`https://` in `VM_HOST`, che *Deploy backend* usa per ssh così com'è) fa fallire il workflow
*GitHub Pages* con un messaggio che riporta il valore inserito, invece di finire nella pagina.

### Passaggio automatico nella pagina

`boatradar.html` legge l'elenco con `apiList` e sceglie il server con `createFailover` (entrambe in
`public/ais-logic.js`, con `networkDown`; test in `test/backend-pagina.test.js` e `test/pagina-backend.test.js`):

- Decide **solo la richiesta della vista** (`/api/locations?bbox=…`): errore di rete, risposta non ok
  (per esempio 503) o nessuna risposta entro 8 s. `/api/status`, `include=`, `/api/vessel` e la ricerca
  vanno al server attivo, ma un loro errore non fa cambiare server.
- **Niente passaggio per un errore isolato della VM.** Dalla VM (`"sleeps":false`) la pagina passa a Render
  solo dopo **due errori di fila** della vista: dopo il primo riprova la VM dopo 3 s (riga di stato «Mondo:
  server non raggiungibile, riprovo tra 3 s (ora solo Baltico)»). Una risposta in mezzo azzera il conto.
- **Rete dell'utente assente.** Un errore della vista senza nessuna risposta (errore di rete o nessuna risposta
  entro 8 s) non conta quando il browser dice di essere offline (`navigator.onLine` falso) oppure quando nello
  stesso giro anche la richiesta al Baltico (Digitraffic, un altro sito) fallisce con un errore di rete. Il
  Baltico vale come prova solo se ha risposto negli ultimi 2 min: se Digitraffic è bloccato dalla rete
  dell'utente, o la rete manca da più di 2 min, gli errori contano di nuovo e la pagina può passare a Render.
  Una risposta di errore della VM (per esempio 503) conta sempre, anche con il browser offline: una risposta
  dice che la rete c'è. Gli errori che non contano non avvicinano al passaggio e fanno riprovare lo stesso
  server con un'attesa crescente a parte (3, 5, 10, 20, 40, poi ogni 60 s), azzerata da una risposta; quando
  la rete torna (evento `online` del browser) la pagina riprova subito. La richiesta al Baltico ha 15 s, poi
  si annulla e il giro va avanti senza.
- Dopo il secondo errore di fila la VM si riprova dopo 5 s, poi 10, 20, 40 e al massimo 60 s; con due
  server nel frattempo la pagina passa subito all'altro, con un server solo mostra il Baltico e «riprovo
  tra N s».
- **Render che si sveglia**: l'avvio parte al primo errore di Render se la pagina non lo sente (né errori né
  risposte) da 15 min, o non l'ha mai sentito: dopo 15 min senza visite si addormenta davvero. Finché non
  risponde, per 90 s da quel primo errore la pagina resta su di lui (riga di stato «Mondo: server di riserva
  in avvio, circa un minuto…»), e in quel periodo la richiesta della vista a Render ha **45 s** invece di 8
  (Render tiene le richieste finché il servizio non è pronto); intanto gli altri giri non ne aprono altre.
  Dopo, se non ha ancora risposto, torna a provare la VM. Se Render ha sbagliato o risposto da poco è sveglio
  e un suo errore fa passare subito: con **entrambi i server giù** la riga di stato dice quindi «Mondo:
  server non raggiungibile, riprovo tra N s (ora solo Baltico)» e non più «in avvio». La stessa regola vale
  con **un solo server che dorme** (solo `RENDER_HOST`): «in avvio» al primo errore dopo 15 min senza
  contatti, poi «riprovo tra N s».
- Quando il server attivo non è il primo dell'elenco, la riga di stato finisce con «server di riserva
  (Render)».
- **Ritorno alla VM.** Mentre è su Render (o su un altro server che non è il primo), ogni 5 min
  (`PRIMARY_RECHECK_MS` in `boatradar.html`) la pagina prova la VM con una sola richiesta della **stessa
  vista** del giro (`/api/locations?bbox=…`, uguale per tutti e servita dalla cache della VM; timeout 8 s), a
  parte dal giro: la mappa continua con Render. Se la VM risponde con l'elenco delle navi, dal giro successivo
  la pagina torna alla VM e lo ricorda in `sessionStorage`. Un elenco **vuoto** vale solo se anche
  `/api/status` della VM dice `hasKey` e `connected` (una VM appena ripartita o senza chiave risponde con zero
  navi): una richiesta in più solo in quel caso. Se non risponde o risponde con un errore, la pagina resta su
  Render senza segnalare errori e riprova dopo un altro intervallo. Mai più di una prova in corso.
- **Scheda nascosta** (in secondo piano o con lo schermo spento, finché il browser la tiene attiva) su Render:
  i giri non chiedono nulla a Render (né la vista né `/api/status`), la mappa resta com'era e continua solo la
  prova della VM. Quando la scheda torna visibile su Render riparte subito un giro normale; se l'ultima prova è
  finita da almeno 60 s e l'intervallo non è raddoppiato (VM che oscilla, sotto), la pagina prova prima la VM
  e aspetta la risposta (al massimo 8 s) prima di chiedere la vista: se la VM risponde, la vista del giro è
  la risposta della prova (nessun secondo download). Il Baltico non aspetta la prova.
- **VM che oscilla.** Se la VM ricade entro 10 min da un ritorno con la prova, l'intervallo delle prove
  raddoppia: 5, 10, 20 e al massimo 40 min. Dopo 30 min di VM senza ricadute torna a 5 min.
- Il server attivo resta per la **sessione della scheda** (`sessionStorage`, chiave `boatradar:api`):
  ricaricando la scheda su Render la pagina prova **subito** la VM (sempre, anche entro 60 s) e aspetta la
  risposta (al massimo 8 s) prima della prima vista: se la VM risponde si riparte dalla VM, con la sua
  risposta come prima vista, altrimenti da Render. Una scheda nuova riparte dalla VM.

**Quota di Render.** Una VM che risponde non fa mai passare la pagina a Render: si cambia solo dopo due
errori di fila della vista, e non per un buco di rete dell'utente. Una scheda passata a Render ci resta al
massimo circa 5 min dopo che la VM è tornata in linea, **anche se è nascosta** (con lo schermo spento
alcuni browser rallentano i giri fino a uno al minuto: qualche decina di secondi in più); una scheda
nascosta su Render non gli chiede nulla, e se il browser la ferma del tutto alla riapertura la prima
richiesta è la prova della VM (se l'ultima è di almeno 60 s prima). Il traffico di Render dopo un guasto
della VM è quindi quello dei minuti del guasto passati con la scheda in primo piano, al massimo circa 5 min
per scheda aperta dopo il ritorno della VM (vista mondo: circa 5 MB, sotto). Se la VM oscilla, ogni
ricaduta lascia la scheda su Render fino a 10, 20 o 40 min (vista mondo: fino a circa 37 MB per scheda a
ricaduta) invece di farla rimbalzare ogni 5 min. La prova pesa sulla VM, non su Render: una vista ogni
5 min per ogni scheda che sta su Render (vista mondo: 227,5 KB gzip, circa 2,7 MB all'ora, dai 10 TB della VM). Con la
quota di 5 GB al mese (sotto) non serve chiudere e riaprire le schede dopo un guasto; per tornare subito
alla VM basta ricaricare la scheda (prova immediata).

### Costi e quote di Render

Fonti: <https://render.com/docs/free> e <https://render.com/docs/outbound-bandwidth>, verificate il 26/11/2026.

| Voce | Workspace Hobby (0 $/mese) |
|---|---|
| Ore dei servizi Free | 750 al mese |
| Minuti di build | 500 al mese |
| Traffico in uscita | 5 GB al mese, **condivisi da tutti i servizi del workspace** |
| Oltre i 5 GB, con un metodo di pagamento | 0,15 $/GB |
| Oltre i 5 GB, senza metodo di pagamento | Render sospende **tutti** i servizi Free del workspace fino a fine mese |

Quanto consuma una scheda aperta (misura con `node --expose-gc tools/carico.js --navi 30000`, 26/11/2026,
stesse navi di `docs/prestazioni.md`): la vista mondo restituisce 5979 navi (il massimo è 6000,
`MAX_FEATURES` di `server.js`), **227,5 KB gzip** per risposta. La pagina la richiede ogni 15 s
(`REFRESH_MS` di `boatradar.html`), cioè 240 volte all'ora:

- vista mondo: 227,5 KB × 240 ≈ **56 MB all'ora** per scheda, circa 1,3 GB al giorno;
- vista porto (Rotterdam, 1427 navi, 53,2 KB gzip): circa 13 MB all'ora.

**Con Render come unico server, circa 90 ore di una scheda aperta sulla vista mondo esauriscono la
quota di 5 GB del mese** (meno di 4 giorni di una sola scheda lasciata aperta, o una sera con una
ventina di schede). Il conto non include intestazioni HTTP, `/api/status` e le richieste in più
quando si sposta la mappa, quindi il consumo reale è un po' più alto; la quota è anche condivisa con
gli altri servizi del workspace. La VM Oracle include invece 10 TB al mese. Per questo **la VM resta
il server principale e Render la riserva**: Render va usato per brevi periodi, quando la VM non
risponde, e senza metodo di pagamento il superamento lo spegne fino al mese successivo.

### Creare il servizio su Render (una volta sola)

1. Crea una **seconda chiave** su <https://aisstream.io>, diversa da quella della VM. aisstream accetta
   una sola connessione per chiave. Con la stessa chiave sui due server le connessioni si chiudono a
   vicenda e nessuno dei due riceve dati con continuità.
2. Su <https://dashboard.render.com>: **New → Blueprint**, collega la repo `lorenzomp7/BoatRadar` e
   come branch scegli **`main`**: `render.yaml` deve essere già su `main` (fai prima il merge), perché
   Render legge il Blueprint dal branch scelto e poi si aggiorna solo da quello (`branch: main`).
   Poi Render chiede il valore di `AISSTREAM_KEY` (lo chiede solo a questa prima
   creazione; per cambiarlo dopo: servizio → *Environment*). Incolla lì la seconda chiave: non va mai
   nel file né nella repo.
3. Alla fine del primo deploy Render mostra l'indirizzo del servizio, per esempio
   `https://boatradar-xxxx.onrender.com`. Controlla che `https://boatradar-xxxx.onrender.com/api/status`
   risponda con `"hasKey":true`.
4. Su GitHub, in **Settings → Secrets and variables → Actions → Variables**, aggiungi
   `RENDER_HOST` = `boatradar-xxxx.onrender.com` (anche con `https://` e `/` finale va bene). Poi lancia
   il workflow *GitHub Pages* da **Actions → Run workflow**: un cambio di variabile non lo fa
   partire da solo.

Dopo, Render si aggiorna da solo a ogni push su `main` che tocca un file dell'immagine
(`buildFilter` di `render.yaml`). Non serve nessun secret su GitHub per Render.

### Cambiare l'ordine o spegnere un backend

- **Ordine**: è in `backends()` di `tools/config-pages.js` (prima la VM). Per mettere Render per primo
  inverti i due `list.push` e aggiorna il test `test/backend.test.js`. Per usare solo Render basta
  spegnere la VM come sotto.
- **Spegnere la VM**: togli le variabili `VM_HOST` e `API_HOST`. Così si ferma anche *Deploy backend*.
  Poi rilancia *GitHub Pages*. Il container sulla VM resta acceso finché non lo fermi
  (`sudo docker compose -p boatradar -f /opt/apps/boatradar/deploy/compose.yml down`), e intanto
  usa la sua chiave aisstream.
- **Spegnere Render**: togli la variabile `RENDER_HOST` e rilancia *GitHub Pages*. Poi su Render:
  servizio → *Settings* → **Suspend Service**, per non consumare ore e non tenere aperta la sua
  connessione aisstream.

Un server che risponde ma non ha la chiave (`"hasKey":false` in `/api/status`) conta come
funzionante: la richiesta della vista riesce (senza navi). La pagina resta su quel server e mostra solo
il Baltico, senza passare all'altro.
In quel caso sistema la chiave di quel server, oppure toglilo come sopra.

## Comandi utili sulla VM

```bash
ssh -i chiave.key ubuntu@IP
sudo docker ps                                  # container attivi
sudo docker logs -f <app>                       # log di un'app
sudo docker compose -p <app> -f /opt/apps/<app>/deploy/compose.yml restart
```
