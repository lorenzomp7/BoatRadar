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

## Online (Render, gratuito)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lorenzomp7/BoatRadar)

1. Clicca il pulsante e accedi a Render con GitHub.
2. Quando chiede `AISSTREAM_KEY`, incolla la chiave di aisstream.io e conferma.
3. Dopo un paio di minuti l'app è su `https://boatradar-xxxx.onrender.com`; si aggiorna da sola a ogni push.

Nel piano gratuito Render spegne il servizio dopo 15 minuti senza visite: alla visita successiva
riparte in circa 30-60 secondi e le navi ricompaiono man mano che arrivano i segnali.

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

Cliccando su una nave si apre una scheda con MMSI, IMO, nominativo e bandiera. Il pulsante
**Trova il proprietario** copia l'IMO (o l'MMSI per le navi senza IMO) e apre Equasis
(o ITU MARS), con l'indicazione di dove incollarlo. I registri non accettano ricerche
automatiche, quindi l'ultimo passaggio, incolla e invio, resta manuale.

## Mappa VesselFinder

Il pulsante **🌍 VesselFinder** in alto passa alla mappa gratuita di VesselFinder
(widget ufficiale, uso non commerciale), centrata sulla stessa zona. Dalla scheda di una nave,
**Mostra sulla mappa VesselFinder** la segue con la sua rotta.
