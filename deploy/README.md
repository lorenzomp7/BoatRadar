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
| Variable | `VM_HOST` | IP pubblico della VM, es. `130.61.10.20` |
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
variabili per la cache di `/api/locations`. I default vanno bene per la VM; per cambiarne una
aggiungila sotto `environment:` in `deploy/compose.yml`. Un valore non valido (non numerico o
negativo) vale come il default. Lo stato della cache è in `locationsCache` di `/api/status`
(`hits`, `misses`, `compressions`, `size`, `bytes`).

| Variabile | Default | Significato |
|---|---|---|
| `LOCATIONS_CACHE_MS` | `3000` | ms per cui una risposta si riusa anche se nel frattempo i dati sono cambiati |
| `LOCATIONS_CACHE_STABLE_MS` | `60000` | ms per cui una risposta si riusa se i dati non sono cambiati |
| `LOCATIONS_CACHE_SIZE` | `50` | viste tenute al massimo; `0` = cache spenta |
| `LOCATIONS_CACHE_BYTES` | `33554432` (32 MB) | byte al massimo (JSON più gzip); oltre esce la voce più vecchia |
| `LOCATIONS_CACHE_CLEANUP_MS` | `60000` | ogni quanti ms si tolgono le voci che non si possono più riusare |

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

Render Free: 750 ore gratuite al mese per workspace, 512 MB di RAM e 0,1 CPU. Si spegne dopo 15
minuti senza traffico in entrata (la connessione verso aisstream non conta) e alla visita successiva
riparte in circa un minuto **con la memoria vuota**: le navi ricompaiono man mano che arrivano i
messaggi. Anche il disco è effimero. Il traffico in uscita e i minuti di build contano nella quota
inclusa del workspace; se si supera, Render fa pagare oppure, senza carta registrata, sospende il servizio.
La seconda chiave aisstream è gratuita come la prima.

`config.js` contiene l'elenco nell'ordine VM, poi Render:

```js
window.BOATRADAR_APIS = [{"url":"https://boatradar.130-61-10-20.sslip.io/api","name":"VM Oracle","sleeps":false},{"url":"https://boatradar-xxxx.onrender.com/api","name":"Render","sleeps":true}];
window.BOATRADAR_API = window.BOATRADAR_APIS[0].url;
```

Per ora la pagina usa solo il primo indirizzo (`window.BOATRADAR_API`). Il passaggio automatico al
secondo, quando il primo non risponde, non c'è ancora. Senza nessuna variabile `config.js` resta un
commento e la pagina mostra solo il Baltico. Un valore che non è un nome di host (per esempio con
spazi o virgolette) fa fallire il workflow *GitHub Pages*, invece di finire nella pagina.

### Creare il servizio su Render (una volta sola)

1. Crea una **seconda chiave** su <https://aisstream.io>, diversa da quella della VM. aisstream accetta
   una sola connessione per chiave. Con la stessa chiave sui due server le connessioni si chiudono a
   vicenda e nessuno dei due riceve dati con continuità.
2. Su <https://dashboard.render.com>: **New → Blueprint** e collega la repo `lorenzomp7/BoatRadar`.
   Render legge `render.yaml` e chiede il valore di `AISSTREAM_KEY` (lo chiede solo a questa prima
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
