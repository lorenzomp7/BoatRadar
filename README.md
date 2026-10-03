# BoatRadar

Mappa live delle imbarcazioni in stile Flightradar24.

- **Mar Baltico**: dati AIS aperti di Fintraffic / Digitraffic, nessuna chiave richiesta.
- **Mediterraneo**: dati AIS di [aisstream.io](https://aisstream.io), richiede una chiave API gratuita.

## Avvio

Richiede Node.js 22 o superiore, nessuna dipendenza.

```bash
node server.js
```

Poi apri http://localhost:8765.

Per il Mediterraneo crea `aisstream-key.txt` con la tua chiave aisstream.io
(oppure imposta la variabile d'ambiente `AISSTREAM_KEY`). Il file è escluso da git.

## Proprietario della nave

Cliccando su una nave si apre una scheda con MMSI, IMO, nominativo e bandiera, e i link
ai registri pubblici (Equasis, ITU MARS, MarineTraffic, VesselFinder) dove cercare
armatore e gestore.
