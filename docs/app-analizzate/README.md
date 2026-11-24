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

Dalla chat non serve fare nulla: in ogni sessione Claude Code su questa repo c'è il server MCP
`rea` (`.mcp.json`), e Claude installa da solo JADX e Apktool (skill `rea`). Basta mandare gli APK
in chat, o collegare il telefono, e chiedere l'analisi.

| Strumento | Serve per | Installazione |
|---|---|---|
| REA 6.10.1 | tutti i comandi | `node .claude/rea/rea.mjs <comando>` (versione fissata, senza installazione globale); nel cloud c'è anche `rea` nel PATH |
| JDK 17+, JADX headless 0.7.1 e Apktool 3.0.2 | manifest, classi, librerie, stringhe, risorse | `bash .claude/rea/installa.sh` (Linux/macOS; nel cloud parte all'avvio della sessione) oppure `.claude\rea\installa-windows.ps1` (Windows): scarica i JAR con controllo SHA-256 in `~/.cache/rea-tools` (Windows `%LOCALAPPDATA%\rea`) |
| adb | scaricare gli APK dal telefono | Android SDK Platform Tools; debug USB attivo sul telefono; `REA_ADB_PATH` se non è nel `PATH` |

Controllo: `node .claude/rea/check.mjs [file.apk]`.

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
| MarineTraffic | `com.marinetraffic.android` | 4, 9, 15, 16, 18, 30 | [scheda](com.marinetraffic.android.md) (fonti pubbliche) |
| VesselFinder | da `list-adb-packages` | 7, 12, 23, 37 | [scheda](vesselfinder.md) (fonti pubbliche) |
| MyShipTracking | `com.nativity.myshiptracking` | 10, 17, 18, 31, 39, 41 | [scheda](com.nativity.myshiptracking.md) (fonti pubbliche) |
| ShipXplorer | da `list-adb-packages` | 8, 9 | [scheda](shipxplorer.md) (fonti pubbliche) |
| Boat Watch | `com.electricpocket.boatwatch` | 3, 20, 24, 26, 28, 29, 40 | [scheda](com.electricpocket.boatwatch.md) (fonti pubbliche) |
| ShipAtlas | `com.maritimeoptima.production` | 9, 18, 37, 38 | [scheda](com.maritimeoptima.production.md) (fonti pubbliche) |

I pacchetti indicati vengono dai link Play Store del foglio «Confronti»; per le altre tre il
Piano ha solo il sito web.

Le sei schede sono compilate da **fonti pubbliche** (store, pagine di supporto, siti degli
editori), con le fonti citate riga per riga. Quando arriva un APK, `bash tools/analizza-apk.sh`
aggiunge librerie, permessi e servizi alla scheda della stessa app (righe «da APK»).
