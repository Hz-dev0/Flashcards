// 純函式（不依賴 DOM / Firebase），方便單獨測試

/**
 * 解析批量匯入文字。
 * 每行一張：  單字  例句  備註(選填)  例句翻譯(選填)   （欄位之間用兩個空白隔開；Tab 分隔也可以；
 * 有欄位要留空、後面還有欄位時請用 Tab）
 * 空行、以 # 或 // 開頭的行會略過。
 */
export function parseImport(text, opts = {}) {
  const comments = opts.comments !== false;
  const rows = [];
  const skipped = [];
  String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || (comments && (line.startsWith("#") || line.startsWith("//")))) return;
      // Tab 優先；否則用「兩個以上空白」；都沒有才退回舊的 | 格式
      const sep = line.includes("\t") ? "\t" : /\s{2,}/.test(line) ? /\s{2,}/ : "|";
      const [word = "", example = "", note = "", ...rest] = line.split(sep).map((s) => s.trim());
      if (!word) {
        skipped.push({ line: i + 1, reason: "缺少單字" });
        return;
      }
      rows.push({ word, example, note, trans: rest.filter(Boolean).join("  "), line: i + 1 });
    });
  return { rows, skipped };
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** 去重用的 key：單字 + 例句（忽略大小寫與多餘空白） */
export function cardKey(word, example) {
  return norm(word) + "\u0000" + norm(example);
}

/** 53-bit 字串雜湊（cyrb53），用來替內建字庫的每張卡產生固定的編號 */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 內建字庫的卡片編號：由「單字 + 例句」決定，跟行號、順序無關，所以在 words.txt 中間插行不會讓進度錯位 */
export const baseCardId = (word, example) => "b" + cyrb53(cardKey(word, example)).toString(36);

/** 單元標題行：「# ===== 1 招聘與求職 =====」或「## 招聘與求職」（行首可有 [編號]）→ 標題；不是標題 → null */
export function headTitle(line) {
  const ln = String(line || "").replace(/^[ \t]*\[\d+\][ \t]*/, "");
  const m = /^\s*#+\s*=+\s*(?:\d+[\s.、．]+)?([^=\s].*?)\s*=+\s*$/.exec(ln) || /^\s*##\s+(.+?)\s*$/.exec(ln);
  return m ? m[1].trim() : null;
}

/**
 * 讀字庫文字檔（words.txt 或 App 內的批量匯入共用）：
 * - 行首的 [編號]（從「文字編輯」複製出來的）自動去掉，標題行前面有也可以
 * - 「# ===== 1 招聘與求職 =====」或「## 招聘與求職」是單元標題；其後的每張卡 row.unit = 標題
 */
