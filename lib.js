// 純函式（不依賴 DOM / Firebase），方便單獨測試

/**
 * 解析批量匯入文字。
 * 每行一張：  單字  例句  備註(選填)   （欄位之間用兩個空白隔開；Tab 分隔也可以）
 * 空行、以 # 或 // 開頭的行會略過。
 */
export function parseImport(text) {
  const rows = [];
  const skipped = [];
  String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) return;
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
