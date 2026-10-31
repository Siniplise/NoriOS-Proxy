/* UNOFFICIAL local helper (added by QClaw) — 浏览器存档清理器（跟随「世界代号」自动清）
 *
 * 作用：把浏览器里这份游戏的本地存档清空，避免服务器已经重置了世界、
 *       但浏览器还留着上一次的邮件已读状态 / 打开着的浏览器标签页 / 窗口布局等残渣：
 *         localStorage + sessionStorage + IndexedDB + Cache Storage（含 sw.js 的 arcade-assets-v1）
 *
 * 触发方式：
 *   1) 自动：向代理要「世界代号」（/nori-world-gen，就是 day-1 包的 T0，每次重置 ColdOpen 都会变）。
 *      本地记的代号与服务器不一致 → 清一次并自动刷新；一致则什么都不做（不会每次刷新都清）。
 *   2) 手动：打开 http://127.0.0.1:4199/?fresh=1 强制清一次。
 *
 * 还原方式：删掉 index.html 里引用本文件的那一行即可（或直接删本文件）。
 */
(function () {
  "use strict";
  var MARK = "nori.fresh.done";
  var GENKEY = "nori.world.gen";
  var forced = /[?&]fresh=1(&|$)/.test(location.search);

  function cleanUrl() {
    return location.pathname + location.search.replace(/([?&])fresh=1(&|$)/, "$1").replace(/[?&]$/, "") + location.hash;
  }

  function wipeAll(done) {
    var jobs = [];
    try { localStorage.clear(); } catch (e) { console.warn("[nori-fresh-start] localStorage.clear 失败", e); }
    try { sessionStorage.clear(); } catch (e) {}
    try {
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (ks) {
          return Promise.all(ks.map(function (k) { return caches.delete(k); }));
        }));
      }
    } catch (e) {}
    try {
      if (window.indexedDB && indexedDB.databases) {
        jobs.push(indexedDB.databases().then(function (ds) {
          return Promise.all((ds || []).map(function (d) {
            if (!d || !d.name) return null;
            return new Promise(function (r) {
              var q = indexedDB.deleteDatabase(d.name);
              q.onsuccess = q.onerror = q.onblocked = function () { r(); };
            });
          }));
        }));
      }
    } catch (e) {}
    Promise.all(jobs).then(done, done);
  }

  fetch("/nori-world-gen", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (j) { return j && j.gen ? String(j.gen) : null; })
    .catch(function () { return null; })
    .then(function (gen) {
      var known = null;
      try { known = localStorage.getItem(GENKEY); } catch (e) {}
      var need = forced || (gen && known !== gen);
      if (!need) return;
      wipeAll(function () {
        try {
          localStorage.setItem(MARK, String(Date.now()));
          if (gen) localStorage.setItem(GENKEY, gen);
        } catch (e) {}
        try { history.replaceState(null, "", cleanUrl()); } catch (e) {}
        console.log("[nori-fresh-start] 世界代号=" + gen + "（本地=" + known + "），已清空浏览器存档，正在重新载入…");
        location.reload();
      });
    });
})();
