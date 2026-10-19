// PWA：註冊 service worker、安裝按鈕、安裝診斷。刻意獨立於 app.js，
// 這樣就算 app.js 載入失敗，也能在設定頁看出為什麼不能安裝。
let deferred = null;   // Chrome 的 beforeinstallprompt 事件
let swError = "";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => { swError = String(e && e.message || e); });
  });
}

window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; syncInstall(); });
window.addEventListener("appinstalled", () => { deferred = null; syncInstall(); });

function syncInstall() {
  const b = document.getElementById("s-install");
  if (b) b.hidden = !deferred;
}

async function diagnose() {
  const out = [];
  const ok = (b) => (b ? "✓" : "✗");
  out.push(`${ok(isSecureContext)} 安全連線：${location.protocol}//${location.host}`);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  out.push(`${standalone ? "✓" : "–"} 開啟方式：${standalone ? "App 視窗（已安裝）" : "瀏覽器分頁"}`);

  let reg = null;
  try { reg = await navigator.serviceWorker.getRegistration(); } catch {}
  const swState = reg ? (reg.active ? "已啟用" : reg.installing ? "安裝中" : reg.waiting ? "等待中" : "已註冊") : "未註冊";
  out.push(`${ok(reg && reg.active)} Service Worker：${swState}${swError ? "　錯誤：" + swError : ""}`);

  const link = document.querySelector('link[rel="manifest"]');
  let m = null;
  try {
    const r = await fetch(link.href + "?diag=" + Date.now());
    out.push(`${ok(r.ok)} manifest：HTTP ${r.status}（${r.headers.get("content-type") || "?"}）`);
    if (r.ok) m = await r.json();
  } catch (e) { out.push("✗ manifest 讀取失敗：" + e.message); }

  if (m) {
    for (const ic of m.icons || []) {
      const u = new URL(ic.src, link.href).href + "?diag=" + Date.now();
      try {
        const r = await fetch(u);
        out.push(`${ok(r.ok)} 圖示 ${ic.sizes} ${ic.purpose || ""}：HTTP ${r.status}`);
      } catch { out.push(`✗ 圖示 ${ic.src}：讀取失敗`); }
    }
  }
  out.push(`${deferred ? "✓" : "✗"} Chrome 允許安裝：${deferred ? "是" : "尚未收到（可能已安裝，或上面有 ✗）"}`);
  return out.join("\n");
}

const install = document.getElementById("s-install");
const diag = document.getElementById("s-diag");
const diagOut = document.getElementById("s-diag-out");
if (install) install.onclick = async () => {
  if (!deferred) return;
  deferred.prompt();
  try { await deferred.userChoice; } catch {}
  deferred = null;
  syncInstall();
};
if (diag) diag.onclick = async () => {
  diagOut.hidden = false;
  diagOut.textContent = "檢查中…";
  diagOut.textContent = await diagnose();
};
syncInstall();
