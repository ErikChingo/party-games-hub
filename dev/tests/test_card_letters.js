const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["DurakCard", "durakRankLabel", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS };")(require, m, __dirname);
const { load, React, RDS } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const at = (lang) => load({ react: React, local: { hatsitSettings: JSON.stringify({ language: lang }) } }).C;
const word = (C) => [11, 12, 13, 14, 10, 7].map((r) => C.durakRankLabel(r, C.__lang)).join(" ");
for (const [lang, want] of [["ru", "В Д К Т 10 7"], ["en", "J Q K A 10 7"], ["hy", "В Д К Т 10 7"]]) {
  const C = at(lang);
  const got = [11, 12, 13, 14, 10, 7].map((r) => C.durakRankLabel(r, lang)).join(" ");
  ok(got === want, lang + ": " + got);
  const html = RDS.renderToStaticMarkup(React.createElement(C.DurakCard, { card: "13H" }));
  ok(html.includes(">" + want.split(" ")[2] + "<"), lang + ": the king card shows " + want.split(" ")[2]);
}
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
