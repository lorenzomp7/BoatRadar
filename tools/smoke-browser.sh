#!/usr/bin/env bash
# Verifica di BoatRadar nel browser con agent-browser (https://github.com/vercel-labs/agent-browser, Apache-2.0).
# Avvia server.js con i messaggi di test (tools/smoke-server.js, senza chiave né rete), apre la pagina
# a larghezza desktop (1280×800) e telefono (390×844) e controlla che:
#   1. compaiano le navi;
#   2. un clic del mouse su una nave apra la scheda con il suo MMSI;
#   3. la pagina non abbia errori JavaScript né messaggi console.error.
# Esce con 0 se tutto va bene, con 1 al primo controllo fallito. Screenshot in diagnosi/smoke/.
#
#   bash tools/smoke-browser.sh                 # server locale con la fixture di esempio
#   SMOKE_URL=https://.../ bash tools/smoke-browser.sh   # pagina già pubblicata (nessun server locale)
#
# Variabili: SMOKE_PORT (8799), SMOKE_FIXTURE, SMOKE_URL, SMOKE_LEAFLET_LOCAL=1 per caricare Leaflet dal
# registro npm quando unpkg.com non è raggiungibile (ambienti con rete limitata), AGENT_BROWSER_EXECUTABLE_PATH
# per usare un Chrome già installato invece di quello scaricato da «agent-browser install».
set -euo pipefail
cd "$(dirname "$0")/.."

AB=(agent-browser --session "boatradar-smoke-$$")
PORT="${SMOKE_PORT:-8799}"
OUT="diagnosi/smoke"
mkdir -p "$OUT"
SERVER_PID=""
TMP="$(mktemp -d)"

cleanup() {
  "${AB[@]}" close >/dev/null 2>&1 || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }
command -v agent-browser >/dev/null || fail "agent-browser non trovato: npm install -g agent-browser && agent-browser install"

# --- server ---------------------------------------------------------------
if [ -n "${SMOKE_URL:-}" ]; then
  URL="$SMOKE_URL"
else
  node tools/smoke-server.js "$PORT" ${SMOKE_FIXTURE:+"$SMOKE_FIXTURE"} > "$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 150); do
    grep -q '^pronto ' "$TMP/server.log" && break
    kill -0 "$SERVER_PID" 2>/dev/null || { cat "$TMP/server.log" >&2; fail "il server di prova si è fermato"; }
    sleep 0.1
  done
  grep -q '^pronto ' "$TMP/server.log" || { cat "$TMP/server.log" >&2; fail "il server di prova non è pronto dopo 15 s"; }
  URL="http://127.0.0.1:$PORT/"
fi
ok "pagina: $URL"

# --- Leaflet senza unpkg (facoltativo) -------------------------------------
# La pagina carica Leaflet da unpkg.com. Se non è raggiungibile, Leaflet 1.9.4 preso dal registro npm
# viene eseguito appena il browser crea <html>, prima degli script della pagina.
if [ "${SMOKE_LEAFLET_LOCAL:-0}" = 1 ]; then
  (cd "$TMP" && npm pack leaflet@1.9.4 --silent >/dev/null && tar xzf leaflet-1.9.4.tgz)
  node -e '
    const fs = require("fs"), d = process.argv[1] + "/package/dist/";
    const js = fs.readFileSync(d + "leaflet.js", "utf8"), css = fs.readFileSync(d + "leaflet.css", "utf8");
    fs.writeFileSync(process.argv[1] + "/leaflet-init.js", "(function(){if(window.top!==window)return;" +
      "function run(){if(window.L)return;" + js + "\n;var s=document.createElement(\"style\");s.textContent=" +
      JSON.stringify(css) + ";document.documentElement.appendChild(s);}" +
      "if(document.documentElement)run();else new MutationObserver(function(_,o){if(document.documentElement)" +
      "{o.disconnect();run();}}).observe(document,{childList:true});})();");
  ' "$TMP"
  AB+=(--init-script "$TMP/leaflet-init.js")
  ok "Leaflet caricato dal registro npm (SMOKE_LEAFLET_LOCAL=1)"
fi

# Valore di un'espressione JavaScript nella pagina, come testo JSON.
js() { "${AB[@]}" eval --json "$1" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success) { console.error(d.error || "eval fallito"); process.exit(1); }
  process.stdout.write(JSON.stringify(d.data.result));'; }

# --- controlli per ogni dimensione ----------------------------------------
check() {
  local name="$1" w="$2" h="$3"
  "${AB[@]}" set viewport "$w" "$h" >/dev/null
  "${AB[@]}" open "$URL" >/dev/null || fail "$name: la pagina non si apre"
  "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 0" >/dev/null \
    || fail "$name: nessuna nave in mappa (Leaflet caricato? $(js "typeof L") · stato: $(js "document.getElementById('status')?.textContent"))"
  ok "$name: $(js "markers.size") navi in mappa"

  # nave da aprire: quella della fixture di esempio se c'è, altrimenti la prima ricevuta
  local mmsi
  mmsi=$(js "markers.has(247123450) ? 247123450 : markers.keys().next().value")
  js "map.setView(markers.get($mmsi).marker.getLatLng(), 12, { animate: false }), true" >/dev/null
  "${AB[@]}" wait 300 >/dev/null
  local point
  point=$(js "(() => { const r = document.getElementById('map').getBoundingClientRect();
    const p = map.latLngToContainerPoint(markers.get($mmsi).marker.getLatLng());
    return Math.round(r.left + p.x) + ' ' + Math.round(r.top + p.y); })()" | tr -d '"')
  # clic vero del mouse sul simbolo della nave (non una chiamata diretta a select())
  "${AB[@]}" mouse move $point >/dev/null
  "${AB[@]}" mouse down >/dev/null
  "${AB[@]}" mouse up >/dev/null
  "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none'
    && document.getElementById('content').textContent.includes('$mmsi')" >/dev/null \
    || { "${AB[@]}" screenshot "$OUT/$name-errore.png" >/dev/null || true; fail "$name: il clic sulla nave $mmsi non apre la scheda (screenshot in $OUT/)"; }
  ok "$name: il clic sulla nave $mmsi apre la scheda ($(js "document.querySelector('#content h2')?.textContent || ''"))"
  "${AB[@]}" screenshot "$OUT/$name.png" >/dev/null

  # errori JavaScript e console.error (i warning, come Digitraffic non raggiungibile, non contano)
  local problems
  problems=$( { "${AB[@]}" errors --json; echo; "${AB[@]}" console --json; } | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    const out = [];
    for (const e of lines[0].data.errors || []) out.push("errore JS: " + (e.text || e.message || JSON.stringify(e)).split("\n")[0]);
    for (const m of lines[1].data.messages || []) if (m.type === "error") out.push("console.error: " + String(m.text).split("\n")[0]);
    process.stdout.write(out.join("\n"));')
  [ -z "$problems" ] || fail "$name: $problems"
  ok "$name: nessun errore JavaScript"
  "${AB[@]}" errors --clear >/dev/null; "${AB[@]}" console --clear >/dev/null
}

check desktop 1280 800
check telefono 390 844
echo "Verifica nel browser riuscita · screenshot in $OUT/"
