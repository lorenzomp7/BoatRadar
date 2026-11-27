#!/usr/bin/env bash
# Misura della pagina nel browser (punti 13, 63, 42): quanto costa il movimento fluido con molte navi.
# Avvia server.js con le navi sintetiche di tools/carico.js (tools/smoke-server.js --navi, che le fa avanzare coerenti
# con velocità e rotta), apre boatradar.html con agent-browser a 1280×800 e, per ogni scenario, con l'animazione spenta
# e accesa, misura per MISURA_SECONDI secondi: fotogrammi al secondo (requestAnimationFrame), ridisegni del canvas al
# secondo e loro p50/p95 (renderer._redraw), long task oltre 50 ms (fuori dall'arrivo dei dati, cioè non entro 1 s
# dalla fine di una risposta di /api/locations o del Baltico), passi e setLatLng dell'animatore (anim.stats), e il tempo
# di loadLocations per aggiornare i marker (mediana di 5 giri). Scenari: mondo a zoom 3 (6000 marker, il campione del
# server), Rotterdam a zoom 9 e a zoom 13.
#
#   bash tools/misura-pagina.sh                          # stampa la tabella e controlla le soglie
#   bash tools/misura-pagina.sh --registra "dopo punto 13"   # e aggiunge le righe a docs/prestazioni.md («Pagina»)
#
# Soglie (docs/prestazioni.md, «Pagina»): fps ≥ 55 (con MISURA_CPU: ≥ 30 a zoom 13); con l'animazione accesa mondo
# ≤ 2 ridisegni/s e p95 ≤ 12 ms, zoom 13 p95 ≤ 6 ms; nessun long task > 50 ms fuori dall'arrivo dei dati;
# loadLocations con l'animazione accesa al massimo 2 ms più che spenta.
# Esce con 1 se una soglia non regge (le righe sono comunque stampate e, con --registra, registrate).
# Variabili: MISURA_PORT (8930), MISURA_NAVI (30000), MISURA_SECONDI (10), MISURA_CPU (es. 4: CPU rallentata 4 volte
# con Emulation.setCPUThrottlingRate via CDP; facoltativo), SMOKE_LEAFLET_LOCAL=1 (Leaflet dal registro npm),
# AGENT_BROWSER_EXECUTABLE_PATH. Headless e senza GPU i numeri valgono per confrontare due versioni sulla stessa macchina.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --registra) LABEL="${2:?--registra vuole un nome per le righe}"; shift 2 ;;
    *) echo "opzione sconosciuta: $1" >&2; exit 2 ;;
  esac
done
PORT="${MISURA_PORT:-8930}" NAVI="${MISURA_NAVI:-30000}" SECS="${MISURA_SECONDI:-10}" CPU="${MISURA_CPU:-}"
SESSION="boatradar-misura-$$"
AB=(agent-browser --session "$SESSION")
TMP="$(mktemp -d)"
SERVER_PID="" CDP_PID=""
cleanup() {
  [ -n "$CDP_PID" ] && kill "$CDP_PID" 2>/dev/null || true
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "✗ $*" >&2; exit 1; }
command -v agent-browser >/dev/null || fail "agent-browser non trovato: npm install -g agent-browser && agent-browser install"

node tools/smoke-server.js "$PORT" --navi "$NAVI" > "$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 700); do
  grep -q '^pronto ' "$TMP/server.log" && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$TMP/server.log" >&2; fail "il server di prova si è fermato"; }
  sleep 0.1
done
grep -q '^pronto ' "$TMP/server.log" || { cat "$TMP/server.log" >&2; fail "il server di prova non è pronto dopo 70 s"; }
URL="http://127.0.0.1:$PORT/"
echo "✓ $NAVI navi sintetiche su $URL"

if [ "${SMOKE_LEAFLET_LOCAL:-0}" = 1 ]; then   # come tools/smoke-browser.sh
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
fi

js() { "${AB[@]}" eval --json "$1" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success) { console.error(d.error || "eval fallito"); process.exit(1); }
  process.stdout.write(JSON.stringify(d.data.result));'; }

"${AB[@]}" set viewport 1280 800 >/dev/null
"${AB[@]}" open "$URL" >/dev/null || fail "la pagina non si apre"
"${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 1000" >/dev/null || fail "nessuna nave in mappa · stato: $(js "document.getElementById('status')?.textContent")"
# la legenda chiusa, come la vede chi guarda la mappa
js "(document.getElementById('legend').open = false, true)" >/dev/null

