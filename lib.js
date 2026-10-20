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
export function diffBulk(snap, text) {
  const used = new Set();
  const lines = [];
  const updates = [], adds = [];
  let same = 0;
  for (const it of parseBulk(text)) {
    if (!it.word) continue;
    const card = it.id && !used.has(it.id) ? snap[it.id - 1] : null;
    if (card) {
      used.add(it.id);
      if (rowKey(card) === rowKey(it)) same++; else updates.push({ card, row: it });
      lines.push({ card, row: it });
    } else {
      adds.push(it);
      lines.push({ card: null, row: it });
    }
  }
  const deletes = snap.filter((_, i) => !used.has(i + 1));
  return { same, updates, adds, deletes, lines };
}
