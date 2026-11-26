#!/usr/bin/env bash
# Verifica di BoatRadar nel browser con agent-browser (https://github.com/vercel-labs/agent-browser, Apache-2.0).
# Avvia server.js con i messaggi di test (tools/smoke-server.js, senza chiave né rete), apre la pagina
# a larghezza desktop (1280×800) e telefono (390×844) e controlla che:
#   1. compaiano le navi;
#   2. un clic del mouse su una nave apra la scheda con il suo MMSI, e un clic vero sulla × (almeno 44×44 px)
#      o Esc la chiudano, lasciando il focus su un elemento visibile;
#   3. (punto 10) un clic vero sulle due navi sovrapposte della fixture (GEMELLA, 247555001 e 247555002, a 10 m a
#      Genova) apra il popup «2 navi qui» con due righe e la × da almeno 44 px e il focus sulla prima, Esc lo chiuda, e un clic
#      vero sulla seconda riga apra la scheda di 247555002; la nave isolata del punto 2 apre la scheda senza popup; poi,
#      con la scheda aperta, 30 navi finte nello stesso punto: popup con 15 righe e «e altre 15» fra l'header e la
#      scheda (o il fondo della mappa), ogni riga raggiungibile scorrendo, × «Chiudi elenco», zoom «Ingrandisci»/«Riduci»,
#      e un clic vero su «e altre 15» che chiude il popup e ingrandisce di 2;
#   3a. (solo con il server locale, punto 9) un clic vero su «Cargo» nella legenda (aperta con un clic vero sul suo
#      titolo se chiusa, come su telefono; riga da almeno 44 px a 390) tolga il cargo LAGUNA PRIMA (247123450) e salvi il
#      filtro in localStorage; ricaricando la pagina il filtro resti (Cargo spento, nave assente, «filtri attivi»); un
#      secondo clic la riporti e svuoti localStorage. Prima della passata telefono localStorage si svuota;
#   3a bis. (solo con il server locale, punto 12) la ricerca «GEMELLA» scritta con tasti veri dia 2 righe con «2 navi con
#      questo nome» (almeno 44 px su telefono, nome accessibile = solo il nome), «2 risultati» nella regione aria-live
#      nascosta, freccia giù + Invio apra la scheda della prima e Esc la chiuda;
#   3b. la pagina non abbia errori JavaScript né messaggi console.error;
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

