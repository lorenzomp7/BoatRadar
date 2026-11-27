#!/usr/bin/env bash
# Verifica di BoatRadar nel browser con agent-browser (https://github.com/vercel-labs/agent-browser, Apache-2.0).
# Avvia server.js con i messaggi di test (tools/smoke-server.js, senza chiave né rete), apre la pagina
# a larghezza desktop (1280×800) e telefono (390×844) e controlla che:
#   1. compaiano le navi;
#   2. un clic del mouse su una nave apra la scheda con il suo MMSI, e un clic vero sulla × (almeno 44×44 px)
#      o Esc la chiudano, lasciando il focus su un elemento visibile;
#   2 bis. (solo con il server locale, lotto B, punti 27, 44, 46, 23) la scheda di LAGUNA PRIMA (247123450) abbia, dopo
#      il nominativo, il gruppo «Viaggio (dichiarato dalla nave, …)» (prossimo porto, ETA completa dell'anno, pescaggio) e
#      poi «Movimento», ognuno nel suo <tbody> con <th scope="rowgroup">, «Bandiera» Italia, decimali con la virgola e
#      nessun «—», e che il prossimo porto si veda senza scorrere, anche su telefono con la scheda a metà (screenshot
#      $name-scheda.png senza scorrere);
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
#   3b bis. (punto 71, vedi sheet_phone e sheet_desktop) a 390×844 il pannello in basso parta chiuso (72 px) con il numero
#      di navi e l'attribuzione visibile sopra, si trascini con il mouse vero chiuso → metà → aperto → chiuso (± 8 px,
#      legenda nascosta da aperto, nessun long task > 50 ms), un lancio veloce lo porti una tappa più in là (chiuso → metà,
#      metà → chiuso), un tocco lo porti a metà, un clic su una riga apra la scheda a metà con la nave fra header e scheda e
#      la × libera, Esc torni all'elenco con il focus sulla riga e un altro Esc lo chiuda; a 1280×800 «Elenco» apra l'elenco
#      a destra non coperto dall'header, la riga di una nave sotto l'elenco apra la scheda e sposti la mappa con la nave a
#      sinistra della scheda, Esc ed Esc;
#   3c. (solo con il server locale, punti 13, 63, 42) a zoom 14 su LAGUNA PRIMA (247123450, che smoke-server fa avanzare
#      coerente con velocità e rotta) 6 letture della posizione mostrata in 3 s: distanza dal primo fix mai in calo, nave
#      in movimento, stima entro il suo limite; #smooth spento con un clic vero sulla sua riga (≥ 44 px a 390) e la nave
#      resta esattamente sull'ultimo fix;
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
# primo server morto, secondo buono; di solito non serve), AGENT_BROWSER_EXECUTABLE_PATH
# per usare un Chrome già installato invece di quello scaricato da «agent-browser install».
# Leaflet (punto 85) viene da vendor/leaflet/ della repo: in ogni sessione del browser le richieste a unpkg.com sono
# bloccate (block_unpkg), così la verifica fallisce se la pagina torna a dipendere dal CDN.
set -euo pipefail
cd "$(dirname "$0")/.."

SESSION="boatradar-smoke-$$"
AB=(agent-browser --session "$SESSION")
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

# --- Leaflet senza unpkg (punto 85) ----------------------------------------
# La pagina carica Leaflet 1.9.4 da vendor/leaflet/: le richieste a unpkg.com si annullano in ogni sessione, prima di
# aprire la pagina (il browser parte qui, con gli init script della sessione già in AB).
block_unpkg() { "${AB[@]}" network route "https://unpkg.com/**" --abort >/dev/null || fail "non riesco a bloccare unpkg.com"; }

# Clic vero del mouse nel punto x y della pagina
click_at() { "${AB[@]}" mouse move "$1" "$2" >/dev/null; "${AB[@]}" mouse down >/dev/null; "${AB[@]}" mouse up >/dev/null; }

# Valore di un'espressione JavaScript nella pagina, come testo JSON.
js() { "${AB[@]}" eval --json "$1" | node -e '
  const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!d.success) { console.error(d.error || "eval fallito"); process.exit(1); }
  process.stdout.write(JSON.stringify(d.data.result));'; }

