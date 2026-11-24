# ShipXplorer – scheda da fonti pubbliche

| Campo | Valore |
|---|---|
| Pacchetto | da verificare con `rea list-adb-packages` (editore AirNav Systems) |
| Versione | iOS aggiornata ad aprile 2026 |
| Analizzata il | 2026-11-24 |
| Fonte | **fonti pubbliche, non l'APK** (App Store, rtl-sdr.com, blog AirNav) |

## Cosa si è visto, per punto del Piano

| Punto | Trovato | Fonte |
|---|---|---|
| 8, 36 – fonti | rete di oltre 350 ricevitori di volontari (come RadarBox per gli aerei), più accordi con fornitori satellitari | [appfollow](https://apps.appfollow.io/ios/shipxplorer-ship-tracker/1626500450?country=mt), [Hellenic Shipping News](https://www.hellenicshippingnews.com/shipxplorer-is-officially-launched/) |
| 8 – ricevitore proprio | chi manda i dati del proprio ricevitore ottiene l'account business gratis; AirNav vende dongle AIS e antenne | [rtl-sdr.com](https://www.rtl-sdr.com/tag/automatric-identification-system/), [rtl-sdr.com](https://www.rtl-sdr.com/airnav-systems-launch-ais-aggregator-shipxplorer-com/) |
| 9 – copertura | mappa di copertura dettagliata per sapere dove i dati sono affidabili | [blog AirNav](https://en.airnavradar.com/blog/what-are-the-random-vessels-on-airnavradarcom) |
| Scheda nave | rotta, pescaggio, posizione, velocità, foto degli spotter | [App Store](https://apps.apple.com/app/id1626500450) |
| Privacy | l'App Store dichiara «Data Used to Track You» | idem |
| Libreria mappa, permessi | da APK | — |

## Cosa prendere per BoatRadar

- Punto 8: il ricevitore proprio (AIS-catcher su RTL-SDR) è la stessa strada di ShipXplorer;
  mandare i dati anche a un aggregatore dà in cambio accesso ai suoi dati.
- Punto 9: mostrare in mappa dove arrivano dati (zone con messaggi recenti), così una zona
  vuota non sembra «nessuna nave».

## Limiti

Niente APK e pacchetto non confermato: da completare con REA.
