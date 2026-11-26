#!/usr/bin/env node
// Scrive config.js per GitHub Pages: l'elenco dei server della pagina (prima la VM Oracle, sempre
// accesa, poi Render, che si addormenta) dalle variabili del repo API_HOST/VM_HOST e RENDER_HOST.
// Uso (in pages.yml): node tools/config-pages.js > _site/config.js
// Esce con 1 se un indirizzo non è un nome di host valido: non finisce nulla in config.js.
'use strict';

const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/i;

// "https://x.onrender.com/" → "x.onrender.com"; vuoto → ''
function cleanHost(value, name) {
  const host = String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (host && !HOST_RE.test(host)) throw new Error(`${name} non valido: ${JSON.stringify(String(value))} (serve un nome di host, es. boatradar.onrender.com)`);
  return host;
}

function backends(env = {}) {
  const list = [];
  let vm = cleanHost(env.API_HOST, 'API_HOST');
  if (!vm) {
    const ip = cleanHost(env.VM_HOST, 'VM_HOST');
    if (ip) vm = cleanHost(`boatradar.${ip.replace(/\./g, '-')}.sslip.io`, 'VM_HOST');
  }
  if (vm) list.push({ url: `https://${vm}/api`, name: 'VM Oracle', sleeps: false });
  const render = cleanHost(env.RENDER_HOST, 'RENDER_HOST');
  if (render) list.push({ url: `https://${render}/api`, name: 'Render', sleeps: true });
  return list.filter((b, i) => list.findIndex(o => o.url.toLowerCase() === b.url.toLowerCase()) === i);
}

function configJs(env = {}) {
  const list = backends(env);
  if (!list.length) return '// server non ancora configurato: solo dati del Baltico\n';
  return `window.BOATRADAR_APIS = ${JSON.stringify(list)};\n`
    + 'window.BOATRADAR_API = window.BOATRADAR_APIS[0].url;\n';
}

module.exports = { configJs, backends };

if (require.main === module) {
  try {
    process.stdout.write(configJs(process.env));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