# Clic vero del mouse nel punto x y della pagina
click_at() { "${AB[@]}" mouse move "$1" "$2" >/dev/null; "${AB[@]}" mouse down >/dev/null; "${AB[@]}" mouse up >/dev/null; }

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
  [ "$(js "!document.querySelector('.leaflet-popup.pick')")" = true ] || fail "$name: il clic sulla nave $mmsi apre il popup di scelta invece della scheda"
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

  # navi sovrapposte (punto 10): le due GEMELLA della fixture, a 10 m l'una dall'altra (meno di 1 px a zoom 12) a Genova;
  # dopo lo zoom su Venezia sono fuori dalla vista, quindi prima la mappa va su di loro. Solo con il server locale.
  if [ -z "${SMOKE_URL:-}" ]; then
    js "map.setView([44.42, 8.9], 12, { animate: false }), true" >/dev/null
    "${AB[@]}" wait --fn "markers.has(247555001) && markers.has(247555002)" >/dev/null \
      || fail "$name: le navi sovrapposte della fixture (247555001, 247555002) non sono in mappa · stato: $(js "document.getElementById('status').textContent")"
    "${AB[@]}" wait 300 >/dev/null
    local twin
    twin=$(js "(() => { const r = document.getElementById('map').getBoundingClientRect();
      const p = map.latLngToContainerPoint(markers.get(247555001).marker.getLatLng());
      return Math.round(r.left + p.x) + ' ' + Math.round(r.top + p.y); })()" | tr -d '"')
    "${AB[@]}" mouse move $twin >/dev/null
    "${AB[@]}" mouse down >/dev/null
    "${AB[@]}" mouse up >/dev/null
    "${AB[@]}" wait --fn "document.querySelectorAll('.leaflet-popup.pick .pickrow').length === 2" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/$name-sovrapposte-errore.png" >/dev/null || true
           fail "$name: il clic sulle navi sovrapposte ($twin) non apre il popup con 2 righe · righe: $(js "document.querySelectorAll('.pickrow').length") · scheda: $(js "document.getElementById('panel').style.display")"; }
    "${AB[@]}" wait 500 >/dev/null   # fine dell'autoPan del popup
    local rows
    rows=$(js "[...document.querySelectorAll('.leaflet-popup.pick .pickrow')].map(b => b.dataset.pick + ':' + Math.round(b.getBoundingClientRect().height)).join(' ')" | tr -d '"')
    for r in $rows; do [ "${r#*:}" -ge 44 ] || fail "$name: riga del popup $r px, meno di 44"; done
    local px
    px=$(js "(() => { const r = document.querySelector('.leaflet-popup.pick .leaflet-popup-close-button').getBoundingClientRect();
      return Math.round(r.width) + 'x' + Math.round(r.height); })()" | tr -d '"')
    [ "${px%x*}" -ge 44 ] && [ "${px#*x}" -ge 44 ] || fail "$name: la × del popup è $px px, meno di 44×44"
    [ "$(js "document.activeElement?.classList.contains('pickrow') === true")" = true ] || fail "$name: il focus non è sulla prima riga del popup"
    [ "$(js "getComputedStyle(document.getElementById('panel')).display")" = '"none"' ] || fail "$name: il popup ha aperto anche la scheda"
    ok "$name: navi sovrapposte → popup «$(js "document.querySelector('.pick .pick-title').textContent" | tr -d '"')», righe $rows (MMSI:px), × $px px"
    "${AB[@]}" screenshot "$OUT/$name-sovrapposte.png" >/dev/null
    "${AB[@]}" press Escape >/dev/null
    "${AB[@]}" wait --fn "!document.querySelector('.leaflet-popup.pick')" >/dev/null || fail "$name: Esc non chiude il popup"
    ok "$name: Esc chiude il popup"
    "${AB[@]}" mouse move $twin >/dev/null
    "${AB[@]}" mouse down >/dev/null
    "${AB[@]}" mouse up >/dev/null
    "${AB[@]}" wait --fn "document.querySelectorAll('.leaflet-popup.pick .pickrow').length === 2" >/dev/null \
      || fail "$name: il secondo clic sulle navi sovrapposte non riapre il popup"
    "${AB[@]}" wait 500 >/dev/null
    local second
    second=$(js "(() => { const b = document.querySelectorAll('.leaflet-popup.pick .pickrow')[1], r = b.getBoundingClientRect();
      return b.dataset.pick + ' ' + Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2); })()" | tr -d '"')
    local srow sx sy
    read -r srow sx sy <<<"$second"
    local hitrow
    hitrow=$(js "document.elementFromPoint($sx, $sy)?.closest('[data-pick]')?.dataset.pick || 'niente'" | tr -d '"')
    [ "$hitrow" = "$srow" ] || fail "$name: sopra la seconda riga ($sx $sy) c'è $hitrow, non $srow"
    "${AB[@]}" mouse move $sx $sy >/dev/null
    "${AB[@]}" mouse down >/dev/null
    "${AB[@]}" mouse up >/dev/null
    "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none'
      && document.getElementById('content').textContent.includes('$srow') && !document.querySelector('.leaflet-popup.pick')" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/$name-sovrapposte-errore.png" >/dev/null || true; fail "$name: il clic sulla seconda riga non apre la scheda di $srow"; }
    [ "$srow" = 247555002 ] || fail "$name: la seconda riga è $srow, attesa 247555002"
    ok "$name: clic sulla seconda riga → scheda di $srow ($(js "document.querySelector('#content h2')?.textContent || ''"))"

    # molte navi nello stesso punto con la scheda aperta (correzioni da revisione del punto 10): 30 marker finti
    # aggiunti a markers nella parte libera della mappa (sotto l'header, fuori dalla scheda), poi un clic vero lì: popup
    # «30 navi qui» con 15 righe e «e altre 15», tutto fra l'header e la scheda (o il fondo della mappa), ogni riga
    # raggiungibile scorrendo (sopra il suo centro c'è lei, non la scheda né l'header), × con aria-label; un clic vero su
    # «e altre 15» chiude il popup e ingrandisce di 2. I marker finti spariscono al giro dopo (non sono nella risposta).
    local crowd
    crowd=$(js "(() => { const m = document.getElementById('map').getBoundingClientRect(), h = document.querySelector('header').getBoundingClientRect();
      const p = document.getElementById('panel').getBoundingClientRect(), phone = matchMedia('(max-width: 640px)').matches;
      const right = phone ? m.right : p.left, bottom = phone ? p.top : m.bottom;
      const x = Math.round((m.left + right) / 2), y = Math.round(bottom - 40);
      const c = { x: x - m.left, y: y - m.top };
      for (let i = 0; i < 30; i++) {
        const mmsi = 990000000 + i, ll = map.containerPointToLatLng([c.x + (i % 6) - 3, c.y + Math.floor(i / 6) - 2]);
        meta.set(mmsi, { name: 'PROVA ' + i, shipType: 70 });
        const marker = new ShipMarker(ll, { renderer, ...STYLE.normal, fillColor: '#888', fillOpacity: 0.9 }).addTo(map);
        markers.set(mmsi, { marker, props: { mmsi, sog: 1 } });
      }
      return x + ' ' + y + ' ' + map.getZoom(); })()" | tr -d '"')
    local cx cy z0
    read -r cx cy z0 <<<"$crowd"
    "${AB[@]}" mouse move "$cx" "$cy" >/dev/null
    "${AB[@]}" mouse down >/dev/null
    "${AB[@]}" mouse up >/dev/null
    "${AB[@]}" wait --fn "document.querySelectorAll('.leaflet-popup.pick [data-more]').length === 1" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/$name-molte-errore.png" >/dev/null || true
           fail "$name: il clic su 30 navi ($cx $cy) non apre il popup con «e altre» · righe: $(js "document.querySelectorAll('.pickrow').length")"; }
    "${AB[@]}" wait 600 >/dev/null   # fine dell'autoPan
    local reach
    reach=$(js "(() => {
      const pop = document.querySelector('.leaflet-popup.pick'), box = pop.querySelector('.leaflet-popup-content-wrapper').getBoundingClientRect();
      const tip = pop.querySelector('.leaflet-popup-tip-container').getBoundingClientRect();
      const h = document.querySelector('header').getBoundingClientRect(), m = document.getElementById('map').getBoundingClientRect();
      const p = document.getElementById('panel').getBoundingClientRect(), phone = matchMedia('(max-width: 640px)').matches;
      const limit = phone ? p.top : m.bottom, out = [];
      if (box.top < h.bottom) out.push('popup sotto l\'header (' + Math.round(box.top) + ' < ' + Math.round(h.bottom) + ')');
      // il riquadro sempre fuori dalla scheda; la punta pure, salvo quando lo spazio è sotto il minimo di ~3 righe
      // (PICK_MIN_HEIGHT: il popup tiene le sue 3 righe e la punta può toccare la scheda)
      const content = pop.querySelector('.leaflet-popup-content'), atMin = content.clientHeight <= AisLogic.PICK_MIN_HEIGHT;
      if (box.bottom > limit) out.push('riquadro oltre ' + (phone ? 'la scheda' : 'la mappa') + ' (' + Math.round(box.bottom) + ' > ' + Math.round(limit) + ')');
      if (tip.bottom > limit && !atMin) out.push('punta oltre ' + (phone ? 'la scheda' : 'la mappa') + ' (' + Math.round(tip.bottom) + ' > ' + Math.round(limit) + ')');
      if (!phone && box.right > p.left) out.push('popup sotto la scheda');
      const rows = [...pop.querySelectorAll('.pickrow')];
      if (rows.length !== 16) out.push(rows.length + ' pulsanti invece di 15 + 1');
      for (const b of rows) {
        b.scrollIntoView({ block: 'nearest' });
        const r = b.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button');
        if (hit !== b) out.push((b.dataset.pick || 'altre') + ' coperta da ' + (hit?.className || 'niente'));
        if (Math.round(r.height) < 44) out.push((b.dataset.pick || 'altre') + ' alta ' + Math.round(r.height) + ' px');
      }
      const label = pop.querySelector('.leaflet-popup-close-button').getAttribute('aria-label');
      if (label !== 'Chiudi elenco') out.push('× con aria-label ' + label);
      const zin = document.querySelector('.leaflet-control-zoom-in')?.getAttribute('aria-label'),
        zout = document.querySelector('.leaflet-control-zoom-out')?.getAttribute('aria-label');
      if (zin !== 'Ingrandisci' || zout !== 'Riduci') out.push('zoom con aria-label ' + zin + '/' + zout);
      return out.length ? out.join('; ') : 'ok ' + Math.round(box.top) + '-' + Math.round(tip.bottom) + ' px (limite ' + Math.round(h.bottom) + '-'
        + Math.round(limit) + '), contenuto ' + content.clientHeight + '/' + content.scrollHeight + ' px' + (atMin ? ' (minimo)' : '')
        + ', ' + rows.length + ' pulsanti';
    })()" | tr -d '"')
    "${AB[@]}" screenshot "$OUT/$name-molte.png" >/dev/null
    case "$reach" in ok*) ;; *) fail "$name: 30 navi con la scheda aperta: $reach (screenshot in $OUT/)" ;; esac
    ok "$name: 30 navi con la scheda aperta → «$(js "document.querySelector('.pick .pick-title').textContent" | tr -d '"')», 15 righe + «e altre», tutte raggiungibili: $reach"
    local mx my
    read -r mx my <<<"$(js "(() => { const b = document.querySelector('.leaflet-popup.pick [data-more]'); b.scrollIntoView({ block: 'nearest' });
      const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2); })()" | tr -d '"')"
    "${AB[@]}" mouse move "$mx" "$my" >/dev/null
    "${AB[@]}" mouse down >/dev/null
    "${AB[@]}" mouse up >/dev/null
    "${AB[@]}" wait --fn "!document.querySelector('.leaflet-popup.pick') && map.getZoom() === $z0 + 2" >/dev/null \
      || fail "$name: «e altre 15» non chiude il popup né ingrandisce (zoom $(js "map.getZoom()"), da $z0)"
    ok "$name: «e altre 15» → popup chiuso, zoom da $z0 a $(js "map.getZoom()")"
    [ "$(js "getComputedStyle(document.getElementById('panel')).display")" != '"none"' ] || fail "$name: «e altre» ha chiuso la scheda"
    js "(() => { for (let i = 0; i < 30; i++) { const m = markers.get(990000000 + i); if (m) { m.marker.remove(); markers.delete(990000000 + i); } } return true; })()" >/dev/null
    "${AB[@]}" press Escape >/dev/null
    "${AB[@]}" wait --fn "document.getElementById('panel').style.display === 'none'" >/dev/null || fail "$name: Esc non chiude la scheda dopo la scelta"
  else
    ok "$name: navi sovrapposte non controllate (pagina pubblicata, navi vere)"
  fi

  # filtri (punto 9): clic veri su «Cargo» nella legenda; LAGUNA PRIMA (247123450, tipo 70) della fixture sparisce e
  # torna, il filtro resta in localStorage anche ricaricando. Solo con il server locale (navi e tipi noti).
  if [ -z "${SMOKE_URL:-}" ]; then
    local FKEY="'boatradar:filtri'" NOCARGO="'types=tanker,passenger,fishing,pleasure,service,other'"
    # centro di un elemento portato in vista (dentro la legenda che scorre), poi chi c'è davvero in quel punto
    local center_of="(sel => { const b = document.querySelector(sel); b.scrollIntoView({ block: 'nearest' });
      const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2) + ' ' + Math.round(r.height); })"
    open_legend() {
      [ "$(js "document.getElementById('legend').open")" = true ] && return 0
      local sx sy _h
      read -r sx sy _h <<<"$(js "$center_of('#legend > summary')" | tr -d '"')"
      click_at "$sx" "$sy"
      "${AB[@]}" wait --fn "document.getElementById('legend').open" >/dev/null || fail "$name: il clic sul titolo della legenda non la apre"
    }
    cargo_click() {
      open_legend
      local bx by bh hitb
      read -r bx by bh <<<"$(js "$center_of('#lt-cargo')" | tr -d '"')"
      hitb=$(js "document.elementFromPoint($bx, $by)?.closest('button')?.id || 'niente'" | tr -d '"')
      [ "$hitb" = lt-cargo ] || { "${AB[@]}" screenshot "$OUT/$name-filtri-errore.png" >/dev/null || true; fail "$name: sopra «Cargo» ($bx $by) c'è $hitb"; }
      click_at "$bx" "$by"
      CARGO_H="$bh"
    }
    js "map.setView([45.4312, 12.3355], 10, { animate: false }), true" >/dev/null
    "${AB[@]}" wait --fn "markers.has(247123450)" >/dev/null || fail "$name: LAGUNA PRIMA (247123450) non è in mappa per la prova dei filtri"
    cargo_click
    if [ "$(js "matchMedia('(max-width: 640px)').matches")" = true ]; then
      [ "$CARGO_H" -ge 44 ] || fail "$name: la riga «Cargo» della legenda è alta $CARGO_H px, meno di 44"
    fi
    "${AB[@]}" wait --fn "!markers.has(247123450) && localStorage.getItem($FKEY) === $NOCARGO" >/dev/null       || { "${AB[@]}" screenshot "$OUT/$name-filtri-errore.png" >/dev/null || true
           fail "$name: il clic su «Cargo» non toglie 247123450 · localStorage $(js "localStorage.getItem($FKEY)") · in mappa $(js "markers.has(247123450)")"; }
    [ "$(js "document.getElementById('lt-cargo').getAttribute('aria-pressed')")" = '"false"' ] || fail "$name: «Cargo» spento senza aria-pressed=false"
    ok "$name: clic su «Cargo» (riga $CARGO_H px) → 247123450 tolta, localStorage «$(js "localStorage.getItem($FKEY)" | tr -d '"')», conteggio «$(js "document.getElementById('filter-count').textContent" | tr -d '"')»"
    "${AB[@]}" screenshot "$OUT/$name-filtri.png" >/dev/null
    # ricaricando: il filtro resta (vista mondo, LAGUNA PRIMA è dentro ma non torna)
    "${AB[@]}" open "$URL" >/dev/null || fail "$name: la pagina non si riapre"
    "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 0 && /filtri attivi/.test(document.getElementById('status').textContent)" >/dev/null       || fail "$name: dopo il ricaricamento niente navi o niente «filtri attivi» · stato: $(js "document.getElementById('status')?.textContent")"
    [ "$(js "tick().then(() => !markers.has(247123450) && document.getElementById('lt-cargo').getAttribute('aria-pressed') === 'false')")" = true ]       || fail "$name: dopo il ricaricamento il filtro non vale (247123450 in mappa o «Cargo» acceso)"
    ok "$name: ricaricando il filtro resta · stato «$(js "document.getElementById('status').textContent" | tr -d '"')»"
    cargo_click
    "${AB[@]}" wait --fn "markers.has(247123450) && localStorage.getItem($FKEY) === null" >/dev/null       || fail "$name: il secondo clic su «Cargo» non riporta 247123450 · localStorage $(js "localStorage.getItem($FKEY)")"
    ok "$name: secondo clic su «Cargo» → 247123450 di nuovo in mappa, localStorage vuoto"
  fi

  # ricerca (punto 12): «GEMELLA» scritta con tasti veri → dopo l'attesa 2 righe role="option", entrambe con «2 navi
  # con questo nome» (le due omonime della fixture), righe da almeno 44 px su telefono; freccia giù rende attiva la
  # prima (aria-activedescendant), Invio apre la sua scheda e chiude l'elenco, Esc chiude la scheda. Solo con il server locale.
  if [ -z "${SMOKE_URL:-}" ]; then
    "${AB[@]}" focus "#q" >/dev/null
    "${AB[@]}" keyboard type "GEMELLA" >/dev/null
    "${AB[@]}" wait --fn "document.querySelectorAll('#results [role=option][data-mmsi]').length === 2
      && getComputedStyle(document.getElementById('results')).display !== 'none'" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/$name-ricerca-errore.png" >/dev/null || true
           fail "$name: «GEMELLA» non dà 2 risultati · righe: $(js "document.getElementById('results').textContent")"; }
    local found
    found=$(js "(() => { const rows = [...document.querySelectorAll('#results [role=option][data-mmsi]')], out = [];
      if (document.getElementById('q').getAttribute('aria-expanded') !== 'true') out.push('aria-expanded non true');
      const live = document.getElementById('search-live');
      if (live.textContent !== '2 risultati') out.push('aria-live «' + live.textContent + '»');
      if (live.getBoundingClientRect().width > 1) out.push('regione aria-live visibile');
      for (const r of rows) {
        const label = document.getElementById(r.getAttribute('aria-labelledby'));
        if (label?.textContent !== 'GEMELLA') out.push(r.dataset.mmsi + ' nome accessibile «' + label?.textContent + '»');
        if (!r.textContent.includes('2 navi con questo nome')) out.push(r.dataset.mmsi + ' senza «2 navi con questo nome»');
        if (matchMedia('(max-width: 640px)').matches && r.getBoundingClientRect().height < 44) out.push(r.dataset.mmsi + ' alta ' + Math.round(r.getBoundingClientRect().height) + ' px');
      }
      return out.length ? out.join('; ') : 'ok ' + rows.map(r => r.dataset.mmsi + ' (' + r.querySelector('small').textContent + ', ' + Math.round(r.getBoundingClientRect().height) + ' px)').join(' · '); })()" | tr -d '"')
    "${AB[@]}" screenshot "$OUT/$name-ricerca.png" >/dev/null
    case "$found" in ok*) ;; *) fail "$name: ricerca «GEMELLA»: $found (screenshot in $OUT/)" ;; esac
    ok "$name: ricerca «GEMELLA» → 2 righe con «2 navi con questo nome»: ${found#ok }"
    "${AB[@]}" press ArrowDown >/dev/null
    local first
    first=$(js "document.querySelector('#results [role=option][data-mmsi]').dataset.mmsi" | tr -d '"')
    [ "$(js "document.getElementById('q').getAttribute('aria-activedescendant')")" = "\"res-$first\"" ] \
      || fail "$name: freccia giù: riga attiva $(js "document.getElementById('q').getAttribute('aria-activedescendant')"), attesa res-$first"
    [ "$(js "document.getElementById('res-$first').getAttribute('aria-selected')")" = '"true"' ] || fail "$name: la prima riga non è aria-selected"
    "${AB[@]}" press Enter >/dev/null
    "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none'
      && document.getElementById('content').textContent.includes('$first')
      && getComputedStyle(document.getElementById('results')).display === 'none'" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/$name-ricerca-errore.png" >/dev/null || true; fail "$name: freccia giù + Invio non apre la scheda di $first"; }
    ok "$name: freccia giù + Invio → scheda di $first, elenco chiuso"
    "${AB[@]}" press Escape >/dev/null
    "${AB[@]}" wait --fn "document.getElementById('panel').style.display === 'none'" >/dev/null || fail "$name: Esc non chiude la scheda aperta dalla ricerca"
    ok "$name: Esc chiude la scheda aperta dalla ricerca"
    "${AB[@]}" fill "#q" "" >/dev/null
  fi

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
# stessa sessione: niente filtri della passata desktop (punto 9) nella passata telefono
js "(localStorage.clear(), true)" >/dev/null
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
