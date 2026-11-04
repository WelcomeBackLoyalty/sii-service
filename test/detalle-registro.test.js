// Copyright (c) 2026 Devlas SpA, https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * `obtenerDetalleRegistro()`: detalle por documento del RCV oficial con el evento del receptor.
 *
 * Sin red ni SII: `_request` y el token del portal se reemplazan por dobles.
 *
 *  1. Arma la llamada de compras (`getDetalleCompra`, accion RCV_DETC) con el período en AAAAMM.
 *  2. Arma la de ventas (`getDetalleVenta`, accion RCV_DETV).
 *  3. El evento "P" se informa como `formaPago: 'contado'`; cualquier otro queda en null.
 *  4. Una respuesta sin `data` (el SII empezó a validar el reCAPTCHA) lanza `RCV_DETALLE_RECAPTCHA`.
 *  5. Una respuesta que no es JSON lanza un error descriptivo.
 *
 * Se ejecuta con `node test/detalle-registro.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATADIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sii-detreg-'));
const SiiPortalAuth = require('../SiiPortalAuth');

function authFalso(respuestaBody) {
  const a = Object.create(SiiPortalAuth.prototype);
  a.llamadas = [];
  a.autenticar = async () => ({ TOKEN: 'sesion-falsa' });
  a._obtenerTokenPortalCV = async () => 'conversacion-falsa';
  a._request = async (url, opts) => {
    a.llamadas.push({ url, body: JSON.parse(opts.body) });
    return { body: respuestaBody };
  };
  return a;
}

const FILA_CONTADO = {
  detRutDoc: 76543210, detDvDoc: 'K', detNroDoc: 101, detFchDoc: '30/09/2026',
  detMntTotal: 1190, detEventoReceptor: 'P', detEventoReceptorLeyenda: 'Forma de pago contado',
  detCdgSIISucur: 0,
};
const FILA_ACUSE = {
  detRutDoc: 77111222, detDvDoc: '3', detNroDoc: 102, detFchDoc: '12/08/2026',
  detMntTotal: 119, detEventoReceptor: 'A', detEventoReceptorLeyenda: 'No reclamado en plazo',
};

(async () => {
  // 1 y 3. Compras: arma la llamada y marca el contado
  {
    const a = authFalso(JSON.stringify({ data: [FILA_CONTADO, FILA_ACUSE] }));
    const filas = await a.obtenerDetalleRegistro('11111111', '1', '2026-10', 'COMPRA', 33);
    assert.strictEqual(a.llamadas.length, 1);
    const { url, body } = a.llamadas[0];
    assert.ok(url.endsWith('/consdcvinternetui/services/data/facadeService/getDetalleCompra'), url);
    assert.strictEqual(body.metaData.conversationId, 'conversacion-falsa');
    assert.ok(body.metaData.namespace.endsWith('FacadeService/getDetalleCompra'));
    assert.strictEqual(body.data.ptributario, '202610');
    assert.strictEqual(body.data.codTipoDoc, '33');
    assert.strictEqual(body.data.operacion, 'COMPRA');
    assert.strictEqual(body.data.estadoContab, 'REGISTRO');
    assert.strictEqual(body.data.accionRecaptcha, 'RCV_DETC');
    assert.strictEqual(filas.length, 2);
    assert.strictEqual(filas[0].formaPago, 'contado');
    assert.strictEqual(filas[0].evento, 'P');
    assert.strictEqual(filas[0].detNroDoc, 101, 'conserva los campos crudos del SII');
    assert.strictEqual(filas[1].formaPago, null, 'el acuse no es forma de pago');
    assert.strictEqual(filas[1].evento, 'A');
  }

  // 2. Ventas
  {
    const a = authFalso(JSON.stringify({ data: [] }));
    await a.obtenerDetalleRegistro('11111111', '1', '2026-10', 'VENTA', 33, 'PENDIENTE');
    const { url, body } = a.llamadas[0];
    assert.ok(url.endsWith('/getDetalleVenta'), url);
    assert.strictEqual(body.data.accionRecaptcha, 'RCV_DETV');
    assert.strictEqual(body.data.estadoContab, 'PENDIENTE');
  }

  // 4. Sin `data`: el SII empezó a validar el reCAPTCHA
  {
    const a = authFalso(JSON.stringify({ respEstado: { codRespuesta: 1, msgeRespuesta: 'reCAPTCHA invalido' } }));
    await assert.rejects(
      () => a.obtenerDetalleRegistro('11111111', '1', '2026-10', 'COMPRA', 33),
      (e) => e.code === 'RCV_DETALLE_RECAPTCHA'
    );
  }

  // 5. Respuesta que no es JSON
  {
    const a = authFalso('<html>error</html>');
    await assert.rejects(
      () => a.obtenerDetalleRegistro('11111111', '1', '2026-10', 'COMPRA', 33),
      /respuesta no-JSON de getDetalleCompra/
    );
  }

  console.log('detalle-registro: OK');
})().catch((e) => { console.error(e); process.exit(1); });
