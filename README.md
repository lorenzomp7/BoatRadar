# BoatRadar

Mappa live delle imbarcazioni in stile Flightradar24.

- **Tutto il mondo**: dati AIS di [aisstream.io](https://aisstream.io), richiede una chiave API gratuita.
  Il server riceve tutte le navi del pianeta e la pagina carica solo quelle nell'area visibile
  (con lo zoom lontano ne mostra un campione, avvicinandosi le mostra tutte).
- **Mar Baltico**: dati AIS aperti di Fintraffic / Digitraffic, funzionano anche senza chiave.

La ricerca per nome, MMSI o IMO copre tutte le navi ricevute, anche fuori dalla mappa visibile.
Le navi in movimento sono frecce orientate sulla rotta, quelle ferme sono pallini.

La copertura dipende dalle stazioni AIS a terra della rete aisstream.io: ottima lungo coste,
porti e stretti, scarsa in mare aperto (lì servirebbe l'AIS satellitare, che è a pagamento).

Tocca un’imbarcazione per vedere la scheda AIS. Quando trasmessi, mostra anche destinazione, pescaggio e dimensioni. Su telefono la scheda è adattata allo spazio disponibile.

## Online (gratuito)

- **Pagina**: GitHub Pages, <https://lorenzomp7.github.io/BoatRadar/>. Si aggiorna da sola a ogni push su `main`
  (workflow `.github/workflows/pages.yml`).
- **Server** (`server.js`, raccoglie l'AIS di tutto il mondo): VM Oracle Cloud *Always Free*, 0 €/mese,
  sempre accesa, quindi le navi non spariscono più dopo 15 minuti senza visite. Si aggiorna da solo a ogni
  push su `main` (workflow `.github/workflows/deploy-backend.yml`).

Configurazione, una volta sola: segui [deploy/README.md](deploy/README.md) per la VM, poi in
**Settings → Secrets and variables → Actions** aggiungi la variabile `VM_HOST`, i secret `VM_SSH_KEY` e
`AISSTREAM_KEY` (la chiave di aisstream.io), e in **Settings → Pages** scegli *GitHub Actions* come sorgente.
Il server risponde su `https://boatradar.<IP con i trattini>.sslip.io` e la pagina lo usa in automatico.

Finché il server non è configurato la pagina su Pages mostra solo il Baltico (dati aperti di Digitraffic).

## Avvio in locale

Richiede Node.js 22 o superiore.

```bash
npm install
node server.js
```

Poi apri http://localhost:8765.

Per vedere tutto il mondo crea `aisstream-key.txt` con la tua chiave aisstream.io
(oppure imposta la variabile d'ambiente `AISSTREAM_KEY`). Il file è escluso da git.

## Proprietario della nave

La scheda di ogni nave guida in tre passi:

1. **Trova il proprietario**: copia l'IMO (o l'MMSI) e apre Equasis (o ITU MARS).
2. Incolli il nome del proprietario nel campo della scheda: resta salvato su quella nave
   (nel browser) e compare in cima ai dati.
3. Un clic cerca quel nome su OpenCorporates, Companies House, registro di Malta, altre navi
   in Equasis, web e notizie.

Sotto, a seconda della nave: siti sugli yacht (ricerca già fatta sul nome), visura e Guardia
Costiera per le barche italiane, società di classificazione (Lloyd's Register, DNV, ABS,
ClassNK, Bureau Veritas, RINA), VesselFinder e MarineTraffic, servizi a pagamento.
Il pulsante **📚 Registri** in alto elenca tutte le fonti anche senza scegliere una nave.

## Mappa VesselFinder

Il pulsante **🌍 VesselFinder** in alto passa alla mappa gratuita di VesselFinder
(widget ufficiale, uso non commerciale), centrata sulla stessa zona. Dalla scheda di una nave,
**Mostra sulla mappa VesselFinder** la segue con la sua rotta.
