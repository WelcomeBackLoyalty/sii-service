'use strict';

/**
 * Ficha de la empresa en el SII ("Actualizacion de datos del contribuyente").
 *
 * El SII retiro las paginas antiguas de la ficha (cvc_cgi/dte/ad_empresa1..4): en produccion
 * responden 404 desde el 2026-11-17 y en certificacion redirigen a la pagina de error. El
 * reemplazo es la app "Mantenedor de Usuarios DTE" (sii-muyd-inter), un SPA con API JSON:
 *
 *   produccion:    https://www2.sii.cl/app/sii-muyd/ct/{rut}-{dv}/...
 *   certificacion: https://www2c.sii.cl/app/sii-muyd/ct/{rut}-{dv}/...
 *
 * Condiciones medidas contra produccion con login por certificado (sin clave tributaria ni MFA):
 *  - Se envian TODAS las cookies del login, incluidas las NETSCAPE_LIVEWIRE.* (con punto).
 *  - Cabeceras de navegador (user-agent de Chrome, referer del SPA, sec-fetch-*,
 *    X-SII-SESSION-USER-AUTH-TYPE=CT, X-SII-SESSION-USER-ID del titular). Sin ellas, todo
 *    /app/sii-muyd/* responde 401 aunque session/status responda 200.
 *  - Secuencia: GET del SPA -> GET session/status -> GET esUsuarioAdministrador -> operacion.
 *  - 401 en /ct/ con session/status en 200 = el titular no tiene acceso a esa empresa.
 *  - NUNCA llamar existEmpresa: responde 428 (exige MFA) y no hace falta para leer ni grabar.
 *  - Para grabar se manda la ficha COMPLETA leida, cambiando solo lo pedido, con
 *    rutResponsable/dvResponsable del titular de la sesion.
 */

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/142.0.0.0 Safari/537.36';

/** Regex de correo del SPA del SII (maximo 50 caracteres). */
const REGEX_CORREO = /^(?=.{1,50}$)[-\w.%+]{1,64}@(?:[A-Z0-9-]{1,63}\.){1,125}[A-Z]{2,63}$/i;

/** Campos que `actualizarFicha` acepta cambiar. */
const CAMPOS_EDITABLES = ['mailSupusuario', 'mailContactoSii', 'mailContactoDte', 'nombreSw', 'url'];
const CAMPOS_CORREO = new Set(['mailSupusuario', 'mailContactoSii', 'mailContactoDte']);

const CODIGOS_HTTP = {
  401: { code: 'FICHA_SESION_INVALIDA', texto: 'sesion no valida para la app de la ficha' },
  // 401 en /ct/{rut}-{dv}/* con session/status en 200: la sesion esta viva pero el titular no
  // tiene acceso a esa empresa (medido en produccion con un RUT del que no es usuario).
  '401ct': { code: 'FICHA_SIN_ACCESO_EMPRESA', texto: 'el titular de la sesion no tiene acceso a la ficha de esta empresa, o la empresa no es emisor electronico' },
  403: { code: 'FICHA_REQUIERE_CLAVE_TRIBUTARIA', texto: 'el SII exige autenticarse con RUT y Clave Tributaria' },
  428: { code: 'FICHA_REQUIERE_MFA', texto: 'el SII exige la verificacion en dos pasos (MFA)' },
};

function _normalizarRut(rut) {
  const limpio = String(rut || '').replace(/\./g, '').trim();
  const m = limpio.match(/^(\d{1,9})-([0-9Kk])$/);
  if (!m) throw new TypeError(`SiiFichaEmpresa: RUT invalido "${rut}". Formato esperado: "77111222-3"`);
  return { num: m[1], dv: m[2].toUpperCase(), rut: `${m[1]}-${m[2].toUpperCase()}` };
}

function _errorHttp(paso, url, res) {
  const enCt = url.includes('/app/sii-muyd/ct/');
  const esRedireccion = res.status >= 300 && res.status < 400;
  const conocido = (res.status === 401 && enCt) ? CODIGOS_HTTP['401ct']
    : esRedireccion ? { code: 'FICHA_REDIRECCION', texto: `el SII redirige a ${(res.headers && res.headers.location) || '(sin location)'}; la app no acepta la sesion` }
      : CODIGOS_HTTP[res.status];
  const cuerpo = res.body == null ? '' : String(res.body);
  const err = new Error(
    `SiiFichaEmpresa: ${paso} respondio HTTP ${res.status}` +
    (conocido ? ` (${conocido.texto})` : '') +
    ` en ${url}. Cuerpo del SII: ${cuerpo || '(vacio)'}`,
  );
  err.code = conocido ? conocido.code : 'FICHA_HTTP_ERROR';
  err.status = res.status;
  err.body = cuerpo;
  err.paso = paso;
  return err;
}

