# VesselFinder – scheda da fonti pubbliche

| Campo | Valore |
|---|---|
| Pacchetto | da verificare con `rea list-adb-packages` (Lite gratuita e Pro a pagamento) |
| Versione | Pro 5.7.7 (iOS) |
| Analizzata il | 2026-11-24 |
| Fonte | **fonti pubbliche, non l'APK** (schede degli store) |

## Cosa si è visto, per punto del Piano

| Punto | Trovato | Fonte |
|---|---|---|
| 7, 23 – dati statici | scheda con nome, bandiera, tipo, IMO, MMSI, destinazione, ETA, pescaggio, rotta, velocità, stazza, anno, dimensioni, foto | [App Store Lite](https://apps.apple.com/ph/app/id918080862) |
| 12 – ricerca | ricerca per nome, IMO o MMSI; porti per nome o LOCODE | idem |
| 37 – ETA | rotte previste ed ETA fino al prossimo porto | [App Store](https://apps.apple.com/app/id918080862) |
| 23 – posizione vecchia | se la nave è fuori copertura mostra l'ultima posizione nota e la aggiorna appena rientra | [App Store Pro](https://apps.apple.com/gb/app/id608985698?l=en-gb) |
| 9 – filtri | filtro delle navi in mappa per tipo | [App Store Pro](https://apps.apple.com/ca/app/id608985698?l=en-ca) |
| 28 – preferite | «My Fleet» sincronizzata con il sito; «My Views» salva viste della mappa | [App Store](https://apps.apple.com/us/app/vesselfinder/id918080862) |
| Mappe | stili Simple, Detailed, Dark, Satellite, Nautical | idem |
| 38 – porti | soste per nave (arrivo e permanenza nell'ultimo porto) e per porto | [App Store Lite](https://apps.apple.com/ph/app/id918080862) |
| Libreria mappa, cluster, notifiche | da APK | — |

## Cosa prendere per BoatRadar

- Punto 37: riconoscere i porti anche per UN/LOCODE, come la ricerca di VesselFinder.
- Punto 23: mostrare l'ultima posizione nota con la sua età invece di nascondere la nave.
- Punto 18: offrire uno stile scuro e uno nautico (OpenSeaMap) oltre a quello base.
- Viste salvate («My Views»): un elenco di bbox preferiti in localStorage, a costo zero.

## Limiti

Niente APK e pacchetto non confermato: librerie e servizi da verificare con REA.
