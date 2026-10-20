const ROOT = require("path").resolve(__dirname, "../..");
// Room invite previews: hatsit.org/join/<game>/<code> (api/invite.js) gives
// messengers a title with the host's name, a description with the room code
// and the game's picture, then sends people on to the room; the pictures
// exist for every game and language; the app shares these addresses.
const fs = require("fs");
const path = require("path");
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
const invite = require(ROOT + "/api/invite.js");
const { GAMES } = invite._internals;

let cardRooms = {}, openRooms = [];
const json = (body) => ({ ok: true, status: 200, json: async () => body });
global.fetch = async (url) => {
  const pathPart = decodeURIComponent(String(url).match(/\/rest\/v1\/(.*)$/)[1]);
  const q = new URLSearchParams(pathPart.split("?")[1]);
  const code = (q.get("code") || "").replace("eq.", "");
  if (pathPart.startsWith("card_rooms")) return json(cardRooms[code] ? [{ state: cardRooms[code] }] : []);
  if (pathPart.startsWith("open_rooms")) { const game = (q.get("game") || "").replace("eq.", ""); return json(openRooms.filter((r) => r.game === game && r.code === code)); }
  return json([]);
};
function get(query) {
  return new Promise((resolve) => {
    const headers = {};
    const res = { setHeader(k, v) { headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, send(b) { resolve({ code: this.code, headers, body: b }); } };
    invite({ method: "GET", query }, res);
  });
}
const meta = (html, prop) => ((html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`)) || [])[1] || "");

(async () => {
  /* ---------- the preview ---------- */
  cardRooms["4821"] = { game: "nardy", status: "lobby", hostId: "h", players: [{ id: "h", name: "Аня" }] };
  let r = await get({ game: "nardy", code: "4821" });
  eq(r.code, 200, "a room's invite page");
  eq(meta(r.body, "og:title"), "Аня зовёт играть в нарды", "the title names the host and the game");
  ok(meta(r.body, "og:description").includes("4821"), "the description gives the room code");
  eq(meta(r.body, "og:image"), "https://hatsit.org/og/ru/nardy.png", "the game's own picture");
  ok(meta(r.body, "twitter:card") === "summary_large_image" && r.body.includes('content="noindex"'), "a large card; not indexed by search engines");
  ok(r.body.includes('location.replace("/?room=4821&game=nardy")') && r.body.includes('href="/?room=4821&game=nardy"'), "people go straight on to the room");
  ok(/s-maxage=60/.test(r.headers["cache-control"]), "cached only briefly");

  r = await get({ game: "nardy", code: "4821", l: "hy" });
  ok(meta(r.body, "og:title").startsWith("Аня-ը հրավիրում է") && meta(r.body, "og:image").endsWith("/og/hy/nardy.png"), "Armenian when the inviter uses Armenian");
  r = await get({ game: "nardy", code: "4821", l: "en" });
  eq(meta(r.body, "og:title"), "Аня invites you to play nardy", "English too");

  cardRooms["5555"] = { game: "durak", status: "lobby", hostId: "h", players: [{ id: "h", name: "<script>alert(1)</script>" }] };
  r = await get({ game: "durak", code: "5555" });
  ok(!r.body.includes("<script>alert") && meta(r.body, "og:title").includes("&lt;script&gt;"), "a name is never run as code");
  cardRooms["6666"] = { game: "blot", status: "closed", hostId: "h", players: [{ id: "h", name: "Боря" }] };
  r = await get({ game: "blot", code: "6666" });
  eq(meta(r.body, "og:title"), "Вас зовут играть в блот", "a room that is gone: a plain invite");
  cardRooms["7777"] = { game: "nardy", status: "lobby", hostId: "h", players: [{ id: "h", name: "Вика" }] };
  r = await get({ game: "durak", code: "7777" });
  eq(meta(r.body, "og:title"), "Вас зовут играть в дурака", "a code from another game does not borrow its host");
  openRooms.push({ game: "mafia", code: "1212", host_name: "Ли" });
  r = await get({ game: "mafiaroom", code: "1212" });
  ok(meta(r.body, "og:title") === "Ли зовёт играть в Мафию" && r.body.includes("game=mafiaroom"), "Mafia: the name from the open-room list, the online Mafia screen");
  r = await get({ game: "bunker", code: "3434" });
  eq(meta(r.body, "og:title"), "Вас зовут играть в Бункер", "a private Bunker room: a plain invite");
  r = await get({ game: "spy", code: "1234" });
  eq([r.code, r.headers.location], [302, "/"], "anything else goes to the home page");

  /* ---------- the pictures ---------- */
  for (const lang of ["ru", "en", "hy"]) {
    for (const g of GAMES) {
      const file = path.join(ROOT, "og", lang, g + ".png");
      const buf = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
      const isPng = buf.length > 1000 && buf.toString("ascii", 1, 4) === "PNG";
      ok(isPng && buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630 && buf.length < 400000, `og/${lang}/${g}.png: 1200x630 PNG, not too big`);
    }
  }
  ok(fs.existsSync(path.join(ROOT, "dist", "og", "hy", "court.png")), "the build ships the pictures");

  /* ---------- the app shares these addresses ---------- */
  const vercel = JSON.parse(fs.readFileSync(ROOT + "/vercel.json", "utf8"));
  ok(vercel.rewrites.some((x) => x.source === "/join/:game/:code" && x.destination === "/api/invite?game=:game&code=:code"), "vercel.json: /join/<game>/<code> goes to the invite page");
  const src = fs.readFileSync(ROOT + "/index.html", "utf8");
  ok((src.match(/roomInviteUrl\(game, code\)/g) || []).length === 3, "share button and QR code both use the invite address");
  const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0].replace('const names = [', 'const names = ["roomInviteUrl", ');
  const m = { exports: {} };
  new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React };")(require, m, __dirname);
  for (const [lang, tail] of [["ru", ""], ["hy", "?l=hy"]]) {
    const e = m.exports.load({ react: m.exports.React, local: { hatsitSettings: JSON.stringify({ language: lang }) } });
    eq(e.C.roomInviteUrl("nardy", "4821"), "https://hatsit.vercel.app/join/nardy/4821" + tail, lang + ": the invite address");
  }

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
