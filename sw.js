// 安裝測試版：不做任何快取，只保留一個「直接放行」的 fetch 處理，
// 並清掉舊版 service worker 留下的快取。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", () => {});
