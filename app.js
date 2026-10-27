import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult, signOut, signInWithCredential,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, writeBatch, setDoc, updateDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=9";
import {
  parseImport, cardKey, shuffle, splitHighlight, bulkLine, diffBulk,
  VERB_FIELDS, verbBulkLine, diffVerbBulk, checkVerbAnswer, verbSay, verbAlts, highlightForm, langSegments,
} from "./lib.js?v=11";
import { VERB_SEED } from "./verbs-seed.js?v=1";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = ["setup", "auth", "home", "study", "verb", "vmanage", "manage", "bulk", "done", "import", "settings"];
let current = null;

// 手機系統返回鍵：在字卡／管理等子頁按返回，回到上一層（首頁）而不是退出 APP。
// 作法：離開首頁層級時墊一筆歷史紀錄，系統返回只會消耗這一筆，並改為觸發頁面內的返回鈕。
const TOP_VIEWS = ["setup", "auth", "home"];
try { if (history.state?.sub) history.replaceState(null, ""); } catch {}
window.addEventListener("popstate", () => {
  if (!current || TOP_VIEWS.includes(current)) return;
  const open = ["#rg-cancel", "#cf-no", "#ed-cancel", "#rt-ok"].find((b) => !document.querySelector(b)?.closest(".sheet")?.hidden);
  if (open) { try { history.pushState({ sub: true }, ""); } catch {} document.querySelector(open).click(); return; }
  const back = $(`#v-${current}`)?.querySelector("[data-back], #vm-back, #bk-back");
  if (back) back.click(); else show("home");
});

