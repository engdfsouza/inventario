/*
 * app.js — Inventário de Paletes v0.1
 * Câmera → detector (quando ler) → Apps Script/Gemini (o que está escrito)
 * → lista local + Google Sheets → Excel.
 */
(function () {
  'use strict';

  var VERSAO = '0.1';
  var CHAVE = 'inv.v1.';
  var INTERVALO_ANALISE_MS = 125;      // ~8 análises por segundo
  var LADO_MAX_ENVIO = 1600;           // px do maior lado da foto enviada ao Gemini
  var JANELA_REPETIDO_MS = 2500;      // re-registro quase imediato = provável tremida, não palete novo

  // ------------------------------------------------------------- estado
  var cfg = carregar('config', { url: '', token: '', operador: '', modo: 'auto', ausenciaMs: 1200, som: true });
  var registros = carregar('registros', []);
  var sessao = carregar('sessao', null) || novaSessaoNome();
  var maquina = novaMaquina();
  var miniaturas = {};                 // id → dataURL (só em memória)
  var filaLeitura = [];                // capturas aguardando o Gemini
  var lendo = false;
  var filaConfirmacao = [];            // leituras esperando o operador (modo confirmar)
  var editando = null;
  var rodando = false, stream = null, trilha = null, timer = null, wakeLock = null;
  var cinzaAnterior = null, ultimaAnalise = null;
  var sincronizando = false, falhasSync = 0;

  var $ = function (id) { return document.getElementById(id); };
  var video = $('video'), sobre = $('sobreposicao');
  var cAnalise = document.createElement('canvas');
  var ctxAnalise = cAnalise.getContext('2d', { willReadFrequently: true });
  var cCaptura = document.createElement('canvas');

  // ------------------------------------------------------- persistência
  function carregar(k, padrao) {
    try { var v = localStorage.getItem(CHAVE + k); return v ? JSON.parse(v) : padrao; } catch (e) { return padrao; }
  }
  function guardar(k, v) {
    try { localStorage.setItem(CHAVE + k, JSON.stringify(v)); } catch (e) { /* armazenamento cheio/bloqueado */ }
  }
  function salvarRegistros() { guardar('registros', registros); }

  function novaSessaoNome() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'Inventário ' + p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function novaMaquina() { return new Logica.Maquina({ tempoAusenciaMs: Number(cfg.ausenciaMs) || 1200 }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // Configuração pelo link gerado na planilha: index.html#url=...&token=...
  (function lerHash() {
    if (!location.hash || location.hash.indexOf('url=') < 0) return;
    var p = {};
    location.hash.slice(1).split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    if (p.url) cfg.url = p.url;
    if (p.token) cfg.token = p.token;
    guardar('config', cfg);
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(function () { aviso('Configuração recebida pelo link.', 'ok'); }, 300);
  })();

  // ------------------------------------------------------------ feedback
  var audio = null;
  function bip(tipo) {
    if (navigator.vibrate) navigator.vibrate(tipo === 'ok' ? 80 : tipo === 'conferir' ? [80, 60, 80] : 250);
    if (!cfg.som) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var notas = tipo === 'ok' ? [[1046, 0, .12]] : tipo === 'conferir' ? [[523, 0, .12], [523, .18, .12]] : [[220, 0, .3]];
      notas.forEach(function (n) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = n[0]; o.connect(g); g.connect(audio.destination);
        var t = audio.currentTime + n[1];
        g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + n[2]);
        o.start(t); o.stop(t + n[2] + .02);
      });
    } catch (e) { /* sem áudio */ }
  }

  var timerAviso = null;
  function aviso(msg, tom, ms) {
    var el = $('aviso');
    el.textContent = msg; el.dataset.tom = tom || '';
    el.classList.add('visivel');
    clearTimeout(timerAviso);
    timerAviso = setTimeout(function () { el.classList.remove('visivel'); }, ms || 2600);
  }

  var situacaoFixa = null;
  function situacao(msg, tom) {
    var el = $('situacao');
    el.hidden = false; el.dataset.tom = tom || '';
    $('situacaoTexto').textContent = msg;
  }

  // -------------------------------------------------------------- lista
  function daSessao() { return registros.filter(function (r) { return r.sessao === sessao && !r.excluido; }); }

  function fmtQtd(r) {
    return typeof r.quantidade === 'number' ? r.quantidade.toLocaleString('pt-BR') : (r.quantidadeTexto || '—');
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function renderizar() {
    var lista = daSessao();
    var conferir = lista.filter(function (r) { return r.status === 'CONFERIR'; }).length;
    var pend = registros.filter(function (r) { return r.pendente; }).length;
    $('nomeSessao').textContent = sessao;
    $('contadores').innerHTML = lista.length + (lista.length === 1 ? ' palete' : ' paletes') +
      (conferir ? ' · <span class="c">' + conferir + ' a conferir</span>' : '') +
      (pend ? ' · <span class="p">' + pend + ' sem enviar</span>' : '') +
      (filaLeitura.length + (lendo ? 1 : 0) ? ' · lendo ' + (filaLeitura.length + (lendo ? 1 : 0)) : '');

    var html = '';
    var emLeitura = filaLeitura.slice();
    if (lendo && lendo.miniatura) emLeitura.unshift(lendo);
    emLeitura.forEach(function (c) {
      html += '<div class="linha lendo"><span class="n"></span><img src="' + c.miniatura + '" alt="">' +
        '<div class="info"><div class="cod">' + (c.esperaAte > Date.now() ? 'Aguardando limite do Gemini…' : 'Lendo etiqueta…') + '</div></div></div>';
    });
    for (var i = lista.length - 1; i >= 0; i--) {
      var r = lista[i];
      var det = [r.lote && 'Lote ' + r.lote, r.validade && 'Val. ' + r.validade, r.item].filter(Boolean).join(' · ');
      html += '<button type="button" class="linha" data-id="' + r.id + '"><span class="n">' + (i + 1) + '</span>' +
        '<div class="info"><div class="cod">' + esc(r.codigo || '???') +
        (r.status === 'CONFERIR' ? '<span class="selo conferir">CONFERIR</span>' : '') +
        (r.possivelRepetido ? '<span class="selo repetido">REPETIDO?</span>' : '') +
        (r.pendente ? '<span class="selo pendente">não enviado</span>' : '') +
        '</div><div class="det">' + esc(det || r.observacao || '') + '</div></div>' +
        '<div class="qtd">' + esc(fmtQtd(r)) + '</div></button>';
    }
    $('lista').innerHTML = html || '<div class="vazio">Nenhum palete registrado nesta sessão.</div>';
  }

  $('lista').addEventListener('click', function (ev) {
    var b = ev.target.closest('.linha[data-id]');
    if (!b) return;
    var r = registros.filter(function (x) { return x.id === b.dataset.id; })[0];
    if (r) abrirRegistro({ registro: r, edicao: true });
  });

  // ----------------------------------------------------- câmera e análise
  function iniciar() {
    if (!cfg.url || !cfg.token) { abrirConfig('Configure o endereço e a senha antes de começar.'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      aviso('Este navegador não dá acesso à câmera. Abra o link pelo Chrome ou Safari (endereço https).', 'erro', 6000);
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (s) {
      stream = s; trilha = s.getVideoTracks()[0];
      video.srcObject = s;
      return video.play();
    }).then(function () {
      rodando = true;
      maquina = novaMaquina();
      cinzaAnterior = null;
      $('parado').hidden = true;
      $('btnIniciar').textContent = 'Pausar'; $('btnIniciar').classList.add('pausar');
      $('btnLer').disabled = false;
      situacao('Procurando etiqueta…');
      prepararLanterna();
      manterTelaLigada();
      timer = setInterval(analisar, INTERVALO_ANALISE_MS);
    }).catch(function (e) {
      aviso('Não consegui abrir a câmera: ' + (e && e.name === 'NotAllowedError' ? 'permissão negada.' : (e && e.message || e)), 'erro', 6000);
    });
  }

  function pausar() {
    rodando = false;
    clearInterval(timer);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; trilha = null;
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* */ } wakeLock = null; }
    $('parado').hidden = false;
    $('situacao').hidden = true;
    $('btnIniciar').textContent = 'Iniciar'; $('btnIniciar').classList.remove('pausar');
    $('btnLer').disabled = true; $('btnLanterna').style.display = 'none';
    limparSobreposicao();
  }

  function manterTelaLigada() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (w) { wakeLock = w; }).catch(function () { /* */ });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && rodando) manterTelaLigada();
  });

  var lanternaLigada = false;
  function prepararLanterna() {
    var cap = trilha && trilha.getCapabilities ? trilha.getCapabilities() : {};
    $('btnLanterna').style.display = cap.torch ? 'grid' : 'none';
  }
  $('btnLanterna').addEventListener('click', function () {
    if (!trilha) return;
    lanternaLigada = !lanternaLigada;
    trilha.applyConstraints({ advanced: [{ torch: lanternaLigada }] }).catch(function () { lanternaLigada = false; });
  });

  function analisar() {
    if (!rodando || video.readyState < 2 || !video.videoWidth) return;
    var w = Detector.DEFAULTS.largura, h = Math.round(video.videoHeight * w / video.videoWidth);
    if (cAnalise.width !== w || cAnalise.height !== h) { cAnalise.width = w; cAnalise.height = h; }
    ctxAnalise.drawImage(video, 0, 0, w, h);
    var r = Detector.analisar(ctxAnalise.getImageData(0, 0, w, h));
    var mov = cinzaAnterior ? Detector.movimento(cinzaAnterior, r.cinza) : 255;
    cinzaAnterior = r.cinza;
    ultimaAnalise = r;
    desenharCaixa(r);

    var acao = maquina.quadro({ t: Date.now(), presente: r.presente, centralizada: r.centralizada, movimento: mov, caixa: r.caixa });
    if (acao) capturar(acao);
    atualizarSituacao(r, mov);
  }

  function atualizarSituacao(r, mov) {
    if (situacaoFixa && situacaoFixa.ate > Date.now()) { situacao(situacaoFixa.msg, situacaoFixa.tom); return; }
    if (!r.presente) situacao('Procurando etiqueta…');
    else if (maquina.estado === 'BLOQUEADO') situacao('Já registrado — siga para o próximo palete', 'ok');
    else if (maquina.estado === 'AGUARDANDO') situacao('Lendo etiqueta…', 'lendo');
    else if (!r.centralizada) situacao('Centralize a etiqueta', 'aviso');
    else if (mov > maquina.limiarMovimento) situacao('Segure firme…', 'aviso');
    else situacao('Segure firme…', 'aviso');
  }
  function fixarSituacao(msg, tom, ms) { situacaoFixa = { msg: msg, tom: tom, ate: Date.now() + (ms || 1800) }; situacao(msg, tom); }

  function desenharCaixa(r) {
    var dw = sobre.clientWidth, dh = sobre.clientHeight;
    if (sobre.width !== dw || sobre.height !== dh) { sobre.width = dw; sobre.height = dh; }
    var ctx = sobre.getContext('2d');
    ctx.clearRect(0, 0, dw, dh);
    if (!r.caixa) return;
    // mapeia coordenadas do vídeo (object-fit: cover) para a tela
    var vw = video.videoWidth, vh = video.videoHeight, esc = Math.max(dw / vw, dh / vh);
    var ox = (dw - vw * esc) / 2, oy = (dh - vh * esc) / 2;
    var x = ox + r.caixa.x * vw * esc, y = oy + r.caixa.y * vh * esc, w = r.caixa.w * vw * esc, h = r.caixa.h * vh * esc;
    ctx.lineWidth = 4;
    ctx.strokeStyle = maquina.estado === 'BLOQUEADO' ? '#35c27a' : r.centralizada ? '#ffb020' : 'rgba(255,255,255,.6)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 10); else ctx.rect(x, y, w, h);
    ctx.stroke();
  }
  function limparSobreposicao() { sobre.getContext('2d').clearRect(0, 0, sobre.width, sobre.height); }

  // ------------------------------------------------------------- captura
  function capturar(acao) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var esc = Math.min(1, LADO_MAX_ENVIO / Math.max(vw, vh));
    cCaptura.width = Math.round(vw * esc); cCaptura.height = Math.round(vh * esc);
    cCaptura.getContext('2d').drawImage(video, 0, 0, cCaptura.width, cCaptura.height);
    var dataUrl = cCaptura.toDataURL('image/jpeg', 0.85);
    var t = document.createElement('canvas');
    var te = 240 / Math.max(cCaptura.width, cCaptura.height);
    t.width = Math.round(cCaptura.width * te); t.height = Math.round(cCaptura.height * te);
    t.getContext('2d').drawImage(cCaptura, 0, 0, t.width, t.height);
    filaLeitura.push({
      id: uid(), aparicao: acao.aparicao, manual: !!acao.manual, dataHora: new Date().toISOString(),
      imagem: dataUrl.slice(dataUrl.indexOf(',') + 1), foto: dataUrl, miniatura: t.toDataURL('image/jpeg', 0.7),
      tentativasRede: 0, esperaAte: 0
    });
    renderizar();
    processarFila();
  }

  $('btnLer').addEventListener('click', function () {
    if (!rodando) return;
    capturar(maquina.forcar(Date.now()));
    fixarSituacao('Lendo etiqueta…', 'lendo');
  });

  // --------------------------------------------------- servidor (Apps Script)
  function chamar(corpo) {
    corpo.token = cfg.token;
    return fetch(cfg.url, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita pré-verificação CORS
      body: JSON.stringify(corpo)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function processarFila() {
    if (lendo || !filaLeitura.length) return;
    var agora = Date.now();
    var c = filaLeitura[0];
    if (c.esperaAte > agora) { setTimeout(processarFila, c.esperaAte - agora); return; }
    lendo = filaLeitura.shift();
    renderizar();
    chamar({ acao: 'ler', imagem: c.imagem }).then(function (resp) {
      tratarLeitura(c, resp);
    }).catch(function (e) {
      c.tentativasRede++;
      if (c.tentativasRede <= 4) {
        c.esperaAte = Date.now() + 1500 * c.tentativasRede;
        filaLeitura.unshift(c);
        fixarSituacao('Sem conexão — tentando de novo…', 'erro');
      } else {
        bip('erro');
        aviso('Não consegui enviar a foto (sem conexão). Leia este palete de novo.', 'erro', 5000);
        maquina.resultado(c.aparicao, 'tentar');
      }
    }).then(function () {
      lendo = false;
      renderizar();
      processarFila();
    });
  }

  function tratarLeitura(c, resp) {
    if (!resp || !resp.ok) {
      var erro = resp && resp.erro;
      if ((erro === 'limite' || erro === 'gemini') && resp.tentarEmMs) {
        c.esperaAte = Date.now() + resp.tentarEmMs;
        filaLeitura.unshift(c);
        fixarSituacao(erro === 'limite' ? 'Limite do Gemini — continuo em ' + Math.ceil(resp.tentarEmMs / 1000) + ' s' : 'Gemini instável — tentando de novo', 'aviso', 2500);
        return;
      }
      bip('erro');
      maquina.resultado(c.aparicao, 'tentar');
      if (erro === 'senha' || erro === 'chave') { pausar(); abrirConfig(resp.mensagem); }
      else aviso(resp && resp.mensagem || 'Erro na leitura.', 'erro', 5000);
      return;
    }
    if (resp.acao !== 'registrar') {
      var res = maquina.resultado(c.aparicao, 'tentar');
      if (c.manual) { bip('erro'); aviso(resp.motivo || 'Não encontrei a etiqueta.', 'erro'); }
      else if (res === 'desistiu') {
        bip('erro');
        aviso('Não consegui ler esta etiqueta. Aproxime ou toque em "Ler agora".', 'erro', 4000);
      }
      return;
    }
    maquina.resultado(c.aparicao, 'registrado');
    var r = resp.registro;
    var reg = {
      id: c.id, dataHora: c.dataHora, sessao: sessao, operador: cfg.operador || '',
      codigo: r.codigo, item: r.item, lote: r.lote, validade: r.validade, fornecedor: r.fornecedor,
      quantidade: r.quantidade, quantidadeTexto: r.quantidadeTexto, status: r.status, observacao: r.observacao,
      modo: c.manual ? 'manual' : 'automático'
    };
    miniaturas[reg.id] = c.foto;
    if (cfg.modo === 'confirmar') {
      filaConfirmacao.push(reg);
      if (!editando) proximaConfirmacao();
      bip(r.status === 'OK' ? 'ok' : 'conferir');
      return;
    }
    adicionar(reg);
  }

  function adicionar(reg) {
    var anteriores = daSessao();
    reg.possivelRepetido = Logica.possivelRepetido(anteriores[anteriores.length - 1], reg, JANELA_REPETIDO_MS);
    reg.pendente = true;
    registros.push(reg);
    salvarRegistros();
    renderizar();
    var q = typeof reg.quantidade === 'number' ? reg.quantidade.toLocaleString('pt-BR') : (reg.quantidadeTexto || '?');
    if (reg.status === 'OK') {
      bip('ok');
      fixarSituacao('Registrado ✓  ' + reg.codigo + ' · ' + q, 'ok', 2200);
    } else {
      bip('conferir');
      fixarSituacao('Registrado — CONFERIR  ' + (reg.codigo || '???') + ' · ' + q, 'erro', 3000);
    }
    sincronizar();
  }

  // Envia à planilha tudo que está pendente (novos, editados e excluídos).
  function sincronizar() {
    if (sincronizando || !cfg.url) return;
    var pend = registros.filter(function (r) { return r.pendente; });
    if (!pend.length) return;
    sincronizando = true;
    var lote = pend.slice(0, 25).map(function (r) {
      var o = {}; for (var k in r) if (k !== 'pendente') o[k] = r[k];
      return o;
    });
    chamar({ acao: 'salvar', registros: lote }).then(function (resp) {
      if (!resp.ok) throw new Error(resp.mensagem || 'erro ao salvar');
      falhasSync = 0;
      var ok = {}; resp.salvos.forEach(function (id) { ok[id] = true; });
      registros.forEach(function (r) { if (ok[r.id]) r.pendente = false; });
      registros = registros.filter(function (r) { return !(r.excluido && !r.pendente); });
      salvarRegistros();
    }).catch(function () {
      falhasSync++;
    }).then(function () {
      sincronizando = false;
      renderizar();
      if (registros.some(function (r) { return r.pendente; })) {
        setTimeout(sincronizar, falhasSync ? Math.min(30000, 2000 * falhasSync) : 300);
      }
    });
  }
  window.addEventListener('online', sincronizar);

  // ------------------------------------------------ confirmar / editar
  function proximaConfirmacao() {
    var reg = filaConfirmacao.shift();
    if (reg) abrirRegistro({ registro: reg, edicao: false });
  }

  function abrirRegistro(o) {
    editando = o;
    var r = o.registro;
    $('regTitulo').textContent = o.edicao ? 'Editar palete' : 'Confirmar leitura';
    $('regSub').textContent = r.status === 'CONFERIR' ? 'Confira: ' + (r.observacao || 'leitura incerta') + '.' :
      (o.edicao ? 'Corrija o que for preciso.' : 'Confira os dados lidos.');
    $('regSub').style.color = r.status === 'CONFERIR' ? 'var(--conferir)' : '';
    var foto = miniaturas[r.id];
    $('regFoto').style.display = foto ? 'block' : 'none';
    if (foto) $('regFoto').src = foto;
    $('regCodigo').value = r.codigo || '';
    $('regQtd').value = typeof r.quantidade === 'number' ? r.quantidade.toLocaleString('pt-BR') : (r.quantidadeTexto || '');
    $('regLote').value = r.lote || '';
    $('regValidade').value = r.validade || '';
    $('regItem').value = r.item || '';
    $('regFornecedor').value = r.fornecedor || '';
    $('regExcluir').textContent = o.edicao ? 'Excluir' : 'Descartar';
    $('regSalvar').textContent = o.edicao ? 'Salvar' : 'Adicionar';
    $('dlgRegistro').showModal();
  }

  $('dlgRegistro').addEventListener('close', function () {
    var o = editando; editando = null;
    if (!o) return;
    var acao = $('dlgRegistro').returnValue;
    var r = o.registro;
    if (acao === 'salvar') {
      var novo = Logica.revalidar({
        codigo: $('regCodigo').value, quantidadeTexto: $('regQtd').value, lote: $('regLote').value,
        validade: $('regValidade').value, item: $('regItem').value.trim(), fornecedor: $('regFornecedor').value.trim().toUpperCase()
      });
      ['codigo', 'quantidade', 'quantidadeTexto', 'lote', 'validade', 'item', 'fornecedor', 'status', 'observacao']
        .forEach(function (k) { r[k] = novo[k]; });
      if (o.edicao) {
        r.modo = 'editado'; r.pendente = true; r.possivelRepetido = false;
        salvarRegistros(); renderizar(); sincronizar();
        aviso('Palete atualizado.', 'ok');
      } else {
        r.modo = 'confirmado';
        adicionar(r);
      }
    } else if (acao === 'excluir' && o.edicao) {
      if (confirm('Excluir este palete da contagem?')) {
        r.excluido = true; r.pendente = true;
        salvarRegistros(); renderizar(); sincronizar();
        aviso('Palete excluído.', 'ok');
      }
    } else if (!o.edicao && acao !== 'excluir') {
      // fechou sem escolher (ex.: botão voltar): mantém para não perder a leitura
      filaConfirmacao.unshift(r);
      setTimeout(proximaConfirmacao, 50);
      return;
    }
    if (!o.edicao) setTimeout(proximaConfirmacao, 50);
  });

  // ------------------------------------------------------ configurações
  function abrirConfig(alerta) {
    $('cfgAlerta').style.display = alerta ? 'block' : 'none';
    $('cfgAlerta').textContent = alerta || '';
    $('cfgUrl').value = cfg.url; $('cfgToken').value = cfg.token; $('cfgOperador').value = cfg.operador;
    $('cfgAusencia').value = String(cfg.ausenciaMs);
    Array.prototype.forEach.call(document.querySelectorAll('input[name=modo]'), function (el) { el.checked = el.value === cfg.modo; });
    $('teste').textContent = '';
    $('dlgConfig').showModal();
  }
  function lerCamposConfig() {
    cfg.url = $('cfgUrl').value.trim();
    cfg.token = $('cfgToken').value.trim();
    cfg.operador = $('cfgOperador').value.trim();
    cfg.ausenciaMs = Number($('cfgAusencia').value);
    var m = document.querySelector('input[name=modo]:checked'); cfg.modo = m ? m.value : 'auto';
  }
  $('btnConfig').addEventListener('click', function () { abrirConfig(); });
  $('dlgConfig').addEventListener('close', function () {
    if ($('dlgConfig').returnValue !== 'salvar') return;
    lerCamposConfig(); guardar('config', cfg);
    maquina = novaMaquina();
    aviso('Configurações salvas.', 'ok');
    sincronizar();
  });
  $('btnTestar').addEventListener('click', function () {
    lerCamposConfig();
    $('teste').textContent = 'Testando…'; $('teste').style.color = '';
    chamar({ acao: 'ping' }).then(function (r) {
      $('teste').style.color = r.ok ? 'var(--ok)' : 'var(--conferir)';
      $('teste').textContent = r.ok ? 'Conectado à planilha "' + r.planilha + '" (Gemini: ' + r.modelo + ').' : r.mensagem;
    }).catch(function (e) {
      $('teste').style.color = 'var(--conferir)';
      $('teste').textContent = 'Sem resposta do script. Confira o endereço (termina em /exec) e a implantação.';
    });
  });

  // --------------------------------------------------- sessão e Excel
  $('sessao').addEventListener('click', function () {
    var n = prompt('Nome desta sessão de inventário:', sessao);
    if (!n || !n.trim()) return;
    var antigo = sessao; sessao = n.trim();
    registros.forEach(function (r) { if (r.sessao === antigo && !r.excluido) { r.sessao = sessao; r.pendente = true; } });
    guardar('sessao', sessao); salvarRegistros(); renderizar(); sincronizar();
  });
  $('btnNovaSessao').addEventListener('click', function () {
    var lista = daSessao();
    if (lista.length && !confirm('Começar uma nova sessão? A atual (' + lista.length + ' paletes) continua salva na planilha.')) return;
    sessao = novaSessaoNome(); guardar('sessao', sessao);
    maquina = novaMaquina();
    renderizar();
    aviso('Nova sessão: ' + sessao, 'ok');
  });

  function linhasExcel(lista) {
    return lista.map(function (r) {
      var o = {};
      Logica.COLUNAS_LEITURAS.forEach(function (c) {
        var v = r[c[0]];
        if (c[0] === 'dataHora') v = v ? new Date(v) : '';
        if (c[0] === 'quantidade') v = typeof r.quantidade === 'number' ? r.quantidade : (r.quantidadeTexto || '');
        if (c[0] === 'modo' && r.possivelRepetido) v = (v || '') + ' · possível repetido';
        o[c[1]] = v == null ? '' : v;
      });
      return o;
    });
  }
  function exportar() {
    var lista = daSessao();
    if (!lista.length) { aviso('Nada para exportar nesta sessão.', 'erro'); return; }
    var wb = XLSX.utils.book_new();
    var abaL = XLSX.utils.json_to_sheet(linhasExcel(lista), { cellDates: true, dateNF: 'dd/mm/yyyy hh:mm:ss' });
    abaL['!cols'] = [10, 19, 22, 14, 14, 34, 18, 12, 14, 12, 11, 30, 16].map(function (w) { return { wch: w }; });
    var res = Logica.resumir(lista).map(function (g) {
      var o = {}; Logica.COLUNAS_RESUMO.forEach(function (c) { o[c[1]] = g[c[0]]; }); return o;
    });
    var abaR = XLSX.utils.json_to_sheet(res);
    abaR['!cols'] = [22, 14, 34, 14, 16, 18].map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, abaL, 'Leituras');
    XLSX.utils.book_append_sheet(wb, abaR, 'Resumo');
    var nome = ('inventario_' + sessao).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_') + '.xlsx';
    XLSX.writeFile(wb, nome, { compression: true });
  }
  $('btnExportar').addEventListener('click', exportar);

  $('btnIniciar').addEventListener('click', function () { rodando ? pausar() : iniciar(); });

  // ------------------------------------------------------------- início
  renderizar();
  sincronizar();
  if (!cfg.url || !cfg.token) setTimeout(function () { abrirConfig('Para começar, abra o link de configuração gerado na planilha (menu Inventário › 3) ou preencha abaixo.'); }, 200);

  // ganchos para os testes automáticos
  window.__inventario = {
    versao: VERSAO,
    estado: function () { return { registros: registros, sessao: sessao, fila: filaLeitura.length, lendo: !!lendo, maquina: maquina.estado }; },
    exportar: exportar
  };
})();
