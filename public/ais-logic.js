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
  // Opacità per età (come fadeCurve di AIS-catcher): 1 fino a fullMs, poi lineare fino a min a endMs, poi min.
  // Età non valida (NaN) = la più vecchia.
  function fadeOpacity(age, { fullMs = 2 * MIN_MS, endMs = 30 * MIN_MS, min = 0.2 } = {}) {
    if (!(age > fullMs)) return Number.isNaN(age) ? min : 1;
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

  return { TYPES, typeOf, typeName, validHeading, heading, symbol, stopped, decodeEta, matchesQuery, SOURCE_LABEL, toMs, isNewer, STATIC_FIELDS, mergeFeatures,
    clockSample, createClock, includeParam, DEFAULT_LIMITS, validSog, isStill, retentionMs, ageMs, fadeOpacity, ageStyle, formatAge };
});
