// Punti 25 e 24: funzioni pure dei link condivisibili (parseLink, viewHash, linkUrl) in
// public/ais-logic.js. Formato del link: ?mmsi=…&segui=1#lat,lon,zoom. Il comportamento nella pagina è in
// test/pagina-link.test.js e test/pagina-segui.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AL = require('../public/ais-logic');

const NONE = { view: null, mmsi: null, follow: false };

test('parseLink: vista #lat,lon,zoom, MMSI e segui=1', () => {
  assert.deepEqual(AL.parseLink('?mmsi=247123450&segui=1', '#45.4312,12.3355,14'),
    { view: { lat: 45.4312, lon: 12.3355, zoom: 14 }, mmsi: 247123450, follow: true });
  assert.deepEqual(AL.parseLink('', ''), NONE);
  assert.deepEqual(AL.parseLink(undefined, undefined), NONE, 'senza location');
  assert.deepEqual(AL.parseLink(null, null), NONE);
  // senza # e senza ? iniziali, numeri negativi e interi
  assert.deepEqual(AL.parseLink('mmsi=1', '-33.9,-70,5'), { view: { lat: -33.9, lon: -70, zoom: 5 }, mmsi: 1, follow: false });
  // altri parametri ignorati, ordine qualsiasi
  assert.deepEqual(AL.parseLink('?x=2&segui=1&mmsi=247000001', ''), { view: null, mmsi: 247000001, follow: true });
});

test('parseLink: latitudine portata entro ±85,0511, oltre ±90 vista non valida; longitudine normalizzata', () => {
  assert.equal(AL.parseLink('', '#89.5,10,4').view.lat, 85.0511);
  assert.equal(AL.parseLink('', '#-90,10,4').view.lat, -85.0511);
  assert.equal(AL.parseLink('', '#90.01,10,4').view, null);
  assert.equal(AL.parseLink('', '#-91,10,4').view, null);
  assert.equal(AL.parseLink('', '#10,190,4').view.lon, -170);
  assert.equal(AL.parseLink('', '#10,-180,4').view.lon, -180);
  assert.equal(AL.parseLink('', '#10,180,4').view.lon, -180);
  assert.equal(AL.parseLink('', '#10,540.5,4').view.lon, -179.5);
});

test('parseLink: zoom arrotondato fra 1 e 18', () => {
  assert.equal(AL.parseLink('', '#10,10,0').view.zoom, 1);
  assert.equal(AL.parseLink('', '#10,10,25').view.zoom, 18);
  assert.equal(AL.parseLink('', '#10,10,7.6').view.zoom, 8);
  assert.equal(AL.parseLink('', '#10,10,7.4').view.zoom, 7);
});

test('parseLink: testo non valido → vista null', () => {
  for (const h of ['#', '#abc', '#10,10', '#10,10,5,6', '#10,,5', '#1e3,10,5', '#0x10,10,5', '#10,10,5x', '# 10,10,5',
    '#Infinity,10,5', '#NaN,10,5', '#10;10;5', '#10.,10,5', '#.5,10,5', '#--1,10,5', '#10,10,-3', '#10,10,1,'])
    assert.equal(AL.parseLink('', h).view, null, h);
  assert.equal(AL.parseLink('', 12345).view, null, 'non stringa');
});

test('parseLink: MMSI da 1 a 9 cifre maggiore di 0; segui=1 vale solo con l\'MMSI', () => {
  for (const s of ['?mmsi=0', '?mmsi=000', '?mmsi=1234567890', '?mmsi=-5', '?mmsi=12a', '?mmsi=1.5', '?mmsi=', '?mmsi=%20%201',
    '?mmsi=1e5'])
    assert.equal(AL.parseLink(s, '').mmsi, null, s);
  assert.equal(AL.parseLink('?mmsi=999999999', '').mmsi, 999999999);
  assert.equal(AL.parseLink('?mmsi=007', '').mmsi, 7, 'zeri davanti: stesso numero');
  assert.deepEqual(AL.parseLink('?segui=1', ''), NONE, 'segui senza mmsi');
  assert.equal(AL.parseLink('?mmsi=5&segui=0', '').follow, false);
  assert.equal(AL.parseLink('?mmsi=5&segui=true', '').follow, false);
  assert.equal(AL.parseLink('?mmsi=0&segui=1', '').follow, false, 'MMSI non valido: niente segui');
  // MMSI ripetuto: vale il primo
  assert.equal(AL.parseLink('?mmsi=5&mmsi=6', '').mmsi, 5);
});

