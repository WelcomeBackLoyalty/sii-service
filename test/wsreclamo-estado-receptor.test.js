// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * `WsReclamo`: estado del receptor, fecha de recepción en el SII y tiempo máximo de las llamadas.
 *
 * Reglas oficiales: "Webservice Registro Reclamo DTE v1.2" del SII
 * (https://www.sii.cl/factura_electronica/Webservice_Registro_Reclamo_DTE_V1.2.pdf, copia en
 * docs/). Solo ACD, ERM, RCD, RFP y RFT se registran; NCA y ENC son informativos. Un reclamo
 * después de ACD o ERM y ACD/ERM después de un reclamo son rechazados por el SII.
 *
 * Antes, el estado salía del ÚLTIMO evento de la lista y NCA/ENC se mapeaban a 'sin_accion':
 * una factura reclamada que luego recibía una nota de crédito quedaba como 'sin_accion'.
 *
 * Sin red externa: `_llamar` se reemplaza por un doble que devuelve el XML de respuesta, y el
 * caso de tiempo máximo usa un servidor local en 127.0.0.1 que nunca responde.
 *
 * Se ejecuta con `node test/wsreclamo-estado-receptor.test.js`.
 */
const assert = require('assert');
const http = require('http');
const WsReclamo = require('../WsReclamo');

// ─── Respuestas del SII (formato de listarEventosHistDoc, WS v1.2) ──────────

function envelope(innerReturn, metodo = 'listarEventosHistDoc') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/">
  <S:Body>
    <ns2:${metodo}Response xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl">
      <return>${innerReturn}</return>
    </ns2:${metodo}Response>
  </S:Body>