# --- pannello con l'elenco (punto 71) -------------------------------------
# Telefono: pannello chiuso (72 px) con il numero e l'attribuzione di OpenStreetMap visibile sopra; trascinamento vero
# della maniglia (mouse giù, mosso in 12 passi, su) chiuso → metà (± 8 px), metà → aperto (legenda nascosta), aperto →
# chiuso, misurando i long task (> 50 ms) del trascinamento; lancio veloce vero (mouse mosso di 100 px in 45 ms e
# rilasciato subito) dal chiuso → metà e da metà verso il basso → chiuso; tocco vero → metà; clic vero su una riga → scheda a metà
# con la nave fra header e scheda, × da 44 px non coperta; Esc → elenco a metà con il focus sulla riga; Esc → chiuso con
# il focus sulla maniglia. Screenshot: chiuso, metà, aperto, scheda sopra.
# tappa, altezza visibile (dal fondo della finestra alla cima del pannello, anche durante la transizione), cima, tappe, transform
sheet_state() { js "(() => { const r = document.getElementById('sheet').getBoundingClientRect();
  return sheet.stop + ' ' + Math.round(innerHeight - r.top) + ' ' + Math.round(r.top) + ' ' + sheet.stops.join(',') + ' ' + (document.getElementById('sheet').style.transform || '-'); })()" | tr -d '"'; }
handle_center() { js "(() => { const r = document.getElementById('sheet-handle').getBoundingClientRect();
  return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2) + ' ' + Math.round(r.height); })()" | tr -d '"'; }