test('viewHash: cifre secondo lo zoom, senza zeri in coda né «-0»', () => {
  assert.equal(AL.viewHash({ lat: 45.123456, lon: 12.987654, zoom: 3 }), '#45.12,12.99,3');
  assert.equal(AL.viewHash({ lat: 45.123456, lon: 12.987654, zoom: 7 }), '#45.123,12.988,7');
  assert.equal(AL.viewHash({ lat: 45.123456, lon: 12.987654, zoom: 11 }), '#45.1235,12.9877,11');
  assert.equal(AL.viewHash({ lat: 45.123456, lon: 12.987654, zoom: 14 }), '#45.12346,12.98765,14');
  assert.equal(AL.viewHash({ lat: 45.4312, lon: 12.3355, zoom: 14 }), '#45.4312,12.3355,14');
  assert.equal(AL.viewHash({ lat: 30, lon: 10, zoom: 3 }), '#30,10,3');
  assert.equal(AL.viewHash({ lat: -0.001, lon: -0.0001, zoom: 3 }), '#0,0,3', 'niente «-0»');
  assert.equal(AL.viewHash({ lat: -0.4, lon: 0, zoom: 3 }), '#-0.4,0,3');
  // longitudine normalizzata, latitudine e zoom portati nei limiti come parseLink
  assert.equal(AL.viewHash({ lat: 88, lon: 370, zoom: 22.4 }), '#85.0511,10,18');
  assert.equal(AL.viewHash({ lat: 10, lon: 10, zoom: 6.6 }), '#10,10,7');
  for (const bad of [null, {}, { lat: NaN, lon: 0, zoom: 3 }, { lat: 0, lon: Infinity, zoom: 3 }, { lat: 0, lon: 0 }])
    assert.equal(AL.viewHash(bad), '', JSON.stringify(bad));
});

test('linkUrl: percorso, ?mmsi=…&segui=1 e #vista; andata e ritorno con parseLink', () => {
  const view = { lat: 45.4312, lon: 12.3355, zoom: 14 };
  assert.equal(AL.linkUrl('/boatradar/', { view, mmsi: 247123450, follow: true }), '/boatradar/?mmsi=247123450&segui=1#45.4312,12.3355,14');
  assert.equal(AL.linkUrl('/', { view, mmsi: 247123450, follow: false }), '/?mmsi=247123450#45.4312,12.3355,14');
  assert.equal(AL.linkUrl('/', { view, mmsi: null, follow: true }), '/#45.4312,12.3355,14', 'segui senza nave: niente');
  assert.equal(AL.linkUrl('https://x.io/a', { view: null, mmsi: 5 }), 'https://x.io/a?mmsi=5');
  assert.equal(AL.linkUrl('/', {}), '/');
  assert.equal(AL.linkUrl(undefined, { view }), '#45.4312,12.3355,14');
  assert.equal(AL.linkUrl('/', { mmsi: 0 }), '/', 'MMSI non valido');
  assert.equal(AL.linkUrl('/', { mmsi: '247123450' }), '/', 'solo numeri interi');
  for (const link of [{ view, mmsi: 247123450, follow: true }, { view: { lat: -33.9, lon: -70.25, zoom: 5 }, mmsi: null, follow: false },
    { view: null, mmsi: 1, follow: false }]) {
    const url = AL.linkUrl('/p', link), [path, hash = ''] = url.split('#'), search = path.slice(2);
    assert.deepEqual(AL.parseLink(search, hash ? '#' + hash : ''), link, url);
  }
});
