'use strict';

// Ficha de la empresa sobre la API nueva del SII (sii-muyd), con respuestas grabadas y sin red.
// El SII retiro las paginas antiguas cvc_cgi/dte/ad_empresa1..4 (2026-11-17). Datos inventados.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const SiiPortalAuth = require('../SiiPortalAuth');
const SiiFichaEmpresa = require('../SiiFichaEmpresa');

const TITULAR = '11111111-1';
const EMPRESA = '76543210-K';

const fichaBase = (extra = {}) => ({
  rut: 76543210, dv: 'K',
  tipoFacturacion: '1',
  fechaResolucion: '2014-08-22', resolucion: '80',
  rutResponsable: '22222222', dvResponsable: '2',
  nombreSw: 'SOFTWARE EJEMPLO', entidadCertificadora: 'SII',
  fechaAutorizacion: '2024-04-16',
  mailContactoDte: 'dte@ejemplo.cl',
  mailContactoSii: 'sii@ejemplo.cl',
  mailSupusuario: 'admin@ejemplo.cl',
  fechaDesautorizacion: null,
  url: 'www.ejemplo.cl',
  codigo: 123,
  mailRepresentante: null, telefonoContacto: null,
  ...extra,
});

/**
 * SII falso: responde segun la ruta y registra cada llamada (url, metodo, cabeceras, cookies, body).
 * `respuestas` permite pisar una ruta: { obtenerEmpresa: [{status, body}, ...] } (se consumen en orden).
 */
function siiFalso({ ficha = fichaBase(), respuestas = {} } = {}) {
  const auth = Object.create(SiiPortalAuth.prototype);
  const llamadas = [];
  let guardada = ficha;
  auth.autenticaciones = 0;
  auth.limpiezas = 0;
  auth.autenticar = async () => {
    auth.autenticaciones++;
    return { 'NETSCAPE_LIVEWIRE.rut': '11111111', 'NETSCAPE_LIVEWIRE.dv': '1', TOKEN: 't' };
  };
  auth.limpiarSesion = async () => { auth.limpiezas++; };
  auth._request = async (url, { method = 'GET', cookieJar = {}, body = null, headers = {} } = {}) => {
    llamadas.push({ url, method, headers, cookies: { ...cookieJar }, body });
    const ruta = url.split('/').pop();
    const cola = respuestas[ruta];
    if (cola && cola.length) return cola.shift();
    if (url.endsWith('/sii-muyd-inter/')) {
      cookieJar.dtCookie = 'spa';
      return { status: 200, body: '<html></html>', headers: {} };
    }
    if (url.endsWith('/app/session/status')) {
      return { status: 200, body: JSON.stringify({ seconds: 5999, userId: TITULAR, userAuthType: 'CT' }), headers: {} };
    }
    if (ruta === 'esUsuarioAdministrador') return { status: 200, body: 'true', headers: {} };
    if (ruta === 'obtenerEmpresa') return { status: 200, body: JSON.stringify(guardada), headers: {} };
    if (ruta === 'actualizarEmpresa') {
      guardada = JSON.parse(body);
      return { status: 200, body, headers: {} };
    }
    return { status: 404, body: 'no mapeado', headers: {} };
  };
  return { auth, llamadas };
}

const rutas = (llamadas) => llamadas.map((l) => `${l.method} ${l.url.replace(/^https:\/\/[^/]+/, '')}`);

test('leerFicha sigue la secuencia medida y nunca llama existEmpresa', async () => {
  const { auth, llamadas } = siiFalso();
  const ficha = await new SiiFichaEmpresa({ auth }).leerFicha('76.543.210-k');
  assert.equal(ficha.resolucion, '80');
  assert.deepEqual(rutas(llamadas), [
    'GET /sii-muyd-inter/',
    'GET /app/session/status',
    `GET /app/sii-muyd/ct/${EMPRESA}/esUsuarioAdministrador`,
    `GET /app/sii-muyd/ct/${EMPRESA}/obtenerEmpresa`,
  ]);
  assert.ok(llamadas.every((l) => l.url.startsWith('https://www2.sii.cl/')));
  assert.ok(!llamadas.some((l) => l.url.includes('existEmpresa')));
});

