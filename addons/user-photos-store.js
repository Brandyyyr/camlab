/* ============================================================
   CAMLAB 插件 · 我的照片 —— 存储与图片处理（浏览器端）
   ------------------------------------------------------------
   照片只存在当前浏览器的 IndexedDB（按 /works/camlab 的来源隔离），
   不上传服务器。IndexedDB 不可用（隐私模式等）时退化为内存存储：
   本次会话能用，刷新后消失，界面会提示。
   挂在 window.CAMLAB_USER_PHOTOS_STORE 上。
   ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'camlab-user-photos';
  var STORE = 'photos';
  var DB_VERSION = 1;

  /** 展示图：长边 2400，足够取景放大；分析图：长边 1024，只用于发给 AI，不存。 */
  var DISPLAY_EDGE = 2400, DISPLAY_QUALITY = 0.9;
  var ANALYSIS_EDGE = 1024, ANALYSIS_QUALITY = 0.8;
  var THUMB_EDGE = 360;

  var MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  var MAX_PHOTOS = 30;
  var ACCEPT = /^image\/(jpeg|png|webp)$/;

  var memory = {};      // IndexedDB 不可用时的兜底
  var dbPromise = null;
  var persistent = true;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      if (!global.indexedDB) { persistent = false; resolve(null); return; }
      var req;
      try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { persistent = false; resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { console.warn('[camlab] IndexedDB 不可用，照片只保留到本次会话', req.error); persistent = false; resolve(null); };
      req.onblocked = function () { persistent = false; resolve(null); };
    });
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode);
      var store = t.objectStore(STORE);
      var out = fn(store);
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('事务中止')); };
    });
  }

  function list() {
    return openDB().then(function (db) {
      if (!db) return Object.keys(memory).map(function (k) { return memory[k]; });
      return tx(db, 'readonly', function (s) { return s.getAll(); });
    }).then(function (rows) {
      return (rows || []).sort(function (a, b) { return a.createdAt - b.createdAt; });
    });
  }

  function put(record) {
    return openDB().then(function (db) {
      if (!db) { memory[record.id] = record; return; }
      return tx(db, 'readwrite', function (s) { s.put(record); });
    });
  }

  function remove(id) {
    return openDB().then(function (db) {
      if (!db) { delete memory[id]; return; }
      return tx(db, 'readwrite', function (s) { s.delete(id); });
    });
  }

  /** 校验所选文件：类型、大小。返回错误文案或空串。 */
  function checkFile(file, existingCount) {
    if (!file) return '没有选择文件';
    if (existingCount >= MAX_PHOTOS) return '素材库最多 ' + MAX_PHOTOS + ' 张照片，请先删除一些';
    if (!ACCEPT.test(file.type || '')) {
      if (/heic|heif/i.test(file.type || file.name || '')) return 'HEIC 格式浏览器无法直接读取，请先导出为 JPG';
      return '只支持 JPG、PNG、WebP 格式';
    }
    if (file.size > MAX_SOURCE_BYTES) return '照片超过 20MB，请先压缩一下';
    return '';
  }

  /** 把文件解码成可绘制的图像。优先 createImageBitmap（会处理 EXIF 方向）。 */
  function decode(file) {
    if (global.createImageBitmap) {
      return global.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () {
        return decodeViaImg(file);
      });
    }
    return decodeViaImg(file);
  }
  function decodeViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
      img.src = url;
    });
  }

  function sizeOf(src) {
    return { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height };
  }

  /** 按长边缩放到 canvas。 */
  function draw(src, edge) {
    var s = sizeOf(src);
    var scale = Math.min(1, edge / Math.max(s.w, s.h));
    var w = Math.max(1, Math.round(s.w * scale)), h = Math.max(1, Math.round(s.h * scale));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return cv;
  }

  function toBlob(cv, quality) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('图片编码失败')); }, 'image/jpeg', quality);
    });
  }

  /** 64×64 采样像素，供本地估算亮度与色温。 */
  function samplePixels(src) {
    var cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    var ctx = cv.getContext('2d');
    ctx.drawImage(src, 0, 0, 64, 64);
    return ctx.getImageData(0, 0, 64, 64).data;
  }

  /**
   * 处理一张照片：产出展示图、缩略图（存）与分析图（不存），以及采样像素。
   */
  function prepare(file) {
    return decode(file).then(function (src) {
      var s = sizeOf(src);
      var display = draw(src, DISPLAY_EDGE);
      var thumb = draw(src, THUMB_EDGE);
      var analysis = draw(src, ANALYSIS_EDGE);
      var pixels = samplePixels(src);
      if (src.close) src.close();
      return Promise.all([toBlob(display, DISPLAY_QUALITY), toBlob(thumb, 0.82)]).then(function (blobs) {
        return {
          width: s.w, height: s.h,
          blob: blobs[0], thumbBlob: blobs[1],
          analysisDataURL: analysis.toDataURL('image/jpeg', ANALYSIS_QUALITY),
          pixels: pixels
        };
      });
    });
  }

  /** 从已存的展示图重新生成分析图（重新分析时用）。 */
  function analysisImage(blob) {
    return decode(blob).then(function (src) {
      var cv = draw(src, ANALYSIS_EDGE);
      if (src.close) src.close();
      return cv.toDataURL('image/jpeg', ANALYSIS_QUALITY);
    });
  }

  /** 统一管理 objectURL：替换或删除时释放，页面关闭时全部释放。 */
  var urls = {};
  function urlFor(key, blob) {
    if (urls[key]) URL.revokeObjectURL(urls[key]);
    urls[key] = URL.createObjectURL(blob);
    return urls[key];
  }
  function releaseURL(key) {
    if (urls[key]) { URL.revokeObjectURL(urls[key]); delete urls[key]; }
  }
  global.addEventListener('pagehide', function () {
    Object.keys(urls).forEach(releaseURL);
  });

  global.CAMLAB_USER_PHOTOS_STORE = {
    MAX_PHOTOS: MAX_PHOTOS,
    isPersistent: function () { return openDB().then(function () { return persistent; }); },
    list: list, put: put, remove: remove,
    checkFile: checkFile, prepare: prepare, analysisImage: analysisImage,
    urlFor: urlFor, releaseURL: releaseURL
  };
})(window);
