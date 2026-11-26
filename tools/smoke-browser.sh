#!/usr/bin/env bash
# Verifica di BoatRadar nel browser con agent-browser (https://github.com/vercel-labs/agent-browser, Apache-2.0).
# Avvia server.js con i messaggi di test (tools/smoke-server.js, senza chiave né rete), apre la pagina
# a larghezza desktop (1280×800) e telefono (390×844) e controlla che:
#   1. compaiano le navi;
#   2. un clic del mouse su una nave apra la scheda con il suo MMSI, e un clic vero sulla × (almeno 44×44 px)
#      o Esc la chiudano, lasciando il focus su un elemento visibile;
#   3. la pagina non abbia errori JavaScript né messaggi console.error;
#   4. (solo con il server locale) con l'orologio della pagina e serverTime 40 min avanti le navi in moto spariscano e
#      quella ormeggiata della fixture resti tratteggiata, con il pallino rosso e «posizione di 40 min fa» in scheda;
#   5. (solo con il server locale, punto 86) con due server in window.BOATRADAR_APIS, il primo morto (127.0.0.1:9) e il
#      secondo quello di prova, la pagina passi al secondo dopo due tentativi al primo (3 s fra i due): navi in mappa e
#      «server di riserva (Render)» nella riga di stato, a desktop e telefono; con il primo buono resti sul primo senza
#      chiedere nulla al secondo;
#   6. (solo con il server locale, punto 86) sul secondo server, prima di 5 min nessuna prova del primo; con il primo
#      tornato e l'orologio della pagina (e serverTime) 5 min avanti, una prova del primo con la stessa vista e, dal giro
#      dopo, ritorno al primo: niente «server di riserva» e sessionStorage aggiornato, a desktop e telefono.
# Esce con 0 se tutto va bene, con 1 al primo controllo fallito. Screenshot in diagnosi/smoke/.
#
#   bash tools/smoke-browser.sh                 # server locale con la fixture di esempio
#   SMOKE_URL=https://.../ bash tools/smoke-browser.sh   # pagina già pubblicata (nessun server locale)
#
# Variabili: SMOKE_PORT (8799), SMOKE_FIXTURE, SMOKE_URL, SMOKE_APIS (JSON di window.BOATRADAR_APIS per il controllo 5:
# primo server morto, secondo buono; di solito non serve), SMOKE_LEAFLET_LOCAL=1 per caricare Leaflet dal
# registro npm quando unpkg.com non è raggiungibile (ambienti con rete limitata), AGENT_BROWSER_EXECUTABLE_PATH
# per usare un Chrome già installato invece di quello scaricato da «agent-browser install».
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION="boatradar-smoke-$$"
AB=(agent-browser --session "$SESSION")
INIT=()   # init script comuni (Leaflet locale) anche per il passaggio con l'orologio avanti
PORT="${SMOKE_PORT:-8799}"
OUT="diagnosi/smoke"
mkdir -p "$OUT"
SERVER_PID=""
TMP="$(mktemp -d)"

