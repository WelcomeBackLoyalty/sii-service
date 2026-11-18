// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Montos no facturables (IndExe=2 y IndExe=6).
 *
 * Formato DTE del SII (v2.5) y XSD DTE_v10:
 * - Una línea con IndExe=2 "NO ES Facturable"; IndExe=6 es un no facturable negativo.
 * - MontoNF = suma de las líneas IndExe=2 menos suma de las IndExe=6.
 * - MntTotal NO incluye el no facturable. MontoPeriodo = MntTotal + MontoNF y
 *   VlrPagar = MontoPeriodo (no hay SaldoAnterior).
 * - Orden en Totales: ... MntTotal, MontoNF, MontoPeriodo, SaldoAnterior, VlrPagar.
 *
 * Medido en maullin el 2026-11-18 (factura 33, folios 145 a 148):
 * - Sin MontoNF, el SII RECHAZA con (HED-3-270) "Monto No Facturable Incorrecto".
 * - Con MontoNF, MontoPeriodo y VlrPagar, acepta sin reparo. El RCV guarda el no
 *   facturable aparte (detMntNoFact) y QueryEstDte coincide con MntTotal.
 * - Factura exenta 34 y NC 61 que anula una factura con propina: aceptadas sin reparo.
 *
 * Tipos permitidos: 33, 34, 56 y 61. No se permite en:
 * - Boleta 39 y 41: el validador de boleta compara MntTotal con la suma de TODAS las
 *   líneas (reparo HED-2-260) y el resumen de boletas no tiene campo de no facturable,
 *   así que el monto se cuenta como venta. La propina va fuera de la boleta (Res. Ex.
 *   SII 176/2020 y 76/2021, "Otros Montos").
 * - Exportación 110, 111 y 112: su formato no tiene MontoNF (Oficio SII 0110/2024).
 * - Otros tipos (guía, liquidación, compra): no se probaron.
 *
 * Uso típico: la propina de un restaurante en una factura (Oficios SII 0110/2024 y
 * 283/2026: "monto no facturable").
 */

const IND_EXE_NO_FACTURABLE = 2;
const IND_EXE_NO_FACTURABLE_NEGATIVO = 6;
const TIPOS_CON_NO_FACTURABLE = Object.freeze([33, 34, 56, 61]);

/** true si la línea es no facturable (IndExe 2 o 6). */
function esLineaNoFacturable(det) {
  const ind = Number(det?.IndExe);
  return ind === IND_EXE_NO_FACTURABLE || ind === IND_EXE_NO_FACTURABLE_NEGATIVO;
}

/** MontoNF de un Detalle: Σ IndExe=2 - Σ IndExe=6. 0 si no hay líneas no facturables. */
function calcularMontoNF(detalle) {
  let nf = 0;
  for (const det of detalle || []) {
    const ind = Number(det?.IndExe);
    const monto = Number(det?.MontoItem || 0);
    if (ind === IND_EXE_NO_FACTURABLE) nf += monto;
    else if (ind === IND_EXE_NO_FACTURABLE_NEGATIVO) nf -= monto;
  }
  return nf;
}

/** Lanza si el tipo de documento no admite líneas no facturables. */
function assertTipoAdmiteNoFacturable(tipoDte) {
  const tipo = Number(tipoDte);
  if (TIPOS_CON_NO_FACTURABLE.includes(tipo)) return;
  const motivo = tipo === 39 || tipo === 41
    ? 'en boleta el SII suma la línea al total (reparo HED-2-260); la propina va fuera de la boleta'
    : tipo >= 110 && tipo <= 112
      ? 'el formato de exportación no tiene Monto No Facturable'
      : 'tipo no habilitado para montos no facturables';
  const err = new Error(`El tipo ${tipo} no admite líneas no facturables (IndExe 2/6): ${motivo}`);
  err.code = 'NO_FACTURABLE_NO_PERMITIDO';
  throw err;
}

/**
 * Devuelve Totales con MontoNF, MontoPeriodo y VlrPagar cuando el Detalle tiene líneas
 * no facturables, en el orden del XSD (después de MntTotal). Sin líneas no facturables
 * devuelve los mismos Totales. Lanza si el tipo no las admite.
 *
 * @param {number} tipoDte
 * @param {Array} detalle - Detalle ya armado (MontoItem e IndExe por línea)
 * @param {Object} totales - Totales sin el no facturable (MntTotal sin incluirlo)
 */
function agregarTotalesNoFacturable(tipoDte, detalle, totales) {
  if (!(detalle || []).some(esLineaNoFacturable)) return totales;
  assertTipoAdmiteNoFacturable(tipoDte);
  const montoNF = calcularMontoNF(detalle);
  const { MontoNF, MontoPeriodo, SaldoAnterior, VlrPagar, ...resto } = totales || {};
  const mntTotal = Number(resto.MntTotal || 0);
  return {
    ...resto,
    MontoNF: montoNF,
    MontoPeriodo: mntTotal + montoNF,
    VlrPagar: mntTotal + montoNF,
  };
}

module.exports = {
  IND_EXE_NO_FACTURABLE,
  IND_EXE_NO_FACTURABLE_NEGATIVO,
  TIPOS_CON_NO_FACTURABLE,
  esLineaNoFacturable,
  calcularMontoNF,
  assertTipoAdmiteNoFacturable,
  agregarTotalesNoFacturable,
};
