import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult, signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, writeBatch, setDoc, updateDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { parseImport, cardKey, shuffle, splitHighlight } from "./lib.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = ["setup", "auth", "home", "study", "manage", "done", "import", "settings"];
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
const DEFAULTS = { lang: "en-US", voice: "", rate: 0.9, autoplay: true, shuffle: true, autoNext: false };
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
    u.onend = u.onerror = () => resolve();
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
    let list = [...state.cards.values()].filter(inMode);
    if (!list.length) { toast("沒有可看的字卡"); show("home"); renderHome(); return; }
    list = settings.shuffle ? shuffle(list) : list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.queue = list.map((c) => c.id);
    state.idx = 0;
    state.stats = { keep: 0, del: 0, next: 0 };
    $("#st-auto").checked = settings.autoNext;
    show("study");
    showCard();
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

  // 念出來；連播開著時，念完停一下就自動跳下一張
  function playCard(parts) {
    const c = state.current;
    if (!c) return;
    clearAdv();
    const p = speakParts(parts || [c.word, c.example].filter(Boolean));
    if (!settings.autoNext) return;
    p.then((ok) => {
      if (!ok || !settings.autoNext) return;
      advTimer = setTimeout(() => {
        if (settings.autoNext && !editing && current === "study" && state.current === c) act("next");
      }, 1200);
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
  $("#st-auto").onchange = (e) => {
    settings.autoNext = e.target.checked;
    saveSettings();
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
