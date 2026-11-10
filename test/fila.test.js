const test = require('node:test');
const assert = require('node:assert');
const { pool, migrar } = require('../server/db');
const fila = require('../server/fila');
const auth = require('../server/auth');

test.before(async () => {
  await migrar();
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
});
test.after(() => pool.end());

test('numera N e P separadamente, com três dígitos', async () => {
  const a = await fila.emitir('N');
  const b = await fila.emitir('P');
  const c = await fila.emitir('N');
  assert.deepStrictEqual([a.codigo, b.codigo, c.codigo], ['N001', 'P001', 'N002']);
});

test('não repete número com muitos toques ao mesmo tempo', async () => {
  await Promise.all(Array.from({ length: 30 }, () => fila.emitir('P')));
  const { rows } = await pool.query("SELECT COUNT(*)::int n, COUNT(DISTINCT numero)::int d FROM senhas WHERE tipo='P'");
  assert.strictEqual(rows[0].n, rows[0].d);
});

test('alterna 2 normais para 1 preferencial e esvazia a outra fila', async () => {
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
  for (const t of ['N', 'N', 'N', 'N', 'P', 'P']) await fila.emitir(t);
  const ordem = [];
  for (let i = 0; i < 7; i++) {
    const s = await fila.chamarProxima('Ana');
    ordem.push(s && s.codigo);
  }
  assert.deepStrictEqual(ordem, ['N001', 'N002', 'P001', 'N003', 'N004', 'P002', null]);
});

test('dois operadores nunca chamam a mesma senha', async () => {
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
  for (let i = 0; i < 10; i++) await fila.emitir('N');
  const r = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((o) => fila.chamarProxima(o)));
  const cods = r.map((s) => s.codigo);
  assert.strictEqual(new Set(cods).size, 5);
});

test('finalizar, ausente e repetir só valem para a senha do próprio operador', async () => {
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
  await fila.emitir('N'); await fila.emitir('N');
  const s = await fila.chamarProxima('Ana');
  assert.strictEqual(await fila.finalizar(s.id, 'Bia'), null);
  assert.strictEqual((await fila.repetir(s.id, 'Ana')).chamadas, 2);
  assert.strictEqual((await fila.finalizar(s.id, 'Ana')).status, 'finalizada');
  const s2 = await fila.chamarProxima('Ana');
  assert.strictEqual((await fila.ausente(s2.id, 'Ana')).status, 'ausente');
});

test('chamar a próxima finaliza a senha anterior do operador', async () => {
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
  await fila.emitir('N'); await fila.emitir('N');
  const a = await fila.chamarProxima('Ana');
  await fila.chamarProxima('Ana');
  const { rows } = await pool.query('SELECT status, finalizada_em FROM senhas WHERE id = $1', [a.id]);
  assert.strictEqual(rows[0].status, 'finalizada');
  assert.ok(rows[0].finalizada_em);
});

test('senhas esperando de dias anteriores viram desistência', async () => {
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
  await pool.query("INSERT INTO senhas (dia, tipo, numero, codigo) VALUES (CURRENT_DATE - 2, 'N', 1, 'N001')");
  await fila.fecharDiasAnteriores();
  const { rows } = await pool.query('SELECT status FROM senhas');
  assert.strictEqual(rows[0].status, 'desistencia');
});

test('relatório calcula espera e atendimento', async () => {
  await pool.query('TRUNCATE senhas, estado_dia RESTART IDENTITY');
  await pool.query(`INSERT INTO senhas (dia, tipo, numero, codigo, status, emitida_em, chamada_em, finalizada_em)
    VALUES ('2026-01-05','N',1,'N001','finalizada','2026-01-05 10:00:00-03','2026-01-05 10:10:00-03','2026-01-05 10:14:00-03'),
           ('2026-01-05','P',1,'P001','ausente','2026-01-05 10:05:00-03','2026-01-05 10:07:00-03',NULL)`);
  const r = await fila.relatorio('2026-01-05', '2026-01-05');
  assert.strictEqual(r.resumo.atendidas, 1);
  assert.strictEqual(r.resumo.ausentes, 1);
  assert.strictEqual(r.resumo.espera_max, 600);
  assert.strictEqual(r.resumo.espera_media, 360);
  assert.strictEqual(r.resumo.atendimento_medio, 240);
  assert.deepStrictEqual(r.porHora.map((h) => h.hora), [10]);
});

test('login de operador e dono', () => {
  assert.ok(auth.login('operador', 'Ana', process.env.SENHA_OPERADOR || 'operador'));
  assert.strictEqual(auth.login('operador', 'Ana', 'errada'), null);
  const t = auth.login('dono', '', process.env.SENHA_DONO || 'dono');
  assert.strictEqual(auth.lerToken(t).perfil, 'dono');
  assert.strictEqual(auth.lerToken(t + 'x'), null);
});
