#!/usr/bin/env bash
# Analisi statica di un'app di riferimento del Piano con REA (https://github.com/morluto/rea, MIT).
# Legge solo dichiarazioni e nomi delle librerie: l'APK non viene eseguito e nulla viene copiato nella repo.
#
#   bash tools/analizza-apk.sh percorso/app.apk <pacchetto>     # APK già scaricato
#   bash tools/analizza-apk.sh --adb <seriale> <pacchetto>      # scarica l'APK installato sul telefono
#
# Uscite grezze in diagnosi/apk/<pacchetto>/ (ignorata da git); scheda da completare in
# docs/app-analizzate/<pacchetto>.md, creata dal modello solo se manifest e classi sono stati letti.
# Esce con 1 se un comando non riesce. Procedura: docs/app-analizzate/README.md.
set -uo pipefail
cd "$(dirname "$0")/.."

command -v rea >/dev/null || { echo "✗ manca rea: npm install -g rea-agents@6.10.1" >&2; exit 1; }
command -v node >/dev/null || { echo "✗ manca node" >&2; exit 1; }
USAGE="uso: bash tools/analizza-apk.sh percorso/app.apk <pacchetto> | --adb <seriale> <pacchetto>"

if [ "${1:-}" = "--adb" ]; then
  [ $# -eq 3 ] || { echo "$USAGE" >&2; exit 2; }
  SERIAL="$2"; NAME="$3"
  mkdir -p diagnosi/apk
  rea pull-adb-package "$SERIAL" "$NAME" --output-directory diagnosi/apk --json > "diagnosi/apk/pull-$NAME.json" \
    || { echo "✗ download dal telefono non riuscito: vedi diagnosi/apk/pull-$NAME.json" >&2; exit 1; }
  APK="diagnosi/apk/$NAME/base.apk"
else
  [ $# -eq 2 ] && [ -f "$1" ] || { echo "$USAGE" >&2; exit 2; }
  APK="$1"; NAME="$2"
fi
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "✗ nome di pacchetto non valido: $NAME" >&2; exit 2; }
[ -f "$APK" ] || { echo "✗ APK non trovato: $APK" >&2; exit 1; }

OUT="diagnosi/apk/$NAME"
mkdir -p "$OUT"
FAILED=()
failed() { [[ " ${FAILED[*]-} " == *" $1 "* ]]; }
run() {  # run <file> <comando rea...>: salva l'uscita JSON, continua anche se fallisce
  local file="$1"; shift
  if rea "$@" --json > "$OUT/$file" 2> "$OUT/$file.err"; then echo "✓ $file"; rm -f "$OUT/$file.err"
  else echo "✗ $file (dettagli in $OUT/$file.err)"; FAILED+=("$file"); fi
}

# Quante classi nell'uscita JSON contengono la sottostringa cercata. Conta solo valori di testo,
# esclusi i campi che ripetono la richiesta (query, argomenti…), così una ricerca vuota dà 0.
count_classes() {
  node -e '
    const [file, query] = process.argv.slice(1);
    const SKIP = /^(query|queries|request|arguments|args|argv|command|input|target|path|subject|name_query)$/i;
    let n = 0;
    (function walk(v, key) {
      if (typeof v === "string") { if (!SKIP.test(key || "") && v.includes(query)) n++; }
      else if (Array.isArray(v)) v.forEach(x => walk(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!SKIP.test(k)) walk(x, k);
    })(JSON.parse(require("fs").readFileSync(file, "utf8")));
    process.stdout.write(String(n));
  ' "$1" "$2" 2>/dev/null || echo 0
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
if ! failed pacchetto.json; then
  for entry in "${LIBS[@]}"; do
    IFS='|' read -r family points query <<< "$entry"
    file="classi-${query//[^a-zA-Z0-9]/_}.json"
    run "$file" search-android-classes "$APK" "$query" >/dev/null
    failed "$file" && continue
    n="$(count_classes "$OUT/$file" "$query")"
    [ "$n" -gt 0 ] && FOUND+=("- [x] $family (\`$query\`, $n classi) → punti $points")
  done
else
  echo "… ricerca delle librerie saltata: JADX non disponibile"
fi

SHA="$(sha256sum "$APK" 2>/dev/null || shasum -a 256 "$APK")"; SHA="${SHA%% *}"
CARD="docs/app-analizzate/$NAME.md"
if failed pacchetto.json; then
  echo "… scheda non creata: senza manifest e classi sarebbe vuota. Installa JADX e ripeti."
elif [ -f "$CARD" ]; then
  echo "… scheda già presente, non la tocco: $CARD"
  printf 'Librerie trovate in questa analisi:\n'; printf '%s\n' "${FOUND[@]-nessuna}"
else
  VERSION="$(node -e '
    let found = null;
    (function walk(v) {
      if (found || !v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (/^version_?name$/i.test(k) && (typeof x === "string" || typeof x === "number")) { found = String(x); return; }
        walk(x);
      }
    })(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
    process.stdout.write(found || "");' "$OUT/pacchetto.json" 2>/dev/null)"
  LIST="$(printf '%s\n' "${FOUND[@]-- nessuna delle librerie cercate}")"
  APP="$NAME" PKG="$NAME" VER="${VERSION:-da compilare}" DATE="$(date +%Y-%m-%d)" SHA="$SHA" LIST="$LIST" \
    node -e '
      const fs = require("fs"), e = process.env;
      const text = fs.readFileSync("docs/app-analizzate/_modello.md", "utf8")
        .replaceAll("{{app}}", e.APP).replaceAll("{{pacchetto}}", e.PKG).replaceAll("{{versione}}", e.VER)
        .replaceAll("{{data}}", e.DATE).replaceAll("{{sha256}}", e.SHA).replaceAll("{{librerie}}", e.LIST);
      fs.writeFileSync(process.argv[1], text);' "$CARD"
  echo "✓ scheda creata: $CARD"
fi
echo "Uscite grezze in $OUT/ (fuori da git). APK sha256 $SHA"
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "✗ comandi non riusciti: ${FAILED[*]} (di solito manca JADX o Apktool: vedi docs/app-analizzate/README.md)" >&2
  exit 1
fi
