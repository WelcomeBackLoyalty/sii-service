// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * WsReclamo.js — Cliente SOAP para el WS de Aceptación/Reclamo de DTEs del SII
 *
 * Implementa el "WS Consulta y Registro de Aceptación/Reclamo a DTE recibido" v1.2
 * Fuente oficial: https://www.sii.cl/factura_electronica/Webservice_Registro_Reclamo_DTE_V1.2.pdf
 * (copia en docs/Webservice_Registro_Reclamo_DTE_V1.2.pdf)
 *
 * Métodos expuestos:
 *   listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio) → { codResp, descResp, eventos[] }
 *   consultarEstadoReceptor(rutEmisor, dvEmisor, tipoDoc, folio) → 'sin_accion'|'aceptada'|'acuse_recibo'|'reclamada'
 *   consultarEstadoReceptorDetalle(rutEmisor, dvEmisor, tipoDoc, folio) → { estado, reclamo, notaCredito, eventos[], ... }
 *   consultarFechaRecepcionSii(rutEmisor, dvEmisor, tipoDoc, folio) → { fechaRecepcion, fechaRecepcionIso } | null
 *   ingresarAceptacion(rutEmisor, dvEmisor, tipoDoc, folio, accion) → { codResp, descResp }
 *
 * Autenticación: TOKEN SII vía flujo seed/firma SOAP (mismo que EnviadorSII.getTokenSoap).
 */

const forge = require('node-forge');
const { fetchRegistrado } = require('./utils/httpDebug');

/** `fetchRegistrado` con el cliente ya fijado, para no repetirlo en cada llamada. */
const fetchRegistradoWs = (url, opciones) => fetchRegistrado(url, opciones, 'WsReclamo');
const {
  SOAP_ENDPOINTS,
  WSRECLAMO_ENDPOINTS,
  validateAmbiente,
  createScopedLogger,
  getCachedToken,
  setCachedToken,
  extractTagContent,
  decodeXmlEntities,
  parseXmlNoNs,
  siiError,
  ERROR_CODES,
} = require('./utils');
const { WSRECLAMO_CODIGOS } = require('./utils/endpoints');

const log = createScopedLogger('WsReclamo');

// ─── Acciones válidas para ingresarAceptacionReclamoDoc ───────────────────────
/** @typedef {'ACD'|'ERM'|'RCD'|'RFP'|'RFT'} AccionReclamo */

// ─── Eventos del registro y su efecto en el estado ───────────────────────────
// Fuente: WS v1.2 del SII, método ingresarAceptacionReclamoDoc (combinaciones permitidas)
// y listarEventosHistDoc (eventos informativos NCA y ENC).
//
// Solo ACD, ERM, RCD, RFP y RFT se registran por el WS y determinan el estado. Las
// combinaciones que el SII admite son: ACD y ERM en cualquier orden; un reclamo distinto
// después de otro reclamo. Un reclamo después de ACD o ERM se rechaza (codResp 11 y 13) y
// ACD o ERM después de un reclamo también (codResp 12 y 6). Por eso el estado no sale del
// último evento de la lista sino de la prioridad: reclamada > aceptada > acuse_recibo.
//
// NCA (NC de anulación recibida que referencia al documento) y ENC (NC distinta de
// anulación) son informativos: no cambian la aceptación ni el reclamo. Se informan aparte
// en `notaCredito`.
//
// 'tacita' NO es un evento del WS: es una presunción legal cuando pasan 8 días desde la
// recepción en el SII sin eventos. Se calcula en la capa de negocio con
// consultarFechaRecepcionSii, no aquí.
const EVENTOS_RECLAMO = ['RCD', 'RFP', 'RFT'];
const EVENTOS_NOTA_CREDITO = ['NCA', 'ENC'];

// codResp de listarEventosHistDoc que son datos y no errores.
const COD_LISTADO = 15;          // Listado de eventos del documento
const COD_SIN_EVENTOS = 16;      // Documento no presenta eventos de reclamos o acuse de recibo
const COD_NO_RECIBIDO = 18;      // Documento no ha sido recibido

/** Tiempo máximo por llamada SOAP (semilla, token y WS) si el consumidor no fija otro. */
const TIMEOUT_MS_DEFECTO = 20000;