function _parsearJson(paso, url, res) {
  const texto = res.body == null ? '' : String(res.body).trim();
  if (texto === '' || texto === 'null') {
    const err = new Error(
      `SiiFichaEmpresa: ${paso} respondio HTTP ${res.status} sin contenido en ${url}.`,
    );
    err.code = 'FICHA_VACIA';
    err.status = res.status;
    err.body = res.body;
    err.paso = paso;
    throw err;
  }
  try {
    return JSON.parse(res.body);
  } catch {
    const err = new Error(
      `SiiFichaEmpresa: ${paso} respondio HTTP ${res.status} sin JSON valido en ${url}. ` +
      `Cuerpo del SII: ${res.body || '(vacio)'}`,
    );
    err.code = 'FICHA_RESPUESTA_INVALIDA';
    err.status = res.status;
    err.body = res.body;
    err.paso = paso;
    throw err;
  }
}

class SiiFichaEmpresa {
  /**
   * @param {Object} opts
   * @param {import('./SiiPortalAuth')} opts.auth - Instancia de SiiPortalAuth (login por certificado).
   * @param {'certificacion'|'produccion'} [opts.ambiente='produccion']
   */
  constructor({ auth, ambiente = 'produccion' } = {}) {
    if (!auth || typeof auth._request !== 'function') {
      throw new TypeError('SiiFichaEmpresa: se requiere una instancia de SiiPortalAuth en opts.auth');
    }
    this._auth = auth;
    this._host = SiiFichaEmpresa.host(ambiente);
  }

  /** Host de la app segun el ambiente. La de certificacion no esta medida. */
  static host(ambiente) {
    if (ambiente === 'produccion') return 'www2.sii.cl';
    if (ambiente === 'certificacion') return 'www2c.sii.cl';
    throw new TypeError(`SiiFichaEmpresa: ambiente invalido "${ambiente}" (certificacion | produccion)`);
  }

  static validarCorreo(valor) {
    return typeof valor === 'string' && REGEX_CORREO.test(valor);
  }

  /**
   * Lee la ficha (respuesta de obtenerEmpresa).
   * @param {string} rutEmpresa - "77111222-3"
   * @param {Object} [opts]
   * @param {Object} [opts.cookieJar] - Sesion ya autenticada; si se omite, autentica.
   * @returns {Promise<Object>}
   */
  async leerFicha(rutEmpresa, { cookieJar } = {}) {
    const empresa = _normalizarRut(rutEmpresa);
    return this._conSesionFicha(cookieJar, empresa, (s) => this._obtenerEmpresa(s, empresa));
  }

