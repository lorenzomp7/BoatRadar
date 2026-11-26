// Non è un file di test: si carica con NODE_OPTIONS=--require prima di server.js (test/cache-locations.test.js)
// e fa fallire zlib.gzip asincrono, per controllare che /api/locations risponda comunque non compresso.
'use strict';
const zlib = require('node:zlib');
zlib.gzip = (data, options, cb) => process.nextTick(typeof options === 'function' ? options : cb,
  new Error('gzip finto in errore'));
