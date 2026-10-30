/* ============================================================
   CAMLAB 插件 · 我的照片（界面层）
   ------------------------------------------------------------
   在「拍摄模拟」的场景网格末尾加一张「上传照片」卡片：
     1. 选择照片 → 浏览器内压缩 → 存进 IndexedDB（不上传服务器）；
     2. 在工作台里登录打开时，经父页面桥接请 AI 识别场景参数；
        否则本地估算亮度 / 色温，并由用户选一个最接近的内置场景作为模板；
     3. 注册成和内置场景同结构的场景：CAMLIB.scenes / CAMSIM.SCENE_FOCUS / CAM_IMAGES。
   不改 CAMLAB 源码：原有的场景切换、景深、曝光、成片导出全部原样复用。

   依赖：user-photos-core.js、user-photos-store.js（构建时按顺序注入）。
   所有用户可控文本一律用 textContent 写入，不拼 innerHTML。
   ============================================================ */
(function (global) {
  'use strict';

  var CORE = global.CAMLAB_USER_PHOTOS_CORE;
  var STORE = global.CAMLAB_USER_PHOTOS_STORE;
  var L = global.CAMLIB, SIM = global.CAMSIM, C = global.CAMLAB, UI = global.CAMUI;
  if (!CORE || !STORE || !L || !SIM || !C || !global.CAM_IMAGES) {
    console.warn('[camlab] 我的照片插件未启用：缺少依赖');
    return;
  }

  var TEAL = '#2E8C7E';
  var builtinIds = L.scenes.map(function (s) { return s.id; });
  var records = {};          // id → IndexedDB 记录
  var busyText = '';         // 上传卡片上的处理状态

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 2600);
  }
  function inShoot() { return C.state && C.state.mode === 'shoot'; }
  function builtin(id) { return L.scenes.filter(function (s) { return s.id === id; })[0]; }

  /* ---------------- 桥接客户端（与工作台父页面） ---------------- */
  var bridge = { ai: false, connected: false };
  var pending = {};
  var embedded = global.parent && global.parent !== global;

  global.addEventListener('message', function (e) {
    if (!embedded || e.source !== global.parent || e.origin !== global.location.origin) return;
    var d = e.data || {};
    if (d.type === 'camlab:bridge') {
      bridge.connected = true;
      bridge.ai = d.ai === true;
    } else if (d.type === 'camlab:analyze:result' && pending[d.reqId]) {
      var p = pending[d.reqId];
      delete pending[d.reqId];
      clearTimeout(p.timer);
      d.ok ? p.resolve(d.data) : p.reject(new Error(d.error || 'AI 分析失败'));
    }
  });
  if (embedded) {
    try { global.parent.postMessage({ type: 'camlab:hello' }, global.location.origin); } catch (e) { /* 跨源嵌入：不桥接 */ }
  }

  function analyze(image) {
    return new Promise(function (resolve, reject) {
      if (!bridge.ai) { reject(new Error('未登录')); return; }
      var reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      pending[reqId] = {
        resolve: resolve, reject: reject,
        timer: setTimeout(function () {
          delete pending[reqId];
          reject(new Error('AI 分析超时'));
        }, 75000)
      };
      global.parent.postMessage({ type: 'camlab:analyze', reqId: reqId, image: image }, global.location.origin);
    });
  }

  /* ---------------- 场景注册 ---------------- */

  /**
   * 把一条记录注册成 CAMLAB 场景。三处必须同时写：
   *   scenes（列表与参数）、SCENE_FOCUS（切换场景时直接读取，缺了会抛错）、CAM_IMAGES（纹理与缩略图）。
   */
  function register(record) {
    var id = record.id;
    if (!CORE.isSafeId(id)) return;
    var scene = CORE.toScene(id, record);
    scene.img = id + '-t';                         // 卡片用缩略图，纹理用展示图
    // AI 生成的两条任务界面里没有地方显示，并进底部提示里，不丢信息。
    var p = CORE.sanitize(record.params);
    if (record.source === 'ai' && p.tasks.length) scene.tip = p.tip + ' 练习：' + p.tasks.join('；') + '。';

    var i = L.scenes.findIndex(function (s) { return s.id === id; });
    if (i >= 0) L.scenes[i] = scene; else L.scenes.push(scene);
    SIM.SCENE_FOCUS[id] = CORE.toFocus(record);
    // 练习任务借用最接近的内置场景：它们带自动判定（达成后打勾），AI 写的文字任务做不到。
    if (UI && UI.TASKS) {
      var tpl = builtinIds.indexOf(record.template) >= 0 ? record.template : CORE.nearestTemplate(record.params, L.scenes);
      UI.TASKS[id] = UI.TASKS[tpl] || [];
    }
    global.CAM_IMAGES[id] = STORE.urlFor(id, record.blob);
    global.CAM_IMAGES[scene.img] = STORE.urlFor(scene.img, record.thumbBlob || record.blob);
    records[id] = record;
  }

  function unregister(id) {
    var i = L.scenes.findIndex(function (s) { return s.id === id; });
    if (i >= 0) L.scenes.splice(i, 1);
    delete SIM.SCENE_FOCUS[id];
    if (UI && UI.TASKS) delete UI.TASKS[id];
    delete global.CAM_IMAGES[id];
    delete global.CAM_IMAGES[id + '-t'];
    STORE.releaseURL(id);
    STORE.releaseURL(id + '-t');
    delete records[id];
  }

  function refreshLeft() {
    if (inShoot() && UI && UI.leftShoot) UI.leftShoot();
  }

  /** 切到某个场景：点一下它的卡片，复用 CAMLAB 自己的切换流程。 */
  function selectScene(id) {
    var card = document.querySelector('.scene-card[data-id="' + id + '"]');
    if (card) card.click();
  }

  /* ---------------- 场景网格装饰（每次 leftShoot 重建后补回） ---------------- */
  function decorate() {
    var grid = document.querySelector('#leftPanel .scene-grid');
    if (!grid || grid.getAttribute('data-up-done') === '1') return;
    grid.setAttribute('data-up-done', '1');

    Array.prototype.forEach.call(grid.querySelectorAll('.scene-card'), function (card) {
      var id = card.getAttribute('data-id');
      if (!records[id] || card.classList.contains('up-mine')) return;   // 已装饰过（setBusy 会重跑）
      card.classList.add('up-mine');
      card.appendChild(el('span', 'up-badge', '我的'));
      var more = el('button', 'up-more', '⋯');
      more.type = 'button';
      more.title = '管理这张照片';
      more.addEventListener('click', function (e) {
        e.stopPropagation();                         // 不触发卡片的 set-scene
        openMenu(more, id);
      });
      card.appendChild(more);
    });

    var add = el('button', 'scene-card up-add' + (busyText ? ' up-busy' : ''));
    add.type = 'button';
    add.title = '上传自己的照片作为拍摄场景（只存在当前浏览器）';
    var icon = el('span', 'up-add-ic', busyText ? '' : '+');
    add.appendChild(icon);
    add.appendChild(el('span', 'up-add-tx', busyText || '上传照片'));
    add.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!busyText) pickFile();
    });
    grid.appendChild(add);
  }

  function setBusy(text) {
    busyText = text || '';
    var grid = document.querySelector('#leftPanel .scene-grid');
    if (grid) { grid.removeAttribute('data-up-done'); var old = grid.querySelector('.up-add'); if (old) old.remove(); }
    decorate();
  }

  var leftPanel = document.getElementById('leftPanel');
  if (leftPanel && global.MutationObserver) {
    new MutationObserver(function () { decorate(); }).observe(leftPanel, { childList: true, subtree: true });
  }

  /* ---------------- 上传流程 ---------------- */
  var fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);
  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) handleFile(file);
  });
  function pickFile() { fileInput.click(); }

  /** 本地估算时默认选的模板：按亮度粗分夜景 / 室内 / 风光。 */
  function guessTemplate(stats) {
    if (stats.lum < 0.16) return 'night';
    if (stats.lum < 0.32) return 'indoor';
    return 'landscape';
  }

  function handleFile(file) {
    var err = STORE.checkFile(file, Object.keys(records).length);
    if (err) { toast(err, 3200); return; }
    setBusy('处理中…');
    STORE.prepare(file).then(function (prep) {
      setBusy('');
      var stats = CORE.sampleStats(prep.pixels);
      var draft = {
        id: CORE.newId(),
        name: '', place: '',
        blob: prep.blob, thumbBlob: prep.thumbBlob,
        width: prep.width, height: prep.height,
        ratio: CORE.ratioOf(prep.width, prep.height),
        template: guessTemplate(stats),
        source: 'local',
        createdAt: Date.now()
      };
      openPanel({ mode: 'create', draft: draft, stats: stats, analysisImage: prep.analysisDataURL });
    }).catch(function (e) {
      setBusy('');
      console.error('[camlab] 处理照片失败', e);
      toast('这张照片读取失败，换一张试试', 3200);
    });
  }

  function save(record, isNew) {
    register(record);
    return STORE.put(record).then(function () {
      return STORE.isPersistent();
    }).then(function (ok) {
      if (!ok && isNew) toast('当前浏览器不允许本地存储，照片只保留到关闭页面', 3600);
    }).catch(function (e) {
      console.error('[camlab] 保存照片失败', e);
      toast('浏览器存储空间不足，这张照片只保留到关闭页面', 3600);
    }).then(function () {
      refreshLeft();
      selectScene(record.id);
    });
  }

  function removeRecord(id) {
    var wasCurrent = C.state.sceneId === id;
    unregister(id);
    STORE.remove(id).catch(function (e) { console.error('[camlab] 删除照片失败', e); });
    if (wasCurrent) selectScene(builtinIds[0]);   // 卡片还在 DOM 里，点它会触发重绘
    else refreshLeft();
    toast('已从素材库删除');
  }

  /* ---------------- 菜单 ---------------- */
  var menu = null;
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  document.addEventListener('click', function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  }, true);

  function openMenu(anchor, id) {
    closeMenu();
    menu = el('div', 'up-menu');
    function item(label, fn, disabled, title) {
      var b = el('button', 'up-menu-it', label);
      b.type = 'button';
      b.disabled = !!disabled;
      if (title) b.title = title;
      b.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); fn(); });
      menu.appendChild(b);
    }
    item('编辑名称与参数', function () { openPanel({ mode: 'edit', draft: records[id] }); });
    item('重新用 AI 分析', function () { openPanel({ mode: 'reanalyze', draft: records[id] }); },
      !bridge.ai, bridge.ai ? '' : '在工作台登录后可用');
    item('删除', function () {
      if (global.confirm('从素材库删除「' + (records[id].name || '我的照片') + '」？只删除本浏览器里的这张照片。')) removeRecord(id);
    });
    var r = anchor.getBoundingClientRect();
    menu.style.top = Math.min(r.bottom + 4, global.innerHeight - 130) + 'px';
    menu.style.left = Math.max(8, r.right - 150) + 'px';
    document.body.appendChild(menu);
  }

  /* ---------------- 确认面板 ---------------- */
  function openPanel(opts) {
    var src = opts.draft;
    var draft = {};
    Object.keys(src).forEach(function (k) { draft[k] = src[k]; });
    var stats = opts.stats || null;
    var analysisImage = opts.analysisImage || null;
    var analyzing = false, closed = false;
    var aiToken = 0;   // 用户点了「改用本地估算」后，迟到的 AI 结果要丢弃

    var mask = el('div', 'up-mask');
    var card = el('div', 'up-panel');
    mask.appendChild(card);

    var head = el('div', 'up-head');
    head.appendChild(el('div', 'up-title', opts.mode === 'create' ? '加入我的素材库' : '编辑我的照片'));
    var badge = el('span', 'up-src');
    head.appendChild(badge);
    card.appendChild(head);

    var preview = el('div', 'up-preview');
    var img = el('img');
    img.alt = '';
    img.src = STORE.urlFor('panel-preview', draft.thumbBlob || draft.blob);
    preview.appendChild(img);
    var veil = el('div', 'up-veil');
    veil.appendChild(el('span', 'up-spin'));
    var veilText = el('span', '', 'AI 正在识别场景…');
    veil.appendChild(veilText);
    preview.appendChild(veil);
    card.appendChild(preview);

    function field(label, value, max, placeholder) {
      var wrap = el('label', 'up-field');
      wrap.appendChild(el('span', 'up-label', label));
      var input = el('input', 'up-input');
      input.maxLength = max;
      input.value = value || '';
      input.placeholder = placeholder;
      wrap.appendChild(input);
      card.appendChild(wrap);
      return input;
    }
    var nameInput = field('名称', draft.name, 16, '例如：街头 · 雨夜');
    var placeInput = field('地点与光线', draft.place, 32, '例如：老城巷子，雨后路灯');

    var tplWrap = el('div', 'up-field');
    tplWrap.appendChild(el('span', 'up-label', '最接近的场景类型（决定对焦距离、景深与练习任务）'));
    var chips = el('div', 'up-chips');
    tplWrap.appendChild(chips);
    card.appendChild(tplWrap);
    builtinIds.forEach(function (bid) {
      var b = el('button', 'up-chip', builtin(bid).short);
      b.type = 'button';
      b.setAttribute('data-tpl', bid);
      b.addEventListener('click', function () { draft.template = bid; if (draft.source === 'local') applyLocal(); paint(); });
      chips.appendChild(b);
    });

    var summary = el('div', 'up-summary');
    card.appendChild(summary);
    var hint = el('div', 'up-hint');
    card.appendChild(hint);

    var foot = el('div', 'up-foot');
    var skip = el('button', 'up-btn up-ghost', '改用本地估算');
    skip.type = 'button';
    var cancel = el('button', 'up-btn up-ghost', '取消');
    cancel.type = 'button';
    var ok = el('button', 'up-btn up-primary', opts.mode === 'create' ? '加入素材库' : '保存');
    ok.type = 'button';
    foot.appendChild(skip); foot.appendChild(cancel); foot.appendChild(ok);
    card.appendChild(foot);

    /** 本地估算：模板给对焦与景深，像素给 EV 与色温。编辑模式没有像素时保留原 EV / 色温。 */
    function applyLocal() {
      var t = builtin(draft.template) || builtin(builtinIds[0]);
      var fresh = CORE.fromLocal(stats || { lum: 0.5, r: 0.5, b: 0.5 }, t, SIM.SCENE_FOCUS[t.id]);
      if (!stats && draft.params) { fresh.ev100 = draft.params.ev100; fresh.kelvin = draft.params.kelvin; }
      draft.params = fresh;
      draft.source = 'local';
      if (!nameInput.value.trim()) nameInput.value = '我的 · ' + t.short;
      if (!placeInput.value.trim()) placeInput.value = t.place.slice(0, 32);
    }

    function paint() {
      var p = CORE.sanitize(draft.params);
      badge.textContent = analyzing ? 'AI 分析中' : draft.source === 'ai' ? 'AI 分析' : '本地估算';
      badge.className = 'up-src ' + (analyzing || draft.source === 'ai' ? 'is-ai' : 'is-local');
      veil.style.display = analyzing ? 'flex' : 'none';
      Array.prototype.forEach.call(chips.children, function (c) {
        c.classList.toggle('on', c.getAttribute('data-tpl') === draft.template);
      });
      tplWrap.style.display = draft.source === 'ai' && !analyzing ? 'none' : '';
      summary.textContent = draft.params
        ? 'EV ' + p.ev100.toFixed(1) + ' · ' + p.kelvin + 'K · ' + (p.depth_mode ? '近景主体' : '远景全景') +
          ' · 主体 ' + (p.subject_mm >= 1000 ? (p.subject_mm / 1000).toFixed(1) + ' m' : Math.round(p.subject_mm) + ' mm')
        : '';
      hint.textContent = analyzing ? '约 5–15 秒。也可以直接改用本地估算。'
        : draft.source === 'ai' ? (p.tip || '')
        : bridge.ai ? '本地估算：亮度推算曝光、冷暖推算色温；也可以重新用 AI 分析。'
        : '本地估算：亮度推算曝光、冷暖推算色温。在工作台登录后打开，会用 AI 自动识别。';
      skip.style.display = analyzing ? '' : 'none';
      ok.disabled = analyzing;
    }

    function runAI(image) {
      var token = ++aiToken;
      analyzing = true; paint();
      analyze(image).then(function (data) {
        if (closed || token !== aiToken) return;
        draft.params = CORE.sanitize(data);
        draft.source = 'ai';
        draft.template = CORE.nearestTemplate(draft.params, L.scenes);
        if (!nameInput.value.trim() || opts.mode === 'reanalyze') nameInput.value = draft.params.name || nameInput.value;
        if (!placeInput.value.trim() || opts.mode === 'reanalyze') placeInput.value = draft.params.place || placeInput.value;
      }).catch(function (e) {
        if (closed || token !== aiToken) return;
        console.warn('[camlab] AI 分析失败，改用本地估算', e);
        toast((e && e.message ? e.message : 'AI 分析失败') + '，已改用本地估算', 3600);
        if (!draft.params || draft.source !== 'ai') applyLocal();
      }).then(function () {
        if (token !== aiToken) return;
        analyzing = false;
        if (!closed) paint();
      });
    }

    function close() {
      closed = true;
      STORE.releaseURL('panel-preview');
      document.removeEventListener('keydown', onKey, true);
      mask.classList.add('out');
      setTimeout(function () { mask.remove(); }, 160);
    }
    function submit() {
      if (analyzing) return;
      draft.name = nameInput.value.trim().slice(0, 16) || '我的照片';
      draft.place = placeInput.value.trim().slice(0, 32);
      if (!draft.params) applyLocal();
      close();
      save(draft, opts.mode === 'create').then(function () {
        toast(opts.mode === 'create' ? '已加入素材库，可以开始拍了' : '已保存');
      });
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    }

    skip.addEventListener('click', function () { aiToken++; analyzing = false; applyLocal(); paint(); });
    cancel.addEventListener('click', close);
    ok.addEventListener('click', submit);
    mask.addEventListener('click', function (e) { if (e.target === mask && !analyzing) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(mask);

    // 首次进入：能用 AI 就分析，否则本地估算。
    if (opts.mode === 'create') {
      if (bridge.ai && analysisImage) runAI(analysisImage); else applyLocal();
    } else if (opts.mode === 'reanalyze') {
      STORE.analysisImage(draft.blob).then(runAI).catch(function () { toast('读取照片失败'); });
    }
    paint();
    setTimeout(function () { nameInput.focus(); }, 60);
  }

  /* ---------------- 样式 ---------------- */
  var css = [
    '.up-add{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:1px dashed var(--line-strong);background:linear-gradient(180deg,#fbfbf9,#f3f3ef);color:var(--ink-3);font:inherit;padding:0}',
    '.up-add:hover{border-color:' + TEAL + ';color:' + TEAL + ';background:#f2f8f6}',
    '.up-add-ic{font-size:22px;line-height:1;font-weight:300;transition:transform .18s}',
    '.up-add:hover .up-add-ic{transform:translateY(-2px)}',
    '.up-add-tx{font-size:11px;font-weight:600;letter-spacing:.02em}',
    '.up-busy{cursor:progress;color:' + TEAL + '}',
    '.up-busy .up-add-ic{width:18px;height:18px;border:2px solid rgba(46,140,126,.25);border-top-color:' + TEAL + ';border-radius:50%;animation:up-rot .8s linear infinite}',
    '.up-mine{animation:up-in .18s ease-out}',
    '.up-badge{position:absolute;left:5px;top:5px;padding:1px 6px;border-radius:9px;background:' + TEAL + ';color:#fff;font-size:9.5px;font-weight:700;letter-spacing:.04em;box-shadow:0 1px 3px rgba(0,0,0,.25)}',
    '.up-more{position:absolute;right:4px;top:4px;width:22px;height:22px;border-radius:6px;border:0;background:rgba(10,12,16,.55);color:#fff;font-size:14px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s,background .15s}',
    '.scene-card:hover .up-more,.up-more:focus{opacity:1}.up-more:hover{background:rgba(10,12,16,.8)}',
    '.up-menu{position:fixed;z-index:120;width:150px;padding:4px;border-radius:9px;background:#fff;border:1px solid var(--line);box-shadow:0 12px 32px -8px rgba(20,22,26,.28);animation:up-in .14s ease-out}',
    '.up-menu-it{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;background:none;font:inherit;font-size:12px;color:var(--ink);cursor:pointer}',
    '.up-menu-it:hover:not(:disabled){background:#f2f2ee}.up-menu-it:disabled{color:var(--ink-3);cursor:not-allowed}',
    '.up-menu-it:last-child{color:var(--red)}',
    '.up-mask{position:fixed;inset:0;z-index:110;display:grid;place-items:center;padding:16px;background:rgba(8,10,13,.55);backdrop-filter:blur(3px);animation:up-fade .16s ease-out}',
    '.up-mask.out{opacity:0;transition:opacity .16s}',
    '.up-panel{width:420px;max-width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:16px;border-radius:14px;background:linear-gradient(180deg,#161b23,#0f1318);color:#e8eef0;border:1px solid rgba(255,255,255,.08);box-shadow:0 24px 60px -12px rgba(0,0,0,.6);animation:up-pop .18s ease-out}',
    '.up-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}',
    '.up-title{font-size:15px;font-weight:600;letter-spacing:.01em}',
    '.up-src{padding:2px 8px;border-radius:10px;font-size:10.5px;font-weight:600}',
    '.up-src.is-ai{background:rgba(46,140,126,.18);color:#7fd1c3;border:1px solid rgba(46,140,126,.45)}',
    '.up-src.is-local{background:rgba(255,255,255,.06);color:#a7b3ba;border:1px solid rgba(255,255,255,.12)}',
    '.up-preview{position:relative;aspect-ratio:16/10;border-radius:10px;overflow:hidden;background:#080a0d;border:1px solid rgba(255,255,255,.06);margin-bottom:12px}',
    '.up-preview img{width:100%;height:100%;object-fit:contain;display:block}',
    '.up-veil{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:linear-gradient(180deg,rgba(8,10,13,.35),rgba(8,10,13,.75));font-size:12px;color:#cfe9e3}',
    '.up-spin{width:22px;height:22px;border:2px solid rgba(127,209,195,.25);border-top-color:#7fd1c3;border-radius:50%;animation:up-rot .8s linear infinite}',
    '.up-field{display:block;margin-bottom:10px}',
    '.up-label{display:block;margin-bottom:5px;font-size:11px;color:#a7b3ba}',
    '.up-input{width:100%;height:32px;padding:0 10px;border-radius:7px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#e8eef0;font:inherit;font-size:12.5px;outline:none;transition:border-color .15s,background .15s}',
    '.up-input:focus{border-color:#52a898;background:rgba(255,255,255,.07)}',
    '.up-chips{display:flex;flex-wrap:wrap;gap:5px}',
    '.up-chip{padding:3px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.12);background:none;color:#a7b3ba;font:inherit;font-size:11px;cursor:pointer;transition:.15s}',
    '.up-chip:hover{border-color:rgba(255,255,255,.3);color:#e8eef0}',
    '.up-chip.on{border-color:#52a898;background:rgba(46,140,126,.22);color:#e8eef0}',
    '.up-summary{margin:4px 0 6px;padding:7px 10px;border-radius:7px;background:rgba(255,255,255,.04);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#cfe9e3;font-variant-numeric:tabular-nums}',
    '.up-hint{min-height:18px;font-size:11.5px;line-height:1.6;color:#6e7b83}',
    '.up-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
    '.up-btn{height:32px;padding:0 14px;border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer;transition:.15s}',
    '.up-ghost{border:1px solid rgba(255,255,255,.14);background:none;color:#a7b3ba}.up-ghost:hover{color:#e8eef0;border-color:rgba(255,255,255,.3)}',
    '.up-primary{border:0;background:linear-gradient(180deg,#36a091,#2e8c7e);color:#fff;font-weight:600;box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}',
    '.up-primary:hover:not(:disabled){filter:brightness(1.08)}.up-primary:disabled{opacity:.45;cursor:not-allowed}',
    '@keyframes up-rot{to{transform:rotate(360deg)}}',
    '@keyframes up-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
    '@keyframes up-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes up-pop{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}'
  ].join('\n');
  var style = el('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ---------------- 启动：等 CAMLAB 自己 boot 完，再把已存照片注册进来 ---------------- */
  var booted = new Promise(function (resolve) {
    function later() { setTimeout(resolve, 0); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later);
    else later();
  });
  Promise.all([booted, STORE.list()]).then(function (res) {
    res[1].forEach(function (record) {
      if (CORE.isSafeId(record.id) && record.blob) register(record);
    });
    refreshLeft();
    decorate();
  }).catch(function (e) {
    console.error('[camlab] 读取我的照片失败', e);
  });
})(window);
