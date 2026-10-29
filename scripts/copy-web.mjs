// 把網頁檔複製到 www/，給 Capacitor 打包進 App
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
rmSync("www", { recursive: true, force: true });
mkdirSync("www", { recursive: true });
for (const f of ["index.html", "app.js", "lib.js", "pwa.js", "sw.js", "style.css", "manifest.json", "firebase-config.js", "verbs-seed.js", "words.txt"]) {
  if (existsSync(f)) cpSync(f, `www/${f}`);
}
if (existsSync("icons")) cpSync("icons", "www/icons", { recursive: true });
console.log("www/ ready");