test('las llamadas a la API llevan cabeceras de navegador y el titular de la sesion', async () => {
  const { auth, llamadas } = siiFalso();
  await new SiiFichaEmpresa({ auth }).leerFicha(EMPRESA);
  const h = llamadas.find((l) => l.url.endsWith('obtenerEmpresa')).headers;
  assert.match(h['User-Agent'], /Chrome\/\d+/);
  assert.equal(h['Referer'], 'https://www2.sii.cl/sii-muyd-inter/');
  assert.equal(h['Sec-Fetch-Site'], 'same-origin');
  assert.equal(h['Sec-Fetch-Mode'], 'cors');
  assert.equal(h['Accept'], 'application/json, text/plain, */*');
  assert.equal(h['X-SII-SESSION-USER-AUTH-TYPE'], 'CT');
  assert.equal(h['X-SII-SESSION-USER-ID'], TITULAR);
});

test('se envian todas las cookies del login (con punto) sin contaminar la sesion compartida', async () => {
  const { auth, llamadas } = siiFalso();
  const jar = { 'NETSCAPE_LIVEWIRE.rut': '11111111', 'NETSCAPE_LIVEWIRE.clave': 'x', TOKEN: 't' };
  await new SiiFichaEmpresa({ auth }).leerFicha(EMPRESA, { cookieJar: jar });
  const c = llamadas.find((l) => l.url.endsWith('obtenerEmpresa')).cookies;
  assert.equal(c['NETSCAPE_LIVEWIRE.rut'], '11111111');
  assert.equal(c['NETSCAPE_LIVEWIRE.clave'], 'x');
  assert.equal(c.dtCookie, 'spa', 'la cookie que fija el SPA se reenvia');
  assert.equal(jar.dtCookie, undefined, 'el jar del llamador no se modifica');
  assert.equal(auth.autenticaciones, 0, 'con jar del llamador no se autentica');
});

test('certificacion usa www2c.sii.cl y un ambiente desconocido lanza', async () => {
  const { auth, llamadas } = siiFalso();
  await new SiiFichaEmpresa({ auth, ambiente: 'certificacion' }).leerFicha(EMPRESA);
  assert.ok(llamadas.every((l) => l.url.startsWith('https://www2c.sii.cl/')));
  assert.throws(() => new SiiFichaEmpresa({ auth, ambiente: 'produccion-x' }), /ambiente invalido/);
});

test('actualizarFicha graba la ficha completa cambiando solo lo pedido y confirma con una lectura', async () => {
  const { auth, llamadas } = siiFalso();
  const r = await new SiiFichaEmpresa({ auth }).actualizarFicha(EMPRESA, { mailContactoSii: 'nuevo@ejemplo.cl' });

  const put = llamadas.find((l) => l.method === 'PUT');
  assert.ok(put.url.endsWith(`/ct/${EMPRESA}/actualizarEmpresa`));
  assert.equal(put.headers['Content-Type'], 'application/json');
  assert.equal(put.headers['Origin'], 'https://www2.sii.cl');
  const enviada = JSON.parse(put.body);
  assert.deepEqual(enviada, {
    ...fichaBase(),
    mailContactoSii: 'nuevo@ejemplo.cl',
    rutResponsable: '11111111',
    dvResponsable: '1',
  });
  assert.equal(r.antes.mailContactoSii, 'sii@ejemplo.cl');
  assert.equal(r.despues.mailContactoSii, 'nuevo@ejemplo.cl');
  assert.equal(r.despues.mailSupusuario, 'admin@ejemplo.cl');
  assert.equal(r.despues.mailContactoDte, 'dte@ejemplo.cl');
  // lectura, PUT y lectura de confirmacion
  assert.deepEqual(rutas(llamadas).slice(3), [
    `GET /app/sii-muyd/ct/${EMPRESA}/obtenerEmpresa`,
    `PUT /app/sii-muyd/ct/${EMPRESA}/actualizarEmpresa`,
    `GET /app/sii-muyd/ct/${EMPRESA}/obtenerEmpresa`,
  ]);
});

