#!/usr/bin/env bash
# Misura della pagina nel browser (punti 13, 63, 42): quanto costa il movimento fluido con molte navi.
# Avvia server.js con le navi sintetiche di tools/carico.js (tools/smoke-server.js --navi, che le fa avanzare coerenti
# con velocità e rotta), apre boatradar.html con agent-browser a 1280×800 e, per ogni scenario, misura quattro volte in
# ordine alternato (animazione spenta, accesa, accesa, spenta) per MISURA_SECONDI secondi: fotogrammi al secondo
# (requestAnimationFrame della misura), ridisegni del canvas divisi per causa (dati arrivati, animatore, altri) con
# p50/p95/max, long task oltre 50 ms fuori dalle finestre dei dati (segni 'boatradar:load-start'/'boatradar:load-end'
# di loadLocations e risposte di /api/locations e del Baltico), fotogrammi e risvegli del ciclo dell'animatore, passi e
# setLatLng (anim.stats), e il tempo di loadLocations per aggiornare i marker (5 giri per misura, 10 per stato).
# Ogni riga è la mediana delle due misure dello stesso stato. Scenari: mondo a zoom 3 (6000 marker, il campione del
# server), Rotterdam a zoom 9 e a zoom 13.
#
#   bash tools/misura-pagina.sh                          # stampa la tabella e controlla le soglie
#   bash tools/misura-pagina.sh --registra "dopo punto 13"   # e aggiunge le righe a docs/prestazioni.md («Pagina»)
#
# Soglie (docs/prestazioni.md, «Pagina», con il perché): fps ≥ 55 (con MISURA_CPU: ≥ 30 a zoom 13); con l'animazione
# accesa, ridisegni causati dall'animatore: mondo ≤ 2/s e p95 ≤ 12 ms, zoom 13 p95 ≤ 6 ms (p95 con almeno 20 campioni,
# altrimenti il massimo); nessun long task > 50 ms fuori dai dati; loadLocations (mediana di 10 giri) accesa al massimo
# 2 ms più che spenta, più metà della somma degli scarti interquartili dei due gruppi.
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

# misura di MISURA_SECONDI secondi nella pagina (JSON). I ridisegni del canvas sono divisi per causa con i contatori
# della pagina letti a ogni ridisegno: «dati» se nel frattempo loadLocations ha aggiornato i marker (anim.stats.loads),
# «animatore» se l'animatore ha spostato marker (anim.stats.moved + pickMoved), altrimenti «altri». I long task contano
# solo fuori dalle finestre dei dati: dalla prima risposta di /api/locations o del Baltico del giro (o 50 ms prima
# dell'inizio di loadLocations, segno 'boatradar:load-start') a 250 ms dopo la sua fine ('boatradar:load-end', misura
# 'boatradar:load'), cioè lettura del JSON, aggiornamento dei marker e il ridisegno che segue.
MEASURE="new Promise(done => {
  const SEC = $SECS, st = anim.stats, s0 = { steps: st.steps, moved: st.moved, frames: st.frames, wakes: st.wakes },
    longs = [], resp = [], loads = [], red = { dati: [], animatore: [], altri: [] }, steps = [];
  const lt = new PerformanceObserver(l => { for (const e of l.getEntries()) longs.push({ at: e.startTime, end: e.startTime + e.duration, ms: e.duration }); });
  try { lt.observe({ type: 'longtask', buffered: false }); } catch { /* browser senza long task */ }
  const rs = new PerformanceObserver(l => { for (const e of l.getEntries()) if (/\\/api\\/locations|digitraffic/.test(e.name)) resp.push(e.responseEnd); });
  rs.observe({ type: 'resource', buffered: false });
  const ms = new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'boatradar:load') loads.push({ start: e.startTime, end: e.startTime + e.duration }); });
  ms.observe({ type: 'measure', buffered: false });
  const orig = renderer._redraw;
  let seenLoads = st.loads, seenMoves = st.moved + st.pickMoved;
  renderer._redraw = function (...a) {
    const cause = st.loads !== seenLoads ? 'dati' : st.moved + st.pickMoved !== seenMoves ? 'animatore' : 'altri';
    seenLoads = st.loads; seenMoves = st.moved + st.pickMoved;
    const t = performance.now();
    try { return orig.apply(this, a); } finally { red[cause].push(performance.now() - t); }
  };
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
    lt.disconnect(); rs.disconnect(); ms.disconnect(); renderer._redraw = orig;
    const windows = loads.map(w => { const before = resp.filter(r => r <= w.start && r >= w.start - 5000);
      return [Math.min(w.start - 50, ...before) , w.end + 250]; });
    const outside = longs.filter(l => l.ms > 50 && !windows.some(([a, b]) => l.end >= a && l.at <= b));
    done({ markers: markers.size, animated: anim.enabled ? anim.set.size : 0, candidates: anim.enabled ? st.candidates : 0,
      secs: r2(secs), fps: r1(frames / secs), red: { dati: red.dati.map(r2), animatore: red.animatore.map(r2), altri: red.altri.map(r2) },
      longOutside: outside.map(l => r1(l.ms)), longAll: longs.filter(l => l.ms > 50).map(l => r1(l.ms)), loads: loads.length, arrivals: resp.length,
      steps: st.steps - s0.steps, moves: st.moved - s0.moved, animFrames: st.frames - s0.frames, wakes: st.wakes - s0.wakes,
      stepP95: r2(pct(steps, 0.95)), pickMs: r2(st.pickMs), interval: Math.round(anim.interval) });
  }
  requestAnimationFrame(loop);
})"