cleanup() {
  agent-browser --session "$SESSION" close >/dev/null 2>&1 || true
  agent-browser --session "$SESSION-40min" close >/dev/null 2>&1 || true
  for s in riserva-desktop riserva-telefono primo-buono ritorno-desktop ritorno-telefono; do agent-browser --session "$SESSION-$s" close >/dev/null 2>&1 || true; done
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
  INIT+=(--init-script "$TMP/leaflet-init.js")
  AB+=("${INIT[@]}")
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

  # × della scheda: almeno 44×44 px, raggiungibile con un clic vero anche con una riga di stato lunga
  # (l'header non deve coprirla), e dopo la chiusura il focus resta su un elemento visibile
  local size
  size=$(js "(() => { const r = document.getElementById('close').getBoundingClientRect();
    return Math.round(r.width) + 'x' + Math.round(r.height); })()" | tr -d '"')
  [ "${size%x*}" -ge 44 ] && [ "${size#*x}" -ge 44 ] || fail "$name: la × è $size px, meno di 44×44"
  local close
  close=$(js "(() => { const r = document.getElementById('close').getBoundingClientRect();
    return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2); })()" | tr -d '"')
  local hit
  hit=$(js "(() => { const [x, y] = '$close'.split(' ').map(Number), e = document.elementFromPoint(x, y);
    return e ? (e.id || e.tagName) + (e.closest('header') ? ' (header)' : '') : 'niente'; })()" | tr -d '"')
  [ "$hit" = close ] || { "${AB[@]}" screenshot "$OUT/$name-chiudi-errore.png" >/dev/null || true
    fail "$name: sopra la × ($close) c'è $hit · stato: $(js "document.getElementById('status').textContent") (screenshot in $OUT/)"; }
  "${AB[@]}" mouse move $close >/dev/null
  "${AB[@]}" mouse down >/dev/null
  "${AB[@]}" mouse up >/dev/null
  # scheda chiusa dalla ×, non nascosta dal passaggio alla mappa VesselFinder (body.vf)
  "${AB[@]}" wait --fn "document.getElementById('panel').style.display === 'none' && !document.body.classList.contains('vf')" >/dev/null \
    || { "${AB[@]}" screenshot "$OUT/$name-chiudi-errore.png" >/dev/null || true
         fail "$name: il clic sulla × ($close) non chiude la scheda: sotto il puntatore c'è $hit · stato: $(js "document.getElementById('status').textContent") (screenshot in $OUT/)"; }
  local focus
  focus=$(js "(() => { const a = document.activeElement;
    return a && a !== document.body && a.getClientRects().length > 0 ? (a.id || a.tagName) : ''; })()" | tr -d '"')
  [ -n "$focus" ] || fail "$name: dopo la × il focus non è su un elemento visibile"
  ok "$name: la × ($size px) si chiude con un clic vero, focus su #$focus · stato: $(js "document.getElementById('status').textContent.length") caratteri"

  # Esc chiude la scheda
  "${AB[@]}" mouse move $point >/dev/null
  "${AB[@]}" mouse down >/dev/null
  "${AB[@]}" mouse up >/dev/null
  "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none'" >/dev/null \
    || fail "$name: la scheda non si riapre con un secondo clic sulla nave"
  "${AB[@]}" press Escape >/dev/null
  "${AB[@]}" wait --fn "document.getElementById('panel').style.display === 'none'" >/dev/null \
    || fail "$name: Esc non chiude la scheda"
  ok "$name: Esc chiude la scheda"

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

# --- orologio 40 min avanti (punto 8) --------------------------------------
# Un init script sposta avanti di 40 min l'ora della pagina (Date) e serverTime di /api/status, come se le posizioni
# ricevute fossero di 40 min fa: le navi in moto (limite 30 min) spariscono, quella ormeggiata della fixture
# (NORDIC TRADER, 538001234, conservata 6 h) resta, tratteggiata, con il pallino rosso e l'età in scheda.
# Solo con il server locale: sulla pagina pubblicata le navi e i loro stati non sono noti in anticipo.
if [ -z "${SMOKE_URL:-}" ]; then
  cat > "$TMP/orologio-40.js" <<'JS'
