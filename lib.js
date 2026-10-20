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

/**
 * 總編輯：把「原本的卡」和「編輯後的文字」比對。
 * 先配對內容完全相同的行（沒改）；剩下的先用「單字相同」配成修改，
 * 再依順序配成修改；多出來的新行 = 新增，多出來的舊卡 = 刪除。
 */
export function diffBulk(cards, text) {
  const { rows } = parseImport(text, { comments: false });
  const pool = new Map(); // key -> [card...]
  for (const c of cards) {
    const k = rowKey(c);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(c);
  }
  const leftRows = [];
  let same = 0;
  for (const r of rows) {
    const arr = pool.get(rowKey(r));
    if (arr && arr.length) { arr.shift(); same++; } else leftRows.push(r);
  }
  let leftCards = [];
  for (const arr of pool.values()) leftCards.push(...arr);
  leftCards.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const updates = [];
  const rest = [];
  // 1) 單字相同 → 修改
  for (const r of leftRows) {
    const i = leftCards.findIndex((c) => flat(c.word) === flat(r.word));
    if (i >= 0) { updates.push({ card: leftCards[i], row: r }); leftCards.splice(i, 1); } else rest.push(r);
  }
  // 2) 依順序配對
  const adds = [];
  for (const r of rest) {
    if (leftCards.length) updates.push({ card: leftCards.shift(), row: r }); else adds.push(r);
  }
  return { same, updates, adds, deletes: leftCards };
}
