(function () {
  'use strict';
  var C = window.SnapCore;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- 状态 ----------------
  var WEB_VERSION = '3.1.0';
  var state = {
    cfg: null, batch: null, photos: [], editing: null,
    selecting: false, selected: {}
  };
  var pendingQuick = false;
  var pendingCk = null;
  var lastTap = { id: '', t: 0 };
  var quickTimer = null;
  var checkSel = {};
  var histMode = false;
  var backTo = null;

  function hasUpdateBridge() {
    try { return !!(window.SnapAndroid && window.SnapAndroid.checkUpdate); } catch (e) { return false; }
  }

  function versionText() {
    var app = '';
    try {
      if (window.SnapAndroid && window.SnapAndroid.appVersion) {
        app = 'App ' + window.SnapAndroid.appVersion() + ' · ';
      }
    } catch (e) {}
    return app + '网页 ' + WEB_VERSION;
  }

  function defaultCfg() {
    return { unit: '', short_unit: '', issue_unit: '', inspectors: '', location: '',
             check_type: '一般检查', special_name: '', deadline_days: 7 };
  }

  function loadCfg() {
    try {
      var raw = localStorage.getItem('snap.cfg');
      if (raw) return Object.assign(defaultCfg(), JSON.parse(raw));
    } catch (e) {}
    return defaultCfg();
  }

  function saveCfg(cfg) {
    state.cfg = Object.assign(defaultCfg(), cfg || {});
    try { localStorage.setItem('snap.cfg', JSON.stringify(state.cfg)); } catch (e) {}
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  function setLoading(on, text) {
    var el = $('loading');
    if (on) { el.textContent = text || '处理中…'; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }

  // ---------------- IndexedDB ----------------
  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('hazard-snap', 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) {
          var s = db.createObjectStore('photos', { keyPath: 'key' });
          s.createIndex('byBatch', 'batchId');
          s.createIndex('byHazard', 'hazardId');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function store(name, mode) {
    return openDB().then(function (db) { return db.transaction(name, mode || 'readonly').objectStore(name); });
  }

  function reqP(req) {
    return new Promise(function (res, rej) {
      req.onsuccess = function () { res(req.result); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function dbGet(name, key) { return store(name).then(function (s) { return reqP(s.get(key)); }); }
  function dbPut(name, val) { return store(name, 'readwrite').then(function (s) { return reqP(s.put(val)); }); }
  function dbDel(name, key) { return store(name, 'readwrite').then(function (s) { return reqP(s.delete(key)); }); }
  function dbIndex(name, idx, key) {
    return store(name).then(function (s) { return reqP(s.index(idx).getAll(key)); });
  }
  function dbAll(name) { return store(name).then(function (s) { return reqP(s.getAll()); }); }

  // ---------------- 批次 ----------------
  function newBatchMeta(cfg) {
    var now = new Date();
    return {
      id: C.makeBatchId(now),
      created: C.isoNow(),
      updated: C.isoNow(),
      exported_at: '',
      meta: {
        name: cfg.name || '',
        check_date: C.todayStr(now),
        unit: cfg.unit || '',
        short_unit: cfg.short_unit || '',
        issue_unit: cfg.issue_unit || '',
        inspectors: cfg.inspectors || '',
        location: cfg.location || '',
        check_type: cfg.check_type || '一般检查',
        special_name: cfg.special_name || '',
        deadline_days: Number(cfg.deadline_days) || 7,
        requirement: '',
        receiver_opinion: ''
      },
      hazards: [],
      checklist: { answers: {} }
    };
  }

  function saveBatch() {
    state.batch.updated = C.isoNow();
    return dbPut('batches', state.batch);
  }

  function nextHazardId(batch) {
    var max = 0;
    batch.hazards.forEach(function (h) {
      var m = /^h-(\d+)$/.exec(h.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    var id = C.makeHazardId(max + 1);
    while (batch.hazards.some(function (h) { return h.id === id; })) {
      max += 1;
      id = C.makeHazardId(max + 1);
    }
    return id;
  }

  function hazardById(id) {
    return state.batch.hazards.filter(function (h) { return h.id === id; })[0] || null;
  }

  function photosOf(hazardId, phase) {
    return state.photos.filter(function (p) {
      return p.hazardId === hazardId && (!phase || p.phase === phase);
    }).sort(function (a, b) { return a.order - b.order; });
  }

  async function refreshPhotos() {
    state.photos = await dbIndex('photos', 'byBatch', state.batch.id);
  }

  // ---------------- 图片压缩 ----------------
  function loadImage(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { res({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('照片无法解码')); };
      img.src = url;
    });
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise(function (res) { canvas.toBlob(function (b) { res(b); }, type, quality); });
  }

  async function sha1Hex(buf) {
    if (!(window.crypto && crypto.subtle)) return '';
    var digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.prototype.map.call(new Uint8Array(digest), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  async function compressImage(file) {
    var src = null, w = 0, h = 0, cleanup = null;
    if (window.createImageBitmap) {
      try {
        src = await createImageBitmap(file, { imageOrientation: 'from-image' });
        w = src.width; h = src.height;
      } catch (e) { src = null; }
    }
    if (!src) {
      var loaded = await loadImage(file);
      src = loaded.img; w = src.naturalWidth; h = src.naturalHeight;
      cleanup = function () { URL.revokeObjectURL(loaded.url); };
    }
    var max = 2560;
    var scale = Math.min(1, max / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);
    var blob = await canvasBlob(canvas, 'image/jpeg', 0.88);
    if (cleanup) cleanup();
    if (src.close) src.close();

    // 4:3 缩略图（白底居中）
    var tc = document.createElement('canvas');
    tc.width = 320; tc.height = 240;
    var tctx = tc.getContext('2d');
    tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, 320, 240);
    var s2 = Math.min(320 / cw, 240 / ch);
    var tw = Math.round(cw * s2), th = Math.round(ch * s2);
    tctx.drawImage(canvas, (320 - tw) / 2, (240 - th) / 2, tw, th);
    var thumb = await canvasBlob(tc, 'image/jpeg', 0.75);

    var buf = await blob.arrayBuffer();
    return { blob: blob, thumb: thumb, w: cw, h: ch, bytes: blob.size, sha1: await sha1Hex(buf) };
  }

  async function addPhotos(files) {
    if (!state.editing) { toast('请先打开一条隐患再添加照片'); return; }
    var ed = state.editing;
    var existing = photosOf(ed.hazardId, ed.phase);
    var have = existing.length;
    var maxOrder = existing.reduce(function (m, p) { return Math.max(m, p.order || 0); }, 0);
    var room = 6 - have;
    if (room <= 0) { toast('这条隐患已有 6 张照片'); return; }
    var list = Array.prototype.slice.call(files, 0, room);
    if (list.length < files.length) toast('每条最多 6 张，多出的已忽略');
    var seen = {};
    existing.forEach(function (p) { if (p.sha1) seen[p.sha1] = 1; });
    var added = 0;
    for (var i = 0; i < list.length; i++) {
      setLoading(true, '处理照片 ' + (i + 1) + '/' + list.length + '…');
      try {
        var c = await compressImage(list[i]);
        if (c.sha1 && seen[c.sha1]) { toast('这张照片已经在里面了'); continue; }
        if (c.sha1) seen[c.sha1] = 1;
        added += 1;
        var order = maxOrder + added;
        var rec = {
          key: ed.hazardId + ':' + ed.phase + ':' + order,
          batchId: state.batch.id, hazardId: ed.hazardId, phase: ed.phase, order: order,
          blob: c.blob, thumb: c.thumb, w: c.w, h: c.h, bytes: c.bytes, sha1: c.sha1,
          createdAt: C.isoNow()
        };
        await dbPut('photos', rec);
        state.photos.push(rec);
      } catch (e) {
        toast('照片处理失败：' + (e.message || e));
      }
    }
    setLoading(false);
    renderPhotos();
  }

  async function deletePhoto(rec) {
    if (!confirm('删除这张照片？')) return;
    await dbDel('photos', rec.key);
    state.photos = state.photos.filter(function (p) { return p.key !== rec.key; });
    renderPhotos();
  }

  // ---------------- 渲染 ----------------
  var urls = [];
  function revokeUrls() {
    urls.forEach(function (u) { URL.revokeObjectURL(u); });
    urls = [];
  }

  function photoUrl(blob) {
    var u = URL.createObjectURL(blob);
    urls.push(u);
    return u;
  }

  function renderHeader() {
    var cfg = state.cfg;
    $('hdrUnit').textContent = (state.batch && state.batch.meta.unit) || cfg.unit || '未设置单位';
    var b0 = state.batch;
    var nm = b0 ? (b0.meta.name || '').trim() : '';
    $('hdrDate').textContent = b0 ? ((nm || b0.meta.check_date) + ' · ' + b0.hazards.length + ' 条') : '';
  }

  function renderHome() {
    revokeUrls();
    var list = $('hazardList');
    var batch = state.batch;
    list.innerHTML = '';
    $('emptyHome').classList.toggle('hidden', batch.hazards.length > 0);
    $('selBar').classList.toggle('hidden', !state.selecting);
    $('btnManage').classList.toggle('hidden', state.selecting);
    document.querySelector('.fabbar').classList.toggle('hidden', state.selecting);
    var cst = ckStats();
    $('ckEntrySub').textContent = '已检 ' + cst.done + '/' + cst.total + ' · 不符合 ' + cst.ng;
    if (!isChecklistBatch(state.batch) && cst.done === 0) {
      $('ckEntrySub').textContent = '清单化检查 · 未开始';
    }
    $('ckEntryBar').style.width = (cst.total ? Math.round(cst.done / cst.total * 100) : 0) + '%';
    batch.hazards.forEach(function (h, idx) {
      var ph = photosOf(h.id).sort(function (a, b) { return a.phase === b.phase ? a.order - b.order : (a.phase === 'before' ? -1 : 1); });
      var before = photosOf(h.id, 'before').length;
      var after = photosOf(h.id, 'after').length;
      var el = document.createElement('div');
      el.className = 'card' + (state.selected[h.id] ? ' sel' : '');
      var thumb = ph.length ? photoUrl(ph[0].thumb) : '';
      var check = state.selecting
        ? '<div class="check">' + (state.selected[h.id] ? '✓' : '') + '</div>' : '';
      var hasCkText = !!(h.tag && h.tag.type === 'checklist' && h.tag.text);
      var descShown = h.desc || (hasCkText ? h.tag.text : '未填写，点击补充');
      var descEmpty = !h.desc && !hasCkText;
      el.innerHTML = check +
        '<div class="thumb" style="' + (thumb ? "background-image:url('" + thumb + "')" : '') + '">' +
          (thumb ? '' : '<div class="nophoto">无照片</div>') +
        '</div>' +
        '<div class="info">' +
          '<div class="desc' + (descEmpty ? ' empty' : '') + '">' + C.escapeHtml(descShown) + '</div>' +
          '<div class="meta">' +
            '<span class="chip">' + (idx + 1) + '</span>' +
            '<span class="chip ' + (h.level === '重大' ? 'warn' : '') + '">' + C.escapeHtml(h.level || '一般') + '</span>' +
            (h.tag && h.tag.type === 'checklist' ? '<span class="chip ck">189·' + h.tag.no + '</span>' : '') +
            (h.measure ? '<span class="chip after">已填措施</span>' : '') +
            '<span>前 ' + before + ' 张</span>' +
            (after ? '<span class="chip after">后 ' + after + ' 张</span>' : '') +
          '</div>' +
          (h.location ? '<div class="meta">' + C.escapeHtml(h.location) + '</div>' : '') +
        '</div>' +
        (state.selecting ? '' : '<div class="arrow">›</div>');
      el.addEventListener('click', function () {
        if (state.selecting) { toggleSelected(h.id); } else { openEdit(h.id); }
      });
      list.appendChild(el);
    });

    var n = batch.hazards.filter(function (h) { return h.desc.trim() || photosOf(h.id).length; }).length;
    var photos = state.photos.length;
    var bytes = state.photos.reduce(function (s, p) { return s + (p.bytes || 0); }, 0);
    $('statCount').textContent = n;
    $('statPhotos').textContent = photos;
    $('statSize').textContent = C.formatBytes(bytes);
    updateSelCount();
    renderHeader();
  }

  // ---------------- 管理（多选 / 批量删除） ----------------
  function setSelecting(on) {
    state.selecting = !!on;
    state.selected = {};
    renderHome();
  }

  function toggleSelected(id) {
    if (state.selected[id]) delete state.selected[id];
    else state.selected[id] = true;
    renderHome();
  }

  function selectedIds() {
    return Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
  }

  function updateSelCount() {
    var n = selectedIds().length;
    $('selCount').textContent = '已选 ' + n + ' 条';
    $('btnSelDelete').disabled = n === 0;
  }

  function selectAllToggle() {
    var ids = state.batch.hazards.map(function (h) { return h.id; });
    var all = ids.length > 0 && ids.every(function (id) { return state.selected[id]; });
    state.selected = {};
    if (!all) ids.forEach(function (id) { state.selected[id] = true; });
    renderHome();
  }

  async function deleteSelected() {
    var ids = selectedIds();
    if (!ids.length) return;
    if (!confirm('删除选中的 ' + ids.length + ' 条隐患及其照片？')) return;
    var keep = [];
    for (var i = 0; i < state.batch.hazards.length; i++) {
      var h = state.batch.hazards[i];
      if (selectedIds().indexOf(h.id) < 0) { keep.push(h); continue; }
      var recs = photosOf(h.id);
      for (var j = 0; j < recs.length; j++) { await dbDel('photos', recs[j].key); }
      state.photos = state.photos.filter(function (p) { return p.hazardId !== h.id; });
    }
    state.batch.hazards = keep;
    await saveBatch();
    setSelecting(false);
    toast('已删除 ' + ids.length + ' 条');
  }

  function renderPhotos() {
    var ed = state.editing;
    if (!ed) return;
    var grid = $('photoGrid');
    grid.innerHTML = '';
    var list = photosOf(ed.hazardId, ed.phase);
    list.forEach(function (rec, i) {
      var el = document.createElement('div');
      el.className = 'photo';
      el.style.backgroundImage = "url('" + photoUrl(rec.thumb) + "')";
      var del = document.createElement('div');
      del.className = 'del';
      del.textContent = '×';
      del.addEventListener('click', function (e) { e.stopPropagation(); deletePhoto(rec); });
      el.appendChild(del);
      grid.appendChild(el);
    });
    if (list.length < 6) {
      var add = document.createElement('div');
      add.className = 'photo add';
      add.textContent = '＋';
      add.addEventListener('click', function () { $('fileCamera').click(); });
      grid.appendChild(add);
    }
    $('photoHint').textContent = list.length + ' / 6 张 · 横拍 4:3 最合适，竖拍在文书里会左右留白';
  }

  var DESC_PH = '例：压榨房遥控器缺少保护套，易造成误操作和损坏。\n可点输入法上的麦克风直接用语音输入。';

  function updateCkBlock(h) {
    var isCk = !!(h && h.tag && h.tag.type === 'checklist');
    $('ckQSection').classList.toggle('hidden', !isCk);
    if (isCk) {
      $('ckQTitle').textContent = '检查内容（189 条 · 第 ' + h.tag.no + ' 条' +
        (h.tag.group ? ' · ' + h.tag.group : '') + '）';
      $('ckQText').textContent = h.tag.text || '';
      $('inDesc').placeholder = '';
    } else {
      $('inDesc').placeholder = DESC_PH;
    }
  }

  function fillEditForm(h) {
    $('inDesc').value = h.desc || '';
    $('inMeasure').value = h.measure || '';
    $('inLocation').value = h.location || '';
    $('inResp').value = h.responsible || '';
    var level = h.level || '一般';
    Array.prototype.forEach.call($('segLevel').children, function (b) {
      b.classList.toggle('on', b.dataset.level === level);
    });
    var opts = (state.cfg.locations || []).slice();
    var base = (state.batch.meta.location || '').trim();
    if (base && opts.indexOf(base) < 0) opts.unshift(base);
    state.batch.hazards.forEach(function (x) { if (x.location && opts.indexOf(x.location) < 0) opts.push(x.location); });
    $('locationList').innerHTML = opts.slice(0, 12).map(function (t) {
      return '<option value="' + C.escapeHtml(t) + '"></option>';
    }).join('');
  }

  function updatePhaseUI() {
    var after = !!(state.editing && state.editing.phase === 'after');
    $('editFields').classList.toggle('hidden', after);
    $('afterHint').classList.toggle('hidden', !after);
    $('btnSaveNext').classList.toggle('hidden', after);
  }

  function openEdit(hazardId) {
    var h = hazardById(hazardId);
    if (!h) return;
    pendingQuick = false;
    pendingCk = null;
    state.editing = { hazardId: hazardId, phase: 'before' };
    var idx = state.batch.hazards.indexOf(h) + 1;
    $('editTitle').textContent = '隐患 ' + idx;
    $('editSub').textContent = (state.batch.meta.short_unit || state.batch.meta.unit || '') + ' · ' + state.batch.meta.check_date;
    $('phaseTabs').classList.remove('hidden');
    Array.prototype.forEach.call($('phaseTabs').children, function (b) {
      b.classList.toggle('on', b.dataset.phase === 'before');
    });
    fillEditForm(h);
    updateCkBlock(h);
    updatePhaseUI();
    renderPhotos();
    showView('edit');
  }

  async function startNew() {
    var batch = state.batch;
    pendingQuick = false;
    pendingCk = null;
    var id = nextHazardId(batch);
    var h = {
      id: id, seq: batch.hazards.length + 1, desc: '', measure: '', location: '',
      level: '一般', responsible: '', created: C.isoNow()
    };
    batch.hazards.push(h);
    await saveBatch();
    state.editing = { hazardId: id, phase: 'before' };
    $('editTitle').textContent = '新隐患';
    $('editSub').textContent = (batch.meta.short_unit || batch.meta.unit || '') + ' · ' + batch.meta.check_date;
    $('phaseTabs').classList.add('hidden');
    fillEditForm(h);
    updateCkBlock(h);
    updatePhaseUI();
    renderPhotos();
    showView('edit');
    setTimeout(function () { $('inDesc').focus(); }, 250);
  }

  // 首页「📷 拍照」：直接开相机，拍完就存一条（不写描述也能存）
  function quickCapture() {
    if (!state.batch) return;
    pendingQuick = true;
    clearTimeout(quickTimer);
    quickTimer = setTimeout(function () { pendingQuick = false; }, 120000);
    $('fileCamera').click();
  }

  async function createHazardWithPhotos(files) {
    var batch = state.batch;
    var id = nextHazardId(batch);
    var h = {
      id: id, seq: batch.hazards.length + 1, desc: '', measure: '', location: '',
      level: '一般', responsible: '', created: C.isoNow()
    };
    batch.hazards.push(h);
    await saveBatch();
    state.editing = { hazardId: id, phase: 'before' };
    try {
      await addPhotos(files);
    } finally {
      state.editing = null;
    }
    showView('home');
    toast('照片已存，点这一条补描述即可');
  }

  // 清单项拍照 → 生成带“189条”标签的隐患随手拍记录
  async function createChecklistHazard(itemId, files) {
    var item = null, gname = '';
    CK_GROUPS.forEach(function (g) {
      g.items.forEach(function (it) {
        if (it.id === itemId) { item = it; gname = g.name; }
      });
    });
    if (!item) return;
    var batch = state.batch;
    var hid = nextHazardId(batch);
    var h = {
      id: hid, seq: batch.hazards.length + 1,
      desc: '',
      measure: '', location: gname, level: '一般', responsible: '',
      created: C.isoNow(),
      tag: { type: 'checklist', no: item.no, group: gname, text: item.text }
    };
    batch.hazards.push(h);
    var a = ckAnswers();
    a[item.id] = a[item.id] || { r: '', note: '' };
    if (a[item.id].r !== 'ok') a[item.id].r = 'ng';
    await saveBatch();
    state.editing = { hazardId: hid, phase: 'before' };
    try {
      await addPhotos(files);
    } finally {
      state.editing = null;
    }
    await saveBatch();
    renderChecklist();
    toast('已生成隐患记录（189·' + item.no + '）');
  }

  function ckPhotoRecs(no) {
    var out = [];
    (state.batch.hazards || []).forEach(function (h) {
      if (!(h.tag && h.tag.type === 'checklist' && h.tag.no === no)) return;
      state.photos.filter(function (p) { return p.hazardId === h.id; })
        .sort(function (x, y) {
          return (x.phase === y.phase) ? (x.order - y.order) : (x.phase === 'before' ? -1 : 1);
        })
        .forEach(function (p) { out.push(p); });
    });
    return out.slice(0, 3);
  }

  async function ckPhotoDataUrl(rec) {
    try {
      var bmp = await createImageBitmap(rec.blob);
      var max = 720;
      var scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      return c.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      return '';
    }
  }

  async function exportChecklistRecord() {
    var a = ckAnswers();
    var st = ckStats();
    var m = state.batch.meta;
    var title = (m.name || '').trim() || ('检查清单 ' + (m.check_date || ''));
    setLoading(true, '正在生成检查清单…');
    try {
      var rows = '';
      for (var gi = 0; gi < CK_GROUPS.length; gi++) {
        var g = CK_GROUPS[gi];
        for (var ii = 0; ii < g.items.length; ii++) {
          var it = g.items[ii];
          var ans = a[it.id] || {};
          var r = ans.r || '';
          var note = (ans.note || '').trim();
          var txt = r === 'ok' ? '合格' : (r === 'ng' ? '不符合' : '未检');
          var pics = ckPhotoRecs(it.no);
          var urls = [];
          for (var pi = 0; pi < pics.length; pi++) {
            var du = await ckPhotoDataUrl(pics[pi]);
            if (du) urls.push(du);
          }
          var imgHtml = '';
          if (urls.length) {
            var wcm = urls.length === 1 ? 5.6 : (urls.length === 2 ? 3.2 : 2.2);
            var wpx = Math.round(wcm * 37.795);
            var hpx = Math.round(wpx * 0.75);
            imgHtml = '<div class="phs">' + urls.map(function (u, ui) {
              return (ui ? '&nbsp;&nbsp;' : '') +
                '<img src="' + u + '" width="' + wpx + '" height="' + hpx +
                '" style="width:' + wcm + 'cm;height:' + (Math.round(wcm * 75) / 100) + 'cm">';
            }).join('') + '</div>';
          }
          var cell = imgHtml + (note ? '<div class="note">' + C.escapeHtml(note) + '</div>' : '');
          if (!cell) cell = '<div class="none">—</div>';
          var isNg = r === 'ng';
          rows += '<tr' + (isNg ? ' class="ngrow"' : '') + '>' +
            '<td class="c">' + it.no + '</td>' +
            '<td>' + C.escapeHtml(g.name) + '</td>' +
            '<td>' + C.escapeHtml(it.text) + '</td>' +
            '<td class="c res' + (isNg ? ' ng' : '') + '">' + txt + '</td>' +
            '<td class="phcell">' + cell + '</td></tr>';
        }
      }
      var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8">' +
        '<style>' +
        '@page{size:A4;margin:1.3cm}' +
        'body{font-family:"宋体",SimSun;font-size:9pt;color:#000}' +
        'h1{font-family:"黑体",SimHei;font-size:15pt;text-align:center;margin:0 0 8pt}' +
        '.meta{font-size:9pt;margin:3pt 0;line-height:1.5}' +
        'table{border-collapse:collapse;width:100%;table-layout:fixed}' +
        'th,td{border:1px solid #444;padding:3pt 4pt;vertical-align:top;word-wrap:break-word}' +
        'th{background:#DCE6F1;font-family:"黑体",SimHei;text-align:center;font-weight:bold}' +
        'tr{page-break-inside:avoid}' +
        '.c{text-align:center}' +
        '.res{font-size:9pt}' +
        '.res.ng{background:#F5B7B1;color:#C00000;font-weight:bold;font-size:10pt}' +
        'tr.ngrow td{background:#FDECEC}' +
        'tr.ngrow td.res.ng{background:#F5B7B1}' +
        '.ph{margin:0 0 3pt}' +
        '.phs{margin:0 0 3pt;line-height:normal;white-space:nowrap}' +
        '.phs img{display:inline;margin:0 6pt 3pt 0;border:1px solid #bbb;vertical-align:top}' +
        '.note{color:#B91C1C;font-weight:bold;line-height:1.4}' +
        '.none{color:#999;text-align:center}' +
        '</style></head><body>' +
        '<h1>189 条清单检查记录</h1>' +
        '<div class="meta">检查名称：' + C.escapeHtml(title) + '　　受查单位：' + C.escapeHtml(m.unit || '') +
        (m.short_unit ? '（' + C.escapeHtml(m.short_unit) + '）' : '') + '</div>' +
        '<div class="meta">检查日期：' + C.escapeHtml(m.check_date || '') + '　　检查人：' + C.escapeHtml(m.inspectors || '') +
        '　　检查地点：' + C.escapeHtml(m.location || '') + '</div>' +
        '<div class="meta">检查项：' + st.total + '　已检：' + st.done + '　合格：' + st.ok + '　不符合：' + st.ng +
        '　未检：' + (st.total - st.done) + '　（不符合项以红底标识）</div>' +
        '<table><thead><tr>' +
        '<th style="width:7%">序号</th><th style="width:12%">区域</th><th style="width:33%">检查内容</th>' +
        '<th style="width:9%">结果</th><th style="width:39%">图片及问题描述</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div class="meta">导出时间：' + C.isoNow().replace('T', ' ') + '</div>' +
        '</body></html>';
      var safe = String(m.short_unit || m.unit || '检查').replace(/[\\/:*?"<>|]/g, '_');
      var name = '189条清单_' + safe + '_' + (m.check_date || '') + '.doc';
      var bytes = new TextEncoder().encode('\ufeff' + html);
      await shareBytes(bytes, name, 'application/msword');
      toast('已生成 ' + name);
    } finally {
      setLoading(false);
    }
  }

  function showView(name) {
    document.body.dataset.view = name;
    $('viewEdit').classList.toggle('hidden', name !== 'edit');
    $('viewSettings').classList.toggle('hidden', name !== 'settings');
    $('viewExport').classList.toggle('hidden', name !== 'export');
    $('viewChecklist').classList.toggle('hidden', name !== 'checklist');
    $('topbar').classList.toggle('hidden', name !== 'home');
    document.querySelector('.fabbar').classList.toggle('hidden', name !== 'home' || state.selecting);
    // Chrome/PWA：用 history 让系统返回键回到上一级（APK 里走 SnapBack，不重复记历史）
    if (!window.SnapAndroid && name !== 'home' && state.batch) {
      try { history.pushState({ snapView: name }, ''); } catch (e) {}
    }
    if (name === 'home') renderHome();
  }

  // Chrome/PWA 的返回键
  window.addEventListener('popstate', function () {
    var v = document.body.dataset.view;
    if (v === 'home' || !state.batch) return;
    if (v === 'edit') { $('btnBack').click(); return; }
    goUp();
  });

  // ---------------- 保存 ----------------
  function readForm() {
    if (!state.editing) return null;
    var h = hazardById(state.editing.hazardId);
    if (!h) return null;
    h.desc = $('inDesc').value.trim();
    h.measure = $('inMeasure').value.trim();
    h.location = $('inLocation').value.trim();
    h.responsible = $('inResp').value.trim();
    var on = $('segLevel').querySelector('.on');
    h.level = on ? on.dataset.level : '一般';
    return h;
  }

  async function saveEdit(next) {
    if (!state.editing) { toast('这条隐患已不在编辑状态，请重新打开'); showView('home'); return; }
    var after = !!(state.editing && state.editing.phase === 'after');
    var h = after ? hazardById(state.editing.hazardId) : readForm();
    if (!h) return;
    var photos = photosOf(h.id).length;
    if (!after && !h.desc && !photos && !h.measure && !h.location && !h.responsible) {
      // 什么都没有的条目直接丢弃
      state.batch.hazards = state.batch.hazards.filter(function (x) { return x.id !== h.id; });
      await saveBatch();
      toast('已放弃空白条目');
      showView('home');
      return;
    }
    await saveBatch();
    backTo = null;
    if (next && !after) {
      // 保存后继续给“当前这条隐患”加照片，不新建隐患
      toast('已保存，继续给这条拍照');
      $('fileCamera').click();
    } else {
      showView('home');
      toast(after ? '整改后照片已保存' : '已保存');
    }
  }

  // ---------------- 导出 ----------------
  async function buildZip() {
    var batch = state.batch;
    var photos = await dbIndex('photos', 'byBatch', batch.id);
    var byH = {};
    photos.forEach(function (p) { (byH[p.hazardId] = byH[p.hazardId] || []).push(p); });
    var files = [];
    var payload = {
      schema: 'hazard-snap/1',
      exported_at: C.isoNow(),
      batch: {
        id: batch.id, created: batch.created, check_date: batch.meta.check_date,
        name: batch.meta.name || '',
        unit: batch.meta.unit, short_unit: batch.meta.short_unit,
        issue_unit: batch.meta.issue_unit, inspectors: batch.meta.inspectors,
        location: batch.meta.location, check_type: batch.meta.check_type,
        special_name: batch.meta.special_name, deadline_days: batch.meta.deadline_days,
        requirement: batch.meta.requirement || '',
        receiver_opinion: batch.meta.receiver_opinion || ''
      },
      hazards: []
    };
    if (batch.checklist && batch.checklist.answers) {
      var ckItems = [];
      CK_FLAT.forEach(function (it) {
        var ans = batch.checklist.answers[it.id];
        if (!ans || (!ans.r && !ans.note)) return;
        var gname = '';
        CK_GROUPS.forEach(function (g) {
          if (g.items.indexOf(it) >= 0) gname = g.name;
        });
        ckItems.push({ no: it.no, group: gname, text: it.text, result: ans.r || '', note: ans.note || '' });
      });
      payload.checklist = {
        total: CK_FLAT.length,
        answered: ckItems.length,
        ok: ckItems.filter(function (x) { return x.result === 'ok'; }).length,
        ng: ckItems.filter(function (x) { return x.result === 'ng'; }).length,
        items: ckItems
      };
    }
    var hazards = batch.hazards.slice().sort(function (a, b) { return a.seq - b.seq; });
    for (var i = 0; i < hazards.length; i++) {
      var h = hazards[i];
      var recs = (byH[h.id] || []).slice().sort(function (a, b) {
        return a.phase === b.phase ? a.order - b.order : (a.phase === 'before' ? -1 : 1);
      });
      var item = {
        id: h.id, seq: h.seq, desc: h.desc, measure: h.measure || '',
        location: h.location, level: h.level,
        responsible: h.responsible, created: h.created, tag: h.tag || null, photos: []
      };
      var counter = { before: 0, after: 0 };
      for (var j = 0; j < recs.length; j++) {
        var p = recs[j];
        counter[p.phase] = (counter[p.phase] || 0) + 1;
        var nn = ('0' + counter[p.phase]).slice(-2);
        var rel = 'photos/' + h.id + '/' + p.phase + '-' + nn + '.jpg';
        var trel = 'thumbs/' + h.id + '/' + p.phase + '-' + nn + '.jpg';
        item.photos.push({ phase: p.phase, file: rel, w: p.w, h: p.h, bytes: p.bytes, sha1: p.sha1 });
        files.push({ name: rel, data: new Uint8Array(await p.blob.arrayBuffer()) });
        if (p.thumb) files.push({ name: trel, data: new Uint8Array(await p.thumb.arrayBuffer()) });
      }
      payload.hazards.push(item);
    }
    files.unshift({ name: 'batch.json', data: JSON.stringify(payload, null, 2) });
    return { parts: C.zipParts(files), count: payload.hazards.length, photos: photos.length };
  }

  function blobToBase64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  async function shareBytes(data, name, mime) {
    var blob = (data instanceof Blob) ? data : new Blob([data], { type: mime });
    if (window.SnapAndroid && window.SnapAndroid.shareFile) {
      try {
        window.SnapAndroid.shareFile(name, mime, await blobToBase64(blob));
        return;
      } catch (e) { console.warn('原生分享失败', e); }
    }
    var file = null;
    try { file = new File([blob], name, { type: mime }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { /* 用户取消 */ }
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  async function exportBatch() {
    if (!state.batch.hazards.length) { toast('还没有隐患可导出'); return; }
    setLoading(true, '正在打包…');
    try {
      var out = await buildZip();
      var short = C.safeName(state.batch.meta.short_unit || state.batch.meta.unit || '随手拍');
      var fname = '随手拍_' + state.batch.meta.check_date.replace(/-/g, '') + '_' + short + '.zip';
      var blob = new Blob(out.parts, { type: 'application/zip' });
      setLoading(false);
      await shareBytes(blob, fname, 'application/zip');
      markExported();
      toast('已导出 ' + fname + '（' + C.formatBytes(blob.size) + '）');
    } catch (e) {
      setLoading(false);
      toast('导出失败：' + (e.message || e));
    }
  }

  async function buildNoticePayload() {
    var batch = state.batch;
    var hazards = batch.hazards.filter(function (h) { return (h.desc || '').trim(); });
    var photos = [];
    for (var i = 0; i < hazards.length; i++) {
      var h = hazards[i];
      var recs = photosOf(h.id, 'before');
      if (!recs.length) continue;
      var items = [];
      for (var j = 0; j < recs.length; j++) {
        var buf = await recs[j].blob.arrayBuffer();
        items.push({ bytes: new Uint8Array(buf), w: recs[j].w, h: recs[j].h });
      }
      photos.push({ seq: i + 1, desc: h.desc, items: items });
    }
    return {
      meta: batch.meta,
      hazards: hazards.map(function (h, i) {
        return { seq: i + 1, desc: h.desc, measure: h.measure || '' };
      }),
      photos: photos
    };
  }

  function confirmNoDesc() {
    var n = state.batch.hazards.filter(function (h) { return !(h.desc || '').trim(); }).length;
    if (!n) return true;
    return confirm(n + ' 条只有照片、没写描述，不会进通知单。继续导出？');
  }

  async function exportNotice() {
    var hazards = state.batch.hazards.filter(function (h) { return (h.desc || '').trim(); });
    if (!hazards.length) { toast('还没有写描述的隐患，无法生成通知单'); return; }
    if (!(state.batch.meta.unit || '').trim()) {
      toast('请先填写受查单位');
      backTo = 'export';
      openSetup();
      return;
    }
    if (!confirmNoDesc()) return;
    setLoading(true, '正在生成通知单…');
    try {
      var payload = await buildNoticePayload();
      var bytes = window.SnapDocx.buildNotice(payload);
      var name = window.SnapDocx.noticeFileName(payload.meta);
      setLoading(false);
      await shareBytes(bytes, name,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      toast('已生成 ' + name);
    } catch (e) {
      setLoading(false);
      console.error(e);
      toast('生成失败：' + (e.message || e));
    }
  }

  async function exportPdf() {
    var hazards = state.batch.hazards.filter(function (h) { return (h.desc || '').trim(); });
    if (!hazards.length) { toast('还没有写描述的隐患，无法生成通知单'); return; }
    if (!(state.batch.meta.unit || '').trim()) {
      toast('请先填写受查单位');
      backTo = 'export';
      openSetup();
      return;
    }
    if (!confirmNoDesc()) return;
    setLoading(true, '正在生成 PDF…');
    try {
      var payload = await buildNoticePayload();
      var bytes = await window.SnapPdf.buildNoticePdf(payload);
      var name = window.SnapDocx.noticeFileName(payload.meta).replace(/\.docx$/i, '.pdf');
      setLoading(false);
      await shareBytes(bytes, name, 'application/pdf');
      toast('已生成 ' + name + '（' + C.formatBytes(bytes.length) + '）');
    } catch (e) {
      setLoading(false);
      console.error(e);
      toast('PDF 生成失败：' + (e.message || e));
    }
  }

  function openExport() {
    var n = state.batch.hazards.filter(function (h) { return (h.desc || '').trim(); }).length;
    var total = state.batch.hazards.length;
    $('exportSub').textContent = n
      ? (n + ' 条隐患 · 生成后可直接发微信/QQ/邮件')
      : (total ? '还没写描述，通知单会是空的' : '还没有隐患');
    showView('export');
  }

  async function markExported() {
    state.batch.exported_at = C.isoNow();
    await saveBatch();
  }

  // ---------------- 批次 / 菜单 ----------------
  function openSheet(html) {
    var s = $('sheet');
    s.innerHTML = html;
    s.style.transform = '';
    s.scrollTop = 0;
    $('mask').classList.remove('hidden');
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    $('mask').classList.add('hidden');
    document.body.classList.remove('sheet-open');
    $('sheet').style.transform = '';
  }

  function svgIcon(paths, size, stroke) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' +
      stroke + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  }

  function batchWhen(b) {
    var iso = b.created || '';
    var date = (b.meta && b.meta.check_date) || iso.slice(0, 10);
    var time = iso.length >= 16 ? iso.slice(11, 16) : '';
    return { date: date, time: time };
  }

  // 清单化检查：kind 显式标记，兼容旧数据（有清单答案的也算）
  function isChecklistBatch(b) {
    if (!b) return false;
    if (b.kind === 'checklist') return true;
    if (b.kind === 'photo') return false;
    var a = (b.checklist && b.checklist.answers) || {};
    return Object.keys(a).length > 0;
  }

  async function openMenu(mode, manage) {
    var isAdd = mode === 'add';
    histMode = isAdd && !!manage;
    var allBatches = await dbAll('batches');
    allBatches.sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); });
    var batches = allBatches.filter(function (b) { return !isChecklistBatch(b); });
    var cur = state.batch;
    var curIsList = isChecklistBatch(cur);
    var bytes = state.photos.reduce(function (s, p) { return s + (p.bytes || 0); }, 0);
    var when = batchWhen(cur);
    var meta = [(cur.meta.name || '').trim(), when.date, when.time, cur.hazards.length + ' 条隐患', C.formatBytes(bytes)]
      .filter(Boolean).join(' · ');
    var selected = Object.keys(checkSel).length;
    var hist = batches.map(function (b) {
      var w = batchWhen(b);
      var on = b.id === cur.id;
      var sel = !on && !!checkSel[b.id];
      var nm = (b.meta.name || '').trim();
      var label = nm
        ? C.escapeHtml(nm) + '<span>' + C.escapeHtml(w.date) + (w.time ? ' ' + C.escapeHtml(w.time) : '') + '</span>'
        : C.escapeHtml(w.date) + (w.time ? '<span>' + C.escapeHtml(w.time) + '</span>' : '');
      if (histMode) {
        return '<div class="cm-row' + (on ? ' dis' : '') + (sel ? ' on' : '') + '" data-batch="' + C.escapeHtml(b.id) + '">' +
          '<span class="cm-check">' + (sel ? '✓' : '') + '</span>' +
          '<span class="d">' + label + '</span>' +
          (on ? '<span class="badge">当前</span>' : '') +
          '<span class="n">' + b.hazards.length + ' 条</span></div>';
      }
      return '<div class="sh-hist' + (on ? ' on' : '') + '" data-batch="' + C.escapeHtml(b.id) + '">' +
        '<span class="dot"></span>' +
        '<span class="d">' + label + '</span>' +
        (on ? '<span class="badge">当前</span>' : '') +
        '<span class="n">' + b.hazards.length + ' 条</span></div>';
    }).join('');
    var appVer = '';
    try {
      if (window.SnapAndroid && window.SnapAndroid.appVersion) appVer = window.SnapAndroid.appVersion();
    } catch (e) {}

    if (isAdd) {
      openSheet(
        '<div class="sh-grab"></div>' +
        '<div class="sh-hd"><div><div class="tt">' + (histMode ? '管理检查' : '新建 / 切换检查') + '</div>' +
        '<div class="mt">' + (histMode ? '点选要删除的检查；当前检查不能删'
          : '共 ' + batches.length + ' 次检查，点一条可切换') + '</div></div>' +
        '<button class="sh-x" id="mClose">' +
        (histMode ? '<span style="font-size:13px">取消</span>' : svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 15, '#5a6b7b')) +
        '</button></div>' +
        (histMode ? '' :
          '<div class="sh-primary" id="mNewBatch">' +
          '<span class="ib">' + svgIcon('<path d="M12 5v14M5 12h14"/>', 20, '#ffffff') + '</span>' +
          '<span class="pt"><span class="t">新建检查</span><span class="s">新开一次现场检查</span></span>' +
          svgIcon('<path d="M9 6l6 6-6 6"/>', 18, 'rgba(255,255,255,.65)') + '</div>' +
          '<div class="sh-grid">' +
          '<div class="sh-tile" id="mSettings">' + svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>', 18, '#1f4e79') + '<span>本次检查信息</span></div>' +
          '<div class="sh-tile" id="mNewList">' + svgIcon('<path d="M9 5h9a1 1 0 011 1v13a1 1 0 01-1 1H6a1 1 0 01-1-1V6a1 1 0 011-1h3z"/><path d="M9 4h6v3H9z"/><path d="M8.5 12h7M8.5 16h5"/>', 18, '#1f4e79') + '<span>清单化检查</span></div>' +
          '</div>') +
        '<div class="sh-sec"><span>历史检查</span><span>' +
        (histMode ? '已选 ' + selected + ' 条' : '共 ' + batches.length + ' 次') + '</span></div>' +
        (curIsList ? '<div class="sh-hist on" style="opacity:.9"><span class="dot"></span>' +
          '<span class="d">当前：清单化检查<span>' + C.escapeHtml(when.date) + ' ' + C.escapeHtml(when.time) + '</span></span>' +
          '<span class="badge">当前</span></div>' : '') +
        (hist || '<div class="sh-hist"><span class="d">' + (curIsList ? '还没有普通检查' : '暂无检查') + '</span></div>') +
        (histMode
          ? '<div class="cm-actions"><div class="btn ghost" id="mAll">全选</div>' +
            '<div class="btn primary' + (selected ? '' : ' disabled') + '" id="mDel">删除（' + selected + '）</div>' +
            '<div class="btn ghost" id="mCancelSel">取消</div></div>'
          : '') +
        '<div class="sh-foot">' + C.escapeHtml(versionText()) + '</div>'
      );
      $('mClose').onclick = function () {
        if (histMode) { checkSel = {}; openMenu('add', false); return; }
        checkSel = {};
        closeSheet();
      };
      if (histMode) {
        $('mAll').onclick = function () { toggleAllChecks(); };
        $('mDel').onclick = function () { deleteChecked(); };
        $('mCancelSel').onclick = function () { checkSel = {}; openMenu('add', false); };
      } else {
        $('mNewBatch').onclick = function () { closeSheet(); backTo = 'add'; newCheck(); };
        $('mSettings').onclick = function () { closeSheet(); backTo = 'add'; openSetup(); };
        $('mNewList').onclick = function () { closeSheet(); openChecklistManager(false); };
      }
      Array.prototype.forEach.call($('sheet').querySelectorAll('[data-batch]'), function (b) {
        var isCur = b.classList.contains('on') || b.classList.contains('dis');
        if (histMode) {
          if (!isCur) b.onclick = function () { toggleCheck(b.dataset.batch); };
          return;
        }
        var timer = null, longPressed = false;
        var start = function () {
          longPressed = false;
          clearTimeout(timer);
          timer = setTimeout(function () {
            longPressed = true;
            checkSel = {};
            if (!isCur) checkSel[b.dataset.batch] = true;
            openMenu('add', true);
          }, 480);
        };
        var cancel = function () { clearTimeout(timer); };
        b.addEventListener('touchstart', start, { passive: true });
        b.addEventListener('touchend', cancel);
        b.addEventListener('touchmove', cancel, { passive: true });
        b.addEventListener('mousedown', start);
        b.addEventListener('mouseup', cancel);
        b.addEventListener('mouseleave', cancel);
        b.onclick = function () {
          if (longPressed) { longPressed = false; return; }
          var id = b.dataset.batch;
          var now = Date.now();
          if (lastTap.id === id && now - lastTap.t < 420) {
            lastTap = { id: '', t: 0 };
            closeSheet();
            showView('home');
            return;
          }
          lastTap = { id: id, t: now };
          selectBatch(id);
        };
      });
      return;
    }

    openSheet(
      '<div class="sh-grab"></div>' +
      '<div class="sh-hd"><div><div class="tt">检查详情</div><div class="mt">' + C.escapeHtml(meta) + '</div></div>' +
      '<button class="sh-x" id="mClose">' + svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 15, '#5a6b7b') + '</button></div>' +
      '<div class="sh-primary" id="mExport">' +
      '<span class="ib">' + svgIcon('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>', 20, '#ffffff') + '</span>' +
      '<span class="pt"><span class="t">导出 / 分享</span><span class="s">Word · PDF · 数据包（zip）</span></span>' +
      svgIcon('<path d="M9 6l6 6-6 6"/>', 18, 'rgba(255,255,255,.65)') +
      '</div>' +
      '<div class="sh-sec"><span>其它</span><span></span></div>' +
      '<div class="sh-sys" id="mStorage">' +
      svgIcon('<rect x="4" y="5" width="16" height="6" rx="2"/><rect x="4" y="13" width="16" height="6" rx="2"/><path d="M7 8h.01M7 16h.01"/>', 18, '#5a6b7b') +
      '<span class="t">存储占用 / 清理</span><span class="v">' + C.formatBytes(bytes) + '</span>' +
      '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>' +
      (hasUpdateBridge()
        ? '<div class="sh-sys" id="mUpdate">' +
          svgIcon('<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/>', 18, '#5a6b7b') +
          '<span class="t">检查更新</span><span class="v" id="mUpdateVal">' + C.escapeHtml(appVer || '检查') + '</span>' +
          '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>'
        : '') +
      '<div class="sh-foot">' + C.escapeHtml(versionText()) + '</div>'
    );

    $('mClose').onclick = function () {
      checkSel = {};
      histMode = false;
      closeSheet();
    };
    $('mExport').onclick = function () { closeSheet(); backTo = 'detail'; openExport(); };
    $('mStorage').onclick = function () { closeSheet(); storageInfo(); };
    var upd = $('mUpdate');
    if (upd) {
      upd.onclick = function () {
        closeSheet();
        try { window.SnapAndroid.checkUpdate(); } catch (e) { toast('检查更新失败'); }
      };
    }
    refreshUpdateHint();
  }

  function toggleCheck(id) {
    if (checkSel[id]) delete checkSel[id];
    else checkSel[id] = true;
    openMenu('add', true);
  }

  async function toggleAllChecks() {
    var bs = await dbAll('batches');
    var list = bs.filter(function (b) { return b.id !== state.batch.id; });
    var every = list.length && list.every(function (b) { return checkSel[b.id]; });
    checkSel = {};
    if (!every) list.forEach(function (b) { checkSel[b.id] = true; });
    openMenu('add', true);
  }

  async function deleteChecked() {
    var ids = Object.keys(checkSel);
    if (!ids.length) return;
    var bs = await dbAll('batches');
    var cnt = 0;
    bs.forEach(function (b) { if (checkSel[b.id]) cnt += b.hazards.length; });
    if (!confirm('删除 ' + ids.length + ' 个检查（共 ' + cnt + ' 条隐患，照片一起删除，不可恢复）？')) return;
    for (var k = 0; k < ids.length; k++) {
      if (ids[k] === state.batch.id) continue;
      var ps = await dbIndex('photos', 'byBatch', ids[k]);
      for (var j = 0; j < ps.length; j++) await dbDel('photos', ps[j].key);
      await dbDel('batches', ids[k]);
    }
    checkSel = {};
    toast('已删除 ' + ids.length + ' 个检查');
    showView('home');
    openMenu('add', false);
  }

  async function refreshUpdateHint() {
    var el = $('mUpdateVal');
    if (!el) return;
    try {
      var m = /\((\d+)\)/.exec(el.textContent || '');
      var cur = m ? parseInt(m[1], 10) : 0;
      var res = await fetch('update.json?t=' + Date.now(), { cache: 'no-store' });
      var j = await res.json();
      if (j && j.versionCode > cur) {
        el.textContent = '新版本 ' + j.versionName;
        el.style.color = 'var(--blue)';
      } else {
        el.textContent = '已是最新';
      }
    } catch (e) {}
  }

  async function newCheck() {
    var b = newBatchMeta(state.cfg || {});
    b.kind = 'photo';
    await dbPut('batches', b);
    state.batch = b;
    state.photos = [];
    showView('home');
    openSetup();
    toast('已新建检查，填好信息就可以拍照');
  }

  // 单击只选中（留在面板），双击才进随手拍
  async function selectBatch(id) {
    var b = await dbGet('batches', id);
    if (!b) return;
    state.batch = b;
    await refreshPhotos();
    showView('home');
    openMenu('add');
    var nm = (b.meta.name || '').trim();
    var w = batchWhen(b);
    toast('已选中：' + (nm || [w.date, w.time].filter(Boolean).join(' ')));
  }

  async function storageInfo() {
    var bytes = state.photos.reduce(function (s, p) { return s + (p.bytes || 0); }, 0);
    var quota = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        quota = est.quota || 0;
      }
    } catch (e) {}
    var all = await dbAll('batches');
    var empties = [];
    for (var i = 0; i < all.length; i++) {
      var b0 = all[i];
      if (b0.id === state.batch.id || b0.hazards.length) continue;
      var ps0 = await dbIndex('photos', 'byBatch', b0.id);
      if (!ps0.length) empties.push(b0);
    }
    openSheet(
      '<h4>存储占用</h4>' +
      '<button disabled>当前检查 ' + C.formatBytes(bytes) + ' · ' + state.photos.length + ' 张</button>' +
      '<button disabled>' + (quota ? '浏览器可用约 ' + C.formatBytes(quota) : '浏览器未报告容量') + '</button>' +
      '<button disabled style="color:#66788a;font-size:13px">导出后即可清理旧检查，数据不会自动上传任何服务器。</button>' +
      (empties.length ? '<button id="mClearEmpty">🧹 删除空检查（' + empties.length + ' 个）</button>' : '') +
      '<button id="mClearExported">🧹 删除其它已导出检查</button>' +
      '<button id="mClose2">关闭</button>'
    );
    $('mClose2').onclick = closeSheet;
    var ce = $('mClearEmpty');
    if (ce) {
      ce.onclick = async function () {
        if (!confirm('删除 ' + empties.length + ' 个空检查？')) return;
        for (var k = 0; k < empties.length; k++) await dbDel('batches', empties[k].id);
        closeSheet();
        toast('已删除 ' + empties.length + ' 个空检查');
      };
    }
    $('mClearExported').onclick = async function () {
      var batches = await dbAll('batches');
      var targets = batches.filter(function (b) { return b.id !== state.batch.id && b.exported_at; });
      if (!targets.length) { toast('没有已导出且非当前的检查'); return; }
      if (!confirm('删除 ' + targets.length + ' 个已导出检查（含照片）？')) return;
      for (var i = 0; i < targets.length; i++) {
        var ps = await dbIndex('photos', 'byBatch', targets[i].id);
        for (var j = 0; j < ps.length; j++) await dbDel('photos', ps[j].key);
        await dbDel('batches', targets[i].id);
      }
      closeSheet();
      toast('已清理 ' + targets.length + ' 个检查');
    };
  }

  // ---------------- 新建检查 / 本次检查信息 ----------------
  function updateDeadlineHint() {
    var days = Math.max(1, Math.min(365, Number($('cfgDays').value) || 7));
    var base = SnapDocx._internal.parseDate($('cfgDate').value) || new Date();
    var d = SnapDocx._internal.addDays(base, days);
    $('cfgDeadlineHint').textContent = '整改期限：' + SnapDocx._internal.fmtCN(d) + '前';
  }

  function openSetup() {
    var meta = state.batch.meta;
    $('setupTitle').textContent = '本次检查信息';
    $('setupSub').textContent = '写进通知单的表头和落款';
    $('btnSaveCfg').textContent = '保存';
    $('btnSetBack').style.visibility = 'visible';

    $('cfgName').value = meta.name || '';
    $('cfgUnit').value = meta.unit || '';
    $('cfgShort').value = meta.short_unit || '';
    $('cfgIssue').value = meta.issue_unit || '';
    $('cfgInspectors').value = meta.inspectors || '';
    $('cfgLocation').value = meta.location || '';
    $('cfgType').value = meta.check_type || '一般检查';
    $('cfgDate').value = meta.check_date || C.todayStr();
    $('cfgDays').value = meta.deadline_days || 7;
    $('cfgSpecial').value = meta.special_name || '';
    $('cfgRequirement').value = meta.requirement || '';
    $('cfgOpinion').value = meta.receiver_opinion || '';
    $('cfgRemember').checked = true;
    updateDeadlineHint();
    showView('settings');
  }

  function saveSetup() {
    var meta = state.batch.meta;
    meta.name = $('cfgName').value.trim();
    meta.unit = $('cfgUnit').value.trim();
    meta.short_unit = $('cfgShort').value.trim();
    meta.issue_unit = $('cfgIssue').value.trim();
    meta.inspectors = $('cfgInspectors').value.trim();
    meta.location = $('cfgLocation').value.trim();
    meta.check_type = $('cfgType').value;
    meta.check_date = $('cfgDate').value || C.todayStr();
    meta.deadline_days = Math.max(1, Math.min(365, Number($('cfgDays').value) || 7));
    meta.special_name = $('cfgSpecial').value.trim();
    meta.requirement = $('cfgRequirement').value.trim();
    meta.receiver_opinion = $('cfgOpinion').value.trim();

    if (!meta.unit) {
      toast('请填写受查单位');
      $('cfgUnit').focus();
      return;
    }
    if ($('cfgRemember').checked) {
      saveCfg({
        unit: meta.unit, short_unit: meta.short_unit, issue_unit: meta.issue_unit,
        inspectors: meta.inspectors, location: meta.location, check_type: meta.check_type,
        special_name: meta.special_name, deadline_days: meta.deadline_days,
        locations: state.cfg.locations || []
      });
    }
    saveBatch();
    backTo = null;
    showView('home');
    toast('已保存本次检查信息');
  }

  // ---------------- 离线状态 ----------------
  function updateBadge() {
    var b = $('offlineBadge');
    if (!('serviceWorker' in navigator)) { b.textContent = '仅在线'; b.className = 'badge warn'; return; }
    if (navigator.serviceWorker.controller) { b.textContent = '离线可用 ✓'; b.className = 'badge ok'; }
    else { b.textContent = '缓存中…'; b.className = 'badge warn'; }
  }

  function applyConfigFromHash() {
    var m = /[#&]cfg=([A-Za-z0-9_-]+)/.exec(location.hash || '');
    if (!m) return false;
    try {
      var cfg = JSON.parse(C.b64urlDecode(m[1]));
      saveCfg(Object.assign({}, state.cfg, cfg));
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(function () { toast('已套用手机配置：' + (state.cfg.short_unit || state.cfg.unit || '')); }, 400);
      if (state.batch && !state.batch.hazards.length) {
        var meta = state.batch.meta;
        meta.unit = state.cfg.unit; meta.short_unit = state.cfg.short_unit;
        meta.issue_unit = state.cfg.issue_unit; meta.inspectors = state.cfg.inspectors;
        meta.location = state.cfg.location; meta.check_type = state.cfg.check_type;
        meta.special_name = state.cfg.special_name; meta.deadline_days = state.cfg.deadline_days;
        saveBatch();
      }
      renderHeader();
      return true;
    } catch (e) {
      console.warn('配置解析失败', e);
    }
    return false;
  }

  async function boot() {
    state.cfg = loadCfg();

    // 扫码带配置：#cfg=<base64url>
    applyConfigFromHash();

    await openDB();
    var batches = await dbAll('batches');
    batches.sort(function (a, b) { return (b.updated || '').localeCompare(a.updated || ''); });
    if (batches.length) {
      state.batch = batches[0];
      await refreshPhotos();
      showView('home');
    } else {
      await newCheck();
    }
    updateBadge();
  }

  // ---------------- 清单化检查（189 条） ----------------
  var CK_GROUPS = [];
  (function () {
    var no = 0;
    (window.SnapChecklist || []).forEach(function (g) {
      var items = g.items.map(function (t) {
        no++;
        return { id: 'q' + no, no: no, text: t };
      });
      CK_GROUPS.push({ name: g.name, items: items });
    });
  })();
  var CK_FLAT = [];
  CK_GROUPS.forEach(function (g) { g.items.forEach(function (it) { CK_FLAT.push(it); }); });
  var ckMeta = { open: {}, filter: 'all' };
  var ckSel = {};
  var ckMgrMode = false;
  var ckMgrSel = {};

  function ckAnswers() {
    if (!state.batch.checklist) state.batch.checklist = { answers: {} };
    if (!state.batch.checklist.answers) state.batch.checklist.answers = {};
    return state.batch.checklist.answers;
  }

  function ckStats() {
    var a = ckAnswers();
    var done = 0, ok = 0, ng = 0;
    CK_FLAT.forEach(function (it) {
      var r = a[it.id] && a[it.id].r;
      if (r === 'ok') { done++; ok++; }
      else if (r === 'ng') { done++; ng++; }
    });
    return { total: CK_FLAT.length, done: done, ok: ok, ng: ng };
  }

  function ckSave() {
    state.batch.checklist.updated = C.isoNow();
    saveBatch();
  }

  function openChecklist() {
    ckMeta.filter = 'all';
    ckSel = {};
    if ($('ckSearch')) $('ckSearch').value = '';
    renderChecklist();
    showView('checklist');
  }

  function ckListStats(b) {
    var a = (b && b.checklist && b.checklist.answers) || {};
    var done = 0, ng = 0;
    Object.keys(a).forEach(function (k) {
      var v = a[k] || {};
      if (v.r) { done++; if (v.r === 'ng') ng++; }
    });
    return { done: done, ng: ng, total: CK_FLAT.length };
  }

  async function openChecklistManager(manage) {
    ckMgrMode = !!manage;
    var all = (await dbAll('batches')).filter(isChecklistBatch);
    all.sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); });
    var selN = Object.keys(ckMgrSel).length;
    var rows = all.map(function (b) {
      var w = batchWhen(b);
      var nm = (b.meta.name || '').trim();
      var label = nm
        ? C.escapeHtml(nm) + '<span>' + C.escapeHtml(w.date) + (w.time ? ' ' + C.escapeHtml(w.time) : '') + '</span>'
        : C.escapeHtml(w.date) + (w.time ? '<span>' + C.escapeHtml(w.time) + '</span>' : '');
      var st = ckListStats(b);
      var on = b.id === state.batch.id;
      var sel = !on && !!ckMgrSel[b.id];
      if (ckMgrMode) {
        return '<div class="cm-row' + (on ? ' dis' : '') + (sel ? ' on' : '') + '" data-batch="' + C.escapeHtml(b.id) + '">' +
          '<span class="cm-check">' + (sel ? '✓' : '') + '</span>' +
          '<span class="d">' + label + '</span>' +
          (on ? '<span class="badge">当前</span>' : '') +
          '<span class="n">' + st.done + '/' + st.total + ' · 不符合 ' + st.ng + '</span></div>';
      }
      return '<div class="sh-hist' + (on ? ' on' : '') + '" data-batch="' + C.escapeHtml(b.id) + '">' +
        '<span class="dot"></span>' +
        '<span class="d">' + label + '</span>' +
        (on ? '<span class="badge">当前</span>' : '') +
        '<span class="n">已检 ' + st.done + '</span></div>';
    }).join('');
    openSheet(
      '<div class="sh-grab"></div>' +
      '<div class="sh-hd"><div><div class="tt">' + (ckMgrMode ? '管理清单化检查' : '清单化检查') + '</div>' +
      '<div class="mt">' + (ckMgrMode ? '删除会连同该检查的隐患与照片；当前清单不能删'
        : '共 ' + all.length + ' 份，点一条打开清单') + '</div></div>' +
      '<button class="sh-x" id="mClClose">' +
      (ckMgrMode ? '<span style="font-size:13px">取消</span>' : svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 15, '#5a6b7b')) +
      '</button></div>' +
      (ckMgrMode ? '' :
        '<div class="sh-primary" id="mClNew">' +
        '<span class="ib">' + svgIcon('<path d="M12 5v14M5 12h14"/>', 20, '#ffffff') + '</span>' +
        '<span class="pt"><span class="t">新建清单化检查</span><span class="s">空白，或复制上次清单</span></span>' +
        svgIcon('<path d="M9 6l6 6-6 6"/>', 18, 'rgba(255,255,255,.65)') + '</div>') +
      '<div class="sh-sec"><span>历史清单化检查</span><span>' + (ckMgrMode ? '已选 ' + selN + ' 份' : '共 ' + all.length + ' 份') + '</span></div>' +
      (rows || '<div class="sh-hist"><span class="d">暂无</span></div>') +
      (ckMgrMode
        ? '<div class="cm-actions"><div class="btn ghost" id="mClAll">全选</div>' +
          '<div class="btn primary' + (selN ? '' : ' disabled') + '" id="mClDel">删除（' + selN + '）</div>' +
          '<div class="btn ghost" id="mClCancel">取消</div></div>'
        : '') +
      '<div class="sh-foot">' + C.escapeHtml(versionText()) + '</div>'
    );
    $('mClClose').onclick = function () {
      if (ckMgrMode) { ckMgrSel = {}; openChecklistManager(false); return; }
      closeSheet();
    };
    if (ckMgrMode) {
      $('mClAll').onclick = function () {
        var list = $('sheet').querySelectorAll('.cm-row[data-batch]:not(.dis)');
        var every = list.length && Array.prototype.every.call(list, function (r) { return ckMgrSel[r.dataset.batch]; });
        ckMgrSel = {};
        Array.prototype.forEach.call(list, function (r) { if (!every) ckMgrSel[r.dataset.batch] = true; });
        openChecklistManager(true);
      };
      $('mClCancel').onclick = function () { ckMgrSel = {}; openChecklistManager(false); };
      $('mClDel').onclick = async function () {
        var ids = Object.keys(ckMgrSel).filter(function (id) { return id !== state.batch.id; });
        if (!ids.length) return;
        if (!confirm('删除 ' + ids.length + ' 条检查（含隐患记录和照片，不可恢复）？')) return;
        for (var i = 0; i < ids.length; i++) {
          var ps = await dbIndex('photos', 'byBatch', ids[i]);
          for (var j = 0; j < ps.length; j++) await dbDel('photos', ps[j].key);
          await dbDel('batches', ids[i]);
        }
        ckMgrSel = {};
        toast('已删除 ' + ids.length + ' 条检查');
        openChecklistManager(false);
      };
    } else {
      $('mClNew').onclick = function () { openNewChecklistSheet(); };
    }
    Array.prototype.forEach.call($('sheet').querySelectorAll('[data-batch]'), function (r) {
      var on = r.classList.contains('on') || r.classList.contains('dis');
      if (ckMgrMode) {
        if (!on) r.onclick = function () {
          if (ckMgrSel[r.dataset.batch]) delete ckMgrSel[r.dataset.batch];
          else ckMgrSel[r.dataset.batch] = true;
          openChecklistManager(true);
        };
        return;
      }
      var timer = null, longPressed = false;
      var start = function () {
        longPressed = false;
        clearTimeout(timer);
        timer = setTimeout(function () {
          longPressed = true;
          ckMgrSel = {};
          if (!on) ckMgrSel[r.dataset.batch] = true;
          openChecklistManager(true);
        }, 480);
      };
      var cancel = function () { clearTimeout(timer); };
      r.addEventListener('touchstart', start, { passive: true });
      r.addEventListener('touchend', cancel);
      r.addEventListener('touchmove', cancel, { passive: true });
      r.addEventListener('mousedown', start);
      r.addEventListener('mouseup', cancel);
      r.addEventListener('mouseleave', cancel);
      r.onclick = function () {
        if (longPressed) { longPressed = false; return; }
        closeSheet();
        ckMgrOpen(r.dataset.batch);
      };
    });
  }

  async function ckMgrOpen(id) {
    var b = await dbGet('batches', id);
    if (!b) return;
    state.batch = b;
    await refreshPhotos();
    openChecklist();
  }

  function copyChecklistAnswers(src) {
    var out = {};
    var a = (src && src.checklist && src.checklist.answers) || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k] || {};
      if (v.r || (v.note || '').trim()) out[k] = { r: v.r || '', note: v.note || '' };
    });
    return out;
  }

  async function openNewChecklistSheet() {
    var all = (await dbAll('batches')).filter(isChecklistBatch);
    all.sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); });
    var src = null, srcN = 0;
    for (var i = 0; i < all.length; i++) {
      var ans = copyChecklistAnswers(all[i]);
      var n = Object.keys(ans).length;
      if (n) { src = all[i]; srcN = n; break; }
    }
    var w = src ? batchWhen(src) : null;
    var srcName = src ? (((src.meta.name || '').trim()) || [w.date, w.time].filter(Boolean).join(' ')) : '';
    openSheet(
      '<div class="sh-grab"></div>' +
      '<div class="sh-hd"><div><div class="tt">新建检查清单</div><div class="mt">会新建一条检查，当前这条保留</div></div>' +
      '<button class="sh-x" id="mNcClose">' + svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 15, '#5a6b7b') + '</button></div>' +
      '<div class="sh-primary" id="mNcBlank">' +
      '<span class="ib">' + svgIcon('<path d="M12 5v14M5 12h14"/>', 20, '#ffffff') + '</span>' +
      '<span class="pt"><span class="t">新建空白清单</span><span class="s">189 条全部为未检</span></span>' +
      svgIcon('<path d="M9 6l6 6-6 6"/>', 18, 'rgba(255,255,255,.65)') + '</div>' +
      (src
        ? '<div class="sh-grid"><div class="sh-tile" id="mNcCopy" style="flex:1">' +
          svgIcon('<path d="M8 7V5a1 1 0 011-1h9l3 3v10a1 1 0 01-1 1h-2"/><rect x="3" y="7" width="11" height="12" rx="1"/>', 18, '#1f4e79') +
          '<span>复制上次清单<br><small style="color:#8a97a6">' + C.escapeHtml(srcName) + ' · ' + srcN + ' 项</small></span></div></div>'
        : '<div class="hint" style="margin:12px 20px">还没有可复制的历史清单</div>') +
      '<div class="sh-foot">新建后仍可继续修改、导出</div>'
    );
    $('mNcClose').onclick = closeSheet;
    $('mNcBlank').onclick = function () { newChecklist('blank'); };
    var cp = $('mNcCopy');
    if (cp) cp.onclick = function () { newChecklist('copy'); };
  }

  async function newChecklist(mode) {
    closeSheet();
    var b = newBatchMeta(state.cfg || {});
    b.kind = 'checklist';
    if (mode === 'copy') {
      var all = await dbAll('batches');
      all.sort(function (x, y) { return (y.created || '').localeCompare(x.created || ''); });
      for (var i = 0; i < all.length; i++) {
        if (!isChecklistBatch(all[i])) continue;
        var ans = copyChecklistAnswers(all[i]);
        if (Object.keys(ans).length) {
          b.checklist = { answers: ans, copied_from: all[i].id };
          break;
        }
      }
    }
    await dbPut('batches', b);
    state.batch = b;
    state.photos = [];
    showView('home');
    openChecklist();
    var n = Object.keys((b.checklist && b.checklist.answers) || {}).length;
    toast(mode === 'copy' && n ? ('已新建清单，复制 ' + n + ' 项') : '已新建空白清单');
  }

  function ckHazardCount(no) {
    return (state.batch.hazards || []).filter(function (h) {
      return h.tag && h.tag.type === 'checklist' && h.tag.no === no;
    }).length;
  }

  // 已拍照或已写问题描述的条目，不能通过多选/全选标为合格
  function ckLocked(it) {
    var a = ckAnswers();
    var note = (a[it.id] && a[it.id].note) || '';
    return ckHazardCount(it.no) > 0 || note.trim() !== '';
  }

  function renderChecklist() {
    var a = ckAnswers();
    var st = ckStats();
    var q = ($('ckSearch').value || '').trim();
    CK_FLAT.forEach(function (it) { if (ckSel[it.id] && ckLocked(it)) delete ckSel[it.id]; });
    $('ckSub').textContent = (state.batch.meta.short_unit || state.batch.meta.unit || '') + ' · ' + state.batch.meta.check_date;
    $('ckNums').innerHTML = '已检 <b>' + st.done + '</b>/' + st.total +
      ' · 合格 <b>' + st.ok + '</b> · 不符合 <b>' + st.ng + '</b> · 未检 <b>' + (st.total - st.done) + '</b>';
    $('ckBar').style.width = (st.total ? Math.round(st.done / st.total * 100) : 0) + '%';
    Array.prototype.forEach.call($('ckTabs').children, function (b) {
      b.classList.toggle('on', b.dataset.f === ckMeta.filter);
    });
    var html = '';
    CK_GROUPS.forEach(function (g, gi) {
      var items = g.items.filter(function (it) {
        var r = a[it.id] && a[it.id].r;
        if (ckMeta.filter === 'todo' && r) return false;
        if (ckMeta.filter === 'ng' && r !== 'ng') return false;
        if (q) {
          var note = (a[it.id] && a[it.id].note) || '';
          if ((g.name + ' ' + it.text + ' ' + note).indexOf(q) < 0) return false;
        }
        return true;
      });
      if (!items.length) return;
      var done = 0, ng = 0;
      g.items.forEach(function (it) {
        var r = a[it.id] && a[it.id].r;
        if (r) done++;
        if (r === 'ng') ng++;
      });
      var open = ckMeta.filter !== 'all' || !!q || ckMeta.open[gi];
      var unlocked = items.filter(function (it) { return !ckLocked(it); });
      var allSel = unlocked.length && unlocked.every(function (it) { return ckSel[it.id]; });
      html += '<div class="ck-group' + (open ? ' open' : '') + '" data-g="' + gi + '">' +
        '<div class="ck-head">' +
        '<span class="ck-selbox' + (allSel ? ' on' : '') + '" data-gsel="' + gi + '">' + (allSel ? '✓' : '') + '</span>' +
        '<span class="nm">' + C.escapeHtml(g.name) + '</span>' +
        '<span class="meta">' + done + '/' + g.items.length + (ng ? ' · 不符合 ' + ng : '') + '</span>' +
        '<span class="chev">›</span></div>' +
        '<div class="ck-body">' + items.map(function (it) {
          var r = (a[it.id] && a[it.id].r) || '';
          var note = (a[it.id] && a[it.id].note) || '';
          var nimg = ckHazardCount(it.no);
          var locked = ckLocked(it);
          var sel = !!ckSel[it.id] && !locked;
          return '<div class="ck-item" data-id="' + it.id + '">' +
            '<div class="ck-q"><span class="ck-selbox' + (sel ? ' on' : '') + (locked ? ' lock' : '') + '"' +
            (locked ? ' title="已有照片或问题描述，不能批量标合格"' : ' data-isel="' + it.id + '"') + '>' +
            (sel ? '✓' : '') + '</span>' +
            '<b>' + it.no + '</b>' + C.escapeHtml(it.text) + '</div>' +
            '<div class="ck-act"><button class="ok' + (r === 'ok' ? ' on' : '') + '" data-r="ok">合格</button>' +
            '<button class="ng' + (r === 'ng' ? ' on' : '') + '" data-r="ng">不符合</button>' +
            '<button class="ph" data-photo="1">📷' + (nimg ? '<i>' + nimg + '</i>' : '') + '</button></div>' +
            (r === 'ng' ? '<textarea class="ck-note" placeholder="问题描述（选填）">' + C.escapeHtml(note) + '</textarea>' : '') +
            '</div>';
        }).join('') + '</div></div>';
    });
    $('ckList').innerHTML = html || '<div class="ck-empty">没有符合条件的检查项</div>';
    var selN = Object.keys(ckSel).length;
    $('ckBulk').classList.toggle('hidden', !selN);
    $('ckBulkN').textContent = selN;
    var allUnlocked = CK_FLAT.filter(function (it) { return !ckLocked(it); });
    var allSelAll = allUnlocked.length && allUnlocked.every(function (it) { return ckSel[it.id]; });
    $('ckAllSel').textContent = allSelAll ? '取消全选' : '全选';
  }

  function toggleAllCk() {
    var unlocked = CK_FLAT.filter(function (it) { return !ckLocked(it); });
    var all = unlocked.length && unlocked.every(function (it) { return ckSel[it.id]; });
    ckSel = {};
    if (!all) unlocked.forEach(function (it) { ckSel[it.id] = true; });
    renderChecklist();
  }

  function toggleCkSel(id) {
    if (ckSel[id]) delete ckSel[id];
    else ckSel[id] = true;
    renderChecklist();
  }

  function toggleGroupSel(gi) {
    var g = CK_GROUPS[gi];
    if (!g) return;
    var unlocked = g.items.filter(function (it) { return !ckLocked(it); });
    var all = unlocked.length && unlocked.every(function (it) { return ckSel[it.id]; });
    unlocked.forEach(function (it) {
      if (all) delete ckSel[it.id];
      else ckSel[it.id] = true;
    });
    renderChecklist();
  }

  function bulkMarkOk() {
    var ids = Object.keys(ckSel).filter(function (id) {
      var it = null;
      CK_FLAT.forEach(function (x) { if (x.id === id) it = x; });
      return it && !ckLocked(it);
    });
    var skipped = Object.keys(ckSel).length - ids.length;
    if (!ids.length) {
      ckSel = {};
      renderChecklist();
      toast('选中的条目都有照片或问题描述，不能标为合格');
      return;
    }
    var a = ckAnswers();
    ids.forEach(function (id) {
      a[id] = a[id] || { r: '', note: '' };
      a[id].r = 'ok';
    });
    ckSel = {};
    ckSave();
    renderChecklist();
    toast('已把 ' + ids.length + ' 项标为合格' + (skipped ? '，' + skipped + ' 项已有照片/描述已跳过' : ''));
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    $('btnMenu').addEventListener('click', function () { openMenu('detail'); });
    $('btnAdd').addEventListener('click', function () { openMenu('add'); });
    $('btnCkBack').addEventListener('click', goUp);
    $('btnCkNew').addEventListener('click', function () { openChecklistManager(false); });
    $('btnCkExport').addEventListener('click', function () {
      exportChecklistRecord().catch(function (e) {
        console.error(e);
        toast('导出失败：' + (e.message || e));
      });
    });
    $('ckEntry').addEventListener('click', function () {
      if (isChecklistBatch(state.batch)) openChecklist();
      else openChecklistManager(false);
    });
    $('ckSearch').addEventListener('input', function () { renderChecklist(); });
    $('ckTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.id === 'ckAllSel') return;
      ckMeta.filter = b.dataset.f;
      renderChecklist();
    });
    $('ckAllSel').addEventListener('click', toggleAllCk);
    $('ckList').addEventListener('click', function (e) {
      var sb = e.target.closest('.ck-selbox');
      if (sb) {
        if (sb.dataset.isel) { toggleCkSel(sb.dataset.isel); return; }
        if (sb.dataset.gsel !== undefined) { toggleGroupSel(+sb.dataset.gsel); return; }
      }
      var head = e.target.closest('.ck-head');
      if (head) {
        var gi = +head.parentNode.dataset.g;
        ckMeta.open[gi] = !ckMeta.open[gi];
        head.parentNode.classList.toggle('open', !!ckMeta.open[gi]);
        return;
      }
      var ph = e.target.closest('.ck-act .ph');
      if (ph) {
        var phItem = ph.closest('.ck-item');
        pendingCk = phItem.dataset.id;
        $('fileCamera').click();
        return;
      }
      var btn = e.target.closest('.ck-act button');
      if (!btn) return;
      var item = btn.closest('.ck-item');
      var id = item.dataset.id;
      var a = ckAnswers();
      var cur = a[id] || { r: '', note: '' };
      var r = btn.dataset.r;
      cur.r = (cur.r === r) ? '' : r;
      a[id] = cur;
      ckSave();
      renderChecklist();
    });
    $('ckBulkOk').addEventListener('click', bulkMarkOk);
    $('ckBulkClear').addEventListener('click', function () { ckSel = {}; renderChecklist(); });
    $('ckList').addEventListener('change', function (e) {
      if (!e.target.classList.contains('ck-note')) return;
      var item = e.target.closest('.ck-item');
      var a = ckAnswers();
      var id = item.dataset.id;
      if (!a[id]) a[id] = { r: 'ng', note: '' };
      a[id].note = e.target.value;
      ckSave();
      renderChecklist();
    });
    $('mask').addEventListener('click', function (e) { if (e.target === $('mask')) closeSheet(); });

    // 面板下拉关闭（顶部区域，列表未滚动时）
    (function sheetDrag() {
      var s = $('sheet');
      var startY = 0, delta = 0, dragging = false;
      s.addEventListener('touchstart', function (e) {
        if (s.scrollTop > 0 || e.touches.length !== 1) return;
        var top = s.getBoundingClientRect().top;
        if (e.touches[0].clientY - top > 100) return;
        startY = e.touches[0].clientY;
        delta = 0;
        dragging = true;
        s.style.transition = 'none';
      }, { passive: true });
      s.addEventListener('touchmove', function (e) {
        if (!dragging) return;
        delta = Math.max(0, e.touches[0].clientY - startY);
        s.style.transform = 'translateY(' + delta + 'px)';
      }, { passive: true });
      s.addEventListener('touchend', function () {
        if (!dragging) return;
        dragging = false;
        s.style.transition = 'transform .22s ease';
        if (delta > 90) {
          s.style.transform = 'translateY(100%)';
          setTimeout(closeSheet, 200);
        } else {
          s.style.transform = 'translateY(0)';
        }
      });
    })();

    $('btnNew').addEventListener('click', quickCapture);
    $('btnBack').addEventListener('click', function () {
      if (!state.editing) { showView('home'); return; }
      var after = !!(state.editing && state.editing.phase === 'after');
      if (!after) readForm();
      saveBatch().then(function () {
        // 空条目丢弃
        var h = hazardById(state.editing.hazardId);
        if (h && !h.desc && !photosOf(h.id).length) {
          state.batch.hazards = state.batch.hazards.filter(function (x) { return x.id !== h.id; });
          return saveBatch();
        }
      }).then(function () { showView('home'); });
    });
    $('btnSaveBack').addEventListener('click', function () { saveEdit(false); });
    $('btnSaveNext').addEventListener('click', function () { saveEdit(true); });
    $('btnSetBack').addEventListener('click', goUp);
    $('btnSaveCfg').addEventListener('click', saveSetup);
    $('btnManage').addEventListener('click', function () { setSelecting(true); });
    $('btnSelAll').addEventListener('click', selectAllToggle);
    $('btnSelDelete').addEventListener('click', deleteSelected);
    $('btnSelDone').addEventListener('click', function () { setSelecting(false); });
    $('btnExportBack').addEventListener('click', goUp);
    $('btnExportDocx').addEventListener('click', exportNotice);
    $('btnExportPdf').addEventListener('click', exportPdf);
    $('btnExportZip').addEventListener('click', exportBatch);
    $('btnPhotoCamera').addEventListener('click', function () { $('fileCamera').click(); });
    $('btnPhotoAlbum').addEventListener('click', function () { $('filePick').click(); });
    $('cfgDate').addEventListener('change', updateDeadlineHint);
    $('cfgDays').addEventListener('input', updateDeadlineHint);

    Array.prototype.forEach.call($('segLevel').children, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call($('segLevel').children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });

    Array.prototype.forEach.call($('phaseTabs').children, function (b) {
      b.addEventListener('click', function () {
        if (!state.editing) return;
        var prev = state.editing.phase;
        if (prev === 'before' && b.dataset.phase === 'after') {
          readForm();
          saveBatch();
        }
        Array.prototype.forEach.call($('phaseTabs').children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        state.editing.phase = b.dataset.phase;
        updatePhaseUI();
        renderPhotos();
      });
    });

    // 两个文件输入：相机 / 相册
    var cam = document.createElement('input');
    cam.type = 'file'; cam.accept = 'image/*'; cam.capture = 'environment'; cam.multiple = true;
    cam.id = 'fileCamera'; cam.className = 'hidden';
    document.body.appendChild(cam);
    cam.addEventListener('change', function () {
      var files = Array.prototype.slice.call(cam.files || []);
      cam.value = '';
      if (!files.length) { pendingQuick = false; pendingCk = null; return; }
      if (pendingCk) {
        var ckId = pendingCk;
        pendingCk = null;
        createChecklistHazard(ckId, files).catch(function (e) {
          console.error(e);
          toast('照片保存失败：' + (e.message || e));
        });
        return;
      }
      if (pendingQuick) {
        pendingQuick = false;
        clearTimeout(quickTimer);
        createHazardWithPhotos(files).catch(function (e) {
          console.error(e);
          toast('照片保存失败：' + (e.message || e));
        });
      } else {
        addPhotos(files);
      }
    });

    var pick = document.createElement('input');
    pick.type = 'file'; pick.accept = 'image/*'; pick.multiple = true;
    pick.id = 'filePick'; pick.className = 'hidden';
    document.body.appendChild(pick);
    pick.addEventListener('change', function () { addPhotos(pick.files); pick.value = ''; });

    // 长按照片提示：改用删除按钮，不做复杂手势
  }

  // ---------------- 启动 ----------------
  // 安卓返回键：先回上一级菜单，不直接退出
  window.SnapBack = function () {
    try {
      if (!$('mask').classList.contains('hidden')) {
        if (histMode) { checkSel = {}; openMenu('add', false); return true; }
        closeSheet();
        return true;
      }
      var view = document.body.dataset.view;
      if (view === 'edit') { $('btnBack').click(); return true; }
      if (view === 'export' || view === 'settings' || view === 'checklist') { goUp(); return true; }
      if (state.selecting) { setSelecting(false); return true; }
    } catch (e) { console.warn('SnapBack', e); }
    return false;
  };

  // 返回上一级：子页一律回拍照页；拍照页再按返回才退出
  function goUp() {
    var to = backTo || 'home';
    backTo = null;
    if (to === 'add' || to === 'detail') {
      showView('home');
      openMenu(to);
      return;
    }
    showView(to);
  }

  if (!window.SnapCore) {
    var el = $('fatal');
    el.textContent = '出错了：core.js 没有加载成功，请刷新页面重试。';
    el.classList.remove('hidden');
    return;
  }
  bind();
  boot().catch(function (e) {
    console.error(e);
    var msg = (e && (e.stack || e.message)) || String(e);
    var box = $('fatal');
    box.textContent = '初始化失败：' + msg + '\n（把这段截图发给我）';
    box.classList.remove('hidden');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; })
        .then(updateBadge).catch(function (e) { console.warn('SW 注册失败', e); updateBadge(); });
      navigator.serviceWorker.addEventListener('controllerchange', updateBadge);
    });
  }
  window.addEventListener('online', updateBadge);
  window.addEventListener('offline', updateBadge);
  window.addEventListener('hashchange', function () {
    // 已打开页面时扫码（只变 hash，不会重新加载）
    if (state.batch) applyConfigFromHash();
  });
})();
