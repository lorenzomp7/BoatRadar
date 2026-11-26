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

  // Direzione della freccia: la rotta, solo per navi in movimento (sog 102.3 = n.d., cog 360 = n.d.)
  const heading = p => p.sog > 0.5 && p.sog < 102.3 && p.cog != null && p.cog < 360 ? p.cog : null;

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

  return { TYPES, typeOf, typeName, heading, decodeEta, matchesQuery };
});
