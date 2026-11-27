// Punti 13, 42 (commit C): tools/smoke-server.js realistico. A ogni ripetizione le navi con SOG e COG valide si
// spostano coerenti con velocità e rotta (moved), così la verifica nel browser vede fix veri in successione; le altre
// (ferme, velocità o rotta non disponibili, messaggi statici) restano identiche. Il server non le scarta (punto 1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');
const { judge } = require('../position-check');
const { moved } = require('../tools/smoke-server');
const { messaggi } = require('./fixtures/aisstream-esempio.json');

const pos = m => Object.values(m.Message)[0];
const byMmsi = (mmsi, type) => messaggi.find(m => m.MetaData.MMSI === mmsi && Object.keys(m.Message)[0] === type);

test('smoke-server: in 20 s LAGUNA PRIMA (11,2 kn, rotta 87,5°) avanza di 115 m lungo la rotta', () => {
  const m = byMmsi(247123450, 'PositionReport'), copy = JSON.stringify(m);
  const out = moved(m, 20000), a = pos(m), b = pos(out);
  const exp = AL.rhumbDestination(a.Latitude, a.Longitude, 87.5, 11.2 * AL.KN * 20);
  assert.ok(Math.abs(b.Latitude - exp.lat) < 1e-12 && Math.abs(b.Longitude - exp.lon) < 1e-12);
  const d = AL.approach({ lat: a.Latitude, lon: a.Longitude }, { lat: b.Latitude, lon: b.Longitude, cog: 87.5 }, { dtMs: 1, blendMs: 0 });
  assert.equal(d.lat, b.Latitude, 'avanti lungo la rotta');
  assert.equal(JSON.stringify(m), copy, 'il messaggio originale non cambia');
  assert.equal(b.Sog, 11.2); assert.equal(b.Cog, 87.5);
  const prev = { lat: a.Latitude, lon: a.Longitude, sog: a.Sog, ts: 0 }, next = { lat: b.Latitude, lon: b.Longitude, sog: b.Sog, ts: 20000 };
  assert.equal(judge(prev, next), 'ok', 'il controllo delle posizioni del server lo accetta');
});

test('smoke-server: navi ferme, senza velocità o rotta e messaggi statici restano uguali; a 0 ms niente cambia', () => {
  for (const [mmsi, type] of [[538001234, 'PositionReport'], [636091111, 'PositionReport'], [636092222, 'PositionReport'],
    [247555001, 'PositionReport'], [247123450, 'ShipStaticData']]) {
    const m = byMmsi(mmsi, type);
    assert.equal(moved(m, 60000), m, `${mmsi} ${type}`);
  }
  const m = byMmsi(247123450, 'PositionReport');
  assert.equal(moved(m, 0), m);
  // classe B in moto: si sposta anche lei
  assert.notEqual(pos(moved(byMmsi(247987650, 'StandardClassBPositionReport'), 20000)).Latitude, pos(byMmsi(247987650, 'StandardClassBPositionReport')).Latitude);
});
