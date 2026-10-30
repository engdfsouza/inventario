/*
 * logic.js — regras de negócio do inventário de paletes (v0.1).
 *
 * - Normalização do que o Gemini leu (quantidade, data, código).
 * - Decisão de status: OK ou CONFERIR.
 * - Máquina de estados da regra "saiu e voltou" (quando ler, quando é palete novo).
 * - Resumo por código.
 *
 * O MESMO arquivo roda no app (navegador), no Google Apps Script (copiado como
 * Logica.gs) e nos testes (Node). Por isso é ES5 puro, sem dependências.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logica = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function vazio(v) { return v === null || v === undefined || String(v).trim() === ''; }
  function texto(v) { return vazio(v) ? '' : String(v).trim(); }

  // ---------------------------------------------------------------- quantidade
  /**
   * "10.000" → 10000 · "1.400" → 1400 · "1050" → 1050 · "J0.000" → 10000
   * Ambíguo ("10.5", "1?50", vazio) → {valor:null, ok:false}.
   */
  function normalizarQuantidade(bruto) {
    var t = texto(bruto);
    if (!t) return { valor: null, ok: false, texto: '' };
    var s = t.replace(/\s+/g, '')
      .replace(/^[Jj|Il]/, '1')        // "1" manuscrito lido como J / I / l / |
      .replace(/[Oo]/g, '0')
      .replace(/(\d)[Il|](?=\d)/g, function (_, d) { return d + '1'; });
    var valor = null;
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) valor = parseInt(s.replace(/[.,]/g, ''), 10);
    else if (/^\d+$/.test(s)) valor = parseInt(s, 10);
    var ok = valor !== null && valor > 0;
    return { valor: ok ? valor : null, ok: ok, texto: t };
  }

  // -------------------------------------------------------------------- data
  function dataValida(d, m, a) {
    if (m < 1 || m > 12 || d < 1 || a < 2000 || a > 2099) return false;
    var dias = [31, (a % 4 === 0 && (a % 100 !== 0 || a % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dias[m - 1];
  }
  function fmt(d, m, a) {
    return (d < 10 ? '0' : '') + d + '/' + (m < 10 ? '0' : '') + m + '/' + a;
  }
  function ano(s) { var a = parseInt(s, 10); return s.length === 2 ? 2000 + a : a; }

  /**
   * "24/09/28" → "24/09/2028" · "06/10/2027" → "06/10/2027"
   * "24109128" (barras manuscritas lidas como "1") → "24/09/2028"
   * Inválida → {texto: original, ok:false} (lote/validade são opcionais).
   */
  function normalizarData(bruto) {
    var t = texto(bruto);
    if (!t) return { texto: '', ok: false };
    var s = t.replace(/[\s]/g, '').replace(/[-.\\]/g, '/');
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
    if (m) {
      var d = +m[1], me = +m[2], a = ano(m[3]);
      if (dataValida(d, me, a)) return { texto: fmt(d, me, a), ok: true };
      return { texto: t, ok: false };
    }
    if (/^\d{8}$/.test(s)) {
      var d1 = +s.slice(0, 2), m1 = +s.slice(2, 4), a1 = +s.slice(4, 8);
      if (dataValida(d1, m1, a1)) return { texto: fmt(d1, m1, a1), ok: true };
      // DD1MM1AA: as barras "/" escritas à mão viraram "1"
      if (s[2] === '1' && s[5] === '1') {
        var d2 = +s.slice(0, 2), m2 = +s.slice(3, 5), a2 = 2000 + +s.slice(6, 8);
        if (dataValida(d2, m2, a2)) return { texto: fmt(d2, m2, a2), ok: true };
      }
    }
    if (/^\d{6}$/.test(s)) {
      var d3 = +s.slice(0, 2), m3 = +s.slice(2, 4), a3 = 2000 + +s.slice(4, 6);
      if (dataValida(d3, m3, a3)) return { texto: fmt(d3, m3, a3), ok: true };
    }
    return { texto: t, ok: false };
  }

  // ------------------------------------------------------------------ código
  /** Mantém pontos e hífens ("110.03.0032"); "?" marca dígito ilegível. */
  function normalizarCodigo(bruto) {
    var t = texto(bruto).toUpperCase().replace(/\s+/g, '');
    var ok = /^[A-Z0-9][A-Z0-9.\-\/]*$/.test(t) && /\d/.test(t);
    return { valor: t, ok: ok };
  }

  // ------------------------------------------------------ leitura → registro
  /**
   * Converte a resposta do Gemini num registro.
   * @returns {{acao:'registrar'|'tentar', registro?:object, motivo?:string}}
   *   'tentar' = não achou etiqueta, ou ela está cortada sem código/quantidade.
   */
  function interpretarLeitura(l) {
    l = l || {};
    if (l.etiqueta_encontrada === false) return { acao: 'tentar', motivo: 'Nenhuma etiqueta legível na imagem' };
    var cod = normalizarCodigo(l.codigo);
    var qtd = normalizarQuantidade(l.quantidade);
    var temCod = !vazio(l.codigo), temQtd = !vazio(l.quantidade);
    if (!temCod && !temQtd) return { acao: 'tentar', motivo: 'Código e quantidade não encontrados' };
    if (l.etiqueta_completa === false && (!temCod || !temQtd)) {
      return { acao: 'tentar', motivo: 'Etiqueta cortada — aponte para ela inteira' };
    }
    var motivos = [];
    if (!temCod) motivos.push('código não encontrado');
    else if (!cod.ok || l.codigo_legivel === false) motivos.push('código incerto');
    if (!temQtd) motivos.push('quantidade não encontrada');
    else if (!qtd.ok || l.quantidade_legivel === false) motivos.push('quantidade incerta');

    var val = normalizarData(l.validade);
    var registro = {
      codigo: cod.valor,
      item: texto(l.item),
      lote: texto(l.lote).toUpperCase(),
      validade: val.texto,
      fornecedor: texto(l.fornecedor).toUpperCase(),
      quantidade: qtd.valor,
      quantidadeTexto: qtd.texto,
      status: motivos.length ? 'CONFERIR' : 'OK',
      observacao: motivos.join('; ')
    };
    return { acao: 'registrar', registro: registro };
  }

  /** Revalida um registro editado à mão pelo operador. */
  function revalidar(reg) {
    var cod = normalizarCodigo(reg.codigo);
    var qtd = normalizarQuantidade(reg.quantidadeTexto != null && reg.quantidadeTexto !== '' ? reg.quantidadeTexto : reg.quantidade);
    var val = normalizarData(reg.validade);
    var motivos = [];
    if (!cod.ok) motivos.push('código incerto');
    if (!qtd.ok) motivos.push('quantidade incerta');
    var r = {};
    for (var k in reg) r[k] = reg[k];
    r.codigo = cod.valor;
    r.quantidade = qtd.valor;
    r.quantidadeTexto = qtd.texto;
    r.validade = val.texto;
    r.lote = texto(reg.lote).toUpperCase();
    r.status = motivos.length ? 'CONFERIR' : 'OK';
    r.observacao = motivos.join('; ');
    return r;
  }

  /**
   * Aviso suave de repetição: mesmo código+lote+quantidade do registro anterior,
   * registrado há menos de `janelaMs`. Não bloqueia — só sinaliza na lista.
   */
  function possivelRepetido(anterior, novo, janelaMs) {
    if (!anterior || !novo) return false;
    var dt = Date.parse(novo.dataHora) - Date.parse(anterior.dataHora);
    return anterior.codigo === novo.codigo && anterior.lote === novo.lote &&
      anterior.quantidade === novo.quantidade && dt >= 0 && dt < (janelaMs || 10000);
  }

  // ------------------------------------------------- máquina "saiu e voltou"
  var LIVRE = 'LIVRE', AGUARDANDO = 'AGUARDANDO', BLOQUEADO = 'BLOQUEADO';

  /**
   * Decide quando capturar uma imagem para leitura e quando uma etiqueta é
   * um palete novo. Cada "aparição" de etiqueta gera no máximo 1 registro.
   *
   * Uma aparição termina quando:
   *  - nenhuma etiqueta é vista por `tempoAusenciaMs` (palete saiu da câmera), ou
   *  - a etiqueta "salta" de posição de um quadro para o outro (outra etiqueta
   *    entrou enquanto a anterior saía — paletes colados).
   */
  function Maquina(cfg) {
    cfg = cfg || {};
    this.tempoAusenciaMs = cfg.tempoAusenciaMs != null ? cfg.tempoAusenciaMs : 1200;
    this.tempoParadoMs = cfg.tempoParadoMs != null ? cfg.tempoParadoMs : 300;
    this.limiarMovimento = cfg.limiarMovimento != null ? cfg.limiarMovimento : 8;
    this.intervaloTentativaMs = cfg.intervaloTentativaMs != null ? cfg.intervaloTentativaMs : 1200;
    this.maxTentativas = cfg.maxTentativas != null ? cfg.maxTentativas : 3;
    this.saltoMax = cfg.saltoMax != null ? cfg.saltoMax : 0.35;
    this.estado = LIVRE;
    this.aparicao = 0;
    this.aparicaoAtiva = false;
    this.tentativas = 0;
    this.ausenteDesde = null;
    this.paradoDesde = null;
    this.ultimaCaptura = -Infinity;
    this.ultimoCentro = null;
  }

  Maquina.prototype._encerrarAparicao = function () {
    this.aparicaoAtiva = false;
    this.estado = LIVRE;
    this.tentativas = 0;
    this.ultimaCaptura = -Infinity;
    this.ultimoCentro = null;
  };

  /**
   * @param f {t, presente, centralizada, movimento, caixa:{x,y,w,h}}
   * @returns {null | {acao:'capturar', aparicao:number}}
   */
  Maquina.prototype.quadro = function (f) {
    var t = f.t;
    if (!f.presente) {
      if (this.ausenteDesde === null) this.ausenteDesde = t;
      this.paradoDesde = null;
      if (this.aparicaoAtiva && t - this.ausenteDesde >= this.tempoAusenciaMs) this._encerrarAparicao();
      return null;
    }
    this.ausenteDesde = null;

    var centro = f.caixa ? { x: f.caixa.x + f.caixa.w / 2, y: f.caixa.y + f.caixa.h / 2 } : null;
    if (this.aparicaoAtiva && centro && this.ultimoCentro &&
        Math.abs(centro.x - this.ultimoCentro.x) > this.saltoMax) {
      this._encerrarAparicao(); // outra etiqueta tomou o lugar da anterior
    }
    if (!this.aparicaoAtiva) { this.aparicaoAtiva = true; this.aparicao++; this.paradoDesde = null; }
    this.ultimoCentro = centro;

    if (f.movimento <= this.limiarMovimento) { if (this.paradoDesde === null) this.paradoDesde = t; }
    else this.paradoDesde = null;

    if (this.estado === LIVRE && f.centralizada && this.paradoDesde !== null &&
        t - this.paradoDesde >= this.tempoParadoMs &&
        t - this.ultimaCaptura >= this.intervaloTentativaMs) {
      this.estado = AGUARDANDO;
      this.tentativas++;
      this.ultimaCaptura = t;
      return { acao: 'capturar', aparicao: this.aparicao };
    }
    return null;
  };

  /** Botão "Ler agora": captura já, para a aparição atual. */
  Maquina.prototype.forcar = function (t) {
    if (!this.aparicaoAtiva) { this.aparicaoAtiva = true; this.aparicao++; }
    this.estado = AGUARDANDO;
    this.ultimaCaptura = t;
    return { acao: 'capturar', aparicao: this.aparicao, manual: true };
  };

  /**
   * Informa o resultado de uma leitura.
   * @param tipo 'registrado' | 'tentar'
   * @returns 'bloqueado' | 'livre' | 'desistiu' | 'outra-aparicao'
   */
  Maquina.prototype.resultado = function (aparicao, tipo) {
    if (aparicao !== this.aparicao || !this.aparicaoAtiva) return 'outra-aparicao';
    if (tipo === 'registrado') { this.estado = BLOQUEADO; return 'bloqueado'; }
    if (this.tentativas >= this.maxTentativas) { this.estado = BLOQUEADO; return 'desistiu'; }
    this.estado = LIVRE;
    return 'livre';
  };

  // ------------------------------------------------------------------ resumo
  /** Agrupa por sessão + código. */
  function resumir(registros) {
    var mapa = {}, ordem = [];
    for (var i = 0; i < registros.length; i++) {
      var r = registros[i];
      if (r.excluido) continue;
      var chave = (r.sessao || '') + '\u0000' + (r.codigo || '');
      var g = mapa[chave];
      if (!g) {
        g = mapa[chave] = { sessao: r.sessao || '', codigo: r.codigo || '', itens: {}, paletes: 0, quantidade: 0, conferir: 0 };
        ordem.push(chave);
      }
      g.paletes++;
      if (typeof r.quantidade === 'number') g.quantidade += r.quantidade;
      if (r.status === 'CONFERIR') g.conferir++;
      if (r.item) g.itens[r.item] = (g.itens[r.item] || 0) + 1;
    }
    return ordem.map(function (k) {
      var g = mapa[k], item = '', n = 0;
      for (var it in g.itens) if (g.itens[it] > n) { n = g.itens[it]; item = it; }
      return { sessao: g.sessao, codigo: g.codigo, item: item, paletes: g.paletes, quantidade: g.quantidade, conferir: g.conferir };
    }).sort(function (a, b) {
      return a.sessao < b.sessao ? -1 : a.sessao > b.sessao ? 1 : (a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0);
    });
  }

  // Colunas das abas (mesma ordem no Excel do app e no Google Sheets).
  var COLUNAS_LEITURAS = [
    ['id', 'ID'], ['dataHora', 'Data/Hora'], ['sessao', 'Sessão'], ['operador', 'Operador'],
    ['codigo', 'Código'], ['item', 'Item'], ['lote', 'Lote'], ['validade', 'Validade'],
    ['fornecedor', 'Fornecedor'], ['quantidade', 'Quantidade'], ['status', 'Status'],
    ['observacao', 'Observação'], ['modo', 'Modo']
  ];
  var COLUNAS_RESUMO = [
    ['sessao', 'Sessão'], ['codigo', 'Código'], ['item', 'Item'], ['paletes', 'Nº de paletes'],
    ['quantidade', 'Quantidade total'], ['conferir', 'Paletes a conferir']
  ];

  return {
    normalizarQuantidade: normalizarQuantidade,
    normalizarData: normalizarData,
    normalizarCodigo: normalizarCodigo,
    interpretarLeitura: interpretarLeitura,
    revalidar: revalidar,
    possivelRepetido: possivelRepetido,
    Maquina: Maquina,
    resumir: resumir,
    COLUNAS_LEITURAS: COLUNAS_LEITURAS,
    COLUNAS_RESUMO: COLUNAS_RESUMO
  };
});