(function () {
  if (window.top !== window) return;
  var OFF = 40 * 60 * 1000, RealDate = Date, realNow = RealDate.now.bind(RealDate);
  function ShiftedDate() {
    var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof ShiftedDate)) return new RealDate(realNow() + OFF).toString();
    return a.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(a)))() : new RealDate(realNow() + OFF);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = function () { return realNow() + OFF; };
  ShiftedDate.parse = RealDate.parse; ShiftedDate.UTC = RealDate.UTC;
  window.Date = ShiftedDate;
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = String(input && input.url || input);
    return realFetch(input, init).then(function (res) {
      if (!/\/api\/status/.test(url)) return res;
      return res.clone().json().then(function (j) {
        if (typeof j.serverTime === 'number') j.serverTime += OFF;
        return new Response(JSON.stringify(j), { status: res.status, headers: { 'Content-Type': 'application/json' } });
      });
    });
  };
})();
JS
  AB=(agent-browser --session "$SESSION-40min" "${INIT[@]}" --init-script "$TMP/orologio-40.js")
  STILL=538001234 MOVING=247123450
  "${AB[@]}" set viewport 1280 800 >/dev/null
  "${AB[@]}" open "$URL" >/dev/null || fail "40 min: la pagina non si apre"
  "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.has($STILL)" >/dev/null \
    || fail "40 min: la nave ormeggiata $STILL non è in mappa · stato: $(js "document.getElementById('status')?.textContent")"
  [ "$(js "markers.has($MOVING)")" = false ] || fail "40 min: la nave in moto $MOVING è ancora in mappa"
  dash=$(js "markers.get($STILL).marker.options.dashArray" | tr -d '"')
  [ "$dash" = "3 2" ] || fail "40 min: la nave ormeggiata non è tratteggiata (dashArray $dash)"
  tip=$(js "tooltipText($STILL)" | tr -d '"')
  case "$tip" in *"posizione di 40 min fa"*) ;; *) fail "40 min: tooltip «$tip»" ;; esac
  ok "40 min: in moto tolta, ormeggiata tratteggiata (dashArray $dash) · tooltip «$tip»"
  js "map.setView(markers.get($STILL).marker.getLatLng(), 12, { animate: false }), true" >/dev/null
  "${AB[@]}" wait 300 >/dev/null
  point=$(js "(() => { const r = document.getElementById('map').getBoundingClientRect();
    const p = map.latLngToContainerPoint(markers.get($STILL).marker.getLatLng());
    return Math.round(r.left + p.x) + ' ' + Math.round(r.top + p.y); })()" | tr -d '"')
  "${AB[@]}" mouse move $point >/dev/null
  "${AB[@]}" mouse down >/dev/null
  "${AB[@]}" mouse up >/dev/null
  "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none'
    && document.getElementById('content').textContent.includes('$STILL')" >/dev/null \
    || { "${AB[@]}" screenshot "$OUT/40min-errore.png" >/dev/null || true; fail "40 min: il clic sulla nave ormeggiata non apre la scheda"; }
  row=$(js "(() => { const tr = [...document.querySelectorAll('#content tr')].find(t => t.cells[0]?.textContent === 'Ultimo segnale');
    return tr ? (tr.querySelector('.age')?.className || 'senza pallino') + ' | ' + tr.cells[1].textContent : 'riga assente'; })()" | tr -d '"')
  case "$row" in "age age-rosso | posizione di 40 min fa ("*) ;; *) "${AB[@]}" screenshot "$OUT/40min-errore.png" >/dev/null || true
    fail "40 min: riga «Ultimo segnale»: $row" ;; esac
  ok "40 min: scheda «$row»"
  "${AB[@]}" screenshot "$OUT/40min.png" >/dev/null
  problems=$( { "${AB[@]}" errors --json; echo; "${AB[@]}" console --json; } | node -e '
    const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    const out = [];
    for (const e of lines[0].data.errors || []) out.push("errore JS: " + (e.text || e.message || JSON.stringify(e)).split("\n")[0]);
    for (const m of lines[1].data.messages || []) if (m.type === "error") out.push("console.error: " + String(m.text).split("\n")[0]);
    process.stdout.write(out.join("\n"));')
  [ -z "$problems" ] || fail "40 min: $problems"
  ok "40 min: nessun errore JavaScript"
fi

# --- server di riserva (punto 86) ------------------------------------------
# Un init script scrive window.BOATRADAR_APIS come config.js di Pages (in locale server.js serve config.js vuoto),
# svuota sessionStorage (scheda nuova) e annota le richieste. Il primo server è 127.0.0.1:9, dove non risponde nessuno
# (Chrome lo rifiuta subito), il secondo è il server di prova. Gli errori di rete verso 127.0.0.1:9 sono attesi.
if [ -z "${SMOKE_URL:-}" ]; then
  DEAD_API="http://127.0.0.1:9/api" GOOD_API="http://127.0.0.1:$PORT/api"
  apis_init() {   # $1 = file, $2 = JSON dei server
    node -e '
      const [file, apis] = process.argv.slice(1);
      JSON.parse(apis);   // JSON non valido: errore subito, non nella pagina
      require("fs").writeFileSync(file, "(function(){if(window.top!==window)return;window.BOATRADAR_APIS=" + apis + ";" +
        "try{sessionStorage.removeItem(\"boatradar:api\")}catch(e){}" +
        "var f=window.fetch;window.__smokeFetched=[];window.fetch=function(i){window.__smokeFetched.push(String(i&&i.url||i));" +
        "return f.apply(this,arguments)};})();");
    ' "$1" "$2" || fail "SMOKE_APIS non è JSON valido: $2"
  }
  # errori JavaScript e console.error, tranne le richieste fallite verso il server morto
  page_problems() {
    { "${AB[@]}" errors --json; echo; "${AB[@]}" console --json; } | node -e '
      const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
      const expected = t => /127\.0\.0\.1:9\b|ERR_UNSAFE_PORT|ERR_CONNECTION_REFUSED|Failed to load resource/.test(t);
      const out = [];
      for (const e of lines[0].data.errors || []) out.push("errore JS: " + (e.text || e.message || JSON.stringify(e)).split("\n")[0]);
      for (const m of lines[1].data.messages || []) if (m.type === "error" && !expected(String(m.text))) out.push("console.error: " + String(m.text).split("\n")[0]);
      process.stdout.write(out.join("\n"));'
  }
  DEFAULT_APIS="[{\"url\":\"$DEAD_API\",\"name\":\"VM Oracle\",\"sleeps\":false},{\"url\":\"$GOOD_API\",\"name\":\"Render\",\"sleeps\":true}]"
  apis_init "$TMP/riserva.js" "${SMOKE_APIS:-$DEFAULT_APIS}"
  for size in "desktop 1280 800" "telefono 390 844"; do
    set -- $size
    AB=(agent-browser --session "$SESSION-riserva-$1" "${INIT[@]}" --init-script "$TMP/riserva.js")
    "${AB[@]}" set viewport "$2" "$3" >/dev/null
    "${AB[@]}" open "$URL" >/dev/null || fail "riserva $1: la pagina non si apre"
    "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 0
      && / · server di riserva \(Render\)$/.test(document.getElementById('status').textContent)" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/riserva-$1-errore.png" >/dev/null || true
           fail "riserva $1: niente navi dal secondo server · stato: $(js "document.getElementById('status')?.textContent")"; }
    tried=$(js "window.__smokeFetched.filter(u => u.startsWith('$DEAD_API/locations?bbox=')).length")
    [ "$tried" = 2 ] || fail "riserva $1: la pagina ha provato $tried volte il server morto prima di passare (attese 2)"
    saved=$(js "sessionStorage.getItem('boatradar:api')" | tr -d '"')
    [ "$saved" = "$GOOD_API" ] || fail "riserva $1: sessionStorage ricorda «$saved», non $GOOD_API"
    ok "riserva $1: $(js "markers.size") navi dal secondo server · stato «$(js "document.getElementById('status').textContent" | tr -d '"')»"
    "${AB[@]}" screenshot "$OUT/riserva-$1.png" >/dev/null
    problems=$(page_problems)
    [ -z "$problems" ] || fail "riserva $1: $problems"
    ok "riserva $1: nessun errore JavaScript (a parte le richieste al server morto)"
  done

  # primo server buono: resta sul primo, al secondo (qui morto) non arriva nessuna richiesta, neanche al giro dopo
  apis_init "$TMP/primo-buono.js" "[{\"url\":\"$GOOD_API\",\"name\":\"VM Oracle\",\"sleeps\":false},{\"url\":\"$DEAD_API\",\"name\":\"Render\",\"sleeps\":true}]"
  AB=(agent-browser --session "$SESSION-primo-buono" "${INIT[@]}" --init-script "$TMP/primo-buono.js")
  "${AB[@]}" set viewport 1280 800 >/dev/null
  "${AB[@]}" open "$URL" >/dev/null || fail "primo buono: la pagina non si apre"
  "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 0" >/dev/null \
    || fail "primo buono: nessuna nave · stato: $(js "document.getElementById('status')?.textContent")"
  js "tick().then(() => true)" >/dev/null
  status=$(js "document.getElementById('status').textContent" | tr -d '"')
  case "$status" in *riserva*) fail "primo buono: la riga di stato parla del server di riserva: «$status»" ;; esac
  second=$(js "window.__smokeFetched.filter(u => u.startsWith('$DEAD_API')).length")
  [ "$second" = 0 ] || fail "primo buono: $second richieste al secondo server"
  ok "primo buono: resta sul primo, nessuna richiesta al secondo · stato «$status»"
  problems=$(page_problems)
  [ -z "$problems" ] || fail "primo buono: $problems"

  # ritorno al primo dopo 5 min (PRIMARY_RECHECK_MS): il primo «torna» quando window.__smokePrimaryUp è vero (le sue
  # richieste vanno allora al server di prova, ma la pagina vede sempre il suo indirizzo); window.__smokeShift sposta
  # avanti l'ora della pagina e serverTime di /api/status, così l'orologio corretto della pagina va avanti di tanto.
  cat > "$TMP/ritorno.js" <<JS
