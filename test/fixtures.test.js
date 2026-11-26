// Rimanda al vero server.js tutti i messaggi di test/fixtures/aisstream-*.json (registrati con Proxelar
// o, per aisstream-esempio.json, scritti a mano) e controlla che il server li regga senza rete esterna.
// La posizione attesa di ogni nave si calcola con position-check.js, come fa il server (punto 1 del Piano).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, waitFor } = require('./helpers');
const { isValidFix, step } = require('../position-check');

const DIR = path.join(__dirname, 'fixtures');
const files = fs.readdirSync(DIR).filter(f => /^aisstream-.+\.json$/.test(f)).sort();
const POSITION_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'];

test('c\'è almeno una fixture aisstream', () => assert.ok(files.length >= 1));

for (const file of files) {
  test(`fixture ${file}: il server elabora i messaggi e mostra le posizioni valide`, async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.ok(Array.isArray(fixture.messaggi) && fixture.messaggi.length > 0, 'la fixture ha messaggi');
    assert.doesNotMatch(JSON.stringify(fixture), /"api_?key"\s*:\s*"(?!\[rimossa\])/i, 'nessuna chiave nella fixture');

    const s = await startServer();
    try {
      const before = (await s.getJson('/api/status')).messages;
      for (const msg of fixture.messaggi) s.socket.send(JSON.stringify(msg));
      // la conferma della sottoscrizione (punto 11) non è un messaggio AIS e non viene contata
      const expected = fixture.messaggi.filter(m => !m.error && m.MessageType !== 'SubscriptionConfirmation').length;
      await waitFor(async () => (await s.getJson('/api/status')).messages >= before + expected, 'tutti i messaggi elaborati');

      // posizione accettata di ogni nave: stessi controlli del server, con i messaggi arrivati a raffica
      const accepted = new Map(), candidates = new Map();
      fixture.messaggi.forEach((msg, i) => {
        const pos = POSITION_TYPES.map(t => msg.Message?.[t]).find(Boolean);
        const mmsi = msg.MetaData?.MMSI;
        if (!pos || !mmsi || !isValidFix(pos)) return;
        const fix = { lat: pos.Latitude, lon: pos.Longitude, sog: pos.Sog, ts: i };
        const r = step(accepted.get(mmsi), candidates.get(mmsi), fix);
        if (r.accept) accepted.set(mmsi, r.moving ? { ...fix, moving: true } : fix);
        if (r.candidate) candidates.set(mmsi, r.candidate); else candidates.delete(mmsi);
      });
      const res = await s.get('/api/locations');
      assert.equal(res.status, 200);
      const geo = JSON.parse(res.body.toString('utf8'));
      assert.equal(geo.type, 'FeatureCollection');
      const shown = new Map(geo.features.map(f => [f.mmsi, f.geometry.coordinates]));
      for (const [mmsi, fix] of accepted) {
        assert.deepEqual(shown.get(mmsi), [fix.lon, fix.lat], `nave ${mmsi} in [lon, lat]`);
      }
      for (const mmsi of shown.keys()) assert.ok(accepted.has(mmsi), `nave ${mmsi} senza posizione accettata`);
      for (const f of geo.features) assert.equal(f.geometry.coordinates.length, 2);
      // il server risponde ancora a tutte le API
      assert.equal((await s.get('/api/search?q=' + encodeURIComponent('LA'))).status, 200);
    } finally { await s.stop(); }
  });
}
