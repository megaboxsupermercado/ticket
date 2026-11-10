// Funções compartilhadas pelas telas.
(function () {
  function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function apagar(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // A chave da loja vem no endereço (?chave=...) na primeira vez e fica guardada no aparelho.
  function chaveLoja() {
    const p = new URLSearchParams(location.search).get('chave');
    if (p) guardar('chave', p);
    return p || ler('chave') || '';
  }

  async function api(caminho, { metodo = 'GET', corpo, token, chave } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (chave) headers['X-Chave'] = chave;
    const r = await fetch(caminho, { method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(dados.erro || 'Falha de conexão');
      e.status = r.status;
      throw e;
    }
    return dados;
  }

  function minutos(seg) {
    if (seg == null) return '–';
    if (seg < 60) return seg + ' s';
    const m = Math.floor(seg / 60), s = seg % 60;
    return m + ' min' + (s ? ' ' + String(s).padStart(2, '0') + ' s' : '');
  }

  window.Senhas = { guardar, ler, apagar, chaveLoja, api, minutos };
})();