test('actualizarFicha falla si la lectura posterior no tiene el valor pedido', async () => {
  const { auth } = siiFalso({
    respuestas: {
      obtenerEmpresa: [
        { status: 200, body: JSON.stringify(fichaBase()) },
        { status: 200, body: JSON.stringify(fichaBase()) },
      ],
      actualizarEmpresa: [{ status: 200, body: '{}' }],
    },
  });
  await assert.rejects(
    () => new SiiFichaEmpresa({ auth }).actualizarFicha(EMPRESA, { mailContactoSii: 'nuevo@ejemplo.cl' }),
    (e) => e.code === 'FICHA_NO_CONFIRMADA' && !!e.antes && !!e.despues,
  );
});

test('actualizarFicha valida antes de tocar la red: correo, largo y campos no editables', async () => {
  const { auth, llamadas } = siiFalso();
  const f = new SiiFichaEmpresa({ auth });
  const largo = `${'a'.repeat(40)}@ejemplo.cl`; // 51 caracteres
  await assert.rejects(() => f.actualizarFicha(EMPRESA, { mailSupusuario: 'no-es-correo' }), /mailSupusuario invalido/);
  await assert.rejects(() => f.actualizarFicha(EMPRESA, { mailContactoDte: largo }), /maximo 50/);
  await assert.rejects(() => f.actualizarFicha(EMPRESA, { resolucion: '1' }), /no editables: resolucion/);
  await assert.rejects(() => f.actualizarFicha(EMPRESA, {}), /no hay cambios/);
  await assert.rejects(() => f.actualizarFicha('123', { url: 'x' }), /RUT invalido/);
  assert.equal(llamadas.length, 0);
  assert.ok(SiiFichaEmpresa.validarCorreo(`${'a'.repeat(39)}@ejemplo.cl`));
});

test('401 en session/status con el jar del llamador: error con codigo, status y cuerpo completo, sin reintento', async () => {
  const cuerpo = '{"mensaje":"' + 'x'.repeat(800) + '"}';
  const { auth } = siiFalso({ respuestas: { status: [{ status: 401, body: cuerpo }] } });
  await assert.rejects(
    () => new SiiFichaEmpresa({ auth }).leerFicha(EMPRESA, { cookieJar: { TOKEN: 't' } }),
    (e) => e.code === 'FICHA_SESION_INVALIDA' && e.status === 401 && e.body === cuerpo &&
      e.message.includes(cuerpo) && e.paso === 'session/status',
  );
  assert.equal(auth.limpiezas, 0);
});

test('401 en /ct/ con la sesion viva es falta de acceso a la empresa: no se reintenta', async () => {
  // Medido en produccion: un RUT del que el titular no es usuario da 401 en esUsuarioAdministrador
  // aunque session/status responda 200.
  const { auth } = siiFalso({ respuestas: { esUsuarioAdministrador: [{ status: 401, body: '' }] } });
  await assert.rejects(
    () => new SiiFichaEmpresa({ auth }).leerFicha(EMPRESA),
    (e) => e.code === 'FICHA_SIN_ACCESO_EMPRESA' && e.paso === 'esUsuarioAdministrador',
  );
  assert.equal(auth.limpiezas, 0);
  assert.equal(auth.autenticaciones, 1);
});

test('una redireccion (certificacion medida: 307 a sii.gob.cl) da FICHA_REDIRECCION con el destino', async () => {
  const { auth } = siiFalso({ respuestas: { status: [{ status: 307, body: '', headers: { location: 'http://sii.gob.cl' } }] } });
  await assert.rejects(
    () => new SiiFichaEmpresa({ auth, ambiente: 'certificacion' }).leerFicha(EMPRESA, { cookieJar: {} }),
    (e) => e.code === 'FICHA_REDIRECCION' && /sii\.gob\.cl/.test(e.message),
  );
});

test('obtenerEmpresa sin contenido da FICHA_VACIA', async () => {
  const { auth } = siiFalso({ respuestas: { obtenerEmpresa: [{ status: 200, body: '' }] } });
  await assert.rejects(() => new SiiFichaEmpresa({ auth }).leerFicha(EMPRESA), (e) => e.code === 'FICHA_VACIA');
});

