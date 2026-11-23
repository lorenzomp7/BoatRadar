#!/usr/bin/env bash
# Analisi statica di un'app di riferimento del Piano con REA (https://github.com/morluto/rea, MIT).
# Legge solo dichiarazioni e nomi delle librerie: l'APK non viene eseguito e nulla viene copiato nella repo.
#
#   bash tools/analizza-apk.sh percorso/app.apk
#   bash tools/analizza-apk.sh --adb <seriale> <pacchetto>     # scarica l'APK installato sul telefono
#
# Uscite grezze in diagnosi/apk/<nome>/ (ignorata da git); scheda da completare in
# docs/app-analizzate/<nome>.md, creata dal modello se non esiste. Procedura: docs/app-analizzate/README.md.
set -uo pipefail
cd "$(dirname "$0")/.."

command -v rea >/dev/null || { echo "✗ manca rea: npm install -g rea-agents@6.10.1" >&2; exit 1; }

if [ "${1:-}" = "--adb" ]; then
  [ $# -eq 3 ] || { echo "uso: bash tools/analizza-apk.sh --adb <seriale> <pacchetto>" >&2; exit 2; }
  SERIAL="$2"; NAME="$3"
  mkdir -p diagnosi/apk
  rea pull-adb-package "$SERIAL" "$NAME" --output-directory diagnosi/apk --json > "diagnosi/apk/pull-$NAME.json" \
    || { echo "✗ download dal telefono non riuscito: vedi diagnosi/apk/pull-$NAME.json" >&2; exit 1; }
  APK="diagnosi/apk/$NAME/base.apk"
else
  [ $# -eq 1 ] && [ -f "$1" ] || { echo "uso: bash tools/analizza-apk.sh percorso/app.apk | --adb <seriale> <pacchetto>" >&2; exit 2; }
  APK="$1"; NAME="$(basename "$1" .apk)"
fi
[ -f "$APK" ] || { echo "✗ APK non trovato: $APK" >&2; exit 1; }

OUT="diagnosi/apk/$NAME"
mkdir -p "$OUT"
FAILED=()
run() {  # run <file> <comando rea...>: salva l'uscita JSON, continua anche se fallisce
  local file="$1"; shift
  if rea "$@" --json > "$OUT/$file" 2> "$OUT/$file.err"; then echo "✓ $file"; rm -f "$OUT/$file.err"
  else echo "✗ $file (dettagli in $OUT/$file.err)"; FAILED+=("$file"); fi
}

# senza strumenti esterni
run firma.json inspect-apk-signature "$APK"
run flutter.json identify-flutter-build "$APK"
# richiedono JADX (REA_JADX_MCP_JAR + JDK 17+) e Apktool (REA_APKTOOL_COMMAND)
run pacchetto.json inspect-android-package "$APK"
run risorse.json decode-android-resources "$APK" --string-tables-only

# Librerie cercate per nome di classe, con il punto del Piano a cui servono.
# formato: famiglia|punti|sottostringa (maiuscole e minuscole contano)
LIBS=(
  "Mapbox|4, 10, 16, 30|com.mapbox"
  "MapLibre|4, 10, 16, 30|org.maplibre"
  "Google Maps|4, 10, 16, 30|com.google.android.gms.maps"
  "raggruppamento marker (Google Maps Utils)|4, 30|com.google.maps.android.clustering"
  "osmdroid|4, 10, 16|org.osmdroid"
  "HERE SDK|4, 10|com.here.sdk"
  "Firebase Cloud Messaging|28, 29|com.google.firebase.messaging"
  "WorkManager|28, 29|androidx.work"
  "OneSignal|28, 29|com.onesignal"
  "OkHttp|17, 36|okhttp3"
  "Retrofit|17, 36|retrofit2"
  "WebSocket (Java-WebSocket)|17, 36|org.java_websocket"
  "Socket.IO|17, 36|io.socket"
  "MQTT (Paho)|17, 36|org.eclipse.paho"
)
FOUND=()
if [[ ! " ${FAILED[*]} " =~ " pacchetto.json " ]]; then
  for entry in "${LIBS[@]}"; do
    IFS='|' read -r family points query <<< "$entry"
    file="classi-${query//[^a-zA-Z0-9]/_}.json"
    run "$file" search-android-classes "$APK" "$query" >/dev/null
    if [ -s "$OUT/$file" ] && grep -q "$query" "$OUT/$file"; then FOUND+=("- [x] $family (\`$query\`) → punti $points"); fi
  done
else
  echo "… ricerca delle librerie saltata: JADX non disponibile"
fi

SHA="$(sha256sum "$APK" 2>/dev/null || shasum -a 256 "$APK")"; SHA="${SHA%% *}"
VERSION="$(grep -o -m1 -E '"?version_?[nN]ame"?[": ]+"?[^",}]+' "$OUT/pacchetto.json" 2>/dev/null | sed -E 's/.*[:=] *"?//')"
CARD="docs/app-analizzate/$NAME.md"
if [ ! -f "$CARD" ]; then
  LIST="$(printf '%s\n' "${FOUND[@]:-- nessuna delle librerie cercate (o ricerca saltata)}")"
  sed -e "s|{{app}}|$NAME|g" -e "s|{{pacchetto}}|$NAME|g" -e "s|{{versione}}|${VERSION:-da compilare}|g" \
      -e "s|{{data}}|$(date +%Y-%m-%d)|g" -e "s|{{sha256}}|$SHA|g" docs/app-analizzate/_modello.md \
    | awk -v list="$LIST" '{ if ($0 == "{{librerie}}") print list; else print }' > "$CARD"
  echo "✓ scheda creata: $CARD"
else
  echo "… scheda già presente, non la tocco: $CARD"
  printf 'Librerie trovate in questa analisi:\n%s\n' "${FOUND[@]:-nessuna}"
fi
echo "Uscite grezze in $OUT/ (fuori da git). APK sha256 $SHA"
[ ${#FAILED[@]} -eq 0 ] || echo "Comandi non riusciti: ${FAILED[*]} (di solito manca JADX o Apktool: vedi README)"