# trascina la maniglia di dy px (negativo = verso l'alto) con il mouse vero, in 12 passi
drag_handle() {
  local hx hy _hh
  read -r hx hy _hh <<<"$(handle_center)"
  "${AB[@]}" mouse move "$hx" "$hy" >/dev/null
  "${AB[@]}" mouse down >/dev/null
  "${AB[@]}" mouse move "$hx" "$((hy + $1))" --steps 12 --duration 360 >/dev/null
  "${AB[@]}" wait 150 >/dev/null
  "${AB[@]}" mouse up >/dev/null
  "${AB[@]}" wait 350 >/dev/null   # transizione di 200 ms
}
# lancio: dy px in 45 ms e rilascio subito (snapStop: una tappa più in là della più vicina)
fling_handle() {
  local hx hy _hh
  read -r hx hy _hh <<<"$(handle_center)"
  "${AB[@]}" mouse move "$hx" "$hy" >/dev/null
  "${AB[@]}" mouse down >/dev/null
  "${AB[@]}" mouse move "$hx" "$((hy + $1))" --steps 3 --duration 45 >/dev/null
  "${AB[@]}" mouse up >/dev/null
  "${AB[@]}" wait 350 >/dev/null
}
# dopo il trascinamento: tappa attesa e altezza vera entro 8 px dalla sua, senza transform rimasti
expect_stop() {
  local name="$1" want="$2" st h top stops tr
  read -r st h top stops tr <<<"$(sheet_state)"
  local target; target=$(cut -d, -f$((want + 1)) <<<"$stops")
  [ "$st" = "$want" ] && [ $((h - target)) -le 8 ] && [ $((target - h)) -le 8 ] && [ "$tr" = - ] \
    || { "${AB[@]}" screenshot "$OUT/$name-pannello-errore.png" >/dev/null || true
         fail "$name: dopo il trascinamento tappa $st (attesa $want), altezza $h px (attesa $target ± 8), transform $tr"; }
  echo "$h"
}
sheet_phone() {
  local name="$1"
  # legenda chiusa (i controlli dei filtri l'hanno aperta), come all'avvio su telefono
  js "map.setView([45.4312, 12.3355], 9, { animate: false }), document.getElementById('legend').open = false, true" >/dev/null
  "${AB[@]}" wait 300 >/dev/null   # fine della transizione del pannello dopo l'ultima scheda chiusa
  "${AB[@]}" wait --fn "markers.has(247123450) && /in quest'area/.test(document.getElementById('sheet-count').textContent)" >/dev/null \
    || fail "$name: pannello: nessun conteggio («$(js "document.getElementById('sheet-count').textContent")»)"
  local st h top stops tr
  read -r st h top stops tr <<<"$(sheet_state)"
  [ "$st" = 0 ] && [ "$h" -ge 70 ] && [ "$h" -le 74 ] || fail "$name: pannello all'avvio tappa $st, alto $h px (atteso chiuso, 72)"
  local hx hy hh
  read -r hx hy hh <<<"$(handle_center)"
  [ "$hh" -ge 44 ] || fail "$name: maniglia alta $hh px, meno di 44"
  local attr
  attr=$(js "(() => { const a = document.querySelector('.leaflet-control-attribution'), r = a.getBoundingClientRect();
    const s = document.getElementById('sheet').getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.bottom <= s.top + 1 && a.contains(e) ? 'ok' : 'attribuzione ' + Math.round(r.top) + '-' + Math.round(r.bottom) + ', pannello da ' + Math.round(s.top) + ', sopra c\'è ' + (e?.id || e?.className || 'niente'); })()" | tr -d '"')
  [ "$attr" = ok ] || fail "$name: $attr"
  "${AB[@]}" screenshot "$OUT/$name-pannello-chiuso.png" >/dev/null
  ok "$name: pannello chiuso ($h px, maniglia $hh px) «$(js "document.getElementById('sheet-count').textContent" | tr -d '"')», attribuzione visibile sopra"

  # long task durante i trascinamenti (PerformanceObserver; dove non c'è, nessuna misura)
  js "(window.__long = [], (() => { try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); })
    .observe({ type: 'longtask', buffered: false }); return true; } catch { return false; } })())" >/dev/null
  local s0 s1 s2
  IFS=, read -r s0 s1 s2 <<<"$stops"
  local t0; t0=$(date +%s%N)
  drag_handle "-$((s1 - s0))"
  local hm; hm=$(expect_stop "$name" 1)
  [ "$(js "document.getElementById('sheet-handle').getAttribute('aria-expanded')")" = '"true"' ] || fail "$name: a metà aria-expanded non è true"
  [ "$(js "document.querySelectorAll('#list .row').length > 0")" = true ] || fail "$name: a metà nessuna riga nell'elenco"
  "${AB[@]}" screenshot "$OUT/$name-pannello-meta.png" >/dev/null
  ok "$name: trascinamento vero chiuso → metà: $hm px (tappa $s1), $(js "document.querySelectorAll('#list .row').length") righe"
  drag_handle "-$((s2 - s1))"
  local ha; ha=$(expect_stop "$name" 2)
  [ "$(js "getComputedStyle(document.getElementById('legend')).visibility")" = '"hidden"' ] || fail "$name: da aperto la legenda si vede ancora"
  "${AB[@]}" screenshot "$OUT/$name-pannello-aperto.png" >/dev/null
  ok "$name: trascinamento vero metà → aperto: $ha px (tappa $s2), legenda nascosta"
  drag_handle "$((s2 - s0))"
  local hc; hc=$(expect_stop "$name" 0)
  local t1; t1=$(date +%s%N)
  local long; long=$(js "window.__long.filter(d => d > 50).join(' ')" | tr -d '"')
  [ -z "$long" ] || fail "$name: long task oltre 50 ms durante i trascinamenti: $long ms"
  ok "$name: trascinamento vero aperto → chiuso: $hc px; nessun long task > 50 ms in $(( (t1 - t0) / 1000000 )) ms di trascinamenti (tutti: $(js "window.__long.join(' ') || 'nessuno'" | tr -d '"'))"
  # lancio veloce: 100 px verso l'alto dal chiuso (più vicina: chiuso) → metà; 80 px verso il basso da metà → chiuso
  fling_handle -100
  local hf; hf=$(expect_stop "$name" 1)
  fling_handle 80
  expect_stop "$name" 0 >/dev/null
  ok "$name: lancio vero di 100 px in 45 ms dal chiuso → metà ($hf px); lancio di 80 px verso il basso → chiuso"

  # tocco vero → metà; clic vero sulla riga di LAGUNA PRIMA → scheda a metà, zoom 11, nave fra header e scheda
  read -r hx hy hh <<<"$(handle_center)"
  click_at "$hx" "$hy"
  "${AB[@]}" wait 300 >/dev/null
  expect_stop "$name" 1 >/dev/null
  local rx ry
  read -r rx ry <<<"$(js "(() => { const b = document.querySelector('#list .row[data-mmsi=\"247123450\"]'); b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2); })()" | tr -d '"')"
  [ "$(js "document.elementFromPoint($rx, $ry)?.closest('.row')?.dataset.mmsi")" = '"247123450"' ] || fail "$name: sopra la riga di 247123450 ($rx $ry) c'è altro"
  click_at "$rx" "$ry"
  "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none' && selected === 247123450
    && document.activeElement?.id === 'close' && document.getElementById('sheet').inert" >/dev/null \
    || fail "$name: il clic sulla riga non apre la scheda di 247123450 con il focus sulla × e l'elenco inert (focus su $(js "document.activeElement?.id"))"
  "${AB[@]}" wait 700 >/dev/null   # spostamento animato della mappa
  local vis
  vis=$(js "(() => { const m = document.getElementById('map').getBoundingClientRect(), h = document.querySelector('header').getBoundingClientRect();
    const p = document.getElementById('panel').getBoundingClientRect(), pt = map.latLngToContainerPoint(markers.get(247123450).marker.getLatLng());
    const x = m.left + pt.x, y = m.top + pt.y, c = document.getElementById('close').getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2), out = [];
    if (!(y > h.bottom && y < p.top && x > 0 && x < m.right)) out.push('nave in ' + Math.round(x) + ',' + Math.round(y) + ' fuori da header ' + Math.round(h.bottom) + ' - scheda ' + Math.round(p.top));
    if (sheet.stop !== 1 || Math.abs(p.height - sheet.stops[1]) > 2) out.push('scheda alta ' + Math.round(p.height) + ' (tappa ' + sheet.stop + ')');
    if (map.getZoom() < 11) out.push('zoom ' + map.getZoom());
    if (c.width < 44 || c.height < 44) out.push('× ' + Math.round(c.width) + 'x' + Math.round(c.height));
    if (hit?.id !== 'close') out.push('sopra la × c\'è ' + (hit?.id || hit?.className || 'niente'));
    return out.length ? out.join('; ') : 'ok nave in ' + Math.round(x) + ',' + Math.round(y) + ' fra ' + Math.round(h.bottom) + ' e ' + Math.round(p.top) + ', zoom ' + map.getZoom(); })()" | tr -d '"')
  "${AB[@]}" screenshot "$OUT/$name-pannello-scheda.png" >/dev/null
  case "$vis" in ok*) ;; *) fail "$name: riga → scheda: $vis (screenshot in $OUT/)" ;; esac
  ok "$name: clic vero sulla riga → scheda a metà, ${vis#ok }, × 44 px libera"
  "${AB[@]}" press Escape >/dev/null
  "${AB[@]}" wait --fn "document.getElementById('panel').style.display === 'none' && sheet.stop === 1
    && document.activeElement?.dataset?.mmsi === '247123450'" >/dev/null \
    || fail "$name: Esc dalla scheda: tappa $(js "sheet.stop"), focus su $(js "document.activeElement?.dataset?.mmsi || document.activeElement?.id")"
  "${AB[@]}" press Escape >/dev/null
  "${AB[@]}" wait --fn "sheet.stop === 0 && document.activeElement?.id === 'sheet-handle'" >/dev/null \
    || fail "$name: secondo Esc: tappa $(js "sheet.stop"), focus su $(js "document.activeElement?.id")"
  ok "$name: Esc → elenco a metà con il focus sulla riga; Esc → pannello chiuso, focus sulla maniglia"
}
# Computer: clic vero su «Elenco» → elenco a destra (aria-pressed, nessun header sopra), clic vero su una riga di una nave
# che sta sotto l'elenco (spostata a destra di 460 px) → scheda sopra l'elenco e mappa spostata con la nave a sinistra
# della scheda; Esc → elenco con il focus sulla riga; Esc → elenco chiuso, focus su «Elenco»
sheet_desktop() {
  local name="$1"
  js "map.setView([45.4312, 12.3355], 9, { animate: false }), map.panBy([-460, 0], { animate: false }), true" >/dev/null
  "${AB[@]}" wait --fn "markers.has(247123450)" >/dev/null || fail "$name: 247123450 non è in mappa per l'elenco"
  local bx by _bh
  read -r bx by _bh <<<"$(js "(() => { const r = document.getElementById('listbtn').getBoundingClientRect();
    return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2) + ' 0'; })()" | tr -d '"')"
  click_at "$bx" "$by"
  "${AB[@]}" wait --fn "document.body.classList.contains('list-open') && document.querySelectorAll('#list .row').length > 0" >/dev/null \
    || fail "$name: il clic su «Elenco» non apre l'elenco"
  local cov
  cov=$(js "(() => { const s = document.getElementById('sheet').getBoundingClientRect(), h = document.querySelector('header').getBoundingClientRect(), out = [];
    if (document.getElementById('listbtn').getAttribute('aria-pressed') !== 'true') out.push('aria-pressed non true');
    if (h.right > s.left) out.push('header fino a ' + Math.round(h.right) + ', elenco da ' + Math.round(s.left));
    for (const y of [s.top + 8, s.top + 40]) { const e = document.elementFromPoint(s.left + s.width / 2, y); if (!document.getElementById('sheet').contains(e)) out.push('in ' + Math.round(y) + ' c\'è ' + (e?.id || e?.tagName)); }
    return out.length ? out.join('; ') : 'ok ' + Math.round(s.left) + '-' + Math.round(s.right) + ' px, ' + document.querySelectorAll('#list .row').length + ' righe'; })()" | tr -d '"')
  case "$cov" in ok*) ;; *) "${AB[@]}" screenshot "$OUT/$name-elenco-errore.png" >/dev/null || true; fail "$name: elenco: $cov" ;; esac
  "${AB[@]}" screenshot "$OUT/$name-elenco.png" >/dev/null
  ok "$name: clic vero su «Elenco» → elenco a destra ${cov#ok }, «$(js "document.getElementById('list-count').textContent" | tr -d '"')»"
  local rx ry
  read -r rx ry <<<"$(js "(() => { const b = document.querySelector('#list .row[data-mmsi=\"247123450\"]'); b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ' ' + Math.round(r.top + r.height / 2); })()" | tr -d '"')"
  click_at "$rx" "$ry"
  "${AB[@]}" wait --fn "getComputedStyle(document.getElementById('panel')).display !== 'none' && selected === 247123450
    && document.activeElement?.id === 'close' && document.getElementById('sheet').inert" >/dev/null \
    || fail "$name: il clic sulla riga non apre la scheda con il focus sulla × e l'elenco inert"
  "${AB[@]}" wait 700 >/dev/null   # spostamento animato della mappa
  local side
  side=$(js "(() => { const m = document.getElementById('map').getBoundingClientRect(), p = document.getElementById('panel').getBoundingClientRect();
    const pt = map.latLngToContainerPoint(markers.get(247123450).marker.getLatLng()), x = m.left + pt.x;
    return x > 0 && x < p.left ? 'ok nave in x ' + Math.round(x) + ', scheda da ' + Math.round(p.left) : 'nave in x ' + Math.round(x) + ' sotto la scheda da ' + Math.round(p.left); })()" | tr -d '"')
  "${AB[@]}" screenshot "$OUT/$name-elenco-scheda.png" >/dev/null
  case "$side" in ok*) ;; *) fail "$name: riga → scheda: $side" ;; esac
  ok "$name: riga di una nave sotto l'elenco → scheda e mappa spostata: ${side#ok }"
  "${AB[@]}" press Escape >/dev/null
  "${AB[@]}" wait --fn "document.getElementById('panel').style.display === 'none' && document.body.classList.contains('list-open')
    && document.activeElement?.dataset?.mmsi === '247123450'" >/dev/null || fail "$name: Esc dalla scheda non torna all'elenco con il focus sulla riga"
  "${AB[@]}" press Escape >/dev/null
  "${AB[@]}" wait --fn "!document.body.classList.contains('list-open') && document.activeElement?.id === 'listbtn'
    && getComputedStyle(document.getElementById('sheet')).display === 'none'" >/dev/null || fail "$name: secondo Esc non chiude l'elenco"
  ok "$name: riga → scheda sopra l'elenco; Esc → elenco (focus sulla riga); Esc → chiuso (focus su «Elenco»)"
}