function show(name) {
  try {
    if (!TOP_VIEWS.includes(name)) {
      if (!history.state?.sub) history.pushState({ sub: true }, "");
    } else if (history.state?.sub) {
      history.back();                  // 用頁面內按鈕回首頁時，把墊的那筆紀錄收掉
    }
  } catch {}
  closeMenus();
  current = name;
  for (const v of VIEWS) $(`#v-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
  updateLock();
}

// 右上角「⋯」下拉選單：點按鈕開關；點選項、點外面、按 Esc 都會收起
// 選單開著時，連播會先暫停（不然卡片自己換掉，選單上的「編輯／刪除」就點到下一張）；
// 沒選任何項目就關掉的話，再接著播。
let menuOpen = false;
function closeMenus(except, picked) {
  document.querySelectorAll(".menu-pop").forEach((pop) => {
    if (pop === except || pop.hidden) return;
    pop.hidden = true;
    pop.parentElement.querySelector("[data-menu]")?.setAttribute("aria-expanded", "false");
  });
  if (menuOpen && !except) { menuOpen = false; document.dispatchEvent(new CustomEvent("menuclose", { detail: { picked: !!picked } })); }
}
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-menu]");
  if (btn) {
    const pop = btn.parentElement.querySelector(".menu-pop");
    const wasOpen = !pop.hidden;
    closeMenus(wasOpen ? undefined : pop);
    if (wasOpen) return;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (!menuOpen) { menuOpen = true; document.dispatchEvent(new CustomEvent("menuopen")); }
    if (!pop.hidden) pop.querySelector(".mi:not(:disabled)")?.focus({ preventScroll: true });
    return;
  }
  if (e.target.closest?.(".menu-pop")) { if (!e.target.closest(".mi")?.disabled) setTimeout(() => closeMenus(undefined, true), 0); return; }
  closeMenus();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || ![...document.querySelectorAll(".menu-pop")].some((p) => !p.hidden)) return;
  e.stopImmediatePropagation(); closeMenus();
}, true);

// 連播（字卡）或純看連播（動詞）進行中
const autoWant = () => (settings.autoNext && current === "study") || (current === "verb" && settings.vmode === "look" && settings.vauto);
// 連播時保持螢幕不熄滅
let wakeLock = null;
async function updateLock() {
  const want = autoWant() && !document.hidden;
  try {
    if (want && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      const w = wakeLock; wakeLock = null; await w.release();
    }
  } catch { wakeLock = null; }
}
document.addEventListener("visibilitychange", updateLock);

/* ------------------------------------------------------------------ */
/* 本機設定（語音每台裝置不同，所以不放雲端）                              */
/* ------------------------------------------------------------------ */
const DEFAULTS = { lang: "en-US", readZh: true, rate: 0.95, autoplay: true, shuffle: true, autoNext: false, loop: false, fx: true, vmode: "quiz", vauto: false };
function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("wc.settings") || "{}") }; }
  catch { return { ...DEFAULTS }; }
}
const settings = readSettings();
const saveSettings = () => { try { localStorage.setItem("wc.settings", JSON.stringify(settings)); } catch {} };

const LANGS = [
  ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["ja-JP", "日本語"], ["ko-KR", "한국어"],
  ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["es-ES", "Español"], ["zh-TW", "中文（台灣）"],
];
const SAMPLES = {
  "en-US": "Hello, nice to meet you.", "en-GB": "Hello, nice to meet you.", "ja-JP": "こんにちは。",
  "ko-KR": "안녕하세요.", "fr-FR": "Bonjour.", "de-DE": "Guten Tag.", "es-ES": "Hola.", "zh-TW": "你好。",
};

/* ------------------------------------------------------------------ */
/* TTS：先念單字，停一下，再念例句                                       */
/* ------------------------------------------------------------------ */
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
let voices = [];
let speakToken = 0;
const normLang = (l) => String(l || "").replace("_", "-").toLowerCase().replace(/^cmn/, "zh");

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices();
}
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

// 語音品質評分：神經網路／加強版語音聽起來自然得多，壓縮版與 eSpeak 最機械
function voiceScore(v) {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/natural|neural|online/.test(n)) s += 100;        // Edge／Windows 的 Microsoft xxx Online (Natural)
  if (/premium|enhanced|siri/.test(n)) s += 80;          // iOS／macOS 下載的高品質語音
  if (/google/.test(n)) s += 60;                         // Android／Chrome 的 Google 語音
  if (/samantha|ava|allison|serena|daniel|karen|moira|tessa|zoe|evan|nathan/.test(n)) s += 20;
  if (/compact|espeak|novelty|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|organ|trinoids|whisper|zarvox|albert|fred|junior|kathy|ralph|superstar/.test(n)) s -= 100;
  if (!v.localService) s += 10;                          // 雲端語音通常較好（需要網路）
  return s;
}

// 中文語音（排除粵語）；發音語言是英文／歐語系時，中文片段（備註等）自動改用中文語音
const ZH_LANG = "zh-TW";
const zhVoices = () => voices.filter((v) => normLang(v.lang).startsWith("zh") && !/hk|yue/.test(normLang(v.lang)) && !/粵|粤|廣東|广东|cantonese/i.test(v.name));
const autoZh = () => !/^(zh|ja|ko)/.test(normLang(settings.lang));

function pickVoice(lang = settings.lang) {
  if (!voices.length) return null;
  const want = normLang(lang);
  const prim = want.split("-")[0];
  const pool = prim === "zh" ? zhVoices() : voices;
  const best = (list) => list.sort((a, b) => voiceScore(b) - voiceScore(a))[0] || null;
  return best(pool.filter((v) => normLang(v.lang) === want))
      || best(pool.filter((v) => normLang(v.lang).startsWith(prim)))
      || null;
}

function utter(text, zh = false) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = zh ? ZH_LANG : settings.lang;
    u.rate = settings.rate;
    const v = zh ? pickVoice(ZH_LANG) : pickVoice();
    if (v) u.voice = v;
    // 防呆：Android／Chrome 偶爾不會觸發 onend，超時就強制往下走，連播才不會卡死
    let timer = 0;
    const done = () => { clearTimeout(timer); resolve(); };
    u.onend = u.onerror = done;
    timer = setTimeout(() => { try { synth.cancel(); } catch {} done(); }, 4000 + (text.length * 350) / Math.max(settings.rate, 0.3));
    synth.speak(u);
  });
}

// 回傳 Promise<boolean>：true = 完整念完；false = 被打斷（換卡、重播、離開畫面）
// 原生 App（Capacitor）：朗讀改走 Android 系統 TTS，連播交給背景服務
const NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const NSpeech = NATIVE ? window.Capacitor.Plugins.Speech : null;
let nativeActive = false;     // 原生連播服務是否在跑（網頁端的記錄）
let nativeRemove = null;      // 剛標成「會了」／刪除的卡，下次重啟連播時通知服務從輪次拿掉

function speakParts(parts) {
  if (!parts.length) return Promise.resolve(false);
  const token = ++speakToken;
  if (NATIVE) {
    nativeActive = false;      // 單次朗讀會先停掉原生連播
    return NSpeech.speak({ parts, rate: settings.rate, lang: settings.lang, autoZh: autoZh() })
      .then((r) => !!(r && r.completed) && token === speakToken)
      .catch(() => false);
  }
  if (!synth) return sleep(2500).then(() => token === speakToken);
  const busy = synth.speaking || synth.pending;
  if (busy) synth.cancel();
  const run = async () => {
    for (let i = 0; i < parts.length; i++) {
      if (token !== speakToken) return false;
      if (i > 0) { await sleep(350); if (token !== speakToken) return false; }
      // 一段文字裡的中文／英文分開念，各用各的語音
      const segs = autoZh() ? langSegments(parts[i]) : [{ text: parts[i], zh: false }];
      for (let j = 0; j < segs.length; j++) {
        if (token !== speakToken) return false;
        if (j > 0) await sleep(120);
        await utter(segs[j].text, segs[j].zh);
      }
    }
    return token === speakToken;
  };
  // 沒有正在念的內容時同步呼叫，避免 iOS 把它當成非使用者操作
  return new Promise((res) => { busy ? setTimeout(() => run().then(res), 80) : run().then(res); });
}
let advTimer = 0;
const clearAdv = () => { clearTimeout(advTimer); advTimer = 0; };
function stopSpeech() {
  speakToken++; clearAdv();
  if (NATIVE) { nativeActive = false; NSpeech.stop().catch(() => {}); }
  else if (synth) synth.cancel();
}
// 原生 App 連播中切到背景／關螢幕不要停（背景服務繼續播）；網頁版和其他情況照舊停止
document.addEventListener("visibilitychange", () => { if (document.hidden && !(NATIVE && autoWant())) stopSpeech(); });

/* ------------------------------------------------------------------ */
/* Toast                                                                */
/* ------------------------------------------------------------------ */
let toastTimer;
function hideToast() { $("#toast").hidden = true; }
function toast(msg, action) {
  $("#toast-msg").textContent = msg;
  const b = $("#toast-act");
  b.hidden = !action;
  b.onclick = action ? () => { action.fn(); hideToast(); } : null;
  if (action) b.textContent = action.label;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 3000);
}
function syncError(err) {
  const code = err?.code || "";
  console.error(err);
  if (code.includes("permission-denied")) toast("沒有權限：請確認 Firestore 規則已發布");
  else toast("同步失敗：" + (code || err?.message || err));
}

/* ------------------------------------------------------------------ */
/* 啟動                                                                 */
/* ------------------------------------------------------------------ */
const freshPrefs = () => ({ word: { on: false, from: 1, to: null }, verb: { on: false, from: 1, to: null } });
const normPref = (p) => {
  let from = Math.max(1, parseInt(p?.from, 10) || 1);
  let to = p?.to ? Math.max(1, parseInt(p.to, 10) || 0) || null : null;
  if (to && to < from) [from, to] = [to, from];
  return { on: !!p?.on, from, to };
};

const configured = !!(firebaseConfig && firebaseConfig.apiKey && !/^YOUR_/.test(firebaseConfig.apiKey));

if (!configured) {
  show("setup");
} else {
  init();
}

function init() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  let db;
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("離線快取不可用，改用一般模式", e);
    db = getFirestore(app);
  }

  const state = {
    uid: null, cards: new Map(), verbs: new Map(), gone: new Set(), prefs: freshPrefs(), unsub: null, ready: false, pending: false,
    mode: "new", queue: [], idx: 0, current: null,
    stats: { keep: 0, del: 0, next: 0 },
  };
  // 與其他 app 共用同一個 Firebase 專案，所以根集合用獨立名稱 wordcards
  const cardsCol = () => collection(db, "wordcards", state.uid, "cards");
  const cardRef = (id) => doc(db, "wordcards", state.uid, "cards", id);

  /* ---------------- 驗證（只用 Google 登入） ---------------- */
  const AUTH_ERRORS = {
    "auth/popup-closed-by-user": "登入視窗被關閉了",
    "auth/cancelled-popup-request": "",
    "auth/network-request-failed": "網路連線失敗",
    "auth/operation-not-allowed": "尚未在 Firebase 啟用 Google 登入",
    "auth/unauthorized-domain": "此網域尚未加入 Firebase 的授權網域",
  };
  const authMsg = (m) => { $("#au-msg").textContent = m || ""; };
  const authError = (e) => {
    const m = AUTH_ERRORS[e?.code];
    return m !== undefined ? m : `登入失敗（${e?.code || e?.message || "未知錯誤"}）`;
  };

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  $("#au-google").onclick = async () => {
    authMsg("");
    if (NATIVE) {
      // 原生 App：Google 不允許在內嵌網頁裡登入，改用 Android 原生的 Google 登入，再把憑證交給 Firebase
      try {
        const r = await window.Capacitor.Plugins.FirebaseAuthentication.signInWithGoogle();
        const idToken = r && r.credential && r.credential.idToken;
        if (!idToken) throw new Error("沒有取得 Google 憑證");
        await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
      } catch (err) { authMsg(authError(err)); }
      return;
    }
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      // 少數環境不能開彈窗時，改用整頁跳轉
      if (err?.code === "auth/popup-blocked" || err?.code === "auth/operation-not-supported-in-this-environment") {
        try { await signInWithRedirect(auth, provider); return; } catch (e2) { err = e2; }
      }
      authMsg(authError(err));
    }
  };
  if (!NATIVE) getRedirectResult(auth).catch((err) => authMsg(authError(err)));
  $("#s-logout").onclick = () => {
    stopSpeech(); signOut(auth);
    if (NATIVE) window.Capacitor.Plugins.FirebaseAuthentication.signOut().catch(() => {});
  };

  onAuthStateChanged(auth, (user) => {
    if (user) {
      if (state.uid !== user.uid) attach(user.uid);
      if (current === null || current === "auth") { show("home"); renderHome(); }
    } else {
      detach();
      show("auth");
    }
  });

  /* ---------------- 資料同步 ---------------- */
  function attach(uid) {
    detach();
    state.uid = uid;
    state.unsub = onSnapshot(cardsCol(), { includeMetadataChanges: true }, (snap) => {
      state.pending = snap.metadata.hasPendingWrites;
      snap.docChanges().forEach((ch) => {
        const id = ch.doc.id;
        if (ch.type === "removed") { state.cards.delete(id); state.verbs.delete(id); if (id === "verbmeta") state.gone = new Set(); if (id === "prefs") { state.prefs = freshPrefs(); renderGears(); } return; }
        const data = ch.doc.data();
        if (data.type === "verbmeta") { state.gone = new Set(data.gone || []); return; }   // 記錄「刪掉的內建動詞」
        if (data.type === "prefs") {                                                       // 練習範圍設定（雲端同步）
          state.prefs = { word: normPref(data.word), verb: normPref(data.verb) };
          renderGears();
          return;
        }
        // 動詞三態的卡不混進一般單字
        (data.type === "verb" ? state.verbs : state.cards).set(id, { id, ...data });
      });
      state.ready = true;
      renderHome();
    }, (err) => {
      if (err?.code === "permission-denied") {
        // 不是允許的帳號（或規則還沒發布）→ 登出並回到登入畫面
        stopSpeech();
        authMsg("這個 Google 帳號沒有使用權限（若確定是自己的帳號，請確認 Firestore 規則已發布、UID 正確）");
        signOut(auth);
      } else {
        syncError(err);
      }
    });
  }
  function detach() {
    if (state.unsub) { state.unsub(); state.unsub = null; }
    state.uid = null; state.cards.clear(); state.verbs.clear(); state.gone = new Set(); state.prefs = freshPrefs(); state.ready = false;
  }

  /* ---------------- 首頁 ---------------- */
  function counts() {
    let n = 0, k = 0;
    for (const c of state.cards.values()) (c.status === "known" ? k++ : n++);
    return { n, k };
  }
  function renderHome() {
    const { n, k } = counts();
    $("#h-new").textContent = n;
    $("#h-known").textContent = k;
    $("#h-verbs").textContent = state.verbs.size;
    $("#h-learn").disabled = n === 0;
    $("#h-review").disabled = k === 0;
    const empty = $("#h-empty");
    empty.hidden = state.cards.size > 0;
    $("#h-empty-import").hidden = !state.ready || state.cards.size > 0;
    empty.textContent = state.ready ? "還沒有字卡，先匯入一批吧。" : "載入中…";
    renderSync();
    if (current === "manage") refreshManage();
    if (current === "verb") vqRefresh();
    if (current === "vmanage") vmRender();
  }
  // 同步狀態：離線、或有寫入還沒送到雲端時顯示在標題旁
  function renderSync() {
    const el = $("#h-sync");
    const online = navigator.onLine;
    const msg = state.pending ? (online ? "同步中…" : "離線・尚未同步") : (online ? "" : "離線中");
    el.textContent = msg;
    el.hidden = !msg;
  }
  window.addEventListener("online", renderSync);
  window.addEventListener("offline", renderSync);
  $("#h-learn").onclick = () => startStudy("new");
  $("#h-review").onclick = () => startStudy("known");
  $("#h-verb").onclick = () => { show("verb"); vqRefresh(); };
  const openManage = () => { stopSpeech(); mg.q = ""; $("#m-q").value = ""; mg.limit = PAGE; show("manage"); renderManage(); };
  $("#st-manage").onclick = openManage;
  $("#h-empty-import").onclick = () => { show("import"); updatePreview(); };
  let settingsFrom = "home";
  $("#h-settings").onclick = () => { settingsFrom = "home"; fillSettings(); show("settings"); };
  // 學習中開設定：改完按返回回到同一張卡（不是跳回首頁）
  $("#st-settings").onclick = () => { stopSpeech(); settingsFrom = "study"; fillSettings(); show("settings"); };
  $$("[data-back]").forEach((b) => b.addEventListener("click", () => {
    if (current === "settings" && settingsFrom === "study" && state.current) {
      settingsFrom = "home";
      show("study");
      renderCard(state.current);
      if (settings.autoNext) playCard();
      return;
    }
    stopSpeech(); clearTimeout(vq.timer); show("home"); renderHome();
  }));

  /* ---------------- 學習 / 複習 ---------------- */
  const inMode = (c) => (state.mode === "known" ? c.status === "known" : c.status !== "known");

  function startStudy(mode) {
    state.mode = mode;
    if (!buildQueue()) { toast("沒有可看的字卡"); show("home"); renderHome(); return; }
    state.stats = { keep: 0, del: 0, next: 0 };
    state.hinted = false;
    renderMode();
    show("study");
    showCard();
  }

  // 重新排出佇列（回傳是否有卡可看）
  function buildQueue() {
    let list = inRange("word", [...state.cards.values()]).filter(inMode);
    if (!list.length) return false;
    list = settings.shuffle ? shuffle(list) : list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.queue = list.map((c) => c.id);
    state.idx = 0;
    return true;
  }

  // 略過已被其他裝置刪除、或狀態已改變的卡
  function nextVisible() {
    while (state.idx < state.queue.length) {
      const c = state.cards.get(state.queue[state.idx]);
      if (c && inMode(c)) return c;
      state.idx++;
    }
    return null;
  }

  // 大字單字：左上角標序號（像平方的小數字）
  function setWord(el, text, no) {
    el.textContent = "";
    el.classList.remove("sn-on");          // 換卡就先藏起來，點單字才顯示
    if (no) { const sup = document.createElement("span"); sup.className = "sn"; sup.textContent = no; sup.title = "序號"; el.append(sup); }
    el.append(text);
  }
  function setTrans(c, open) {
    const el = $("#c-trans");
    el.dataset.open = open ? "1" : "0";
    el.setAttribute("aria-expanded", String(open));
    el.textContent = open ? c.trans || "" : "點一下看翻譯";
  }
  function renderCard(c) {
    setWord($("#c-word"), c.word, serialMap("word").get(c.id));
    const ex = $("#c-example");
    ex.textContent = "";
    for (const p of splitHighlight(c.example, c.word)) {
      if (p.hl) { const b = document.createElement("b"); b.textContent = p.text; ex.append(b); }
      else ex.append(p.text);
    }
    ex.hidden = !c.example;
    $("#c-trans").hidden = !c.trans;
    setTrans(c, !!settings.readZh);        // 有唸中文就直接顯示；沒唸的話先蓋起來，點一下才顯示
    $("#c-note").textContent = c.note || "";
    $("#c-note").hidden = !c.note;
  }

  let playCount = 0;
  // 念出來；連播開著時，念完停一下就自動跳下一張
  function playCard(parts) {
    const c = state.current;
    if (!c) return;
    clearAdv();
    if (NATIVE && settings.autoNext && !parts) { startNativeSession(c); return; }
    // 勾「朗讀時唸出中文」：單字 → 備註 → 英文例句 → 中文例句；沒勾：單字 → 英文例句
    const list = parts || (settings.readZh ? [c.word, c.note, c.example, c.trans] : [c.word, c.example]).filter(Boolean);
    let p;
    // 長時間連播：每 20 張先重置一次語音引擎，避免 Chrome 的合成器越用越卡
    if (synth && settings.autoNext && ++playCount % 20 === 0) {
      synth.cancel();
      p = sleep(250).then(() => (state.current === c && current === "study" ? speakParts(list) : false));
    } else p = speakParts(list);
    if (!settings.autoNext) return;
    p.then((ok) => {
      if (!ok || !settings.autoNext) return;
      advTimer = setTimeout(() => {
        if (!settings.autoNext || editing || current !== "study" || state.current !== c) return;
        if (settings.loop) playCard(list);   // 單字循環：同一張重複念
        else act("next");                    // 連播：跳下一張
      }, settings.loop ? 900 : 1200);
    });
  }

  function showCard(silent) {
    clearAdv();
    const c = nextVisible();
    state.current = c;
    if (!c) return finish();
    renderCard(c);
    $("#st-progress").textContent = `${state.idx + 1} / ${state.queue.length}`;
    $("#a-keep").textContent = state.mode === "known" ? "還不熟" : "會了";
    const stage = $("#stage");
    stage.classList.remove("swap"); void stage.offsetWidth; stage.classList.add("swap");
    if (!silent && (settings.autoplay || settings.autoNext)) playCard();
  }

  function finish() {
    // 連播開著：不分輪次，看完自動重新洗牌繼續，直到手動關閉連播
    if (settings.autoNext && current === "study" && buildQueue()) {
      if (state.queue.length === 1 && !state.hinted) { state.hinted = true; toast("只剩一張卡，會一直重複播放"); }
      showCard(); return;
    }
    stopSpeech();
    const s = state.stats;
    const known = state.mode === "known";
    $("#dn-title").textContent = known ? "複習完了" : "這一輪看完了";
    $("#dn-sub").textContent = `${known ? "還不熟" : "會了"} ${s.keep} · 刪除 ${s.del} · 略過 ${s.next}`;
    $("#dn-again").hidden = ![...state.cards.values()].some(inMode);
    show("done");
  }
  $("#dn-again").onclick = () => startStudy(state.mode);

  const toData = (c) => { const { id, ...data } = c; return data; };

  function removeCard(c) {
    const data = toData(c);
    deleteDoc(cardRef(c.id)).catch(syncError);
    const label = c.word.length > 18 ? c.word.slice(0, 18) + "…" : c.word;
    toast(`已刪除「${label}」`, { label: "復原", fn: () => setDoc(cardRef(c.id), data).catch(syncError) });
  }

  function act(kind) {
    const c = state.current;
    if (!c || current !== "study" || editing) return;
    clearAdv();
    if (NATIVE && (kind === "keep" || kind === "del")) nativeRemove = c.id;
    if (kind === "keep") {
      const patch = state.mode === "known" ? { status: "new" } : { status: "known", knownAt: Date.now() };
      updateDoc(cardRef(c.id), patch).catch(syncError);
      state.stats.keep++;
    } else if (kind === "del") {
      removeCard(c);
      state.stats.del++;
    } else {
      state.stats.next++;
    }
    state.idx++;
    showCard();
  }
  // 左右滑動 = 下一張（不管往哪邊都一樣，順序依「隨機順序」設定）
  const stageEl = $("#stage");
  let sx = 0, sy = 0, tracking = false, swiped = false;
  stageEl.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY; tracking = true; swiped = false;
  });
  stageEl.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; act("next"); }
  });
  stageEl.addEventListener("pointercancel", () => { tracking = false; });
  // 滑動結束時不要同時觸發「點單字／例句發音」
  stageEl.addEventListener("click", (e) => {
    if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
  }, true);

  $("#a-del").onclick = () => {
    const c = state.current;
    if (!c || current !== "study" || editing) return;
    confirmDelete(`刪除「${c.word.length > 18 ? c.word.slice(0, 18) + "…" : c.word}」？`, "刪除後可以在下方提示按「復原」。", () => act("del"));
  };
  $("#a-keep").onclick = () => act("keep");
  $("#st-speak").onclick = () => playCard();
  $("#c-word").onclick = () => { const c = state.current; if (c) { $("#c-word").classList.toggle("sn-on"); playCard([c.word]); } };
  $("#c-example").onclick = () => { const c = state.current; if (c && c.example) playCard([c.example]); };
  $("#c-note").onclick = () => { const c = state.current; if (c && c.note) playCard([c.note]); };
  $("#c-trans").onclick = () => {
    const c = state.current;
    if (!c || !c.trans) return;
    if (settings.readZh) playCard([c.trans]);     // 一直顯示的狀態：點一下是單獨朗讀
    else setTrans(c, $("#c-trans").dataset.open !== "1");
  };
  // 播放模式：關 → 連播 → 單字循環 → 關（點擊切換）
  const MODE_TXT = { off: "連播", next: "連播", loop: "循環" };
  const curMode = () => (!settings.autoNext ? "off" : settings.loop ? "loop" : "next");
  function renderMode() {
    const m = curMode();
    const b = $("#st-mode");
    b.dataset.mode = m;
    b.dataset.on = m === "off" ? "0" : "1";
    $("#st-mode-txt").textContent = MODE_TXT[m];
  }
  /* ---------------- 原生 App：連播交給背景服務（螢幕關掉也繼續唸） ---------------- */
  // 連播時整個播放流程（單字 → 備註 → 英文例句 → 中文例句 → 下一張）由 Android 前景服務執行，
  // 網頁這邊只負責同步畫面：服務換卡時通知網頁，切回前景時再對一次進度。
  function nativeTurnOff() {
    nativeActive = false;
    if (settings.autoNext) { settings.autoNext = false; saveSettings(); renderMode(); updateLock(); }
  }
  function onNativeCard(e) {
    if (!settings.autoNext || current !== "study" || editing || !e) return;
    if (e.ids && e.ids.length) state.queue = e.ids.slice();      // 服務重新排了一輪
    const i = state.queue.indexOf(e.id);
    if (i < 0) return;
    state.idx = i;
    state.stats.next++;
    showCard(true);
  }
  function syncNative() {
    if (!NATIVE || !settings.autoNext || current !== "study") return;
    NSpeech.getSession().then((r) => {
      if (!r || !r.active) { if (nativeActive) nativeTurnOff(); return; }
      nativeActive = true;
      let i = state.queue.indexOf(r.id);
      if (i < 0 && r.ids && r.ids.length) { state.queue = r.ids.slice(); i = state.queue.indexOf(r.id); }
      if (i >= 0 && (i !== state.idx || !state.current || state.current.id !== r.id)) { state.idx = i; showCard(true); }
    }).catch(() => {});
  }
  if (NATIVE) {
    NSpeech.stop().catch(() => {});                  // 重新開啟 App 時，清掉上次殘留的背景連播
    NSpeech.addListener("card", onNativeCard);
    NSpeech.addListener("state", (e) => { if (e && e.active === false) nativeTurnOff(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNative(); });
  }
  function startNativeSession(c) {
    speakToken++;                                   // 取消網頁端進行中的朗讀
    const ids = state.queue.slice(state.idx).filter((id) => { const x = state.cards.get(id); return x && inMode(x); });
    if (!ids.includes(c.id)) ids.unshift(c.id);
    const payload = {
      ids, rate: settings.rate, lang: settings.lang, autoZh: autoZh(),
      readZh: !!settings.readZh, loop: !!settings.loop, shuffle: !!settings.shuffle, remove: nativeRemove,
    };
    nativeRemove = null;
    const pool = () => inRange("word", [...state.cards.values()]).filter(inMode)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((x) => ({ id: x.id, w: x.word || "", n: x.note || "", e: x.example || "", t: x.trans || "" }));
    if (!nativeActive) payload.cards = pool();
    NSpeech.startSession(payload).then(() => { nativeActive = true; }).catch((err) => {
      if (String((err && err.message) || err).includes("NEED_CARDS")) {
        payload.cards = pool();
        return NSpeech.startSession(payload).then(() => { nativeActive = true; });
      }
      nativeActive = false;
      toast("無法啟動背景朗讀");
    });
  }

  $("#st-mode").onclick = () => {
    const m = curMode();
    settings.autoNext = m === "off" ? true : m === "next";
    settings.loop = m === "next";
    saveSettings();
    renderMode();
    updateLock();
    if (settings.autoNext) playCard(); else { clearAdv(); if (NATIVE) stopSpeech(); }
  };

  /* ---------------- 練習範圍（依序號；設定存雲端） ---------------- */
  // 序號 = 該類全部卡片依建立順序的第幾張，跟「文字編輯」裡的編號一致
  function serialMap(kind) {
    const arr = [...(kind === "verb" ? state.verbs : state.cards).values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return new Map(arr.map((c, i) => [c.id, i + 1]));
  }
  function inRange(kind, list) {
    const p = state.prefs[kind];
    if (!p.on) return list;
    const m = serialMap(kind);
    return list.filter((c) => { const n = m.get(c.id); return n >= p.from && (p.to == null || n <= p.to); });
  }
  const prefsRef = () => doc(db, "wordcards", state.uid, "cards", "prefs");
  function savePref(kind, val) {
    state.prefs[kind] = val;
    if (state.uid) setDoc(prefsRef(), { type: "prefs", [kind]: val }, { merge: true }).catch(syncError);
    renderGears();
  }
  function renderGears() {
    $("#st-gear").dataset.on = state.prefs.word.on ? "1" : "0";
    $("#vq-gear").dataset.on = state.prefs.verb.on ? "1" : "0";
  }

  // 各種浮層（範圍／刪除確認／編輯／語速）開著時，不要讓背景的連播或快捷鍵繼續動
  const sheetOpen = () => ["#rg", "#cf", "#ed", "#rt"].some((id) => !$(id).hidden);
  function pauseForSheet() {
    editing = true; stopSpeech(); clearTimeout(vq.timer); vq.run++;
  }
  function resumeAfterSheet() {
    editing = false;
    if (current === "study" && settings.autoNext) playCard();
    else if (current === "verb" && vqLook() && settings.vauto && vq.done && vq.card) speakExamples();
  }

  const rg = { kind: "word" };
  const rgEl = $("#rg");
  const rgTotal = () => (rg.kind === "verb" ? state.verbs : state.cards).size;
  function rgRead() {
    const from = Math.max(1, parseInt($("#rg-from").value, 10) || 1);
    const to = parseInt($("#rg-to").value, 10) || null;
    return normPref({ on: $("#rg-on").checked, from, to });
  }
  function rgHint() {
    const n = rgTotal();
    const on = $("#rg-on").checked;
    $("#rg-from").disabled = $("#rg-to").disabled = !on;
    if (!on) { $("#rg-hint").textContent = `目前練習全部，共 ${n} ${rg.kind === "verb" ? "個" : "張"}。`; return; }
    const p = rgRead();
    const hi = p.to == null ? n : Math.min(p.to, n);
    const cnt = Math.max(0, hi - p.from + 1);
    $("#rg-hint").textContent = `第 ${p.from} ～ ${hi} 個，共 ${cnt} ${rg.kind === "verb" ? "個" : "張"}（全部共 ${n}）。`;
  }
  function openRange(kind) {
    if (sheetOpen()) return;
    rg.kind = kind;
    const p = state.prefs[kind];
    $("#rg-title").textContent = kind === "verb" ? "練習範圍 · 動詞三態" : "練習範圍 · 單字";
    $("#rg-on").checked = p.on;
    $("#rg-from").value = p.from;
    $("#rg-to").value = p.to ?? "";
    $("#rg-to").placeholder = String(rgTotal() || "");
    rgHint();
    pauseForSheet();
    rgEl.hidden = false;
  }
  function closeRange() {
    if (rgEl.hidden) return;
    rgEl.hidden = true;
    resumeAfterSheet();
  }
  $("#st-gear").onclick = () => openRange("word");
  $("#vq-gear").onclick = () => openRange("verb");
  ["#rg-on", "#rg-from", "#rg-to"].forEach((id) => $(id).addEventListener("input", rgHint));
  $("#rg-cancel").onclick = closeRange;
  rgEl.addEventListener("pointerdown", (e) => { if (e.target === rgEl) closeRange(); });
  $("#rg-form").onsubmit = (e) => {
    e.preventDefault();
    const p = rgRead();
    const n = rgTotal();
    if (p.on && p.from > n) { toast(`起始序號超過總數（共 ${n}）`); return; }
    rgEl.hidden = true;
    savePref(rg.kind, p);
    editing = false;
    if (rg.kind === "verb") {
      vq.queue = [];
      if (vqCards().length) vqNext();
    } else if (current === "study") {
      stopSpeech();
      if (!buildQueue()) { toast("這個範圍裡沒有可看的字卡"); show("home"); renderHome(); return; }
      showCard();
    }
    if (p.on) toast(`已套用：第 ${p.from} ～ ${p.to ?? "最後"}`);
  };

  /* ---------------- 刪除確認 ---------------- */
  const cfEl = $("#cf");
  let cfFn = null;
  function confirmDelete(title, msg, fn) {
    if (sheetOpen()) return;
    cfFn = fn;
    $("#cf-title").textContent = title;
    $("#cf-msg").textContent = msg;
    pauseForSheet();
    cfEl.hidden = false;
    $("#cf-no").focus();
  }
  function closeConfirm(yes) {
    if (cfEl.hidden) return;
    cfEl.hidden = true;
    const fn = cfFn; cfFn = null;
    editing = false;
    if (yes && fn) fn(); else resumeAfterSheet();
  }
  $("#cf-no").onclick = () => closeConfirm(false);
  $("#cf-yes").onclick = () => closeConfirm(true);
  cfEl.addEventListener("pointerdown", (e) => { if (e.target === cfEl) closeConfirm(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeConfirm(false); closeRange(); }
  });

  /* ---------------- 學習中快速編輯 ---------------- */
  let editing = false;
  const edEl = $("#ed");
  $("#a-edit").onclick = () => {
    const c = state.current;
    if (!c || current !== "study") return;
    editing = true;
    stopSpeech();
    $("#ed-word").value = c.word;
    $("#ed-example").value = c.example || "";
    $("#ed-note").value = c.note || "";
    $("#ed-trans").value = c.trans || "";
    edEl.hidden = false;
    $("#ed-word").focus();
  };
  function closeEdit(resume) {
    edEl.hidden = true;
    editing = false;
    if (resume) playCard();
  }
  $("#ed-cancel").onclick = () => closeEdit(settings.autoNext);
  edEl.addEventListener("pointerdown", (e) => { if (e.target === edEl) closeEdit(settings.autoNext); });
  $("#ed-form").onsubmit = (e) => {
    e.preventDefault();
    const c = state.current;
    if (!c) return closeEdit(false);
    const clean = (v) => v.replace(/\s*\n\s*/g, " ").trim();
    const patch = { word: clean($("#ed-word").value), example: clean($("#ed-example").value), note: clean($("#ed-note").value), trans: clean($("#ed-trans").value) };
    if (!patch.word) { toast("單字不能空白"); return; }
    updateDoc(cardRef(c.id), patch).catch(syncError);
    Object.assign(c, patch);
    renderCard(c);
    closeEdit(settings.autoplay || settings.autoNext);
  };
  document.addEventListener("keydown", (e) => { if (editing && e.key === "Escape") closeEdit(settings.autoNext); });

  /* ---------------- 語速（長按／右鍵喇叭） ---------------- */
  const rtEl = $("#rt");
  const rtOut = () => { $("#rt-out").textContent = settings.rate.toFixed(2) + "×"; };
  function openRate() {
    if (current !== "study" || editing || !rtEl.hidden) return;
    editing = true;            // 調整期間暫停連播／循環
    stopSpeech();
    $("#rt-range").value = settings.rate;
    rtOut();
    rtEl.hidden = false;
  }
  function closeRate() {
    if (rtEl.hidden) return;
    rtEl.hidden = true;
    editing = false;
    if (settings.autoNext) playCard();
  }
  $("#rt-range").oninput = (e) => { settings.rate = parseFloat(e.target.value); rtOut(); saveSettings(); };
  // 放開滑桿時試聽一次
  $("#rt-range").onchange = () => { const c = state.current; if (c) speakParts([c.word, c.example].filter(Boolean)); };
  $("#rt-ok").onclick = closeRate;
  rtEl.addEventListener("pointerdown", (e) => { if (e.target === rtEl) closeRate(); });
  document.addEventListener("keydown", (e) => { if (!rtEl.hidden && e.key === "Escape") closeRate(); });

  const spk = $("#st-speak");
  let lpTimer = 0, lpFired = false;
  const lpCancel = () => { clearTimeout(lpTimer); lpTimer = 0; };
  spk.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;      // 電腦用右鍵
    lpFired = false;
    lpCancel();
    lpTimer = setTimeout(() => { lpFired = true; openRate(); }, 500);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) => spk.addEventListener(t, lpCancel));
  spk.addEventListener("contextmenu", (e) => { e.preventDefault(); lpCancel(); lpFired = true; openRate(); });
  // 長按後放開不要同時觸發重播
  spk.addEventListener("click", (e) => {
    if (lpFired) { e.stopImmediatePropagation(); e.preventDefault(); lpFired = false; }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (current !== "study" || editing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
    switch (e.key) {
      case "ArrowRight": act("next"); break;
      case "ArrowUp": case "k": case "K": act("keep"); break;
      case "Delete": case "d": case "D": act("del"); break;
      case "ArrowDown": case "r": case "R": $("#st-speak").click(); break;
      case "t": case "T": $("#c-trans").click(); break;
    }
  });

  /* ---------------- 動詞三態 ---------------- */
  const FORMS = [["v1", "V1", "原形"], ["v2", "V2", "過去式"], ["v3", "V3", "過去分詞"]];
  const vq = { card: null, form: 0, done: false, ok: 0, total: 0, streak: 0, best: 0, queue: [], last: null, run: 0 };
  const vqAll = () => [...state.verbs.values()].filter((c) => c.v1 && c.v2 && c.v3);
  const vqCards = () => { const all = vqAll(), r = inRange("verb", all); return r.length ? r : all; };
  const vqInput = (i) => $(`#vq-i${i}`);
  const showAlts = (s) => verbAlts(s).join(" / ");

  const vqLook = () => settings.vmode === "look";
  function vqRenderMode() {
    // 按鈕顯示「點下去會切到的模式」：測驗中顯示「純看」，純看中顯示「測驗」
    const to = vqLook() ? "測驗" : "純看";
    $("#vq-mode-txt").textContent = to;
    $("#vq-mode").title = $("#vq-mode").ariaLabel = `切換到${to}模式`;
    const a = $("#vq-auto");
    a.hidden = !vqLook();
    a.dataset.on = settings.vauto ? "1" : "0";
    a.setAttribute("aria-pressed", String(!!settings.vauto));
    a.textContent = "連播";
    $("#vq-del").disabled = !(vq.card && vq.done);
    updateLock();
  }
  function vqScore() {
    $("#vq-score").textContent = vqLook() ? "" : vq.total
      ? `答對 ${vq.ok} / ${vq.total}${vq.streak > 1 ? ` · 連對 ${vq.streak}` : ""}`
      : "";
  }
  function vqRefresh() {
    vqRenderMode();
    const has = vqCards().length > 0;
    $("#vq-empty").hidden = has;
    $("#vq-quiz").hidden = !has;
    $("#vq-foot").hidden = !has;
    if (!has) { vq.card = null; stopSpeech(); $("#vq-del").disabled = true; }
    else if (!vq.card || !state.verbs.has(vq.card.id)) vqNext();
    vqScore();
  }

  function vqPick() {
    const all = vqCards();
    vq.queue = vq.queue.filter((id) => state.verbs.has(id));
    if (!vq.queue.length) {
      vq.queue = shuffle(all.map((c) => c.id));
      const n = vq.queue.length;       // 從尾巴取：避免洗牌後第一題跟上一題同一個
      if (n > 1 && vq.queue[n - 1] === vq.last) [vq.queue[0], vq.queue[n - 1]] = [vq.queue[n - 1], vq.queue[0]];
    }
    return state.verbs.get(vq.queue.pop());
  }

  function vqNext() {
    stopSpeech(); vq.run++; clearTimeout(vq.timer);
    const c = vqPick();
    if (!c) return;
    vq.card = c; vq.last = c.id; vq.done = false;
    vq.form = Math.floor(Math.random() * 3);
    const f = vq.form;
    // 中文意思放在單字正下方（題目和結果都看得到）
    $("#vq-note").textContent = c.note || "";
    $("#vq-note").hidden = !c.note;
    $("#vq-del").disabled = true;
    $("#vq-badge").hidden = vqLook();
    if (vqLook()) {                       // 純看：不用打字，直接顯示三態＋例句並朗讀
      vq.done = true;
      setWord($("#vq-word"), showAlts(c.v1), serialMap("verb").get(c.id));
      $("#vq-giveup").hidden = true;
      $("#vq-del").disabled = false;
      $("#vq-go").textContent = "下一個";
      $("#vq-quiz").classList.remove("ok", "bad");
      renderExamples(c, null, true);
      vqScore();
      speakExamples();
      return;
    }
    $("#vq-badge").textContent = `${FORMS[f][1]} · ${FORMS[f][2]}`;
    setWord($("#vq-word"), showAlts(c[FORMS[f][0]]), serialMap("verb").get(c.id));
    for (let i = 0; i < 3; i++) {
      const el = vqInput(i);
      el.className = i === f ? "given" : "";
      el.readOnly = i === f;
      el.tabIndex = i === f ? -1 : 0;
      el.value = i === f ? showAlts(c[FORMS[i][0]]) : "";
    }
    vqFlip(false);
    $("#vq-giveup").hidden = false;
    $("#vq-go").textContent = "送出";
    const q = $("#vq-quiz");
    q.classList.remove("ok", "bad");
    const first = [0, 1, 2].find((i) => i !== f);
    vqInput(first).focus({ preventScroll: true });
    speakParts([verbSay(c, f)]);
  }

  /* ----- 特效：彩帶、閃光、大符號、音效、震動 ----- */
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fxCanvas = $("#fx"), fxCtx = fxCanvas.getContext("2d");
  let fxParts = [], fxRaf = 0, fxDpr = 1;
  function fxTick() {
    fxCtx.setTransform(fxDpr, 0, 0, fxDpr, 0, 0);
    fxCtx.clearRect(0, 0, innerWidth, innerHeight);
    fxParts = fxParts.filter((p) => p.y < innerHeight + 30 && p.life > 0);
    for (const p of fxParts) {
      p.vy += 0.5; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.life -= 0.008;
      fxCtx.save();
      fxCtx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      fxCtx.translate(p.x, p.y); fxCtx.rotate(p.r);
      fxCtx.fillStyle = p.c; fxCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      fxCtx.restore();
    }
    fxRaf = fxParts.length ? requestAnimationFrame(fxTick) : 0;
    if (!fxRaf) fxCtx.clearRect(0, 0, innerWidth, innerHeight);
  }
  function confetti(n, power) {
    if (!settings.fx || reduceMotion()) return;
    fxDpr = window.devicePixelRatio || 1;
    fxCanvas.width = innerWidth * fxDpr; fxCanvas.height = innerHeight * fxDpr;
    const cols = ["#23c27a", "#f2b705", "#ff5d5d", "#3a86ff", "#c77dff", "#ff8fab"];
    for (let i = 0; i < n; i++) {
      fxParts.push({
        x: innerWidth / 2, y: innerHeight * 0.4,
        vx: (Math.random() - 0.5) * power * 1.6, vy: -(Math.random() * power + power * 0.5),
        w: 6 + Math.random() * 7, h: 4 + Math.random() * 6, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.45,
        c: cols[i % cols.length], life: 1,
      });
    }
    if (!fxRaf) fxRaf = requestAnimationFrame(fxTick);
  }
  let actx = null;
  function tone(seq) {
    if (!settings.fx) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      const t0 = actx.currentTime;
      for (const [f, d, at, type] of seq) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = type || "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + d);
        o.connect(g).connect(actx.destination);
        o.start(t0 + at); o.stop(t0 + at + d + 0.05);
      }
    } catch {}
  }
  const buzz = (p) => { if (settings.fx) try { navigator.vibrate?.(p); } catch {} };
  function retrigger(el, cls) { el.classList.remove("ok", "bad"); void el.offsetWidth; el.classList.add(cls); }
  function fxResult(ok) {
    const flash = $("#fx-flash"), mark = $("#fx-mark");
    flash.className = "fx-flash"; mark.className = "fx-mark"; void flash.offsetWidth;
    flash.classList.add(ok ? "ok" : "bad");
    mark.classList.add(ok ? "ok" : "bad", "show");
    $("#fx-sym").textContent = ok ? "✓" : "✗";
    $("#fx-sub").textContent = ok ? (vq.streak > 1 ? `連對 ×${vq.streak}` : "答對了！") : "答錯了";
    retrigger($("#vq-quiz"), ok ? "ok" : "bad");
    if (ok) {
      const big = vq.streak > 0 && vq.streak % 5 === 0;
      confetti(big ? 150 : 70, big ? 17 : 12);
      tone(big ? [[523, 0.12, 0], [659, 0.12, 0.1], [784, 0.12, 0.2], [1047, 0.34, 0.3]] : [[660, 0.12, 0], [990, 0.26, 0.1]]);
      buzz(big ? [40, 40, 40, 40, 90] : 35);
    } else {
      tone([[200, 0.2, 0, "sawtooth"], [140, 0.34, 0.16, "sawtooth"]]);
      buzz([90, 50, 90]);
    }
  }

  /* ----- 送出、結果、例句發音 ----- */
  function vqSubmit(giveUp = false) {
    if (vq.done) return vqNext();
    const c = vq.card;
    if (!c) return;
    const need = [0, 1, 2].filter((i) => i !== vq.form);
    if (!giveUp) {
      const empty = need.find((i) => !vqInput(i).value.trim());
      if (empty !== undefined) { retrigger($("#vq-quiz"), "bad"); vqInput(empty).focus(); return; }
    }
    let allOk = true;
    const res = { [vq.form]: { st: "given" } };
    for (const i of need) {
      const el = vqInput(i);
      const ok = !giveUp && checkVerbAnswer(c[FORMS[i][0]], el.value);
      res[i] = { st: ok ? "ok" : "bad", mine: giveUp ? "" : el.value.trim() };
      el.readOnly = true;
      if (!ok) allOk = false;
    }
    vq.done = true;
    vq.total++;
    if (allOk) { vq.ok++; vq.streak++; vq.best = Math.max(vq.best, vq.streak); } else vq.streak = 0;
    vqScore();
    document.activeElement?.blur?.();
    $("#vq-giveup").hidden = true;
    $("#vq-del").disabled = false;
    $("#vq-go").textContent = "下一題";
    renderExamples(c, res);
    fxResult(allOk);
    setTimeout(() => { if (vq.card === c && vq.done && current === "verb") speakExamples(); }, 700);
  }

  // 翻面：front＝輸入框，back＝正確答案＋例句；三列依序翻（instant＝不要動畫）
  function vqFlip(on, instant) {
    const box = $("#vq-rows");
    if (instant || !on) box.classList.add("reset");
    box.classList.toggle("flipped", on);
    if (instant || !on) { void box.offsetWidth; box.classList.remove("reset"); }
  }
  function renderExamples(c, res, instant) {
    FORMS.forEach(([k], i) => {
      const r = res?.[i];
      const b = $$(".vq-back")[i];
      b.textContent = "";
      b.className = "vq-face vq-back vq-ex" + (r && r.st !== "given" ? " " + r.st : "");
      const head = document.createElement("span");
      head.className = "vq-exh";
      const w = document.createElement("span");
      w.className = "vq-form"; w.textContent = showAlts(c[k]);
      head.append(w);
      if (r && r.st !== "given") {
        const m = document.createElement("i");
        m.className = "vq-mark"; m.textContent = r.st === "ok" ? "✓" : "✗";
        head.append(m);
        if (r.st === "bad" && r.mine) {
          const mine = document.createElement("small");
          mine.className = "vq-mine"; mine.textContent = `你寫：${r.mine}`;
          head.append(mine);
        }
      }
      const ex = document.createElement("span");
      ex.className = "vq-exs";
      const text = c["ex" + (i + 1)] || "";
      for (const p of highlightForm(text, c[k])) {
        if (p.hl) { const bb = document.createElement("b"); bb.textContent = p.text; ex.append(bb); } else ex.append(p.text);
      }
      if (!text) ex.textContent = "（還沒有例句）";
      b.append(head, ex);
    });
    vqFlip(true, instant);
  }

  const hiliteRow = (i) => $$(".vq-ex").forEach((el) => el.classList.toggle("speaking", Number(el.dataset.i) === i));
  // 依序念：V1、例句1、V2、例句2、V3、例句3；念到哪一行就把那行框起來
  async function speakExamples(only) {
    const c = vq.card;
    if (!c) return;
    const run = ++vq.run;
    const alive = () => vq.run === run && vq.card === c && current === "verb";
    let all = true;
    for (const i of only === undefined ? [0, 1, 2] : [only]) {
      if (!alive()) return;
      hiliteRow(i);
      const ok = await speakParts([verbSay(c, i), c["ex" + (i + 1)]].filter(Boolean));
      if (!ok || !alive()) { all = false; break; }
      await sleep(250);
    }
    if (!alive()) return;
    hiliteRow(-1);
    // 純看連播：整組念完，停一下自動下一個，直到手動關掉
    if (all && only === undefined && vqLook() && settings.vauto) {
      vq.timer = setTimeout(() => { if (alive() && vqLook() && settings.vauto) vqNext(); }, 1500);
    }
  }

  $("#vq-mode").onclick = () => {
    settings.vmode = vqLook() ? "quiz" : "look";
    saveSettings(); vqRenderMode();
    if (vqCards().length) vqNext();
  };
  $("#vq-auto").onclick = () => {
    settings.vauto = !settings.vauto;
    saveSettings(); vqRenderMode();
    if (settings.vauto && vq.done && vq.card) speakExamples(); else clearTimeout(vq.timer);
  };
  document.addEventListener("keydown", (e) => {
    if (current === "verb" && vqLook() && !sheetOpen() && e.key === "ArrowRight" && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) vqNext();
  });
  // 選單開著 → 暫停自動換卡／播放；沒選項目就關 → 照原本設定繼續
  document.addEventListener("menuopen", () => {
    if (current !== "study" && current !== "verb") return;
    stopSpeech(); clearAdv(); clearTimeout(vq.timer); vq.run++;
  });
  document.addEventListener("menuclose", (e) => {
    if (e.detail.picked || editing) return;
    if (current === "study" && settings.autoNext && state.current) playCard();
    else if (current === "verb" && vqLook() && settings.vauto && vq.done && vq.card) speakExamples();
  });
  $("#vq-go").onclick = () => vqSubmit();
  $("#vq-giveup").onclick = () => vqSubmit(true);
  $("#vq-speak").onclick = () => {
    const c = vq.card;
    if (!c) return;
    if (vq.done) speakExamples(); else speakParts([verbSay(c, vq.form)]);
  };
  $("#vq-word").onclick = () => { const c = vq.card; if (c) { $("#vq-word").classList.toggle("sn-on"); speakParts([verbSay(c, vq.form)]); } };
  $("#vq-rows").addEventListener("click", (e) => {
    const b = e.target.closest(".vq-ex");
    if (b) speakExamples(Number(b.dataset.i));
  });
  $("#vq-quiz").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || !e.target.matches?.("input")) return;
    e.preventDefault();
    if (vq.done) return vqNext();
    const need = [0, 1, 2].filter((i) => i !== vq.form);
    const at = need.indexOf(Number(e.target.dataset.i));
    if (at >= 0 && at < need.length - 1) vqInput(need[at + 1]).focus(); else vqSubmit();
  });
  document.addEventListener("keydown", (e) => {
    if (current !== "verb" || !vq.done || e.key !== "Enter" || e.isComposing || sheetOpen()) return;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target?.tagName || "")) return;
    vqNext();
  });

  /* ----- 刪除（單個／多個）與「已刪除的內建動詞」記錄 ----- */
  // 記在同一個 cards 集合裡的一份 verbmeta 文件，換裝置也同步；用來避免「補入內建動詞」把你刪掉的又補回來
  const SEED_KEYS = new Set(VERB_SEED.map((r) => r[0].toLowerCase()));
  const vkey = (v) => String(v || "").trim().toLowerCase();
  const saveGone = () => setDoc(doc(db, "wordcards", state.uid, "cards", "verbmeta"), { type: "verbmeta", gone: [...state.gone] }).catch(syncError);
  function markGone(cards) {
    let ch = false;
    for (const c of cards) { const k = vkey(c.v1); if (SEED_KEYS.has(k) && !state.gone.has(k)) { state.gone.add(k); ch = true; } }
    if (ch) saveGone();
  }
  function unmarkGone(cards) {
    let ch = false;
    for (const c of cards) if (state.gone.delete(vkey(c.v1))) ch = true;
    if (ch) saveGone();
  }
  function deleteVerbs(cards) {
    if (!cards.length) return;
    const backup = cards.map((c) => ({ id: c.id, data: toData(c) }));
    for (let i = 0; i < cards.length; i += 400) {
      const batch = writeBatch(db);
      cards.slice(i, i + 400).forEach((c) => batch.delete(cardRef(c.id)));
      batch.commit().catch(syncError);
    }
    cards.forEach((c) => { state.verbs.delete(c.id); vm.sel.delete(c.id); });
    markGone(cards);
    toast(cards.length === 1 ? `已刪除「${cards[0].v1}」` : `已刪除 ${cards.length} 個動詞`, { label: "復原", fn: () => {
      for (let i = 0; i < backup.length; i += 400) {
        const batch = writeBatch(db);
        backup.slice(i, i + 400).forEach((x) => batch.set(cardRef(x.id), x.data));
        batch.commit().catch(syncError);
      }
      unmarkGone(backup.map((x) => x.data));
    } });
  }
  $("#vq-del").onclick = () => {
    const c = vq.card;
    if (!c) return;
    confirmDelete(`刪除「${showAlts(c.v1)}」？`, `${showAlts(c.v1)} / ${showAlts(c.v2)} / ${showAlts(c.v3)}。刪除後可以在下方提示按「復原」。`, () => { deleteVerbs([c]); vqNext(); });
  };

  /* ----- 動詞管理：勾選多個一起刪 ----- */
  const vm = { q: "", sel: new Set() };
  const vmList = () => {
    const q = vm.q.trim().toLowerCase();
    return [...state.verbs.values()]
      .filter((c) => !q || `${c.v1} ${c.v2} ${c.v3} ${c.note || ""}`.toLowerCase().includes(q))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  };
  function vmSync() {
    $("#vm-del").textContent = `刪除所選 (${vm.sel.size})`;
    $("#vm-del").disabled = vm.sel.size === 0;
  }
  function vmRender() {
    for (const id of [...vm.sel]) if (!state.verbs.has(id)) vm.sel.delete(id);
    const list = vmList();
    $("#vm-count").textContent = `${state.verbs.size} 個`;
    const frag = document.createDocumentFragment();
    const sn = serialMap("verb");
    for (const c of list) {
      const row = document.createElement("label");
      row.className = "vm-row";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.dataset.id = c.id; cb.checked = vm.sel.has(c.id);
      const main = document.createElement("span");
      main.className = "vm-main";
      const no = document.createElement("span"); no.className = "vm-no"; no.textContent = sn.get(c.id);
      const chk = document.createElement("span"); chk.className = "vm-chk";
      const b = document.createElement("b"); b.textContent = c.v1;
      main.append(b, ` · ${c.v2 || "?"} · ${c.v3 || "?"}`);
      if (c.note) { const sm = document.createElement("small"); sm.textContent = c.note; main.append(sm); }
      chk.append(cb, no);
      row.append(chk, main);
      frag.append(row);
    }
    $("#vm-list").textContent = "";
    $("#vm-list").append(frag);
    $("#vm-empty").hidden = list.length > 0;
    vmSync();
  }
  $("#vm-list").addEventListener("change", (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    if (e.target.checked) vm.sel.add(id); else vm.sel.delete(id);
    vmSync();
  });
  $("#vm-q").addEventListener("input", (e) => { vm.q = e.target.value; vmRender(); });
  $("#vm-all").onclick = () => { vmList().forEach((c) => vm.sel.add(c.id)); vmRender(); };
  $("#vm-none").onclick = () => { vm.sel.clear(); vmRender(); };
  $("#vm-back").onclick = () => { show("verb"); vqRefresh(); };
  $("#vm-seed").onclick = () => seedVerbs();
  $("#vm-del").onclick = () => {
    const cards = [...vm.sel].map((id) => state.verbs.get(id)).filter(Boolean);
    if (!cards.length) return;
    if (cards.length > 5 && !confirm(`確定刪除 ${cards.length} 個動詞？`)) return;
    deleteVerbs(cards);
    vmRender();
  };

  function seedVerbs() {
    const have = new Set([...state.verbs.values()].map((c) => vkey(c.v1)));
    let fresh = VERB_SEED.filter((r) => !have.has(r[0].toLowerCase()) && !state.gone.has(r[0].toLowerCase()));
    if (!fresh.length) {
      const back = VERB_SEED.filter((r) => !have.has(r[0].toLowerCase()));
      if (back.length && confirm(`內建動詞裡有 ${back.length} 個是你之前刪除的，要補回來嗎？`)) {
        back.forEach((r) => state.gone.delete(r[0].toLowerCase()));
        saveGone();
        fresh = back;
      } else { toast("內建的動詞都已經在裡面了"); return 0; }
    }
    const base = Date.now(), col = cardsCol(), jobs = [];
    for (let i = 0; i < fresh.length; i += 400) {
      const batch = writeBatch(db);
      fresh.slice(i, i + 400).forEach((r, j) => {
        const data = { type: "verb", word: r[0], createdAt: base + i + j };
        VERB_FIELDS.forEach((k, x) => { data[k] = r[x] || ""; });
        batch.set(doc(col), data);
      });
      jobs.push(batch.commit());
    }
    Promise.all(jobs).catch(syncError);   // 不 await：離線也立刻生效
    toast(`已加入 ${fresh.length} 個動詞`);
    return fresh.length;
  }
  $("#vq-seed").onclick = seedVerbs;
  $("#vq-seed").textContent = `載入內建 ${VERB_SEED.length} 個動詞`;

  /* ---------------- 管理全部卡片 ---------------- */
  const PAGE = 100;
  const mg = { q: "", f: "all", limit: PAGE, dirty: false };
  const mBody = $("#m-body");

  function mkCell(cls, el) { const td = document.createElement("td"); td.className = cls; td.append(el); return td; }
  function mkField(tag, k, v, label) {
    const el = document.createElement(tag);
    el.dataset.k = k;
    el.value = v || "";
    el.setAttribute("aria-label", label);
    el.spellcheck = false;
    if (tag === "input") { el.autocomplete = "off"; el.autocapitalize = "off"; } else el.rows = 2;
    return el;
  }
  function mkBtn(cls, text, act) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "mbtn " + cls; b.dataset.act = act; b.textContent = text;
    return b;
  }
  function mkRow(c, no) {
    const tr = document.createElement("tr");
    tr.dataset.id = c.id;
    const wordCell = mkCell("c-word", mkField("input", "word", c.word, "單字"));
    const sn = document.createElement("span");      // 序號（跟「文字編輯」的編號一樣，練習範圍用）
    sn.className = "m-no"; sn.textContent = no; sn.title = "序號";
    wordCell.append(sn);
    tr.append(
      wordCell,
      mkCell("c-example", mkField("textarea", "example", c.example, "例句")),
      mkCell("c-note", mkField("input", "note", c.note, "備註")),
      mkCell("c-trans", mkField("textarea", "trans", c.trans, "例句翻譯")),
      mkCell("c-status", mkBtn("st", c.status === "known" ? "已會" : "待學", "toggle")),
      mkCell("c-del", mkBtn("del", "刪除", "del")),
    );
    return tr;
  }

  function renderManage() {
    mg.dirty = false;
    const q = mg.q.trim().toLowerCase();
    const list = [...state.cards.values()]
      .filter((c) => (mg.f === "all" || (mg.f === "known") === (c.status === "known"))
        && (!q || `${c.word}\n${c.example || ""}\n${c.note || ""}\n${c.trans || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    $("#m-count").textContent = `${list.length} 張`;
    const frag = document.createDocumentFragment();
    const sn = serialMap("word");
    list.slice(0, mg.limit).forEach((c) => frag.append(mkRow(c, sn.get(c.id))));
    mBody.textContent = "";
    mBody.append(frag);
    $("#m-more").hidden = list.length <= mg.limit;
    $("#m-more").textContent = `顯示更多（還有 ${list.length - mg.limit} 張）`;
    $("#m-empty").hidden = list.length > 0;
    $("#m-empty").textContent = state.cards.size ? "沒有符合的字卡。" : "還沒有字卡，先匯入一批吧。";
  }
  // 正在打字時不要重畫整張表（會搶走游標），等離開格子再更新
  function refreshManage() {
    const ae = document.activeElement;
    if (ae && ae.matches?.("[data-k]") && mBody.contains(ae)) mg.dirty = true;
    else renderManage();
  }
  mBody.addEventListener("focusout", () => setTimeout(() => {
    const ae = document.activeElement;
    if (mg.dirty && !(ae && ae.matches?.("[data-k]") && mBody.contains(ae))) renderManage();
  }, 0));
  mBody.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-k]") && !e.isComposing) { e.preventDefault(); e.target.blur(); }
  });
  mBody.addEventListener("change", (e) => {
    const el = e.target.closest("[data-k]");
    if (!el) return;
    const tr = el.closest("tr");
    const c = state.cards.get(tr.dataset.id);
    if (!c) return;
    const k = el.dataset.k;
    const v = el.value.replace(/\s*\n\s*/g, " ").trim();
    el.value = v;
    if (k === "word" && !v) { el.value = c.word; toast("單字不能空白"); return; }
    if (v === (c[k] || "")) return;
    c[k] = v;
    updateDoc(cardRef(c.id), { [k]: v }).catch(syncError);
    tr.classList.remove("saved"); void tr.offsetWidth; tr.classList.add("saved");
  });
  mBody.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const c = state.cards.get(b.closest("tr").dataset.id);
    if (!c) return;
    if (b.dataset.act === "del") removeCard(c);
    else updateDoc(cardRef(c.id), c.status === "known" ? { status: "new" } : { status: "known", knownAt: Date.now() }).catch(syncError);
  });
  $("#m-q").addEventListener("input", (e) => { mg.q = e.target.value; mg.limit = PAGE; renderManage(); });
  $$(".seg [data-f]").forEach((b) => b.addEventListener("click", () => {
    mg.f = b.dataset.f; mg.limit = PAGE;
    $$(".seg [data-f]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderManage();
  }));
  $("#m-more").onclick = () => { mg.limit += PAGE; renderManage(); };
  $("#m-import").onclick = () => { show("import"); updatePreview(); };

  /* ---------------- 匯入 ---------------- */
  function updatePreview() {
    const { rows } = parseImport($("#im-text").value);
    const el = $("#im-preview");
    $("#im-go").disabled = rows.length === 0;
    el.textContent = rows.length
      ? `偵測到 ${rows.length} 張 · 第一張：${rows[0].word} / ${rows[0].example || "（無例句）"}`
      : "";
  }
  $("#im-text").addEventListener("input", updatePreview);
  $("#im-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("#im-text").value = await f.text();
    e.target.value = "";
    updatePreview();
  };
  $("#im-go").onclick = () => {
    const { rows } = parseImport($("#im-text").value);
    const seen = new Set([...state.cards.values()].map((c) => cardKey(c.word, c.example)));
    const fresh = [];
    let dup = 0;
    for (const r of rows) {
      const k = cardKey(r.word, r.example);
      if (seen.has(k)) { dup++; continue; }
      seen.add(k);
      fresh.push(r);
    }
    if (!fresh.length) { $("#im-preview").textContent = `沒有新字卡（${dup} 張重複）`; return; }

    const base = Date.now();
    const col = cardsCol();
    const jobs = [];
    for (let i = 0; i < fresh.length; i += 400) {
      const batch = writeBatch(db);
      fresh.slice(i, i + 400).forEach((r, j) =>
        batch.set(doc(col), { word: r.word, example: r.example, note: r.note, trans: r.trans || "", status: "new", createdAt: base + i + j }));
      jobs.push(batch.commit());
    }
    // 不 await：離線時也立刻生效，連線後自動同步
    Promise.all(jobs).catch(syncError);

    $("#im-text").value = "";
    updatePreview();
    show("home");
    renderHome();
    toast(`已新增 ${fresh.length} 張` + (dup ? `，略過重複 ${dup} 張` : ""));
  };

  /* ---------------- 總編輯（純文字編輯器） ---------------- */
  const bk = { snap: [], orig: "", scope: "all", kind: "word" };
  const bkVerb = () => bk.kind === "verb";
  const bkFields = () => (bkVerb() ? VERB_FIELDS : ["word", "example", "note", "trans"]);
  const bkDirty = () => $("#bk-text").value !== bk.orig;
  const bkRender = (list) => {
    bk.snap = list;
    bk.orig = list.map((c, i) => (bkVerb() ? verbBulkLine(c, i + 1) : bulkLine(c, i + 1))).join("\n");
    $("#bk-text").value = bk.orig;
    $("#bk-count").textContent = `${list.length} ${bkVerb() ? "個" : "張"}`;
    bkSummary();
  };
  function bkLoad() {
    if (bkVerb()) {
      bkRender([...state.verbs.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
      return;
    }
    const f = bk.scope;
    bkRender([...state.cards.values()]
      .filter((c) => f === "all" || (f === "known") === (c.status === "known"))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
  }
  function bkSummary() {
    const d = bkVerb() ? diffVerbBulk(bk.snap, $("#bk-text").value) : diffBulk(bk.snap, $("#bk-text").value);
    const moved = bkOrderChanged(d);
    const n = d.updates.length + d.adds.length + d.deletes.length;
    $("#bk-save").disabled = !(n || moved);
    $("#bk-save").textContent = bkDirty() ? "儲存 ●" : "儲存";
    let dup, extra = "";
    if (bkVerb()) {
      const have = new Set([...state.verbs.values()].map((c) => String(c.v1).trim().toLowerCase()));
      dup = d.adds.filter((r) => have.has(r.v1.toLowerCase())).length;
      const bad = d.lines.filter((l) => !(l.row.v2 && l.row.v3)).length;
      if (bad) extra = ` · ⚠ ${bad} 行缺 V2／V3（不會出題）`;
    } else {
      const keys = new Set([...state.cards.values()].map((c) => cardKey(c.word, c.example)));
      dup = d.adds.filter((r) => keys.has(cardKey(r.word, r.example))).length;
    }
    $("#bk-sum").textContent = n || moved || extra
      ? `修改 ${d.updates.length} · 新增 ${d.adds.length}${dup ? `（${dup} 筆與現有重複）` : ""} · 刪除 ${d.deletes.length}${moved ? " · 順序有調整" : ""}${extra}`
      : "";
    return d;
  }
  // 依文字順序重新分配既有卡片的 createdAt（順序有變才回傳 true）
  function bkTimes(d) {
    const S = d.lines.filter((l) => l.card).map((l) => l.card.createdAt || 0).sort((a, b) => a - b);
    let ei = 0;
    const t = d.lines.map((l) => (l.card ? S[ei++] : null));
    for (let i = 0; i < t.length;) {
      if (t[i] !== null) { i++; continue; }
      let j = i; while (j < t.length && t[j] === null) j++;
      const k = j - i, p = i > 0 ? t[i - 1] : null, n = j < t.length ? t[j] : null;
      for (let x = 0; x < k; x++) {
        t[i + x] = p !== null && n !== null ? p + ((n - p) * (x + 1)) / (k + 1)
          : p !== null ? p + x + 1 : n !== null ? n - (k - x) : Date.now() + x;
      }
      i = j;
    }
    return t;
  }
  function bkOrderChanged(d) {
    const t = bkTimes(d);
    return d.lines.some((l, i) => l.card && (l.card.createdAt || 0) !== t[i]);
  }
  $("#bk-text").addEventListener("input", bkSummary);
  $("#bk-text").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); bkSave(); }
  });
  // Enter 自動編號：不管游標在行的哪裡，都在「目前這行下面」新增一行，編號 = 目前最大編號 + 1
  // （例：[1][2][3] 在 [1] 按 Enter → [1][4][2][3]；儲存後會依這個順序重新編號）
  $("#bk-text").addEventListener("beforeinput", (e) => {
    if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") return;
    const ta = e.target;
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    if (a !== b) return;
    const ls = v.lastIndexOf("\n", a - 1) + 1;
    const le0 = v.indexOf("\n", a);
    const le = le0 === -1 ? v.length : le0;
    e.preventDefault();
    if (/^\s*\[\d+\]\s*$/.test(v.slice(ls, le))) return;       // 空的編號行：不要再疊一個
    let max = bk.snap.length;
    for (const m of v.matchAll(/^\s*\[(\d+)\]/gm)) max = Math.max(max, Number(m[1]));
    const ins = `\n[${max + 1}] `;
    ta.setSelectionRange(le, le);
    if (!document.execCommand || !document.execCommand("insertText", false, ins)) {
      ta.setRangeText(ins, le, le, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  // 空的編號行（只有 [n]、還沒輸入內容）按退格 → 整個編號連同換行一起刪掉，回到上一行行尾
  $("#bk-text").addEventListener("beforeinput", (e) => {
    if (e.inputType !== "deleteContentBackward") return;
    const ta = e.target;
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    if (a !== b) return;
    const ls = v.lastIndexOf("\n", a - 1) + 1;
    const le0 = v.indexOf("\n", a);
    const le = le0 === -1 ? v.length : le0;
    if (a !== le || !/^\s*\[\d+\]\s*$/.test(v.slice(ls, le))) return;   // 游標要在這行行尾、且這行只有編號
    e.preventDefault();
    const from = ls > 0 ? ls - 1 : ls;
    ta.setSelectionRange(from, le);
    if (!document.execCommand || !document.execCommand("delete")) {
      ta.setRangeText("", from, le, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  window.addEventListener("beforeunload", (e) => { if (current === "bulk" && bkDirty()) { e.preventDefault(); e.returnValue = ""; } });
  function bkOpen(kind) {
    bk.kind = kind;
    const v = kind === "verb";
    $("#bk-scope").hidden = v; $("#bk-seed").hidden = !v;
    $("#bk-hint-verb").hidden = !v; $("#bk-hint-word").hidden = v;
    if (!v) { bk.scope = mg.f; $("#bk-scope").value = bk.scope; }
    bkLoad(); show("bulk");
  }
  $("#m-bulk").onclick = () => bkOpen("word");
  $("#vq-bulk").onclick = () => { vm.q = ""; $("#vm-q").value = ""; vm.sel.clear(); show("vmanage"); vmRender(); };
  $("#vm-bulk").onclick = () => bkOpen("verb");
  $("#bk-seed").onclick = () => {
    if (!seedVerbs()) return;
    setTimeout(() => { if (current === "bulk" && bkVerb() && !bkDirty()) bkLoad(); }, 300);
  };
  $("#bk-scope").onchange = (e) => {
    if (bkDirty() && !confirm("有尚未儲存的修改，切換範圍會捨棄，確定嗎？")) { e.target.value = bk.scope; return; }
    bk.scope = e.target.value; bkLoad();
  };
  $("#bk-reset").onclick = () => { if (!bkDirty() || confirm("捨棄所有尚未儲存的修改？")) { $("#bk-text").value = bk.orig; bkSummary(); } };
  $("#bk-back").onclick = () => {
    if (bkDirty() && !confirm("有尚未儲存的修改，確定離開？")) return;
    if (bkVerb()) { show("vmanage"); vmRender(); return; }
    show("manage"); renderManage();
  };
  $("#bk-save").onclick = bkSave;
  function bkSave() {
    const d = bkSummary();
    const t = bkTimes(d);
    const moved = bkOrderChanged(d);
    if (!(d.updates.length || d.adds.length || d.deletes.length || moved)) return;
    if (d.deletes.length && !confirm(`將刪除 ${d.deletes.length} 張字卡，確定嗎？（儲存後可按「復原」）`)) return;
    const ops = [];
    const next = [];   // 儲存後的新快照（依文字順序）
    d.lines.forEach((l, i) => {
      const r = l.row;
      const vals = {};
      for (const k of bkFields()) vals[k] = r[k] || "";
      if (bkVerb()) vals.word = r.v1;   // 保留 word 欄位，萬一舊版 App 讀到也不會壞
      if (l.card) {
        const patch = {};
        for (const k of Object.keys(vals)) if (vals[k] !== (l.card[k] || "")) patch[k] = vals[k];
        if ((l.card.createdAt || 0) !== t[i]) patch.createdAt = t[i];
        if (Object.keys(patch).length) ops.push((b) => b.update(cardRef(l.card.id), patch));
        next.push({ ...l.card, ...vals, createdAt: t[i] });
      } else {
        const ref = doc(cardsCol());
        const data = bkVerb()
          ? { ...vals, type: "verb", createdAt: t[i] }
          : { ...vals, status: "new", createdAt: t[i] };
        ops.push((b) => b.set(ref, data));
        next.push({ id: ref.id, ...data });
      }
    });
    const backup = d.deletes.map((c) => ({ id: c.id, data: toData(c) }));
    if (bkVerb()) markGone(d.deletes);
    for (const c of d.deletes) ops.push((b) => b.delete(cardRef(c.id)));
    const jobs = [];
    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach((f) => f(batch));
      jobs.push(batch.commit());
    }
    // 不 await：離線時也立刻生效，連線後自動同步
    Promise.all(jobs).catch(syncError);
    bkRender(next);   // 留在編輯器，並替新增的行補上編號
    const msg = `已儲存：修改 ${d.updates.length}、新增 ${d.adds.length}、刪除 ${d.deletes.length}`;
    if (backup.length) {
      toast(msg, { label: "復原刪除", fn: () => {
        const b = writeBatch(db);
        backup.slice(0, 400).forEach((x) => b.set(cardRef(x.id), x.data));
        b.commit().catch(syncError);
        if (bkVerb()) unmarkGone(backup.map((x) => x.data));
        setTimeout(() => { if (current === "bulk" && !bkDirty()) bkLoad(); }, 400);
      } });
    } else toast(msg);
  }

  /* ---------------- 設定 ---------------- */
  function fillSettings() {
    const sl = $("#s-lang");
    if (!sl.options.length) LANGS.forEach(([v, t]) => sl.add(new Option(t, v)));
    sl.value = settings.lang;
    $("#s-rate").value = settings.rate;
    $("#s-rate-out").textContent = settings.rate.toFixed(2) + "×";
    $("#s-auto").checked = settings.autoplay;
    $("#s-readzh").checked = settings.readZh;
    $("#s-shuffle").checked = settings.shuffle;
    $("#s-fx").checked = settings.fx;
    $("#s-account").textContent = auth.currentUser?.email || "";
  }
  $("#s-lang").onchange = (e) => { settings.lang = e.target.value; saveSettings(); };
  $("#s-readzh").onchange = (e) => { settings.readZh = e.target.checked; saveSettings(); };
  $("#s-rate").oninput = (e) => {
    settings.rate = parseFloat(e.target.value);
    $("#s-rate-out").textContent = settings.rate.toFixed(2) + "×";
    saveSettings();
  };
  $("#s-auto").onchange = (e) => { settings.autoplay = e.target.checked; saveSettings(); };
  $("#s-shuffle").onchange = (e) => { settings.shuffle = e.target.checked; saveSettings(); };
  $("#s-fx").onchange = (e) => { settings.fx = e.target.checked; saveSettings(); };
  $("#s-test").onclick = () => speakParts([SAMPLES[settings.lang] || "Hello", ...(autoZh() ? ["這是中文語音測試。"] : [])]);
}

/* ------------------------------------------------------------------ */
/* PWA                                                                  */
/* ------------------------------------------------------------------ */
// Service Worker 註冊與安裝按鈕在 pwa.js
