// Builds the search pages: one plain HTML page per game in Russian
// (hatsit.org/<slug>) and Armenian (hatsit.org/hy/<slug>), an Armenian list
// of all games (hatsit.org/hy), and sitemap.xml. Called from build.js.
//
// The pages are plain HTML on purpose: search engines read them at once,
// they load instantly, and the "Играть" button opens the game itself
// (hatsit.org/?play=<id>). The texts are in seo/content.js; the rules are
// read from the game's *_RULES in index.html, so they never drift apart.
//
// Files go to dist/seo/...; vercel.json maps the short addresses onto them.

const fs = require("fs");
const path = require("path");
const { GAMES, SITE } = require("./content.js");

const ORIGIN = "https://hatsit.org";
const LANGS = ["ru", "hy"];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pageUrl = (lang, slug) => ORIGIN + (lang === "hy" ? "/hy" : "") + (slug ? "/" + slug : lang === "hy" ? "" : "/");
const playUrl = (lang, id) => "/?play=" + id + (lang === "hy" ? "&lang=hy" : "");

// `const NARDY_RULES = { ru: [...], en: [...], hy: [...] };` -> the object.
function readRules(source, name) {
  const start = source.indexOf("const " + name + " = {");
  if (start < 0) throw new Error("seo: " + name + " not found in index.html");
  const end = source.indexOf("\n};", start);
  return new Function("return " + source.slice(source.indexOf("{", start), end + 2))();
}

const STYLE = `
:root{color-scheme:dark;--bg:#0b0e14;--surface:#161c28;--surface-2:#1e2531;--border:rgba(255,255,255,.09);--text:#eef1f6;--dim:#98a1b7;--faint:#6b7488;--accent:#e8b545;--ink:#1a1405}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
.wrap{max-width:720px;margin:0 auto;padding:0 16px 48px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 0}
.logo{font:800 22px/1 Impact,"Arial Black",sans-serif;letter-spacing:1px;color:var(--text);text-decoration:none}
.lang{font-size:14px;color:var(--dim);text-decoration:none;border:1px solid var(--border);border-radius:999px;padding:6px 12px}
nav.crumbs{font-size:13px;color:var(--faint);margin:4px 0 8px}
nav.crumbs a{color:var(--dim);text-decoration:none}
h1{font:800 clamp(28px,7vw,40px)/1.15 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:8px 0 12px}
h2{font-size:22px;margin:36px 0 12px}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px;padding:0;list-style:none}
.facts li{background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:14px;color:var(--dim)}
.play{display:block;text-align:center;background:var(--accent);color:var(--ink);font-weight:800;font-size:20px;text-decoration:none;padding:16px;border-radius:18px;margin:20px 0 8px}
.free{text-align:center;font-size:13px;color:var(--faint);margin:0 0 8px}
p{color:#d6dbe6}
ol{padding-left:22px}
ol li{margin:6px 0;color:#d6dbe6}
h3{font-size:16px;color:var(--dim);margin:20px 0 6px}
details{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 16px;margin:8px 0}
summary{cursor:pointer;font-weight:600}
details p{margin:8px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:0;padding:0;list-style:none}
.grid a{display:block;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;text-decoration:none;color:var(--text)}
.grid span{display:block;font-size:13px;color:var(--faint)}
footer{margin-top:40px;font-size:13px;color:var(--faint);text-align:center}
`.replace(/\n/g, "");