# --- controlli per ogni dimensione ----------------------------------------
check() {
  local name="$1" w="$2" h="$3"
  "${AB[@]}" set viewport "$w" "$h" >/dev/null
  "${AB[@]}" open "$URL" >/dev/null || fail "$name: la pagina non si apre"
  "${AB[@]}" wait --fn "typeof markers !== 'undefined' && markers.size > 0" >/dev/null \
    || fail "$name: nessuna nave in mappa (Leaflet caricato? $(js "typeof L") · stato: $(js "document.getElementById('status')?.textContent"))"
  ok "$name: $(js "markers.size") navi in mappa"
  # punto 85: Leaflet 1.9.4 della repo, con il suo CSS applicato (con unpkg.com bloccato)
  local lf
  lf=$(js "(() => { const p = document.querySelector('.leaflet-pane');
    return (window.L && L.version) + ' ' + (p && getComputedStyle(p).position) + ' '
      + performance.getEntriesByType('resource').filter(e => /unpkg\\.com/.test(e.name)).length; })()" | tr -d '"')
  [ "$lf" = "1.9.4 absolute 0" ] || fail "$name: Leaflet locale non caricato o CSS non applicato (versione, .leaflet-pane, richieste a unpkg: $lf)"
  ok "$name: Leaflet $(cut -d' ' -f1 <<<"$lf") da vendor/leaflet/, CSS applicato, nessuna richiesta a unpkg.com"

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

  # scheda nave (lotto B, punti 27, 44, 46, 23): LAGUNA PRIMA della fixture, con i dati statici arrivati da /api/vessel,
  # ha dopo il nominativo il gruppo «Viaggio (dichiarato dalla nave, …)» e poi «Movimento», «Bandiera» Italia, decimali con la
  # virgola e nessun «—» (i mancanti sono «n.d.»); il prossimo porto si vede senza scorrere (su telefono con la scheda a
  # metà). Solo con il server locale (dati noti). Screenshot della scheda com'è aperta, senza scorrere.
  if [ -z "${SMOKE_URL:-}" ] && [ "$mmsi" = 247123450 ]; then
    "${AB[@]}" wait --fn "document.getElementById('content').textContent.includes('Viaggio (dichiarato dalla nave')" >/dev/null \
      || { "${AB[@]}" screenshot "$OUT/$name-scheda-errore.png" >/dev/null || true; fail "$name: la scheda di LAGUNA PRIMA non ha il gruppo «Viaggio»"; }
    local card
    card=$(js "(() => { const c = document.getElementById('content'), t = c.textContent;
      const rows = [...c.querySelectorAll('#facts tr')], rowOf = k => rows.find(r => r.cells[0]?.textContent === k);
      const flag = rowOf('Bandiera')?.cells[1]?.textContent;
      const heads = [...c.querySelectorAll('#facts tbody > tr.group > th')];
      const group = heads.find(h => /^Viaggio \\(dichiarato dalla nave, /.test(h.textContent));
      const moving = heads.find(h => h.textContent === 'Movimento');
      if (t.includes('—')) return 'trovato «—» nella scheda';
      if (flag !== 'Italia') return 'Bandiera: ' + flag;
      if (!group) return 'nessun gruppo «Viaggio»: ' + heads.map(h => h.textContent).join(', ');
      if (!moving) return 'nessun gruppo «Movimento»';
      if (heads.some(h => h.getAttribute('scope') !== 'rowgroup' || h.colSpan !== 2)) return 'titolo di gruppo senza scope=rowgroup e colspan 2';
      const bodies = [...c.querySelectorAll('#facts tbody')], at = el => bodies.indexOf(el.closest('tbody'));
      if (!(at(rowOf('Nominativo')) < at(group) && at(group) < at(moving))) return 'ordine: Nominativo, Viaggio, Movimento';
      for (const k of ['Prossimo porto', 'ETA', 'Pescaggio']) if (!rowOf(k) || at(rowOf(k)) !== at(group)) return k + ' fuori dal gruppo Viaggio';
      for (const k of ['Velocità / Rotta', 'Stato', 'Ultimo segnale']) if (at(rowOf(k)) !== at(moving)) return k + ' fuori dal gruppo Movimento';
      if (!/\\d{4}/.test(rowOf('ETA').cells[1].textContent)) return 'ETA senza anno';
      if (/\\d\\.\\d/.test(rowOf('Velocità / Rotta').cells[1].textContent)) return 'velocità con il punto decimale';
      // la destinazione si vede senza scorrere (su telefono con la scheda a metà altezza)
      for (let e = document.getElementById('facts'); e; e = e.parentElement) if (e.scrollTop) return 'scheda già scorsa';
      const r = rowOf('Prossimo porto').getBoundingClientRect(), pr = document.getElementById('panel').getBoundingClientRect();
      const hdr = document.querySelector('header')?.getBoundingClientRect().bottom || 0;
      if (r.top < Math.max(pr.top, hdr) || r.bottom > Math.min(pr.bottom, innerHeight))
        return 'Prossimo porto fuori vista senza scorrere (riga ' + Math.round(r.top) + '-' + Math.round(r.bottom) + ', scheda '
          + Math.round(pr.top) + '-' + Math.round(Math.min(pr.bottom, innerHeight)) + ')';
      return 'ok ' + group.textContent + ' · ' + rowOf('Prossimo porto').cells[1].textContent; })()" | tr -d '"')
    case "$card" in ok*) ;; *) "${AB[@]}" screenshot "$OUT/$name-scheda-errore.png" >/dev/null || true; fail "$name: scheda: $card (screenshot in $OUT/)" ;; esac
    "${AB[@]}" wait 200 >/dev/null
    "${AB[@]}" screenshot "$OUT/$name-scheda.png" >/dev/null
    ok "$name: scheda di LAGUNA PRIMA con «${card#ok }» in vista senza scorrere, gruppi Viaggio e Movimento, bandiera Italia, ETA con l'anno e nessun «—»"
  fi

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

  # Esc chiude la scheda. Su telefono la scheda ha spostato la mappa (punto 71: la nave fra header e scheda): il punto
  # della nave va ricalcolato
  point=$(js "(() => { const r = document.getElementById('map').getBoundingClientRect();
    const p = map.latLngToContainerPoint(markers.get($mmsi).marker.getLatLng());
    return Math.round(r.left + p.x) + ' ' + Math.round(r.top + p.y); })()" | tr -d '"')
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

  # movimento fluido (punti 13, 63, 42): a zoom 14 su LAGUNA PRIMA (247123450, 11,2 kn verso est; smoke-server la fa
  # avanzare coerente con velocità e rotta) 6 letture della posizione mostrata in 3 s: la distanza dal primo fix della
  # traccia non cala mai, la nave si muove e la stima resta entro il suo limite (122 s sopra 3 kn); con #smooth spento la
  # nave sta esattamente sull'ultimo fix e non si muove. Solo con il server locale (navi e velocità note).
  if [ -z "${SMOKE_URL:-}" ]; then
    js "map.setView(markers.get(247123450).marker.getLatLng(), 14, { animate: false }), true" >/dev/null
    "${AB[@]}" wait --fn "markers.has(247123450) && markers.get(247123450).track.length > 0 && anim.set.has(247123450)" >/dev/null \
      || fail "$name: 247123450 non è fra le navi animate (anim.enabled $(js "anim.enabled"), #smooth $(js "document.getElementById('smooth').checked"))"
    local readings
    readings=$(js "new Promise(done => {
      const m = markers.get(247123450), out = [], rad = Math.PI / 180;
      let first = null;
      const dist = (a, b) => Math.hypot((b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad), (b.lat - a.lat) * rad) * AisLogic.R_EARTH;
      const take = () => {
        const ll = m.marker.getLatLng(), p = { lat: ll.lat, lon: ll.lng }, last = m.track[m.track.length - 1];
        const at = AisLogic.positionAt(m.track, anim.T), limit = AisLogic.estimateLimitMs(last.sog);
        first ??= { ...m.track[0] };
        out.push({ d: dist(first, p), mode: at.mode, ahead: at.mode === 'estimate' ? at.aheadMs : 0, limit,
          fromLast: dist(last, p), maxFromLast: last.sog * AisLogic.KN * limit / 1000 });
        if (out.length < 6) setTimeout(take, 600); else done(out);
      };
      // con un solo fix ricevuto da meno di 15 s (pagina appena ricaricata) la riproduzione in differita non l'ha ancora
      // raggiunto e la nave aspetta sul fix: le letture partono quando la nave è fra due fix o stimata (al massimo 25 s)
      const t0 = performance.now();
      const start = () => (AisLogic.positionAt(m.track, anim.T).mode !== 'fix' || performance.now() - t0 > 25000 ? take() : setTimeout(start, 200));
      start();
    })")
    local verdict
    verdict=$(node -e '
      const r = JSON.parse(process.argv[1]), bad = [];
      for (let i = 1; i < r.length; i++) if (r[i].d < r[i - 1].d - 0.01) bad.push(`lettura ${i + 1}: distanza dal primo fix scesa da ${r[i - 1].d.toFixed(2)} a ${r[i].d.toFixed(2)} m`);
      if (!(r[r.length - 1].d > r[0].d + 1)) bad.push(`la nave non si muove (${r[0].d.toFixed(2)} → ${r[r.length - 1].d.toFixed(2)} m)`);
      for (const [i, x] of r.entries()) {
        if (x.ahead > x.limit) bad.push(`lettura ${i + 1}: stima ${x.ahead} ms oltre il limite di ${x.limit} ms`);
        if (x.mode === "estimate" && x.fromLast > x.maxFromLast + 5) bad.push(`lettura ${i + 1}: ${x.fromLast.toFixed(1)} m dall ultimo fix, limite ${x.maxFromLast.toFixed(1)} m`);
      }
      process.stdout.write(bad.length ? "✗ " + bad.join("; ") : r.map(x => x.d.toFixed(1) + " m (" + x.mode + ")").join(" · "));
    ' "$readings")
    case "$verdict" in "✗"*) "${AB[@]}" screenshot "$OUT/$name-movimento-errore.png" >/dev/null || true; fail "$name: movimento: ${verdict#✗ }" ;; esac
    ok "$name: movimento fluido a zoom 14, distanza dal primo fix: $verdict"
    # interruttore spento con un clic vero sulla sua riga della legenda (almeno 44 px su telefono)
    open_legend
    local smx smy smh hits
    read -r smx smy smh <<<"$(js "$center_of('#legend label.smooth')" | tr -d '"')"
    hits=$(js "document.elementFromPoint($smx, $smy)?.closest('label')?.className || 'niente'" | tr -d '"')
    [ "$hits" = smooth ] || { "${AB[@]}" screenshot "$OUT/$name-smooth-errore.png" >/dev/null || true; fail "$name: sopra la riga di #smooth ($smx $smy) c'è $hits"; }
    if [ "$(js "matchMedia('(max-width: 640px)').matches")" = true ]; then
      [ "$smh" -ge 44 ] || fail "$name: la riga «Movimento fluido» della legenda è alta $smh px, meno di 44"
    fi
    "${AB[@]}" screenshot "$OUT/$name-movimento.png" >/dev/null
    click_at "$smx" "$smy"
    "${AB[@]}" wait --fn "!document.getElementById('smooth').checked && !anim.enabled" >/dev/null || fail "$name: il clic sulla riga di #smooth non spegne il movimento"
    ok "$name: clic vero sulla riga «Movimento fluido» (alta $smh px) → spento"
    local still
    still=$(js "new Promise(done => {
      const m = markers.get(247123450), out = [];
      const take = () => { const ll = m.marker.getLatLng(), last = m.track[m.track.length - 1];
        out.push(ll.lat === last.lat && ll.lng === last.lon);
        if (out.length < 3) setTimeout(take, 1000); else done(out.every(Boolean) && !anim.enabled && localStorage.getItem('boatradar:movimento') === '0'); };
      take();
    })")
    [ "$still" = true ] || fail "$name: con #smooth spento 247123450 non resta sull'ultimo fix (o localStorage non dice '0')"
    js "(document.getElementById('smooth').click(), true)" >/dev/null
    [ "$(js "anim.enabled && localStorage.getItem('boatradar:movimento') === '1'")" = true ] || fail "$name: riaccendendo #smooth l'animazione non riparte"
    ok "$name: #smooth spento → nave ferma sull'ultimo fix per 2 s; riacceso → animazione ripartita · scheda «Posizione»: $(js "/<td>Posizione<\/td><td[^>]*>([^<]*)/.exec(facts(247123450))[1]" | tr -d '"')"
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

  # pannello con l'elenco (punto 71): trascinamento vero a telefono, pulsante «Elenco» a computer
  if [ "$(js "matchMedia('(max-width: 640px)').matches")" = true ]; then sheet_phone "$name"; else sheet_desktop "$name"; fi

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

block_unpkg
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
  AB=(agent-browser --session "$SESSION-40min" --init-script "$TMP/orologio-40.js")
  block_unpkg
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
    AB=(agent-browser --session "$SESSION-riserva-$1" --init-script "$TMP/riserva.js")
    block_unpkg
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
  AB=(agent-browser --session "$SESSION-primo-buono" --init-script "$TMP/primo-buono.js")
  block_unpkg
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
    AB=(agent-browser --session "$SESSION-ritorno-$1" --init-script "$TMP/ritorno.js")
    block_unpkg
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
