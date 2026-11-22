---
name: ais-api-change
description: Procedura per aggiungere o modificare dati AIS, endpoint /api/* o la loro visualizzazione in BoatRadar, con test sul finto aisstream locale. Usala per ogni modifica a server.js o alla parte dati di boatradar.html.
---

# Modificare dati AIS e API

## 1. Capire il flusso
`aisstream.io` (WebSocket) → `server.js` (stato in memoria, una voce per MMSI)
→ `/api/locations`, `/api/vessel`, `/api/search`, `/api/status` → `boatradar.html`.
Leggi `server.js` e `test/server.test.js` prima di cambiare qualcosa.

## 2. Nuovo campo o nuovo tipo di messaggio AIS
- Se serve un tipo nuovo, aggiungilo a `FilterMessageTypes` nella sottoscrizione e
  aggiorna il test che la controlla.
- Ripulisci i testi AIS (`@` di riempimento, spazi finali) come per nome e destinazione.
- Valori "non disponibili" dello standard AIS (es. ora 24, minuto 60, mese 0, velocità
  102.3, rotta 360) vanno trasformati in `null` o esclusi, non mostrati come dati veri.
- Coordinate GeoJSON sempre `[lon, lat]`.
- Tieni piccolo il payload di `/api/locations` (gira spesso su mappa intera): i dettagli
  vanno in `/api/vessel`.

## 3. Endpoint
- `bbox` = `minLon,minLat,maxLon,maxLat`; se minLon > maxLon l'area attraversa
  l'antimeridiano. Parametri non validi = nessun filtro, mai un errore 500.
- `limit` riduce le navi restituite ma `total` resta il conteggio reale.
- Le risposte JSON passano per la compressione gzip esistente.
- Nessun nuovo endpoint deve esporre file del server o la chiave.

## 4. Test (test/server.test.js)
Il test avvia il vero `server.js` contro un finto aisstream (`AISSTREAM_URL`):
- invia il messaggio con `send({ MetaData: {...}, Message: { <Tipo>: {...} } })`;
- controlla la risposta dell'endpoint con `getJson(...)`;
- aggiungi almeno un caso con valore "non disponibile" e uno al confine (antimeridiano, poli).
Comando: `npm test` (parte anche dall'hook a fine turno).

## 5. Interfaccia (boatradar.html)
- Mostra "n.d." per i valori mancanti, mai `null` o `undefined`.
- Controlla anche la larghezza da telefono. Se non puoi aprire un browser, dichiaralo.

## 6. Limiti di aisstream.io
Una sola connessione per chiave; dopo un 429 si aspetta almeno un minuto; nessuna
riconnessione in ciclo stretto. Non salvare mai la chiave nei file.