test('401 en session/status con sesion propia: limpia la sesion y reintenta una sola vez', async () => {
  const { auth } = siiFalso({ respuestas: { status: [{ status: 401, body: '' }] } });
  const ficha = await new SiiFichaEmpresa({ auth }).leerFicha(EMPRESA);
  assert.equal(ficha.resolucion, '80');
  assert.equal(auth.limpiezas, 1);
  assert.equal(auth.autenticaciones, 2);

  const dosVeces = siiFalso({ respuestas: { status: [{ status: 401, body: '' }, { status: 401, body: '' }] } });
  await assert.rejects(() => new SiiFichaEmpresa({ auth: dosVeces.auth }).leerFicha(EMPRESA), (e) => e.code === 'FICHA_SESION_INVALIDA' && e.paso === 'session/status');
  assert.equal(dosVeces.auth.limpiezas, 1);
});

test('428 (MFA) y 403 (clave tributaria) no se reintentan', async () => {
  const mfa = siiFalso({ respuestas: { obtenerEmpresa: [{ status: 428, body: 'mfa' }] } });
  await assert.rejects(() => new SiiFichaEmpresa({ auth: mfa.auth }).leerFicha(EMPRESA), (e) => e.code === 'FICHA_REQUIERE_MFA' && e.body === 'mfa');
  assert.equal(mfa.auth.limpiezas, 0);
  assert.equal(mfa.auth.autenticaciones, 1);

  const clave = siiFalso({ respuestas: { esUsuarioAdministrador: [{ status: 403, body: '' }] } });
  await assert.rejects(() => new SiiFichaEmpresa({ auth: clave.auth }).leerFicha(EMPRESA), (e) => e.code === 'FICHA_REQUIERE_CLAVE_TRIBUTARIA');
  assert.equal(clave.auth.limpiezas, 0);
});

// ─── obtenerDatosEmpresa sobre la ficha ──────────────────────────────────────

test('obtenerDatosEmpresa lee la resolucion de la ficha del ambiente pedido', async () => {
  const prod = siiFalso();
  const r = await prod.auth.obtenerDatosEmpresa('76543210', 'K', { TOKEN: 't' }, 'produccion');
  assert.deepEqual(r, { rut: EMPRESA, razonSocial: null, fch_resol: '2014-08-22', nro_resol: 80, fecha_autorizacion: '2024-04-16' });
  assert.ok(prod.llamadas.every((l) => l.url.startsWith('https://www2.sii.cl/')));

  const cert = siiFalso({ ficha: fichaBase({ fechaResolucion: '2026-09-21', resolucion: '0' }) });
  const rc = await cert.auth.obtenerDatosEmpresa('76543210', 'K', { TOKEN: 't' });
  assert.ok(cert.llamadas.every((l) => l.url.startsWith('https://www2c.sii.cl/')), 'sin ambiente: certificacion');
  assert.equal(rc.fch_resol, '2026-09-21');
  assert.equal(rc.nro_resol, 0);
  assert.ok(!cert.llamadas.some((l) => l.url.includes('ad_empresa')));
});

test('obtenerDatosEmpresa sin resolucion en la ficha lanza EMPRESA_NO_AUTORIZADA con el texto que buscan los consumidores', async () => {
  const { auth } = siiFalso({ ficha: fichaBase({ fechaResolucion: null, resolucion: null }) });
  const esperado = (e) => e.code === 'EMPRESA_NO_AUTORIZADA' && e.message.includes('no se encontraron datos de resolución') &&
    !e.message.includes('admin@ejemplo.cl');
  await assert.rejects(() => auth.obtenerDatosEmpresa('76543210', 'K', {}, 'produccion'), esperado);

  const sinAcceso = siiFalso({ respuestas: { esUsuarioAdministrador: [{ status: 401, body: '' }] } });
  await assert.rejects(() => sinAcceso.auth.obtenerDatosEmpresa('76543210', 'K', {}, 'produccion'), esperado);

  const vacia = siiFalso({ respuestas: { obtenerEmpresa: [{ status: 200, body: 'null' }] } });
  await assert.rejects(() => vacia.auth.obtenerDatosEmpresa('76543210', 'K', {}, 'produccion'), esperado);
});

