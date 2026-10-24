// 離線快取：
//  - 開啟頁面：有網路就拿最新的（超過 4 秒沒回應或離線才用快取），所以更新後下次開啟自動換新版。
//  - 程式檔（app.js?v=…、style.css?v=… 等）與 Firebase SDK：先用快取，背景再更新。
//  - Firestore／登入等其他連線一律不碰，照常走網路（資料本身由 Firestore 自己的離線快取處理）。
// 改了檔案請照舊把 index.html 裡的 ?v= 加 1；想強制全部重抓就把下面的 VER 加 1。
const VER = "1";
const CACHE = "wc-shell-" + VER;
const SCOPE = self.registration.scope;

const cacheable = (u) =>
  u.origin === location.origin || (u.origin === "https://www.gstatic.com" && u.pathname.startsWith("/firebasejs/"));

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同一個檔案只留最新的 ?v= 版本，避免快取越積越多
async function put(cache, req, res) {
  await cache.put(req, res);
  const u = new URL(req.url);
  if (u.origin !== location.origin || !u.search) return;
  for (const k of await cache.keys()) {
    const ku = new URL(k.url);
    if (ku.pathname === u.pathname && ku.search !== u.search) await cache.delete(k);
  }
}

async function navigate(req) {
  const cache = await caches.open(CACHE);
  const net = fetch(req).then((r) => { if (r.ok) put(cache, req, r.clone()); return r; });
  net.catch(() => {});
  const fallback = async () => (await cache.match(req, { ignoreSearch: true })) || (await cache.match(SCOPE)) || (await cache.match(SCOPE + "index.html"));
  try {
    return await Promise.race([net, new Promise((_, rej) => setTimeout(rej, 4000))]);
  } catch {
    return (await fallback()) || net;
  }
}

async function asset(req, swr) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const refresh = () => fetch(req).then((r) => { if (r.ok) put(cache, req, r.clone()); return r; });
  if (hit) { if (swr) refresh().catch(() => {}); return hit; }
  return refresh();
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (!cacheable(u)) return;
  if (req.mode === "navigate") { e.respondWith(navigate(req)); return; }
  e.respondWith(asset(req, u.origin === location.origin));
});

// 頁面載入後，把這次用到的所有資源（含 Firebase 模組）補進快取，第一次開啟後就能離線使用
self.addEventListener("message", (e) => {
  if (e.data?.type !== "warm") return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of e.data.urls || []) {
      try {
        const u = new URL(url);
        if (!cacheable(u)) continue;
        const req = new Request(u.href);
        if (await cache.match(req)) continue;
        const r = await fetch(req);
        if (r.ok) await put(cache, req, r);
      } catch {}
    }
  })());
});
