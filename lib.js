// 純函式（不依賴 DOM / Firebase），方便單獨測試

/**
 * 解析批量匯入文字。
 * 每行一張：  單字  例句  備註(選填)   （欄位之間用兩個空白隔開；Tab 分隔也可以）
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
      const [word = "", example = "", ...rest] = line.split(sep).map((s) => s.trim());
      if (!word) {
        skipped.push({ line: i + 1, reason: "缺少單字" });
        return;
      }
      rows.push({ word, example, note: rest.join("  "), line: i + 1 });
    });
  return { rows, skipped };
}

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

/** 去重用的 key：單字 + 例句（忽略大小寫與多餘空白） */
export function cardKey(word, example) {
  return norm(word) + "\u0000" + norm(example);
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

/** 單行內欄位正規化：換行／Tab／連續空白都壓成一個空白 */
const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** 卡片 → 總編輯的一行文字（欄位以兩個空白隔開；有備註沒例句時改用 Tab） */
export function cardToLine(c) {
  const w = flat(c.word), e = flat(c.example), n = flat(c.note);
  if (!e && n) return `${w}\t\t${n}`;
  return [w, e, n].filter((x, i) => i === 0 || x).join("  ");
}

/** 比對用 key（內容完全相同的行視為「沒改」） */
export const rowKey = (r) => `${flat(r.word)}\u0000${flat(r.example)}\u0000${flat(r.note)}`;

/** 行首編號：`[12] 單字  例句  備註` */
export const bulkLine = (c, n) => `[${n}] ${cardToLine(c)}`;

/** 解析總編輯文字 → [{ id: 編號或 null, word, example, note }]；空行略過，不處理註解 */
export function parseBulk(text) {
  const out = [];
  String(text || "").replace(/\r/g, "").split("\n").forEach((raw) => {
    if (!raw.trim()) return;
    const m = /^\s*\[(\d+)\][ \t]*/.exec(raw);
    const rest = m ? raw.slice(m[0].length) : raw;
    const row = parseImport(rest, { comments: false }).rows[0] || { word: "", example: "", note: "" };
    out.push({ id: m ? Number(m[1]) : null, word: row.word, example: row.example, note: row.note });
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
