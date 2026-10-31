/*
 * app.js — Inventário de Paletes v0.2
 * Câmera → detector (quando ler) → Apps Script/Gemini (o que está escrito)
 * → lista local + Google Sheets → Excel.
 *
 * v0.2: fila de leitura persistente (sem internet, as fotos ficam guardadas no
 * celular e são lidas quando a conexão volta), zoom (óptico quando o aparelho
 * permite, digital nos demais) e foto manual pela câmera do próprio celular.
 */
(function () {
  'use strict';

  var VERSAO = '0.2';
  var CHAVE = 'inv.v1.';
  var INTERVALO_ANALISE_MS = 125;      // ~8 análises por segundo
  var LADO_MAX_ENVIO = 1600;           // px do maior lado da foto enviada ao Gemini
  var JANELA_REPETIDO_MS = 2500;      // re-registro quase imediato = provável tremida, não palete novo
  var LADO_MAX_FOTO = 2000;            // foto manual (câmera nativa): um pouco maior, a etiqueta pode estar longe
  var TEMPO_LIMITE_REDE_MS = 20000;    // sem resposta nesse tempo = trata como sem internet
  var LIBERAR_APOS_MS = 6000;          // leitura demorando: libera o operador para o próximo palete
  var ZOOM_DIGITAL_MAX = 4;

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
  var redeOk = navigator.onLine !== false;
  var zoom = { hw: null, valor: 1 };   // hw = {min,max} quando a câmera tem zoom óptico/nativo

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

  // Fila de leitura e fotos de conferência ficam no IndexedDB (aguentam fechar o app).
  var db = null;
  function abrirDB() {
    return new Promise(function (ok) {
      try {
        var rq = indexedDB.open('inventario-paletes', 1);
        rq.onupgradeneeded = function () {
          rq.result.createObjectStore('fila', { keyPath: 'id' });
          rq.result.createObjectStore('fotos', { keyPath: 'id' });
        };
        rq.onsuccess = function () { db = rq.result; ok(db); };
        rq.onerror = function () { ok(null); };
      } catch (e) { ok(null); }
    });
  }
  function dbOp(loja, modo, fn) {
    return new Promise(function (ok) {
      if (!db) { ok(null); return; }
      try {
        var tx = db.transaction(loja, modo), st = tx.objectStore(loja), rq = fn(st);
        tx.oncomplete = function () { ok(rq && rq.result); };
        tx.onerror = tx.onabort = function () { ok(null); };
      } catch (e) { ok(null); }
    });
  }
  function filaGuardar(c) {
    var o = {}; for (var k in c) if (k !== 'foto') o[k] = c[k];
    return dbOp('fila', 'readwrite', function (st) { return st.put(o); });
  }
  function filaRemover(id) { return dbOp('fila', 'readwrite', function (st) { return st.delete(id); }); }
  function fotoGuardar(id, dataUrl) { return dbOp('fotos', 'readwrite', function (st) { return st.put({ id: id, foto: dataUrl }); }); }
  function fotoLer(id) { return dbOp('fotos', 'readonly', function (st) { return st.get(id); }).then(function (r) { return r && r.foto; }); }
  function fotoRemover(id) { return dbOp('fotos', 'readwrite', function (st) { return st.delete(id); }); }

  function novaSessaoNome() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'Inventário ' + p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  /** Evita juntar duas sessões criadas no mesmo minuto (mesmo nome). */
  function nomeSessaoUnico(nome) {
    var usados = {}; usados[sessao] = true;
    registros.forEach(function (r) { usados[r.sessao] = true; });
    var n = nome, i = 2;
    while (usados[n]) n = nome + ' (' + (i++) + ')';
    return n;
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
  function horaCurta(iso) {
    var d = new Date(iso), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function renderizar() {
    var lista = daSessao();
    var conferir = lista.filter(function (r) { return r.status === 'CONFERIR'; }).length;
    var pend = registros.filter(function (r) { return r.pendente; }).length;
    var emLeitura = filaLeitura.slice();
    if (lendo && lendo.miniatura) emLeitura.unshift(lendo);
    var aguardando = emLeitura.length;
    $('nomeSessao').textContent = sessao;
    $('contadores').innerHTML = lista.length + (lista.length === 1 ? ' palete' : ' paletes') +
      (aguardando ? ' · <span class="p">' + aguardando + ' aguardando leitura</span>' : '') +
      (conferir ? ' · <span class="c">' + conferir + ' a conferir</span>' : '') +
      (pend ? ' · <span class="p">' + pend + ' sem enviar</span>' : '');
    $('rede').hidden = redeOk;

    var html = '';
    emLeitura.forEach(function (c) {
      var txt = !redeOk || c.semRede ? 'Guardada — leio quando a internet voltar'
        : c.esperaAte > Date.now() ? 'Aguardando o Gemini…' : 'Lendo etiqueta…';
      html += '<div class="linha lendo"><span class="n"></span><img src="' + c.miniatura + '" alt="">' +
        '<div class="info"><div class="cod">' + txt + '</div><div class="det">' +
        (c.origem === 'foto' ? 'Foto manual · ' : '') + horaCurta(c.dataHora) +
        (!redeOk || c.semRede ? '<span class="selo offline">sem internet</span>' : '') + '</div></div></div>';
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
    var video_ = { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } };
    var comZoom = Object.assign({ zoom: true }, video_); // zoom:true pede acesso ao zoom da câmera (Chrome/Android)
    navigator.mediaDevices.getUserMedia({ audio: false, video: comZoom }).catch(function () {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: video_ });
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
      prepararZoom();
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
    $('zoom').hidden = true; video.style.transform = '';
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

  // ------------------------------------------------------------------ zoom
  function prepararZoom() {
    var cap = trilha && trilha.getCapabilities ? trilha.getCapabilities() : {};
    zoom.hw = cap.zoom && cap.zoom.max > 1 ? { min: cap.zoom.min || 1, max: cap.zoom.max } : null;
    $('zoom').hidden = false;
    aplicarZoom(zoom.valor || 1, true);
  }
  function zoomMax() { return zoom.hw ? Math.min(zoom.hw.max, 10) : ZOOM_DIGITAL_MAX; }
  function zoomDigital() { return zoom.hw ? 1 : zoom.valor; }
  function aplicarZoom(z, silencioso) {
    z = Math.max(1, Math.min(zoomMax(), Math.round(z * 10) / 10));
    zoom.valor = z;
    if (zoom.hw && trilha) {
      video.style.transform = '';
      trilha.applyConstraints({ advanced: [{ zoom: Math.max(zoom.hw.min, z) }] }).catch(function () {
        zoom.hw = null; aplicarZoom(z, silencioso); // aparelho recusou: cai para o zoom digital
      });
    } else {
      video.style.transform = z > 1 ? 'scale(' + z + ')' : '';
    }
    Array.prototype.forEach.call(document.querySelectorAll('#zoom button'), function (b) {
      var bz = Number(b.dataset.z);
      b.hidden = bz > zoomMax();
      b.classList.toggle('ativo', Math.abs(bz - z) < 0.05);
    });
    cinzaAnterior = null; // a imagem muda inteira: não é "movimento"
    if (!silencioso) {
      var el = $('zoomValor'); el.textContent = z.toFixed(1).replace('.0', '') + '×'; el.classList.add('visivel');
      clearTimeout(aplicarZoom.t); aplicarZoom.t = setTimeout(function () { el.classList.remove('visivel'); }, 900);
    }
  }
  $('zoom').addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-z]');
    if (b) aplicarZoom(Number(b.dataset.z));
  });
  // pinça com dois dedos sobre a imagem
  (function pinca() {
    var toques = {}, inicio = null;
    function dist() {
      var p = Object.keys(toques).map(function (k) { return toques[k]; });
      return p.length < 2 ? 0 : Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    }
    var area = $('camera');
    area.addEventListener('pointerdown', function (e) {
      toques[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (Object.keys(toques).length === 2) inicio = { d: dist(), z: zoom.valor };
    });
    area.addEventListener('pointermove', function (e) {
      if (!toques[e.pointerId]) return;
      toques[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (inicio && inicio.d > 0 && rodando) aplicarZoom(inicio.z * dist() / inicio.d);
    });
    function fim(e) { delete toques[e.pointerId]; if (Object.keys(toques).length < 2) inicio = null; }
    area.addEventListener('pointerup', fim); area.addEventListener('pointercancel', fim); area.addEventListener('pointerleave', fim);
  })();

  /** Região do vídeo que o operador está vendo (recorte central quando há zoom digital). */
  function regiao() {
    var vw = video.videoWidth, vh = video.videoHeight, z = zoomDigital();
    var sw = vw / z, sh = vh / z;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw: sw, sh: sh };
  }

  function analisar() {
    if (!rodando || video.readyState < 2 || !video.videoWidth) return;
    var rg = regiao();
    var w = Detector.DEFAULTS.largura, h = Math.round(rg.sh * w / rg.sw);
    if (cAnalise.width !== w || cAnalise.height !== h) { cAnalise.width = w; cAnalise.height = h; cinzaAnterior = null; }
    ctxAnalise.drawImage(video, rg.sx, rg.sy, rg.sw, rg.sh, 0, 0, w, h);
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
    else if (maquina.estado === 'AGUARDANDO') situacao(redeOk ? 'Lendo etiqueta…' : 'Guardando foto…', 'lendo');
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
    // mapeia coordenadas do recorte analisado para a tela (object-fit: cover + zoom digital)
    var vw = video.videoWidth, vh = video.videoHeight, rg = regiao();
    var esc = Math.max(dw / vw, dh / vh) * zoomDigital();
    var x = dw / 2 + (rg.sx + r.caixa.x * rg.sw - vw / 2) * esc, y = dh / 2 + (rg.sy + r.caixa.y * rg.sh - vh / 2) * esc;
    var w = r.caixa.w * rg.sw * esc, h = r.caixa.h * rg.sh * esc;
    ctx.lineWidth = 4;
    ctx.strokeStyle = maquina.estado === 'BLOQUEADO' ? '#35c27a' : r.centralizada ? '#ffb020' : 'rgba(255,255,255,.6)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 10); else ctx.rect(x, y, w, h);
    ctx.stroke();
  }
  function limparSobreposicao() { sobre.getContext('2d').clearRect(0, 0, sobre.width, sobre.height); }

  // ------------------------------------------------------------- captura
  /** Desenha `fonte` (recorte sx,sy,sw,sh) num JPEG de no máximo `lado` px; devolve dataURL e miniatura. */
  function gerarJpeg(fonte, sx, sy, sw, sh, lado) {
    var e = Math.min(1, lado / Math.max(sw, sh));
    cCaptura.width = Math.round(sw * e); cCaptura.height = Math.round(sh * e);
    cCaptura.getContext('2d').drawImage(fonte, sx, sy, sw, sh, 0, 0, cCaptura.width, cCaptura.height);
    var dataUrl = cCaptura.toDataURL('image/jpeg', 0.85);
    var t = document.createElement('canvas');
    var te = 240 / Math.max(cCaptura.width, cCaptura.height);
    t.width = Math.round(cCaptura.width * te); t.height = Math.round(cCaptura.height * te);
    t.getContext('2d').drawImage(cCaptura, 0, 0, t.width, t.height);
    return { foto: dataUrl, imagem: dataUrl.slice(dataUrl.indexOf(',') + 1), miniatura: t.toDataURL('image/jpeg', 0.7) };
  }

  function capturar(acao) {
    var rg = regiao();
    var j = gerarJpeg(video, rg.sx, rg.sy, rg.sw, rg.sh, LADO_MAX_ENVIO);
    enfileirar({ aparicao: acao.aparicao, manual: !!acao.manual, origem: acao.manual ? 'ler agora' : 'automático',
      imagem: j.imagem, foto: j.foto, miniatura: j.miniatura });
  }

  function enfileirar(dados) {
    var c = Object.assign({
      id: uid(), dataHora: new Date().toISOString(), sessao: sessao, operador: cfg.operador || '',
      tentativasRede: 0, esperaAte: 0, semRede: false, liberado: false
    }, dados);
    filaLeitura.push(c);
    filaGuardar(c);
    renderizar();
    processarFila();
    return c;
  }

  $('btnLer').addEventListener('click', function () {
    if (!rodando) return;
    capturar(maquina.forcar(Date.now()));
    fixarSituacao(redeOk ? 'Lendo etiqueta…' : 'Foto guardada', 'lendo');
  });

  // ------------------------------------------- foto manual (câmera do celular)
  // Abre a câmera nativa do aparelho: zoom óptico, foco e resolução máximos.
  var retomarAposFoto = false;
  $('btnFoto').addEventListener('click', function () {
    retomarAposFoto = rodando;
    if (rodando) pausar(); // libera a câmera para o app de câmera do celular
    $('inputFoto').value = '';
    $('inputFoto').click();
    window.addEventListener('focus', function voltar() {
      window.removeEventListener('focus', voltar);
      setTimeout(function () { if (retomarAposFoto && !rodando) { retomarAposFoto = false; iniciar(); } }, 1200);
    });
  });
  $('inputFoto').addEventListener('change', function () {
    var arq = this.files && this.files[0];
    if (!arq) return;
    lerArquivoFoto(arq).then(function (j) {
      enfileirar({ aparicao: null, manual: true, origem: 'foto', imagem: j.imagem, foto: j.foto, miniatura: j.miniatura });
      bip('ok');
      aviso(redeOk ? 'Foto recebida — lendo…' : 'Foto guardada — leio quando a internet voltar', 'ok');
    }).catch(function () {
      aviso('Não consegui abrir a foto. Tente de novo.', 'erro', 4000);
    }).then(function () {
      if (retomarAposFoto && !rodando) { retomarAposFoto = false; iniciar(); }
    });
  });
  function lerArquivoFoto(arq) {
    var abrir = window.createImageBitmap
      ? createImageBitmap(arq, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(arq); })
      : new Promise(function (ok, erro) {
        var img = new Image(); img.onload = function () { ok(img); }; img.onerror = erro; img.src = URL.createObjectURL(arq);
      });
    return abrir.then(function (img) {
      var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
      return gerarJpeg(img, 0, 0, w, h, LADO_MAX_FOTO);
    });
  }

  // --------------------------------------------------- servidor (Apps Script)
  function chamar(corpo, limiteMs) {
    corpo.token = cfg.token;
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, limiteMs || TEMPO_LIMITE_REDE_MS) : null;
    return fetch(cfg.url, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita pré-verificação CORS
      body: JSON.stringify(corpo), signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { clearTimeout(t); throw e; });
  }
  function marcarRede(ok) {
    if (redeOk === ok) return;
    redeOk = ok;
    renderizar();
    if (ok) { aviso('Internet de volta — lendo as fotos guardadas.', 'ok'); sincronizar(); }
  }

  /**
   * Libera o operador para seguir em frente sem esperar a leitura: a foto já está
   * guardada e será lida assim que possível (sem internet ou internet lenta).
   */
  function liberar(c, motivo) {
    if (c.liberado) return;
    c.liberado = true;
    filaGuardar(c);
    if (c.aparicao != null) maquina.resultado(c.aparicao, 'registrado');
    if (c.origem !== 'foto') {
      bip('ok');
      fixarSituacao(motivo === 'rede' ? 'Foto guardada ✓ — leio quando a internet voltar' : 'Foto guardada ✓ — siga para o próximo', 'ok', 2200);
    }
  }

  var timerFila = null;
  function agendarFila(ms) { clearTimeout(timerFila); timerFila = setTimeout(processarFila, ms); }

  function processarFila() {
    if (lendo || !filaLeitura.length) return;
    var agora = Date.now();
    var c = filaLeitura[0];
    if (!redeOk && navigator.onLine === false) {
      filaLeitura.forEach(function (x) { x.semRede = true; liberar(x, 'rede'); });
      renderizar();
      agendarFila(15000); // o evento "online" também dispara a fila
      return;
    }
    if (c.esperaAte > agora) { agendarFila(c.esperaAte - agora); return; }
    lendo = filaLeitura.shift();
    renderizar();
    var lenta = setTimeout(function () { liberar(c, 'lenta'); }, LIBERAR_APOS_MS);
    chamar({ acao: 'ler', imagem: c.imagem }).then(function (resp) {
      clearTimeout(lenta);
      marcarRede(true);
      c.semRede = false;
      tratarLeitura(c, resp);
    }).catch(function () {
      clearTimeout(lenta);
      // sem internet, Wi-Fi caiu ou resposta não veio: a foto continua na fila, nunca se perde
      c.tentativasRede++;
      c.semRede = true;
      c.esperaAte = Date.now() + Math.min(30000, 3000 * c.tentativasRede);
      filaLeitura.unshift(c);
      filaGuardar(c);
      marcarRede(false);
      liberar(c, 'rede');
    }).then(function () {
      lendo = false;
      renderizar();
      processarFila();
    });
  }

  /** Tira um item da fila (lido ou descartado). */
  function concluirItem(c) { filaRemover(c.id); }

  function tratarLeitura(c, resp) {
    var depois = c.liberado; // o operador já seguiu em frente (sem internet / leitura lenta)
    if (!resp || !resp.ok) {
      var erro = resp && resp.erro;
      if ((erro === 'limite' || erro === 'gemini') && resp.tentarEmMs) {
        c.esperaAte = Date.now() + resp.tentarEmMs;
        filaLeitura.unshift(c);
        if (!depois) fixarSituacao(erro === 'limite' ? 'Limite do Gemini — continuo em ' + Math.ceil(resp.tentarEmMs / 1000) + ' s' : 'Gemini instável — tentando de novo', 'aviso', 2500);
        return;
      }
      if (erro === 'senha' || erro === 'chave') {
        // problema de configuração: guarda a foto e para tudo até corrigir
        c.esperaAte = Date.now() + 60000; filaLeitura.unshift(c); filaGuardar(c);
        bip('erro'); pausar(); abrirConfig(resp.mensagem);
        return;
      }
      registrarNaoLida(c, resp && resp.mensagem || 'erro na leitura');
      return;
    }
    if (resp.acao !== 'registrar') {
      if (depois || c.origem === 'foto' && c.semRede) { registrarNaoLida(c, resp.motivo); return; }
      concluirItem(c);
      var res = c.aparicao != null ? maquina.resultado(c.aparicao, 'tentar') : 'manual';
      if (c.manual) { bip('erro'); aviso((resp.motivo || 'Não encontrei a etiqueta') + '. Tire outra foto, mais de perto.', 'erro', 4000); }
      else if (res === 'desistiu') {
        bip('erro');
        aviso('Não consegui ler esta etiqueta. Use o zoom, "Ler agora" ou "Foto".', 'erro', 4000);
      }
      return;
    }
    if (c.aparicao != null) maquina.resultado(c.aparicao, 'registrado');
    concluirItem(c);
    var r = resp.registro;
    var reg = {
      id: c.id, dataHora: c.dataHora, sessao: c.sessao || sessao, operador: c.operador || cfg.operador || '',
      codigo: r.codigo, item: r.item, lote: r.lote, validade: r.validade, fornecedor: r.fornecedor,
      quantidade: r.quantidade, quantidadeTexto: r.quantidadeTexto, status: r.status, observacao: r.observacao,
      modo: c.origem + (depois ? ' · lido depois' : '')
    };
    miniaturas[reg.id] = c.foto || ('data:image/jpeg;base64,' + c.imagem);
    if (reg.status === 'CONFERIR') fotoGuardar(reg.id, miniaturas[reg.id]);
    if (depois) { adicionar(reg, true); return; } // não abre confirmação fora de hora
    if (cfg.modo === 'confirmar') {
      filaConfirmacao.push(reg);
      if (!editando) proximaConfirmacao();
      bip(r.status === 'OK' ? 'ok' : 'conferir');
      return;
    }
    adicionar(reg);
  }

  /** Foto que não pôde ser lida depois que o operador já seguiu: entra como CONFERIR, com a foto. */
  function registrarNaoLida(c, motivo) {
    if (c.aparicao != null) maquina.resultado(c.aparicao, 'registrado');
    concluirItem(c);
    var reg = {
      id: c.id, dataHora: c.dataHora, sessao: c.sessao || sessao, operador: c.operador || cfg.operador || '',
      codigo: '', item: '', lote: '', validade: '', fornecedor: '', quantidade: null, quantidadeTexto: '',
      status: 'CONFERIR', observacao: 'etiqueta não lida (' + (motivo || 'sem leitura') + ') — veja a foto',
      modo: c.origem + (c.liberado ? ' · lido depois' : '')
    };
    miniaturas[reg.id] = c.foto || ('data:image/jpeg;base64,' + c.imagem);
    fotoGuardar(reg.id, miniaturas[reg.id]);
    adicionar(reg, true);
  }

  function adicionar(reg, silencioso) {
    var anteriores = registros.filter(function (r) { return r.sessao === reg.sessao && !r.excluido; });
    reg.possivelRepetido = Logica.possivelRepetido(anteriores[anteriores.length - 1], reg, JANELA_REPETIDO_MS);
    reg.pendente = true;
    registros.push(reg);
    salvarRegistros();
    renderizar();
    sincronizar();
    if (silencioso) return;
    var q = typeof reg.quantidade === 'number' ? reg.quantidade.toLocaleString('pt-BR') : (reg.quantidadeTexto || '?');
    if (reg.status === 'OK') {
      bip('ok');
      fixarSituacao('Registrado ✓  ' + reg.codigo + ' · ' + q, 'ok', 2200);
    } else {
      bip('conferir');
      fixarSituacao('Registrado — CONFERIR  ' + (reg.codigo || '???') + ' · ' + q, 'erro', 3000);
    }
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
      if (falhasSync >= 2) marcarRede(false);
    }).then(function () {
      sincronizando = false;
      renderizar();
      if (registros.some(function (r) { return r.pendente; })) {
        setTimeout(sincronizar, falhasSync ? Math.min(30000, 2000 * falhasSync) : 300);
      }
    });
  }
  window.addEventListener('online', function () { marcarRede(true); filaLeitura.forEach(function (c) { c.esperaAte = 0; }); processarFila(); sincronizar(); });
  window.addEventListener('offline', function () { marcarRede(false); processarFila(); });

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
    else fotoLer(r.id).then(function (f) { if (f && editando && editando.registro === r) { $('regFoto').src = f; $('regFoto').style.display = 'block'; } });
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
        if (r.status === 'OK') fotoRemover(r.id);
        salvarRegistros(); renderizar(); sincronizar();
        aviso('Palete atualizado.', 'ok');
      } else {
        r.modo = 'confirmado';
        adicionar(r);
      }
    } else if (acao === 'excluir' && o.edicao) {
      if (confirm('Excluir este palete da contagem?')) {
        r.excluido = true; r.pendente = true; fotoRemover(r.id);
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
    var antigo = sessao; sessao = n.trim() === antigo ? antigo : nomeSessaoUnico(n.trim());
    registros.forEach(function (r) { if (r.sessao === antigo && !r.excluido) { r.sessao = sessao; r.pendente = true; } });
    guardar('sessao', sessao); salvarRegistros(); renderizar(); sincronizar();
  });
  $('btnNovaSessao').addEventListener('click', function () {
    var lista = daSessao();
    if (lista.length && !confirm('Começar uma nova sessão? A atual (' + lista.length + ' paletes) continua salva na planilha.')) return;
    sessao = nomeSessaoUnico(novaSessaoNome()); guardar('sessao', sessao);
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
  function aguardandoComoLinhas() {
    var itens = filaLeitura.slice(); if (lendo) itens.unshift(lendo);
    return itens.filter(function (c) { return (c.sessao || sessao) === sessao; }).map(function (c) {
      return { id: c.id, dataHora: c.dataHora, sessao: c.sessao || sessao, operador: c.operador || '',
        codigo: '(aguardando leitura)', quantidade: null, quantidadeTexto: '', status: 'AGUARDANDO LEITURA',
        observacao: 'foto guardada no celular; será lida quando houver internet', modo: c.origem };
    });
  }
  function exportar() {
    var aguard = aguardandoComoLinhas();
    var lista = daSessao().concat(aguard);
    if (!lista.length) { aviso('Nada para exportar nesta sessão.', 'erro'); return; }
    if (aguard.length) aviso(aguard.length + ' foto(s) ainda sem leitura entraram como "AGUARDANDO LEITURA". Exporte de novo depois.', 'erro', 6000);
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
  abrirDB().then(function () { return dbOp('fila', 'readonly', function (st) { return st.getAll(); }); }).then(function (itens) {
    if (!itens || !itens.length) return;
    itens.sort(function (a, b) { return a.dataHora < b.dataHora ? -1 : 1; });
    itens.forEach(function (c) { c.liberado = true; c.esperaAte = 0; c.aparicao = null; filaLeitura.push(c); });
    aviso(itens.length + ' foto(s) guardada(s) para ler.', 'ok');
    renderizar();
    processarFila();
  });
  if (!cfg.url || !cfg.token) setTimeout(function () { abrirConfig('Para começar, abra o link de configuração gerado na planilha (menu Inventário › 3) ou preencha abaixo.'); }, 200);

  // ganchos para os testes automáticos
  window.__inventario = {
    versao: VERSAO,
    estado: function () { return { registros: registros, sessao: sessao, fila: filaLeitura.length, lendo: !!lendo, maquina: maquina.estado, redeOk: redeOk, zoom: { valor: zoom.valor, hw: !!zoom.hw } }; },
    exportar: exportar
  };
})();
