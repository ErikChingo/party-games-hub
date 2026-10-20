// Telegram notifications from @hatsit_games_bot.
//
//   POST /api/notify { action, initData, ... }
//     status       -> { ok, subscribed, prefs }
//     subscribe    -> after the person let the bot write to them (Mini App)
//     prefs        -> { prefs: { daily, rooms, turns } } switches; all off = unsubscribed
//     room_open    -> { game, code }: a room just went on the open list; tells
//                     subscribers «someone is waiting» (each at most once per 3 h)
//   GET  /api/notify?task=daily  (Vercel cron, 19:00 Yerevan)
//     -> today's task reminder to subscribers who have not done it
//
// Who is asking is checked from Telegram's signed initData, never taken on
// trust. The tables and the claim_* functions are in supabase/telegram_notify.sql;
// they make sure no one gets the same note twice.
//
// Vercel env: TELEGRAM_BOT_TOKEN (from @BotFather), CRON_SECRET (any long
// random string; Vercel sends it with the cron call), SUPABASE_SERVICE_ROLE_KEY.

const tg = require("./_lib/telegram.js");

const DEFAULT_SUPABASE_URL = "https://zocoaqqcrxpbkyzlfzsf.supabase.co";
const ROOM_GAMES = ["bunker", "court", "mafia", "durak", "blot", "blackjack", "nardy"];
const LANGS = ["ru", "en", "hy"];

function supa() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return { url, key };
}
async function db(path, init = {}) {
  const { url, key } = supa();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error("db " + res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const rpc = (name, args) => db("rpc/" + name, { method: "POST", body: JSON.stringify(args) });

function reply(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}
const langOf = (x) => (LANGS.includes(x) ? x : "ru");
const prefsOf = (row) => (row && row.active ? { daily: !!row.want_daily, rooms: !!row.want_rooms, turns: !!row.want_turns } : null);

// Sends to everyone in `list` ({ tg_id, lang }); marks those who blocked the bot.
async function sendAll(list, make) {
  let sent = 0;
  for (const person of list.slice(0, 500)) {
    const { text, button } = make(tg.textFor(person.lang), person);
    const r = await tg.sendMessage(person.tg_id, text, button);
    if (r.ok) sent++;
    else if (r.blocked) await db(`tg_subscribers?tg_id=eq.${person.tg_id}`, { method: "PATCH", body: JSON.stringify({ active: false }) }).catch(() => null);
  }
  return sent;
}

async function daily(res) {
  const day = tg.yerevanToday();
  const task = tg.dailyTaskFor(day);
  const game = tg.DAILY_GAME[task];
  const list = (await rpc("tg_claim_daily", { p_day: day })) || [];
  const sent = await sendAll(list, (t, person) => ({
    // The streak line only for those who have one going (done yesterday).
    text: t.daily.replace("{task}", t.task[task]) + (person.done_yesterday && person.streak > 0 ? "\n" + t.streak.replace("{n}", person.streak) : ""),
    button: { text: t.play, url: tg.SITE + (game ? "/?play=" + game : "/") },
  }));
  return reply(res, 200, { ok: true, day, task, sent });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const secret = process.env.CRON_SECRET || "";
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) return reply(res, 401, { error: "unauthorized" });
      if ((req.query && req.query.task) !== "daily") return reply(res, 400, { error: "bad_request" });
      return await daily(res);
    }
    if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" });
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    body = body || {};
    const user = tg.verifyInitData(body.initData);

    if (body.action === "room_open") {
      const game = String(body.game || "");
      const code = String(body.code || "").replace(/\D/g, "").slice(0, 4);
      if (!ROOM_GAMES.includes(game) || code.length !== 4) return reply(res, 400, { error: "bad_request" });
      // Only a room that really is on the open list right now.
      const since = new Date(Date.now() - 60000).toISOString();
      const rooms = await db(`open_rooms?game=eq.${game}&code=eq.${code}&updated_at=gt.${encodeURIComponent(since)}&select=host_name,players,max_players`);
      const room = rooms && rooms[0];
      if (!room || (room.max_players && room.players >= room.max_players)) return reply(res, 200, { ok: true, sent: 0 });
      const list = (await rpc("tg_claim_room", { p_game: game, p_code: code, p_host: user ? user.id : null })) || [];
      const sent = await sendAll(list, (t) => ({
        text: t.room.replace("{name}", room.host_name || t.someone).replace("{game}", t.games[game] || game),
        button: { text: t.join, url: tg.roomUrl(game, code) },
      }));
      return reply(res, 200, { ok: true, sent });
    }

    if (!user) return reply(res, 403, { error: "forbidden" });
    const rows = await db(`tg_subscribers?tg_id=eq.${user.id}&select=*`);
    const row = rows && rows[0];

    if (body.action === "status") return reply(res, 200, { ok: true, subscribed: !!(row && row.active), prefs: prefsOf(row) });

    if (body.action === "subscribe") {
      const lang = langOf(body.lang || user.language_code);
      const saved = await db("tg_subscribers?on_conflict=tg_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ tg_id: user.id, lang, active: true, want_daily: true, want_rooms: true, want_turns: true, updated_at: new Date().toISOString() }),
      });
      // A first hello, so the chat with the bot exists and shows what to expect.
      if (!(row && row.active)) await tg.sendMessage(user.id, tg.textFor(lang).welcome);
      return reply(res, 200, { ok: true, subscribed: true, prefs: prefsOf(saved && saved[0]) });
    }

    if (body.action === "prefs") {
      const p = body.prefs || {};
      const next = { want_daily: !!p.daily, want_rooms: !!p.rooms, want_turns: !!p.turns, updated_at: new Date().toISOString() };
      next.active = next.want_daily || next.want_rooms || next.want_turns;
      if (body.lang) next.lang = langOf(body.lang);
      if (!row) return reply(res, 200, { ok: true, subscribed: false, prefs: null });
      const saved = await db(`tg_subscribers?tg_id=eq.${user.id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(next) });
      return reply(res, 200, { ok: true, subscribed: next.active, prefs: prefsOf(saved && saved[0]) });
    }

    return reply(res, 400, { error: "bad_request" });
  } catch (e) {
    return reply(res, 502, { error: "storage error" });
  }
};

module.exports._internals = { daily, sendAll };
