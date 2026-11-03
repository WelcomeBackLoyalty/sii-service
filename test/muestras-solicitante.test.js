'use strict';

/**
 * El impreso (HTML y PDF) muestra al solicitante del documento: nombre (Receptor/Contacto) y RUT (Encabezado/RUTSolicita).
 * Sin esos datos el recuadro del receptor no cambia (3 filas, igual que antes).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const MuestrasImpresas = require('../cert/MuestrasImpresas');

const xml = (solicitante) => `<?xml version="1.0"?>
<EnvioDTE><SetDTE><DTE><Documento>
  <Encabezado>
    <IdDoc><TipoDTE>33</TipoDTE><Folio>1</Folio><FchEmis>2026-11-03</FchEmis></IdDoc>
    <Emisor><RUTEmisor>76543210-K</RUTEmisor><RznSoc>EMPRESA EJEMPLO SPA</RznSoc></Emisor>
    <Receptor><RUTRecep>77111222-3</RUTRecep><RznSocRecep>CLIENTE EJEMPLO SPA</RznSocRecep>${solicitante ? '<Contacto>Ana Perez</Contacto>' : ''}</Receptor>
    ${solicitante ? '<RUTSolicita>11111111-1</RUTSolicita>' : ''}
    <Totales><MntNeto>1681</MntNeto><TasaIVA>19</TasaIVA><IVA>319</IVA><MntTotal>2000</MntTotal></Totales>
  </Encabezado>
  <Detalle><NroLinDet>1</NroLinDet><NmbItem>Producto</NmbItem><QtyItem>2</QtyItem><PrcItem>1000</PrcItem><MontoItem>2000</MontoItem></Detalle>
</Documento></DTE></SetDTE></EnvioDTE>`;

const m = new MuestrasImpresas({ emisor: { rut: '76543210-K', razonSocial: 'EMPRESA EJEMPLO SPA' } });

test('parseEnvioDTE trae rutSolicita y el contacto del receptor', () => {
  const [d] = m.parseEnvioDTE(xml(true));
  assert.equal(d.rutSolicita, '11111111-1');
  assert.equal(d.receptor.Contacto, 'Ana Perez');
  assert.equal(m.parseEnvioDTE(xml(false))[0].rutSolicita, '');
});

test('el HTML muestra Solicitante y RUT solicitante solo si existen', () => {
  const con = m._buildHtml({ doc: m.parseEnvioDTE(xml(true))[0], esCedible: false, tedDataUri: '' });
  const sin = m._buildHtml({ doc: m.parseEnvioDTE(xml(false))[0], esCedible: false, tedDataUri: '' });
  assert.match(con, /Solicitante:<\/span> Ana Perez/);
  assert.match(con, /RUT solicitante:<\/span> 11111111-1/);
  assert.doesNotMatch(sin, /Solicitante/);
});

test('el recuadro del receptor del PDF crece una fila solo con solicitante', () => {
  const [con] = m.parseEnvioDTE(xml(true));
  const [sin] = m.parseEnvioDTE(xml(false));
  assert.ok(m._pdfCalcReceptorHeight(con) > m._pdfCalcReceptorHeight(sin));
});

test('el PDF se genera con solicitante y sin solicitante', async () => {
  for (const flag of [true, false]) {
    const [d] = m.parseEnvioDTE(xml(flag));
    const buf = await m.generarPDFBuffer(d, { cedible: false });
    assert.ok(Buffer.isBuffer(buf) && buf.length > 1000 && buf.slice(0, 4).toString() === '%PDF');
  }
});