class WsReclamo {
  /**
   * @param {Object} certificado  — instancia de Certificado con privateKey y cert
   * @param {string} ambiente     — 'certificacion' | 'produccion'
   * @param {Object} [options]
   * @param {boolean} [options.useTokenCache=true]
   * @param {number}  [options.timeoutMs=20000] tiempo máximo de cada llamada SOAP (semilla,
   *   token y WS). Al vencer se lanza un DteSiiError con code SII_TIMEOUT.
   */
  constructor(certificado, ambiente, options = {}) {
    if (!certificado) throw new Error('WsReclamo: certificado es obligatorio');
    this.certificado = certificado;
    this.ambiente = validateAmbiente(ambiente);
    this.useTokenCache = options.useTokenCache !== false;
    const t = Number(options.timeoutMs);
    this.timeoutMs = Number.isFinite(t) && t > 0 ? t : TIMEOUT_MS_DEFECTO;

    this.rutCert = certificado.rut || 'unknown';

    this._tokenSoap = null;

    // URLs
    this._seedUrl  = SOAP_ENDPOINTS[this.ambiente].seed;
    this._tokenUrl = SOAP_ENDPOINTS[this.ambiente].token;
    this._wsUrl    = WSRECLAMO_ENDPOINTS[this.ambiente].replace('?wsdl', '');
  }

