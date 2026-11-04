'use strict';

/**
 * Caso WB-3532: un CAF vencido (folios libres) seguía contando en FOLIOS_DISP y aprieta el tope,
 * pero `_anularSinUsar` lo excluía como "CAF en disco" y el corte de 180 días lo descartaba.
 * Solo en certificación se anulan sus folios libres, acotado a su rango; producción no cambia.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CertRunner = require('../cert/CertRunner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caf-venc-'));
const escribir = (nombre, fa) => {
  const p = path.join(dir, nombre);
  fs.writeFileSync(p, `<AUTORIZACION><CAF><DA><TD>33</TD><FA>${fa}</FA></DA></CAF></AUTORIZACION>`);
  return p;
};
const vencido = escribir('caf-1-90', '2022-01-10');
const vigente = escribir('caf-91-99', new Date().toISOString().slice(0, 10));

function armar(ambiente) {
  const r = Object.create(CertRunner.prototype);
  const anular = [];
  r.ambiente = ambiente;
  r._rangoDelCaf = (p) => {
    const m = /caf-(\d+)-(\d+)/.exec(p);
    return m ? { tipo: 33, desde: +m[1], hasta: +m[2] } : null;
  };
  Object.defineProperty(r, 'folioService', {
    value: {
      listarCafs: () => [vencido, vigente],
      anularFolios: async (a) => { anular.push(a); return { totalAnulados: 5 }; },
    },
    configurable: true,
  });
  return { r, anular };
}

test('certificación: anula el rango del CAF vencido, sin corte de antigüedad y respetando el vigente', async () => {
  const { r, anular } = armar('certificacion');
  const n = await r._anularSinUsar(33, 4, { errorCode: 'TIMBRAJE_BLOQUEADO', foliosDisp: null }, []);
  assert.equal(n, 5);
  assert.equal(anular.length, 1);
  assert.equal(anular[0].folioDesde, 1);
  assert.equal(anular[0].folioHasta, 90);
  assert.equal(anular[0].soloUltimosDias, null);
  assert.deepEqual(anular[0].excluir, [[91, 99]]);
});

test('un CAF vencido que está en mano no se anula', async () => {
  const { r, anular } = armar('certificacion');
  await r._anularSinUsar(33, 4, { errorCode: 'TIMBRAJE_BLOQUEADO', foliosDisp: null }, [vencido]);
  assert.ok(anular.every((a) => a.folioDesde == null), 'solo la pasada normal, nunca el rango del vencido');
  assert.ok(anular.every((a) => a.excluir.some(([d, h]) => d === 1 && h === 90)));
});

test('producción: todo CAF en disco sigue excluido y el corte es de 1 día', async () => {
  const { r, anular } = armar('produccion');
  await r._anularSinUsar(33, 4, { errorCode: 'TIMBRAJE_BLOQUEADO', foliosDisp: null }, []);
  assert.equal(anular.length, 1);
  assert.equal(anular[0].soloUltimosDias, 1);
  assert.deepEqual(anular[0].excluir, [[1, 90], [91, 99]]);
});

test('antes de las tandas se liberan solo los folios libres del CAF vencido (certificación)', async () => {
  const { r, anular } = armar('certificacion');
  r._consultarTopeCaf = async () => ({ maxAutor: 5, foliosDisp: 0, sinTope: false });
  const orden = [];
  Object.defineProperty(r, 'folioService', {
    value: {
      listarCafs: () => [vencido, vigente],
      anularFolios: async (a) => { orden.push('anular'); anular.push(a); return { totalAnulados: 3 }; },
      solicitarCafPorTandas: async (a) => { orden.push(`tandas:${a.topeInicial.maxAutor}`); return { ok: true, cafPaths: [], otorgados: 0 }; },
    },
    configurable: true,
  });
  await r._pedirFolios(33, 9, { maxAutor: 1, foliosDisp: 90, sinTope: false });
  assert.deepEqual(orden, ['anular', 'tandas:5']);
});
