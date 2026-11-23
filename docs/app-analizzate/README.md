# App di riferimento analizzate (REA)

Le app di tracciamento navi del foglio «Confronti» del Piano risolvono già problemi aperti di
BoatRadar: densità dei marker, tocco sulle navi sovrapposte, icone per tipo, avvisi sulle navi
preferite. Con [REA](https://github.com/morluto/rea) (MIT, v6.10.1) si vede dall'APK con quali
librerie e permessi lo fanno. Integrazione GitHub n. 4 del Piano.

Regole:

- Si leggono dichiarazioni (manifest, permessi, componenti), nomi delle librerie e stringhe, per
  capire funzioni e interoperabilità. Niente codice o risorse copiati in BoatRadar.
- Gli APK sono di terzi: restano in `diagnosi/apk/` (ignorata da git). Nella repo va solo una
  scheda per app, `docs/app-analizzate/<pacchetto>.md`, creata da `_modello.md`.
- Usa APK scaricati dal tuo telefono o dallo store ufficiale, nel rispetto dei termini d'uso
  delle app.

## Strumenti (una volta)

| Strumento | Serve per | Installazione |
|---|---|---|
| REA | tutti i comandi | `npm install -g rea-agents@6.10.1` (oppure `npx rea-agents setup` per usarlo come MCP da Claude Code) |
| JDK 17+ e JADX headless 0.8.0 | manifest, classi, librerie | JAR e controllo SHA-256 nella [guida Android di REA](https://github.com/morluto/rea/blob/main/docs/guides/android/android-analysis.md); poi `REA_JADX_MCP_JAR=/percorso/jadx-headless-mcp-0.8.0-all.jar` |
| Apktool | stringhe e risorse | `REA_APKTOOL_COMMAND=/percorso/apktool` |
| adb | scaricare gli APK dal telefono | Android SDK Platform Tools; debug USB attivo sul telefono; `REA_ADB_PATH` se non è nel `PATH` |

Firma dell'APK e riconoscimento di Flutter funzionano anche senza JADX e Apktool.

## Procedura per ogni app

1. Telefono collegato: `rea list-adb-devices` per il seriale, poi
   `rea list-adb-packages <seriale> --scope third_party --json` per il nome del pacchetto.
2. `bash tools/analizza-apk.sh --adb <seriale> <pacchetto>` (oppure, con un APK già scaricato,
   `bash tools/analizza-apk.sh app.apk <pacchetto>`). Lo script salva le uscite in
   `diagnosi/apk/<pacchetto>/`, cerca le librerie di mappa, avvisi e rete e crea la scheda con
   versione, data, sha256 e librerie trovate (con il numero di classi). Se manca JADX non crea
   la scheda ed esce con 1: firma e Flutter restano comunque in `diagnosi/apk/`.
3. Completa la scheda leggendo `pacchetto.json` (permessi, servizi, ricevitori) e `risorse.json`
   (categorie di nave, testi degli avvisi): ogni scoperta rimanda a un punto del Piano.
4. Cancella gli APK quando hai finito: `rm -r diagnosi/apk/<pacchetto>`.

## App da analizzare

| App | Pacchetto | Punti del Piano che la citano | Scheda |
|---|---|---|---|
| MarineTraffic | da `list-adb-packages` | 4, 9, 15, 16, 18, 30 | — |
| VesselFinder | da `list-adb-packages` | 7, 12, 23, 37 | — |
| MyShipTracking | `com.nativity.myshiptracking` | 10, 17, 18, 31, 39, 41 | — |
| ShipXplorer | da `list-adb-packages` | 8, 9 | — |
| Boat Watch | `com.electricpocket.boatwatch` | 3, 20, 24, 26, 28, 29, 40 | — |
| ShipAtlas | `com.maritimeoptima.production` | 9, 18, 37, 38 | — |

I pacchetti indicati vengono dai link Play Store del foglio «Confronti»; per le altre tre il
Piano ha solo il sito web. Quando una scheda è pronta, sostituisci «—» con il link.
