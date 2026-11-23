// Test di tools/estrai-fixture.js su una piccola sessione Proxelar finta (formato nativo, versione 3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../tools/estrai-fixture');

const bytes = obj => [...Buffer.from(JSON.stringify(obj))];
const pos = (mmsi, lat, lon) => ({ MessageType: 'PositionReport', MetaData: { MMSI: mmsi },
  Message: { PositionReport: { Latitude: lat, Longitude: lon, Sog: 5, Cog: 90, Valid: true } } });

function session() {
  const frames = [
    { direction: 'ClientToServer', opcode: 'Text', time: 1000, truncated: false,
      payload: bytes({ APIKey: 'segretissima-123', BoundingBoxes: [[[-90, -180], [90, 180]]] }) },
    { direction: 'ServerToClient', opcode: 'Binary', time: 1100, truncated: false, payload: bytes(pos(1, 45, 12)) },
    { direction: 'ServerToClient', opcode: 'Binary', time: 1200, truncated: false, payload: bytes(pos(2, 91, 181)) },
    { direction: 'ServerToClient', opcode: 'Binary', time: 2100, truncated: false,
      payload: bytes({ MessageType: 'ShipStaticData', MetaData: { MMSI: 1 }, Message: { ShipStaticData: { Name: 'A' } } }) },
    { direction: 'ServerToClient', opcode: 'Binary', time: 3000, truncated: true, payload: [123] },
    { direction: 'ServerToClient', opcode: 'Ping', time: 3050, truncated: false, payload: [] },
    { direction: 'ServerToClient', opcode: 'Binary', time: 3100, truncated: false, payload: bytes(pos(3, 0, 0)) },
  ];
  return { version: 3, created_at: 1, flows: [], websockets: [
    { id: 1, closed: true, frames: [],
      request: { uri: 'wss://altro.example/ws', headers: [] }, response: { headers: [] } },
    { id: 2, closed: true, frames,
      request: { uri: 'https://stream.aisstream.io/v0/stream',
        headers: [{ name: 'Sec-WebSocket-Extensions', value: 'permessage-deflate; client_max_window_bits' }] },
      response: { headers: [{ name: 'Upgrade', value: 'websocket' }] } },
  ] };
}

test('legge solo la connessione verso aisstream e solo i frame dati inviati dal server', () => {
  const c = ex.readSession(session());
  assert.equal(c.length, 1);
  assert.match(c[0].uri, /aisstream/);
  assert.equal(c[0].frames.length, 5);          // niente frame del client, niente ping
  assert.equal(c[0].offered, 'permessage-deflate; client_max_window_bits');
  assert.equal(c[0].accepted, null);
});

test('rifiuta file che non sono sessioni native versione 3', () => {
  assert.throws(() => ex.readSession({ version: 2, websockets: [] }), /versione 3/);
  assert.throws(() => ex.readSession({ log: { entries: [] } }), /versione 3/);
});

test('misure: messaggi al secondo, tipi, anomalie e frame troncati', () => {
  const m = ex.measure(ex.readSession(session()));
  assert.equal(m.messages, 5);
  assert.equal(m.seconds, 2);
  assert.equal(m.perSecond, 2.5);
  assert.equal(m.types.PositionReport, 3);
  assert.equal(m.types.ShipStaticData, 1);
  assert.equal(m.anomalous, 2);                  // 91/181 e 0,0
  assert.equal(m.truncated, 1);
  assert.equal(m.invalid, 1);                    // il frame troncato non è JSON
  assert.match(ex.report('x', m), /toglie l'offerta di compressione/);
});

test('la scelta tiene le anomalie e i tipi rari, nell\'ordine di arrivo, entro il massimo', () => {
  const c = ex.readSession(session());
  const all = ex.pick(c, 100);
  assert.deepEqual(all.map(ex.messageType), ['PositionReport', 'PositionReport', 'ShipStaticData', 'PositionReport']);
  const two = ex.pick(c, 2);
  assert.equal(two.length, 2);
  assert.ok(two.every(ex.isAnomalous));          // con poco posto restano le posizioni anomale
});

test('isAnomalous riconosce i valori AIS «non disponibile», 0,0 e Valid false', () => {
  assert.equal(ex.isAnomalous(pos(1, 45, 12)), false);
  assert.equal(ex.isAnomalous(pos(1, 91, 12)), true);
  assert.equal(ex.isAnomalous(pos(1, 45, 181)), true);
  assert.equal(ex.isAnomalous(pos(1, 0, 0)), true);
  const notValid = pos(1, 45, 12); notValid.Message.PositionReport.Valid = false;
  assert.equal(ex.isAnomalous(notValid), true);
  assert.equal(ex.isAnomalous({ MetaData: { MMSI: 1 }, Message: { ShipStaticData: {} } }), false);
});

test('redact toglie APIKey a qualsiasi profondità e payloadText accetta byte, testo e base64', () => {
  assert.deepEqual(ex.redact({ a: [{ APIKey: 'x', b: 1 }], api_key: 'y' }), { a: [{ APIKey: '[rimossa]', b: 1 }], api_key: '[rimossa]' });
  assert.equal(ex.payloadText([123, 125]), '{}');
  assert.equal(ex.payloadText('{"a":1}'), '{"a":1}');
  assert.equal(ex.payloadText(Buffer.from('{"a":1}').toString('base64')), '{"a":1}');
});

test('la riga di comando salva una fixture senza chiave che il test delle fixture sa leggere', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boatradar-'));
  const input = path.join(dir, 's.proxelar.json');
  const out = path.join(dir, 'aisstream-prova.json');
  fs.writeFileSync(input, JSON.stringify(session()));
  const log = console.log; console.log = () => {};
  try { assert.equal(ex.main([input, '--out', out]), 0); } finally { console.log = log; }
  const text = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /segretissima/);
  const f = JSON.parse(text);
  assert.equal(f.messaggi.length, 4);
  assert.equal(f.misure.messages, 5);
  assert.equal(f.registrato, new Date(1100).toISOString());
  // nome di uscita che il test delle fixture non troverebbe
  const err = console.error; console.error = () => {};
  try { assert.equal(ex.main([input, '--out', path.join(dir, 'altro.json')]), 2); } finally { console.error = err; }
  fs.rmSync(dir, { recursive: true, force: true });
});
