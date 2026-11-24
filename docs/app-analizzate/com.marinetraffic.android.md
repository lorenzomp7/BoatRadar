# MarineTraffic – scheda da fonti pubbliche

| Campo | Valore |
|---|---|
| Pacchetto | `com.marinetraffic.android` |
| Versione | 5.6.0 (Play Store, maggio 2026); iOS 5.7.2 |
| Analizzata il | 2026-11-24 |
| Fonte | **fonti pubbliche, non l'APK** (pagine di supporto, schede degli store) |

Le righe «da APK» si completano con `bash tools/analizza-apk.sh` quando c'è l'APK.

## Cosa si è visto, per punto del Piano

| Punto | Trovato | Fonte |
|---|---|---|
| 9 – filtri | sulla mappa ci sono tre comandi fissi: filtri delle navi (imbuto), aggiornamento, «My Fleets» (cuore); nei livelli si sceglie quali tipi di nave mostrare | [supporto MarineTraffic](https://support.marinetraffic.com/en/articles/9552821-settings-of-mobile-app) |
| 15, 16 – simboli | opzione «Show Wake»: la scia dietro la nave cambia lunghezza con la velocità | idem |
| 30 – etichette | nella versione 2026 i nomi non si vedono più in mappa e gli utenti se ne lamentano: senza nomi non si capisce la nave senza aprirla | [App Store, recensione](https://apps.apple.com/JP/app/id563910324) |
| 28 – avvisi | «Notifications» crea, mette in pausa, riprende e cancella avvisi; si attivano per dispositivo | [supporto](https://support.marinetraffic.com/en/articles/9552821-settings-of-mobile-app) |
| 29 – vicino a me | «see what's near you» e auto-tracking della propria posizione | [App Store](https://apps.apple.com/pg/app/id563910324?l=en-gb), [supporto](https://support.marinetraffic.com/en/articles/9552821-settings-of-mobile-app) |
| 38 – porti | arrivi e partenze live per oltre 4.000 porti e marine | [App Store](https://apps.apple.com/pg/app/id563910324?l=en-gb) |
| 37 – ETA | pianificatore di rotta: distanze ed ETA su un percorso disegnato | idem |
| 36 – fonti | posizioni da stazioni costiere gratis; satellite a pagamento | [App Store, risposta dello sviluppatore](https://apps.apple.com/PH/app/id563910324) |
| Libreria mappa, cluster, FCM | da APK | — |

## Cosa prendere per BoatRadar

- Punto 9: tre comandi sempre visibili sulla mappa (filtri, aggiorna, preferite) invece di menu
  nascosti.
- Punto 30: tenere i nomi in mappa a zoom alto; la loro scomparsa è la lamentela principale.
- Punto 16: scia proporzionale alla velocità come segnale «in moto / ferma» leggibile da lontano.
- Punto 23: indicare sempre da dove viene la posizione (terrestre o no) e quanto è vecchia.

## Limiti

Niente APK: libreria della mappa, raggruppamento dei marker e servizi in background vanno
confermati con REA.
