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

## Avvio

Richiede Node.js 22 o superiore, nessuna dipendenza.

```bash
node server.js
```

Poi apri http://localhost:8765.

Per vedere tutto il mondo crea `aisstream-key.txt` con la tua chiave aisstream.io
(oppure imposta la variabile d'ambiente `AISSTREAM_KEY`). Il file è escluso da git.

## Proprietario della nave

Cliccando su una nave si apre una scheda con MMSI, IMO, nominativo e bandiera, e i link
ai registri pubblici (Equasis, ITU MARS, MarineTraffic, VesselFinder) dove cercare
armatore e gestore.
