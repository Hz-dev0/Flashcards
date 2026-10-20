import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, writeBatch, setDoc, updateDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js?v=5";
import { parseImport, cardKey, shuffle, splitHighlight, bulkLine, diffBulk } from "./lib.js?v=5";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = ["setup", "auth", "home", "study", "manage", "bulk", "done", "import", "settings"];
let current = null;

function show(name) {
  current = name;
  for (const v of VIEWS) $(`#v-${v}`).hidden = v !== name;
  window.scrollTo(0, 0);
  updateLock();
}

// 連播時保持螢幕不熄滅（鎖屏或切到背景時，瀏覽器會中斷語音合成）
let wakeLock = null;
async function updateLock() {
  const want = settings.autoNext && current === "study" && !document.hidden;
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
const DEFAULTS = { lang: "en-US", voice: "", rate: 0.9, autoplay: true, shuffle: true, autoNext: false, loop: false };
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
const normLang = (l) => String(l || "").replace("_", "-").toLowerCase();

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices();
  if (current === "settings") fillVoices();
}
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }

function pickVoice() {
  if (!voices.length) return null;
  if (settings.voice) {
    const v = voices.find((x) => x.name === settings.voice);
    if (v) return v;
  }
  const want = settings.lang.toLowerCase();
  const prim = want.split("-")[0];
  return voices.find((v) => normLang(v.lang) === want)
      || voices.find((v) => normLang(v.lang).startsWith(prim))
      || null;
}