RUNS="$TMP/runs.jsonl"
: > "$RUNS"
# Una misura: vista, interruttore, cinque giri per loadLocations (dati di questa vista, i 5 tempi), 3,5 s per la scelta
# delle navi animate, poi MISURA_SECONDI secondi
run() {   # nome, lat, lon, zoom, acceso (true/false)
  local name="$1" lat="$2" lon="$3" zoom="$4" on="$5"
  js "map.setView([$lat, $lon], $zoom, { animate: false }), true" >/dev/null
  [ "$(js "document.getElementById('smooth').checked")" = "$on" ] || js "(document.getElementById('smooth').click(), true)" >/dev/null
  [ "$(js "anim.enabled")" = "$on" ] || fail "$name: interruttore del movimento non a $on"
  local load res
  load=$(js "(async () => { const t = []; for (let i = 0; i < 5; i++) { await tick(); t.push(Math.round(anim.stats.loadMs * 100) / 100); } return t; })()")
  "${AB[@]}" wait 3500 >/dev/null
  res=$(js "$MEASURE")
  node -e 'const [n, on, load, r] = process.argv.slice(1); console.log(JSON.stringify({ scenario: n, anim: on === "true", loadMs: JSON.parse(load), ...JSON.parse(r) }));' \
    "$name" "$on" "$load" "$res" >> "$RUNS"
  echo "✓ $name, animazione $([ "$on" = true ] && echo accesa || echo spenta): $(node -e '
    const r = JSON.parse(process.argv[1]); console.log(`${r.fps} fps, ridisegni dati/animatore/altri ${r.red.dati.length}/${r.red.animatore.length}/${r.red.altri.length}, ` +
      `long task fuori dai dati ${r.longOutside.length}, fotogrammi del ciclo ${r.animFrames}, risvegli ${r.wakes}`);' "$res") · loadLocations $load ms"
}
# ordine alternato (spenta, accesa, accesa, spenta): la deriva della macchina durante la misura pesa uguale sui due casi
scenario() { local on; for on in false true true false; do run "$@" "$on"; done; }
scenario "mondo z3" 30 10 3
scenario "Rotterdam z9" 51.95 4.05 9
scenario "Rotterdam z13" 51.95 4.05 13

VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo '?')$(git diff --quiet 2>/dev/null || echo '+modifiche')"
node -e '
  const fs = require("fs"), [file, label, version, cpu] = process.argv.slice(1);
  const runs = fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const med = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const iqr = a => pct(a, 0.75) - pct(a, 0.25);
  const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
  // una riga per scenario e stato: mediane delle due misure, campioni dei ridisegni e dei long task uniti
  const rows = [];
  for (const r of runs) {
    if (rows.some(x => x.scenario === r.scenario && x.anim === r.anim)) continue;
    const g = runs.filter(x => x.scenario === r.scenario && x.anim === r.anim), secs = g.reduce((t, x) => t + x.secs, 0);
    const all = k => g.flatMap(x => x.red[k]), loadMs = g.flatMap(x => x.loadMs);
    rows.push({ scenario: r.scenario, anim: r.anim, n: g.length, markers: med(g.map(x => x.markers)), animated: med(g.map(x => x.animated)),
      candidates: med(g.map(x => x.candidates)), fps: r1(med(g.map(x => x.fps))),
      dati: all("dati"), animatore: all("animatore"), altri: all("altri"), secs,
      longOutside: g.flatMap(x => x.longOutside), longAll: g.flatMap(x => x.longAll), arrivals: g.reduce((t, x) => t + x.arrivals, 0),
      stepsPerS: r1(g.reduce((t, x) => t + x.steps, 0) / secs), movesPerS: r1(g.reduce((t, x) => t + x.moves, 0) / secs),
      framesPerS: r1(g.reduce((t, x) => t + x.animFrames, 0) / secs), wakesPerS: r1(g.reduce((t, x) => t + x.wakes, 0) / secs),
      stepP95: r2(med(g.map(x => x.stepP95))), pickMs: r2(med(g.map(x => x.pickMs))),
      loadMs: r2(med(loadMs)), loadIqr: r2(iqr(loadMs)), loadN: loadMs.length });
  }
  const bad = [];
  const MIN_SAMPLES = 20;
  for (const r of rows) {
    const k = `${r.scenario} (animazione ${r.anim ? "accesa" : "spenta"})`;
    // con la CPU rallentata vale solo fps ≥ 30 a zoom 13; il resto è in tabella per confronto
    if (cpu) { if (/z13/.test(r.scenario) && r.fps < 30) bad.push(`${k}: ${r.fps} fps < 30 con la CPU ${cpu}× più lenta`); continue; }
    if (r.fps < 55) bad.push(`${k}: ${r.fps} fps < 55`);
    // ridisegni causati dall animatore (spenta non ce ne sono): quanti al secondo e quanto durano. Il p95 con almeno
    // MIN_SAMPLES campioni; con meno il massimo (più severo); nessuno = nessun costo
    if (r.anim) {
      const a = r.animatore, perS = a.length / r.secs, lim = /mondo/.test(r.scenario) ? 12 : /z13/.test(r.scenario) ? 6 : null;
      if (/mondo/.test(r.scenario) && perS > 2) bad.push(`${k}: ${r1(perS)} ridisegni/s dell animatore > 2`);
      if (lim != null && a.length) {
        const v = a.length >= MIN_SAMPLES ? pct(a, 0.95) : Math.max(...a), what = a.length >= MIN_SAMPLES ? "p95" : `massimo (${a.length} campioni)`;
        if (v > lim) bad.push(`${k}: ridisegno dell animatore ${what} ${v} ms > ${lim}`);
      }
    }
    if (r.longOutside.length) bad.push(`${k}: ${r.longOutside.length} long task > 50 ms fuori dai dati (max ${Math.max(...r.longOutside)} ms)`);
  }
  // loadLocations: accesa al massimo 2 ms più che spenta, più il rumore misurato (metà della somma degli scarti
  // interquartili dei due gruppi di 10 giri): una differenza dentro lo scarto fra i giri non è un costo dell animazione
  for (const r of rows.filter(x => x.anim && !cpu)) {
    const off = rows.find(x => !x.anim && x.scenario === r.scenario);
    if (!off) continue;
    const lim = 2 + (r.loadIqr + off.loadIqr) / 2;
    if (r.loadMs > off.loadMs + lim) bad.push(`${r.scenario}: loadLocations ${r.loadMs} ms acceso contro ${off.loadMs} spento (+${(r.loadMs - off.loadMs).toFixed(2)} > ${lim.toFixed(2)} ms)`);
  }
  const day = new Date().toISOString().slice(0, 10), ver = label ? `${label} (${version})` : version;
  const fmtRed = (a, secs) => `${r1(a.length / secs)}`;
  const lines = rows.map(r => `| ${day} | ${ver}${cpu ? ` · CPU ${cpu}×` : ""} | ${r.scenario} | ${r.anim ? "accesa" : "spenta"} | ${r.markers} | ${r.animated} / ${r.candidates} | ` +
    `${r.fps} | ${fmtRed(r.dati, r.secs)} · ${fmtRed(r.animatore, r.secs)} · ${fmtRed(r.altri, r.secs)} | ` +
    `${r.animatore.length ? `${r2(pct(r.animatore, 0.5))} / ${r2(pct(r.animatore, 0.95))} / ${r2(Math.max(...r.animatore))} (${r.animatore.length})` : "– (0)"} | ` +
    `${r.dati.length ? r2(pct(r.dati, 0.95)) : "–"} | ${r.longOutside.length} (max ${Math.max(0, ...r.longOutside)}) · ${r.longAll.length} (max ${Math.max(0, ...r.longAll)}), ${r.arrivals} risposte | ` +
    `${r.framesPerS} / ${r.wakesPerS} | ${r.stepsPerS} / ${r.movesPerS} | ${r.stepP95} | ${r.pickMs} | ${r.loadMs} (IQR ${r.loadIqr}, ${r.loadN} giri) |`);
  console.log("\n| Data | Versione | Scenario | Animazione | Marker | Animate / in moto | fps | Ridisegni/s: dati · animatore · altri | Ridisegno animatore p50 / p95 / max ms (campioni) | Ridisegno dati p95 ms | Long task > 50 ms fuori dai dati (max ms) · in tutto, risposte | Fotogrammi / risvegli del ciclo al s | Passi/s / setLatLng/s | Passo p95 ms | Scelta ms | loadLocations ms |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  console.log(lines.join("\n"));
  if (label) {
    const doc = "docs/prestazioni.md", marker = "<!-- nuove righe della pagina (misura alternata) sopra questa linea -->", text = fs.readFileSync(doc, "utf8");
    if (!text.includes(marker)) { console.error(`manca la riga «${marker}» in ${doc}`); process.exit(1); }
    fs.writeFileSync(doc, text.replace(marker, lines.join("\n") + "\n" + marker));
    console.log(`\nRighe aggiunte a ${doc}`);
  }
  if (bad.length) { console.log("\n✗ soglie non rispettate:\n  " + bad.join("\n  ")); process.exit(1); }
  console.log("\n✓ soglie rispettate");
' "$RUNS" "$LABEL" "$VERSION" "$CPU"
