/* 隐患随手拍 · 手机端生成《隐患整改通知单》.docx（纯 JS，无第三方库）
 * 版式对齐桌面端 core/docgen.py:render_notice()：
 * A4、四列表格、仿宋/黑体/华文中宋、页脚"第 X 页 共 Y 页"、附件照片页。
 *
 * 用法：
 *   SnapDocx.buildNotice({ meta, hazards, photos }) -> Uint8Array
 *   SnapDocx.noticeTitle(meta) / SnapDocx.noticeFileName(meta)
 *
 * meta:   {unit, inspectors, check_date, location, issue_unit, deadline,
 *          check_type, special_name, requirement, receiver_opinion}
 * hazards:[{seq, desc, measure}]
 * photos: [{seq, desc, items:[{bytes:Uint8Array, w, h}]}]   // 整改前照片
 */
(function (global) {
  'use strict';

  var FONT_TITLE = '华文中宋';
  var FONT_BODY = '仿宋';
  var FONT_LABEL = '黑体';
  var FONT_SONG = '宋体';
  var CONTENT_W = 481.9;              // A4 210mm - 左右各 56.7pt
  var GRID = [78.0, 78.0, 90.0, 235.9];

  var enc = function (s) { return new TextEncoder().encode(s); };
  var tw = function (pt) { return Math.round(pt * 20); };
  var emu = function (pt) { return Math.round(pt * 12700); };
  var hp = function (pt) { return Math.round(pt * 2); };   // 字号：半磅
  var lineTw = function (mult) { return Math.round(240 * mult); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(s || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function fmtCN(d) {
    if (!d) return '';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + Number(n || 0));
    return x;
  }

  function mdd(d) { return d ? pad2(d.getMonth() + 1) + pad2(d.getDate()) : ''; }

  // ---------------- 基础 XML ----------------
  function run(text, o) {
    o = o || {};
    var font = o.font || FONT_BODY;
    var size = o.size || 14;
    var rPr = '<w:rPr>' +
      '<w:rFonts w:ascii="' + esc(font) + '" w:hAnsi="' + esc(font) +
      '" w:eastAsia="' + esc(font) + '" w:cs="' + esc(font) + '"/>' +
      (o.bold ? '<w:b/><w:bCs/>' : '') +
      (o.color ? '<w:color w:val="' + o.color + '"/>' : '') +
      '<w:sz w:val="' + hp(size) + '"/><w:szCs w:val="' + hp(size) + '"/>' +
      (o.spacing ? '<w:spacing w:val="' + Math.round(o.spacing * 20) + '"/>' : '') +
      '</w:rPr>';
    return '<w:r>' + rPr + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r>';
  }

  function pPr(o) {
    o = o || {};
    var x = '<w:pPr>';
    x += '<w:jc w:val="' + (o.align || 'left') + '"/>';
    x += '<w:spacing w:before="' + tw(o.before || 0) + '" w:after="' + tw(o.after || 0) +
      '" w:line="' + lineTw(o.line || 1) + '" w:lineRule="auto"/>';
    if (o.left || o.hanging) {
      x += '<w:ind' + (o.left ? ' w:left="' + tw(o.left) + '"' : '') +
        (o.hanging ? ' w:hanging="' + tw(o.hanging) + '"' : '') + '/>';
    }
    if (o.tabs && o.tabs.length) {
      x += '<w:tabs>' + o.tabs.map(function (pos) {
        return '<w:tab w:val="left" w:pos="' + tw(pos) + '"/>';
      }).join('') + '</w:tabs>';
    }
    if (o.pageBreakBefore) x += '<w:pageBreakBefore/>';
    if (o.keepNext) x += '<w:keepNext/>';
    x += '</w:pPr>';
    return x;
  }

  function tabRun() { return '<w:r><w:tab/></w:r>'; }

  function para(runs, o) {
    return '<w:p>' + pPr(o) + (runs || '') + '</w:p>';
  }

  function table(gridPts, rowsXml, outerSz, innerSz) {
    var width = gridPts.reduce(function (a, b) { return a + b; }, 0);
    function edge(e, sz) {
      return '<w:' + e + ' w:val="' + (sz ? 'single' : 'nil') + '" w:sz="' + (sz || 0) +
        '" w:space="0" w:color="000000"/>';
    }
    var b = '<w:tblBorders>' + edge('top', outerSz) + edge('left', outerSz) +
      edge('bottom', outerSz) + edge('right', outerSz) +
      edge('insideH', innerSz) + edge('insideV', innerSz) + '</w:tblBorders>';
    var grid = '<w:tblGrid>' + gridPts.map(function (p) {
      return '<w:gridCol w:w="' + tw(p) + '"/>';
    }).join('') + '</w:tblGrid>';
    return '<w:tbl><w:tblPr><w:tblW w:w="' + tw(width) + '" w:type="dxa"/>' +
      '<w:jc w:val="center"/><w:tblLayout w:type="fixed"/>' + b +
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/>' +
      '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>' +
      '</w:tblPr>' + grid + rowsXml + '</w:tbl>';
  }

  function cell(contentXml, o) {
    o = o || {};
    var x = '<w:tc><w:tcPr>';
    x += '<w:tcW w:w="' + tw(o.width || CONTENT_W) + '" w:type="dxa"/>';
    if (o.span && o.span > 1) x += '<w:gridSpan w:val="' + o.span + '"/>';
    x += '<w:tcMar>' +
      '<w:top w:w="' + tw(o.mt || 0) + '" w:type="dxa"/>' +
      '<w:left w:w="' + tw(o.ml || 0) + '" w:type="dxa"/>' +
      '<w:bottom w:w="' + tw(o.mb || 0) + '" w:type="dxa"/>' +
      '<w:right w:w="' + tw(o.mr || 0) + '" w:type="dxa"/>' +
      '</w:tcMar>';
    x += '<w:vAlign w:val="' + (o.valign || 'top') + '"/>';
    x += '</w:tcPr>' + (contentXml || para('')) + '</w:tc>';
    return x;
  }

  function row(cellsXml, height) {
    return '<w:tr><w:trPr>' +
      '<w:trHeight w:val="' + tw(height || 20) + '" w:hRule="atLeast"/>' +
      '<w:cantSplit/>' +
      '</w:trPr>' + cellsXml + '</w:tr>';
  }

  // ---------------- 业务内容 ----------------
  function noticeTitle(meta) {
    var d = parseDate(meta.check_date);
    if ((meta.check_type || '').indexOf('专项') >= 0) {
      var subject = (meta.short_unit || meta.unit || '').trim();
      return subject + '关于' + ((meta.special_name || '').trim() || '专项检查') + '整改通知单';
    }
    return mdd(d) + '事故隐患整改通知单';
  }

  function noticeFileName(meta) {
    return noticeTitle(meta) + '.docx';
  }

  function blocks(hazards, requirement) {
    var items = [];
    var extra = [];
    var seen = {};
    hazards.forEach(function (h) {
      String(h.measure || '').split(/\r?\n/).forEach(function (line) {
        line = line.trim();
        if (!line || seen['i' + line]) return;
        seen['i' + line] = 1;
        items.push(line);
      });
    });
    String(requirement || '').split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      if (seen['i' + line] || seen['e' + line]) return;
      seen['e' + line] = 1;
      extra.push(line);
    });
    if (!items.length && !extra.length) {
      if (hazards.length) items.push('按有关安全生产法律法规和标准规范立即整改。');
    }
    var out = items.map(function (t) { return { kind: 'item', text: t }; });
    if (extra.length) {
      if (out.length) out.push({ kind: 'gap', text: '' });
      extra.forEach(function (t) { out.push(out.length ? { kind: 'plain', text: t } : { kind: 'item', text: t }); });
    }
    return out;
  }

  function splitLines(text) {
    return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // 粗估高度（pt）：中文按 1 字宽 = 字号，行高 ≈ 1.39 × 字号 × 行距倍数
  function estLines(text, size, width, lineMult) {
    var per = Math.max(1, Math.floor(width / size));
    var lines = 0;
    String(text || '').split(/\r?\n/).forEach(function (line) {
      lines += Math.max(1, Math.ceil(line.length / per));
    });
    return lines * size * 1.39 * (lineMult || 1);
  }

  function estItems(items, size, width) {
    var h = 0;
    var no = 0;
    var indent = size * 1.6;
    items.forEach(function (it) {
      if (it.kind === 'gap') { h += size * 1.39; return; }
      var text = it.kind === 'item' ? (++no) + '. ' + it.text : it.text;
      h += estLines(text, size, width - indent * 0.6, 1.35) + 2.5;
    });
    return h;
  }

  function sectionCell(label, items, size, minHeight) {
    var out = para(run(label, { font: FONT_LABEL, size: 13 }), { line: 1.2, after: 2 });
    if (!items.length) {
      out += para(run('', { size: size }), { line: 1.35, after: 2.5 });
      out += para(run('', { size: size }), { line: 1.35, after: 2.5 });
    } else {
      var no = 0;
      items.forEach(function (it) {
        if (it.kind === 'gap') {
          out += para(run('', { size: size }), { line: 1, after: 0 });
          return;
        }
        var indent = size * 1.6;
        if (it.kind === 'item') {
          no += 1;
          out += para(run(no + '. ' + it.text, { size: size }),
            { align: 'both', line: 1.35, after: 2.5, left: indent, hanging: indent });
        } else {
          out += para(run(it.text, { size: size }),
            { align: 'both', line: 1.35, after: 2.5, left: indent, hanging: indent });
        }
      });
    }
    return cell(out, { width: CONTENT_W, span: 4, mt: 4, mb: 3, ml: 6, mr: 5, valign: 'top' }) +
      '';
  }

  function imageRun(relId, wPt, hPt, id) {
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + emu(wPt) + '" cy="' + emu(hPt) + '"/>' +
      '<wp:docPr id="' + id + '" name="照片' + id + '"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="p' + id + '.jpg"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emu(wPt) + '" cy="' + emu(hPt) + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  function buildBody(payload) {
    var meta = payload.meta || {};
    var hazards = (payload.hazards || []).filter(function (h) { return String(h.desc || '').trim(); });
    var title = noticeTitle(meta);
    var titleSize = Math.max(14, Math.min(22, CONTENT_W / Math.max(1, title.length) - 1.2));

    var body = para(run(title, { font: FONT_TITLE, size: titleSize, spacing: 1.2 }),
      { align: 'center', line: 1, after: 5, keepNext: true });

    var check = parseDate(meta.check_date);
    var deadline = meta.deadline ? parseDate(meta.deadline)
      : addDays(check || new Date(), meta.deadline_days || 7);

    function labelValue(label, value, height, valueSize) {
      var lc = cell(para(run(label, { font: FONT_LABEL, size: 13 }), { align: 'center', line: 1 }),
        { width: GRID[0] + GRID[1], span: 2, mt: 1.5, mb: 1.5, ml: 5, mr: 5, valign: 'center' });
      var vc = cell(para(run(value || '＿＿＿＿＿＿＿＿＿＿', { size: valueSize || 14 }),
        { align: 'left', line: 1.15, left: 4 }),
        { width: GRID[2] + GRID[3], span: 2, mt: 1.5, mb: 1.5, ml: 5, mr: 5, valign: 'center' });
      return row(lc + vc, height);
    }

    var descs = hazards.map(function (h) { return { kind: 'item', text: String(h.desc).replace(/\r?\n/g, '；') }; });
    var reqBlocks = blocks(hazards, meta.requirement);
    var reqCount = reqBlocks.filter(function (b) { return b.kind !== 'gap'; }).length;
    var descSize = 14;
    var reqSize = reqCount <= 3 ? 14 : (reqCount <= 6 ? 13 : 12);

    var rows = '';
    rows += labelValue('受查单位', meta.unit, 38, (meta.unit || '').length > 26 ? 13 : 14);
    rows += labelValue('检查人', meta.inspectors, 28);
    rows += labelValue('检查时间', fmtCN(check), 28);
    rows += labelValue('检查地点', meta.location, 26);
    rows += row(sectionCell('存在问题', descs, descSize, 100), 100);
    rows += row(sectionCell('检查处理意见（整改要求）', reqBlocks, reqSize, 80), 80);
    rows += labelValue('整改期限', fmtCN(deadline) + '前', 28);
    var opinionLines = splitLines(meta.receiver_opinion);
    var opinion = para(run('受查单位意见', { font: FONT_LABEL, size: 13 }), { line: 1.2, after: 2 });
    opinionLines.forEach(function (line) {
      opinion += para(run(line, { size: 14 }), { align: 'both', line: 1.3, after: 2, left: 28 });
    });

    // 受查单位意见框高度：把落款压在第 1 页底部（同桌面端的“余量补给意见框”）
    var contentH = 714.3;                       // A4 高 - 上下页边距
    var titleH = titleSize * 1.5 + 5;
    var rowsH = 38 + 28 + 28 + 26;
    var descH = Math.max(100, 13 * 1.2 * 1.39 + 2 + estItems(descs, descSize, CONTENT_W - 11) + 7);
    var reqH = Math.max(80, 13 * 1.2 * 1.39 + 2 + estItems(reqBlocks, reqSize, CONTENT_W - 11) + 7);
    var opinionContent = 13 * 1.2 * 1.39 + 2 + (opinionLines.length
      ? opinionLines.reduce(function (a, t) { return a + estLines(t, 14, CONTENT_W - 39, 1.3) + 2; }, 0)
      : 0);
    var sigH = 6 + 2 * 11.5 * 1.3 * 1.39;
    var slack = contentH - (titleH + rowsH + descH + reqH + 28 + sigH + 4 + 50);
    var opinionBox = Math.max(64, Math.min(300, Math.max(opinionContent + 10, slack)));
    rows += row(cell(opinion, { width: CONTENT_W, span: 4, mt: 5, mb: 5, ml: 6, mr: 5, valign: 'top' }), opinionBox);

    body += table(GRID, rows, 10, 6);
    body += para(run(' ', { size: 4 }), { line: 1, after: 0 });

    // 落款：用制表位对齐，避免表格跨页被拆开
    var tabAt = CONTENT_W / 2;
    body += para(
      run('检查单位：' + (meta.issue_unit || ''), { size: 11.5 }) + tabRun() +
      run('签发日期：' + fmtCN(check), { size: 11.5 }),
      { align: 'left', line: 1.3, after: 0, tabs: [tabAt], keepNext: true });
    body += para(
      run('检查人（签字）：', { size: 11.5 }) + tabRun() +
      run('受查单位负责人（签字）：', { size: 11.5 }),
      { align: 'left', line: 1.3, after: 0 });

    // 附件照片页
    var groups = (payload.photos || []).filter(function (g) { return g.items && g.items.length; });
    if (groups.length) {
      var cells = [];
      groups.forEach(function (g) {
        g.items.forEach(function (it, i) {
          cells.push({ seq: g.seq, desc: g.desc, item: it, no: i + 1 });
        });
      });
      var seqNo = 0;
      cells.forEach(function (c) { seqNo += 1; c.caption = seqNo; });
      var rowsN = Math.ceil(cells.length / 2);
      var boxH = Math.max(150, Math.min(220, 620 / rowsN - 40));
      var maxW = CONTENT_W / 2 - 20;
      var half = CONTENT_W / 2;

      body += para(run('附件：整改前照片', { font: FONT_TITLE, size: 18 }),
        { align: 'center', line: 1, after: 2, pageBreakBefore: true });
      body += para(run('受查单位：' + (meta.unit || '＿＿＿＿'), { font: FONT_SONG, size: 8.5, color: '595959' }),
        { align: 'center', line: 1.2, after: 6 });

      var annexRows = '';
      for (var ri = 0; ri < rowsN; ri++) {
        var rowCells = '';
        var used = 0;
        for (var ci = 0; ci < 2; ci++) {
          var idx = ri * 2 + ci;
          if (idx >= cells.length) { rowCells += cell(para(''), { width: half, mt: 1, mb: 1, ml: 1, mr: 1 }); continue; }
          var c2 = cells[idx];
          var aspect = Math.max(0.5, Math.min(2, (c2.item.w || 4) / (c2.item.h || 3)));
          var bw = Math.min(maxW, boxH * aspect);
          var bh = bw / aspect;
          var rel = 'rIdMedia' + c2.item.mediaIndex;
          var content = para(run('隐患 ' + c2.seq + '：' + String(c2.desc || '').slice(0, 42), { font: FONT_LABEL, size: 9 }),
            { align: 'left', line: 1.15, after: 2 });
          content += para(imageRun(rel, bw, bh, 100 + idx), { align: 'center', line: 1, before: 1, after: 0 });
          content += para(run('照片' + c2.caption, { font: FONT_SONG, size: 8, color: '595959' }),
            { align: 'center', line: 1, before: 1, after: 0 });
          rowCells += cell(content, { width: half, mt: 4, mb: 3, ml: 4, mr: 4, valign: 'bottom' });
          used++;
        }
        annexRows += row(rowCells, boxH + 40);
      }
      body += table([half, half], annexRows, 8, 6);
      body += para('', { line: 1, after: 0 });
    }
    return { body: body, title: title };
  }

  function buildPackage(body, title, media) {
    var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<w:body>' + body +
      '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/>' +
      '<w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1134" w:header="300" w:footer="360" w:gutter="0"/>' +
      '<w:cols w:space="425"/><w:docGrid w:linePitch="312"/>' +
      '</w:sectPr></w:body></w:document>';

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="' + FONT_BODY + '" w:hAnsi="' + FONT_BODY + '" w:eastAsia="' + FONT_BODY + '"/>' +
      '<w:sz w:val="21"/><w:szCs w:val="21"/>' +
      '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
      '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>' +
      '</w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '</w:styles>';

    var footer = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
      run('第 ', { font: FONT_SONG, size: 9, color: '595959' }) +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:rFonts w:ascii="' + FONT_SONG + '" w:hAnsi="' + FONT_SONG +
      '" w:eastAsia="' + FONT_SONG + '"/><w:sz w:val="18"/><w:color w:val="595959"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>' +
      run(' 页  共 ', { font: FONT_SONG, size: 9, color: '595959' }) +
      '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:rPr><w:rFonts w:ascii="' + FONT_SONG + '" w:hAnsi="' + FONT_SONG +
      '" w:eastAsia="' + FONT_SONG + '"/><w:sz w:val="18"/><w:color w:val="595959"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple>' +
      run(' 页', { font: FONT_SONG, size: 9, color: '595959' }) +
      '</w:p></w:ftr>';

    var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
      (media || []).map(function (m, i) {
        return '<Relationship Id="rIdMedia' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + (i + 1) + '.jpg"/>';
      }).join('') +
      '</Relationships>';

    var core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(title) + '</dc:title>' +
      '<dc:creator>隐患随手拍</dc:creator>' +
      '<cp:lastModifiedBy>隐患随手拍</cp:lastModifiedBy>' +
      '</cp:coreProperties>';

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>';

    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>';

    var files = [
      { name: '[Content_Types].xml', data: enc(ct) },
      { name: '_rels/.rels', data: enc(rels) },
      { name: 'docProps/core.xml', data: enc(core) },
      { name: 'word/document.xml', data: enc(doc) },
      { name: 'word/styles.xml', data: enc(styles) },
      { name: 'word/footer1.xml', data: enc(footer) },
      { name: 'word/_rels/document.xml.rels', data: enc(docRels) }
    ];
    (media || []).forEach(function (m, i) {
      files.push({ name: 'word/media/image' + (i + 1) + '.jpg', data: m.bytes });
    });
    return global.SnapCore.zipStore(files);
  }

  function buildNotice(payload) {
    payload = payload || {};
    // 给图片编号，供 rel 与 drawing 引用
    var media = [];
    (payload.photos || []).forEach(function (g) {
      (g.items || []).forEach(function (it) {
        it.mediaIndex = media.length;
        media.push({ bytes: it.bytes });
      });
    });
    var built = buildBody(payload);
    return buildPackage(built.body, built.title, media);
  }

  global.SnapDocx = {
    buildNotice: buildNotice,
    noticeTitle: noticeTitle,
    noticeFileName: noticeFileName,
    _internal: { blocks: blocks, fmtCN: fmtCN, parseDate: parseDate, addDays: addDays }
  };
})(typeof window !== 'undefined' ? window : globalThis);