function utter(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = settings.lang;
    u.rate = settings.rate;
    const v = pickVoice();
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
function speakParts(parts) {
  if (!parts.length) return Promise.resolve(false);
  const token = ++speakToken;
  if (!synth) return sleep(2500).then(() => token === speakToken);
  const busy = synth.speaking || synth.pending;
  if (busy) synth.cancel();
  const run = async () => {
    for (let i = 0; i < parts.length; i++) {
      if (token !== speakToken) return false;
      if (i > 0) { await sleep(350); if (token !== speakToken) return false; }
      await utter(parts[i]);
    }
    return token === speakToken;
  };
  // 沒有正在念的內容時同步呼叫，避免 iOS 把它當成非使用者操作
  return new Promise((res) => { busy ? setTimeout(() => run().then(res), 80) : run().then(res); });
}
let advTimer = 0;
const clearAdv = () => { clearTimeout(advTimer); advTimer = 0; };
function stopSpeech() { speakToken++; clearAdv(); if (synth) synth.cancel(); }
document.addEventListener("visibilitychange", () => { if (document.hidden) stopSpeech(); });

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
    uid: null, cards: new Map(), unsub: null, ready: false, pending: false,
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
  getRedirectResult(auth).catch((err) => authMsg(authError(err)));
  $("#s-logout").onclick = () => { stopSpeech(); signOut(auth); };

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
        if (ch.type === "removed") state.cards.delete(ch.doc.id);
        else state.cards.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
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
    state.uid = null; state.cards.clear(); state.ready = false;
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
    $("#h-total").textContent = n + k;
    $("#h-learn").disabled = n === 0;
    $("#h-review").disabled = k === 0;
    const empty = $("#h-empty");
    empty.hidden = state.cards.size > 0;
    empty.textContent = state.ready ? "還沒有字卡，先匯入一批吧。" : "載入中…";
    renderSync();
    if (current === "manage") refreshManage();
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
  $("#h-manage").onclick = () => { mg.q = ""; $("#m-q").value = ""; mg.limit = PAGE; show("manage"); renderManage(); };
  $("#h-import").onclick = () => { show("import"); updatePreview(); };
  $("#h-settings").onclick = () => { fillSettings(); show("settings"); };
  $$("[data-back]").forEach((b) => b.addEventListener("click", () => { stopSpeech(); show("home"); renderHome(); }));

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
    let list = [...state.cards.values()].filter(inMode);
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

  function renderCard(c) {
    $("#c-word").textContent = c.word;
    const ex = $("#c-example");
    ex.textContent = "";
    for (const p of splitHighlight(c.example, c.word)) {
      if (p.hl) { const b = document.createElement("b"); b.textContent = p.text; ex.append(b); }
      else ex.append(p.text);
    }
    ex.hidden = !c.example;
    $("#c-note").textContent = c.note || "";
    $("#c-note").hidden = !c.note;
  }

  let playCount = 0;
  // 念出來；連播開著時，念完停一下就自動跳下一張
  function playCard(parts) {
    const c = state.current;
    if (!c) return;
    clearAdv();
    const list = parts || [c.word, c.example].filter(Boolean);
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

  function showCard() {
    clearAdv();
    const c = nextVisible();
    state.current = c;
    if (!c) return finish();
    renderCard(c);
    $("#st-progress").textContent = `${state.idx + 1} / ${state.queue.length}`;
    $("#a-keep").textContent = state.mode === "known" ? "還不熟" : "會了";
    const stage = $("#stage");
    stage.classList.remove("swap"); void stage.offsetWidth; stage.classList.add("swap");
    if (settings.autoplay || settings.autoNext) playCard();
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

  $("#a-del").onclick = () => act("del");
  $("#a-keep").onclick = () => act("keep");
  $("#st-speak").onclick = () => playCard();
  $("#c-word").onclick = () => { const c = state.current; if (c) playCard([c.word]); };
  $("#c-example").onclick = () => { const c = state.current; if (c && c.example) playCard([c.example]); };
  // 播放模式：關 → 連播 → 單字循環 → 關（點擊切換）
  const MODE_TXT = { off: "連播開啟", next: "關閉連播", loop: "單字循環" };
  const curMode = () => (!settings.autoNext ? "off" : settings.loop ? "loop" : "next");
  function renderMode() {
    const m = curMode();
    const b = $("#st-mode");
    b.dataset.mode = m;
    $("#st-mode-txt").textContent = MODE_TXT[m];
  }
  $("#st-mode").onclick = () => {
    const m = curMode();
    settings.autoNext = m === "off" ? true : m === "next";
    settings.loop = m === "next";
    saveSettings();
    renderMode();
    updateLock();
    if (settings.autoNext) playCard(); else clearAdv();
  };

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
    const patch = { word: clean($("#ed-word").value), example: clean($("#ed-example").value), note: clean($("#ed-note").value) };
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
    }
  });

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
  function mkRow(c) {
    const tr = document.createElement("tr");
    tr.dataset.id = c.id;
    tr.append(
      mkCell("c-word", mkField("input", "word", c.word, "單字")),
      mkCell("c-example", mkField("textarea", "example", c.example, "例句")),
      mkCell("c-note", mkField("input", "note", c.note, "備註")),
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
        && (!q || `${c.word}\n${c.example || ""}\n${c.note || ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    $("#m-count").textContent = `${list.length} 張`;
    const frag = document.createDocumentFragment();
    list.slice(0, mg.limit).forEach((c) => frag.append(mkRow(c)));
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
        batch.set(doc(col), { word: r.word, example: r.example, note: r.note, status: "new", createdAt: base + i + j }));
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
  const bk = { snap: [], orig: "", scope: "all" };
  const bkDirty = () => $("#bk-text").value !== bk.orig;
  const bkRender = (list) => {
    bk.snap = list;
    bk.orig = list.map((c, i) => bulkLine(c, i + 1)).join("\n");
    $("#bk-text").value = bk.orig;
    $("#bk-count").textContent = `${list.length} 張`;
    bkSummary();
  };
  function bkLoad() {
    const f = bk.scope;
    bkRender([...state.cards.values()]
      .filter((c) => f === "all" || (f === "known") === (c.status === "known"))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
  }
  function bkSummary() {
    const d = diffBulk(bk.snap, $("#bk-text").value);
    const moved = bkOrderChanged(d);
    const n = d.updates.length + d.adds.length + d.deletes.length;
    $("#bk-save").disabled = !(n || moved);
    $("#bk-save").textContent = bkDirty() ? "儲存 ●" : "儲存";
    const keys = new Set([...state.cards.values()].map((c) => cardKey(c.word, c.example)));
    const dup = d.adds.filter((r) => keys.has(cardKey(r.word, r.example))).length;
    $("#bk-sum").textContent = n || moved
      ? `修改 ${d.updates.length} · 新增 ${d.adds.length}${dup ? `（${dup} 張與現有重複）` : ""} · 刪除 ${d.deletes.length}${moved ? " · 順序有調整" : ""}`
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
  window.addEventListener("beforeunload", (e) => { if (current === "bulk" && bkDirty()) { e.preventDefault(); e.returnValue = ""; } });
  $("#m-bulk").onclick = () => { bk.scope = mg.f; $("#bk-scope").value = bk.scope; bkLoad(); show("bulk"); };
  $("#bk-scope").onchange = (e) => {
    if (bkDirty() && !confirm("有尚未儲存的修改，切換範圍會捨棄，確定嗎？")) { e.target.value = bk.scope; return; }
    bk.scope = e.target.value; bkLoad();
  };
  $("#bk-reset").onclick = () => { if (!bkDirty() || confirm("捨棄所有尚未儲存的修改？")) { $("#bk-text").value = bk.orig; bkSummary(); } };
  $("#bk-back").onclick = () => {
    if (bkDirty() && !confirm("有尚未儲存的修改，確定離開？")) return;
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
      if (l.card) {
        const patch = {};
        if (r.word !== l.card.word) patch.word = r.word;
        if ((r.example || "") !== (l.card.example || "")) patch.example = r.example || "";
        if ((r.note || "") !== (l.card.note || "")) patch.note = r.note || "";
        if ((l.card.createdAt || 0) !== t[i]) patch.createdAt = t[i];
        if (Object.keys(patch).length) ops.push((b) => b.update(cardRef(l.card.id), patch));
        next.push({ ...l.card, word: r.word, example: r.example || "", note: r.note || "", createdAt: t[i] });
      } else {
        const ref = doc(cardsCol());
        const data = { word: r.word, example: r.example || "", note: r.note || "", status: "new", createdAt: t[i] };
        ops.push((b) => b.set(ref, data));
        next.push({ id: ref.id, ...data });
      }
    });
    const backup = d.deletes.map((c) => ({ id: c.id, data: toData(c) }));
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
        setTimeout(() => { if (current === "bulk" && !bkDirty()) bkLoad(); }, 400);
      } });
    } else toast(msg);
  }

  /* ---------------- 設定 ---------------- */
  function fillVoices() {
    const sv = $("#s-voice");
    sv.textContent = "";
    sv.add(new Option("自動（建議）", ""));
    const prim = settings.lang.split("-")[0].toLowerCase();
    voices.filter((v) => normLang(v.lang).startsWith(prim))
      .forEach((v) => sv.add(new Option(`${v.name} (${v.lang})`, v.name)));
    sv.value = [...sv.options].some((o) => o.value === settings.voice) ? settings.voice : "";
  }
  function fillSettings() {
    const sl = $("#s-lang");
    if (!sl.options.length) LANGS.forEach(([v, t]) => sl.add(new Option(t, v)));
    sl.value = settings.lang;
    fillVoices();
    $("#s-rate").value = settings.rate;
    $("#s-rate-out").textContent = settings.rate.toFixed(2) + "×";
    $("#s-auto").checked = settings.autoplay;
    $("#s-shuffle").checked = settings.shuffle;
    $("#s-account").textContent = auth.currentUser?.email || "";
  }
  $("#s-lang").onchange = (e) => { settings.lang = e.target.value; settings.voice = ""; saveSettings(); fillVoices(); };
  $("#s-voice").onchange = (e) => { settings.voice = e.target.value; saveSettings(); };
  $("#s-rate").oninput = (e) => {
    settings.rate = parseFloat(e.target.value);
    $("#s-rate-out").textContent = settings.rate.toFixed(2) + "×";
    saveSettings();
  };
  $("#s-auto").onchange = (e) => { settings.autoplay = e.target.checked; saveSettings(); };
  $("#s-shuffle").onchange = (e) => { settings.shuffle = e.target.checked; saveSettings(); };
  $("#s-test").onclick = () => speakParts([SAMPLES[settings.lang] || "Hello"]);
}

/* ------------------------------------------------------------------ */
/* PWA                                                                  */
/* ------------------------------------------------------------------ */
// Service Worker 註冊與安裝按鈕在 pwa.js
