const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { migrar } = require('./db');
const fila = require('./fila');
const auth = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const ok = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro no servidor. Tente de novo.' });
  }
};

// Avisa todas as telas que algo mudou na fila.
async function difundir(chamada) {
  const estado = await fila.estadoPainel();
  io.to('loja').emit('estado', estado);
  if (chamada) io.to('loja').emit('chamada', { codigo: chamada.codigo, tipo: chamada.tipo, numero: chamada.numero });
}

app.get('/api/saude', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  const { perfil, nome, senha } = req.body || {};
  const token = auth.login(perfil, nome, senha);
  if (!token) return res.status(401).json({ erro: 'Nome ou senha incorretos.' });
  res.json({ token });
});

// ----- Totem -----
app.post('/api/senhas', auth.exigirChave, ok(async (req, res) => {
  const senha = await fila.emitir(req.body && req.body.tipo);
  res.json(senha);
  difundir();
}));

// ----- Painel -----
app.get('/api/painel', auth.exigirChave, ok(async (req, res) => {
  res.json(await fila.estadoPainel());
}));

// ----- Operador -----
const op = auth.exigir('operador');
app.get('/api/operador/estado', op, ok(async (req, res) => {
  res.json(await fila.estadoOperador(req.usuario.nome));
}));
app.post('/api/operador/proxima', op, ok(async (req, res) => {
  const s = await fila.chamarProxima(req.usuario.nome);
  res.json(await fila.estadoOperador(req.usuario.nome));
  difundir(s);
}));
app.post('/api/operador/repetir', op, ok(async (req, res) => {
  const s = await fila.repetir(req.body.id, req.usuario.nome);
  res.json(await fila.estadoOperador(req.usuario.nome));
  if (s) io.to('loja').emit('chamada', { codigo: s.codigo, tipo: s.tipo, numero: s.numero });
}));
app.post('/api/operador/finalizar', op, ok(async (req, res) => {
  await fila.finalizar(req.body.id, req.usuario.nome);
  res.json(await fila.estadoOperador(req.usuario.nome));
  difundir();
}));
app.post('/api/operador/ausente', op, ok(async (req, res) => {
  await fila.ausente(req.body.id, req.usuario.nome);
  res.json(await fila.estadoOperador(req.usuario.nome));
  difundir();
}));

// ----- Relatórios (dono) -----
const dono = auth.exigir('dono');
const DATA = /^\d{4}-\d{2}-\d{2}$/;
function periodo(req) {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const de = DATA.test(req.query.de) ? req.query.de : hoje;
  const ate = DATA.test(req.query.ate) ? req.query.ate : hoje;
  return [de, ate];
}
app.get('/api/relatorios', dono, ok(async (req, res) => {
  res.json(await fila.relatorio(...periodo(req)));
}));
app.get('/api/relatorios/planilha', dono, ok(async (req, res) => {
  const [de, ate] = periodo(req);
  const linhas = await fila.listaSenhas(de, ate);
  const cab = ['Dia', 'Senha', 'Tipo', 'Situação', 'Operador', 'Emitida', 'Chamada', 'Finalizada', 'Espera (min)', 'Atendimento (min)'];
  const min = (s) => (s == null ? '' : (s / 60).toFixed(1).replace('.', ','));
  const tipo = { N: 'Normal', P: 'Preferencial' };
  const csv = [cab, ...linhas.map((l) => [
    l.dia, l.codigo, tipo[l.tipo], l.status, l.operador || '', l.emitida || '', l.chamada || '',
    l.finalizada || '', min(l.espera_seg), min(l.atendimento_seg),
  ])].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="senhas-${de}-a-${ate}.csv"`);
  res.send('﻿' + csv); // BOM para o Excel abrir os acentos corretamente
}));

// ----- Tempo real -----
io.on('connection', async (socket) => {
  const { chave, token } = socket.handshake.auth || {};
  const usuario = auth.lerToken(token);
  if (!auth.chaveValida(chave) && !usuario) return socket.disconnect(true);
  socket.join('loja');
  socket.emit('estado', await fila.estadoPainel());
});

const PORT = process.env.PORT || 3000;

async function iniciar() {
  await migrar();
  await fila.fecharDiasAnteriores();
  setInterval(() => fila.fecharDiasAnteriores().then(() => difundir()).catch(console.error), 10 * 60e3);
  server.listen(PORT, () => console.log(`Sistema de senhas rodando na porta ${PORT}`));
}

if (require.main === module) {
  iniciar().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { app, server, iniciar };
