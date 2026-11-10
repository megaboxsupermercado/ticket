const { pool, TZ } = require('./db');

// Quantas normais são chamadas antes de uma preferencial (alternância 2:1).
const NORMAIS_POR_PREFERENCIAL = Number(process.env.NORMAIS_POR_PREFERENCIAL || 2);

const HOJE = `(now() AT TIME ZONE '${TZ}')::date`;

function codigo(tipo, numero) {
  return tipo + String(numero).padStart(3, '0');
}

async function transacao(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function emitir(tipo) {
  if (!['N', 'P'].includes(tipo)) throw new Error('tipo inválido');
  return transacao(async (c) => {
    // Trava por dia+tipo para que dois toques simultâneos não gerem o mesmo número.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext(${HOJE}::text || $1))`, [tipo]);
    const { rows } = await c.query(
      `SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM senhas WHERE dia = ${HOJE} AND tipo = $1`,
      [tipo]
    );
    const n = rows[0].n;
    const ins = await c.query(
      `INSERT INTO senhas (dia, tipo, numero, codigo) VALUES (${HOJE}, $1, $2, $3) RETURNING *`,
      [tipo, n, codigo(tipo, n)]
    );
    return ins.rows[0];
  });
}

async function chamarProxima(operador) {
  return transacao(async (c) => {
    // Chamar a próxima encerra o atendimento atual do operador, caso ele não tenha finalizado.
    await c.query(
      `UPDATE senhas SET status = 'finalizada', finalizada_em = now()
        WHERE status = 'chamada' AND operador = $1`,
      [operador]
    );

    await c.query(`INSERT INTO estado_dia (dia) VALUES (${HOJE}) ON CONFLICT DO NOTHING`);
    const est = await c.query(`SELECT normais_seguidas FROM estado_dia WHERE dia = ${HOJE} FOR UPDATE`);
    const seguidas = est.rows[0].normais_seguidas;

    const cont = await c.query(
      `SELECT tipo, COUNT(*)::int AS n FROM senhas
        WHERE dia = ${HOJE} AND status = 'aguardando' GROUP BY tipo`
    );
    const espera = { N: 0, P: 0 };
    cont.rows.forEach((r) => (espera[r.tipo] = r.n));

    let tipo = null;
    if (espera.P > 0 && (seguidas >= NORMAIS_POR_PREFERENCIAL || espera.N === 0)) tipo = 'P';
    else if (espera.N > 0) tipo = 'N';
    else if (espera.P > 0) tipo = 'P';
    if (!tipo) return null;

    const prox = await c.query(
      `SELECT id FROM senhas WHERE dia = ${HOJE} AND status = 'aguardando' AND tipo = $1
        ORDER BY numero LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [tipo]
    );
    if (!prox.rows.length) return null;

    const upd = await c.query(
      `UPDATE senhas SET status = 'chamada', chamada_em = now(), operador = $2, chamadas = 1
        WHERE id = $1 RETURNING *`,
      [prox.rows[0].id, operador]
    );
    await c.query(`UPDATE estado_dia SET normais_seguidas = $1 WHERE dia = ${HOJE}`, [
      tipo === 'N' ? seguidas + 1 : 0,
    ]);
    return upd.rows[0];
  });
}

async function repetir(id, operador) {
  const { rows } = await pool.query(
    `UPDATE senhas SET chamadas = chamadas + 1
      WHERE id = $1 AND status = 'chamada' AND operador = $2 RETURNING *`,
    [id, operador]
  );
  return rows[0] || null;
}

async function finalizar(id, operador) {
  const { rows } = await pool.query(
    `UPDATE senhas SET status = 'finalizada', finalizada_em = now()
      WHERE id = $1 AND status = 'chamada' AND operador = $2 RETURNING *`,
    [id, operador]
  );
  return rows[0] || null;
}

async function ausente(id, operador) {
  const { rows } = await pool.query(
    `UPDATE senhas SET status = 'ausente'
      WHERE id = $1 AND status = 'chamada' AND operador = $2 RETURNING *`,
    [id, operador]
  );
  return rows[0] || null;
}

// Senhas de dias anteriores que ficaram esperando viram desistência.
async function fecharDiasAnteriores() {
  await pool.query(
    `UPDATE senhas SET status = 'desistencia' WHERE dia < ${HOJE} AND status = 'aguardando'`
  );
  await pool.query(
    `UPDATE senhas SET status = 'finalizada' WHERE dia < ${HOJE} AND status = 'chamada'`
  );
}

async function contagem() {
  const { rows } = await pool.query(
    `SELECT tipo, COUNT(*)::int AS n FROM senhas
      WHERE dia = ${HOJE} AND status = 'aguardando' GROUP BY tipo`
  );
  const espera = { N: 0, P: 0 };
  rows.forEach((r) => (espera[r.tipo] = r.n));
  return espera;
}

async function estadoPainel() {
  const { rows } = await pool.query(
    `SELECT codigo, tipo, numero, chamada_em FROM senhas
      WHERE dia = ${HOJE} AND chamada_em IS NOT NULL
      ORDER BY chamada_em DESC LIMIT 5`
  );
  return { atual: rows[0] || null, anteriores: rows.slice(1), espera: await contagem() };
}

async function estadoOperador(operador) {
  const { rows } = await pool.query(
    `SELECT * FROM senhas WHERE status = 'chamada' AND operador = $1
      ORDER BY chamada_em DESC LIMIT 1`,
    [operador]
  );
  return { atual: rows[0] || null, espera: await contagem() };
}

// ---------- Relatórios ----------
const ESPERA = `EXTRACT(EPOCH FROM (chamada_em - emitida_em))`;
const ATEND = `EXTRACT(EPOCH FROM (finalizada_em - chamada_em))`;

async function relatorio(de, ate) {
  const p = [de, ate];
  const filtro = `dia BETWEEN $1 AND $2`;

  const resumo = await pool.query(
    `SELECT
       COUNT(*)::int                                           AS emitidas,
       COUNT(*) FILTER (WHERE status = 'finalizada')::int      AS atendidas,
       COUNT(*) FILTER (WHERE status = 'ausente')::int         AS ausentes,
       COUNT(*) FILTER (WHERE status = 'desistencia')::int     AS desistencias,
       ROUND(AVG(${ESPERA}))::int                              AS espera_media,
       ROUND(MAX(${ESPERA}))::int                              AS espera_max,
       ROUND(AVG(${ESPERA}) FILTER (WHERE tipo = 'N'))::int    AS espera_media_n,
       ROUND(AVG(${ESPERA}) FILTER (WHERE tipo = 'P'))::int    AS espera_media_p,
       ROUND(AVG(${ATEND}) FILTER (WHERE status = 'finalizada'))::int AS atendimento_medio
     FROM senhas WHERE ${filtro}`,
    p
  );

  const porDia = await pool.query(
    `SELECT to_char(dia, 'YYYY-MM-DD') AS dia,
            COUNT(*)::int AS emitidas,
            COUNT(*) FILTER (WHERE status = 'finalizada')::int AS atendidas,
            ROUND(AVG(${ESPERA}))::int AS espera_media,
            ROUND(AVG(${ATEND}) FILTER (WHERE status = 'finalizada'))::int AS atendimento_medio
       FROM senhas WHERE ${filtro} GROUP BY dia ORDER BY dia`,
    p
  );

  const porHora = await pool.query(
    `SELECT EXTRACT(HOUR FROM emitida_em AT TIME ZONE '${TZ}')::int AS hora,
            COUNT(*)::int AS emitidas,
            ROUND(AVG(${ESPERA}))::int AS espera_media
       FROM senhas WHERE ${filtro} GROUP BY hora ORDER BY hora`,
    p
  );

  return { resumo: resumo.rows[0], porDia: porDia.rows, porHora: porHora.rows };
}

async function listaSenhas(de, ate) {
  const { rows } = await pool.query(
    `SELECT to_char(dia, 'DD/MM/YYYY') AS dia, codigo, tipo, status, operador,
            to_char(emitida_em AT TIME ZONE '${TZ}', 'HH24:MI:SS') AS emitida,
            to_char(chamada_em AT TIME ZONE '${TZ}', 'HH24:MI:SS') AS chamada,
            to_char(finalizada_em AT TIME ZONE '${TZ}', 'HH24:MI:SS') AS finalizada,
            ROUND(${ESPERA})::int AS espera_seg,
            ROUND(${ATEND})::int AS atendimento_seg
       FROM senhas WHERE dia BETWEEN $1 AND $2 ORDER BY emitida_em`,
    [de, ate]
  );
  return rows;
}

module.exports = {
  emitir, chamarProxima, repetir, finalizar, ausente, fecharDiasAnteriores,
  estadoPainel, estadoOperador, relatorio, listaSenhas, codigo,
};
