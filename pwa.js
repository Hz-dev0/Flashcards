// PWA：註冊 service worker、安裝按鈕。刻意獨立於 app.js。
let deferred = null;   // Chrome 的 beforeinstallprompt 事件

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    // 載入完後，把這次用到的資源交給 service worker 補進離線快取
    navigator.serviceWorker.ready.then((reg) => {
      setTimeout(() => {
        const urls = [location.href.split("#")[0], ...performance.getEntriesByType("resource").map((r) => r.name)];
        reg.active?.postMessage({ type: "warm", urls });
      }, 2500);
    }).catch(() => {});
  });
}

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; syncInstall(); });
window.addEventListener("appinstalled", () => { deferred = null; syncInstall(); });

function syncInstall() {
  const b = document.getElementById("s-install");
  if (b) b.hidden = !deferred;
}

const install = document.getElementById("s-install");
if (install) install.onclick = async () => {
  if (!deferred) return;
  deferred.prompt();
  try { await deferred.userChoice; } catch {}
  deferred = null;
  syncInstall();
};
syncInstall();
