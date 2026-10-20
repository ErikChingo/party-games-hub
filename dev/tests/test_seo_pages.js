const ROOT = require("path").resolve(__dirname, "../..");
// The search pages (seo/build-pages.js): every game in Russian and Armenian,
// the Armenian front page and sitemap.xml; their short addresses in
// vercel.json; the "Играть" button opening the game in the app; and the
// rules links at the bottom of the Hub.
const fs = require("fs");
const os = require("os");
const path = require("path");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["GAMES", "GAME_PAGE_SLUGS", "pendingPlayParams", "reducer", "initialState", "Hub", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS };")(require, m, __dirname);
const { load, React, RDS } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const src = fs.readFileSync(ROOT + "/index.html", "utf8");
const { buildSeoPages, GAMES } = require(ROOT + "/seo/build-pages.js");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "hatsit-seo-"));
const count = buildSeoPages(src, out);
eq(count, 27, "13 games x 2 languages + the Armenian front page");

const env = load({ react: React });
const C = env.C;
const appIds = C.GAMES.map((g) => g.id);
eq(GAMES.map((g) => g.play).sort(), appIds.slice().sort(), "a page for every game on the Hub, and no other");
eq(GAMES.map((g) => g.play + "=" + g.slug).sort(), appIds.map((id) => id + "=" + C.GAME_PAGE_SLUGS[id]).sort(), "the Hub's links use the pages' own addresses");

const rules = (name) => {
  const i = src.indexOf("const " + name + " = {");
  return new Function("return " + src.slice(src.indexOf("{", i), src.indexOf("\n};", i) + 2))();
};
for (const g of GAMES) {
  for (const lang of ["ru", "hy"]) {
    const file = path.join(out, "seo", lang === "hy" ? "hy" : "", g.slug + ".html");
    const html = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const where = `${lang}/${g.slug}`;
    const url = "https://hatsit.org" + (lang === "hy" ? "/hy/" : "/") + g.slug;
    ok(html.includes(`<html lang="${lang}">`) && html.includes(`<link rel="canonical" href="${url}">`), where + ": language and canonical address");
    ok(["ru", "hy", "x-default"].every((hl) => html.includes(`hreflang="${hl}"`)), where + ": links to the other language");
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
    ok(title.includes(g[lang].name) && title.length <= 90, where + ": a title with the game's name (" + title.length + " chars)");
    const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || "";
    ok(desc.length >= 80 && desc.length <= 200, where + ": a description of a useful length (" + desc.length + ")");
    const expected = g.rules.reduce((n, r) => n + (rules(r)[lang] || rules(r).ru).length, 0);
    const inLists = [...html.matchAll(/<ol>([\s\S]*?)<\/ol>/g)].reduce((n, x) => n + (x[1].match(/<li>/g) || []).length, 0);
    eq(inLists - g[lang].howTo.length, expected, where + ": every rule is on the page");
    ok(html.includes(`href="/?play=${g.play}${lang === "hy" ? "&lang=hy" : ""}"`), where + ": the play button opens the game" + (lang === "hy" ? " in Armenian" : ""));
    const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((x) => JSON.parse(x[1]));
    ok(ld.length === 1 && ld[0].some((x) => x["@type"] === "FAQPage" && x.mainEntity.length === g[lang].faq.length), where + ": structured data with the FAQ");
    ok(!/undefined|\{name\}/.test(html), where + ": no gaps in the text");
    ok(GAMES.filter((x) => x.slug !== g.slug).every((x) => html.includes(`href="${lang === "hy" ? "/hy" : ""}/${x.slug}"`)), where + ": links to all the other games");
  }
}
const hyHub = fs.readFileSync(path.join(out, "seo", "hy", "index.html"), "utf8");
ok(hyHub.includes('<html lang="hy">') && hyHub.includes('href="/?lang=hy"') && GAMES.every((g) => hyHub.includes(`href="/hy/${g.slug}"`)), "the Armenian front page lists every game and opens the site in Armenian");

const sitemap = fs.readFileSync(path.join(out, "sitemap.xml"), "utf8");
const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((x) => x[1]);
eq(locs.length, 28, "sitemap: the home page, the Armenian front page and 26 game pages");
ok(locs.every((l) => l.startsWith("https://hatsit.org")), "sitemap: only hatsit.org addresses");
ok(!fs.existsSync(ROOT + "/sitemap.xml"), "no hand-written sitemap.xml left to go stale");

// vercel.json: the short addresses lead to those files.
const vercel = JSON.parse(fs.readFileSync(ROOT + "/vercel.json", "utf8"));
const slugsIn = (source) => ((source.match(/\(([^)]*)\)/) || [])[1] || "").split("|").sort();
const all = GAMES.map((g) => g.slug).sort();
const rw = vercel.rewrites || [];
ok(rw.some((r) => r.source === "/hy" && r.destination === "/seo/hy/index.html"), "vercel: /hy is the Armenian front page");
const ruRule = rw.find((r) => r.destination === "/seo/:slug.html");
const hyRule = rw.find((r) => r.destination === "/seo/hy/:slug.html");
eq(ruRule && slugsIn(ruRule.source), all, "vercel: every Russian page has its short address");
eq(hyRule && slugsIn(hyRule.source), all, "vercel: every Armenian page has its short address");

// The app: ?play opens the game, &lang=hy switches the language at once.
{
  const e = load({ react: React, search: "?play=nardy&lang=hy" });
  eq(e.C.pendingPlayParams, { play: "nardy", lang: "hy" }, "?play=nardy&lang=hy is read");
  eq(JSON.parse(e.ls.getItem("hatsitSettings") || "{}").language, "hy", "the language is switched before the first paint");
  const g = e.C.GAMES.find((x) => x.id === "spy");
  eq(e.C.reducer({ ...e.C.initialState, screen: "hub" }, { type: g.openAction }).screen, "spy-setup", "a game id leads to its first screen");
  ok(/const fromPage = pendingPlayParams && pendingPlayParams\.play && GAMES\.find/.test(src) && /logAppEvent\("seo_play"/.test(src), "App opens that screen and notes the visit for the statistics");
  const bad = load({ react: React, search: "?play=<script>&lang=xx" });
  eq(bad.C.pendingPlayParams, { play: null, lang: null }, "anything else in the address is ignored");
}
// The Hub: rules links at the bottom, Armenian ones in Armenian.
for (const [lang, prefix] of [["ru", "/"], ["hy", "/hy/"]]) {
  const e = load({ react: React, local: { hatsitSettings: JSON.stringify({ language: lang }) } });
  const page = RDS.renderToStaticMarkup(React.createElement(e.C.Hub, { state: { feedbackPending: null }, dispatch() {} }));
  ok(GAMES.every((g) => page.includes(`href="${prefix}${g.slug}"`)), lang + ": the Hub links to every rules page");
}

fs.rmSync(out, { recursive: true, force: true });
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