function head({ lang, title, description, url, alternates, jsonLd }) {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
${alternates.map(([hl, href]) => `<link rel="alternate" hreflang="${hl}" href="${href}">`).join("\n")}
<meta name="theme-color" content="#0b0e14">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(SITE[lang].brand)}">
<meta property="og:locale" content="${lang === "hy" ? "hy_AM" : "ru_RU"}">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${ORIGIN}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'><rect width='192' height='192' rx='40' fill='%230f172a'/><text x='96' y='134' font-family='Arial' font-size='120' font-weight='900' text-anchor='middle' fill='%23e8b545'>H</text></svg>">
<style>${STYLE}</style>
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<div class="wrap">`;
}

function topBar(lang, otherUrl) {
  const t = SITE[lang];
  return `<header><a class="logo" href="${lang === "hy" ? "/hy" : "/"}">${esc(t.brand.toUpperCase())}</a><a class="lang" href="${otherUrl}" hreflang="${lang === "hy" ? "ru" : "hy"}">${esc(t.langSwitch)}</a></header>`;
}

function otherGames(lang, except) {
  return `<ul class="grid">${GAMES.filter((g) => g.slug !== except)
    .map((g) => `<li><a href="${lang === "hy" ? "/hy" : ""}/${g.slug}">${esc(g[lang].name)}<span>${esc(g[lang].facts[0])}</span></a></li>`)
    .join("")}</ul>`;
}

function gamePage(game, lang, source) {
  const c = game[lang];
  const t = SITE[lang];
  const url = pageUrl(lang, game.slug);
  const ruUrl = pageUrl("ru", game.slug);
  const hyUrl = pageUrl("hy", game.slug);
  const rulesBlocks = game.rules.map((name, i) => {
    const rules = readRules(source, name)[lang] || readRules(source, name).ru;
    const sub = game.rulesTitles ? `<h3>${esc(game.rulesTitles[lang][i])}</h3>` : "";
    return sub + `<ol>${rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>`;
  });
  const jsonLd = [
    { "@context": "https://schema.org", "@type": "Game", name: c.name, description: c.description, url, inLanguage: lang, isAccessibleForFree: true, publisher: { "@type": "Organization", name: "Hatsit", url: ORIGIN + "/" } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: t.brand, item: pageUrl(lang, "") },
      { "@type": "ListItem", position: 2, name: c.name, item: url },
    ] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: c.faq.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) },
  ];
  const play = esc(t.play.replace("{name}", c.playAs || c.name));
  return (
    head({ lang, title: c.title + " | " + t.brand, description: c.description, url, alternates: [["ru", ruUrl], ["hy", hyUrl], ["x-default", ruUrl]], jsonLd }) +
    topBar(lang, lang === "hy" ? ruUrl.replace(ORIGIN, "") : hyUrl.replace(ORIGIN, "")) +
    `<nav class="crumbs"><a href="${lang === "hy" ? "/hy" : "/"}">${esc(t.brand)}</a> › ${esc(c.name)}</nav>
<main>
<h1>${esc(c.h1)}</h1>
<ul class="facts">${c.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
${c.intro.map((p) => `<p>${esc(p)}</p>`).join("\n")}
<a class="play" href="${playUrl(lang, game.play)}">▶ ${play}</a>
<p class="free">${esc(t.free)}</p>
<h2>${esc(t.howTo)}</h2>
<ol>${c.howTo.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<h2>${esc(t.rules)}: ${esc(c.name)}</h2>
${rulesBlocks.join("\n")}
<h2>${esc(t.faq)}</h2>
${c.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("\n")}
<a class="play" href="${playUrl(lang, game.play)}">▶ ${play}</a>
<h2>${esc(t.more)}</h2>
${otherGames(lang, game.slug)}
</main>
<footer>${esc(t.footer)}</footer>
</div>
</body>
</html>
`
  );
}

// hatsit.org/hy: the Armenian front door (the app's own home page is Russian
// to search engines).
function armenianHub() {
  const t = SITE.hy;
  const url = pageUrl("hy", "");
  const jsonLd = { "@context": "https://schema.org", "@type": "WebSite", name: t.brand, url, inLanguage: "hy" };
  return (
    head({ lang: "hy", title: t.hubTitle, description: t.hubDescription, url, alternates: [["ru", ORIGIN + "/"], ["hy", url], ["x-default", ORIGIN + "/"]], jsonLd }) +
    topBar("hy", "/") +
    `<main>
<h1>${esc(t.hubH1)}</h1>
<p>${esc(t.hubIntro)}</p>
<a class="play" href="/?lang=hy">▶ ${esc(t.playShort)}</a>
<p class="free">${esc(t.free)}</p>
<h2>${esc(t.allGames)}</h2>
${otherGames("hy", null)}
</main>
<footer>${esc(t.footer)}</footer>
</div>
</body>
</html>
`
  );
}

function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const entry = (loc, alts, priority) =>
    `  <url>\n    <loc>${loc}</loc>\n${alts.map(([hl, href]) => `    <xhtml:link rel="alternate" hreflang="${hl}" href="${href}"/>`).join("\n")}\n    <lastmod>${today}</lastmod>\n    <priority>${priority}</priority>\n  </url>`;
  const homeAlts = [["ru", ORIGIN + "/"], ["hy", ORIGIN + "/hy"], ["x-default", ORIGIN + "/"]];
  const urls = [entry(ORIGIN + "/", homeAlts, "1.0"), entry(ORIGIN + "/hy", homeAlts, "0.9")];
  GAMES.forEach((g) => {
    const alts = [["ru", pageUrl("ru", g.slug)], ["hy", pageUrl("hy", g.slug)], ["x-default", pageUrl("ru", g.slug)]];
    LANGS.forEach((lang) => urls.push(entry(pageUrl(lang, g.slug), alts, "0.8")));
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

function buildSeoPages(source, outDir) {
  const seoDir = path.join(outDir, "seo");
  fs.mkdirSync(path.join(seoDir, "hy"), { recursive: true });
  for (const game of GAMES) {
    for (const lang of LANGS) {
      fs.writeFileSync(path.join(seoDir, lang === "hy" ? "hy" : "", game.slug + ".html"), gamePage(game, lang, source));
    }
  }
  fs.writeFileSync(path.join(seoDir, "hy", "index.html"), armenianHub());
  fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemap());
  return GAMES.length * LANGS.length + 1;
}

module.exports = { buildSeoPages, GAMES };
