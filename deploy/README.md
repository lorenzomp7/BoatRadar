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
| Variable | `VM_HOST` | IP pubblico della VM, es. `130.61.10.20` (con un nome al posto dell'IP serve anche `API_HOST`: sslip.io funziona solo con un IP) |
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

`vessels` di `/api/status` conta le posizioni in memoria, non le navi in mappa: comprende anche le posizioni già
scadute che la pulizia non ha ancora tolto (al massimo `POSITIONS_CLEANUP_MS`, 60 s) e, con il punto 8, le navi ferme
fino a 6 h invece di 30 min. Dopo il deploy del punto 8 il numero cresce quindi anche senza navi nuove: annota
`vessels` sulla VM prima del deploy e confrontalo dopo qualche ora (memoria della VM e peso della vista mondo,
`docs/prestazioni.md`), per esempio con `curl -s https://<API_HOST>/api/status | jq '{vessels, limits}'`.

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

Per ora la pagina usa solo il primo indirizzo (`window.BOATRADAR_API`). Il passaggio automatico al
secondo, quando il primo non risponde, non c'è ancora. Senza nessuna variabile `config.js` resta un
commento e la pagina mostra solo il Baltico. Se `API_HOST` (o il nome sslip.io di `VM_HOST`) e
`RENDER_HOST` sono lo stesso indirizzo, in `config.js` resta una sola voce, quella della VM. Un valore
che non è un nome di host (per esempio con spazi o virgolette, una porta fuori da 1-65535, o
`https://` in `VM_HOST`, che *Deploy backend* usa per ssh così com'è) fa fallire il workflow
*GitHub Pages* con un messaggio che riporta il valore inserito, invece di finire nella pagina.

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
funzionante. La pagina resta su quel server e mostra solo il Baltico, senza passare all'altro.
In quel caso sistema la chiave di quel server, oppure toglilo come sopra.

## Comandi utili sulla VM

```bash
ssh -i chiave.key ubuntu@IP
sudo docker ps                                  # container attivi
sudo docker logs -f <app>                       # log di un'app
sudo docker compose -p <app> -f /opt/apps/<app>/deploy/compose.yml restart
```
