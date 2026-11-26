// BoatRadar: controllo delle posizioni AIS (punto 1 del Piano). Funzioni pure, senza stato:
// server.js tiene la posizione accettata e l'eventuale candidato di ogni nave.
// Soglie riprese da AIS-catcher (PositionCheck.h): 60 nodi più mezzo miglio di margine.
'use strict';

const MAX_SPEED_KN = 60, MARGIN_NM = 0.5;
const STILL_SOG_KN = 0.2, STILL_MAX_M = 200, STILL_WINDOW_S = 15 * 60;
const UNKNOWN_AFTER_S = 30 * 60;
const EARTH_RADIUS_NM = 3440.065;

// Posizione utilizzabile: non segnata non valida, numeri finiti dentro la scala e non il punto (0,0)
// dei trasmettitori guasti. Valid === false e non !Valid: molte fonti (e i test) non mettono il campo.
function isValidFix(pos) {
  const lat = pos.Latitude, lon = pos.Longitude;
  return pos.Valid !== false && Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

// Distanza ortodromica (haversine) in miglia nautiche; a e b = { lat, lon }
function distanceNm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Confronta due posizioni { lat, lon, sog, ts (ms) }: 'ok', 'jump' (spostamento impossibile)
// o 'unknown' (troppo distanti nel tempo per giudicare). Con speedOnly vale solo la regola di velocità.
function judge(prev, next, { speedOnly = false } = {}) {
  const dt = Math.max(0, (next.ts - prev.ts) / 1000);
  if (dt > UNKNOWN_AFTER_S) return 'unknown';
  const d = distanceNm(prev, next);
  if (d > MAX_SPEED_KN * (dt + 1) / 3600 + MARGIN_NM) return 'jump';
  if (speedOnly) return 'ok';
  // nave ferma (102.3 = velocità non disponibile, non conta) che si sposta di colpo
  const still = typeof prev.sog === 'number' && prev.sog <= STILL_SOG_KN;
  if (still && dt <= STILL_WINDOW_S && d * 1852 > STILL_MAX_M) return 'jump';
  return 'ok';
}

// Decide se accettare next. Un salto diventa candidato: lo accetto quando la posizione successiva
// è coerente con il candidato (la nave si è davvero spostata, oppure la precedente era sbagliata).
// Per la conferma conta solo la velocità: una nave in moto che trasmette sempre SOG 0 non resta bloccata.
function step(prev, candidate, next) {
  if (!prev) return { accept: true, candidate: null };
  if (judge(prev, next) !== 'jump') return { accept: true, candidate: null };
  if (candidate && judge(candidate, next, { speedOnly: true }) === 'ok') return { accept: true, candidate: null };
  return { accept: false, candidate: next };
}

// Toglie da map (mmsi -> { ts, ... }) le voci più vecchie di limit (ms); restituisce la stessa map
function pruneOlder(map, limit) {
  for (const [key, value] of map) if (value.ts < limit) map.delete(key);
  return map;
}

module.exports = { isValidFix, distanceNm, judge, step, pruneOlder };
