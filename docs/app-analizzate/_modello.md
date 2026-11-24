# {{app}}

| Campo | Valore |
|---|---|
| Pacchetto | `{{pacchetto}}` |
| Versione | {{versione}} |
| Analizzata il | {{data}} |
| APK sha256 | `{{sha256}}` |
| Strumento | REA 6.10.1 (`tools/analizza-apk.sh`), uscite grezze in `diagnosi/apk/` (non versionate) |

Solo dichiarazioni e nomi delle librerie: nessun codice o risorsa dell'app copiato in BoatRadar.

## Librerie trovate

{{librerie}}

## Cosa si è visto, per punto del Piano

- **Mappa e densità dei marker (punti 4, 10, 16, 30)**: libreria della mappa, raggruppamento
  dei marker (cluster), soglie di zoom se compaiono nelle risorse.
- **Avvisi e lavoro in background (punti 28, 29)**: FCM/WorkManager, permessi
  `POST_NOTIFICATIONS`, `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, servizi in primo piano.
- **Icone e categorie di nave (punti 15, 16, 18)**: nomi delle categorie nelle stringhe
  (`risorse.json`), nomi delle icone o dei colori per tipo.
- **Fonti dati e domini (punti 17, 36)**: domini nel manifest (network security config,
  deep link), librerie di rete, WebSocket o MQTT per gli aggiornamenti in tempo reale.

## Cosa prendere per BoatRadar

- …

## Limiti di questa analisi

- Statica: non dice come l'app si comporta in esecuzione né quali dati scambia.
- Codice offuscato: i nomi delle classi dell'app possono essere illeggibili; quelli delle
  librerie di solito restano.