(function () {
  if (window.top !== window) return;
  window.BOATRADAR_APIS = [{"url":"$DEAD_API","name":"VM Oracle","sleeps":false},{"url":"$GOOD_API","name":"Render","sleeps":true}];
  try { sessionStorage.removeItem('boatradar:api'); } catch (e) {}
  window.__smokeShift = 0; window.__smokePrimaryUp = false; window.__smokeFetched = [];
  var RealDate = Date, realNow = RealDate.now.bind(RealDate);
  function ShiftedDate() {
    var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof ShiftedDate)) return new RealDate(realNow() + window.__smokeShift).toString();
    return a.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(a)))() : new RealDate(realNow() + window.__smokeShift);
  }
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = function () { return realNow() + window.__smokeShift; };
  ShiftedDate.parse = RealDate.parse; ShiftedDate.UTC = RealDate.UTC;
  window.Date = ShiftedDate;
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = String(input && input.url || input);
    window.__smokeFetched.push(url);
    if (window.__smokePrimaryUp && url.indexOf('$DEAD_API') === 0) input = '$GOOD_API' + url.slice('$DEAD_API'.length);
    return realFetch(input, init).then(function (res) {
      if (!/\/api\/status/.test(url) || !res.ok) return res;
      return res.clone().json().then(function (j) {
        if (typeof j.serverTime === 'number') j.serverTime += window.__smokeShift;
        return new Response(JSON.stringify(j), { status: res.status, headers: { 'Content-Type': 'application/json' } });
      });
    });
  };
})();
JS
  for size in "desktop 1280 800" "telefono 390 844"; do
    set -- $size
    AB=(agent-browser --session "$SESSION-ritorno-$1" "${INIT[@]}" --init-script "$TMP/ritorno.js")
    "${AB[@]}" set viewport "$2" "$3" >/dev/null
    "${AB[@]}" open "$URL" >/dev/null || fail "ritorno $1: la pagina non si apre"
    "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 0
      && / · server di riserva \(Render\)$/.test(document.getElementById('status').textContent)" >/dev/null \
      || fail "ritorno $1: la pagina non passa al secondo · stato: $(js "document.getElementById('status')?.textContent")"
    # il primo torna, ma prima di 5 min la pagina non lo prova (le viste al primo restano i due tentativi iniziali)
    dead_views="window.__smokeFetched.filter(u => u.startsWith('$DEAD_API/locations?bbox=')).length"
    js "window.__smokePrimaryUp = true" >/dev/null
    js "tick().then(() => tick()).then(() => true)" >/dev/null
    early=$(js "$dead_views")
    [ "$early" = 2 ] || fail "ritorno $1: $early viste chieste al primo prima di 5 min (attese 2, i tentativi iniziali)"
    # 5 min e 5 s dopo: il giro successivo fa la prova (la stessa vista), quello dopo ancora torna al primo
    js "window.__smokeShift = 305000" >/dev/null
    js "tick().then(() => true)" >/dev/null
    "${AB[@]}" wait --fn "sessionStorage.getItem('boatradar:api') === '$DEAD_API'" >/dev/null \
      || fail "ritorno $1: dopo la prova il primo non è ricordato · viste al primo $(js "$dead_views")"
    js "tick().then(() => true)" >/dev/null
    "${AB[@]}" wait --fn "markers.size > 0 && !/riserva/.test(document.getElementById('status').textContent)" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/ritorno-$1-errore.png" >/dev/null || true
           fail "ritorno $1: ancora sul secondo · stato: $(js "document.getElementById('status').textContent")"; }
    views=$(js "$dead_views")
    [ "$views" -ge 4 ] || fail "ritorno $1: prova e vista del giro dopo non chieste al primo ($views viste, attese almeno 4)"
    ok "ritorno $1: dopo 5 min una prova e il ritorno al primo · $(js "markers.size") navi · stato «$(js "document.getElementById('status').textContent" | tr -d '"')»"
    "${AB[@]}" screenshot "$OUT/ritorno-$1.png" >/dev/null
    problems=$(page_problems)
    [ -z "$problems" ] || fail "ritorno $1: $problems"
  done
fi
echo "Verifica nel browser riuscita · screenshot in $OUT/"
