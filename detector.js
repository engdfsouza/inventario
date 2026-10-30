/*
 * detector.js — detecta, num quadro de vídeo reduzido, se há uma etiqueta
 * (folha branca retangular) visível e se ela está inteira no quadro.
 *
 * Não lê o conteúdo: só decide QUANDO vale a pena enviar a imagem para leitura
 * e quando a etiqueta saiu da câmera (regra "saiu e voltou").
 *
 * Funciona no navegador e no Node (testes): recebe {data, width, height}
 * no formato RGBA do ImageData.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Detector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    largura: 160,          // largura da análise (o chamador reduz o quadro para isso)
    vMin: 0.35,            // brilho mínimo (0-1) para considerar "papel"
    ganhoMaxBranco: 1.2,   // correção máxima do balanço de branco por canal
    vRelativo: 0.80,       // ...e pelo menos 80% do percentil 97 de brilho da cena
    sMax: 0.06,            // saturação máxima: papel ~0.00-0.05; papelão 0.09-0.25
    raioAbertura: 1,       // remove reflexos finos do filme e separa regiões coladas
    raioFechamento: 2,     // fecha buracos do texto escrito sobre a folha
    areaMin: 0.03,         // etiqueta ocupa pelo menos 3% do quadro
    areaMax: 0.85,
    preenchimentoMin: 0.55,// área / área do retângulo envolvente (folha é retangular)
    buracosMax: 0.12,      // reflexo do filme é "poroso"; a folha é sólida (~0.03-0.08)
    aspectoMin: 0.45,
    aspectoMax: 4.0,
    margemBorda: 1         // px (na escala da análise) para considerar "inteira"
  };

  function opcoes(o) {
    var r = {};
    for (var k in DEFAULTS) r[k] = (o && o[k] != null) ? o[k] : DEFAULTS[k];
    return r;
  }

  // Dilatação/erosão separáveis (quadrado de lado 2r+1) sobre máscara Uint8Array.
  function morf(mask, w, h, r, dilatar) {
    var tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    var x, y, k, v;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        v = dilatar ? 0 : 1;
        for (k = -r; k <= r; k++) {
          var xx = x + k;
          var m = (xx < 0 || xx >= w) ? (dilatar ? 0 : 1) : mask[y * w + xx];
          if (dilatar ? m : !m) { v = dilatar ? 1 : 0; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        v = dilatar ? 0 : 1;
        for (k = -r; k <= r; k++) {
          var yy = y + k;
          var m2 = (yy < 0 || yy >= h) ? (dilatar ? 0 : 1) : tmp[yy * w + x];
          if (dilatar ? m2 : !m2) { v = dilatar ? 1 : 0; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  function percentil(hist, total, p) {
    var alvo = total * p, acc = 0;
    for (var i = 0; i < 256; i++) { acc += hist[i]; if (acc >= alvo) return i; }
    return 255;
  }

  /**
   * Analisa um quadro.
   * @returns {{presente:boolean, inteira:boolean, centralizada:boolean, caixa:object|null,
   *            cinza:Uint8Array, largura:number, altura:number}}
   *   caixa em coordenadas relativas (0-1): {x, y, w, h, area, preenchimento}
   */
  function analisar(img, o) {
    o = opcoes(o);
    var w = img.width, h = img.height, d = img.data, n = w * h;
    var cinza = new Uint8Array(n), vArr = new Uint8Array(n), sArr = new Float32Array(n);
    var hist = new Uint32Array(256), hR = new Uint32Array(256), hG = new Uint32Array(256), hB = new Uint32Array(256);
    var i, p;
    for (i = 0, p = 0; i < n; i++, p += 4) { hR[d[p]]++; hG[d[p + 1]]++; hB[d[p + 2]]++; }
    // Balanço de branco: as partes mais claras da cena (o papel) devem ficar neutras.
    // Corrige luz amarelada/azulada do armazém. Ganho limitado para não "branquear" papelão.
    var r99 = percentil(hR, n, 0.99), g99 = percentil(hG, n, 0.99), b99 = percentil(hB, n, 0.99);
    var ref = Math.max(r99, g99, b99, 1);
    var gR = Math.min(o.ganhoMaxBranco, ref / Math.max(r99, 1)),
        gG = Math.min(o.ganhoMaxBranco, ref / Math.max(g99, 1)),
        gB = Math.min(o.ganhoMaxBranco, ref / Math.max(b99, 1));
    for (i = 0, p = 0; i < n; i++, p += 4) {
      var r = d[p] * gR, g = d[p + 1] * gG, b = d[p + 2] * gB;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mx > 255) mx = 255;
      vArr[i] = mx;
      sArr[i] = mx === 0 ? 0 : (mx - mn) / mx;
      cinza[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      hist[vArr[i]]++;
    }
    var p97 = percentil(hist, n, 0.97);
    var limiarV = Math.max(o.vMin * 255, o.vRelativo * p97);

    var mask = new Uint8Array(n);
    for (i = 0; i < n; i++) mask[i] = (vArr[i] >= limiarV && sArr[i] <= o.sMax) ? 1 : 0;

    // Abertura (erode→dilata): some com reflexos finos do filme stretch.
    if (o.raioAbertura > 0) mask = morf(morf(mask, w, h, o.raioAbertura, false), w, h, o.raioAbertura, true);
    // Fechamento (dilata→erode): preenche o texto escrito na folha.
    var fechada = morf(morf(mask, w, h, o.raioFechamento, true), w, h, o.raioFechamento, false);

    // Componentes conexos (4-vizinhança).
    var rot = new Int32Array(n), fila = new Int32Array(n), melhor = null, atual = 0;
    for (i = 0; i < n; i++) {
      if (!fechada[i] || rot[i]) continue;
      atual++;
      var ini = 0, fim = 0, area = 0, buracos = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
      fila[fim++] = i; rot[i] = atual;
      while (ini < fim) {
        var q = fila[ini++], qx = q % w, qy = (q / w) | 0;
        area++;
        if (!mask[q]) buracos++;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx;
        if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        if (qx > 0 && fechada[q - 1] && !rot[q - 1]) { rot[q - 1] = atual; fila[fim++] = q - 1; }
        if (qx < w - 1 && fechada[q + 1] && !rot[q + 1]) { rot[q + 1] = atual; fila[fim++] = q + 1; }
        if (qy > 0 && fechada[q - w] && !rot[q - w]) { rot[q - w] = atual; fila[fim++] = q - w; }
        if (qy < h - 1 && fechada[q + w] && !rot[q + w]) { rot[q + w] = atual; fila[fim++] = q + w; }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      var fracArea = area / n, preench = area / (bw * bh), aspecto = bw / bh;
      if (fracArea < o.areaMin || fracArea > o.areaMax) continue;
      if (preench < o.preenchimentoMin) continue;
      if (buracos / area > o.buracosMax) continue;
      if (aspecto < o.aspectoMin || aspecto > o.aspectoMax) continue;
      var pontuacao = area * preench * preench; // prefere regiões grandes E retangulares
      if (!melhor || pontuacao > melhor.pontuacao) {
        melhor = { pontuacao: pontuacao, areaPx: area, x0: x0, y0: y0, x1: x1, y1: y1, preenchimento: preench };
      }
    }

    var res = { presente: false, inteira: false, centralizada: false, caixa: null, cinza: cinza, largura: w, altura: h };
    if (melhor) {
      var mb = o.margemBorda;
      res.presente = true;
      var cx = (melhor.x0 + melhor.x1 + 1) / 2 / w, cy = (melhor.y0 + melhor.y1 + 1) / 2 / h;
      // "centralizada": o centro da folha está longe das bordas — boa hora para ler.
      res.centralizada = cx > 0.15 && cx < 0.85 && cy > 0.15 && cy < 0.85;
      res.inteira = melhor.x0 >= mb && melhor.y0 >= mb && melhor.x1 <= w - 1 - mb && melhor.y1 <= h - 1 - mb;
      res.caixa = {
        x: melhor.x0 / w, y: melhor.y0 / h,
        w: (melhor.x1 - melhor.x0 + 1) / w, h: (melhor.y1 - melhor.y0 + 1) / h,
        area: melhor.areaPx / n, preenchimento: melhor.preenchimento
      };
    }
    return res;
  }

  /** Diferença média absoluta (0-255) entre dois quadros em tons de cinza. */
  function movimento(cinzaA, cinzaB) {
    if (!cinzaA || !cinzaB || cinzaA.length !== cinzaB.length) return 255;
    var s = 0;
    for (var i = 0; i < cinzaA.length; i++) {
      var dlt = cinzaA[i] - cinzaB[i];
      s += dlt < 0 ? -dlt : dlt;
    }
    return s / cinzaA.length;
  }

  return { analisar: analisar, movimento: movimento, DEFAULTS: DEFAULTS };
});
