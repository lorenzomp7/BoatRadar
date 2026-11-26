// Logica AIS pura di BoatRadar, senza DOM né rete: la usa la pagina (window.AisLogic) e si può
// usare da Node (require('./public/ais-logic')). Ogni funzione è coperta da test/ais-logic.test.js.
// Per aggiungere una funzione: definiscila dentro l'involucro e aggiungila all'oggetto restituito.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.AisLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Categorie per colore e legenda (codici AIS del tipo di nave); l'ultima prende tutto il resto
  const TYPES = [
    { key:'cargo',     label:'Cargo',            color:'#5ad17c', test:t => t >= 70 && t <= 79 },
    { key:'tanker',    label:'Petroliera',       color:'#ff6b5e', test:t => t >= 80 && t <= 89 },
    { key:'passenger', label:'Passeggeri',       color:'#4da3ff', test:t => t >= 60 && t <= 69 },
    { key:'fishing',   label:'Pesca',            color:'#ff9f43', test:t => t === 30 },
    { key:'pleasure',  label:'Diporto / vela',   color:'#d77bff', test:t => t === 36 || t === 37 },
    { key:'service',   label:'Servizio / rimorchio', color:'#ffc83d', test:t => (t >= 31 && t <= 35) || (t >= 50 && t <= 59) },
    { key:'other',     label:'Altro / sconosciuto',  color:'#9aa7b6', test:() => true },
  ];
  const typeOf = t => TYPES.find(x => x.test(t ?? -1));

  // Nome preciso del tipo di nave (codici AIS)
  function typeName(t) {
    const exact = { 30:'Peschereccio', 31:'Rimorchiatore', 32:'Rimorchiatore', 33:'Draga', 34:'Operazioni subacquee', 35:'Nave militare',
      36:'Barca a vela', 37:'Imbarcazione da diporto', 50:'Pilotina', 51:'Ricerca e soccorso', 52:'Rimorchiatore', 53:'Servizio portuale',
      54:'Antinquinamento', 55:'Forze dell\'ordine', 58:'Trasporto sanitario', 59:'Nave speciale' };
    if (exact[t]) return exact[t];
    if (t >= 20 && t <= 29) return 'Aliscafo / WIG';
    if (t >= 40 && t <= 49) return 'Unità veloce';
    if (t >= 60 && t <= 69) return 'Nave passeggeri';
    if (t >= 70 && t <= 79) return 'Nave cargo';
    if (t >= 80 && t <= 89) return 'Petroliera / cisterna';
    return null;
  }

  // Prua vera (TrueHeading, anche properties.heading di Digitraffic): interi 0-359, altrimenti null
  // (511 = non disponibile; 0 = nord è una prua valida)
  const validHeading = h => Number.isInteger(h) && h >= 0 && h <= 359 ? h : null;
  // In movimento: oltre 0,5 kn (sog 102.3 = non disponibile)
  const moving = p => p.sog > 0.5 && p.sog < 102.3;
  // Direzione della freccia: la prua vera se c'è, altrimenti la rotta solo per navi in movimento (cog 360 = n.d.)
  const heading = p => validHeading(p.heading) ?? (moving(p) && p.cog != null && p.cog < 360 ? p.cog : null);
  // Simbolo della nave: heading null = pallino; short = freccia corta, per una nave con la prua nota che non è in
  // moto, cioè ferma (all'ancora, ormeggiata) o con la velocità non nota, così non sembra in moto (come la legenda)
  const symbol = p => ({ heading: heading(p), short: validHeading(p.heading) != null && !moving(p) });
  // Ferma (per il tooltip): velocità nota fino a 0,5 kn; velocità mancante o n.d. (102.3) = non si sa
  const stopped = p => typeof p.sog === 'number' && p.sog >= 0 && p.sog <= 0.5;

  // ETA di Digitraffic, un intero: mese << 16 | giorno << 11 | ora << 6 | minuto (UTC, senza anno).
  // Mese 0 o giorno 0 = non disponibile; ora 24 e minuto 60 = non disponibili.
  function decodeEta(e) {
    const month = (e >> 16) & 15, day = (e >> 11) & 31, hour = (e >> 6) & 31, minute = e & 63;
    if (!(month >= 1 && month <= 12) || !day) return null;
    return { month, day, hour: hour < 24 ? hour : null, minute: minute < 60 ? minute : null };
  }

  // Ricerca locale: q (già in maiuscolo) contenuto nel nome, oppure inizio di MMSI o IMO
  function matchesQuery(v, mmsi, q) {
    v = v || {};
    return (v.name || '').toUpperCase().includes(q) || String(mmsi).startsWith(q) || String(v.imo || '').startsWith(q);
  }

  // Fonti dei dati di posizione e testo mostrato nella scheda (riga «Fonte»)
  const SOURCE_LABEL = { digitraffic: 'Digitraffic (Fintraffic, Baltico)', aisstream: 'aisstream.io' };

  // Orario in millisecondi: numero finito così com'è, stringa numerica → numero, stringa ISO →
  // Date.parse; tutto il resto (mancante, illeggibile) = -Infinity, cioè il più vecchio possibile.
  function toMs(t) {
    if (typeof t === 'number') return Number.isFinite(t) ? t : -Infinity;
    if (typeof t !== 'string' || !t.trim()) return -Infinity;
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(t);
    return Number.isFinite(d) ? d : -Infinity;
  }

  // true se l'orario a è più recente di b (confronto con toMs; a parità false)
  const isNewer = (a, b) => toMs(a) > toMs(b);

  // Dati statici che la pagina prende dalle posizioni e mette in meta: se la posizione vincente
  // non li ha (null, undefined o testo vuoto), restano quelli della perdente.
  const STATIC_FIELDS = ['name', 'shipType'];
  const missing = v => v == null || v === '';

  // MMSI come intero positivo, altrimenti null
  function mmsiOf(f) {
    const n = Number(f.mmsi ?? f.properties?.mmsi);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // Unisce le posizioni di più fonti: groups = [{ source, features }] (features può mancare).
  // Restituisce Map<mmsi numerico, feature>: per ogni MMSI vince properties.timestampExternal più alto
  // (toMs; mancante o illeggibile = la più vecchia); a parità resta la prima nell'ordine dei gruppi
  // (e, nello stesso gruppo, nell'ordine dell'array). Ogni feature è una copia con properties.source
  // e i STATIC_FIELDS mancanti presi dalla perdente; gli originali non vengono toccati.
  // Feature null o con MMSI non intero o ≤ 0 sono scartate.
  function mergeFeatures(groups) {
    const out = new Map(), time = new Map();
    for (const { source, features } of groups) {
      for (const f of features || []) {
        if (!f) continue;
        const mmsi = mmsiOf(f);
        if (mmsi == null) continue;
        const t = toMs(f.properties?.timestampExternal);
        const prev = out.get(mmsi);
        const win = !prev || t > time.get(mmsi);
        const winner = win ? { ...f, properties: { ...f.properties, source } } : prev;
        const loser = win ? prev?.properties : f.properties;
        for (const k of STATIC_FIELDS)
          if (missing(winner.properties[k]) && loser && !missing(loser[k])) winner.properties[k] = loser[k];
        if (win) { out.set(mmsi, winner); time.set(mmsi, t); }
      }
    }
    return out;
  }

  // Punto 43: orologio del telefono corretto con l'ora del server (serverTime di /api/status).
  // Campione da una richiesta: t0 e t1 = ora del telefono a inizio e fine, serverTime = ora del server
  // nella risposta. offset = quanto il telefono è avanti (ms), rtt = durata della richiesta.
  // null se serverTime non è un numero finito o se l'orologio è andato indietro durante la richiesta.
  function clockSample(t0, t1, serverTime) {
    if (![t0, t1, serverTime].every(x => typeof x === 'number' && Number.isFinite(x)) || t1 < t0) return null;
    return { offset: (t0 + t1) / 2 - serverTime, rtt: t1 - t0 };
  }

  // Orologio corretto: offset = mediana degli ultimi keep campioni con rtt ≤ maxRtt (le risposte lente
  // misurano male), 0 senza campioni. now() = ora del telefono − offset (arrotondata al ms), letta a ogni chiamata.
  function createClock({ now = () => Date.now(), keep = 5, maxRtt = 2000 } = {}) {
    const samples = [];
    const offset = () => {
      if (!samples.length) return 0;
      const s = [...samples].sort((a, b) => a - b), mid = s.length >> 1;
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    return {
      add(sample) {
        // rtt valido: numero finito fra 0 e maxRtt (negativo = orologio spostato, non finito = misura rotta)
        if (!sample || !Number.isFinite(sample.rtt) || sample.rtt < 0 || sample.rtt > maxRtt
          || !Number.isFinite(sample.offset)) return;
        samples.push(sample.offset);
        if (samples.length > keep) samples.shift();
      },
      offset,
      // intero: l'offset (mediana di metà richieste) può avere ,5 e from= di Digitraffic vuole millisecondi interi
      now: () => Math.round(now() - offset()),
    };
  }

  // Punto 3: query di /api/locations?include=… per le navi da avere sempre in mappa (la selezionata, più
  // avanti le preferite), chiesta a parte dalla vista. Solo interi > 0, senza doppioni, al massimo 50
  // nell'ordine dato: 'include=1,2'; '' se nessuno o se list non è un array.
  function includeParam(list) {
    if (!Array.isArray(list)) return '';
    const ids = [...new Set(list.filter(n => Number.isInteger(n) && n > 0))].slice(0, 50);
    return ids.length ? 'include=' + ids.join(',') : '';
  }

  // Punto 8: età della posizione. Una nave in moto si conserva movingMs (30 min); ferma, all'ancora o
  // ormeggiata stillMs (6 h, come la conservazione per stato di OpenCPN), disegnata sbiadita e tratteggiata.
  // Li usa anche server.js (pulizia e filtro delle risposte), con i limiti da STALE_MOVING_MS / STALE_STILL_MS.
  const MIN_MS = 60 * 1000, HOUR_MS = 60 * MIN_MS;
  const DEFAULT_LIMITS = Object.freeze({ movingMs: 30 * MIN_MS, stillMs: 6 * HOUR_MS });
  // Velocità nota: numero fra 0 e 102,2 kn (102,3 = non disponibile)
  const validSog = s => typeof s === 'number' && s >= 0 && s < 102.3;
  // Ferma: velocità nota fino a 0,5 kn, oppure stato all'ancora (1), ormeggiata (5) o incagliata (6) se la velocità
  // nota non dice che va ad almeno 3 kn (stato non aggiornato dall'equipaggio). Senza dati = in moto (limite corto).
  const STILL_STATUS = [1, 5, 6];
  const isStill = p => (validSog(p.sog) && p.sog <= 0.5) || (STILL_STATUS.includes(p.navStat) && !(validSog(p.sog) && p.sog >= 3));
  // Per quanto si conserva la posizione p (ms); una nave ferma mai meno di una in moto
  const retentionMs = (p, limits = DEFAULT_LIMITS) => isStill(p) ? Math.max(limits.stillMs, limits.movingMs) : limits.movingMs;
  // Età (ms) di un orario (toMs: numero, stringa numerica o ISO) all'ora now; mai negativa; orario non valido = Infinity
  function ageMs(ts, now) {
    const t = toMs(ts);
    return Number.isFinite(t) && Number.isFinite(now) ? Math.max(0, now - t) : Infinity;
  }
  // Limiti di conservazione riportati dal server (limits di /api/status): validi se movingMs e stillMs sono numeri
  // finiti > 0, altrimenti DEFAULT_LIMITS
  const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const normLimits = l => (l && positive(l.movingMs) && positive(l.stillMs) ? { movingMs: l.movingMs, stillMs: l.stillMs } : DEFAULT_LIMITS);
  // Opacità per età (come fadeCurve di AIS-catcher): 1 fino a fullMs, poi lineare fino a min a endMs, poi min.
  // min 0,35 (era 0,2: dopo il QA, una nave in moto sbiadita restava quasi invisibile sulla mappa scura).
  // Età non valida (non un numero, anche una stringa numerica, o NaN) = la più vecchia.
  function fadeOpacity(age, { fullMs = 2 * MIN_MS, endMs = 30 * MIN_MS, min = 0.35 } = {}) {
    if (typeof age !== 'number' || Number.isNaN(age)) return min;
    if (!(age > fullMs)) return 1;
    if (age >= endMs) return min;
    return 1 - (1 - min) * (age - fullMs) / (endMs - fullMs);
  }
  // Aspetto di una nave dalle sue properties (timestampExternal, sog, navStat) all'ora now (clock.now() nella pagina):
  // age in ms, opacity, dashed = più vecchia del limite delle navi in moto (solo le ferme arrivano a esserlo),
  // gone = oltre la sua conservazione (da togliere). Al limite esatto vale ancora come prima.
  function ageStyle(p, now, limits = DEFAULT_LIMITS) {
    const age = ageMs(p.timestampExternal, now);
    return { age, opacity: fadeOpacity(age), dashed: age > limits.movingMs, gone: !(age <= retentionMs(p, limits)) };
  }
  // Età in parole: «adesso» sotto il minuto, «12 min fa», «1 h 30 min fa», «3 h fa»; non finita = null
  function formatAge(age) {
    if (typeof age !== 'number' || !Number.isFinite(age)) return null;
    if (age < MIN_MS) return 'adesso';
    const min = Math.floor(age / MIN_MS);
    if (min < 60) return `${min} min fa`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min fa` : `${h} h fa`;
  }

  // Punto 62: colore dell'età della posizione (soglie di MyShipTracking): 'verde' sotto 5 min, 'arancio' sotto 15 min,
  // poi 'rosso' (anche età non valida). Nella pagina il pallino colorato è sempre accompagnato dal testo dell'età.
  const ageClass = age => typeof age !== 'number' || Number.isNaN(age) ? 'rosso' : age < 5 * MIN_MS ? 'verde' : age < 15 * MIN_MS ? 'arancio' : 'rosso';

  // Punti 13, 63, 42: posizione stimata, riproduzione in differita e animazione limitata (test in test/movimento.test.js).
  // Un fix è { lat, lon, sog, cog, heading, navStat, ts } con ts in ms (toMs); una posizione mostrata è
  // { lat, lon, cog, sog, heading, mode, aheadMs } con mode 'fix' (ultimo segnale), 'interp' (fra due segnali)
  // o 'estimate' (proiettata da velocità e rotta, aheadMs ms oltre il fix).
  const KN = 0.514444;               // 1 nodo in m/s
  const R_EARTH = 6371008.8;         // raggio medio della Terra (m)
  const ANIM_DELAY_MS = 15000;       // ritardo della riproduzione = intervallo di aggiornamento della pagina
  const RAD = Math.PI / 180;
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  // Longitudine in [-180, 180); i valori già nell'intervallo restano identici (niente errori di arrotondamento)
  const normLon = x => x >= -180 && x < 180 ? x : ((x + 180) % 360 + 360) % 360 - 180;
  // COG valida: numero in [0, 360) (360 = non disponibile)
  const validCog = c => finite(c) && c >= 0 && c < 360;

  // Per quanto si stima oltre il fix (ms), dai limiti di Boat Watch: niente stima fino a 0,5 kn (come isStill) o senza
  // velocità nota; 242 s fino a 3 kn compresi; 122 s oltre. 0 = nessuna stima.
  function estimateLimitMs(sog) {
    if (!finite(sog) || sog < 0 || sog >= 102.3 || sog <= 0.5) return 0;
    return sog <= 3 ? 242000 : 122000;
  }
  // Stimabile: velocità utile, COG valida (solo la rotta, mai la prua: la nave può derivare) e nave non ferma (punto 8)
  const canEstimate = p => estimateLimitMs(p.sog) > 0 && validCog(p.cog) && !isStill(p);

  // Punto d'arrivo lungo una lossodromia (rotta a direzione costante) di distM metri con rotta bearingDeg.
  // Oltre un polo la latitudine si riflette; longitudine in [-180, 180).
  function rhumbDestination(lat, lon, bearingDeg, distM) {
    const d = distM / R_EARTH, th = bearingDeg * RAD, p1 = lat * RAD;
    let p2 = p1 + d * Math.cos(th);
    if (Math.abs(p2) > Math.PI / 2) p2 = p2 > 0 ? Math.PI - p2 : -Math.PI - p2;
    const dPsi = Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
    const q = Math.abs(dPsi) > 1e-12 ? (p2 - p1) / dPsi : Math.cos(p1);
    const dLon = d * Math.sin(th) / q;
    return { lat: p2 / RAD, lon: normLon(lon + dLon / RAD) };
  }

  // Posizione del fix p proiettata all'ora now (punto 13, come Lat_projected di OpenCPN), al massimo estimateLimitMs
  function project(p, now) {
    const out = { lat: p.lat, lon: p.lon, cog: p.cog, sog: p.sog, heading: p.heading, mode: 'fix', aheadMs: 0 };
    if (!canEstimate(p) || !finite(p.ts)) return out;
    const aheadMs = Math.min(Math.max(finite(now) ? now - p.ts : 0, 0), estimateLimitMs(p.sog));
    const to = aheadMs > 0 ? rhumbDestination(p.lat, p.lon, p.cog, p.sog * KN * aheadMs / 1000) : p;
    return { ...out, lat: to.lat, lon: to.lon, mode: 'estimate', aheadMs };
  }

  // Angolo fra a e b (gradi) alla frazione f, girando dal lato più corto; risultato in [0, 360)
  const lerpAngle = (a, b, f) => (a + (((b - a) % 360 + 540) % 360 - 180) * f + 360) % 360;

  // Posizione fra i fix a e b all'ora t (punto 42, come MyShipTracking): lat lineare, lon dal lato corto, rotta e prua
  // dal lato corto se valide in entrambi (altrimenti quelle di b; la prua arrotondata al grado, come nei messaggi AIS),
  // velocità lineare se nota in entrambi (altrimenti quella di b). Fuori da [a.ts, b.ts] resta all'estremo.
  function interpolate(a, b, t) {
    const span = b.ts - a.ts;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - a.ts) / span)) || 0 : 1;
    const dLon = ((b.lon - a.lon + 540) % 360) - 180;
    const ha = validHeading(a.heading), hb = validHeading(b.heading);
    return {
      // agli estremi le coordinate esatte del fix (niente errori di arrotondamento)
      lat: f === 1 ? b.lat : a.lat + (b.lat - a.lat) * f,
      lon: f === 1 ? b.lon : normLon(a.lon + dLon * f),
      cog: validCog(a.cog) && validCog(b.cog) ? lerpAngle(a.cog, b.cog, f) : b.cog,
      sog: validSog(a.sog) && validSog(b.sog) ? a.sog + (b.sog - a.sog) * f : b.sog,
      heading: ha != null && hb != null ? Math.round(lerpAngle(ha, hb, f)) % 360 : b.heading,
      mode: 'interp', aheadMs: 0,
    };
  }

  // Traccia di una nave (ultimi max fix, dal più vecchio): array nuovo. Un fix non più recente dell'ultimo è ignorato;
  // un fix senza ora valida, o una traccia il cui ultimo fix non ha ora valida, ricomincia da [fix].
  function pushFix(track, fix, max = 3) {
    const last = track?.length ? track[track.length - 1] : null;
    if (!last || !finite(fix.ts) || !finite(last.ts)) return [fix];
    if (!(fix.ts > last.ts)) return track.slice();
    return [...track, fix].slice(-max);
  }

  // Posizione da mostrare all'ora t (di riproduzione): prima del primo fix il primo, fra due fix interpolate,
  // oltre l'ultimo la stima del punto 13. Traccia vuota = null.
  function positionAt(track, t) {
    if (!track?.length) return null;
    const first = track[0];
    if (t <= first.ts) return { lat: first.lat, lon: first.lon, cog: first.cog, sog: first.sog, heading: first.heading, mode: 'fix', aheadMs: 0 };
    for (let i = 1; i < track.length; i++) if (t <= track[i].ts) return interpolate(track[i - 1], track[i], t);
    return project(track[track.length - 1], t);
  }

  // Ora di riproduzione: now − delayMs (now = clock.now() del punto 43), mai indietro rispetto a prev
  const playbackTime = (now, delayMs = ANIM_DELAY_MS, prev = -Infinity) => Math.max(prev, now - delayMs);

  // Metri per pixel di Web Mercator (tile di 256 px) alla latitudine lat e allo zoom zoom
  const metersPerPixel = (lat, zoom) => 156543.03392 * Math.cos(lat * RAD) / 2 ** zoom;

  // Spostamento equirettangolare in metri da a a b (x verso est, y verso nord), lon dal lato corto
  function offsetM(a, b) {
    const dLon = ((b.lon - a.lon + 540) % 360) - 180;
    return { x: dLon * RAD * Math.cos((a.lat + b.lat) / 2 * RAD) * R_EARTH, y: (b.lat - a.lat) * RAD * R_EARTH, dLon };
  }
  // Posizione da disegnare a questo passo: dalla posizione mostrata shown verso target senza salti (punto 13: all'arrivo
  // del fix vero). Senza shown o oltre snapM metri salta al target; se il target è dietro (componente lungo target.cog
  // negativa) entro maxBackM la nave resta ferma invece di tornare indietro; altrimenti fa la frazione dtMs/blendMs
  // della strada. I campi diversi da lat/lon sono sempre quelli del target.
  function approach(shown, target, { dtMs, blendMs = 1000, maxBackM = 300, snapM = 5000 } = {}) {
    if (!shown) return { ...target };
    const o = offsetM(shown, target), dist = Math.hypot(o.x, o.y);
    if (!(dist <= snapM)) return { ...target };
    if (validCog(target.cog) && dist <= maxBackM && o.x * Math.sin(target.cog * RAD) + o.y * Math.cos(target.cog * RAD) < 0)
      return { ...target, lat: shown.lat, lon: shown.lon };
    const k = !(blendMs > 0) ? 1 : finite(dtMs) && dtMs > 0 ? Math.min(1, dtMs / blendMs) : 0;
    return { ...target, lat: shown.lat + (target.lat - shown.lat) * k, lon: normLon(shown.lon + o.dLon * k) };
  }

  // Priorità di animazione (punto 63, allineato a sample.js senza classe e movimento: si animano solo navi in moto):
  // selezionata +1000; tipo 60-89 +1; lunghezza log2(m / 10) da 0 a 5 (metri interi); -1 ogni 10 min di età, al massimo -3.
  function animPriority(p, v, isSelected, now) {
    let s = isSelected ? 1000 : 0;
    if (v?.shipType >= 60 && v?.shipType <= 89) s += 1;
    const len = Math.round(v?.length);
    if (len > 0) s += Math.min(5, Math.max(0, Math.log2(len / 10)));
    const age = finite(p.ts) && finite(now) ? Math.max(0, now - p.ts) : Infinity;
    return s - Math.min(3, Math.floor(age / (10 * MIN_MS)));
  }
  // MMSI da animare: items = [{ mmsi, score }], per score decrescente poi MMSI crescente, i primi n
  const pickAnimated = (items, n) => [...items].sort((a, b) => b.score - a.score || a.mmsi - b.mmsi).slice(0, Math.max(0, n)).map(x => x.mmsi);

  // Ogni quanti ms fare un passo: almeno 4 volte il ridisegno misurato e il tempo per mezzo pixel della nave più veloce
  // sullo schermo (maxPxPerS px/s; 0 = niente si muove), fra minMs e maxMs
  function frameInterval({ redrawMs, maxPxPerS, minMs = 16, maxMs = 1000 }) {
    const redraw = finite(redrawMs) ? redrawMs : 0;
    const halfPx = maxPxPerS > 0 ? 500 / maxPxPerS : Infinity;
    return Math.min(maxMs, Math.max(minMs, 4 * redraw, halfPx));
  }

  // Area della vista [w, s, e, n] (e < w = attraversa l'antimeridiano), come viewBox() della pagina ma senza margine:
  // più di un giro = mondo intero, longitudini in [-180, 180), latitudini entro ±90
  function boundsBox(w, s, e, n) {
    if (e - w >= 360) return [-180, -90, 180, 90];
    return [normLon(w), Math.max(s, -90), normLon(e), Math.min(n, 90)];
  }
  // Punto dentro l'area (bordi inclusi); box null = tutto. Nome diverso da inBox(box, p) di server.js.
  function inViewBox(box, lat, lon) {
    if (!box) return true;
    const [w, s, e, n] = box;
    if (lat < s || lat > n) return false;
    return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
  }

  // Punto 86: server della pagina da config.js (cfg = window). BOATRADAR_APIS = [{url, name, sleeps}] o stringhe, nell'ordine
  // di preferenza (prima la VM, poi Render che si addormenta); se non dà nessun indirizzo valido BOATRADAR_API, poi '/api'
  // (server.js della pagina stessa). Indirizzi senza / finale, doppioni e voci non valide (né http(s):// né /percorso,
  // spazi o virgolette) scartati; name null se manca, sleeps solo se true.
  const API_URL_RE = /^(https?:\/\/[^\s"'<>\\`]+|\/[^\s"'<>\\`]+)$/i;
  function apiList(cfg) {
    const read = raw => {
      const out = [];
      for (const x of Array.isArray(raw) ? raw : []) {
        const o = typeof x === 'string' ? { url: x } : x && typeof x === 'object' ? x : null;
        const url = typeof o?.url === 'string' ? o.url.trim().replace(/\/+$/, '') : '';
        if (!API_URL_RE.test(url) || out.some(b => b.url.toLowerCase() === url.toLowerCase())) continue;
        out.push({ url, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null, sleeps: o.sleeps === true });
      }
      return out;
    };
    const list = read(cfg?.BOATRADAR_APIS);
    if (list.length) return list;
    const one = read([cfg?.BOATRADAR_API]);
    return one.length ? one : [{ url: '/api', name: null, sleeps: false }];
  }

  // Passaggio automatico fra i server di list (apiList). Lo decide solo la richiesta della vista: fail(url, t) dopo un
  // errore (t = ora in ms), ok(url) dopo una risposta. Dopo un errore il server si riprova solo da t + baseMs·2^(errori−1),
  // al massimo maxMs (canTry, retryIn). Un server che dorme (sleeps, Render) e non ha ancora risposto da quando è attivo
  // resta attivo per wakeGraceMs dal primo errore (waking: «in avvio»); altrimenti si passa al successivo, in giro, che
  // si possa già riprovare, e se nessuno si può riprovare si resta su quello pronto per primo. Nessun ritorno automatico
  // al primo: si cambia solo dopo un errore, e una risposta (anche tardiva) di un altro server non sposta l'attivo.
  // Errori di un server non più attivo, o arrivati durante l'attesa (richieste partite prima dell'errore precedente),
  // sono ignorati: due richieste fallite insieme contano una volta. onChange(server) ai cambi.
  function createFailover(list, { saved = null, onChange = () => {}, baseMs = 5000, maxMs = 60000, wakeGraceMs = 90000 } = {}) {
    const st = list.map(() => ({ failures: 0, retryAt: 0, firstErrorAt: null, answered: false }));
    let idx = Math.max(0, list.findIndex(b => b.url === saved));
    let wakingNow = false;
    const indexOf = url => list.findIndex(b => b.url === url);
    function fail(url, t) {
      if (indexOf(url) !== idx || t < st[idx].retryAt) return;
      const s = st[idx];
      s.failures++;
      s.retryAt = t + Math.min(maxMs, baseMs * 2 ** (s.failures - 1));
      if (s.firstErrorAt == null) s.firstErrorAt = t;
      wakingNow = list[idx].sleeps && !s.answered && t - s.firstErrorAt < wakeGraceMs;
      if (wakingNow) return;
      let next = -1;
      for (let k = 1; k < list.length && next < 0; k++) { const j = (idx + k) % list.length; if (st[j].retryAt <= t) next = j; }
      if (next < 0) for (let k = 0; k < list.length; k++) {
        const j = (idx + k) % list.length;
        if (next < 0 || st[j].retryAt < st[next].retryAt) next = j;
      }
      if (next === idx) return;
      idx = next;
      // appena attivo: un server che dorme può essersi riaddormentato, l'attesa di avvio riparte dal suo prossimo errore
      st[idx].firstErrorAt = null; st[idx].answered = false;
      onChange(list[idx]);
    }
    function ok(url) {
      const i = indexOf(url);
      if (i < 0) return;
      Object.assign(st[i], { failures: 0, retryAt: 0, firstErrorAt: null, answered: true });
      if (i === idx) wakingNow = false;
    }
    return {
      current: () => list[idx],
      canTry: t => t >= st[idx].retryAt,
      retryIn: t => Math.max(0, st[idx].retryAt - t),
      waking: () => wakingNow,
      ok, fail,
    };
  }

  return { TYPES, typeOf, typeName, validHeading, heading, symbol, stopped, decodeEta, matchesQuery, SOURCE_LABEL, toMs, isNewer, STATIC_FIELDS, mergeFeatures,
    clockSample, createClock, includeParam, DEFAULT_LIMITS, normLimits, validSog, isStill, retentionMs, ageMs, fadeOpacity, ageStyle, formatAge, ageClass,
    KN, R_EARTH, ANIM_DELAY_MS, estimateLimitMs, canEstimate, rhumbDestination, project, lerpAngle, interpolate, pushFix, positionAt, playbackTime, metersPerPixel, approach, animPriority, pickAnimated, frameInterval, inViewBox, boundsBox,
    apiList, createFailover };
});
