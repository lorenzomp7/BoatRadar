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

  // Ricerca locale: la nave corrisponde a q se searchScore (punto 12, in fondo) è maggiore di 0
  function matchesQuery(v, mmsi, q) {
    return searchScore(v, mmsi, q) > 0;
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

  // Punto 9: filtri su tipo, stato di navigazione, velocità, ricezione recente e movimento. Gli stessi in /api/locations
  // (parametri types, status, minSog, maxSog, seen, moving, applicati prima del campione) e nella pagina.
  // Test in test/filtri-logica.test.js e test/filtri.test.js.
  // Gruppi dello stato di navigazione AIS (0-15); 'other' prende 9-15, stato mancante o non valido e la classe B.
  const NAV_GROUPS = [
    { key: 'underway', label: 'In navigazione', codes: [0, 8] },
    { key: 'anchor', label: 'All\'ancora', codes: [1] },
    { key: 'moored', label: 'Ormeggiata', codes: [5] },
    { key: 'fishing', label: 'In pesca', codes: [7] },
    { key: 'limited', label: 'Manovra limitata o incagliata', codes: [2, 3, 4, 6] },
    { key: 'other', label: 'Altro / non indicato', codes: [] },
  ];
  const navGroup = navStat => (NAV_GROUPS.find(g => g.codes.includes(navStat)) || NAV_GROUPS[NAV_GROUPS.length - 1]).key;

  // Testo di un parametro (null, numero o stringa); qualunque altra cosa o un errore = ''
  function paramText(x) {
    if (x == null) return '';
    if (typeof x === 'number') return String(x);
    if (typeof x !== 'string') return '';
    return x.trim();
  }
  // Numero decimale scritto per esteso (anche con esponente); '', esadecimale, Infinity, NaN, '5kn' = null
  function decimal(x) {
    const s = paramText(x);
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // Chiavi valide fra quelle separate da virgola, nell'ordine di list e senza doppioni; nessuna o tutte = null
  function keysOf(x, list) {
    const asked = new Set(paramText(x).split(',').map(k => k.trim()));
    const keys = list.map(t => t.key).filter(k => asked.has(k));
    return keys.length && keys.length < list.length ? keys : null;
  }
  // Arrotondamento a 1/scale; + 0 trasforma -0 in 0
  const roundTo = (n, scale) => Math.round(n * scale) / scale + 0;

  // Filtro normalizzato dai parametri q = { types, status, minSog, maxSog, seen, moving } (stringhe, come da URL):
  // { types, status, minSog, maxSog, seen, moving } con null = nessun vincolo, oppure null se nessun vincolo resta.
  // types e status: chiavi di TYPES e NAV_GROUPS separate da virgola (sconosciute scartate, tutte = nessun vincolo);
  // minSog e maxSog in nodi fra 0 e 102,2 arrotondati a 0,1 (minimo 0 = nessuno; minimo oltre il massimo = entrambi
  // ignorati); seen in minuti, > 0 e ≤ 1440, arrotondato a 0,01; moving '1' = in moto, '0' = ferme. Mai eccezioni.
  function parseFilter(q) {
    if (!q || typeof q !== 'object') return null;
    const sog = x => { const n = decimal(x); if (n === null) return null; const r = roundTo(n, 10); return r >= 0 && r <= 102.2 ? r : null; };
    let minSog = sog(q.minSog), maxSog = sog(q.maxSog);
    if (minSog === 0) minSog = null;
    if (minSog !== null && maxSog !== null && minSog > maxSog) minSog = maxSog = null;
    const seenN = decimal(q.seen), seenR = seenN === null ? null : roundTo(seenN, 100);
    const mv = paramText(q.moving);
    const f = { types: keysOf(q.types, TYPES), status: keysOf(q.status, NAV_GROUPS), minSog, maxSog,
      seen: seenR > 0 && seenR <= 1440 ? seenR : null, moving: mv === '1' ? true : mv === '0' ? false : null };
    return Object.values(f).some(v => v !== null) ? f : null;
  }

  // Forma canonica del filtro, solo i campi presenti in ordine fisso:
  // 'types=cargo,tanker&status=moored&minSog=5&maxSog=20&seen=15&moving=1'; '' senza filtro.
  // parseFilter dei suoi parametri restituisce lo stesso filtro (la usano la chiave della cache e localStorage).
  function filterKey(f) {
    if (!f) return '';
    const parts = [];
    if (f.types) parts.push('types=' + f.types.join(','));
    if (f.status) parts.push('status=' + f.status.join(','));
    for (const k of ['minSog', 'maxSog', 'seen']) if (f[k] != null) parts.push(`${k}=${f[k]}`);
    if (f.moving != null) parts.push('moving=' + (f.moving ? 1 : 0));
    return parts.join('&');
  }

  // true se la posizione p = { sog, navStat, ts } della nave v = { shipType } passa il filtro f all'ora now (ms).
  // Velocità non nota (mancante o 102,3) non passa né minimo né massimo; seen: età ≤ seen minuti, ora non valida no;
  // moving: in moto = non ferma (isStill del punto 8), così in moto e ferme dividono tutte le navi. f null = passa.
  function passesFilter(p, v, f, now) {
    if (!f) return true;
    if (f.types && !f.types.includes(typeOf(v?.shipType).key)) return false;
    if (f.status && !f.status.includes(navGroup(p.navStat))) return false;
    if (f.minSog != null && !(validSog(p.sog) && p.sog >= f.minSog)) return false;
    if (f.maxSog != null && !(validSog(p.sog) && p.sog <= f.maxSog)) return false;
    if (f.seen != null && !(now - toMs(p.ts) <= f.seen * MIN_MS)) return false;
    if (f.moving != null && isStill(p) === f.moving) return false;
    return true;
  }

  // Quanti criteri sono attivi (per «· 2 attivi»): tipi, stato, velocità (da e a contano una volta), ricezione, movimento
  const filterCount = f => !f ? 0 : [f.types, f.status, f.minSog ?? f.maxSog, f.seen, f.moving].filter(x => x != null).length;

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

  // Prove del primo server (ritorno alla VM, quota di Render), usate da createFailover. due(t, force) dice true una volta
  // ogni intervallo e segna la prova in corso; finché non arriva end(t), failed(t) o returned(t) non ne dice altre.
  // Intervallo: recheckMs (5 min); se il primo ricade (primaryLeft) entro flapMs (10 min) da un ritorno con la prova
  // (returned) raddoppia (10, 20, al massimo recheckMaxMs, 40 min), e torna recheckMs se il primo è restato stabile per
  // stableMs (30 min, da returned o da primaryBack, il ritorno per errore dell'altro server). force (scheda riaperta) non
  // aspetta l'intervallo, ma solo se l'ultima prova è finita da almeno forceGapMs (60 s) e l'intervallo non è raddoppiato;
  // startNow (si parte da un server salvato, ricaricando la scheda): la prima prova è subito. failed(t): la prossima da
  // t + intervallo; end(t): prova finita senza ritorno, l'ora resta quella fissata all'inizio della prova.
  // backupChanged(t): passaggio fra due server di riserva, l'ora fissata resta (se non c'è, da t + intervallo).
  function createRecheck({ startNow = false, recheckMs = 300000, recheckMaxMs = 2400000, flapMs = 600000,
    stableMs = 1800000, forceGapMs = 60000 } = {}) {
    // prossima prova (null: da fissare; -Infinity: subito), prova in corso, fine dell'ultima prova
    let at = startNow ? -Infinity : null, running = false, endedAt = null;
    let level = 0, returnedAt = null, primarySince = null;   // raddoppi dell'intervallo, ultimo ritorno con la prova
    const interval = () => Math.min(recheckMaxMs, recheckMs * 2 ** level);
    const end = t => { running = false; endedAt = t ?? null; };
    return {
      due(t, force = false) {
        if (running) return false;
        const forced = force && level === 0 && (endedAt == null || t - endedAt >= forceGapMs);
        if (!forced) {
          if (at == null) { at = t + interval(); return false; }
          if (t < at) return false;
        }
        running = true; at = t + interval();   // se la prova non finisce bene, la prossima fra un intervallo
        return true;
      },
      end,
      failed(t) { end(t); at = t + interval(); },
      returned(t) { end(t); at = null; returnedAt = t ?? null; primarySince = t ?? null; },
      primaryLeft(t) {   // il primo ricade: oscillazione se è appena tornato con la prova, stabile dopo stableMs
        if (returnedAt != null && t - returnedAt < flapMs) level = Math.min(level + 1, 16);
        else if (primarySince == null || t - primarySince >= stableMs) level = 0;
        returnedAt = null;
        at = t + interval();
      },
      primaryBack(t) { at = null; primarySince = t; },
      backupChanged(t) { if (at == null) at = t + interval(); },
      level: () => level,
    };
  }

  // Passaggio automatico fra i server di list (apiList). Lo decide solo la richiesta della vista: fail(url, t) dopo un
  // errore (t = ora in ms), ok(url, t) dopo una risposta. Un server che non dorme (la VM) si lascia solo dopo due errori
  // di fila: il primo lo fa riprovare da t + confirmMs (3 s), un errore isolato non fa passare a Render (quota). Poi il
  // server si riprova solo da t + baseMs·2^(n−1), al massimo maxMs (canTry, retryIn). fail(url, t, {counts: false})
  // (rete dell'utente assente, networkDown) non avvicina al passaggio: fa solo riprovare dopo un'attesa crescente a parte
  // (downWaitsMs: 3, 5, 10, 20, 40, poi sempre 60 s), azzerata da una risposta o da un errore che conta; networkBack(t)
  // (evento online) dopo errori di questo tipo fa riprovare subito e dice true.
  // Avvio di un server che dorme (sleeps, Render): lastSeenAt è il suo ultimo contatto (errore o risposta), wakeSince
  // l'inizio dell'avvio. L'avvio parte al suo primo errore se non lo si sente da rewakeMs (15 min, dopo i quali Render si
  // addormenta; o mai sentito) e finisce con una risposta o dopo wakeGraceMs (90 s): intanto si resta su di lui (waking:
  // «in avvio»). Se ha sbagliato o risposto da poco è sveglio e un suo errore fa passare subito. Vale anche con un solo
  // server. Altrimenti si passa al successivo, in giro, che si possa già riprovare, e se nessuno si può riprovare si
  // resta su quello pronto per primo. Una risposta (anche tardiva) di un altro server non sposta l'attivo. Errori di un
  // server non più attivo, o arrivati durante l'attesa (richieste partite prima dell'errore precedente), sono ignorati:
  // due richieste fallite insieme contano una volta. onChange(server) ai cambi.
  // Ritorno al primo (quota di Render, createRecheck): su un server diverso dal primo shouldRecheck(t) dice true una volta
  // ogni intervallo e segna la prova in corso; finché non arriva recheckOk(url, t) o recheckFailed(t) non ne dice altre.
  // shouldRecheck(t, true) (scheda tornata visibile) non aspetta l'intervallo se l'ultima prova è finita da almeno
  // forceGapMs (60 s) e l'intervallo non è raddoppiato. Partendo da un server salvato diverso dal primo la prima prova è
  // subito (ricaricando la scheda). recheckOk(url del primo, t) torna al primo; recheckFailed(t) riprova da
  // t + intervallo (recheckOk di un altro indirizzo: dall'inizio della prova). La prova non conta come errore né come
  // risposta del server attivo. Intervallo: recheckMs (5 min), raddoppiato se il primo oscilla (createRecheck).
  function createFailover(list, { saved = null, onChange = () => {}, baseMs = 5000, maxMs = 60000, confirmMs = 3000,
    downWaitsMs = [3000, 5000, 10000, 20000, 40000, 60000], wakeGraceMs = 90000, rewakeMs = 15 * 60000,
    recheckMs = 300000, recheckMaxMs = 2400000, flapMs = 600000, stableMs = 1800000, forceGapMs = 60000 } = {}) {
    const st = list.map(() => ({ failures: 0, strikes: 0, retryAt: 0, down: 0, lastSeenAt: null, wakeSince: null }));
    let idx = Math.max(0, list.findIndex(b => b.url === saved));
    let wakingNow = false;
    const recheck = createRecheck({ startNow: idx !== 0, recheckMs, recheckMaxMs, flapMs, stableMs, forceGapMs });
    const indexOf = url => list.findIndex(b => b.url === url);
    const answered = (s, t) => Object.assign(s, { failures: 0, strikes: 0, retryAt: 0, down: 0, wakeSince: null },
      t != null && { lastSeenAt: t });
    function fail(url, t, { counts = true } = {}) {
      if (indexOf(url) !== idx || t < st[idx].retryAt) return;
      const s = st[idx];
      if (!counts) { s.retryAt = t + downWaitsMs[Math.min(s.down++, downWaitsMs.length - 1)]; return; }
      s.down = 0;
      if (list[idx].sleeps) {   // avvio: scaduto dopo wakeGraceMs; riparte solo se non lo si sente da rewakeMs
        if (s.wakeSince != null && t - s.wakeSince >= wakeGraceMs) s.wakeSince = null;
        if (s.wakeSince == null && (s.lastSeenAt == null || t - s.lastSeenAt >= rewakeMs)) s.wakeSince = t;
      }
      s.lastSeenAt = t;
      s.strikes++;
      if (!list[idx].sleeps && s.strikes === 1) { s.retryAt = t + confirmMs; wakingNow = false; return; }
      s.failures++;
      s.retryAt = t + Math.min(maxMs, baseMs * 2 ** (s.failures - 1));
      wakingNow = s.wakeSince != null;
      if (wakingNow) return;
      let next = -1;
      for (let k = 1; k < list.length && next < 0; k++) { const j = (idx + k) % list.length; if (st[j].retryAt <= t) next = j; }
      if (next < 0) for (let k = 0; k < list.length; k++) {
        const j = (idx + k) % list.length;
        if (next < 0 || st[j].retryAt < st[next].retryAt) next = j;
      }
      if (next === idx) return;
      if (idx === 0) recheck.primaryLeft(t);
      else if (next === 0) recheck.primaryBack(t);
      else recheck.backupChanged(t);
      idx = next;
      st[idx].strikes = 0;
      onChange(list[idx]);
    }
    function ok(url, t) {
      const i = indexOf(url);
      if (i < 0) return;
      answered(st[i], t);
      if (i === idx) wakingNow = false;
    }
    function networkBack(t) {
      const s = st[idx];
      if (!s.down) return false;
      s.down = 0;
      s.retryAt = Math.min(s.retryAt, t);
      return true;
    }
    function recheckOk(url, t) {
      if (url !== list[0].url || idx === 0) { recheck.end(t); return; }
      answered(st[0], t);
      idx = 0; wakingNow = false;
      recheck.returned(t);
      onChange(list[0]);
    }
    return {
      current: () => list[idx],
      canTry: t => t >= st[idx].retryAt,
      retryIn: t => Math.max(0, st[idx].retryAt - t),
      waking: () => wakingNow,
      shouldRecheck: (t, force = false) => idx !== 0 && recheck.due(t, force),
      recheckFailed: t => recheck.failed(t),
      ok, fail, networkBack, recheckOk,
    };
  }

  // Punto 86 (correzioni da revisione): l'errore della vista viene dalla rete dell'utente, non dal server, e non deve far
  // cambiare server (fail(..., {counts: false})) quando la vista non ha avuto risposta (viewNetwork: errore di rete o
  // nessuna risposta; una risposta di errore, per esempio 503, dice che la rete c'è e conta sempre) e il browser dice di
  // essere offline (onLine === false), oppure nello stesso giro anche il Baltico (Digitraffic, un altro sito) è fallito
  // con un errore di rete. Il Baltico vale come prova solo se è riuscito negli ultimi graceMs (2 min, balticOkAt): se è
  // bloccato (rete aziendale, filtri) o la rete manca da più tempo, l'errore conta e la pagina può passare all'altro server.
  function networkDown({ onLine, viewNetwork = false, balticNetwork = false, balticOkAt = null, t, graceMs = 120000 } = {}) {
    if (viewNetwork !== true) return false;
    if (onLine === false) return true;
    return balticNetwork === true && balticOkAt != null && Number.isFinite(t) && t - balticOkAt <= graceMs;
  }

  // Punto 10: area toccabile. pickRadius: distanza in px dal punto toccato entro cui una nave si può scegliere (il dito è
  // meno preciso del mouse); canvasTolerance: tolleranza del renderer canvas di Leaflet (area di hover e tooltip).
  const pickRadius = touch => (touch ? 20 : 8);
  const canvasTolerance = touch => (touch ? 12 : 4);
  // Marker entro radius px da point ({x, y}, punto del contenitore della mappa): items = [{mmsi, x, y, r}] già proiettati,
  // r facoltativo = raggio del singolo marker (la nave selezionata è più grande: la punta della sua freccia è a 2 × 8 px),
  // mai sotto radius; → [{mmsi, d}] dal più vicino, a parità di distanza per MMSI crescente (ordine stabile). Bordo
  // incluso; coordinate non numeriche scartate.
  function nearbyMarkers(point, items, radius) {
    const out = [];
    for (const it of items || []) {
      const d = Math.hypot(it.x - point.x, it.y - point.y);
      const r = Number.isFinite(it.r) ? Math.max(radius, it.r) : radius;
      if (Number.isFinite(d) && d <= r) out.push({ mmsi: it.mmsi, d });
    }
    return out.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.mmsi < b.mmsi ? -1 : a.mmsi > b.mmsi ? 1 : 0));
  }
  // Tocco o mouse per questo clic: pointerType dell'evento (PointerEvent di Chrome, Firefox, Safari recente) se c'è,
  // altrimenti fallback, il tipo di schermo (pointer: coarse). La penna è precisa come il mouse.
  const pickTouch = (ev, fallback) => (ev && typeof ev.pointerType === 'string' && ev.pointerType
    ? ev.pointerType === 'touch' : !!fallback);
  // Tetto all'elenco del popup: le prime max (già dalla più vicina) e quante ne restano fuori
  const PICK_MAX_ROWS = 15;
  const pickLimit = (list, max = PICK_MAX_ROWS) => ({ shown: (list || []).slice(0, max), more: Math.max(0, (list || []).length - max) });
  // Altezza massima in px del contenuto del popup (.leaflet-popup-content): lo spazio libero fra top (fondo dell'header)
  // e bottom (cima della scheda aperta o fondo della mappa), in px del contenitore della mappa, meno i margini dell'autoPan
  // sopra e sotto, la punta (tip: punta di Leaflet 20 px + margine sotto il popup 20 px) e chrome (margini del contenuto
  // 2 × 8, bordo e padding del riquadro 2 × 2); almeno min (titolo e tre righe da 48 px: oltre si scorre). Per difetto.
  const PICK_MIN_HEIGHT = 168;
  function pickMaxHeight({ top, bottom, margin = 10, tip = 40, chrome = 20, min = PICK_MIN_HEIGHT } = {}) {
    const h = Math.floor(bottom - top - 2 * margin - tip - chrome);
    return Number.isFinite(h) ? Math.max(min, h) : min;
  }

  // Punto 12: ricerca ordinata e riconoscibile (test in test/ricerca-logica.test.js). La usano server.js (/api/search) e la
  // pagina (unione con le navi in mappa), così l'ordine è lo stesso.
  // Testo confrontabile: senza accenti (NFD e segni combinanti tolti), maiuscolo, trattino, punto, barra e spazi (anche a
  // capo, tab) come un solo spazio, tolti ai lati; mancante = ''. «Città di» = «CITTA DI», «ANNA-MARIA» = «ANNA MARIA».
  function norm(s) {
    return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[\s\-./]+/g, ' ').trim();
  }
  // Testo della ricerca: norm e senza il prefisso «IMO » davanti alle cifre («IMO 9074729» = «9074729»)
  function normQuery(s) {
    return norm(s).replace(/^(IMO )+(?=\d)/, '');
  }
  // Punteggio con i campi già normalizzati (name e call con norm, q con normQuery e non vuota; id e imo stringhe, '' se
  // mancano: chi chiama può passare '' anche quando q non è fatta di cifre, perché allora non possono corrispondere).
  // Il criterio migliore fra MMSI o IMO esatto 100, nome esatto 90, nominativo esatto 80, inizio del nome 70, inizio di
  // MMSI o IMO 60, inizio di una parola del nome 50 (dopo uno spazio: norm ha già trasformato - . / in spazi), inizio del
  // nominativo 40, nome che contiene q 30; nessuno = 0. Un solo indexOf sul nome per i casi senza corrispondenza.
  function scoreFields(name, call, id, imo, q) {
    if (id === q || (imo && imo === q)) return 100;
    const i = name.indexOf(q);
    if (i === 0 && name.length === q.length) return 90;
    if (call === q) return 80;
    if (i === 0) return 70;
    if ((id && id.startsWith(q)) || (imo && imo.startsWith(q))) return 60;
    if (i > 0) for (let j = i; j > 0; j = name.indexOf(q, j + 1)) if (name.charCodeAt(j - 1) === 32) return 50;
    if (call && call.startsWith(q)) return 40;
    return i > 0 ? 30 : 0;
  }
  // Punteggio di una nave per q (normalizzata con normQuery). v = dati statici (name, imo, callSign), anche mancanti.
  function searchScore(v, mmsi, q) {
    q = normQuery(q);
    if (!q) return 0;
    v = v || {};
    return scoreFields(norm(v.name), norm(v.callSign), String(mmsi ?? ''), v.imo ? String(v.imo) : '', q);
  }
  // Ordine dei risultati { score, ts, mmsi }: punteggio decrescente, poi posizione più recente (toMs: orario mancante o
  // illeggibile = il più vecchio; confronto senza sottrazioni, quindi mai NaN), poi MMSI crescente: ordine stabile
  function compareSearch(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    const ta = toMs(a.ts), tb = toMs(b.ts);
    if (ta !== tb) return ta > tb ? -1 : 1;
    return a.mmsi < b.mmsi ? -1 : a.mmsi > b.mmsi ? 1 : 0;
  }
  // Inserisce hit in top (al massimo max, nell'ordine di compareSearch) senza ordinare tutte le corrispondenze: con top
  // pieno basta un confronto con l'ultima per scartare. Stesso risultato di sort(compareSearch).slice(0, max).
  function insertTop(top, hit, max) {
    let k = top.length;
    if (k >= max) {
      if (compareSearch(hit, top[max - 1]) >= 0) return;
      k = max - 1;
    }
    while (k > 0 && compareSearch(hit, top[k - 1]) < 0) { top[k] = top[k - 1]; k--; }
    top[k] = hit;
  }
  // Testo degli omonimi fra i risultati: '' sotto 2; «almeno N» se il conteggio può essere incompleto (tetto dei
  // risultati raggiunto, o nave trovata per MMSI, IMO o nominativo: le omonime possono non corrispondere)
  function twinsText(n, complete) {
    return n > 1 ? `${complete ? '' : 'almeno '}${n} navi con questo nome` : '';
  }
  // Quante navi per nome (norm) fra items = [{ name }]; nomi vuoti esclusi
  function homonymCounts(items) {
    const out = new Map();
    for (const it of items || []) {
      const n = norm(it?.name);
      if (n) out.set(n, (out.get(n) || 0) + 1);
    }
    return out;
  }
  // Seconda riga di un risultato: «tipo · bandiera · 180 m · 5 min fa · → DESTINAZIONE», senza le parti mancanti
  function resultLine({ typeName: type, flag, length, age, destination } = {}) {
    const text = x => (typeof x === 'string' && x.trim() ? x.trim() : null);
    const dest = text(destination);
    return [text(type), text(flag), finite(length) && length > 0 ? `${Math.round(length)} m` : null, text(age), dest && '→ ' + dest]
      .filter(Boolean).join(' · ');
  }

  return { TYPES, typeOf, typeName, validHeading, heading, symbol, stopped, decodeEta, matchesQuery, SOURCE_LABEL, toMs, isNewer, STATIC_FIELDS, mergeFeatures,
    clockSample, createClock, includeParam, DEFAULT_LIMITS, normLimits, validSog, isStill, retentionMs, ageMs, fadeOpacity, ageStyle, formatAge, ageClass,
    KN, R_EARTH, ANIM_DELAY_MS, estimateLimitMs, canEstimate, rhumbDestination, project, lerpAngle, interpolate, pushFix, positionAt, playbackTime, metersPerPixel, approach, animPriority, pickAnimated, frameInterval, inViewBox, boundsBox,
    NAV_GROUPS, navGroup, parseFilter, filterKey, passesFilter, filterCount,
    apiList, createRecheck, createFailover, networkDown,
    pickRadius, canvasTolerance, nearbyMarkers, pickTouch, PICK_MAX_ROWS, pickLimit, PICK_MIN_HEIGHT, pickMaxHeight,
    norm, normQuery, scoreFields, searchScore, compareSearch, insertTop, twinsText, homonymCounts, resultLine };
});