if [ -n "$CPU" ]; then   # facoltativo: CPU rallentata via CDP sulla scheda della pagina
  # il rallentamento vale finché la sessione CDP resta collegata: il processo resta vivo fino alla fine della misura
  CDP=$("${AB[@]}" get cdp-url | tail -1)
  node -e '
    const WebSocket = require("ws"), [url, rate] = process.argv.slice(1), ws = new WebSocket(url);
    let id = 0; const send = (method, params = {}, sessionId) => new Promise(res => { const i = ++id;
      ws.on("message", function h(m) { const d = JSON.parse(m); if (d.id === i) { ws.off("message", h); res(d.result); } });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) })); });
    ws.on("open", async () => {
      const { targetInfos } = await send("Target.getTargets");
      const page = targetInfos.find(t => t.type === "page" && /127\.0\.0\.1/.test(t.url));
      const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      await send("Emulation.setCPUThrottlingRate", { rate: Number(rate) }, sessionId);
      console.log("pronto");
    });
    ws.on("error", e => { console.error("CDP: " + e.message); process.exit(1); });
  ' "$CDP" "$CPU" > "$TMP/cdp.log" 2>&1 &
  CDP_PID=$!
  for _ in $(seq 1 100); do grep -q pronto "$TMP/cdp.log" && break; kill -0 "$CDP_PID" 2>/dev/null || break; sleep 0.1; done
  grep -q pronto "$TMP/cdp.log" || { cat "$TMP/cdp.log" >&2; fail "non riesco a rallentare la CPU via CDP"; }
  # controllo: un ciclo di 20 ms misurato dalla pagina deve durare circa CPU volte di più in tempo vero
  echo "✓ CPU rallentata $CPU volte (prova: $(js "(() => { let x = 0; const t = performance.now(); for (let i = 0; i < 2e6; i++) x += i % 7; return Math.round(performance.now() - t) + ' ms per 2 milioni di somme'; })()" | tr -d '"'))"
fi

# misura di MISURA_SECONDI secondi nella pagina (JSON)
MEASURE="new Promise(done => {
  const SEC = $SECS, st = anim.stats, s0 = { steps: st.steps, moved: st.moved }, longs = [], data = [], redraws = [], steps = [];
  const lt = new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push({ at: e.startTime, ms: e.duration }); });
  try { lt.observe({ type: 'longtask', buffered: false }); } catch { /* browser senza long task */ }
  const rs = new PerformanceObserver(l => { for (const e of l.getEntries()) if (/\\/api\\/locations|digitraffic/.test(e.name)) data.push(e.responseEnd); });
  rs.observe({ type: 'resource', buffered: false });
  const orig = renderer._redraw;
  renderer._redraw = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { redraws.push(performance.now() - t); } };
  let frames = 0, lastSteps = st.steps;
  const t0 = performance.now();
  const loop = () => {
    frames++;
    if (st.steps !== lastSteps) { steps.push(st.stepMs); lastSteps = st.steps; }
    if (performance.now() - t0 < SEC * 1000) requestAnimationFrame(loop); else finish();
  };
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
  function finish() {
    const secs = (performance.now() - t0) / 1000;
    lt.disconnect(); rs.disconnect(); renderer._redraw = orig;
    const outside = longs.filter(l => l.ms > 50 && !data.some(d => l.at >= d - 50 && l.at <= d + 1000));
    done({ markers: markers.size, animated: anim.enabled ? anim.set.size : 0, candidates: anim.enabled ? st.candidates : 0,
      fps: r1(frames / secs), redrawsPerS: r1(redraws.length / secs), redrawP50: r2(pct(redraws, 0.5)), redrawP95: r2(pct(redraws, 0.95)),
      longOutside: outside.length, longMaxOutside: r1(Math.max(0, ...outside.map(l => l.ms))),
      longAll: longs.filter(l => l.ms > 50).length, arrivals: data.length, longMax: r1(Math.max(0, ...longs.map(l => l.ms))),
      stepsPerS: r1((st.steps - s0.steps) / secs), movesPerS: r1((st.moved - s0.moved) / secs),
      stepP95: r2(pct(steps, 0.95)), pickMs: r2(st.pickMs), interval: Math.round(anim.interval) });
  }
  requestAnimationFrame(loop);
})"

ROWS="$TMP/rows.jsonl"
: > "$ROWS"
scenario() {   # nome, lat, lon, zoom
  local name="$1" lat="$2" lon="$3" zoom="$4" on
  for on in false true; do
    js "map.setView([$lat, $lon], $zoom, { animate: false }), true" >/dev/null
    [ "$(js "document.getElementById('smooth').checked")" = "$on" ] || js "(document.getElementById('smooth').click(), true)" >/dev/null
    [ "$(js "anim.enabled")" = "$on" ] || fail "$name: interruttore del movimento non a $on"
    # cinque giri per la mediana di loadLocations (dati di questa vista), poi 3,5 s per la scelta delle navi animate
    local load
    load=$(js "(async () => { const t = []; for (let i = 0; i < 5; i++) { await tick(); t.push(anim.stats.loadMs); }
      t.sort((a, b) => a - b); return Math.round(t[2] * 100) / 100; })()")
    "${AB[@]}" wait 3500 >/dev/null
    local res
    res=$(js "$MEASURE")
    node -e 'const [n, on, load, r] = process.argv.slice(1); console.log(JSON.stringify({ scenario: n, anim: on === "true", loadMs: Number(load), ...JSON.parse(r) }));' \
      "$name" "$on" "$load" "$res" >> "$ROWS"
    echo "✓ $name, animazione $([ "$on" = true ] && echo accesa || echo spenta): $res · loadLocations $load ms"
  done
}
scenario "mondo z3" 30 10 3
scenario "Rotterdam z9" 51.95 4.05 9
scenario "Rotterdam z13" 51.95 4.05 13

VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo '?')$(git diff --quiet 2>/dev/null || echo '+modifiche')"
node -e '
  const fs = require("fs"), [file, label, version, cpu] = process.argv.slice(1);
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const bad = [];
  for (const r of rows) {
    const k = `${r.scenario} (animazione ${r.anim ? "accesa" : "spenta"})`;
    // con la CPU rallentata vale solo fps ≥ 30 a zoom 13; il resto è in tabella per confronto
    if (cpu) { if (/z13/.test(r.scenario) && r.fps < 30) bad.push(`${k}: ${r.fps} fps < 30 con la CPU ${cpu}× più lenta`); continue; }
    if (r.fps < 55) bad.push(`${k}: ${r.fps} fps < 55`);
    // soglie dei ridisegni solo con animazione accesa: spenta, il solo ridisegno è quello dei dati arrivati (tutti i
    // marker, setStyle di loadLocations), che il movimento non tocca; resta in tabella come riferimento
    if (r.anim && /mondo/.test(r.scenario) && r.redrawsPerS > 2) bad.push(`${k}: ${r.redrawsPerS} ridisegni/s > 2`);
    if (r.anim && /mondo/.test(r.scenario) && r.redrawP95 > 12) bad.push(`${k}: ridisegno p95 ${r.redrawP95} ms > 12`);
    if (r.anim && /z13/.test(r.scenario) && r.redrawP95 > 6) bad.push(`${k}: ridisegno p95 ${r.redrawP95} ms > 6`);
    if (r.longOutside > 0) bad.push(`${k}: ${r.longOutside} long task > 50 ms fuori dall arrivo dei dati (max ${r.longMaxOutside} ms)`);
  }
  for (const r of rows.filter(x => x.anim && !cpu)) {
    const off = rows.find(x => !x.anim && x.scenario === r.scenario);
    if (off && r.loadMs > off.loadMs + 2) bad.push(`${r.scenario}: loadLocations ${r.loadMs} ms acceso contro ${off.loadMs} spento (+${(r.loadMs - off.loadMs).toFixed(2)} > 2 ms)`);
  }
  const day = new Date().toISOString().slice(0, 10), ver = label ? `${label} (${version})` : version;
  const lines = rows.map(r => `| ${day} | ${ver}${cpu ? ` · CPU ${cpu}×` : ""} | ${r.scenario} | ${r.anim ? "accesa" : "spenta"} | ${r.markers} | ${r.animated} / ${r.candidates} | ` +
    `${r.fps} | ${r.redrawsPerS} | ${r.redrawP50} / ${r.redrawP95} | ${r.longOutside} (max ${r.longMaxOutside}) · ${r.longAll} (max ${r.longMax}), ${r.arrivals} risposte | ` +
    `${r.stepsPerS} / ${r.movesPerS} | ${r.stepP95} | ${r.pickMs} | ${r.loadMs} |`);
  console.log("\n| Data | Versione | Scenario | Animazione | Marker | Animate / in moto | fps | Ridisegni/s | Ridisegno p50 / p95 ms | Long task > 50 ms fuori dai dati (max ms) · in tutto, risposte nella misura | Passi/s / setLatLng/s | Passo p95 ms | Scelta ms | loadLocations ms |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  console.log(lines.join("\n"));
  if (label) {
    const doc = "docs/prestazioni.md", marker = "<!-- nuove righe della pagina sopra questa linea -->", text = fs.readFileSync(doc, "utf8");
    if (!text.includes(marker)) { console.error(`manca la riga «${marker}» in ${doc}`); process.exit(1); }
    fs.writeFileSync(doc, text.replace(marker, lines.join("\n") + "\n" + marker));
    console.log(`\nRighe aggiunte a ${doc}`);
  }
  if (bad.length) { console.log("\n✗ soglie non rispettate:\n  " + bad.join("\n  ")); process.exit(1); }
  console.log("\n✓ soglie rispettate");
' "$ROWS" "$LABEL" "$VERSION" "$CPU"
