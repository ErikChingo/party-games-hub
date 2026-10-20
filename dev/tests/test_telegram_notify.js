const ROOT = require("path").resolve(__dirname, "../..");
// Telegram notifications: Telegram's signed initData, /api/notify (status,
// subscribe, switches, «someone is waiting», the daily reminder from the
// cron), «your turn» from /api/cards for someone who is away, and the site's
// side (the daily task list matches the bot's). Telegram and the database are
// faked in memory.
const fs = require("fs");
const crypto = require("crypto");
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

process.env.TELEGRAM_BOT_TOKEN = "123456:TEST-token";
process.env.CRON_SECRET = "cron-secret-123";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
const tg = require(ROOT + "/api/_lib/telegram.js");
const notify = require(ROOT + "/api/notify.js");
const cards = require(ROOT + "/api/cards.js");
const Nardy = require(ROOT + "/api/_lib/nardy.js");

// Telegram's own way of signing Mini App data.
function initData(user, ageSeconds = 10, token = process.env.TELEGRAM_BOT_TOKEN) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSeconds), query_id: "q1", user: JSON.stringify(user) });
  const check = Array.from(params.entries()).map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

// ---------- fake database + Telegram ----------
let subscribers = {}, roomAlerts = {}, openRooms = [], profiles = {}, sent = [], blocked = new Set(), rooms = {};
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (body === undefined ? "" : JSON.stringify(body)) });
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.telegram.org/bot")) {
    const body = JSON.parse(init.body);
    if (blocked.has(body.chat_id)) return json(403, { ok: false });
    sent.push(body);
    return json(200, { ok: true });
  }
  const path = decodeURIComponent(url.match(/\/rest\/v1\/(.*)$/)[1]);
  const q = new URLSearchParams(path.split("?")[1] || "");
  const now = Date.now();
  if (path.startsWith("rpc/")) {
    const args = JSON.parse(init.body || "{}");
    const name = path.slice(4).split("?")[0];
    if (name === "moderate_display_name") return json(200, args.p_name);
    if (name === "cards_record") return json(200, { ok: true });
    if (name === "tg_claim_turn") {
      const s = subscribers[args.p_tg];
      if (!s || !s.active || !s.want_turns || (s.last_turn_ping && now - s.last_turn_ping < 180000)) return json(200, []);
      s.last_turn_ping = now;
      return json(200, [{ tg_id: s.tg_id, lang: s.lang }]);
    }
    if (name === "tg_claim_room") {
      const key = args.p_game + ":" + args.p_code;
      if (roomAlerts[key] && now - roomAlerts[key] < 7200000) return json(200, []);
      roomAlerts[key] = now;
      const out = Object.values(subscribers).filter((s) => s.active && s.want_rooms && s.tg_id !== args.p_host && (!s.last_room_ping || now - s.last_room_ping > 3 * 3600000));
      out.forEach((s) => (s.last_room_ping = now));
      return json(200, out.map((s) => ({ tg_id: s.tg_id, lang: s.lang })));
    }
    if (name === "tg_claim_daily") {
      const out = Object.values(subscribers).filter((s) => s.active && s.want_daily && s.last_daily_ping !== args.p_day && (profiles["tg:" + s.tg_id] || {}).daily_last !== args.p_day);
      out.forEach((s) => (s.last_daily_ping = args.p_day));
      return json(200, out.map((s) => { const pr = profiles["tg:" + s.tg_id] || {}; return { tg_id: s.tg_id, lang: s.lang, streak: pr.daily_streak || 0, done_yesterday: pr.daily_last === tg.yerevanToday(Date.now() - 86400000) }; }));
    }
    return json(404, {});
  }
  if (path.startsWith("tg_subscribers")) {
    const id = Number((q.get("tg_id") || "").replace("eq.", ""));
    if (!init.method || init.method === "GET") return json(200, subscribers[id] ? [{ ...subscribers[id] }] : []);
    const body = JSON.parse(init.body);
    if (init.method === "POST") { subscribers[body.tg_id] = { want_daily: true, want_rooms: true, want_turns: true, ...(subscribers[body.tg_id] || {}), ...body }; return json(201, [subscribers[body.tg_id]]); }
    if (init.method === "PATCH") { if (subscribers[id]) Object.assign(subscribers[id], body); return json(200, subscribers[id] ? [subscribers[id]] : []); }
  }
  if (path.startsWith("open_rooms")) {
    const game = (q.get("game") || "").replace("eq.", ""), code = (q.get("code") || "").replace("eq.", "");
    return json(200, openRooms.filter((r) => r.game === game && r.code === code));
  }
  if (path.startsWith("card_rooms")) {
    const code = (q.get("code") || "").replace("eq.", "");
    if (!init.method || init.method === "GET") return json(200, rooms[code] ? [JSON.parse(JSON.stringify(rooms[code]))] : []);
    if (init.method === "POST") { const b = JSON.parse(init.body); if (rooms[b.code]) return json(409, {}); rooms[b.code] = { code: b.code, state: b.state, version: 1, updated_at: new Date().toISOString() }; return json(201, null); }
    if (init.method === "PATCH") {
      const v = Number((q.get("version") || "").replace("eq.", ""));
      if (!rooms[code] || rooms[code].version !== v) return json(200, []);
      const b = JSON.parse(init.body); rooms[code] = { ...rooms[code], state: b.state, version: b.version, updated_at: b.updated_at }; return json(200, [rooms[code]]);
    }
  }
  return json(404, {});
};
function call(handler, { method = "POST", body, headers = {}, query = {} }) {
  return new Promise((resolve) => {
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    handler({ method, body, headers, query }, res);
  });
}

