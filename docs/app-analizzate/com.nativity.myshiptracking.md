# MyShipTracking – scheda da fonti pubbliche

| Campo | Valore |
|---|---|
| Pacchetto | `com.nativity.myshiptracking` |
| Versione | 2.0.2 (iOS) |
| Analizzata il | 2026-11-24 |
| Fonte | **fonti pubbliche, non l'APK** (scheda App Store, editore Webday / nativity.gr) |

## Cosa si è visto, per punto del Piano

| Punto | Trovato | Fonte |
|---|---|---|
| 30 – etichette | la 2.0.2 aggiunge «Labels On Map» (nomi in mappa) | [App Store](https://apps.apple.com/nz/app/myshiptracking/id1403038386) |
| 28 – avvisi su aree | si disegna un'area sulla mappa e si ricevono avvisi sui movimenti delle navi dentro | [App Store](https://apps.apple.com/jo/app/myshiptracking/id1403038386) |
| 17 – fonti | dati dalla sola rete di stazioni AIS dell'editore; gli utenti notano meno navi di chi usa il satellite | [App Store](https://apps.apple.com/us/app/myshiptracking/id1403038386) |
| 10, 31 – posizione | gli utenti chiedono un pulsante per centrare la mappa sulla propria posizione | idem |
| 39, 41 – flotta, meteo | flotta personale; livelli di vento e temperatura | [App Store](https://apps.apple.com/jo/app/myshiptracking/id1403038386) |
| 18 – categorie | database con cargo, petroliere, yacht e altro; overlay personalizzabili | idem |
| Notifiche | un utente lamenta il promemoria insistente quando le notifiche sono spente | [App Store](https://apps.apple.com/nl/app/myshiptracking/id1403038386?l=en) |
| Libreria mappa, cluster | da APK | — |

## Cosa prendere per BoatRadar

- Punto 28: avvisi per **area disegnata** («entra/esce dal golfo»), più semplici da capire degli
  avvisi per nave; stessa macchina a stati del punto 28 applicata al bbox.
- Punto 29: pulsante «centra su di me» sempre visibile.
- Punto 25/notifiche: se l'utente rifiuta le notifiche, non chiederle di nuovo a ogni apertura.

## Limiti

Niente APK: librerie e permessi da verificare con REA.