  /**
   * Cambia solo los campos pedidos de la ficha: lee, mezcla, graba la ficha completa y vuelve a
   * leer para confirmar.
   * @param {string} rutEmpresa - "77111222-3"
   * @param {Object} cambios - Subconjunto de mailSupusuario, mailContactoSii, mailContactoDte, nombreSw, url.
   * @param {Object} [opts]
   * @param {Object} [opts.cookieJar]
   * @returns {Promise<{antes: Object, despues: Object}>}
   */
  async actualizarFicha(rutEmpresa, cambios, { cookieJar } = {}) {
    const empresa = _normalizarRut(rutEmpresa);
    SiiFichaEmpresa._validarCambios(cambios);

    return this._conSesionFicha(cookieJar, empresa, async (s) => {
      const antes = await this._obtenerEmpresa(s, empresa);
      const ficha = {
        ...antes,
        ...cambios,
        rutResponsable: s.titular.num,
        dvResponsable: s.titular.dv,
      };
      const url = this._urlCt(empresa, 'actualizarEmpresa');
      const res = await this._auth._request(url, {
        method: 'PUT',
        cookieJar: s.jar,
        body: JSON.stringify(ficha),
        headers: {
          ...this._cabeceras(s.titular),
          'Content-Type': 'application/json',
          'Origin': `https://${this._host}`,
        },
      });
      if (res.status !== 200) throw _errorHttp('actualizarEmpresa', url, res);

      const despues = await this._obtenerEmpresa(s, empresa);
      // El SII podria normalizar mayusculas o espacios: se compara normalizado.
      const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
      const distintos = Object.keys(cambios).filter((k) => norm(despues[k]) !== norm(cambios[k]));
      if (distintos.length) {
        const err = new Error(
          `SiiFichaEmpresa: el SII respondio 200 a actualizarEmpresa pero la ficha leida despues no ` +
          `tiene los valores pedidos en: ${distintos.join(', ')}. Pedido: ${JSON.stringify(cambios)}. ` +
          `Leido: ${JSON.stringify(despues)}`,
        );
        err.code = 'FICHA_NO_CONFIRMADA';
        err.antes = antes;
        err.despues = despues;
        throw err;
      }
      return { antes, despues };
    });
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  static _validarCambios(cambios) {
    if (!cambios || typeof cambios !== 'object' || !Object.keys(cambios).length) {
      throw new TypeError('SiiFichaEmpresa: no hay cambios que grabar');
    }
    const ajenos = Object.keys(cambios).filter((k) => !CAMPOS_EDITABLES.includes(k));
    if (ajenos.length) {
      throw new TypeError(
        `SiiFichaEmpresa: campos no editables: ${ajenos.join(', ')}. Permitidos: ${CAMPOS_EDITABLES.join(', ')}`,
      );
    }
    for (const [k, v] of Object.entries(cambios)) {
      if (CAMPOS_CORREO.has(k) && !SiiFichaEmpresa.validarCorreo(v)) {
        throw new TypeError(
          `SiiFichaEmpresa: ${k} invalido ("${v}"): el SII exige un correo valido de maximo 50 caracteres`,
        );
      }
      if (k === 'nombreSw' && (typeof v !== 'string' || !v.trim())) {
        throw new TypeError('SiiFichaEmpresa: nombreSw es obligatorio');
      }
      if (k === 'url' && v !== null && typeof v !== 'string') {
        throw new TypeError('SiiFichaEmpresa: url debe ser texto o null');
      }
    }
  }

  _urlCt(empresa, ruta) {
    return `https://${this._host}/app/sii-muyd/ct/${empresa.rut}/${ruta}`;
  }

  _cabeceras(titular) {
    return {
      'User-Agent': UA_CHROME,
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://${this._host}/sii-muyd-inter/`,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'X-SII-SESSION-USER-AUTH-TYPE': 'CT',
      ...(titular ? { 'X-SII-SESSION-USER-ID': titular.rut } : {}),
    };
  }

  async _obtenerEmpresa(s, empresa) {
    const url = this._urlCt(empresa, 'obtenerEmpresa');
    const res = await this._auth._request(url, { cookieJar: s.jar, headers: this._cabeceras(s.titular) });
    if (res.status !== 200) throw _errorHttp('obtenerEmpresa', url, res);
    const ficha = _parsearJson('obtenerEmpresa', url, res);
    if (!ficha || typeof ficha !== 'object') {
      const err = new Error(
        `SiiFichaEmpresa: obtenerEmpresa no devolvio una ficha para ${empresa.rut}. Cuerpo del SII: ${res.body || '(vacio)'}`,
      );
      err.code = 'FICHA_VACIA';
      err.status = res.status;
      err.body = res.body;
      throw err;
    }
    return ficha;
  }

  /**
   * Prepara la sesion de la app (SPA -> session/status -> esUsuarioAdministrador) y ejecuta `fn`.
   * Si session/status responde 401 con una sesion propia (no la del llamador), se re-autentica
   * una vez: la sesion guardada pudo vencer. Un 401 en /ct/ (sin acceso a la empresa), 403 y 428
   * no se reintentan.
   * @private
   */
  async _conSesionFicha(cookieJar, empresa, fn) {
    const propia = !cookieJar;
    for (let intento = 1; ; intento++) {
      const base = cookieJar || await this._auth.autenticar();
      // Copia: las cookies que fija la app (dtCookie, TS...) no deben pisar las de la sesion
      // compartida, que usan otras paginas del portal.
      const s = { jar: { ...base }, titular: null };
      try {
        await this._prepararSesion(s, empresa);
        return await fn(s);
      } catch (err) {
        if (err.code === 'FICHA_SESION_INVALIDA' && propia && intento === 1) {
          await this._auth.limpiarSesion();
          continue;
        }
        throw err;
      }
    }
  }

  async _prepararSesion(s, empresa) {
    await this._auth._request(`https://${this._host}/sii-muyd-inter/`, {
      cookieJar: s.jar,
      headers: { 'User-Agent': UA_CHROME },
    });

    const urlStatus = `https://${this._host}/app/session/status`;
    const st = await this._auth._request(urlStatus, { cookieJar: s.jar, headers: this._cabeceras(null) });
    if (st.status !== 200) throw _errorHttp('session/status', urlStatus, st);
    const estado = _parsearJson('session/status', urlStatus, st);
    try {
      s.titular = _normalizarRut(estado && estado.userId);
    } catch {
      const err = new Error(
        `SiiFichaEmpresa: session/status no trae un userId valido en ${urlStatus}. Cuerpo del SII: ${st.body}`,
      );
      err.code = 'FICHA_RESPUESTA_INVALIDA';
      err.status = st.status;
      err.body = st.body;
      err.paso = 'session/status';
      throw err;
    }

    const urlAdmin = this._urlCt(empresa, 'esUsuarioAdministrador');
    const adm = await this._auth._request(urlAdmin, { cookieJar: s.jar, headers: this._cabeceras(s.titular) });
    if (adm.status !== 200) throw _errorHttp('esUsuarioAdministrador', urlAdmin, adm);
    s.esAdministrador = _parsearJson('esUsuarioAdministrador', urlAdmin, adm) === true;
  }
}

SiiFichaEmpresa.CAMPOS_EDITABLES = CAMPOS_EDITABLES;
SiiFichaEmpresa.REGEX_CORREO = REGEX_CORREO;

module.exports = SiiFichaEmpresa;
