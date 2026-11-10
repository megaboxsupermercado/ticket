const crypto = require('crypto');

const SEGREDO = process.env.SEGREDO_SESSAO || crypto.randomBytes(32).toString('hex');
const CHAVE_LOJA = process.env.CHAVE_LOJA || 'teste';
const SENHA_OPERADOR = process.env.SENHA_OPERADOR || 'operador';
const SENHA_DONO = process.env.SENHA_DONO || 'dono';

const b64 = (s) => Buffer.from(s).toString('base64url');
const assinar = (s) => crypto.createHmac('sha256', SEGREDO).update(s).digest('base64url');

function iguais(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function criarToken(dados, horas = 16) {
  const corpo = b64(JSON.stringify({ ...dados, exp: Date.now() + horas * 3600e3 }));
  return `${corpo}.${assinar(corpo)}`;
}

function lerToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [corpo, ass] = token.split('.');
  if (!corpo || !ass || !iguais(ass, assinar(corpo))) return null;
  try {
    const d = JSON.parse(Buffer.from(corpo, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch {
    return null;
  }
}

function login(perfil, nome, senha) {
  if (perfil === 'operador' && iguais(senha, SENHA_OPERADOR) && nome && nome.trim()) {
    return criarToken({ perfil, nome: nome.trim().slice(0, 40) });
  }
  if (perfil === 'dono' && iguais(senha, SENHA_DONO)) {
    return criarToken({ perfil, nome: 'Dono' }, 24 * 7);
  }
  return null;
}

function tokenDaRequisicao(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.query.token;
}

const exigir = (perfil) => (req, res, next) => {
  const d = lerToken(tokenDaRequisicao(req));
  if (!d || d.perfil !== perfil) return res.status(401).json({ erro: 'Faça login novamente.' });
  req.usuario = d;
  next();
};

function chaveValida(chave) {
  return iguais(chave || '', CHAVE_LOJA);
}

const exigirChave = (req, res, next) => {
  if (!chaveValida(req.headers['x-chave'] || req.query.chave)) {
    return res.status(401).json({ erro: 'Chave da loja inválida.' });
  }
  next();
};

module.exports = { login, lerToken, exigir, exigirChave, chaveValida };