export function parseWordsFile(text) {
  const t = String(text || "").replace(/^\uFEFF/, "");
  if (/^\s*<(!doctype|html)/i.test(t)) return { rows: [], skipped: [], heads: [] };   // 伺服器對不存在的檔案回傳了網頁
  const lines = t.replace(/\r/g, "").split("\n").map((ln) => ln.replace(/^[ \t]*\[\d+\][ \t]*/, ""));
  const heads = [];
  lines.forEach((ln, i) => {
    const title = headTitle(ln);
    if (title !== null) heads.push({ line: i + 1, title });
  });
  const res = parseImport(lines.join("\n"));
  let hi = -1;
  for (const r of res.rows) {
    while (hi + 1 < heads.length && heads[hi + 1].line < r.line) hi++;
    r.unit = hi >= 0 ? heads[hi].title : "";
  }
  res.heads = heads.map((h) => h.title);
  return res;
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 把例句切成 [{text, hl}]，hl=true 的是例句裡的目標單字（含常見變化形）。 */
export function splitHighlight(text, word) {
  text = String(text || "");
  if (!text) return [{ text: "", hl: false }];
  if (!word) return [{ text, hl: false }];
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const latin = /^[A-Za-z0-9]/.test(word);
  const re = latin
    ? new RegExp(`(?<![A-Za-z0-9])${esc}(?:s|es|ed|d|ing|ly|er|est)?(?![A-Za-z0-9])`, "i")
    : new RegExp(esc, "i");
  const m = re.exec(text);
  if (!m) return [{ text, hl: false }];
  const out = [];
  if (m.index > 0) out.push({ text: text.slice(0, m.index), hl: false });
  out.push({ text: m[0], hl: true });
  const end = m.index + m[0].length;
  if (end < text.length) out.push({ text: text.slice(end), hl: false });
  return out;
}

/**
 * 把一段文字切成「中文／非中文」片段，讓中文用中文語音、英文用英文語音念。
 * 數字、空白、半形標點跟著前一個片段走；全形標點算中文。
 */
export function langSegments(text) {
  const s = String(text || "");
  const isZh = (ch) => /[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch);
  const isLatin = (ch) => /[A-Za-z\u00C0-\u024F]/.test(ch);
  const out = [];
  let cur = null, pend = "";
  for (const ch of s) {
    let zh;
    if (isZh(ch)) zh = true;
    else if (isLatin(ch)) zh = false;
    else { if (cur) cur.text += ch; else pend += ch; continue; }
    if (cur && cur.zh === zh) cur.text += ch;
    else { cur = { zh, text: pend + ch }; pend = ""; out.push(cur); }
  }
  if (!cur && pend) out.push({ zh: false, text: pend });
  return out.map((o) => ({ zh: o.zh, text: o.text.trim() })).filter((o) => o.text);
}

/** 單行內欄位正規化：換行／Tab／連續空白都壓成一個空白 */
const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** 卡片 → 總編輯的一行文字（欄位以兩個空白隔開；中間有欄位留空時整行改用 Tab） */
export function cardToLine(c) {
  const f = [flat(c.word), flat(c.example), flat(c.note), flat(c.trans)];
  while (f.length > 1 && !f[f.length - 1]) f.pop();      // 後面沒內容就不用留空欄
  return f.some((x) => !x) ? f.join("\t") : f.join("  ");
}

/** 比對用 key（內容完全相同的行視為「沒改」） */
export const rowKey = (r) => `${flat(r.word)}\u0000${flat(r.example)}\u0000${flat(r.note)}\u0000${flat(r.trans)}`;

/** 行首編號：`[12] 單字  例句  備註` */
export const bulkLine = (c, n) => `[${n}] ${cardToLine(c)}`;

/** 解析總編輯文字 → [{ id: 編號或 null, word, example, note, trans }]；空行略過，不處理註解 */
export function parseBulk(text) {
  const out = [];
  let unit = null;           // 目前所在的單元標題；null = 還沒遇到任何標題（不改動這些卡的單元）
  String(text || "").replace(/\r/g, "").split("\n").forEach((raw) => {
    if (!raw.trim()) return;
    const h = headTitle(raw);
    if (h !== null) { unit = h === "未分類" ? "" : h; return; }       // 標題行不是字卡
    const m = /^\s*\[(\d+)\][ \t]*/.exec(raw);
    const rest = m ? raw.slice(m[0].length) : raw;
    const row = parseImport(rest, { comments: false }).rows[0] || { word: "", example: "", note: "", trans: "" };
    out.push({ id: m ? Number(m[1]) : null, word: row.word, example: row.example, note: row.note, trans: row.trans, unit });
  });
  return out;
}

/**
 * 總編輯比對。snap 是開啟（或上次儲存）時的卡片陣列，第 i 張的編號是 i+1。
 * 有編號且存在 → 沒改／修改；沒編號（或編號重複／不存在）→ 新增；
 * 編號從文字裡消失（或整行被清空）→ 刪除。lines 是依文字順序的有效行。
 */
function diffItems(snap, items, key, valid) {
  const used = new Set();
  const lines = [];
  const updates = [], adds = [];
  let same = 0;
  for (const it of items) {
    if (!valid(it)) continue;
    const card = it.id && !used.has(it.id) ? snap[it.id - 1] : null;
    if (card) {
      used.add(it.id);
      if (key(card) === key(it)) same++; else updates.push({ card, row: it });
      lines.push({ card, row: it });
    } else {
      adds.push(it);
      lines.push({ card: null, row: it });
    }
  }
  const deletes = snap.filter((_, i) => !used.has(i + 1));
  return { same, updates, adds, deletes, lines };
}
export const diffBulk = (snap, text) => diffItems(snap, parseBulk(text), rowKey, (it) => it.word);

/* ------------------------------------------------------------------ */
/* 動詞三態                                                             */
/* 一行一個：[編號] V1  V2  V3  例句1  例句2  例句3  備註                  */
/* 有欄位留空時整行改用 Tab 分隔，才不會錯位                              */
/* ------------------------------------------------------------------ */
export const VERB_FIELDS = ["v1", "v2", "v3", "ex1", "ex2", "ex3", "note"];

export function parseVerbRow(text) {
  const t = String(text || "").trim();
  const p = (t.includes("\t") ? t.split("\t") : t.split(/\s{2,}/)).map(flat);
  const row = {};
  VERB_FIELDS.forEach((k, i) => { row[k] = p[i] || ""; });
  if (p.length > VERB_FIELDS.length) row.note = p.slice(VERB_FIELDS.length - 1).filter(Boolean).join("  ");
  return row;
}
export function verbToLine(c) {
  const v = VERB_FIELDS.map((k) => flat(c[k]));
  while (v.length > 6 && !v[v.length - 1]) v.pop();   // 沒備註就不用留空欄
  return v.some((x) => !x) ? v.join("\t") : v.join("  ");
}
export const verbKey = (r) => VERB_FIELDS.map((k) => flat(r[k])).join("\u0000");
export const verbBulkLine = (c, n) => `[${n}] ${verbToLine(c)}`;
export function parseVerbBulk(text) {
  const out = [];
  String(text || "").replace(/\r/g, "").split("\n").forEach((raw) => {
    if (!raw.trim()) return;
    const m = /^\s*\[(\d+)\][ \t]*/.exec(raw);
    out.push({ id: m ? Number(m[1]) : null, ...parseVerbRow(m ? raw.slice(m[0].length) : raw) });
  });
  return out;
}
export const diffVerbBulk = (snap, text) => diffItems(snap, parseVerbBulk(text), verbKey, (it) => it.v1);

/** "was/were" → ["was","were"] */
export const verbAlts = (s) => String(s || "").split("/").map((x) => x.trim()).filter(Boolean);
const vnorm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** 檢查某一態的答案：任一種寫法都算對（也可以整串打 was/were） */
export function checkVerbAnswer(expected, input) {
  const want = verbAlts(expected).map(vnorm);
  const got = String(input || "").split("/").map(vnorm).filter(Boolean);
  return got.length > 0 && got.every((g) => want.includes(g));
}

/** 發音用文字：多種寫法取第一個；read 的 V2/V3 單獨唸會變成 /riːd/，改送 red 給語音引擎 */
export function verbSay(card, i) {
  const k = ["v1", "v2", "v3"][i];
  if (String(card.v1 || "").toLowerCase() === "read" && i > 0) return "red";
  return verbAlts(card[k])[0] || card[k] || "";
}

/** 例句裡的動詞形態標亮（多種寫法時，找得到哪個就標哪個） */
export function highlightForm(text, form) {
  for (const a of verbAlts(form)) {
    const parts = splitHighlight(text, a);
    if (parts.some((p) => p.hl)) return parts;
  }
  return [{ text: String(text || ""), hl: false }];
}
