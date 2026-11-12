/* 隐患随手拍 · 手机端生成《隐患整改通知单》PDF
 * 做法：用 canvas 按 A4（300dpi）排一遍版，页面转 JPEG，再包成 PDF（DCTDecode）。
 * 不依赖任何第三方库；中文字体用系统字体（安卓为思源系，非仿宋）。
 *
 * 用法：SnapPdf.buildNoticePdf({meta, hazards, photos}) -> Promise<Uint8Array>
 */
(function (global) {
  'use strict';

  var DPI = 300;
  var S = DPI / 72;                 // 1pt = S px
  var W = 595.28;
  var H = 841.89;
  var M = { top: 70.9, bottom: 56.7, left: 56.7, right: 56.7 };
  var CW = W - M.left - M.right;    // 481.9
  var AVAIL = H - M.top - M.bottom;
  var GRID = [78, 78, 90, 235.9];
  var FONT_BODY = '"Noto Serif CJK SC","Source Han Serif SC","Songti SC","SimSun",serif';
  var FONT_LABEL = '"Noto Sans CJK SC","Source Han Sans SC","Heiti SC","SimHei",sans-serif';
  var FONT_TITLE = '"Noto Serif CJK SC","Source Han Serif SC","Songti SC","SimSun",serif';

  var D = global.SnapDocx && global.SnapDocx._internal;
  var noticeTitle = global.SnapDocx ? global.SnapDocx.noticeTitle : function () { return ''; };

  function px(v) { return v * S; }

  function newPage() {
    var c = document.createElement('canvas');
    c.width = Math.round(W * S);
    c.height = Math.round(H * S);
    var g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.textBaseline = 'top';
    return { canvas: c, g: g };
  }

  function setFont(g, size, fam, bold) {
    g.font = (bold ? '700 ' : '400 ') + px(size) + 'px ' + fam;
  }

  function wrap(g, text, maxWpx) {
    var out = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (para) {
      if (!para) { out.push(''); return; }
      var line = '';
      for (var i = 0; i < para.length; i++) {
        var ch = para[i];
        if (line && g.measureText(line + ch).width > maxWpx) {
          out.push(line);
          line = ch;
        } else {
          line += ch;
        }
      }
      if (line) out.push(line);
    });
    return out;
  }

  function lineH(size, mult) { return px(size) * 1.39 * (mult || 1); }

  function drawText(g, text, xPt, yPt, size, fam, opt) {
    opt = opt || {};
    setFont(g, size, fam, opt.bold);
    g.fillStyle = opt.color || '#000';
    var x = px(xPt);
    if (opt.align === 'center') x -= g.measureText(text).width / 2;
    if (opt.align === 'right') x -= g.measureText(text).width;
    g.fillText(text, x, px(yPt));
  }

  function hline(g, x1, y1, x2, w) {
    g.strokeStyle = '#000';
    g.lineWidth = px(w);
    g.beginPath();
    g.moveTo(px(x1), px(y1));
    g.lineTo(px(x2), px(y1));
    g.stroke();
  }

  function vline(g, x, y1, y2, w) {
    g.strokeStyle = '#000';
    g.lineWidth = px(w);
    g.beginPath();
    g.moveTo(px(x), px(y1));
    g.lineTo(px(x), px(y2));
    g.stroke();
  }

  function rect(g, x, y, w, h, lw) {
    g.strokeStyle = '#000';
    g.lineWidth = px(lw);
    g.strokeRect(px(x), px(y), px(w), px(h));
  }

  // 段落块：首行靠左，续行按悬挂缩进
  function blockLines(g, text, size, maxW, indent) {
    setFont(g, size, FONT_BODY);
    var lines = [];
    var line = '';
    var width = px(maxW);
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (line && g.measureText(line + ch).width > width) {
        lines.push(line);
        line = ch;
        width = px(maxW - indent);
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function makeRows(payload, descSize, reqSize) {
    var meta = payload.meta || {};
    var hazards = (payload.hazards || []).filter(function (h) { return String(h.desc || '').trim(); });
    var descs = hazards.map(function (h) { return String(h.desc).replace(/\r?\n/g, '；'); });
    var reqBlocks = D.blocks(hazards, meta.requirement);
    var check = D.parseDate(meta.check_date);
    var deadline = meta.deadline ? D.parseDate(meta.deadline)
      : (check ? D.addDays(check, meta.deadline_days || 7) : new Date());

    var rows = [];
    function kv(label, value, size) {
      rows.push({ kind: 'kv', label: label, value: value || '＿＿＿＿＿＿＿＿＿＿', size: size || 14 });
    }
    kv('受查单位', meta.unit, (meta.unit || '').length > 26 ? 13 : 14);
    kv('检查人', meta.inspectors);
    kv('检查时间', D.fmtCN(check));
    kv('检查地点', meta.location);
    rows.push({ kind: 'section', label: '存在问题', items: descs.map(function (t) { return { kind: 'item', text: t }; }), size: descSize });
    rows.push({ kind: 'section', label: '检查处理意见（整改要求）', items: reqBlocks, size: reqSize });
    kv('整改期限', D.fmtCN(deadline) + '前');
    rows.push({ kind: 'opinion', label: '受查单位意见', lines: String(meta.receiver_opinion || '').split(/\r?\n/).filter(Boolean) });
    return rows;
  }

  function measureRows(g, rows) {
    var h = 0;
    rows.forEach(function (r) {
      if (r.kind === 'kv') {
        r.height = (r.label === '受查单位') ? 38 : (r.label === '整改期限' ? 28 : 27);
        setFont(g, r.size, FONT_BODY);
        var lines = wrap(g, r.value, px(GRID[2] + GRID[3] - 10));
        r.height = Math.max(r.height, lines.length * lineH(r.size, 1.15) / S + 4);
      } else if (r.kind === 'section') {
        var no = 0;
        var total = lineH(13, 1.2) / S + 4;
        r.lines = [];
        r.items.forEach(function (it) {
          if (it.kind === 'gap') {
            r.lines.push({ text: '', gap: true });
            total += lineH(r.size, 1) / S;
            return;
          }
          var text = it.kind === 'item' ? ((++no) + '. ' + it.text) : it.text;
          var ls = blockLines(g, text, r.size, CW - 11, r.size * 1.6);
          r.lines.push({ text: text, wrapped: ls });
          total += ls.length * lineH(r.size, 1.35) / S + 2.5;
        });
        r.height = Math.max(r.kind === 'section' && r.label === '存在问题' ? 100 : 80, total + 7);
      } else if (r.kind === 'opinion') {
        r.height = 64;
      }
      h += r.height;
    });
    return h;
  }

  function drawRows(g, rows, x, y0) {
    var y = y0;
    var colX = [0, GRID[0], GRID[0] + GRID[1], GRID[0] + GRID[1] + GRID[2], CW];
    rows.forEach(function (r) {
      var h = r.height;
      if (r.kind === 'kv') {
        // 标签跨前两列，值跨后两列
        vline(g, x, y, y + h, 0.75);
        vline(g, x + colX[2], y, y + h, 0.75);
        vline(g, x + CW, y, y + h, 0.75);
        drawText(g, r.label, x + colX[1] / 2, y + (h - 14) / 2, 13, FONT_LABEL, { align: 'center' });
        setFont(g, r.size, FONT_BODY);
        var lines = wrap(g, r.value, px(GRID[2] + GRID[3] - 14));
        var ty = y + (h - lines.length * lineH(r.size, 1.15) / S) / 2 + 1;
        lines.forEach(function (ln) {
          drawText(g, ln, x + colX[2] + 5, ty, r.size, FONT_BODY);
          ty += lineH(r.size, 1.15) / S;
        });
      } else if (r.kind === 'section') {
        vline(g, x, y, y + h, 0.75);
        vline(g, x + CW, y, y + h, 0.75);
        var ty2 = y + 4;
        drawText(g, r.label, x + 6, ty2, 13, FONT_LABEL);
        ty2 += lineH(13, 1.2) / S + 2;
        r.lines.forEach(function (ln) {
          if (ln.gap) { ty2 += lineH(r.size, 1) / S; return; }
          var indent = r.size * 1.6;
          ln.wrapped.forEach(function (text, i) {
            drawText(g, text, x + 6 + (i === 0 ? 0 : indent), ty2, r.size, FONT_BODY);
            ty2 += lineH(r.size, 1.35) / S;
          });
          ty2 += 2.5;
        });
      } else if (r.kind === 'opinion') {
        vline(g, x, y, y + h, 0.75);
        vline(g, x + CW, y, y + h, 0.75);
        drawText(g, r.label, x + 6, y + 5, 13, FONT_LABEL);
        var ty3 = y + 5 + lineH(13, 1.2) / S + 2;
        r.lines.forEach(function (ln) {
          setFont(g, 14, FONT_BODY);
          wrap(g, ln, px(CW - 40)).forEach(function (t) {
            drawText(g, t, x + 34, ty3, 14, FONT_BODY);
            ty3 += lineH(14, 1.3) / S;
          });
        });
      }
      hline(g, x, y + h, x + CW, 0.75);
      y += h;
    });
    return y;
  }

  function drawFooter(g, pageNo, total) {
    var text = '第 ' + pageNo + ' 页  共 ' + total + ' 页';
    drawText(g, text, W / 2, H - 30, 9, FONT_BODY, { align: 'center', color: '#595959' });
  }

  function renderMain(payload, ctxState) {
    var page = newPage();
    var g = page.g;
    var meta = payload.meta || {};
    var title = noticeTitle(meta);
    var titleSize = Math.max(14, Math.min(22, CW / Math.max(1, title.length) - 1.2));

    var descSize = 14;
    var reqSize = 14;
    var rows = makeRows(payload, descSize, reqSize);
    var measure = function (ds, rs) {
      var rr = makeRows(payload, ds, rs);
      return { rows: rr, h: measureRows(g, rr) };
    };
    var m = measure(descSize, reqSize);
    var fixed = titleSize * 1.6 + 8 + 45 + 4;
    var attempts = [[14, 14], [13, 13], [12, 12], [11, 11], [10.5, 10.5]];
    for (var i = 0; i < attempts.length; i++) {
      m = measure(attempts[i][0], attempts[i][1]);
      if (titleSize * 1.6 + 8 + m.h + 45 + 4 <= AVAIL) { break; }
    }
    descSize = attempts[i] ? attempts[i][0] : 10.5;
    reqSize = attempts[i] ? attempts[i][1] : 10.5;
    rows = m.rows;

    // 意见框吃掉剩余空间，把落款压到页面底部
    var used = titleSize * 1.6 + 8 + m.h + 45 + 4;
    var slack = AVAIL - used;
    var opinion = rows[rows.length - 1];
    opinion.height = Math.max(64, Math.min(300, opinion.height + Math.max(0, slack)));

    drawText(g, title, W / 2, M.top, titleSize, FONT_TITLE, { align: 'center' });
    var y = M.top + titleSize * 1.6 + 4;
    var x = M.left;

    var tableTop = y;
    var yEnd = drawRows(g, rows, x, tableTop);
    vline(g, x, tableTop, yEnd, 1.25);
    vline(g, x + CW, tableTop, yEnd, 1.25);
    hline(g, x, tableTop, x + CW, 1.25);
    hline(g, x, yEnd, x + CW, 1.25);

    var check = D.parseDate(meta.check_date);
    var sy = yEnd + 6;
    drawText(g, '检查单位：' + (meta.issue_unit || ''), x, sy, 11.5, FONT_BODY);
    drawText(g, '签发日期：' + D.fmtCN(check), x + CW / 2, sy, 11.5, FONT_BODY);
    drawText(g, '检查人（签字）：', x, sy + 20, 11.5, FONT_BODY);
    drawText(g, '受查单位负责人（签字）：', x + CW / 2, sy + 20, 11.5, FONT_BODY);

    ctxState.pages.push(page);
    return page;
  }

  function loadBitmap(item) {
    return createImageBitmap(new Blob([item.bytes], { type: 'image/jpeg' }))
      .catch(function () { return null; });
  }

  async function renderAnnex(payload, ctxState) {
    var groups = (payload.photos || []).filter(function (p) { return p.items && p.items.length; });
    if (!groups.length) return;
    var cells = [];
    groups.forEach(function (gp) {
      gp.items.forEach(function (it) {
        cells.push({ seq: gp.seq, desc: gp.desc, item: it });
      });
    });

    var perPage = 4;
    var pages = Math.ceil(cells.length / perPage);
    for (var p = 0; p < pages; p++) {
      var page = newPage();
      var g = page.g;
      var top = M.top;
      drawText(g, '附件：整改前照片', W / 2, top, 18, FONT_TITLE, { align: 'center' });
      drawText(g, '受查单位：' + (payload.meta.unit || '＿＿＿＿'), W / 2, top + 28, 8.5, FONT_BODY,
        { align: 'center', color: '#595959' });

      var gridTop = top + 44;
      var slice = cells.slice(p * perPage, (p + 1) * perPage);
      var rowsN = Math.ceil(slice.length / 2);
      var boxH = Math.max(150, Math.min(220, 620 / rowsN - 40));
      var rowH = boxH + 40;
      var half = CW / 2;

      for (var r = 0; r < rowsN; r++) {
        var y = gridTop + r * rowH;
        hline(g, M.left, y, M.left + CW, 0.75);
        for (var c = 0; c < 2; c++) {
          var idx = r * 2 + c;
          var cellX = M.left + c * half;
          vline(g, cellX, y, y + rowH, 0.75);
          if (idx >= slice.length) continue;
          var item = slice[idx];
          var capY = y + 6;
          setFont(g, 9, FONT_LABEL);
          var capLines = wrap(g, '隐患 ' + item.seq + '：' + String(item.desc || '').slice(0, 42),
            px(half - 12));
          var capH = 0;
          capLines.slice(0, 2).forEach(function (ln) {
            drawText(g, ln, cellX + 6, capY, 9, FONT_LABEL);
            capY += lineH(9, 1.15) / S;
            capH += lineH(9, 1.15) / S;
          });
          var bmp = await loadBitmap(item.item);
          if (bmp) {
            var areaTop = y + 6 + capH + 4;
            var areaBottom = y + rowH - 16;
            var bh = areaBottom - areaTop;
            var bw = Math.min(half - 16, bh * 4 / 3);
            bh = bw * 3 / 4;
            var ix = cellX + (half - bw) / 2;
            var iy = areaTop + ((areaBottom - areaTop) - bh) / 2;
            g.drawImage(bmp, px(ix), px(iy), px(bw), px(bh));
            if (bmp.close) bmp.close();
          }
          var seqNo = p * perPage + idx + 1;
          drawText(g, '照片' + seqNo, cellX + half / 2, y + rowH - 15, 8, FONT_BODY,
            { align: 'center', color: '#595959' });
        }
        vline(g, M.left + CW, y, y + rowH, 0.75);
      }
      var yb = gridTop + rowsN * rowH;
      hline(g, M.left, yb, M.left + CW, 0.75);
      vline(g, M.left, gridTop, yb, 1.0);
      vline(g, M.left + CW, gridTop, yb, 1.0);
      ctxState.pages.push(page);
    }
  }

  function pageToJpeg(page, quality) {
    return new Promise(function (res) {
      page.canvas.toBlob(function (blob) {
        blob.arrayBuffer().then(function (buf) {
          res({ jpeg: new Uint8Array(buf), w: page.canvas.width, h: page.canvas.height });
        });
      }, 'image/jpeg', quality || 0.9);
    });
  }

  // ---------------- 最小 PDF 封装（每页一张 JPEG） ----------------
  function buildPdfFile(images) {
    var enc = new TextEncoder();
    var parts = [];
    var offsets = [];
    var pos = 0;

    function push(data) {
      var b = (typeof data === 'string') ? enc.encode(data) : data;
      parts.push(b);
      pos += b.length;
    }

    push('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');

    var objCount = 2 + images.length * 3;
    var total = objCount + 1;

    function startObj(id) {
      offsets[id] = pos;
      push(id + ' 0 obj\n');
    }

    startObj(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    var kids = images.map(function (_, i) { return (3 + i * 3) + ' 0 R'; }).join(' ');
    startObj(2);
    push('<< /Type /Pages /Kids [' + kids + '] /Count ' + images.length + ' >>\nendobj\n');

    images.forEach(function (img, i) {
      var pageId = 3 + i * 3;
      var contentId = pageId + 1;
      var imageId = pageId + 2;

      startObj(pageId);
      push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] ' +
        '/Resources << /XObject << /Im0 ' + imageId + ' 0 R >> >> ' +
        '/Contents ' + contentId + ' 0 R >>\nendobj\n');

      var content = 'q\n' + W + ' 0 0 ' + H + ' 0 0 cm\n/Im0 Do\nQ\n';
      startObj(contentId);
      push('<< /Length ' + enc.encode(content).length + ' >>\nstream\n' + content + 'endstream\nendobj\n');

      startObj(imageId);
      push('<< /Type /XObject /Subtype /Image /Width ' + img.w + ' /Height ' + img.h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.jpeg.length + ' >>\nstream\n');
      push(img.jpeg);
      push('\nendstream\nendobj\n');
    });

    var xref = pos;
    push('xref\n0 ' + total + '\n');
    push('0000000000 65535 f \n');
    for (var i = 1; i < total; i++) {
      var off = String(offsets[i] || 0);
      while (off.length < 10) off = '0' + off;
      push(off + ' 00000 n \n');
    }
    push('trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    var totalLen = 0;
    parts.forEach(function (p) { totalLen += p.length; });
    var out = new Uint8Array(totalLen);
    var at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  async function buildNoticePdf(payload) {
    var state = { pages: [] };
    renderMain(payload, state);
    await renderAnnex(payload, state);
    var total = state.pages.length;
    state.pages.forEach(function (pg, i) {
      drawFooter(pg.g, i + 1, total);
    });
    var images = [];
    for (var i = 0; i < state.pages.length; i++) {
      images.push(await pageToJpeg(state.pages[i], 0.9));
      state.pages[i].canvas.width = 1;
      state.pages[i].canvas.height = 1;
    }
    return buildPdfFile(images);
  }

  global.SnapPdf = {
    buildNoticePdf: buildNoticePdf,
    _internal: { buildPdfFile: buildPdfFile }
  };
})(typeof window !== 'undefined' ? window : globalThis);
