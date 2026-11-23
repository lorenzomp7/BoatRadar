// Rimanda al vero server.js tutti i messaggi di test/fixtures/aisstream-*.json (registrati con Proxelar
// o, per aisstream-esempio.json, scritti a mano) e controlla che il server li regga senza rete esterna.
// I controlli valgono anche dopo il punto 1 del Piano (scarto delle posizioni non valide).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, waitFor } = require('./helpers');
const { isAnomalous } = require('../tools/estrai-fixture');

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
      const expected = fixture.messaggi.filter(m => !m.error).length;
      await waitFor(async () => (await s.getJson('/api/status')).messages >= before + expected, 'tutti i messaggi elaborati');

      // ultima posizione valida di ogni nave nella fixture
      const valid = new Map();
      for (const msg of fixture.messaggi) {
        const pos = POSITION_TYPES.map(t => msg.Message?.[t]).find(Boolean);
        if (!pos || !msg.MetaData?.MMSI) continue;
        // dopo una posizione anomala lo stato di quella nave dipende dal punto 1: non la controllo
        if (isAnomalous(msg)) valid.delete(msg.MetaData.MMSI); else valid.set(msg.MetaData.MMSI, pos);
      }
      const res = await s.get('/api/locations');
      assert.equal(res.status, 200);
      const geo = JSON.parse(res.body.toString('utf8'));
      assert.equal(geo.type, 'FeatureCollection');
      const shown = new Map(geo.features.map(f => [f.mmsi, f.geometry.coordinates]));
      for (const [mmsi, pos] of valid) {
        assert.deepEqual(shown.get(mmsi), [pos.Longitude, pos.Latitude], `nave ${mmsi} in [lon, lat]`);
      }
      for (const f of geo.features) assert.equal(f.geometry.coordinates.length, 2);
      // il server risponde ancora a tutte le API
      assert.equal((await s.get('/api/search?q=' + encodeURIComponent('LA'))).status, 200);
    } finally { s.stop(); }
  });
}
