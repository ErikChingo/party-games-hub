// Room invite links with a proper preview: hatsit.org/join/<game>/<code>?l=<lang>
// (vercel.json maps them here). Messengers read the preview from this page —
// «Аня зовёт играть в нарды», «Комната 4821 …» and the game's picture
// (og/<lang>/<game>.png, drawn by dev/make-invite-images.js) — and a person
// is sent straight on to the room (/?room=<code>&game=<game>).
//
// The host's name comes from the room itself: card games from card_rooms,
// the others from the open-room list when the room is public. A room that is
// gone still gets a plain «come and play» preview.

const DEFAULT_SUPABASE_URL = "https://zocoaqqcrxpbkyzlfzsf.supabase.co";
const SITE = "https://hatsit.org";
const GAMES = ["nardy", "durak", "blot", "blackjack", "mafiaroom", "bunker", "court"];
const CARD_GAMES = ["nardy", "durak", "blot", "blackjack"];

const TEXT = {
  ru: {
    games: { nardy: "нарды", durak: "дурака", blot: "блот", blackjack: "блэкджек", mafiaroom: "Мафию", bunker: "Бункер", court: "Суд" },
    named: "{name} зовёт играть в {game}",
    plain: "Вас зовут играть в {game}",
    desc: "Комната {code} на Хатсите — нажмите, чтобы войти. Бесплатно, без регистрации.",
    go: "Войти в комнату",
  },
  en: {
    games: { nardy: "nardy", durak: "durak", blot: "blot", blackjack: "blackjack", mafiaroom: "Mafia", bunker: "Bunker", court: "Court" },
    named: "{name} invites you to play {game}",
    plain: "You’re invited to play {game}",
    desc: "Room {code} on Hatsit — tap to join. Free, no sign-up.",
    go: "Join the room",
  },
  hy: {
    games: { nardy: "նարդի", durak: "դուրակ", blot: "բլոտ", blackjack: "բլեքջեք", mafiaroom: "մաֆիա", bunker: "Բունկեր", court: "Դատարան" },
    named: "{name}-ը հրավիրում է խաղալ {game}",
    plain: "Ձեզ հրավիրում են խաղալ {game}",
    desc: "Սենյակ {code}՝ Հաթսիթում — սեղմեք՝ միանալու համար։ Անվճար, առանց գրանցման։",
    go: "Մտնել սենյակ",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function db(path) {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  if (!key) return null;
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2500) });
  return res.ok ? res.json() : null;
}

async function hostName(game, code) {
  try {
    if (CARD_GAMES.includes(game)) {
      const rows = await db(`card_rooms?code=eq.${code}&select=state`);
      const state = rows && rows[0] && rows[0].state;
      if (!state || state.game !== game || state.status === "closed") return "";
      const host = (state.players || []).find((p) => p.id === state.hostId);
      return host && !host.bot ? host.name || "" : "";
    }
    const listed = game === "mafiaroom" ? "mafia" : game;
    const rows = await db(`open_rooms?game=eq.${listed}&code=eq.${code}&select=host_name`);
    return (rows && rows[0] && rows[0].host_name) || "";
  } catch (e) {
    return "";
  }
}

function page({ lang, game, code, name }) {
  const t = TEXT[lang];
  const gameWord = t.games[game];
  const clean = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 20);
  const title = (clean ? t.named.replace("{name}", clean) : t.plain).replace("{game}", gameWord);
  const desc = t.desc.replace("{code}", code);
  const target = `/?room=${code}&game=${game}`;
  const url = `${SITE}/join/${game}/${code}${lang === "ru" ? "" : "?l=" + lang}`;
  const image = `${SITE}/og/${lang}/${game}.png`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Hatsit</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${lang === "hy" ? "Հաթսիթ" : lang === "en" ? "Hatsit" : "Хатсит"}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${image}">
<meta name="theme-color" content="#0b0e14">
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0e14;color:#eef1f6;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;text-align:center;padding:24px;box-sizing:border-box}a{display:inline-block;margin-top:16px;background:#e8b545;color:#1a1405;font-weight:800;text-decoration:none;padding:14px 28px;border-radius:16px}p{color:#98a1b7}</style>
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
<main><h1>${esc(title)}</h1><p>${esc(desc)}</p><a href="${target}">${esc(t.go)}</a></main>
</body>
</html>
`;
}

module.exports = async function handler(req, res) {
  const q = req.query || {};
  const game = GAMES.includes(q.game) ? q.game : null;
  const code = String(q.code || "").replace(/\D/g, "").slice(0, 4);
  if (!game || code.length !== 4) {
    res.setHeader("Location", "/");
    return res.status(302).send("");
  }
  const lang = TEXT[q.l] ? q.l : "ru";
  const name = await hostName(game, code);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Short: the host's name belongs to this room only while it lasts.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60");
  return res.status(200).send(page({ lang, game, code, name }));
};

module.exports._internals = { page, hostName, TEXT, GAMES };