</S:Envelope>`;
}

function evento(cod, desc, fecha) {
  return `<listaEventosDoc><codEvento>${cod}</codEvento><descEvento>${desc}</descEvento>`
    + `<rutResponsable>76543210</rutResponsable><dvResponsable>3</dvResponsable>`
    + `<fechaEvento>${fecha}</fechaEvento></listaEventosDoc>`;
}

function listado(...eventos) {
  return envelope(`<codResp>15</codResp><descResp>Listado de eventos del documento</descResp>${eventos.join('')}`);
}

function soloCodigo(cod, desc) {
  return envelope(`<codResp>${cod}</codResp><descResp>${desc}</descResp>`);
}

/** Instancia con `_llamar` reemplazado: sin token, sin red. */
function wsCon(xml) {
  const ws = new WsReclamo({ rut: '76543210-3' }, 'certificacion', { useTokenCache: false });
  ws.llamadas = [];
  ws._llamar = async (metodo, params) => {
    ws.llamadas.push({ metodo, params });
    return xml;
  };
  return ws;
}

async function lanza(promesa) {
  try {
    await promesa;
  } catch (e) {
    return e;
  }
  throw new Error('debía lanzar y resolvió');
}

async function main() {
  // 1. Reclamo seguido de NC de anulación: sigue reclamada y la NC se informa aparte.
  {
    const ws = wsCon(listado(
      evento('RCD', 'Reclamo al Contenido del Documento', '03-11-2026 10:00:00'),
      evento('NCA', 'Recepción de NC de anulación que referencia al documento', '05-11-2026 09:30:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 101);
    assert.strictEqual(d.estado, 'reclamada');
    assert.deepStrictEqual(d.reclamo, {
      codigo: 'RCD', descripcion: 'Reclamo al Contenido del Documento', fecha: '03-11-2026 10:00:00',
    });
    assert.deepStrictEqual(d.notaCredito, {
      codigo: 'NCA',
      descripcion: 'Recepción de NC de anulación que referencia al documento',
      fecha: '05-11-2026 09:30:00',
    });
    assert.strictEqual(d.codResp, 15);
    assert.strictEqual(d.eventos.length, 2);
    assert.deepStrictEqual(d.eventos[0], {
      codigo: 'RCD', descripcion: 'Reclamo al Contenido del Documento',
      rutResponsable: '76543210-3', fecha: '03-11-2026 10:00:00',
    });
    // La API de texto devuelve lo mismo.
    assert.strictEqual(await ws.consultarEstadoReceptor('76543210', '3', 33, 101), 'reclamada');
    assert.strictEqual(ws.llamadas[0].metodo, 'listarEventosHistDoc');
    console.log('  ok: RCD y luego NCA queda reclamada, con notaCredito NCA');
  }

  // 1b. Reclamo seguido de ENC (NC distinta de anulación): igual.
  {
    const ws = wsCon(listado(
      evento('RFT', 'Reclamo por Falta Total de Mercaderías', '03-11-2026 10:00:00'),
      evento('ENC', 'Recepción de NC, distinta de anulación, que referencia al documento', '04-11-2026 10:00:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 102);
    assert.strictEqual(d.estado, 'reclamada');
    assert.strictEqual(d.reclamo.codigo, 'RFT');
    assert.strictEqual(d.notaCredito.codigo, 'ENC');
    console.log('  ok: RFT y luego ENC queda reclamada, con notaCredito ENC');
  }

  // 2. ACD y ERM, en ambos órdenes: aceptada (ACD prima sobre ERM).
  for (const orden of [['ACD', 'ERM'], ['ERM', 'ACD']]) {
    const ws = wsCon(listado(
      evento(orden[0], 'x', '02-11-2026 10:00:00'),
      evento(orden[1], 'y', '03-11-2026 10:00:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 103);
    assert.strictEqual(d.estado, 'aceptada', `orden ${orden.join('>')}`);
    assert.strictEqual(d.reclamo, null);
    assert.strictEqual(d.notaCredito, null);
  }
  console.log('  ok: ACD+ERM y ERM+ACD quedan aceptada');

  // 2b. Solo ERM: acuse_recibo. ERM y luego NCA: sigue acuse_recibo.
  {
    const ws = wsCon(listado(
      evento('ERM', 'Otorga Recibo de Mercaderías o Servicios', '02-11-2026 10:00:00'),
      evento('NCA', 'NC', '03-11-2026 10:00:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 104);
    assert.strictEqual(d.estado, 'acuse_recibo');
    assert.strictEqual(d.notaCredito.codigo, 'NCA');
    console.log('  ok: ERM y luego NCA queda acuse_recibo');
  }

  // 3. RFP y luego RCD: reclamada, el reclamo informado es el más reciente.
  {
    const ws = wsCon(listado(
      evento('RFP', 'Reclamo por Falta Parcial de Mercaderías', '02-11-2026 10:00:00'),
      evento('RCD', 'Reclamo al Contenido del Documento', '04-11-2026 08:00:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 105);
    assert.strictEqual(d.estado, 'reclamada');
    assert.strictEqual(d.reclamo.codigo, 'RCD');
    assert.strictEqual(d.reclamo.fecha, '04-11-2026 08:00:00');
    console.log('  ok: RFP y luego RCD queda reclamada con reclamo RCD');
  }

  // 3b. Caso adversarial: la lista viene en orden inverso (más reciente primero). El reclamo
  // más reciente se elige por fecha, no por posición; el cambio de mes y año no lo confunde
  // (DD-MM-AAAA no ordena bien como texto).
  {
    const ws = wsCon(listado(
      evento('RCD', 'Reclamo al Contenido del Documento', '02-01-2027 08:00:00'),
      evento('RFP', 'Reclamo por Falta Parcial de Mercaderías', '30-12-2026 10:00:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 106);
    assert.strictEqual(d.reclamo.codigo, 'RCD');
    console.log('  ok: el reclamo más reciente se elige por fecha, no por posición en la lista');
  }

  // 3c. NCA prima sobre ENC aunque la ENC sea posterior.
  {
    const ws = wsCon(listado(
      evento('NCA', 'NC anulación', '02-11-2026 10:00:00'),
      evento('ENC', 'NC otra', '05-11-2026 10:00:00'),
    ));
    const d = await ws.consultarEstadoReceptorDetalle('76543210', '3', 33, 107);
    assert.strictEqual(d.estado, 'sin_accion');
    assert.strictEqual(d.notaCredito.codigo, 'NCA');
    console.log('  ok: solo NC queda sin_accion y se informa la NCA');
  }

  // 4. codResp 16 y 18 son datos: sin_accion con el codResp conservado.
  for (const [cod, desc] of [
    [16, 'Documento no presenta eventos de reclamos o acuse de recibo'],
    [18, 'Documento no ha sido recibido'],
  ]) {
    const d = await wsCon(soloCodigo(cod, desc)).consultarEstadoReceptorDetalle('76543210', '3', 33, 108);
    assert.deepStrictEqual(d, {
      estado: 'sin_accion', codResp: cod, descResp: desc, reclamo: null, notaCredito: null, eventos: [],
    });
  }
  console.log('  ok: codResp 16 y 18 dan sin_accion con codResp');

  // 5. Errores documentados y desconocidos lanzan con codResp y descResp.
  {
    const e = await lanza(wsCon(soloCodigo(17, 'Acción autorizada solo para empresa receptora'))
      .consultarEstadoReceptor('76543210', '3', 33, 109));
    assert.strictEqual(e.code, 'SII_REJECTED');
    assert.strictEqual(e.details.codResp, 17);
    assert.match(e.message, /codResp=17/);
    assert.match(e.message, /empresa receptora/);

    const interno = await lanza(wsCon(soloCodigo(-1, 'Error Interno'))
      .consultarEstadoReceptorDetalle('76543210', '3', 33, 109));
    assert.strictEqual(interno.code, 'SII_CONNECTION_FAILED');
    assert.strictEqual(interno.isRetryable(), true);

    const raro = await lanza(wsCon(soloCodigo(99, 'Algo nuevo'))
      .consultarEstadoReceptorDetalle('76543210', '3', 33, 109));
    assert.strictEqual(raro.code, 'SII_INVALID_RESPONSE');
    assert.strictEqual(raro.details.codResp, 99);
    assert.strictEqual(raro.details.descResp, 'Algo nuevo');
    assert.match(raro.message, /no documentado/);

    // Respuesta sin codResp: antes se asumía 16 y salía sin_accion.
    const sinCod = await lanza(wsCon(envelope('<algo>nada</algo>'))
      .consultarEstadoReceptor('76543210', '3', 33, 109));
    assert.strictEqual(sinCod.code, 'SII_INVALID_RESPONSE');
    console.log('  ok: codResp de error, -1, desconocido y ausente lanzan');
  }

  // 6. consultarFechaRecepcionSii
  {
    const ws = wsCon(envelope('21-02-2017 19:02:03', 'consultarFechaRecepcionSii'));
    const f = await ws.consultarFechaRecepcionSii('76543210', '3', 33, 110);
    assert.deepStrictEqual(f, { fechaRecepcion: '21-02-2017 19:02:03', fechaRecepcionIso: '2017-02-21T19:02:03' });
    assert.strictEqual(ws.llamadas[0].metodo, 'consultarFechaRecepcionSii');
    assert.deepStrictEqual(ws.llamadas[0].params, { rutEmisor: '76543210', dvEmisor: '3', tipoDoc: 33, folio: 110 });

    assert.strictEqual(await wsCon(envelope('', 'consultarFechaRecepcionSii'))
      .consultarFechaRecepcionSii('76543210', '3', 33, 110), null);

    const e = await lanza(wsCon(envelope('Documento no ha sido recibido', 'consultarFechaRecepcionSii'))
      .consultarFechaRecepcionSii('76543210', '3', 33, 110));
    assert.strictEqual(e.code, 'SII_INVALID_RESPONSE');
    assert.match(e.message, /Documento no ha sido recibido/);
    console.log('  ok: consultarFechaRecepcionSii parsea la fecha, vacío da null y texto lanza');
  }

  // 6b. Respuestas reales del SII (certificación, 2026-11-16), copiadas byte a byte salvo los
  //     RUT, que se cambiaron por inventados. El sobre real viene en una sola línea, con prefijo
  //     soap: y, cuando no hay fecha (documento de otro emisor o tipo sin eventos), `<return/>`.
  {
    const sobre = (metodo, ret) => '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
      + `<ns2:${metodo}Response xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl">${ret}`
      + `</ns2:${metodo}Response></soap:Body></soap:Envelope>`;

    const f = await wsCon(sobre('consultarFechaRecepcionSii', '<return>16-11-2026 16:36:55</return>'))
      .consultarFechaRecepcionSii('76543210', '3', 33, 95);
    assert.deepStrictEqual(f, { fechaRecepcion: '16-11-2026 16:36:55', fechaRecepcionIso: '2026-11-16T16:36:55' });
    assert.strictEqual(await wsCon(sobre('consultarFechaRecepcionSii', '<return/>'))
      .consultarFechaRecepcionSii('76543210', '3', 33, 95), null);

    // RFP: la í llega como referencia numérica (&#237;) y con un espacio al final.
    const rfp = await wsCon(sobre('listarEventosHistDoc', '<return><codResp>15</codResp>'
      + '<descResp>Listado de eventos del documento</descResp><listaEventosDoc><codEvento>RFP</codEvento>'
      + '<descEvento>Reclamo por Falta Parcial de Mercader&#237;as </descEvento><rutResponsable>11111111'
      + '</rutResponsable><dvResponsable>1</dvResponsable><fechaEvento>16-11-2026 16:47:48</fechaEvento>'
      + '</listaEventosDoc></return>')).consultarEstadoReceptorDetalle('76543210', '3', 33, 96);
    assert.strictEqual(rfp.estado, 'reclamada');
    assert.deepStrictEqual(rfp.reclamo, {
      codigo: 'RFP', descripcion: 'Reclamo por Falta Parcial de Mercaderías', fecha: '16-11-2026 16:47:48',
    });
    assert.strictEqual(rfp.eventos[0].rutResponsable, '11111111-1');
    assert.strictEqual(WsReclamo._textoSii('Recepci&#xF3;n &#99999999;'), 'Recepción &#99999999;');
    console.log('  ok: respuestas reales del SII: fecha, <return/> y referencias numéricas (&#237;)');
  }

  // 7. Tiempo máximo: un servidor que acepta y nunca responde corta en ~timeoutMs.
  {
    const server = http.createServer(() => { /* nunca responde */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const ws = new WsReclamo({ rut: '76543210-3' }, 'certificacion', { useTokenCache: false, timeoutMs: 300 });
    ws._seedUrl = `http://127.0.0.1:${port}/seed`;
    const t0 = Date.now();
    const e = await lanza(ws._getSemilla());
    const ms = Date.now() - t0;
    server.closeAllConnections?.();
    server.close();
    assert.strictEqual(e.code, 'SII_TIMEOUT');
    assert.match(e.message, /semilla/);
    assert.ok(ms >= 250 && ms < 3000, `tardó ${ms} ms`);
    assert.strictEqual(new WsReclamo({}, 'certificacion').timeoutMs, 20000);
    console.log(`  ok: llamada sin respuesta corta con SII_TIMEOUT en ${ms} ms (defecto 20000 ms)`);
  }

  console.log('wsreclamo-estado-receptor: todo ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
