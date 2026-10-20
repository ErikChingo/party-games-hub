// Draws the link-preview pictures for room invites (hatsit.org/join/<game>/<code>,
// see api/invite.js): one 1200x630 PNG per online game and language, into
// og/<lang>/<game>.png, which build.js copies to the site. The icon is the
// game's own icon from index.html, so the picture matches the Hub tile.
//
// Run after changing a game's icon, name or these texts, and commit the PNGs:
//   cd dev && node make-invite-images.js
// (needs @resvg/resvg-js from dev/package.json; uses the computer's fonts.)

const fs = require("fs");
const path = require("path");
const { Resvg } = require("@resvg/resvg-js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "og");
const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// The invite games and their Hub icons.
const GAMES = { nardy: "IconDice", durak: "IconCards", blot: "IconSpade", blackjack: "IconChip", mafiaroom: "IconSkull", bunker: "IconRadioactive", court: "IconBank" };
const TEXT = {
  ru: { kicker: "ПРИГЛАШЕНИЕ В ИГРУ", foot: "Бесплатно, без регистрации", names: { nardy: "Нарды", durak: "Дурак", blot: "Блот", blackjack: "Блэкджек", mafiaroom: "Мафия онлайн", bunker: "Бункер", court: "Суд" } },
  en: { kicker: "GAME INVITE", foot: "Free, no sign-up", names: { nardy: "Nardy", durak: "Durak", blot: "Blot", blackjack: "Blackjack", mafiaroom: "Online Mafia", bunker: "Bunker", court: "Court" } },
  hy: { kicker: "ՀՐԱՎԵՐ ԽԱՂԻ", foot: "Անվճար, առանց գրանցման", names: { nardy: "Նարդի", durak: "Դուրակ", blot: "Բլոտ", blackjack: "Բլեքջեք", mafiaroom: "Մաֆիա օնլայն", bunker: "Բունկեր", court: "Դատարան" } },
};
const BRAND = { ru: "ХАТСИТ", en: "HATSIT", hy: "ՀԱԹՍԻԹ" };

function iconInner(name) {
  const start = src.indexOf("const " + name + " = (p) => <Ic {...p}>");
  if (start < 0) throw new Error(name + " not found in index.html");
  const from = src.indexOf(">", src.indexOf("<Ic", start)) + 1;
  // JSX and SVG write these the same way; nothing else is used in the icons.
  return src.slice(from, src.indexOf("</Ic>", from));
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function card(game, lang) {
  const t = TEXT[lang];
  const name = t.names[game];
  // Fits the right-hand side (about 600 px), whatever the length.
  const size = Math.min(132, Math.floor(600 / (name.length * 0.64)));
  // The heaviest Windows face has no Armenian letters: Segoe UI Bold has.
  const heavy = lang === "hy" ? 'font-family="Segoe UI, sans-serif" font-weight="700"' : 'font-family="Segoe UI Black, Segoe UI, Arial Black, sans-serif" font-weight="900"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="0.28" cy="0.45" r="0.6">
      <stop offset="0" stop-color="#e8b545" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#e8b545" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="#0b0e14"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="24" y="24" width="1152" height="582" rx="36" fill="none" stroke="#e8b545" stroke-opacity="0.35" stroke-width="3"/>
  <circle cx="300" cy="300" r="190" fill="#161c28" stroke="#e8b545" stroke-opacity="0.5" stroke-width="4"/>
  <g transform="translate(168 168) scale(11)" fill="none" stroke="#f0c862" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconInner(GAMES[game])}</g>
  <text x="560" y="210" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="34" letter-spacing="6" fill="#e8b545">${esc(t.kicker)}</text>
  <text x="556" y="${210 + Math.round(size * 0.95) + 30}" ${heavy} font-size="${size}" fill="#eef1f6">${esc(name)}</text>
  <text x="560" y="470" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="#98a1b7">${esc(t.foot)}</text>
  <text x="560" y="545" ${heavy} font-size="40" letter-spacing="4" fill="#eef1f6">${BRAND[lang]}<tspan dx="22" fill="#5b6478" font-family="Segoe UI, sans-serif" font-weight="400" font-size="32" letter-spacing="1">· hatsit.org</tspan></text>
</svg>`;
}

let n = 0;
for (const lang of Object.keys(TEXT)) {
  fs.mkdirSync(path.join(OUT, lang), { recursive: true });
  for (const game of Object.keys(GAMES)) {
    const png = new Resvg(card(game, lang), { font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI" }, fitTo: { mode: "width", value: 1200 } }).render().asPng();
    fs.writeFileSync(path.join(OUT, lang, game + ".png"), png);
    n++;
  }
}
console.log(`wrote ${n} pictures to og/`);
