'use strict';

/**
 * Líneas no facturables (IndExe=2), p. ej. la propina en una factura.
 *
 * Medido en un ambiente de certificación (maullin), 2026-11-18:
 * - Factura 33 con consumo $11.900 (bruto) + propina $1.000 como IndExe=2, con MontoNF 1000,
 *   MontoPeriodo 12900 y VlrPagar 12900: aceptada sin reparo. MntTotal 11900 sin la propina.
 * - La misma factura sin MontoNF: RECHAZADA, (HED-3-270) "Monto No Facturable Incorrecto".
 * - Factura exenta 34 y NC 61 que anula una factura con propina: aceptadas sin reparo.
 * - Boleta 39 con IndExe=2 y MntTotal sin la propina: reparo HED-2-260 "Monto Total No Cuadra
 *   con Parciales". Por eso la librería no admite no facturables en boleta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const DTE = require('../DTE');
const MuestrasImpresas = require('../cert/MuestrasImpresas');
const {
  agregarTotalesNoFacturable,
  calcularMontoNF,
  calcularTotalesDesdeDetalle,
} = require('..');

const EMISOR = { RUTEmisor: '76543210-K', RznSoc: 'EMPRESA EJEMPLO SPA', GiroEmis: 'Comercio', DirOrigen: 'Calle Falsa 123', CmnaOrigen: 'Santiago' };
const RECEPTOR = { RUTRecep: '77111222-3', RznSocRecep: 'PROVEEDOR EJEMPLO SPA', GiroRecep: 'Comercio', DirRecep: 'Calle 1', CmnaRecep: 'Santiago' };

function armar(tipo, items, extra = {}) {
  return new DTE({ tipo, folio: 1, fechaEmision: '2026-11-18', emisor: EMISOR, receptor: RECEPTOR, items, ...extra });
}
const PROPINA = { NmbItem: 'Propina', QtyItem: 1, PrcItem: 1000, IndExe: 2 };

test('factura bruta con propina: igual al documento aceptado en maullin', () => {
  const dte = armar(33, [{ NmbItem: 'Consumo restaurante', QtyItem: 1, PrcItem: 11900 }, PROPINA], { precioConIva: true });
  const t = dte.datos.Encabezado.Totales;
  assert.deepEqual(t, { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900, MontoNF: 1000, MontoPeriodo: 12900, VlrPagar: 12900 });
  assert.deepEqual(Object.keys(t), ['MntNeto', 'TasaIVA', 'IVA', 'MntTotal', 'MontoNF', 'MontoPeriodo', 'VlrPagar']);
  assert.deepEqual(dte.datos.Detalle[1], { NroLinDet: 2, IndExe: 2, NmbItem: 'Propina', QtyItem: 1, PrcItem: 1000, MontoItem: 1000 });
  assert.equal(dte.montoTotal, 11900, 'el TED y QueryEstDte usan MntTotal, sin la propina');
});

test('factura neta con propina: el IVA se calcula solo sobre el consumo', () => {
  const t = armar(33, [{ NmbItem: 'Consumo', QtyItem: 1, PrcItem: 10000 }, PROPINA]).datos.Encabezado.Totales;
  assert.deepEqual(t, { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900, MontoNF: 1000, MontoPeriodo: 12900, VlrPagar: 12900 });
});

test('factura exenta 34 con propina: el exento no incluye la propina', () => {
  const t = armar(34, [{ NmbItem: 'Servicio', QtyItem: 1, PrcItem: 10000, IndExe: 1 }, PROPINA]).datos.Encabezado.Totales;
  assert.deepEqual(t, { MntExe: 10000, MntTotal: 10000, MontoNF: 1000, MontoPeriodo: 11000, VlrPagar: 11000 });
});

test('nota de crédito con la línea de propina', () => {
  const dte = armar(61, [{ NmbItem: 'Consumo', QtyItem: 1, PrcItem: 11900 }, PROPINA], {
    precioConIva: true,
    referencia: { TpoDocRef: 33, FolioRef: 1, FchRef: '2026-11-18', CodRef: 1, RazonRef: 'Anula factura' },
  });
  assert.equal(dte.datos.Encabezado.Totales.MontoNF, 1000);
  assert.equal(dte.datos.Encabezado.Totales.MntTotal, 11900);
});

test('sin líneas no facturables los Totales no cambian', () => {
  const t = armar(33, [{ NmbItem: 'Consumo', QtyItem: 1, PrcItem: 11900 }], { precioConIva: true }).datos.Encabezado.Totales;
  assert.deepEqual(t, { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 });
});

test('boleta y exportación no admiten líneas no facturables', () => {
  for (const tipo of [39, 41, 110]) {
    assert.throws(() => armar(tipo, [{ NmbItem: 'Consumo', QtyItem: 1, PrcItem: 11900 }, PROPINA]),
      (e) => e.code === 'NO_FACTURABLE_NO_PERMITIDO', `tipo ${tipo}`);
  }
});

test('IndExe=6 resta del no facturable', () => {
  assert.equal(calcularMontoNF([
    { IndExe: 2, MontoItem: 1000 }, { IndExe: 6, MontoItem: 300 }, { IndExe: 1, MontoItem: 500 }, { MontoItem: 900 },
  ]), 700);
});

test('agregarTotalesNoFacturable reemplaza valores previos y respeta el orden del XSD', () => {
  const t = agregarTotalesNoFacturable(33, [{ IndExe: 2, MontoItem: 1000 }], { MntNeto: 1, MontoNF: 5, IVA: 0, MntTotal: 1 });
  assert.deepEqual(Object.keys(t), ['MntNeto', 'IVA', 'MntTotal', 'MontoNF', 'MontoPeriodo', 'VlrPagar']);
  assert.equal(t.MontoNF, 1000);
});

test('calcularTotalesDesdeDetalle no cuenta la línea no facturable como afecta', () => {
  const t = calcularTotalesDesdeDetalle([{ MontoItem: 10000 }, { IndExe: 2, MontoItem: 1000 }]);
  assert.equal(t.MntNeto, 10000);
  assert.equal(t.MntTotal, 11900);
});

test('modo estructurado: generarXML lanza si MontoNF falta o no cuadra (evita HED-3-270)', () => {
  const base = armar(33, [{ NmbItem: 'Consumo', QtyItem: 1, PrcItem: 10000 }, PROPINA]).datos;
  const sinNF = JSON.parse(JSON.stringify(base));
  delete sinNF.Encabezado.Totales.MontoNF;
  assert.throws(() => new DTE(sinNF).generarXML(), (e) => e.code === 'MONTO_NF_NO_CUADRA');
  const malo = JSON.parse(JSON.stringify(base));
  malo.Encabezado.Totales.MontoNF = 999;
  assert.throws(() => new DTE(malo).generarXML(), (e) => e.code === 'MONTO_NF_NO_CUADRA');
  assert.doesNotThrow(() => new DTE(base).generarXML());
});

test('XML: MontoNF, MontoPeriodo y VlrPagar después de MntTotal; IndExe antes de NmbItem', () => {
  const dte = armar(33, [{ NmbItem: 'Consumo', QtyItem: 1, PrcItem: 10000 }, PROPINA]).generarXML();
  const { XMLBuilder } = require('fast-xml-parser');
  const xml = new XMLBuilder({ ignoreAttributes: false }).build(dte.documento);
  assert.match(xml, /<MntTotal>11900<\/MntTotal><MontoNF>1000<\/MontoNF><MontoPeriodo>12900<\/MontoPeriodo><VlrPagar>12900<\/VlrPagar>/);
  assert.match(xml, /<NroLinDet>2<\/NroLinDet><IndExe>2<\/IndExe><NmbItem>Propina<\/NmbItem>/);
});

test('muestra impresa: Monto No Facturable y Total a Pagar', () => {
  const m = new MuestrasImpresas({ emisor: EMISOR });
  const totales = { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900, MontoNF: 1000, MontoPeriodo: 12900, VlrPagar: 12900 };
  const alto = m._pdfCalcTotalesHeight({ totales, tipoDte: 33 });
  const altoSin = m._pdfCalcTotalesHeight({ totales: { MntNeto: 10000, TasaIVA: 19, IVA: 1900, MntTotal: 11900 }, tipoDte: 33 });
  assert.ok(alto > altoSin, 'dos filas más');
});