(async () => {
  /* ---------- who is asking ---------- */
  const anna = { id: 501, first_name: "Аня", language_code: "ru" };
  ok(tg.verifyInitData(initData(anna)).id === 501, "Telegram's signed data is accepted");
  ok(tg.verifyInitData(initData(anna).replace("501", "502")) === null, "changed data is refused");
  ok(tg.verifyInitData(initData(anna, 10, "999:other-bot")) === null, "data signed for another bot is refused");
  ok(tg.verifyInitData(initData(anna, 8 * 24 * 3600)) === null, "data older than a week is refused");
  ok(tg.verifyInitData("") === null && tg.verifyInitData(null) === null, "no data, no user");

  /* ---------- subscribe, switches ---------- */
  let r = await call(notify, { body: { action: "status", initData: initData(anna) } });
  eq([r.code, r.body.subscribed], [200, false], "not subscribed at first");
  eq((await call(notify, { body: { action: "subscribe", initData: "fake" } })).code, 403, "subscribing needs Telegram's signature");
  r = await call(notify, { body: { action: "subscribe", initData: initData(anna), lang: "hy" } });
  eq([r.body.subscribed, r.body.prefs], [true, { daily: true, rooms: true, turns: true }], "subscribed with every kind on");
  ok(sent.length === 1 && sent[0].chat_id === 501 && sent[0].text.startsWith("🔔"), "a first hello from the bot, in the chosen language");
  ok(/[Ա-֏]/.test(sent[0].text), "…Armenian here");
  r = await call(notify, { body: { action: "subscribe", initData: initData(anna), lang: "ru" } });
  eq(sent.length, 1, "subscribing again does not say hello twice");
  r = await call(notify, { body: { action: "prefs", initData: initData(anna), prefs: { daily: true, rooms: false, turns: true } } });
  eq(r.body.prefs, { daily: true, rooms: false, turns: true }, "one kind switched off");
  r = await call(notify, { body: { action: "prefs", initData: initData(anna), prefs: { daily: false, rooms: false, turns: false } } });
  eq([r.body.subscribed, subscribers[501].active], [false, false], "all off = unsubscribed");
  await call(notify, { body: { action: "subscribe", initData: initData(anna), lang: "ru" } });

  /* ---------- «someone is waiting» ---------- */
  const boris = { id: 502, first_name: "Боря" }, vika = { id: 503, first_name: "Вика" };
  await call(notify, { body: { action: "subscribe", initData: initData(boris), lang: "ru" } });
  await call(notify, { body: { action: "subscribe", initData: initData(vika), lang: "en" } });
  sent = [];
  r = await call(notify, { body: { action: "room_open", game: "nardy", code: "4821", initData: initData(anna) } });
  eq(r.body.sent, 0, "a room that is not on the open list tells nobody");
  openRooms.push({ game: "nardy", code: "4821", host_name: "Аня", players: 1, max_players: 2 });
  r = await call(notify, { body: { action: "room_open", game: "nardy", code: "4821", initData: initData(anna) } });
  eq(sent.map((m) => m.chat_id).sort(), [502, 503], "everyone subscribed hears of it, except the host");
  const toBoris = sent.find((m) => m.chat_id === 502);
  ok(toBoris.text.includes("Аня") && toBoris.text.includes("нарды") && toBoris.reply_markup.inline_keyboard[0][0].web_app.url === "https://hatsit.org/?room=4821&game=nardy", "«Аня ждёт игроков в нарды» with a button into the room");
  ok(sent.find((m) => m.chat_id === 503).text.includes("waiting"), "in each person's language");
  sent = [];
  await call(notify, { body: { action: "room_open", game: "nardy", code: "4821" } });
  eq(sent.length, 0, "the same room is not announced twice");
  openRooms.push({ game: "durak", code: "7777", host_name: "", players: 1, max_players: 6 });
  await call(notify, { body: { action: "room_open", game: "durak", code: "7777" } });
  eq(sent.map((m) => m.chat_id), [501], "a second room within 3 hours: only the one not told yet (the first room's host)");
  openRooms.push({ game: "mafia", code: "1111", host_name: "Ли", players: 3, max_players: 20 });
  subscribers[502].last_room_ping = 0; sent = [];
  await call(notify, { body: { action: "room_open", game: "mafia", code: "1111" } });
  ok(sent.length === 1 && sent[0].reply_markup.inline_keyboard[0][0].web_app.url.endsWith("game=mafiaroom"), "a Mafia room opens the online Mafia screen");
  eq((await call(notify, { body: { action: "room_open", game: "spy", code: "1234" } })).code, 400, "only games with open rooms");

  /* ---------- the daily reminder (cron) ---------- */
  eq((await call(notify, { method: "GET", query: { task: "daily" } })).code, 401, "the cron call needs its secret");
  const today = tg.yerevanToday();
  profiles["tg:502"] = { daily_last: today };
  profiles["tg:501"] = { daily_last: tg.yerevanToday(Date.now() - 86400000), daily_streak: 6 };
  sent = [];
  r = await call(notify, { method: "GET", query: { task: "daily" }, headers: { authorization: "Bearer cron-secret-123" } });
  eq(sent.map((m) => m.chat_id).sort(), [501, 503], "a reminder to those who have not done today's task");
  const toAnna = sent.find((m) => m.chat_id === 501);
  const task = tg.dailyTaskFor(today);
  ok(toAnna.text.includes(tg.TEXT.ru.task[task]) && toAnna.text.includes("Серия 6"), "today's task and the streak to keep");
  ok(!sent.find((m) => m.chat_id === 503).text.includes("🔥"), "no streak line for someone without one");
  sent = [];
  await call(notify, { method: "GET", query: { task: "daily" }, headers: { authorization: "Bearer cron-secret-123" } });
  eq(sent.length, 0, "one reminder a day");
  blocked.add(503); subscribers[503].last_daily_ping = null;
  await call(notify, { method: "GET", query: { task: "daily" }, headers: { authorization: "Bearer cron-secret-123" } });
  eq(subscribers[503].active, false, "someone who blocked the bot is taken off the list");

  /* ---------- «your turn» from the game server ---------- */
  {
    const { act, turnPings, awaitedSeats } = cards._internals;
    const st = Nardy.newGame([{ id: "a", profileId: "tg:501", name: "Аня" }, { id: "b", profileId: "anon:x", name: "Б" }], { variant: "short" });
    eq(awaitedSeats(st), [st.turn], "nardy waits for whoever has the turn");
    const other = 1 - st.turn;
    const away = JSON.parse(JSON.stringify(st)); away.players[other].away = true;
    const after = Nardy.apply(away, st.turn, Nardy.botMove(away, st.turn)).state;
    eq(turnPings(away, after).map((x) => x.id), other === 0 ? ["a"] : [], "the next player, away and on Telegram, is told");
    const here = JSON.parse(JSON.stringify(after)); here.players[other].away = false;
    eq(turnPings(away, here).length, 0, "nobody is told while they are in the game");
    const pres = act({ ...st, players: st.players.map((x) => ({ ...x })) }, { action: "presence", playerId: "a", away: true }, {}, Date.now());
    ok(pres.state.players[0].away === true, "presence marks a player as away");
    // End to end: Аня creates a room, Боря joins, Аня goes away; Боря's move brings «your turn».
    rooms = {}; sent = []; subscribers[501].last_turn_ping = 0;
    const S = (n) => "secret-secret-secret-" + n;
    const c1 = await call(cards, { body: { action: "create", game: "nardy", playerId: "c-anna1", secret: S(1), name: "Аня", profileId: "tg:501" } });
    const code = c1.body.code;
    await call(cards, { body: { action: "join", code, playerId: "c-boris", secret: S(2), name: "Боря", profileId: "anon:b" } });
    await call(cards, { body: { action: "start", code, playerId: "c-anna1", secret: S(1) } });
    await call(cards, { body: { action: "presence", code, playerId: "c-anna1", secret: S(1), away: true } });
    let guard = 0;
    while (rooms[code].state.turn !== 1 && guard++ < 5) {
      const s = rooms[code].state;
      await call(cards, { body: { action: "move", code, playerId: "c-anna1", secret: S(1), move: Nardy.botMove(s, 0) } });
      await call(cards, { body: { action: "presence", code, playerId: "c-anna1", secret: S(1), away: true } });
    }
    sent = [];
    const s = rooms[code].state;
    await call(cards, { body: { action: "move", code, playerId: "c-boris", secret: S(2), move: Nardy.botMove(s, 1) } });
    if (rooms[code].state.turn === 0) {
      ok(sent.length === 1 && sent[0].chat_id === 501 && sent[0].text.includes("Ваш ход в нардах"), "Аня, away, hears «Ваш ход в нардах»");
      ok(sent[0].reply_markup.inline_keyboard[0][0].web_app.url === `https://hatsit.org/?room=${code}&game=nardy`, "…with a button back into the room");
    } else ok(true, "(the roll passed the turn straight back: nothing to say)");
    ok(rooms[code].state.players[1].away === false, "moving marks a player as present");
  }

  /* ---------- the bot's daily tasks are the site's ---------- */
  {
    const src = fs.readFileSync(ROOT + "/index.html", "utf8");
    const ids = [...src.slice(src.indexOf("const DAILY_TASKS = ["), src.indexOf("];", src.indexOf("const DAILY_TASKS = ["))).matchAll(/id: "([a-z_]+)"/g)].map((x) => x[1]);
    eq(tg.DAILY_ORDER, ids, "the same eight tasks in the same order as on the site");
    for (const id of ids) {
      const m = src.match(new RegExp(`"daily\\.task\\.${id}": \\{ ru: "([^"]*)", en: "([^"]*)", hy: "([^"]*)"`));
      ok(m && m[1] === tg.TEXT.ru.task[id] && m[2] === tg.TEXT.en.task[id] && m[3] === tg.TEXT.hy.task[id], "the bot words the task as the site does: " + id);
    }
    const vercel = JSON.parse(fs.readFileSync(ROOT + "/vercel.json", "utf8"));
    ok((vercel.crons || []).some((c) => c.path === "/api/notify?task=daily" && c.schedule === "0 15 * * *"), "the reminder runs at 15:00 UTC = 19:00 in Yerevan");
    ok(/telegram\.onEvent\("deactivated", away\)/.test(src) && /tellRoomOpen\(game, now\.code\)/.test(src), "the app reports going to the background and new open rooms");
  }

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