  /**
   * `fetchRegistrado` con tiempo máximo. Sin tope, una conexión TLS al SII que no completa
   * deja la llamada colgada hasta el timeout del sistema operativo (~2 minutos).
   * El tope cubre también la lectura del cuerpo de la respuesta.
   * @private
   */
  async _fetch(url, opciones, etapa) {
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), this.timeoutMs);
    try {
      return await fetchRegistradoWs(url, { ...opciones, signal: controlador.signal });
    } catch (e) {
      if (controlador.signal.aborted) {
        throw siiError(
          `WSRECLAMO ${etapa}: sin respuesta del SII en ${this.timeoutMs} ms`,
          ERROR_CODES.SII_TIMEOUT,
          { etapa, timeoutMs: this.timeoutMs },
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // AUTENTICACIÓN — mismo flujo que EnviadorSII.getTokenSoap
  // ══════════════════════════════════════════════════════════════════════════════

  /** Obtiene semilla del servicio SOAP del SII */
  async _getSemilla() {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><getSeed/></soapenv:Body>
</soapenv:Envelope>`;

    const { response: res, text: xml } = await this._fetch(this._seedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: envelope,
    }, 'semilla');
    if (!res.ok) throw siiError(`Error semilla: ${res.status}`, ERROR_CODES.SII_CONNECTION_FAILED);

    const semilla = extractTagContent(decodeXmlEntities(xml), 'SEMILLA');
    if (!semilla) throw siiError('No se obtuvo semilla del SII', ERROR_CODES.SII_INVALID_RESPONSE);
    return semilla;
  }

  /** Firma la semilla y obtiene el TOKEN SOAP */
  async _fetchTokenSoap() {
    const semilla = await this._getSemilla();
    const xmlFirmado = this._firmarSemilla(semilla);

    const escaped = xmlFirmado
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getToken>
      <pszXml>${escaped}</pszXml>
    </getToken>
  </soapenv:Body>
</soapenv:Envelope>`;

    const { response: res, text: xml } = await this._fetch(this._tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '' },
      body: envelope,
    }, 'token');
    if (!res.ok) throw siiError(`Error token: ${res.status}`, ERROR_CODES.SII_CONNECTION_FAILED);

    const decoded = xml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const token = extractTagContent(decoded, 'TOKEN');
    if (!token) throw siiError('No se obtuvo TOKEN del SII', ERROR_CODES.SII_AUTH_FAILED);

    return token;
  }

  /** Obtiene o reutiliza el token SOAP (con cache opcional) */
  async _ensureToken() {
    if (this.useTokenCache) {
      const cached = getCachedToken(this.ambiente, 'soap', this.rutCert);
      if (cached) {
        this._tokenSoap = cached;
        return cached;
      }
    }

    const token = await this._fetchTokenSoap();
    this._tokenSoap = token;

    if (this.useTokenCache) {
      setCachedToken(this.ambiente, 'soap', this.rutCert, token);
    }
    return token;
  }

  /** Invalida el token cacheado para forzar renovación */
  invalidarToken() {
    this._tokenSoap = null;
    // invalidateToken no está disponible en utils — limpiamos el caché con un token vacío
    // o simplemente seteamos nulo; el cache expira por TTL
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FIRMA DE SEMILLA — idéntico a EnviadorSII._crearXMLSemilla
  // ══════════════════════════════════════════════════════════════════════════════

  _firmarSemilla(semilla) {
    const xmlContent = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;

    const md = forge.md.sha1.create();
    md.update(xmlContent, 'utf8');
    const digestValue = forge.util.encode64(md.digest().bytes());

    const signedInfoParaFirmar = [
      '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod>',
      '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>',
      '<Reference URI=""><Transforms>',
      '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>',
      '</Transforms>',
      '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>',
      `<DigestValue>${digestValue}</DigestValue>`,
      '</Reference></SignedInfo>',
    ].join('');

    const mdSign = forge.md.sha1.create();
    mdSign.update(signedInfoParaFirmar, 'utf8');
    const signature = this.certificado.privateKey.sign(mdSign);
    const signatureValue = this._wordwrap(forge.util.encode64(signature), 64);

    const modulus  = this._wordwrap(this.certificado.getModulus(), 64);
    const exponent = this.certificado.getExponent();
    const cert     = this._wordwrap(this.certificado.getCertificateBase64(), 64);

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<getToken><item><Semilla>${semilla}</Semilla></item>`,
      '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">',
      '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>',
      '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>',
      '<Reference URI=""><Transforms>',
      '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>',
      '</Transforms>',
      '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>',
      `<DigestValue>${digestValue}</DigestValue>`,
      '</Reference></SignedInfo>',
      `<SignatureValue>${signatureValue}</SignatureValue>`,
      '<KeyInfo><KeyValue><RSAKeyValue>',
      `<Modulus>${modulus}</Modulus>`,
      `<Exponent>${exponent}</Exponent>`,
      '</RSAKeyValue></KeyValue>',
      `<X509Data><X509Certificate>${cert}</X509Certificate></X509Data>`,
      '</KeyInfo></Signature></getToken>',
    ].join('');
  }

  _wordwrap(str, width) {
    const lines = [];
    for (let i = 0; i < str.length; i += width) {
      lines.push(str.substring(i, i + width));
    }
    return lines.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // LLAMADAS SOAP AL WSRECLAMO
  // ══════════════════════════════════════════════════════════════════════════════

  // Namespace oficial del servicio (fuente: WSDL producción/certificación)
  static NS = 'http://ws.registroreclamodte.diii.sdi.sii.cl';

  /**
   * Realiza una llamada SOAP al WSRECLAMO con autenticación via TOKEN cookie.
   * Namespace verificado desde: https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice?wsdl
   * @private
   */
  async _llamar(metodo, params, reintentar = true) {
    const token = await this._ensureToken();
    const ns = WsReclamo.NS;

    const innerXml = Object.entries(params)
      .map(([k, v]) => `<${k}>${v}</${k}>`)
      .join('');

    // El body usa el prefijo ws: con el namespace del servicio
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="${ns}">
  <soapenv:Header/>
  <soapenv:Body>
    <ws:${metodo}>${innerXml}</ws:${metodo}>
  </soapenv:Body>
</soapenv:Envelope>`;

    const { response: res, text: xml } = await this._fetch(this._wsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '',
        Cookie: `TOKEN=${token}`,
      },
      body: envelope,
    }, metodo);

    // Si el SII devuelve 403/401, el token puede haber expirado — reintentar una vez
    if ((res.status === 401 || res.status === 403) && reintentar) {
      log.log(`[WsReclamo] Token expirado (${res.status}), renovando...`);
      this._tokenSoap = null;
      return this._llamar(metodo, params, false);
    }

    if (!res.ok) {
      throw siiError(`WSRECLAMO ${metodo}: HTTP ${res.status}`, ERROR_CODES.SII_CONNECTION_FAILED);
    }

    return xml;
  }

  /**
   * Lista todos los eventos históricos de aceptación/reclamo para un DTE.
   *
   * @param {string} rutEmisor   — RUT sin DV ni puntos, ej: '76354771'
   * @param {string} dvEmisor    — DV del RUT, ej: 'K'
   * @param {number} tipoDoc     — Tipo de DTE, ej: 33 (factura afecta)
   * @param {number} folio       — Número de folio
   * @returns {Promise<{codResp: number, descResp: string, eventos: Array<{codEvento: string, descEvento: string, rutResponsable: string, dvResponsable: string, fechaEvento: string}>}>}
   */
  async listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio) {
    log.log(`[WsReclamo] listarEventosHistDoc RUT=${rutEmisor}-${dvEmisor} tipo=${tipoDoc} folio=${folio}`);

    const xml = await this._llamar('listarEventosHistDoc', {
      rutEmisor,
      dvEmisor,
      tipoDoc,
      folio,
    });

    return this._parsearRespuestaEventos(xml);
  }

  /**
   * Consulta el estado resumido del receptor para un DTE emitido.
   * Equivale a `(await consultarEstadoReceptorDetalle(...)).estado`; se mantiene para los
   * consumidores que guardan el estado como texto.
   *
   * Lanza (DteSiiError) si el SII responde un código de error o uno no documentado.
   *
   * @returns {Promise<'sin_accion'|'aceptada'|'acuse_recibo'|'reclamada'>}
   */
  async consultarEstadoReceptor(rutEmisor, dvEmisor, tipoDoc, folio) {
    const detalle = await this.consultarEstadoReceptorDetalle(rutEmisor, dvEmisor, tipoDoc, folio);
    return detalle.estado;
  }

  /**
   * Consulta el estado del receptor para un DTE, con el detalle de los eventos.
   *
   * Estado por prioridad (WS v1.2, combinaciones de ingresarAceptacionReclamoDoc):
   *   reclamada    hay algún RCD, RFP o RFT (`reclamo` dice cuál, el más reciente)
   *   aceptada     hay ACD y ningún reclamo
   *   acuse_recibo hay ERM y ni ACD ni reclamo
   *   sin_accion   ninguno de los anteriores (incluye codResp 16 y 18)
   * NCA y ENC no cambian el estado; se informan en `notaCredito`.
   *
   * Códigos de listarEventosHistDoc (doc SII v1.2):
   *   15 = Listado de eventos del documento
   *   16 = Documento no presenta eventos de reclamos o acuse de recibo  → sin_accion
   *   18 = Documento no ha sido recibido                                 → sin_accion
   *   cualquier otro (1, 2, 3, 8, 10, 14, 17, -1 o no documentado)      → lanza
   *
   * @param {string} rutEmisor
   * @param {string} dvEmisor
   * @param {number} tipoDoc
   * @param {number} folio
   * @returns {Promise<{
   *   estado: 'sin_accion'|'aceptada'|'acuse_recibo'|'reclamada',
   *   codResp: number,
   *   descResp: string,
   *   reclamo: {codigo: 'RCD'|'RFP'|'RFT', descripcion: string, fecha: string}|null,
   *   notaCredito: {codigo: 'NCA'|'ENC', descripcion: string, fecha: string}|null,
   *   eventos: Array<{codigo: string, descripcion: string, rutResponsable: string, fecha: string}>
   * }>}
   * @throws {DteSiiError} code SII_CONNECTION_FAILED para codResp -1 (reintentar más tarde),
   *   SII_REJECTED para los errores documentados y SII_INVALID_RESPONSE para un codResp
   *   desconocido. `details` lleva codResp y descResp.
   */
  async consultarEstadoReceptorDetalle(rutEmisor, dvEmisor, tipoDoc, folio) {
    const respuesta = await this.listarEventosHistDoc(rutEmisor, dvEmisor, tipoDoc, folio);
    return WsReclamo.derivarEstadoReceptor(respuesta);
  }

  /**
   * Deriva el estado del receptor desde la respuesta de listarEventosHistDoc. Es pura (sin
   * red) para poder probarla y reutilizarla con una respuesta ya obtenida.
   *
   * @param {{codResp: number, descResp: string, eventos: Array<{codEvento: string, descEvento: string, rutResponsable: string, dvResponsable: string, fechaEvento: string}>}} respuesta
   * @returns {Object} misma forma que consultarEstadoReceptorDetalle
   * @throws {DteSiiError} igual que consultarEstadoReceptorDetalle
   */
  static derivarEstadoReceptor({ codResp, descResp = '', eventos = [] }) {
    const vacio = { codResp, descResp, reclamo: null, notaCredito: null, eventos: [] };

    if (codResp === COD_SIN_EVENTOS || codResp === COD_NO_RECIBIDO) {
      return { estado: 'sin_accion', ...vacio };
    }

    if (codResp !== COD_LISTADO) {
      const conocido = Object.prototype.hasOwnProperty.call(WSRECLAMO_CODIGOS, String(codResp));
      const code = codResp === -1
        ? ERROR_CODES.SII_CONNECTION_FAILED
        : conocido ? ERROR_CODES.SII_REJECTED : ERROR_CODES.SII_INVALID_RESPONSE;
      const tipo = codResp === -1
        ? 'error interno del SII, reintentar más tarde'
        : conocido ? 'error' : 'código no documentado';
      throw siiError(
        `WSRECLAMO listarEventosHistDoc: ${tipo} (codResp=${codResp}, descResp="${descResp}")`,
        code,
        { codResp, descResp },
      );
    }

    const lista = (eventos || []).map((ev) => ({
      codigo: String(ev.codEvento || '').trim().toUpperCase(),
      descripcion: ev.descEvento || '',
      rutResponsable: ev.rutResponsable
        ? `${ev.rutResponsable}${ev.dvResponsable ? `-${ev.dvResponsable}` : ''}`
        : '',
      fecha: ev.fechaEvento || '',
    }));

    const resumen = (ev) => (ev ? { codigo: ev.codigo, descripcion: ev.descripcion, fecha: ev.fecha } : null);

    const reclamo = resumen(WsReclamo._masReciente(lista.filter((ev) => EVENTOS_RECLAMO.includes(ev.codigo))));
    // Si hay NC de anulación se informa esa aunque haya también una ENC: anula el documento.
    const nca = lista.filter((ev) => ev.codigo === 'NCA');
    const notaCredito = resumen(WsReclamo._masReciente(nca.length
      ? nca
      : lista.filter((ev) => EVENTOS_NOTA_CREDITO.includes(ev.codigo))));

    let estado = 'sin_accion';
    if (reclamo) estado = 'reclamada';
    else if (lista.some((ev) => ev.codigo === 'ACD')) estado = 'aceptada';
    else if (lista.some((ev) => ev.codigo === 'ERM')) estado = 'acuse_recibo';

    return { estado, codResp, descResp, reclamo, notaCredito, eventos: lista };
  }

  /**
   * Fecha y hora de recepción del DTE en el SII. Desde ahí corren los 8 días corridos para
   * reclamar o acusar recibo (Ley 19.983, WS v1.2).
   *
   * El SII responde un VARCHAR(100), por ejemplo '21-02-2017 19:02:03' (hora de Chile).
   *
   * @param {string} rutEmisor
   * @param {string} dvEmisor
   * @param {number} tipoDoc
   * @param {number} folio
   * @returns {Promise<{fechaRecepcion: string, fechaRecepcionIso: string}|null>}
   *   `fechaRecepcion` tal como la entrega el SII; `fechaRecepcionIso` 'AAAA-MM-DDTHH:mm:ss'
   *   en hora de Chile, sin zona. null si el SII responde vacío.
   * @throws {DteSiiError} SII_INVALID_RESPONSE si la respuesta no es una fecha (se incluye el texto).
   */
  async consultarFechaRecepcionSii(rutEmisor, dvEmisor, tipoDoc, folio) {
    log.log(`[WsReclamo] consultarFechaRecepcionSii RUT=${rutEmisor}-${dvEmisor} tipo=${tipoDoc} folio=${folio}`);

    const xml = await this._llamar('consultarFechaRecepcionSii', {
      rutEmisor,
      dvEmisor,
      tipoDoc,
      folio,
    });

    return this._parsearFechaRecepcion(xml);
  }

  /**
   * Ingresa una acción de aceptación o reclamo sobre un DTE recibido.
   * Uso típico: el receptor registra su decisión.
   *
   * @param {string} rutEmisor
   * @param {string} dvEmisor
   * @param {number} tipoDoc
   * @param {number} folio
   * @param {AccionReclamo} accionDoc  — 'ACD'|'ERM'|'RCD'|'RFP'|'RFT'
   * @returns {Promise<{codResp: number, descResp: string}>}
   */
  async ingresarAceptacion(rutEmisor, dvEmisor, tipoDoc, folio, accionDoc) {
    const ACCIONES_VALIDAS = ['ACD', 'ERM', 'RCD', 'RFP', 'RFT'];
    if (!ACCIONES_VALIDAS.includes(accionDoc)) {
      throw new Error(`WsReclamo: accionDoc inválida '${accionDoc}'. Debe ser una de: ${ACCIONES_VALIDAS.join(', ')}`);
    }

    log.log(`[WsReclamo] ingresarAceptacion RUT=${rutEmisor}-${dvEmisor} tipo=${tipoDoc} folio=${folio} accion=${accionDoc}`);

    const xml = await this._llamar('ingresarAceptacionReclamoDoc', {
      rutEmisor,
      dvEmisor,
      tipoDoc,
      folio,
      accionDoc,
    });

    return this._parsearRespuestaSimple(xml);
  }

  /**
   * @private
   * Convierte 'DD-MM-AAAA HH:mm:ss' (formato del SII) a 'AAAA-MM-DDTHH:mm:ss', hora de Chile
   * sin zona. Acepta también 'AAAA-MM-DD HH:mm:ss'. Devuelve null si no reconoce el formato.
   * @param {string} texto
   * @returns {string|null}
   */
  static _fechaSiiAIso(texto) {
    const t = String(texto || '').trim();
    let m = t.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const [, d, mes, a, h = '00', min = '00', seg = '00'] = m;
      return `${a}-${mes}-${d}T${h}:${min}:${seg}`;
    }
    m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const [, a, mes, d, h = '00', min = '00', seg = '00'] = m;
      return `${a}-${mes}-${d}T${h}:${min}:${seg}`;
    }
    return null;
  }

  /**
   * @private
   * Elige el evento más reciente de una lista. Ordena por fecha del evento; si dos fechas son
   * iguales o no se pueden leer, gana el que viene después en la lista del SII.
   * @param {Array<{fecha: string}>} lista
   */
  static _masReciente(lista) {
    let elegido = null;
    let claveElegida = '';
    for (const ev of lista) {
      const clave = WsReclamo._fechaSiiAIso(ev.fecha) || '';
      if (!elegido || clave >= claveElegida) {
        elegido = ev;
        claveElegida = clave;
      }
    }
    return elegido;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // PARSERS XML
  // ══════════════════════════════════════════════════════════════════════════════

  /**
   * @private
   * Texto de un campo de la respuesta del SII: decodifica las referencias numéricas de
   * caracteres y quita los espacios de los extremos. null o undefined dan ''.
   *
   * Medido en el SII (certificación, 2026-11-16): listarEventosHistDoc entrega
   * `<descEvento>Reclamo por Falta Parcial de Mercader&#237;as </descEvento>`, con la í como
   * `&#237;` y un espacio al final. Las entidades con nombre ya las decodifica el parser
   * antes de extraer el campo; las numéricas no.
   * @param {string|null|undefined} texto
   * @returns {string}
   */
  static _textoSii(texto) {
    return String(texto ?? '')
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => WsReclamo._caracter(parseInt(h, 16), m))
      .replace(/&#(\d+);/g, (m, d) => WsReclamo._caracter(parseInt(d, 10), m))
      .trim();
  }

  /** @private Carácter de un código Unicode; si no es válido deja la referencia tal cual. */
  static _caracter(codigo, original) {
    try { return String.fromCodePoint(codigo); } catch { return original; }
  }

  /**
   * Parsea respuesta de listarEventosHistDoc.
   *
   * Estructura real (verificada en doc SII v1.2 y SoapUI screenshot):
   * <return>
   *   <codResp>15</codResp>
   *   <descResp>Listado de eventos del documento</descResp>
   *   <listaEventosDoc>
   *     <codEvento>ACD</codEvento>
   *     <descEvento>Acepta Contenido del Documento</descEvento>
   *     <rutResponsable>45000055</rutResponsable>
   *     <dvResponsable>8</dvResponsable>
   *     <fechaEvento>29-12-2016 12:05:36</fechaEvento>
   *   </listaEventosDoc>
   * </return>
   */
  _parsearRespuestaEventos(xml) {
    // Decode HTML entities del wrapper SOAP
    const decoded = xml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');

    // Extraer el bloque <return>...</return>
    const returnMatch = decoded.match(/<return>([\s\S]*?)<\/return>/i);
    const bloque = returnMatch ? returnMatch[1] : decoded;

    // Sin codResp la respuesta no es la del método: antes se asumía 16 (sin eventos) y un
    // documento reclamado podía terminar informado como 'sin_accion'.
    const codRespTexto = extractTagContent(bloque, 'codResp');
    const codResp = codRespTexto == null ? NaN : parseInt(codRespTexto.trim(), 10);
    if (!Number.isFinite(codResp)) {
      throw siiError(
        `WSRECLAMO listarEventosHistDoc: respuesta sin codResp válido: ${String(xml).slice(0, 300)}`,
        ERROR_CODES.SII_INVALID_RESPONSE,
      );
    }
    const descResp = WsReclamo._textoSii(extractTagContent(bloque, 'descResp'));

    // Extraer cada <listaEventosDoc>...</listaEventosDoc>
    const eventos = [];
    const itemRegex = /<listaEventosDoc>([\s\S]*?)<\/listaEventosDoc>/gi;
    let match;
    while ((match = itemRegex.exec(bloque)) !== null) {
      const item = match[1];
      eventos.push({
        codEvento:       WsReclamo._textoSii(extractTagContent(item, 'codEvento')),
        descEvento:      WsReclamo._textoSii(extractTagContent(item, 'descEvento')),
        rutResponsable:  WsReclamo._textoSii(extractTagContent(item, 'rutResponsable')),
        dvResponsable:   WsReclamo._textoSii(extractTagContent(item, 'dvResponsable')),
        fechaEvento:     WsReclamo._textoSii(extractTagContent(item, 'fechaEvento')),
      });
    }

    return { codResp, descResp, eventos };
  }

  /**
   * Parsea respuesta de ingresarAceptacionReclamoDoc y consultarDocDteCedible.
   *
   * Estructura:
   * <return>
   *   <codResp>0</codResp>
   *   <descResp>Acción completada OK</descResp>
   * </return>
   *
   * codResp 0 = OK (ingresarAceptacion)
   */
  _parsearRespuestaSimple(xml) {
    const decoded = xml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

    const returnMatch = decoded.match(/<return>([\s\S]*?)<\/return>/i);
    const bloque = returnMatch ? returnMatch[1] : decoded;

    const codResp  = parseInt(extractTagContent(bloque, 'codResp') ?? '-1', 10);
    const descResp = WsReclamo._textoSii(extractTagContent(bloque, 'descResp'));
    return { codResp, descResp };
  }

  /**
   * Parsea respuesta de consultarFechaRecepcionSii.
   *
   * Estructura (WS v1.2, parámetro de salida "Fecha Recepción SII", VARCHAR 100):
   * <return>21-02-2017 19:02:03</return>
   */
  _parsearFechaRecepcion(xml) {
    const decoded = decodeXmlEntities(String(xml || ''));
    const returnMatch = decoded.match(/<return>([\s\S]*?)<\/return>/i);
    if (!returnMatch && !/<return\s*\/>/i.test(decoded)) {
      throw siiError(
        `WSRECLAMO consultarFechaRecepcionSii: respuesta sin <return>: ${decoded.slice(0, 300)}`,
        ERROR_CODES.SII_INVALID_RESPONSE,
      );
    }
    const texto = (returnMatch ? returnMatch[1] : '').trim();
    if (!texto) return null;

    const fechaRecepcionIso = WsReclamo._fechaSiiAIso(texto);
    if (!fechaRecepcionIso) {
      throw siiError(
        `WSRECLAMO consultarFechaRecepcionSii: la respuesta no es una fecha: "${texto.slice(0, 100)}"`,
        ERROR_CODES.SII_INVALID_RESPONSE,
        { respuesta: texto },
      );
    }
    return { fechaRecepcion: texto, fechaRecepcionIso };
  }
}

module.exports = WsReclamo;
