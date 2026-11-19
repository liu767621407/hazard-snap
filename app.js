(function () {
  'use strict';
  var C = window.SnapCore;
  var $ = function (id) { return document.getElementById(id); };

  // ---------------- 状态 ----------------
  var WEB_VERSION = '4.7.2';
  var state = {
    cfg: null, batch: null, photos: [], editing: null,
    selecting: false, selected: {}, moduleKind: 'photo',
    editOnly: false, _editBackup: null
  };
  var pendingQuick = false;
  var pendingCk = null;
  var quickTimer = null;
  var backTo = null;
  var archiveKind = 'photo';
  var chkMulti = false;
  var checkSelMap = {};
  var wsBack = '';

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
    var cfg = state.cfg || {};
    var kind = state.batch ? moduleOf(state.batch) : (state.moduleKind || 'photo');
    $('hdrModule').textContent = moduleName(kind);
    if (!state.batch) {
      $('hdrUnit').textContent = cfg.unit || '未设置单位';
      $('hdrDate').textContent = '还没有进行中的检查';
      return;
    }
    var m = state.batch.meta || {};
    $('hdrUnit').textContent = m.short_unit || m.unit || cfg.unit || '未设置单位';
    var tail = '';
    if (kind === 'special') {
      var sp = (m.special_name || '').trim();
      $('hdrModule').textContent = sp
        ? (moduleName(kind) + ' · ' + sp)
        : moduleName(kind);
      tail = state.batch.hazards.length + ' 条隐患';
    } else if (kind === 'checklist') {
      var s = ckStats();
      tail = '已检 ' + s.done + '/' + s.total;
    } else {
      tail = state.batch.hazards.length + ' 条隐患';
    }
    $('hdrDate').textContent = (m.check_date || '') + ' · ' + tail;
  }
  function renderEmptyWorkspace(kind) {
    var m = MODULE_BY_KIND[kind] || MODULES[0];
    $('hazardList').innerHTML = '<div class="empty">「' + C.escapeHtml(m.name) + '」还没有进行中的检查<br>' +
      C.escapeHtml(m.desc) + '</div>';
    $('emptyHome').classList.add('hidden');
    $('ckEntryWrap').classList.add('hidden');
    $('specialWrap').classList.add('hidden');
    $('selBar').classList.add('hidden');
    $('btnNew').classList.add('hidden');
    $('statCount').textContent = '0';
    $('statPhotos').textContent = '0';
    $('statSize').textContent = '0 B';
    $('btnManage').classList.add('hidden');
    renderHeader();
    var fab = document.querySelector('#viewHome .fabbar');
    if (fab) fab.classList.remove('hidden');
    // 空态时底部按钮变成“新建”
    var btn = $('btnNew');
    btn.classList.remove('hidden');
    btn.textContent = '＋ 新建' + m.name;
    btn.dataset.action = 'new';
  }

  function renderHome() {
    revokeUrls();
    var list = $('hazardList');
    var batch = state.batch;
    if (!batch) { renderEmptyWorkspace(state.moduleKind || 'photo'); return; }
    var btn = $('btnNew');
    btn.dataset.action = 'photo';
    btn.textContent = '📷 拍照';
    list.innerHTML = '';
    $('emptyHome').classList.toggle('hidden', batch.hazards.length > 0);
    var kind = moduleOf(batch);
    $('ckEntryWrap').classList.toggle('hidden', kind !== 'checklist');
    $('specialWrap').classList.toggle('hidden', kind !== 'special');
    $('selBar').classList.toggle('hidden', !state.selecting);
    $('btnManage').classList.toggle('hidden', state.selecting);
    var fabH = document.querySelector('#viewHome .fabbar');
    if (fabH) fabH.classList.toggle('hidden', state.selecting);
    if (kind === 'special') {
      var sp = batch.meta.special_name || '专项检查';
      var dl = batch.meta.deadline_days || 7;
      $('specBar').innerHTML = '<b>' + C.escapeHtml(sp) + '</b><span>整改期限 ' + dl + ' 天 · 出通知单 + 存根 + 销号表</span>';
    }
    var cst = ckStats();
    $('ckEntrySub').textContent = '已检 ' + cst.done + '/' + cst.total + ' · 不符合 ' + cst.ng;
    $('ckEntryBar').style.width = (cst.total ? Math.round(cst.done / cst.total * 100) : 0) + '%';
    batch.hazards.forEach(function (h, idx) {
      var ph = photosOf(h.id).sort(function (a, b) { return a.phase === b.phase ? a.order - b.order : (a.phase === 'before' ? -1 : 1); });
      var before = photosOf(h.id, 'before').length;
      var after = photosOf(h.id, 'after').length;
      var wrap = document.createElement('div');
      wrap.className = 'swipe-wrap' + (state.selecting ? ' no-swipe' : '');
      wrap.dataset.id = h.id;
      var card = document.createElement('div');
      card.className = 'card' + (state.selected[h.id] ? ' sel' : '');
      var thumb = ph.length ? photoUrl(ph[0].thumb) : '';
      var check = state.selecting
        ? '<div class="check">' + (state.selected[h.id] ? '✓' : '') + '</div>' : '';
      var hasCkText = !!(h.tag && h.tag.type === 'checklist' && h.tag.text);
      var descShown = h.desc || (hasCkText ? h.tag.text : '未填写，点击补充');
      var descEmpty = !h.desc && !hasCkText;
      card.innerHTML = check +
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
      if (state.selecting) {
        card.addEventListener('click', function () {
          if (Date.now() < suppressClickUntil) return;
          toggleSelected(h.id);
        });
      } else {
        bindSwipeRow(wrap, card, h.id);
      }
      wrap.appendChild(card);
      var del = document.createElement('button');
      del.className = 'swipe-del';
      del.textContent = '删除';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        closeAllSwipe();
        deleteHazardWithUndo(h.id);
      });
      wrap.appendChild(del);
      list.appendChild(wrap);
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

  // ---------------- 隐患卡片：左滑删除 / 长按多选 ----------------
  var SWIPE_W = 88;
  var openSwipe = null;
  var suppressClickUntil = 0;

  function closeAllSwipe(except) {
    Array.prototype.forEach.call(document.querySelectorAll('.swipe-wrap.open'), function (w) {
      if (w === except) return;
      w.classList.remove('open');
      var c = w.querySelector('.card');
      if (c) c.style.transform = '';
    });
    if (openSwipe && openSwipe !== except) openSwipe = null;
  }

  // 长按 → 进入多选，并勾选被长按的这条
  function enterSelectMode(hazardId) {
    suppressClickUntil = Date.now() + 500;
    setSelecting(true);
    if (hazardId) {
      state.selected[hazardId] = true;
      renderHome();
    }
    toast('已进入多选，点其它条继续勾选');
  }

  function bindSwipeRow(wrap, card, hazardId) {
    var startX = 0, startY = 0, dx = 0, dy = 0;
    var dragging = false, decided = false, horizontal = false;
    var longTimer = null, startAt = 0, suppressUntil = 0;
    var opened = false;

    function setX(x, animate) {
      card.style.transition = animate ? 'transform .18s ease' : 'none';
      card.style.transform = x ? 'translateX(' + x + 'px)' : '';
    }

    function openRow() {
      closeAllSwipe(wrap);
      wrap.classList.add('open');
      openSwipe = wrap;
      opened = true;
      setX(-SWIPE_W, true);
    }

    function closeRow() {
      wrap.classList.remove('open');
      if (openSwipe === wrap) openSwipe = null;
      opened = false;
      setX(0, true);
    }

    function cancelLong() { clearTimeout(longTimer); longTimer = null; }

    wrap.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startAt = Date.now();
      dx = 0; dy = 0;
      dragging = true; decided = false; horizontal = false;
      cancelLong();
      longTimer = setTimeout(function () {
        longTimer = null;
        if (!dragging || decided) return;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) {} }
        enterSelectMode(hazardId);
      }, 450);
    }, { passive: true });

    wrap.addEventListener('touchmove', function (e) {
      if (!dragging || e.touches.length !== 1) return;
      dx = e.touches[0].clientX - startX;
      dy = e.touches[0].clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (horizontal) cancelLong();
      }
      if (!horizontal) return;
      if (e.cancelable) e.preventDefault();
      var base = opened ? -SWIPE_W : 0;
      var x = base + dx;
      if (x > 0) x = 0;
      if (x < -SWIPE_W - 24) x = -SWIPE_W - 24;
      setX(x, false);
    }, { passive: false });

    wrap.addEventListener('touchend', function () {
      cancelLong();
      dragging = false;
      if (horizontal) {
        suppressUntil = Date.now() + 400;
        var base = opened ? -SWIPE_W : 0;
        var x = base + dx;
        if (x < -SWIPE_W / 2) openRow(); else closeRow();
        return;
      }
      // 定时器可能被浏览器丢弃：用按住时长兜底 → 进多选
      if (Date.now() - startAt >= 450) enterSelectMode(hazardId);
    });

    wrap.addEventListener('touchcancel', function () {
      cancelLong();
      dragging = false;
      if (horizontal) { if (opened) setX(-SWIPE_W, true); else setX(0, true); }
    });

    card.addEventListener('click', function (e) {
      if (Date.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); return; }
      if (opened) { e.preventDefault(); e.stopPropagation(); closeRow(); return; }
      openEdit(hazardId);
    });

    // 桌面端：右键进入多选
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      enterSelectMode(hazardId);
    });
  }

  function setSelecting(on) {
    closeAllSwipe();
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
    var removedH = [];
    var removedP = [];
    var keep = [];
    state.batch.hazards.forEach(function (h) {
      if (ids.indexOf(h.id) < 0) { keep.push(h); return; }
      removedH.push(h);
      state.photos.forEach(function (p) { if (p.hazardId === h.id) removedP.push(p); });
    });
    state.batch.hazards = keep;
    var dead = {};
    removedP.forEach(function (p) { dead[p.hazardId] = true; });
    state.photos = state.photos.filter(function (p) { return !dead[p.hazardId]; });
    await saveBatch();
    setSelecting(false);
    renderHome();
    var timer = setTimeout(function () {
      removedP.forEach(function (p) { dbDel('photos', p.key); });
    }, 6500);
    snackbar('已删除 ' + removedH.length + ' 条隐患', '撤销', async function () {
      clearTimeout(timer);
      Array.prototype.push.apply(state.batch.hazards, removedH);
      state.batch.hazards.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      state.photos = state.photos.concat(removedP);
      for (var k = 0; k < removedP.length; k++) await dbPut('photos', removedP[k]);
      await saveBatch();
      renderHome();
    });
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
  }

  function openEdit(hazardId, fromChecklist) {
    var h = hazardById(hazardId);
    if (!h) return;
    pendingQuick = false;
    pendingCk = null;
    state.editFrom = fromChecklist ? 'checklist' : '';
    state.editing = { hazardId: hazardId, phase: 'before' };
    var idx = state.batch.hazards.indexOf(h) + 1;
    $('editTitle').textContent = '隐患 ' + idx;
    var m2 = state.batch.meta;
    $('editSub').innerHTML = '<span>' + C.escapeHtml(m2.short_unit || m2.unit || '未设置单位') + '</span>' +
      '<span class="dot">·</span><span>' + C.escapeHtml(m2.check_date || '') + '</span>';
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
    openEdit(id, false);
    toast('照片已存，补个描述吧');
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
    openEdit(hid, true);
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

  async function makeChecklistDoc() {
    var a = ckAnswers();
    var st = ckStats();
    var m = state.batch.meta;
    var title = (m.name || '').trim() || ('检查清单 ' + (m.check_date || ''));
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
    return { name: name, bytes: bytes, mime: 'application/msword' };
  }

  function showView(name) {
    document.body.dataset.view = name;
    $('viewEdit').classList.toggle('hidden', name !== 'edit');
    $('viewSettings').classList.toggle('hidden', name !== 'settings');
    $('viewExport').classList.toggle('hidden', name !== 'export');
    $('viewEntry').classList.toggle('hidden', name !== 'entry');
    $('viewArchive').classList.toggle('hidden', name !== 'archive');
    $('viewChecks').classList.toggle('hidden', name !== 'checks');
    $('viewChecklist').classList.toggle('hidden', name !== 'checklist');
    $('viewHome').classList.toggle('hidden', name !== 'home');
    var fab = document.querySelector('#viewHome .fabbar');
    if (fab) fab.classList.toggle('hidden', name !== 'home' || state.selecting);
    // Chrome/PWA：用 history 让系统返回键回到上一级（APK 里走 SnapBack，不重复记历史）
    if (!window.SnapAndroid && name !== 'entry' && name !== 'home') {
      try { history.pushState({ snapView: name }, ''); } catch (e) {}
    }
    if (name === 'home') renderHome();
    if (name === 'entry') renderEntry();
    if (name === 'archive') renderArchive();
    if (name === 'checks') renderChecks();
  }

  // Chrome/PWA 的返回键
  window.addEventListener('popstate', function () {
    var v = document.body.dataset.view;
    if (v === 'entry') return;
    if (v === 'edit') { completeEditing(); return; }
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

  // ---------- 离开编辑页时保存 ----------
  async function completeEditing(goto) {
    if (!state.editing) { showView('home'); return; }
    var from = state.editFrom;
    await saveEditing({ dropEmpty: true });
    state.editing = null;
    state.editFrom = '';
    if (goto === 'checklist' || (from === 'checklist' && isChecklistBatch(state.batch))) openChecklist();
    else showView('home');
  }

  async function saveEditing(opts) {
    if (!state.editing) return;
    var after = state.editing.phase === 'after';
    if (!after) readForm();
    var h = hazardById(state.editing.hazardId);
    if (!h) return;
    if (opts && opts.dropEmpty && !after) {
      var photos = photosOf(h.id).length;
      if (!h.desc && !photos && !h.measure && !h.location && !h.responsible) {
        state.batch.hazards = state.batch.hazards.filter(function (x) { return x.id !== h.id; });
        await saveBatch();
        return;
      }
    }
    await saveBatch();
  }

  var snackTimer = null;

  function snackbar(msg, action, fn) {
    var bar = $('snackbar');
    $('snackText').textContent = msg;
    $('snackBtn').textContent = action || '';
    $('snackBtn').classList.toggle('hidden', !action);
    bar.classList.remove('hidden');
    clearTimeout(snackTimer);
    snackTimer = setTimeout(function () { bar.classList.add('hidden'); }, 6000);
    $('snackBtn').onclick = function () {
      bar.classList.add('hidden');
      clearTimeout(snackTimer);
      if (fn) fn();
    };
  }

  async function deleteHazardWithUndo(id) {
    var h = hazardById(id);
    if (!h) return;
    var photos = state.photos.filter(function (p) { return p.hazardId === id; });
    state.batch.hazards = state.batch.hazards.filter(function (x) { return x.id !== id; });
    state.photos = state.photos.filter(function (p) { return p.hazardId !== id; });
    await saveBatch();
    renderHome();
    var timer = setTimeout(function () {
      photos.forEach(function (p) { dbDel('photos', p.key); });
    }, 6500);
    snackbar('已删除 1 条隐患', '撤销', async function () {
      clearTimeout(timer);
      state.batch.hazards.push(h);
      state.batch.hazards.sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
      state.photos = state.photos.concat(photos);
      for (var i = 0; i < photos.length; i++) await dbPut('photos', photos[i]);
      await saveBatch();
      renderHome();
    });
  }

  async function deleteCurrentHazard() {
    if (!state.editing) return;
    var id = state.editing.hazardId;
    if (!confirm('删除这条隐患？6 秒内可以撤销。')) return;
    state.editing = null;
    state.editFrom = '';
    showView('home');
    await deleteHazardWithUndo(id);
  }

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

  var DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  function expGuard(needDesc) {
    if (!state.batch.hazards.length) { toast('还没有隐患可导出'); return false; }
    if (!needDesc) return true;
    var n = state.batch.hazards.filter(function (h) { return (h.desc || '').trim(); }).length;
    if (!n) { toast('还没有写描述的隐患，无法生成通知单'); return false; }
    if (!(state.batch.meta.unit || '').trim()) {
      toast('请先填写受查单位');
      openSetup({ title: '检查信息' });
      return false;
    }
    return confirmNoDesc();
  }

  async function makeNotice() {
    var payload = await buildNoticePayload();
    return { name: window.SnapDocx.noticeFileName(payload.meta), bytes: window.SnapDocx.buildNotice(payload), mime: DOCX_MIME };
  }

  async function makeStub() {
    var payload = await buildNoticePayload();
    return { name: window.SnapDocx.stubFileName(payload.meta), bytes: window.SnapDocx.buildStub(payload), mime: DOCX_MIME };
  }

  async function makePdf() {
    var payload = await buildNoticePayload();
    return {
      name: window.SnapDocx.noticeFileName(payload.meta).replace(/\.docx$/i, '.pdf'),
      bytes: await window.SnapPdf.buildNoticePdf(payload),
      mime: 'application/pdf'
    };
  }

  async function makeData() {
    var out = await buildZip();
    var short = C.safeName(state.batch.meta.short_unit || state.batch.meta.unit || '随手拍');
    var name = '随手拍_' + (state.batch.meta.check_date || '').replace(/-/g, '') + '_' + short + '.zip';
    var blob = new Blob(out.parts, { type: 'application/zip' });
    var bytes = new Uint8Array(await blob.arrayBuffer());
    return { name: name, bytes: bytes, mime: 'application/zip' };
  }

  async function makeChecklistRecord() {
    return await makeChecklistDoc();
  }

  var EXP_MAKERS = { notice: makeNotice, stub: makeStub, pdf: makePdf, zip: makeData, cklist: makeChecklistRecord };
  var EXP_LABELS = { notice: '通知单', stub: '存根', pdf: 'PDF', zip: '数据包', cklist: '清单记录' };

  // 当前模块允许的导出项
  function expKindsFor(kind) {
    var base = ['notice', 'stub', 'pdf'];
    if (kind === 'checklist') base.push('cklist');
    base.push('zip');
    return base;
  }

  function applyExportRows() {
    var kind = state.batch ? moduleOf(state.batch) : (state.moduleKind || 'photo');
    var allow = expKindsFor(kind);
    var sec = $('expCkSection');
    if (sec) sec.classList.toggle('hidden', allow.indexOf('cklist') < 0);
    Array.prototype.forEach.call(document.querySelectorAll('.exp-cb'), function (c) {
      var row = c.closest('.exportrow');
      var ok = allow.indexOf(c.value) >= 0;
      if (row) row.classList.toggle('hidden', !ok);
      if (!ok) c.checked = false;
    });
    var st = ckStats();
    var sub = $('expCkSub');
    if (sub) {
      sub.textContent = st.done
        ? ('已检 ' + st.done + '/' + st.total + ' · 含照片，不符合项红底')
        : '还没有勾选任何清单项（导出会是全“未检”）';
    }
    updateExportSel();
  }

  async function exportOne(kind) {
    if (kind !== 'zip' && kind !== 'cklist' && !expGuard(true)) return;
    if (kind === 'zip' && !expGuard(false)) return;
    setLoading(true, '正在生成' + (EXP_LABELS[kind] || '') + '…');
    try {
      var f = await EXP_MAKERS[kind]();
      setLoading(false);
      await shareBytes(f.bytes, f.name, f.mime);
      markExported();
      toast('已生成 ' + f.name);
    } catch (e) {
      setLoading(false);
      console.error(e);
      toast('生成失败：' + (e.message || e));
    }
  }

  function exportSelectedKinds() {
    return Array.prototype.slice.call(document.querySelectorAll('.exp-cb'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return c.value; });
  }

  function updateExportSel() {
    var all = Array.prototype.slice.call(document.querySelectorAll('.exp-cb'));
    var ks = all.filter(function (c) { return c.checked; });
    var btn = $('btnExportSel');
    if (btn) {
      btn.textContent = '导出所选（' + ks.length + '）';
      btn.classList.toggle('disabled', !ks.length);
    }
    var ea = $('expAll');
    if (ea) ea.checked = all.length > 0 && ks.length === all.length;
  }

  async function exportSelected() {
    var ks = exportSelectedKinds();
    if (!ks.length) { toast('请至少勾选一个文件'); return; }
    if (ks.length === 1) { exportOne(ks[0]); return; }
    var needDesc = ks.some(function (k) { return k === 'notice' || k === 'stub' || k === 'pdf'; });
    if (needDesc && !expGuard(true)) return;
    if (!needDesc && !expGuard(false)) return;
    setLoading(true, '正在生成所选文件…');
    try {
      var files = [];
      for (var i = 0; i < ks.length; i++) {
        var f = await EXP_MAKERS[ks[i]]();
        files.push({ name: f.name, data: f.bytes });
      }
      var parts = C.zipParts(files);
      var blob = new Blob(parts, { type: 'application/zip' });
      var short = C.safeName(state.batch.meta.short_unit || state.batch.meta.unit || '随手拍');
      var name = '整改资料_' + (state.batch.meta.check_date || '').replace(/-/g, '') + '_' + short + '.zip';
      setLoading(false);
      await shareBytes(blob, name, 'application/zip');
      markExported();
      toast('已打包 ' + files.length + ' 个文件：' + name);
    } catch (e) {
      setLoading(false);
      console.error(e);
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

  function openExport() {
    if (!state.batch) { toast('请先开始一次检查'); return; }
    var kind = moduleOf(state.batch);
    var n = state.batch.hazards.filter(function (h) { return (h.desc || '').trim(); }).length;
    var total = state.batch.hazards.length;
    var st = ckStats();
    var sub;
    if (kind === 'checklist') {
      sub = '已检 ' + st.done + '/' + st.total + ' · 可导出清单记录与通知单';
    } else if (n) {
      sub = n + ' 条隐患 · 生成后可直接发微信/QQ/邮件';
    } else {
      sub = total ? '还没写描述，通知单会是空的' : '还没有隐患';
    }
    $('exportSub').textContent = sub;
    showView('export');
    applyExportRows();
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

  // ---------------- 工作台 ⋯ 菜单 ----------------
  function openModuleMenu() {
    var b = state.batch;
    var bytes = state.photos.reduce(function (s, p) { return s + (p.bytes || 0); }, 0);
    var appVer = '';
    try {
      if (window.SnapAndroid && window.SnapAndroid.appVersion) appVer = window.SnapAndroid.appVersion();
    } catch (e) {}
    var kind = b ? moduleOf(b) : (state.moduleKind || 'photo');
    var when = b ? batchWhen(b) : null;
    var meta = b
      ? [(b.meta.name || '').trim(), when.date, when.time, b.hazards.length + ' 条隐患', C.formatBytes(bytes)]
        .filter(Boolean).join(' · ')
      : moduleName(kind);
    var hasBatch = !!b;
    openSheet(
      '<div class="sh-grab"></div>' +
      '<div class="sh-hd"><div><div class="tt">' + C.escapeHtml(moduleName(kind)) + '</div>' +
      '<div class="mt">' + C.escapeHtml(meta) + '</div></div>' +
      '<button class="sh-x" id="mClose">' + svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 15, '#5a6b7b') + '</button></div>' +
      (hasBatch
        ? '<div class="sh-primary" id="mExport">' +
          '<span class="ib">' + svgIcon('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>', 20, '#ffffff') + '</span>' +
          '<span class="pt"><span class="t">导出 / 分享</span><span class="s">通知单 · 存根 · PDF · 数据包' +
          (kind === 'checklist' ? ' · 清单记录' : '') + '</span></span>' +
          svgIcon('<path d="M9 6l6 6-6 6"/>', 18, 'rgba(255,255,255,.65)') + '</div>'
        : '') +
      (hasBatch
        ? '<div class="sh-sec"><span>本次检查</span><span></span></div>' +
          '<div class="sh-sys" id="mInfo">' +
          svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>', 18, '#5a6b7b') +
          '<span class="t">检查信息</span><span class="v">' + C.escapeHtml(b.meta.unit || '未填单位') + '</span>' +
          '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>' +
          '<div class="sh-sys" id="mFinish">' +
          svgIcon('<path d="M20 6L9 17l-5-5"/>', 18, '#1e8e5a') +
          '<span class="t">完成本次检查</span><span class="v"></span>' +
          '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>'
        : '') +
      '<div class="sh-sec"><span>其它</span><span></span></div>' +
      '<div class="sh-sys" id="mStorage">' +
      svgIcon('<rect x="4" y="5" width="16" height="6" rx="2"/><rect x="4" y="13" width="16" height="6" rx="2"/><path d="M7 8h.01M7 16h.01"/>', 18, '#5a6b7b') +
      '<span class="t">存储占用 / 清理</span><span class="v">' + C.formatBytes(bytes) + '</span>' +
      '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>' +
      (hasUpdateBridge()
        ? '<div class="sh-sys" id="mUpdate">' +
          svgIcon('<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/>', 18, '#5a6b7b') +
          '<span class="t">检查更新 App 壳</span><span class="v" id="mUpdateVal">' + C.escapeHtml(appVer || '检查') + '</span>' +
          '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>'
        : '') +
      '<div class="hint" style="padding:4px 22px 0">网页内容会自动更新；只有 App 壳改动时才需要装新版 APK。</div>' +
      '<div class="sh-foot">' + C.escapeHtml(versionText()) + '</div>'
    );
    $('mClose').onclick = closeSheet;
    var ex = $('mExport');
    if (ex) ex.onclick = function () { closeSheet(); openExport(); };
    var inf = $('mInfo');
    if (inf) inf.onclick = function () { closeSheet(); openSetup({ title: '检查信息' }); };
    var fin = $('mFinish');
    if (fin) fin.onclick = function () { closeSheet(); finishCheck(); };
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

  // ---------------- 入口页 ⋯ ----------------
  function openEntryMenu() {
    openSheet(
      '<div class="sh-grab"></div>' +
      '<div class="sh-hd"><div><div class="tt">设置</div><div class="mt">默认单位与检查人，新建检查会自动带上</div></div>' +
      '<button class="sh-x" id="mClose">' + svgIcon('<path d="M6 6l12 12M18 6L6 18"/>', 15, '#5a6b7b') + '</button></div>' +
      '<div class="sh-sys" id="mDefault">' +
      svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>', 18, '#5a6b7b') +
      '<span class="t">默认检查信息</span><span class="v"></span>' +
      '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>' +
      '<div class="sh-sys" id="mStorage2">' +
      svgIcon('<rect x="4" y="5" width="16" height="6" rx="2"/><rect x="4" y="13" width="16" height="6" rx="2"/><path d="M7 8h.01M7 16h.01"/>', 18, '#5a6b7b') +
      '<span class="t">存储占用 / 清理</span><span class="v"></span>' +
      '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>' +
      (hasUpdateBridge()
        ? '<div class="sh-sys" id="mUpdate2">' +
          svgIcon('<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/>', 18, '#5a6b7b') +
          '<span class="t">检查更新 App 壳</span><span class="v"></span>' +
          '<span class="chev">' + svgIcon('<path d="M9 6l6 6-6 6"/>', 16, 'currentColor') + '</span></div>'
        : '') +
      '<div class="sh-foot">' + C.escapeHtml(versionText()) + '</div>'
    );
    $('mClose').onclick = closeSheet;
    $('mDefault').onclick = function () { closeSheet(); openDefaults(); };
    $('mStorage2').onclick = function () { closeSheet(); storageInfo(); };
    var u2 = $('mUpdate2');
    if (u2) u2.onclick = function () { closeSheet(); try { window.SnapAndroid.checkUpdate(); } catch (e) {} };
  }

  // ---------------- 模块模型 ----------------
  var MODULES = [
    { kind: 'photo', name: '一般检查', icon: 'photo',
      desc: '拍照记录隐患，出通知单 + 存根' },
    { kind: 'checklist', name: '189 条清单化检查', icon: 'list',
      desc: '逐项检查，出清单记录 + 通知单' },
    { kind: 'special', name: '专项检查', icon: 'special',
      desc: '专项名称 → 通知单 + 存根 + 销号表' }
  ];
  var MODULE_BY_KIND = {};
  MODULES.forEach(function (m) { MODULE_BY_KIND[m.kind] = m; });

  function moduleOf(b) {
    if (!b) return 'photo';
    if (b.kind === 'special') return 'special';
    if (b.kind === 'checklist') return 'checklist';
    if (b.kind === 'photo') return 'photo';
    var a = (b.checklist && b.checklist.answers) || {};
    if (Object.keys(a).length) return 'checklist';
    if ((b.meta && b.meta.check_type || '').indexOf('专项') >= 0) return 'special';
    return 'photo';
  }

  function moduleName(kind) {
    return (MODULE_BY_KIND[kind] || MODULES[0]).name;
  }

  function loadCurrentMap() {
    try {
      var raw = localStorage.getItem('snap.current');
      if (raw) {
        var o = JSON.parse(raw);
        return { photo: o.photo || null, checklist: o.checklist || null, special: o.special || null };
      }
    } catch (e) {}
    return { photo: null, checklist: null, special: null };
  }

  function saveCurrentMap(m) {
    try { localStorage.setItem('snap.current', JSON.stringify(m)); } catch (e) {}
  }

  function getCurrent(kind) {
    return loadCurrentMap()[kind] || null;
  }

  function setCurrent(kind, id) {
    var m = loadCurrentMap();
    m[kind] = id || null;
    saveCurrentMap(m);
  }

  function isDone(b) { return !!(b && b.done); }

  function isChecklistBatch(b) {
    return !!b && moduleOf(b) === 'checklist';
  }

  function isValidKind(kind) {
    return kind === 'photo' || kind === 'checklist' || kind === 'special';
  }

  // 一次性迁移：给老批次补 kind
  async function migrateKinds() {
    if (localStorage.getItem('snap.migrated41')) return;
    var all = await dbAll('batches');
    all.sort(function (a, b) { return ((b.updated || b.created) || '').localeCompare((a.updated || a.created) || ''); });
    var picked = { photo: 0, checklist: 0, special: 0 };
    var map = { photo: null, checklist: null, special: null };
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      var k = moduleOf(b);
      if (!b.kind) { b.kind = k; await dbPut('batches', b); }
      if (isDone(b)) continue;
      if (!map[k]) { map[k] = b.id; picked[k] = 1; }
    }
    saveCurrentMap(map);
    try { localStorage.setItem('snap.migrated41', '1'); } catch (e) {}
  }

  function moduleStats(b) {
    if (!b) return { text: '未开始', tone: 'idle', done: 0 };
    var n = b.hazards.length;
    if (moduleOf(b) === 'checklist') {
      var st = ckListStats(b);
      var tone2 = st.done ? 'run' : 'idle';
      return { text: '已检 ' + st.done + '/' + st.total + (st.ng ? ' · 不符合 ' + st.ng : ''), tone: tone2, done: st.done, total: st.total };
    }
    return {
      text: n ? (n + ' 条隐患') : '还没有隐患',
      tone: n ? 'run' : 'idle',
      done: n
    };
  }

  // ---------------- 入口页（三块） ----------------
  async function renderEntry() {
    var map = loadCurrentMap();
    var all = await dbAll('batches');
    var byId = {};
    all.forEach(function (b) { byId[b.id] = b; });
    var doneN = all.filter(isDone).length;
    var cur = state.cfg || {};
    $('entrySub').textContent = cur.unit
      ? ('受查单位默认：' + (cur.short_unit || cur.unit))
      : '先填一次默认信息，之后新建检查会自动带上';
    $('doneCount').textContent = doneN;
    var html = MODULES.map(function (m) {
      var b = map[m.kind] ? byId[map[m.kind]] : null;
      if (b && isDone(b)) b = null;
      var st = moduleStats(b);
      var w = b ? batchWhen(b) : null;
      var when = b ? ([w.date, w.time].filter(Boolean).join(' ')) : '';
      var nm = b ? ((b.meta.name || '').trim() || when) : '';
      var cardCls = 'entry-card' + (b ? ' run' : '');
      return '<div class="' + cardCls + '" data-kind="' + m.kind + '">' +
        '<div class="entry-top">' +
        '<span class="entry-ic ' + m.kind + '">' + moduleIcon(m.icon) + '</span>' +
        '<div class="entry-tt"><b>' + C.escapeHtml(m.name) + '</b>' +
        '<span class="entry-desc">' + C.escapeHtml(m.desc) + '</span></div>' +
        '<span class="entry-dot ' + st.tone + '"></span>' +
        '</div>' +
        (b
          ? '<div class="entry-state"><b>' + C.escapeHtml(nm) + '</b><span>' + C.escapeHtml(st.text) + '</span></div>'
          : '<div class="entry-state idle"><span>未开始</span></div>') +
        '<div class="entry-acts">' +
        '<button class="btn primary" data-list="' + m.kind + '">新建</button>' +
        '</div></div>';
    }).join('');
    $('entryList').innerHTML = html;
    Array.prototype.forEach.call($('entryList').querySelectorAll('.entry-card'), function (card) {
      card.addEventListener('click', function (e) {
        var listBtn = e.target.closest('[data-list]');
        if (listBtn) { e.stopPropagation(); openModuleChecks(listBtn.dataset.list); return; }
        openModuleChecks(card.dataset.kind);
      });
    });
    updateBadge();
  }

  function moduleIcon(name) {
    if (name === 'list') {
      return svgIcon('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h1M4 12h1M4 18h1"/>', 22, '#8A5A00');
    }
    if (name === 'special') {
      return svgIcon('<path d="M4 5h16v5H4z"/><path d="M6 10v9h12v-9"/><path d="M10 14h4"/>', 22, '#1B5A86');
    }
    return svgIcon('<path d="M4 7h3l2-2h6l2 2h3v12H4z"/><circle cx="12" cy="13" r="3.5"/>', 22, '#1f4e79');
  }

  // ---------------- 模块内的检查列表 ----------------
  async function openModuleChecks(kind) {
    if (!isValidKind(kind)) kind = 'photo';
    state.moduleKind = kind;
    showView('checks');
  }

  async function renderChecks() {
    var kind = state.moduleKind || 'photo';
    var curId = getCurrent(kind);
    var all = (await dbAll('batches')).filter(function (b) { return moduleOf(b) === kind; });
    all.sort(function (a, b) {
      var ad = isDone(a) ? (a.done_at || '') : '9';
      var bd = isDone(b) ? (b.done_at || '') : '9';
      if (ad !== bd) return ad < bd ? 1 : -1;
      return ((b.updated || b.created) || '').localeCompare((a.updated || a.created) || '');
    });
    var running = all.filter(function (b) { return !isDone(b); });
    $('checksTitle').textContent = moduleName(kind);
    $('checksSub').textContent = running.length
      ? ('进行中 ' + running.length + ' 份 · 共 ' + all.length + ' 份')
      : ('共 ' + all.length + ' 份');
    if (!all.length) {
      $('checksList').innerHTML = '<div class="ck-empty">还没有「' + C.escapeHtml(moduleName(kind)) + '」的检查<br>点右上「＋ 新建」开始</div>';
      return;
    }
    $('checksList').innerHTML = all.map(function (b) {
      var w = batchWhen(b);
      var nm = (b.meta.name || '').trim() || (w.date + (w.time ? ' ' + w.time : ''));
      var done = isDone(b);
      var isCur = b.id === curId && !done;
      var st = done ? '已完成' + (b.exported_at ? ' · 已出单' : '') : moduleStats(b).text;
      var checked = !!(checkSelMap[b.id]);
      return '<div class="chk-card' + (isCur ? ' cur' : '') + (chkMulti ? ' checked' : '') + '" data-id="' + C.escapeHtml(b.id) + '">' +
        '<div class="chk-hd">' +
        (chkMulti ? '<span class="chk-cbx' + (checked ? ' on' : '') + '">' + (checked ? '✓' : '') + '</span>' : '') +
        '<div class="chk-tt">' + C.escapeHtml(nm) + '</div>' +
        (isCur ? '<span class="chk-badge cur">当前</span>' : (done ? '<span class="chk-badge done">已完成</span>' : '<span class="chk-badge run">进行中</span>')) +
        '</div>' +
        '<div class="chk-meta"><span>' + C.escapeHtml(w.date) + (w.time ? ' ' + C.escapeHtml(w.time) : '') + '</span><span>·</span><span>' + C.escapeHtml(st) + '</span></div>' +
        '<div class="chk-acts">' +
        (done
          ? '<button class="btn" data-reopen="' + C.escapeHtml(b.id) + '">重新打开</button>' +
            '<button class="btn ghost" data-edit="' + C.escapeHtml(b.id) + '">编辑</button>'
          : '<button class="btn ghost" data-edit="' + C.escapeHtml(b.id) + '">编辑信息</button>') +
        '<span class="chk-go">' + (done ? '查看' : '进入') + ' ›</span>' +
        '</div></div>';
    }).join('');
    $('viewChecks').classList.toggle('multi', chkMulti);
    $('checkSelBar').classList.toggle('hidden', !chkMulti);
    $('checkSelCount').textContent = '已选 ' + Object.keys(checkSelMap).length + ' 份';
    Array.prototype.forEach.call($('checksList').querySelectorAll('.chk-card'), function (card) {
      bindCheckLongPress(card, card.dataset.id);
    });
    Array.prototype.forEach.call($('checksList').querySelectorAll('[data-reopen]'), function (x) {
      x.onclick = function (e) { e.stopPropagation(); reopenCheck(x.dataset.reopen); };
    });
    Array.prototype.forEach.call($('checksList').querySelectorAll('[data-edit]'), function (x) {
      x.onclick = function (e) { e.stopPropagation(); editCheckInfo(x.dataset.edit); };
    });
  }

  // 检查卡片：长按进入多选；单击进入下一页
  function bindCheckLongPress(card, id) {
    var timer = null, startAt = 0, moved = false, suppressUntil = 0, longHandled = false;
    card.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var sx = e.touches[0].clientX, sy = e.touches[0].clientY;
      startAt = Date.now();
      moved = false;
      longHandled = false;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (moved) return;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) {} }
        suppressUntil = Date.now() + 600;
        longHandled = true;
        enterCheckMulti(id);
      }, 450);
      card.addEventListener('touchmove', function onMove(ev) {
        if (ev.touches.length !== 1) return;
        if (Math.abs(ev.touches[0].clientX - sx) > 8 || Math.abs(ev.touches[0].clientY - sy) > 8) {
          moved = true;
          clearTimeout(timer);
          timer = null;
          card.removeEventListener('touchmove', onMove);
        }
      }, { passive: true });
    }, { passive: true });
    card.addEventListener('touchend', function () {
      clearTimeout(timer);
      timer = null;
      if (!moved && !longHandled && Date.now() - startAt >= 450) {
        suppressUntil = Date.now() + 600;
        longHandled = true;
        enterCheckMulti(id);
      }
    });
    card.addEventListener('touchcancel', function () { clearTimeout(timer); timer = null; });
    card.addEventListener('click', function (e) {
      if (Date.now() < suppressUntil) { e.preventDefault(); return; }
      if (e.target.closest('button')) return;        // 卡片内按钮各自处理
      if (chkMulti) { e.preventDefault(); toggleCheckSel(id); return; }
      var done = !!card.querySelector('[data-reopen]');
      if (done) reopenCheck(id); else activateCheck(id);
    });
    card.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      enterCheckMulti(id);
    });
  }

  function enterCheckMulti(id) {
    chkMulti = true;
    checkSelMap = {};
    if (id) checkSelMap[id] = true;
    renderChecks();
  }

  function toggleCheckSel(id) {
    if (checkSelMap[id]) delete checkSelMap[id];
    else checkSelMap[id] = true;
    if (!Object.keys(checkSelMap).length) { chkMulti = false; }
    renderChecks();
  }

  async function deleteCheckedChecks() {
    var ids = Object.keys(checkSelMap);
    if (!ids.length) { toast('请选择要删除的检查'); return; }
    if (!confirm('删除选中的 ' + ids.length + ' 份检查？\n其中的隐患和照片会一起删除，不能恢复。')) return;
    for (var i = 0; i < ids.length; i++) {
      var b = await dbGet('batches', ids[i]);
      if (!b) continue;
      var ps = await dbIndex('photos', 'byBatch', ids[i]);
      for (var j = 0; j < ps.length; j++) await dbDel('photos', ps[j].key);
      await dbDel('batches', ids[i]);
      var k = moduleOf(b);
      if (getCurrent(k) === ids[i]) setCurrent(k, null);
    }
    toast('已删除 ' + ids.length + ' 份检查');
    checkSelMap = {};
    chkMulti = false;
    renderChecks();
  }

  // 从检查列表编辑某份检查的基本信息（不改“当前”归属）
  async function editCheckInfo(id) {
    var b = await dbGet('batches', id);
    if (!b) return;
    state._editBackup = state.batch;
    state.editOnly = true;
    state.batch = b;
    state.moduleKind = moduleOf(b);
    state.setupReturn = 'checks';
    openSetup({ title: '编辑检查信息', sub: '改完回到检查列表' });
  }

  // 把某份检查设为该模块的进行中并进入工作台
  async function activateCheck(id) {
    var b = await dbGet('batches', id);
    if (!b) return;
    var kind = moduleOf(b);
    if (isDone(b)) b.done = false;
    b.updated = C.isoNow();
    await dbPut('batches', b);
    setCurrent(kind, b.id);
    state.batch = b;
    state.moduleKind = kind;
    state.photos = [];
    state.wsBack = 'checks';   // 从检查列表进来的，返回时回检查列表
    await refreshPhotos();
    showView('home');
  }

  // ---------------- 进入模块 ----------------
  async function openModule(kind) {
    if (!isValidKind(kind)) kind = 'photo';
    var id = getCurrent(kind);
    var b = id ? await dbGet('batches', id) : null;
    if (!b || isDone(b)) {
      // 没有进行中 → 回该模块的检查列表
      state.moduleKind = kind;
      showView('checks');
      return;
    }
    state.batch = b;
    state.moduleKind = kind;
    await refreshPhotos();
    showView('home');
  }

  async function startNewCheck(kind) {
    if (!isValidKind(kind)) kind = 'photo';
    var b = newBatchMeta(state.cfg || {});
    b.kind = kind;
    b.done = false;
    b.meta.check_type = kind === 'special' ? '专项检查' : '一般检查';
    b.meta.special_name = kind === 'special' ? (state.cfg.special_name || '') : '';
    if (kind === 'checklist') {
      var last = await lastChecklistWithAnswers();
      if (last && confirm('要复制上一份清单的结果和描述吗？\n（' + (((last.batch.meta.name || '').trim()) || last.batch.meta.check_date) +
        ' · ' + Object.keys(last.answers).length + ' 项）\n\n点“取消”则从空白开始。')) {
        b.checklist = { answers: last.answers, copied_from: last.batch.id };
      }
    }
    await dbPut('batches', b);
    setCurrent(kind, b.id);
    state.batch = b;
    state.photos = [];
    state.moduleKind = kind;
    state.setupReturn = 'checks';
    openSetup({
      title: '新建' + moduleName(kind),
      sub: kind === 'checklist' ? '189 条清单，逐项检查'
        : (kind === 'special' ? '填专项名称，出通知单 + 存根 + 销号表' : '拍照记录隐患')
    });
  }

  // ---------------- 完成 / 归档 ----------------
  async function finishCheck(silent) {
    if (!state.batch) { showView('entry'); return; }
    var b = state.batch;
    var empty = !b.hazards.length && !Object.keys((b.checklist && b.checklist.answers) || {}).length;
    if (empty) {
      if (!silent && !confirm('这份检查还是空的，完成会直接删除，继续吗？')) return;
      var mk0 = moduleOf(b);
      await dbDel('batches', b.id);
      setCurrent(mk0, null);
      state.batch = null;
      state.photos = [];
      toast('空检查已丢弃');
      if (state.wsBack === 'checks') { state.wsBack = ''; showView('checks'); return; }
      showView('entry');
      return;
    }
    if (!silent && !confirm('完成「' + (((b.meta.name || '').trim()) || b.meta.check_date) + '」？\n完成后会进「已完成」，可随时打开继续改。')) return;
    var mk = moduleOf(b);
    b.done = true;
    b.done_at = C.isoNow();
    await saveBatch();
    setCurrent(mk, null);
    archiveKind = mk;
    state.batch = null;
    state.photos = [];
    toast('已完成，可在「已完成」里找回');
    if (state.wsBack === 'checks') { state.wsBack = ''; showView('checks'); return; }
    showView('entry');
  }

  async function openArchive(kind) {
    archiveKind = isValidKind(kind) ? kind : (archiveKind || 'photo');
    showView('archive');
  }

  async function renderArchive() {
    var all = (await dbAll('batches')).filter(isDone);
    all.sort(function (a, b) { return ((b.done_at || b.updated) || '').localeCompare((a.done_at || a.updated) || ''); });
    var list = all.filter(function (b) { return moduleOf(b) === archiveKind; });
    Array.prototype.forEach.call($('archiveTabs').children, function (x) {
      x.classList.toggle('on', x.dataset.f === archiveKind);
    });
    $('archiveSub').textContent = '共 ' + list.length + ' 份' + (list.length ? '' : '（在这个模块里还没有完成的检查）');
    $('archiveList').innerHTML = list.length ? list.map(function (b) {
      var w = batchWhen(b);
      var nm = (b.meta.name || '').trim() || (w.date + (w.time ? ' ' + w.time : ''));
      var st = b.hazards.length + ' 条隐患';
      if (moduleOf(b) === 'checklist') {
        var s2 = ckListStats(b);
        st = '已检 ' + s2.done + '/' + s2.total;
      }
      return '<div class="arc-row" data-id="' + C.escapeHtml(b.id) + '">' +
        '<div class="arc-main"><div class="arc-t">' + C.escapeHtml(nm) + '</div>' +
        '<div class="arc-s">' + C.escapeHtml(w.date) + (w.time ? ' ' + C.escapeHtml(w.time) : '') +
        ' · ' + C.escapeHtml(st) + (b.exported_at ? ' · 已出单' : '') + '</div></div>' +
        '<div class="arc-acts">' +
        '<button class="btn small" data-open="' + C.escapeHtml(b.id) + '">打开</button>' +
        '<button class="btn small danger" data-del="' + C.escapeHtml(b.id) + '">删除</button>' +
        '</div></div>';
    }).join('') : '<div class="ck-empty">这里还没有已完成的检查</div>';
    Array.prototype.forEach.call($('archiveList').querySelectorAll('[data-open]'), function (btn) {
      btn.onclick = function () { reopenCheck(btn.dataset.open); };
    });
    Array.prototype.forEach.call($('archiveList').querySelectorAll('[data-del]'), function (btn) {
      btn.onclick = function () { deleteArchived(btn.dataset.del); };
    });
  }

  async function reopenCheck(id) {
    var b = await dbGet('batches', id);
    if (!b) return;
    var k = moduleOf(b);
    if (!confirm('把它重新打开为进行中？会占用「' + moduleName(k) + '」的进行中位置。')) return;
    var curId = getCurrent(k);
    if (curId && curId !== id) {
      var cur = await dbGet('batches', curId);
      if (cur && !isDone(cur)) { toast('该模块已有进行中的检查，请先完成它'); return; }
    }
    b.done = false;
    b.done_at = '';
    b.updated = C.isoNow();
    await dbPut('batches', b);
    setCurrent(k, b.id);
    toast('已恢复为进行中');
    state.wsBack = 'checks';
    openModule(k);
  }

  async function deleteArchived(id) {
    var b = await dbGet('batches', id);
    if (!b) return;
    if (!confirm('删除这份检查？其中的隐患和照片会一起删除，不能恢复。')) return;
    var ps = await dbIndex('photos', 'byBatch', id);
    for (var i = 0; i < ps.length; i++) await dbDel('photos', ps[i].key);
    await dbDel('batches', id);
    toast('已删除');
    renderArchive();
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
      if ((state.batch && b0.id === state.batch.id) || b0.hazards.length) continue;
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

  // 入口页 ⋯ → 默认检查信息（只改 snap.cfg，不涉及批次）
  function openDefaults() {
    state.defaultsMode = true;
    state.setupReturn = 'entry';
    var cfg = state.cfg || {};
    $('setupTitle').textContent = '默认检查信息';
    $('setupSub').textContent = '新建检查时自动带上，可逐次修改';
    $('btnSaveCfg').textContent = '保存默认值';
    $('cfgName').value = cfg.name || '';
    $('cfgUnit').value = cfg.unit || '';
    $('cfgShort').value = cfg.short_unit || '';
    $('cfgIssue').value = cfg.issue_unit || '';
    $('cfgInspectors').value = cfg.inspectors || '';
    $('cfgLocation').value = cfg.location || '';
    $('cfgType').value = cfg.check_type || '一般检查';
    $('cfgDate').value = C.todayStr();
    $('cfgDays').value = cfg.deadline_days || 7;
    $('cfgSpecial').value = cfg.special_name || '';
    $('cfgRequirement').value = '';
    $('cfgOpinion').value = '';
    $('cfgRemember').checked = true;
    updateDeadlineHint();
    showView('settings');
  }

  function saveDefaults() {
    saveCfg({
      unit: $('cfgUnit').value.trim(),
      short_unit: $('cfgShort').value.trim(),
      issue_unit: $('cfgIssue').value.trim(),
      inspectors: $('cfgInspectors').value.trim(),
      location: $('cfgLocation').value.trim(),
      check_type: $('cfgType').value,
      special_name: $('cfgSpecial').value.trim(),
      deadline_days: Math.max(1, Math.min(365, Number($('cfgDays').value) || 7)),
      locations: (state.cfg && state.cfg.locations) || []
    });
    state.currentCfg = loadCfg();
    state.cfg = state.currentCfg;
    state.defaultsMode = false;
    toast('默认信息已保存');
    showView('entry');
  }

  function openSetup(opts) {
    opts = opts || {};
    if (!state.batch) { openDefaults(); return; }
    state.defaultsMode = false;
    var meta = state.batch.meta;
    $('setupTitle').textContent = opts.title || '检查信息';
    $('setupSub').textContent = opts.sub || '写进通知单的表头和落款';
    $('btnSaveCfg').textContent = '保存';

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
    if (state.defaultsMode) { saveDefaults(); return; }
    if (!state.batch) { showView('entry'); return; }
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
    var ret = state.setupReturn;
    state.setupReturn = '';
    if (state.editOnly) {
      // 从检查列表进来改基本信息：存完回列表
      state.editOnly = false;
      state.batch = state._editBackup || state.batch;
      state._editBackup = null;
      showView('checks');
      toast('检查信息已更新');
      return;
    }
    if (ret === 'checks') state.wsBack = 'checks';
    showView('home');
    toast('已保存本次检查信息');
  }

  // ---------------- 离线状态 ----------------
  function updateBadge() {
    var txt, cls;
    if (!('serviceWorker' in navigator)) { txt = '仅在线'; cls = 'badge warn'; }
    else if (navigator.serviceWorker.controller) { txt = '离线可用 ✓'; cls = 'badge ok'; }
    else { txt = '缓存中…'; cls = 'badge warn'; }
    ['offlineBadge', 'offlineBadge2'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.textContent = txt;
      b.className = cls;
    });
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
    await migrateKinds();
    var curId = getCurrent('photo');
    if (curId) {
      var cb = await dbGet('batches', curId);
      if (cb && !isDone(cb)) { state.batch = cb; await refreshPhotos(); }
      else { state.batch = null; setCurrent('photo', null); }
    }
    state.moduleKind = state.batch ? moduleOf(state.batch) : 'photo';
    showView('entry');
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
  var ckMeta = { filter: 'all', openGroup: {}, openItem: {}, batch: false };
  var ckSel = {};

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
    ckMeta.openGroup = {};
    ckMeta.openItem = {};
    ckMeta.batch = false;
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

  function copyChecklistAnswers(src) {
    var out = {};
    var a = (src && src.checklist && src.checklist.answers) || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k] || {};
      if (v.r || (v.note || '').trim()) out[k] = { r: v.r || '', note: v.note || '' };
    });
    return out;
  }

  // 建清单检查时可选“复制上次清单”
  async function lastChecklistWithAnswers() {
    var all = (await dbAll('batches')).filter(function (b) { return moduleOf(b) === 'checklist'; });
    all.sort(function (x, y) { return ((y.updated || y.created) || '').localeCompare((x.updated || x.created) || ''); });
    for (var i = 0; i < all.length; i++) {
      var ans = copyChecklistAnswers(all[i]);
      if (Object.keys(ans).length) return { batch: all[i], answers: ans };
    }
    return null;
  }


  function ckHazardCount(no) {
    return (state.batch.hazards || []).filter(function (h) {
      return h.tag && h.tag.type === 'checklist' && h.tag.no === no;
    }).length;
  }

  // 已标「不符合」、已拍照或已写问题描述的条目，不能通过多选/全选标为合格
  function ckLocked(it) {
    var a = ckAnswers();
    var cur = a[it.id] || {};
    var note = cur.note || '';
    return cur.r === 'ng' || ckHazardCount(it.no) > 0 || note.trim() !== '';
  }

  function ckGroupStats(gi) {
    var a = ckAnswers();
    var g = CK_GROUPS[gi];
    var done = 0, ng = 0;
    g.items.forEach(function (it) {
      var r = a[it.id] && a[it.id].r;
      if (r) done++;
      if (r === 'ng') ng++;
    });
    return { done: done, ng: ng, total: g.items.length };
  }

  function ckVisibleItems(gi) {
    var a = ckAnswers();
    var q = ($('ckSearch').value || '').trim();
    var g = CK_GROUPS[gi];
    return g.items.filter(function (it) {
      var r = a[it.id] && a[it.id].r;
      if (ckMeta.filter === 'todo' && r) return false;
      if (ckMeta.filter === 'ng' && r !== 'ng') return false;
      if (q) {
        var note = (a[it.id] && a[it.id].note) || '';
        if ((g.name + ' ' + it.text + ' ' + note).indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function ckItemHtml(it) {
    var a = ckAnswers();
    var r = (a[it.id] && a[it.id].r) || '';
    var note = (a[it.id] && a[it.id].note) || '';
    var nimg = ckHazardCount(it.no);
    var locked = ckLocked(it);
    var sel = !!ckSel[it.id];
    // 标为「不符合」或已有描述/照片时，自动展开问题描述与拍照
    var open = !!ckMeta.openItem[it.id] || r === 'ng' || !!note.trim() || nimg > 0;
    var lockTxt = nimg > 0 ? ('已拍 ' + nimg + ' 张，不能批量标合格')
      : (note.trim() ? '已写问题描述，不能批量标合格' : (r === 'ng' ? '已标不符合，不能批量标合格' : ''));
    var detail = '<div class="ck-detail' + (open ? '' : ' hidden') + '">' +
      '<textarea class="ck-note" data-note="' + it.id + '" placeholder="问题描述（选填）">' + C.escapeHtml(note) + '</textarea>' +
      '<div class="ck-dfoot"><button class="btn small" data-photo="' + it.id + '">📷 拍照</button>' +
      (nimg ? '<span>已拍 ' + nimg + ' 张</span>' : '') +
      (locked ? '<span class="ck-lock"' + (lockTxt ? ' title="' + C.escapeHtml(lockTxt) + '"' : '') + '>不符/已记录 · 不参与批量</span>' : '') +
      '</div></div>';
    return '<div class="ck-item' + (sel ? ' sel' : '') + '" data-id="' + it.id + '">' +
      (ckMeta.batch
        ? '<span class="ck-cb' + (locked ? ' lock' : '') + '">' + (sel ? '✓' : '') + '</span>'
        : '') +
      '<div class="ck-q" data-open="' + it.id + '"><b>' + it.no + '</b> ' + C.escapeHtml(it.text) + '</div>' +
      '<div class="ck-acts">' +
      '<button class="cbtn ok' + (r === 'ok' ? ' on' : '') + '" data-r="ok" data-id="' + it.id + '">✓</button>' +
      '<button class="cbtn ng' + (r === 'ng' ? ' on' : '') + '" data-r="ng" data-id="' + it.id + '">✗</button>' +
      '</div>' + detail + '</div>';
  }

  function ckGroupHeaderHtml(gi) {
    var g = CK_GROUPS[gi];
    var s = ckGroupStats(gi);
    var open = !!ckMeta.openGroup[gi];
    return '<button class="ck-gcard' + (open ? ' open' : '') + '" data-g="' + gi + '">' +
      '<span class="nm">' + C.escapeHtml(g.name) + '</span>' +
      '<span class="meta">' + s.done + '/' + s.total + (s.ng ? ' · 不符合 ' + s.ng : '') + '</span>' +
      '<span class="chev">' + (open ? '⌃' : '⌄') + '</span></button>' +
      '<div class="ck-gbody' + (open ? '' : ' hidden') + '" data-gbody="' + gi + '">' +
      (open ? ckGroupItemsHtml(gi) : '') + '</div>';
  }

  function ckGroupItemsHtml(gi) {
    var items = ckVisibleItems(gi);
    if (!items.length) return '<div class="ck-empty">没有符合条件的检查项</div>';
    return '<div class="ck-items">' + items.map(ckItemHtml).join('') + '</div>';
  }

  function renderChecklist() {
    var st = ckStats();
    var q = ($('ckSearch').value || '').trim();
    CK_FLAT.forEach(function (it) { if (ckSel[it.id] && ckLocked(it)) delete ckSel[it.id]; });
    var m = state.batch.meta;
    $('ckTitle').textContent = '检查清单';
    $('ckSub').innerHTML = '<span>' + C.escapeHtml(m.short_unit || m.unit || '未设置单位') + '</span>' +
      '<span class="dot">·</span><span>' + C.escapeHtml(m.check_date || '') + '</span>' +
      '<span class="dot">·</span><span>已检 ' + st.done + '/' + st.total + '</span>';
    $('ckNums').innerHTML =
      '<span class="k">已检 <b>' + st.done + '</b>/' + st.total + '</span>' +
      '<span class="k">合格 <b>' + st.ok + '</b></span>' +
      '<span class="k">不符合 <b>' + st.ng + '</b></span>' +
      '<span class="k">未检 <b>' + (st.total - st.done) + '</b></span>';
    $('ckBar').style.width = (st.total ? Math.round(st.done / st.total * 100) : 0) + '%';
    Array.prototype.forEach.call($('ckTabs').children, function (b) {
      b.classList.toggle('on', b.dataset.f === ckMeta.filter);
    });
    $('viewChecklist').classList.remove('ck-group-view');
    $('btnCkBatch').textContent = ckMeta.batch ? '完成' : '批量';

    var html = '';
    if (ckMeta.filter !== 'all' || !!q) {
      // 筛选/搜索时全部平铺，方便快速定位
      var flat = CK_GROUPS.map(function (g2, gi) {
        var its = ckVisibleItems(gi);
        if (!its.length) return '';
        return '<div class="ck-glabel">' + C.escapeHtml(g2.name) + '</div>' + its.map(ckItemHtml).join('');
      }).join('');
      html = '<div class="ck-items">' + (flat || '<div class="ck-empty">没有符合条件的检查项</div>') + '</div>';
    } else {
      // 手风琴：区域就地展开/收起
      html = CK_GROUPS.map(function (g2, gi) { return ckGroupHeaderHtml(gi); }).join('');
    }

    $('ckList').innerHTML = html;
    Array.prototype.forEach.call($('ckList').querySelectorAll('.ck-gcard'), function (b) {
      b.onclick = function () {
        var gi = Number(b.dataset.g);
        ckMeta.openGroup[gi] = !ckMeta.openGroup[gi];
        if (!ckMeta.openGroup[gi]) ckSel = {};
        renderChecklist();
        if (ckMeta.openGroup[gi]) {
          var body = document.querySelector('.ck-gbody[data-gbody="' + gi + '"]');
          if (body) {
            var head = b.getBoundingClientRect();
            if (head.top < 60) {
              try { body.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
            }
          }
        }
      };
    });
    var selN = Object.keys(ckSel).length;
    $('ckBulk').classList.toggle('hidden', !ckMeta.batch);
    $('ckBulkN').textContent = selN;
    $('ckBulkOk').classList.toggle('disabled', !selN);
  }

  function ckSetResult(id, r) {
    var a = ckAnswers();
    var it = null;
    CK_FLAT.forEach(function (x) { if (x.id === id) it = x; });
    if (!it) return;
    var cur = a[id] || { r: '', note: '' };
    cur.r = (cur.r === r) ? '' : r;
    a[id] = cur;
    // 点 ✗ 时展开描述框；点 ✓ 时收起（除非已有描述/照片）
    if (cur.r === 'ng') ckMeta.openItem[id] = true;
    ckSave();
    renderChecklist();
    if (cur.r === 'ng') {
      var ta = document.querySelector('.ck-item[data-id="' + id + '"] .ck-note');
      if (ta) { try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); } }
    }
  }

  // 多选模式下勾选/取消一条（锁定的不允许勾选）
  function ckToggleSelItem(id) {
    if (ckSel[id]) {
      delete ckSel[id];
      renderChecklist();
      return;
    }
    var it = null;
    CK_FLAT.forEach(function (x) { if (x.id === id) it = x; });
    if (it && ckLocked(it)) {
      toast('该项已标不符合或有照片/描述，不能批量标合格');
      return;
    }
    ckSel[id] = true;
    renderChecklist();
  }

  function ckSelectAllVisible() {
    var ids = [];
    var anyOpen = false;
    CK_GROUPS.forEach(function (g, gi) {
      if (ckMeta.filter === 'all' && !ckMeta.openGroup[gi]) return;   // 只选已展开区域
      anyOpen = anyOpen || !!ckMeta.openGroup[gi];
      ckVisibleItems(gi).forEach(function (it) { ids.push(it); });
    });
    if (!ids.length && ckMeta.filter === 'all') {
      // 没有展开任何区域时，退化为全选全部
      CK_GROUPS.forEach(function (g, gi) {
        ckVisibleItems(gi).forEach(function (it) { ids.push(it); });
      });
    }
    var unlocked = ids.filter(function (it) { return !ckLocked(it); });
    var all = unlocked.length && unlocked.every(function (it) { return ckSel[it.id]; });
    ckSel = {};
    if (!all) unlocked.forEach(function (it) { ckSel[it.id] = true; });
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
    ckMeta.batch = false;
    ckSave();
    renderChecklist();
    toast('已把 ' + ids.length + ' 项标为合格' + (skipped ? '，' + skipped + ' 项已有照片/描述已跳过' : ''));
  }

  // ---------------- 事件绑定 ----------------
  function bind() {
    $('btnMenu').addEventListener('click', openModuleMenu);
    $('btnEntryMenu').addEventListener('click', openEntryMenu);
    $('btnArchiveEntry').addEventListener('click', function () { openArchive(archiveKind || 'photo'); });
    $('btnChecksNew').addEventListener('click', function () { startNewCheck(state.moduleKind || 'photo'); });
    $('btnCheckSelAll').addEventListener('click', function () {
      var all = Array.prototype.slice.call($('checksList').querySelectorAll('.chk-card'));
      var every = all.length && all.every(function (c) { return checkSelMap[c.dataset.id]; });
      checkSelMap = {};
      if (!every) all.forEach(function (c) { checkSelMap[c.dataset.id] = true; });
      renderChecks();
    });
    $('btnCheckSelDelete').addEventListener('click', deleteCheckedChecks);
    $('btnCheckSelDone').addEventListener('click', function () {
      chkMulti = false;
      checkSelMap = {};
      renderChecks();
    });
    $('btnExportCkList').addEventListener('click', function () { exportOne('cklist'); });
    Array.prototype.forEach.call($('archiveTabs').children, function (b) {
      b.addEventListener('click', function () { archiveKind = b.dataset.f; renderArchive(); });
    });
    $('btnCkBatch').addEventListener('click', function () {
      ckMeta.batch = !ckMeta.batch;
      if (!ckMeta.batch) ckSel = {};
      renderChecklist();
    });
    $('ckEntry').addEventListener('click', function () {
      if (state.batch && isChecklistBatch(state.batch)) openChecklist();
      else toast('请先在「清单化检查」里开始一次检查');
    });
    $('ckSearch').addEventListener('input', function () { renderChecklist(); });
    $('ckTabs').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      ckMeta.filter = b.dataset.f;
      renderChecklist();
    });
    $('ckList').addEventListener('click', function (e) {
      var rb = e.target.closest('[data-r]');
      if (rb) { ckSetResult(rb.dataset.id, rb.dataset.r); return; }
      var pb = e.target.closest('[data-photo]');
      if (pb) {
        pendingCk = pb.dataset.photo;
        $('fileCamera').click();
        return;
      }
      var qb = e.target.closest('[data-open]');
      if (qb) {
        var id = qb.dataset.open;
        if (ckMeta.batch) {
          ckToggleSelItem(id);
          return;
        }
        ckMeta.openItem[id] = !ckMeta.openItem[id];
        renderChecklist();
        return;
      }
      var row = e.target.closest('.ck-item');
      if (row && ckMeta.batch && !e.target.closest('.ck-detail')) {
        ckToggleSelItem(row.dataset.id);
      }
    });
    $('ckBulkAll').addEventListener('click', ckSelectAllVisible);
    $('ckBulkOk').addEventListener('click', bulkMarkOk);
    $('ckBulkClear').addEventListener('click', function () {
      ckMeta.batch = false;
      ckSel = {};
      renderChecklist();
    });
    $('ckList').addEventListener('change', function (e) {
      if (!e.target.classList.contains('ck-note')) return;
      var id = e.target.dataset.note;
      var a = ckAnswers();
      if (!a[id]) a[id] = { r: 'ng', note: '' };
      a[id].note = e.target.value;
      if (a[id].note.trim() && !a[id].r) a[id].r = 'ng';
      ckSave();
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

    $('btnNew').addEventListener('click', function () {
      var btn = $('btnNew');
      if (btn.dataset.action === 'new') { startNewCheck(state.moduleKind || 'photo'); return; }
      quickCapture();
    });
    $('btnDone').addEventListener('click', function () { completeEditing(); });
    $('btnDeleteHazard').addEventListener('click', deleteCurrentHazard);
    $('btnSaveCfg').addEventListener('click', saveSetup);
    $('btnManage').addEventListener('click', function () { setSelecting(true); });
    $('btnSelAll').addEventListener('click', selectAllToggle);
    $('btnSelDelete').addEventListener('click', deleteSelected);
    $('btnSelDone').addEventListener('click', function () { setSelecting(false); });
    $('btnExportDocx').addEventListener('click', function () { exportOne('notice'); });
    $('btnExportStub').addEventListener('click', function () { exportOne('stub'); });
    $('btnExportPdf').addEventListener('click', function () { exportOne('pdf'); });
    $('btnExportZip').addEventListener('click', function () { exportOne('zip'); });
    $('btnExportSel').addEventListener('click', exportSelected);
    $('expAll').addEventListener('change', function () {
      var on = $('expAll').checked;
      Array.prototype.forEach.call(document.querySelectorAll('.exp-cb'), function (c) { c.checked = on; });
      updateExportSel();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.exp-cb'), function (c) {
      c.addEventListener('change', updateExportSel);
    });
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

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && state.editing) {
        saveEditing({ dropEmpty: false }).catch(function (e) { console.error(e); });
      }
    });

    Array.prototype.forEach.call($('phaseTabs').children, function (b) {
      b.addEventListener('click', async function () {
        if (!state.editing) return;
        var prev = state.editing.phase;
        if (prev === 'before' && b.dataset.phase === 'after') {
          await saveEditing({ dropEmpty: false });
          if (!state.editing) return;
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
      if (!$('mask').classList.contains('hidden')) { closeSheet(); return true; }
      var view = document.body.dataset.view;
      if (view === 'entry') return false;
      if (view === 'edit') { completeEditing(); return true; }
      if (state.selecting) { setSelecting(false); return true; }
      if (chkMulti) { chkMulti = false; checkSelMap = {}; renderChecks(); return true; }
      goUp();
      return true;
    } catch (e) { console.warn('SnapBack', e); }
    return false;
  };

  // 返回上一级：子页回工作台；工作台回入口；入口再按返回才退出
  function goUp() {
    if (backTo === 'export' && state.batch) { backTo = null; showView('home'); return; }
    backTo = null;
    var v = document.body.dataset.view;
    if (v === 'archive' || v === 'entry') { showView('entry'); return; }
    if (v === 'settings') {
      // 新建检查时返回 → 回该模块的检查列表
      if (state.setupReturn === 'checks' && (state.batch || state.moduleKind)) {
        state.setupReturn = '';
        if (state.editOnly) {
          state.editOnly = false;
          state.batch = state._editBackup || null;
          state._editBackup = null;
        }
        showView('checks');
        return;
      }
      if (state.defaultsMode) { state.defaultsMode = false; showView('entry'); return; }
    }
    if (v === 'checks') {
      if (chkMulti) { chkMulti = false; checkSelMap = {}; renderChecks(); return; }
      showView('entry');
      return;
    }
    if (v === 'home') {
      // 从检查列表进来的工作台，返回回检查列表
      if (state.wsBack === 'checks') { state.wsBack = ''; showView('checks'); return; }
      showView('entry');
      return;
    }
    if (state.batch) showView('home');
    else showView('entry');
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