test('obtenerDatosEmpresa rechaza una fecha o numero de resolucion con formato inesperado', async () => {
  const fecha = siiFalso({ ficha: fichaBase({ fechaResolucion: '22-08-2014' }) });
  await assert.rejects(() => fecha.auth.obtenerDatosEmpresa('76543210', 'K', {}, 'produccion'), /fechaResolucion con formato inesperado.*"22-08-2014"/);
  const nro = siiFalso({ ficha: fichaBase({ resolucion: '80a' }) });
  await assert.rejects(() => nro.auth.obtenerDatosEmpresa('76543210', 'K', {}, 'produccion'), /resolucion con formato inesperado/);
});

test('obtenerEmisor no re-autentica ante un error definitivo de la ficha (MFA)', async () => {
  const { auth } = siiFalso({ respuestas: { obtenerEmpresa: [{ status: 428, body: 'mfa' }] } });
  await assert.rejects(
    () => SiiPortalAuth._obtenerEmisorConSesion(auth, { rutEmpresa: EMPRESA, ambiente: 'produccion', onAviso: () => {} }),
    (e) => e.code === 'FICHA_REQUIERE_MFA',
  );
  assert.equal(auth.limpiezas, 0);
  assert.equal(auth.autenticaciones, 1);
  assert.equal(SiiPortalAuth.esErrorDefinitivoFicha({ code: 'FICHA_SESION_INVALIDA' }), false);
});

test('obtenerDatosEmpresa con ambiente desconocido lanza', async () => {
  const { auth } = siiFalso();
  await assert.rejects(() => auth.obtenerDatosEmpresa('76543210', 'K', {}, 'produccion-x'), /ambiente invalido/);
});

test('_hostAdEmpresa sigue existiendo (los consumidores lo verifican al arrancar)', () => {
  assert.equal(typeof SiiPortalAuth._hostAdEmpresa, 'function');
});

// ─── Validacion de sesion ────────────────────────────────────────────────────

test('_validarSesion usa session/status: 200 con userId es valida, 401 no', async () => {
  const auth = Object.create(SiiPortalAuth.prototype);
  auth._certHash = 'h';
  const urls = [];
  let respuesta;
  auth._request = async (url) => { urls.push(url); return respuesta; };
  const guardar = SiiPortalAuth._guardarSesion;
  SiiPortalAuth._guardarSesion = async () => {};
  try {
    respuesta = { status: 200, body: JSON.stringify({ seconds: 100, userId: TITULAR }), headers: {} };
    assert.equal(await auth._validarSesion({ TOKEN: 't' }), true);
    respuesta = { status: 401, body: '', headers: {} };
    assert.equal(await auth._validarSesion({ TOKEN: 't' }), false);
    respuesta = { status: 200, body: JSON.stringify({ seconds: 0, userId: TITULAR }), headers: {} };
    assert.equal(await auth._validarSesion({ TOKEN: 't' }), false);
    assert.ok(urls.every((u) => u === 'https://www2.sii.cl/app/session/status'));
  } finally {
    SiiPortalAuth._guardarSesion = guardar;
  }
});

// ─── _request real contra un servidor local: cookies con punto en el nombre ──

test('_request envia y captura cookies con punto en el nombre', async () => {
  let cookieRecibida = null;
  const server = http.createServer((req, res) => {
    cookieRecibida = req.headers.cookie;
    res.setHeader('Set-Cookie', ['NETSCAPE_LIVEWIRE.exp=99; Path=/', 'TS0104a19a=abc; Path=/']);
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const auth = Object.create(SiiPortalAuth.prototype);
    const jar = { 'NETSCAPE_LIVEWIRE.rut': '11111111', 'NETSCAPE_LIVEWIRE.dv': '1', TOKEN: 't' };
    const res = await auth._request(`http://127.0.0.1:${server.address().port}/app/session/status`, { cookieJar: jar });
    assert.equal(res.status, 200);
    assert.match(cookieRecibida, /NETSCAPE_LIVEWIRE\.rut=11111111/);
    assert.match(cookieRecibida, /NETSCAPE_LIVEWIRE\.dv=1/);
    assert.match(cookieRecibida, /TOKEN=t/);
    assert.equal(jar['NETSCAPE_LIVEWIRE.exp'], '99');
    assert.equal(jar.TS0104a19a, 'abc');
  } finally {
    server.close();
  }
});
