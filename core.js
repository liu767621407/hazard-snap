/* 隐患随手拍 · 纯逻辑（无 DOM 依赖，便于本地测试）
 * 包含：CRC32、store-only ZIP 打包、base64url 配置编解码、id/文件名工具。
 */
(function (global) {
  'use strict';

  // ---------------- CRC32 ----------------
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------------- ZIP（store，不压缩） ----------------
  function dosDateTime(d) {
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    var date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time, date: date };
  }

  function bytesOf(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (typeof x === 'string') return new TextEncoder().encode(x);
    throw new Error('不支持的内容类型');
  }

  /**
   * files: [{name: string, data: Uint8Array|ArrayBuffer|string, date?: Date}]
   * 返回 ZIP 的字节片段数组（可直接 new Blob(parts)，避免二次大拷贝）。
   */
  function zipParts(files) {
    var enc = new TextEncoder();
    var now = new Date();
    var parts = [];
    var centrals = [];
    var offset = 0;

    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var data = bytesOf(f.data);
      var name = enc.encode(f.name);
      var stamp = dosDateTime(f.date || now);
      var crc = crc32(data);

      var lh = new Uint8Array(30 + name.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      lh.set(name, 30);

      var cd = new Uint8Array(46 + name.length);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);

      parts.push(lh, data);
      centrals.push(cd);
      offset += lh.length + data.length;
    }

    var cdSize = 0;
    for (var j = 0; j < centrals.length; j++) cdSize += centrals[j].length;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return parts.concat(centrals, [eocd]);
  }

  function zipStore(files) {
    var parts = zipParts(files);
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], pos); pos += parts[j].length; }
    return out;
  }

  // ---------------- base64url（UTF-8 安全） ----------------
  function b64urlEncode(text) {
    var bytes = new TextEncoder().encode(String(text));
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(str) {
    var s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------------- 工具 ----------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function makeBatchId(date, rand) {
    var d = date || new Date();
    var suffix = rand || Math.random().toString(36).slice(2, 6);
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + '_' + String(suffix).slice(0, 4);
  }

  function makeHazardId(seq) {
    return 'h-' + ('000' + seq).slice(-4);
  }

  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 40);
  }

  function formatBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isoNow() {
    var d = new Date();
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var hh = pad2(Math.floor(Math.abs(off) / 60));
    var mm = pad2(Math.abs(off) % 60);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
      sign + hh + ':' + mm;
  }

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  global.SnapCore = {
    crc32: crc32,
    zipParts: zipParts,
    zipStore: zipStore,
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    makeBatchId: makeBatchId,
    makeHazardId: makeHazardId,
    safeName: safeName,
    formatBytes: formatBytes,
    escapeHtml: escapeHtml,
    isoNow: isoNow,
    todayStr: todayStr
  };
})(typeof window !== 'undefined' ? window : globalThis);
