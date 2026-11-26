#!/usr/bin/env node
// Scrive config.js per GitHub Pages: l'elenco dei server della pagina (prima la VM Oracle, sempre
// accesa, poi Render, che si addormenta) dalle variabili del repo API_HOST/VM_HOST e RENDER_HOST.
// Uso (in pages.yml): node tools/config-pages.js > _site/config.js
// Esce con 1 se un indirizzo non è un nome di host valido (VM_HOST: IPv4 o nome, senza schema né porta):
// non finisce nulla in config.js e il messaggio riporta il valore inserito.
'use strict';

// nome di host: etichette di lettere, cifre e trattini (non all'inizio né alla fine) separate da punti
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// nome valido, oppure IPv4 valido se fatto solo di cifre e punti (300.1.2.3 non è un nome)
const isName = h => (/^[\d.]+$/.test(h) ? IPV4_RE.test(h) : NAME_RE.test(h));

// porta facoltativa da 1 a 65535
function isHostPort(hp) {
  const m = hp.match(/^([^:]+)(?::(\d{1,5}))?$/);
  return Boolean(m) && isName(m[1]) && (m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535));
}

const invalid = (name, value, hint) => new Error(`${name} non valido: ${JSON.stringify(String(value))} (${hint})`);

// API_HOST e RENDER_HOST: "https://x.onrender.com/" → "x.onrender.com"; vuoto → ''
function cleanHost(value, name) {
  const host = String(value ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (host && !isHostPort(host)) throw invalid(name, value, 'serve un nome di host con porta facoltativa, es. boatradar.onrender.com');
  return host;
}

// VM_HOST: deploy-backend.yml lo usa per ssh così com'è, quindi niente schema, porta o barra
function cleanVmHost(value) {
  const host = String(value ?? '').trim();
  if (host && !isName(host)) throw invalid('VM_HOST', value, "serve l'IP pubblico della VM o un nome, senza https://, porta né barra: deploy-backend.yml lo usa per ssh");
  return host;
}

function backends(env = {}) {
  const list = [];
  const ip = cleanVmHost(env.VM_HOST);
  const api = cleanHost(env.API_HOST, 'API_HOST');
  // sslip.io risolve solo indirizzi IP: con un nome in VM_HOST l'indirizzo HTTPS va dato in API_HOST
  if (ip && !api && !IPV4_RE.test(ip)) throw invalid('VM_HOST', env.VM_HOST, 'è un nome: imposta anche API_HOST con il nome HTTPS del server, sslip.io funziona solo con un IP');
  const vm = api || (ip && `boatradar.${ip.replace(/\./g, '-')}.sslip.io`);
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
