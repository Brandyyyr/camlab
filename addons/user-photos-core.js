/* ============================================================
   CAMLAB 插件 · 我的照片 —— 纯计算部分（无 DOM，可在 node 里单测）
   ------------------------------------------------------------
   这里只放「给定像素 / 参数，算出场景」的逻辑：
     - 本地估算：平均亮度 → EV，R/B 比 → 色温；
     - 模板合并：用户选的内置场景提供对焦 / 景深参数；
     - AI 结果 → CAMLAB 场景对象与 SCENE_FOCUS 的映射与夹取。
   挂在 window.CAMLAB_USER_PHOTOS_CORE 上，供 user-photos.js 使用。
   ============================================================ */
(function (root) {
  'use strict';

  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || !isFinite(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }
  function round1(v) { return Math.round(v * 10) / 10; }

  /**
   * 从 RGBA 像素（Uint8ClampedArray / 数组）统计平均亮度与 R、B 均值。
   * 跳过近乎全黑和全白的像素：它们分别是死黑与过曝，不代表场景的光色。
   */
  function sampleStats(data) {
    var n = 0, lum = 0, r = 0, b = 0, allN = 0, allLum = 0;
    for (var i = 0; i + 3 < data.length; i += 4) {
      var R = data[i] / 255, G = data[i + 1] / 255, B = data[i + 2] / 255;
      var L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      allN++; allLum += L;
      if (L < 0.03 || L > 0.97) continue;
      n++; lum += L; r += R; b += B;
    }
    if (!allN) return { lum: 0.5, r: 0.5, b: 0.5 };
    if (!n) return { lum: allLum / allN, r: 0.5, b: 0.5 };
    return { lum: allLum / allN, r: r / n, b: b / n };
  }

  /**
   * 亮度 → EV100 的经验映射。
   *
   * 照片已经被拍摄者曝光过，像素亮度不等于现场亮度；
   * 所以只给一个粗估，再向模板场景的 EV 拉近（权重 0.6 给模板）——
   * 模板来自用户「这是夜景 / 这是室内」的判断，比像素更可靠。
   */
  function estimateEV(lum, templateEV) {
    var fromPixels = clamp(3 + 12 * Math.pow(clamp(lum, 0, 1), 0.7), 2, 16);
    if (typeof templateEV !== 'number') return round1(fromPixels);
    var blended = templateEV * 0.6 + fromPixels * 0.4;
    return round1(clamp(blended, templateEV - 2, templateEV + 2));
  }

  /** R/B 比 → 色温：偏暖（R 高）→ 低 K，偏冷（B 高）→ 高 K。 */
  function estimateKelvin(r, b) {
    var ratio = clamp(r, 0.01, 1) / clamp(b, 0.01, 1);
    var k = 6500 - 2600 * Math.log(ratio);
    return Math.round(clamp(k, 2700, 9500) / 100) * 100;
  }

  /** 场景比例（宽 / 高），限制在模拟器画框能承受的范围。 */
  function ratioOf(width, height) {
    if (!width || !height) return 1.5;
    return Math.round(clamp(width / height, 0.5, 2.4) * 1000) / 1000;
  }

  /** 夹取主体区域，保证宽高 ≥ 0.2 且不出画面。 */
  function clampRegion(region) {
    var r = Array.isArray(region) && region.length === 4 ? region : [0.5, 0.5, 0.6, 0.6];
    var w = clamp(r[2], 0.2, 1), h = clamp(r[3], 0.2, 1);
    return [clamp(r[0], w / 2, 1 - w / 2), clamp(r[1], h / 2, 1 - h / 2), w, h];
  }

  /**
   * 统一的「参数」结构（与后端 CamlabSceneResult 同名字段），存进 IndexedDB。
   * 本地估算与 AI 结果都先转成它，再由 toScene / toFocus 映射为 CAMLAB 的内部结构。
   */
  function fromLocal(stats, template, templateFocus) {
    var t = template || {}, f = templateFocus || {};
    return {
      name: '', place: '',
      ev100: estimateEV(stats.lum, t.ev100),
      kelvin: estimateKelvin(stats.r, stats.b),
      depth_mode: t.depthMode === 1 ? 1 : 0,
      subject_mm: f.subject || t.subject || 5000,
      fg_mm: f.fg || 1500,
      bg_mm: f.bg || 60000,
      region: clampRegion(f.region),
      motion: typeof f.motion === 'number' ? f.motion : 0.5,
      vignette: typeof f.vignette === 'number' ? f.vignette : 0.3,
      tip: t.tip || '这是你自己的照片：先用标准曝光拍一张，再试着调光圈、快门看看变化。',
      tasks: (t.tasks && t.tasks.length >= 2) ? t.tasks.slice(0, 2) : [
        '先按标准曝光拍一张作为对照', '换一个光圈再拍，比较景深的变化'
      ]
    };
  }

  /** 再夹取一遍：AI 结果后端已校验，但 IndexedDB 里的旧数据或手改数据也要兜底。 */
  function sanitize(p) {
    p = p || {};
    var subject = clamp(p.subject_mm, 300, 2000000);
    var fg = clamp(Math.min(p.fg_mm || subject * 0.6, subject), 300, 2000000);
    var bg = clamp(Math.max(p.bg_mm || subject * 4, subject * 1.2), 300, 2000000);
    var tasks = (Array.isArray(p.tasks) ? p.tasks : []).filter(function (t) {
      return typeof t === 'string' && t.trim();
    }).slice(0, 2);
    while (tasks.length < 2) tasks.push(tasks.length ? '换一个光圈再拍，比较景深的变化' : '先按标准曝光拍一张作为对照');
    return {
      name: String(p.name || '').slice(0, 16),
      place: String(p.place || '').slice(0, 32),
      ev100: round1(clamp(p.ev100, -2, 17)),
      kelvin: Math.round(clamp(p.kelvin, 2500, 10000)),
      depth_mode: p.depth_mode === 1 ? 1 : 0,
      subject_mm: subject, fg_mm: fg, bg_mm: bg,
      region: clampRegion(p.region),
      motion: clamp(p.motion, 0, 3),
      vignette: clamp(typeof p.vignette === 'number' && p.vignette > 0 ? p.vignette : 0.3, 0.1, 0.5),
      tip: String(p.tip || '').slice(0, 90),
      tasks: tasks
    };
  }

  /**
   * 参数 → CAMLAB 场景对象（与内置 scenes 同结构）。
   * depthNear / depthFar 取前景与背景距离：景深模拟按这两端插值。
   */
  function toScene(id, record) {
    var p = sanitize(record.params);
    var name = String(record.name || p.name || '我的照片').slice(0, 16);
    return {
      id: id, img: id, user: true,
      name: name,
      short: name.split(/[·・\s]/)[0].slice(0, 6) || '我的',
      depthMode: p.depth_mode, depthNear: p.fg_mm, depthFar: p.bg_mm,
      subject: p.subject_mm,
      ev100: p.ev100, kelvin: p.kelvin,
      ratio: record.ratio || 1.5,
      place: String(record.place || p.place || '你上传的照片').slice(0, 32),
      tip: p.tip, tasks: p.tasks
    };
  }

  /** 参数 → SIM.SCENE_FOCUS 条目。 */
  function toFocus(record) {
    var p = sanitize(record.params);
    return { subject: p.subject_mm, bg: p.bg_mm, fg: p.fg_mm, region: p.region, motion: p.motion, vignette: p.vignette };
  }

  /**
   * 找参数最接近的内置场景：EV 差为主，景深模式不同加罚分。
   * 用来给自定义场景挂一套「可自动判定」的练习任务（CAMLAB 的 TASKS 带判定函数）。
   */
  function nearestTemplate(params, scenes) {
    var p = sanitize(params), best = null, bestScore = Infinity;
    (scenes || []).forEach(function (s) {
      if (s.user) return;
      var score = Math.abs((s.ev100 || 0) - p.ev100) + ((s.depthMode === 1 ? 1 : 0) !== p.depth_mode ? 3 : 0) +
        Math.abs((s.kelvin || 5500) - p.kelvin) / 2000;
      if (score < bestScore) { bestScore = score; best = s.id; }
    });
    return best;
  }

  /** 生成只含安全字符的场景 id（会被 CAMLAB 原样拼进 data-id 属性）。 */
  function newId() {
    var s = '';
    for (var i = 0; i < 10; i++) s += Math.floor(Math.random() * 36).toString(36);
    return 'user-' + Date.now().toString(36) + s;
  }
  function isSafeId(id) { return typeof id === 'string' && /^user-[a-z0-9]{4,40}$/.test(id); }

  root.CAMLAB_USER_PHOTOS_CORE = {
    clamp: clamp, sampleStats: sampleStats, estimateEV: estimateEV, estimateKelvin: estimateKelvin,
    ratioOf: ratioOf, clampRegion: clampRegion, fromLocal: fromLocal, sanitize: sanitize,
    toScene: toScene, toFocus: toFocus, nearestTemplate: nearestTemplate, newId: newId, isSafeId: isSafeId
  };
})(typeof window !== 'undefined' ? window : globalThis);
