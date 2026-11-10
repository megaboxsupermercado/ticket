const { Pool, types } = require('pg');

// Datas (DATE) voltam como texto AAAA-MM-DD, sem conversão de fuso.
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/senhas',
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

// Fuso da loja: o "dia" da senha e os relatórios usam o horário de Brasília.
const TZ = process.env.TZ_LOJA || 'America/Sao_Paulo';

async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS senhas (
      id            SERIAL PRIMARY KEY,
      dia           DATE        NOT NULL,
      tipo          CHAR(1)     NOT NULL CHECK (tipo IN ('N','P')),
      numero        INTEGER     NOT NULL,
      codigo        TEXT        NOT NULL,
      status        TEXT        NOT NULL DEFAULT 'aguardando'
                    CHECK (status IN ('aguardando','chamada','finalizada','ausente','desistencia')),
      emitida_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
      chamada_em    TIMESTAMPTZ,
      finalizada_em TIMESTAMPTZ,
      operador      TEXT,
      chamadas      INTEGER     NOT NULL DEFAULT 0,
      UNIQUE (dia, tipo, numero)
    );
    CREATE INDEX IF NOT EXISTS senhas_dia_status ON senhas (dia, status);
    CREATE INDEX IF NOT EXISTS senhas_emitida ON senhas (emitida_em);

    CREATE TABLE IF NOT EXISTS estado_dia (
      dia               DATE PRIMARY KEY,
      normais_seguidas  INTEGER NOT NULL DEFAULT 0
    );
  `);
}

module.exports = { pool, migrar, TZ };
