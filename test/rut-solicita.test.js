'use strict';

/**
 * RUTSolicita, Contacto y CorreoRecep en el DTE. El XSD (DTE_v10) los admite opcionales: Contacto y CorreoRecep dentro
 * del Receptor (tras GiroRecep, antes de DirRecep), RUTSolicita en el Encabezado justo despues de Receptor. La boleta
 * (EnvioBOLETA_v11) no tiene RUTSolicita, asi que ahi no se emite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DTE } = require('../index');

const EMISOR = { RUTEmisor: '76543210-3', RznSoc: 'EMPRESA EJEMPLO SPA', GiroEmis: 'Comercio', Acteco: 620100, DirOrigen: 'Calle 1', CmnaOrigen: 'Santiago' };
const RECEPTOR = { RUTRecep: '77111222-3', RznSocRecep: 'CLIENTE SPA', GiroRecep: 'Comercio', DirRecep: 'Calle 2', CmnaRecep: 'Santiago' };
const TOTALES = { MntNeto: 1000, TasaIVA: 19, IVA: 190, MntTotal: 1190 };
const DETALLE = [{ NroLinDet: 1, NmbItem: 'Producto', QtyItem: 1, PrcItem: 1000, MontoItem: 1000 }];

function armar(tipo, receptor, extra = {}) {
  const dte = new DTE({
    Encabezado: { IdDoc: { TipoDTE: tipo, Folio: 1, FchEmis: '2026-11-03' }, Emisor: EMISOR, Receptor: receptor, Totales: TOTALES, ...extra },
    Detalle: DETALLE,
  });
  dte.generarXML();
  return Object.keys(dte.documento.Documento.Encabezado);
}
function receptorDe(tipo, receptor, extra) {
  const dte = new DTE({
    Encabezado: { IdDoc: { TipoDTE: tipo, Folio: 1, FchEmis: '2026-11-03' }, Emisor: EMISOR, Receptor: receptor, Totales: TOTALES, ...extra },
    Detalle: DETALLE,
  });
  dte.generarXML();
  return dte.documento.Documento.Encabezado;
}

test('factura: RUTSolicita va justo despues de Receptor, formateado', () => {
  const claves = armar(33, RECEPTOR, { RUTSolicita: '11.111.111-1' });
  assert.equal(claves[claves.indexOf('Receptor') + 1], 'RUTSolicita');
  assert.equal(receptorDe(33, RECEPTOR, { RUTSolicita: '11.111.111-1' }).RUTSolicita, '11111111-1');
});

test('sin RUTSolicita no se agrega el campo (comportamiento anterior)', () => {
  assert.equal(armar(33, RECEPTOR).includes('RUTSolicita'), false);
});

test('RUTSolicita con digito verificador malo lanza', () => {
  assert.throws(() => armar(33, RECEPTOR, { RUTSolicita: '12345678-9' }), /RUTSolicita invalido/);
});

test('Contacto y CorreoRecep salen entre GiroRecep y DirRecep', () => {
  const r = receptorDe(33, { ...RECEPTOR, Contacto: 'Ana Perez', CorreoRecep: 'ana@empresa.cl' }).Receptor;
  const claves = Object.keys(r);
  assert.deepEqual(claves.slice(claves.indexOf('GiroRecep'), claves.indexOf('DirRecep') + 1), ['GiroRecep', 'Contacto', 'CorreoRecep', 'DirRecep']);
});

test('Contacto o CorreoRecep de 81 caracteres lanza (el SII rechaza el sobre con codigoSii 7)', () => {
  assert.throws(() => armar(33, { ...RECEPTOR, Contacto: 'a'.repeat(81) }), /Contacto excede/);
  assert.throws(() => armar(33, { ...RECEPTOR, CorreoRecep: 'a'.repeat(81) }), /CorreoRecep excede/);
});

test('formato simplificado: rutSolicita, Contacto y CorreoRecep llegan al XML de la factura', () => {
  const dte = new DTE({ tipo: 33, folio: 1, fechaEmision: '2026-11-03', emisor: EMISOR, receptor: { ...RECEPTOR, Contacto: 'Ana Perez', CorreoRecep: 'ana@empresa.cl' }, rutSolicita: '11.111.111-1', items: [{ nombre: 'Producto', cantidad: 1, precio: 1000 }] });
  dte.generarXML();
  const enc = dte.documento.Documento.Encabezado;
  assert.equal(enc.RUTSolicita, '11111111-1');
  assert.equal(enc.Receptor.Contacto, 'Ana Perez');
  assert.equal(enc.Receptor.CorreoRecep, 'ana@empresa.cl');
});

test('boleta: RUTSolicita no se emite (no existe en EnvioBOLETA_v11)', () => {
  const dte = new DTE({ tipo: 39, folio: 1, fechaEmision: '2026-11-03', emisor: { RUTEmisor: '76543210-3', RznSocEmisor: 'EMPRESA EJEMPLO SPA', GiroEmisor: 'Comercio', DirOrigen: 'Calle 1', CmnaOrigen: 'Santiago' }, rutSolicita: '11.111.111-1', items: [{ nombre: 'Producto', cantidad: 1, precio: 1190 }] });
  dte.generarXML();
  assert.equal('RUTSolicita' in dte.documento.Documento.Encabezado, false);
});
