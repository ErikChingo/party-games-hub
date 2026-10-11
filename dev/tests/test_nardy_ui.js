const ROOT = require("path").resolve(__dirname, "../..");
// Nardy in the page: engine copy, Hub, screens, a whole game against the bot
// on the phone, and an online game on two phones against the real
// /api/cards handler (with a fake database in memory).
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["NardyEngine", "NardyApp", "NardyTable", "NardyLocalGame", "NardyLobby", "NardyResult", "NardyBoard", "nardyPredict", "nardyLocalPlayers", "nardyReplayPlan", "nardyStepArrivals", "nardyEndDelay", "ACHIEVEMENTS", "PLAYER_TITLES", "TITLE_PROFILE_FIELDS", "LEADERBOARD_TABS", "LEADERBOARD_COLUMNS", "computeUnlockedAchievementIds", "getPlayerTitle", "useCardRoom", "NARDY_SESSION_KEY", "GAMES", "loadHubSection", "HUB_SECTIONS", "SCREEN_COMPONENTS", "LAUNCH_ACTION_TO_GAME", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS, makeRuntime, wait };")(require, m, __dirname);
const { load, React, RDS, makeRuntime, wait } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const src = fs.readFileSync(ROOT + "/index.html", "utf8");
const html = (el) => RDS.renderToStaticMarkup(el);
const RU = { hatsitSettings: JSON.stringify({ language: "ru" }) };
const noop = () => {};
const N = require(ROOT + "/api/_lib/nardy.js");

// ---------- fake Supabase REST + the real /api/cards ----------
const handler = require(ROOT + "/api/cards.js");
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
const rooms = {};
const recorded = [];
let apiDelay = 0;
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function rest(url, init) {
  const path = url.match(/\/rest\/v1\/(.*)$/)[1];
  if (path.startsWith("rpc/moderate_display_name")) return json(200, JSON.parse(init.body).p_name);
  if (path.startsWith("rpc/cards_record")) { recorded.push(JSON.parse(init.body)); return json(200, { ok: true }); }
  if (path.startsWith("rpc/")) return json(200, null);
  const q = new URLSearchParams(path.split("?")[1] || "");
  const code = (q.get("code") || "").replace("eq.", "");
  if (!init.method || init.method === "GET") return json(200, rooms[code] ? [JSON.parse(JSON.stringify(rooms[code]))] : []);
  if (init.method === "POST") { const b = JSON.parse(init.body); if (rooms[b.code]) return json(409, {}); rooms[b.code] = { code: b.code, state: b.state, version: 1, updated_at: new Date().toISOString() }; return json(201, null); }
  if (init.method === "PATCH") {
    const v = Number((q.get("version") || "").replace("eq.", ""));
    if (!rooms[code] || rooms[code].version !== v) return json(200, []);
    const b = JSON.parse(init.body); rooms[code] = { ...rooms[code], state: b.state, version: b.version, updated_at: b.updated_at }; return json(200, [rooms[code]]);
  }
  return json(404, {});
}
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes("/rest/v1/")) return rest(url, init);
  if (url === "/api/cards") {
    const body = JSON.parse(init.body);
    return new Promise((resolve) => {
      const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve(json(this.code, o)); } };
      setTimeout(() => handler({ method: "POST", body }, res), apiDelay);
    });
  }
  return json(404, {});
};
// cards_view(), the way the database function does it (supabase/cards.sql).
function cardsView(args) {
  const row = rooms[args.p_code];
  if (!row || row.state.status === "closed") return { data: { error: "not_found" }, error: null };
  const seat = row.state.players.find((q) => q.id === args.p_player_id);
  if (!seat || seat.secretHash !== require("crypto").createHash("sha256").update(args.p_secret).digest("hex")) return { data: { error: "not_in_room" }, error: null };
  const view = JSON.parse(JSON.stringify(row.state));
  delete view.deck; delete view.secret;
  view.players = view.players.map((q) => { delete q.secretHash; delete q.profileId; return q; });
  return { data: { ok: true, code: row.code, version: row.version, view }, error: null };
}
const rpcAny = (fn, args) => Promise.resolve(fn === "cards_view" ? cardsView(args) : { data: null, error: null });

// The bot waits ~1 s before moving; run those waits fast here.
const realSetTimeout = global.setTimeout;
let fast = false;
global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, fast && ms >= 500 ? 1 : ms, ...rest);

(async () => {
  /* ---------- the engine in the page is the server's ---------- */
  const block = (s) => s.slice(s.indexOf("/* NARDY-ENGINE-BEGIN */"), s.indexOf("/* NARDY-ENGINE-END */"));
  const serverBlock = block(fs.readFileSync(ROOT + "/api/_lib/nardy.js", "utf8"));
  ok(serverBlock.length > 5000 && block(src) === serverBlock, "index.html carries an exact copy of api/_lib/nardy.js");

  let env = load({ react: React, local: { ...RU } });
  const C = env.C;
  ok(C.NardyEngine && typeof C.NardyEngine.newGame === "function", "the engine is in the bundle");

  /* ---------- Hub and routing ---------- */
  const page = html(React.createElement(load({ react: React, local: { ...RU, hatsit_hub_section_v1: "cards" } }).C.Hub, { state: { feedbackPending: null }, dispatch: noop }));
  const at = (x) => page.indexOf(">" + x + "<");
  ok(at("Нарды") > 0 && at("Нарды") < at("Блот"), "«Нарды» is first in its tab");
  ok(page.includes("Карты и нарды"), "the tab is called «Карты и нарды»");
  const nardyTile = C.GAMES.find((g) => g.id === "nardy");
  ok(nardyTile && nardyTile.isNew && nardyTile.section === "cards", "Nardy is marked НОВОЕ in the cards tab");
  eq(C.reducer(C.initialState, { type: "OPEN_NARDY" }).screen, "nardy", "OPEN_NARDY");
  ok(C.SCREEN_COMPONENTS.nardy === C.NardyApp, "the screen is routed");
  ok(/\|nardy\)_\(/.test(src) && /game === "nardy"\)\) return \{ room, game \}/.test(src), "invite links (Telegram and web) accept nardy");
  eq(C.reducer({ ...C.initialState, screen: "nardy" }, { type: "GO_HUB" }).feedbackPending, "nardy", "leaving asks «how was it?»");

  /* ---------- hooks stable ---------- */
  {
    const rt = makeRuntime();
    let count = 0;
    const counted = {};
    for (const k of Object.keys(rt.hooks)) counted[k] = (...a) => { count++; return rt.hooks[k](...a); };
    const e = load({ react: { ...React, ...counted }, local: { ...RU } });
    const counts = [];
    rt.mount((props) => { count = 0; const r = e.C.NardyApp(props); counts.push(count); return r; }, { dispatch: noop });
    const text = (el) => (el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el) : Array.isArray(el) ? el.map(text).join("") : el.props ? text(el.props.children) : "");
    const find = (el, label) => {
      if (el == null || typeof el !== "object") return null;
      if (Array.isArray(el)) { for (const x of el) { const r = find(x, label); if (r) return r; } return null; }
      if (el.type === "button" && text(el).includes(label)) return el;
      return el.props ? find(el.props.children, label) : null;
    };
    const press = async (label) => { const b = find(rt.result, label); ok(!!b, "button " + label); if (b) b.props.onClick(); await wait(5); };
    // An element (not rendered further here) by a prop it carries.
    const findBy = (el, test) => {
      if (el == null || typeof el !== "object") return null;
      if (Array.isArray(el)) { for (const x of el) { const r = findBy(x, test); if (r) return r; } return null; }
      if (el.props && test(el.props)) return el;
      return el.props ? findBy(el.props.children, test) : null;
    };
    await press("Играть с ботом");
    const picker = findBy(rt.result, (pr) => typeof pr.onChange === "function" && pr.value === "short");
    ok(!!picker, "the short/long picker is shown");
    if (picker) picker.props.onChange("long");
    await wait(5);
    await press("Лёгкий бот");
    await press("Начать игру");
    const game = findBy(rt.result, (pr) => pr.initial && pr.initial.game === "nardy");
    eq(game && game.props.initial.settings, { variant: "long", level: "easy" }, "the chosen variant and bot strength are used");
    eq(e.ls.getItem("hatsit_nardy_variant_v1"), "long", "the variant is remembered");
    rt.unmount();
    ok(counts.length >= 4 && counts.every((c) => c === counts[0]), "NardyApp calls the same hooks on every screen: " + counts.join(","));
  }

  /* ---------- screens ---------- */
  const t = (k) => C.t_lookup(k, "ru");
  let st = C.NardyEngine.newGame(C.nardyLocalPlayers(t), { variant: "short" });
  st.turn = 0; st.dice = [4, 3];
  let pg = html(React.createElement(C.NardyTable, { view: st, meIndex: 0, onTurn: noop }));
  ok(pg.includes("Ваш ход") && pg.includes(">Готово<") && pg.includes(">Отменить<"), "my turn: the hint, Done and Undo");
  ok(pg.includes("осталось 167") && pg.includes("Бот 1"), "both players with their pip counts");
  ok((pg.match(/<circle/g) || []).length > 60, "checkers and dice are drawn");
  st.turn = 1;
  pg = html(React.createElement(C.NardyTable, { view: st, meIndex: 0, onTurn: noop }));
  ok(pg.includes("Ходит Бот 1") && !pg.includes(">Готово<"), "the bot's turn: no buttons");
  pg = html(React.createElement(C.NardyResult, { view: { ...st, status: "ended", winner: 0, mars: true }, meIndex: 0, onAgain: noop, onExit: noop }));
  ok(pg.includes("Победа!") && pg.includes("Марс"), "a win by mars");
  pg = html(React.createElement(C.NardyResult, { view: { ...st, status: "ended", winner: 1, mars: false }, meIndex: 0, onExit: noop, waitText: "ждём" }));
  ok(pg.includes("Поражение") && pg.includes("Победил Бот 1") && pg.includes("ждём"), "a loss");
  for (const lang of ["en", "hy"]) {
    const e2 = load({ react: React, local: { hatsitSettings: JSON.stringify({ language: lang }) } });
    const g2 = e2.C.NardyEngine.newGame(e2.C.nardyLocalPlayers((k) => e2.C.t_lookup(k, lang)), { variant: "long" });
    const out = html(React.createElement(e2.C.NardyTable, { view: g2, meIndex: 0, onTurn: noop }));
    ok(!/nardy\.\w+/.test(out), lang + ": no untranslated keys on the table");
  }

  /* ---------- predict ---------- */
  {
    const g = C.NardyEngine.newGame(C.nardyLocalPlayers(t), { variant: "short" });
    const mv = C.NardyEngine.botMove(g, g.turn);
    const shown = C.nardyPredict(g, g.turn, mv);
    ok(shown !== g && shown.turn === 1 - g.turn && shown.dice === null && shown.last.seat === g.turn, "my turn shows at once; the next roll waits for the server");
    ok(C.nardyPredict(g, g.turn, { type: "turn", steps: [] }) === g, "an unfinished turn is not guessed");
  }

  /* ---------- animations: the other side's turn played back ---------- */
  {
    const E2 = C.NardyEngine;
    let all = 0, planned = 0, exact = 0, offs = 0;
    for (const variant of ["short", "long"]) {
      let g = E2.newGame(C.nardyLocalPlayers(t), { variant });
      for (let k = 0; k < 400 && g.status === "playing"; k++) {
        const prev = { b: g.board.slice(), bar: g.bar.slice(), off: g.off.slice() };
        const r = E2.apply(g, g.turn, E2.botMove(g, g.turn));
        g = r.state;
        if (!g.last || g.last.blocked || g.last.steps.length === 0) continue;
        all++;
        const plan = C.nardyReplayPlan(prev, g, 0);
        if (!plan) continue;
        planned++;
        const lastFrame = plan.frames[plan.frames.length - 1];
        if (plan.frames.length === g.last.steps.length && lastFrame.b.join() === g.board.join() && lastFrame.off.join() === g.off.join()) exact++;
        plan.arrivals.forEach((a) => { if (a.some((x) => x.kind === "off")) offs++; });
      }
    }
    ok(all > 50 && planned === all && exact === all, `every bot turn plays back step by step to the new position (${exact}/${all})`);
    ok(offs > 0, `borne-off checkers fly to the tray (${offs})`);
    // A hit, on a position made for it: seat 0 from 13 lands on seat 1's blot on 10 (its own 15).
    const hb = new Array(24).fill(0);
    hb[E2.abs("short", 0, 13)] = 1;
    hb[E2.abs("short", 1, 15)] = -1;
    const hitArr = C.nardyStepArrivals({ b: hb, bar: [0, 0], off: [14, 14] }, "short", 0, 0, { from: 13, to: 10, die: 3, hit: true });
    eq(hitArr.map((a) => a.kind + ":" + a.seat), ["point:0", "bar:1"], "a hit checker flies to the bar after the mover lands");
    const g = E2.newGame(C.nardyLocalPlayers(t), { variant: "short" });
    ok(C.nardyReplayPlan(null, g, 0) === null, "nothing is played back on the first look");
    ok(C.nardyReplayPlan({ b: g.board, bar: g.bar, off: g.off }, g, 0) === null, "nothing is played back when the position did not change (my own turn)");
    eq([C.nardyEndDelay({ last: { seat: 0, steps: [1, 2] } }, 0), C.nardyEndDelay({ last: { seat: 1, steps: [1, 2, 3, 4] } }, 0)], [700, 4 * 600 + 500], "the result waits for the last move to play out");
  }

  /* ---------- a whole game against the bot on the phone ---------- */
  for (const variant of ["short", "long"]) {
    fast = true;
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU } });
    const g0 = e.C.NardyEngine.newGame(e.C.nardyLocalPlayers((k) => e.C.t_lookup(k, "ru")), { variant });
    let ended = false;
    rt.mount((props) => e.C.NardyLocalGame(props), { initial: g0, onExit: noop, onAgain: noop });
    let steps = 0;
    while (steps++ < 3000) {
      const full = JSON.parse(e.ss.getItem("hatsit_nardy_local_v1"));
      if (full.status === "ended") { ended = true; break; }
      if (full.turn === 0) rt.result.props.children[0].props.onTurn(e.C.NardyEngine.botMove(full, 0).steps);
      await wait(2);
    }
    ok(ended, variant + ": a whole game against the bot on the phone (" + steps + " steps)");
    await wait(30);
    ok(!!rt.result.props.children[1], variant + ": the result is shown at the end, after the last move has played out");
    rt.unmount();
    fast = false;
  }

  /* ---------- online, two phones ---------- */
  {
    const mk = (id) => {
      const rt = makeRuntime();
      const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU, hatsit_cards_identity_v1: JSON.stringify({ id, secret: "secret-secret-" + id }), hatsit_player_id_v1: "anon:p-" + id }, rpcAny });
      rt.mount(() => e.C.useCardRoom("nardy", e.C.nardyPredict, e.C.NARDY_SESSION_KEY));
      return { rt, e, get room() { return rt.result; } };
    };
    const A = mk("c-alice1"), B = mk("c-boris2");
    await A.room.create("Аня", { variant: "long" });
    await wait(5);
    const code = A.room.code;
    eq([rooms[code].state.game, rooms[code].state.settings.variant], ["nardy", "long"], "Аня opens a long-nardy room");
    eq((await A.room.call("start")).error, "need_players", "it cannot start alone");
    await B.room.join("Боря", code);
    eq((await (mk("c-vika33").room.join("Вика", code))).error, "full", "a third player is turned away");
    await A.room.call("start");
    await wait(2700);
    const s0 = rooms[code].state;
    ok(s0.status === "playing" && B.room.view && B.room.view.status === "playing", "Боря sees the game start");
    ok(s0.deadline - Date.now() > 40000, "a turn has 45 seconds online");
    ok(B.room.view.players.every((q) => !q.secretHash && !q.profileId), "no secrets reach a phone");
    // The first player's move shows on their phone at once.
    const phones = [A, B];
    const first = phones[s0.turn];
    apiDelay = 200;
    first.room.move(N.botMove(s0, s0.turn));
    await wait(5);
    ok(first.room.view.turn === 1 - s0.turn && rooms[code].state.turn === s0.turn, "my turn shows at once, before the server has it");
    await wait(400);
    apiDelay = 0;
    ok(rooms[code].state.turn !== s0.turn || rooms[code].state.turns > s0.turns, "and the server took it");
    let guard = 0;
    while (rooms[code].state.status === "playing" && guard++ < 600) {
      const s = rooms[code].state;
      const r = await phones[s.turn].room.call("move", { move: N.botMove(s, s.turn) });
      if (!r || !r.ok) { ok(false, "a move was refused: " + JSON.stringify(r)); break; }
    }
    const end = rooms[code].state;
    ok(end.status === "ended" && end.off[end.winner] === 15, "the online game is played to the end (" + end.turns + " turns)");
    // The referee wrote the game into both profiles.
    const forNardy = recorded.filter((r) => r.p_delta.nardy_games);
    eq(forNardy.length, 2, "the result goes into both players' profiles");
    const winnerRow = forNardy.find((r) => r.p_delta.nardy_wins === 1);
    const loserRow = forNardy.find((r) => r.p_delta.nardy_wins === 0);
    ok(winnerRow && loserRow && winnerRow.p_profile_id !== loserRow.p_profile_id, "one win, one loss");
    ok(winnerRow && winnerRow.p_delta.nardy_long_wins === 1 && winnerRow.p_delta.nardy_short_wins === 0 && winnerRow.p_delta.nardy_mars === (end.mars ? 1 : 0), "the winner's long-nardy win and mars are counted");
    ok(loserRow && loserRow.p_delta.nardy_mars === 0 && loserRow.p_delta.nardy_long_wins === 0, "the loser gets only the game");
    await wait(2700);
    ok(B.room.view.status === "ended", "Боря sees the end");
    eq((await B.room.call("rematch")).error, "forbidden", "only the host starts a rematch");
    await A.room.call("rematch");
    ok(rooms[code].state.status === "playing" && rooms[code].state.settings.variant === "long", "a rematch, same variant");
    // Someone leaves mid-game: a bot plays on for them.
    await B.room.leave();
    const after = rooms[code].state;
    ok(after.players[1].bot && after.status === "playing", "Боря left: a bot plays on");
    A.rt.unmount(); B.rt.unmount();
  }

  /* ---------- statistics: only games of two people count ---------- */
  {
    const { statsEvents } = handler._internals;
    const base = (humans, players) => ({ game: "nardy", status: "ended", winner: 0, mars: true, humans, settings: { variant: "short" }, players });
    const two = [{ id: "a", profileId: "anon:a", name: "A" }, { id: "b", profileId: "anon:b", name: "B" }];
    const ev = statsEvents({ status: "playing" }, base(2, two));
    eq(ev.map((e) => [e.profileId, e.delta.nardy_wins, e.delta.nardy_mars, e.delta.nardy_short_wins]), [["anon:a", 1, 1, 1], ["anon:b", 0, 0, 0]], "two people: both counted, the winner with mars and a short win");
    eq(statsEvents({ status: "playing" }, base(1, [two[0], { id: "bot-1", bot: true }])).length, 0, "against a bot: nothing counted");
    eq(statsEvents({ status: "ended" }, base(2, two)).length, 0, "an ended game is counted only once");
    eq(statsEvents({ status: "playing" }, base(2, [two[0], { ...two[1], bot: true, left: true }])).map((e) => e.profileId), ["anon:a"], "someone who left (a bot played on) gets nothing");
  }

  /* ---------- achievements, titles, profile, leaderboard ---------- */
  {
    const A = C.ACHIEVEMENTS.filter((a) => a.group === "nardy");
    eq(A.map((a) => a.id), ["nardy_first", "nardy_win_10", "nardy_win_50", "nardy_mars_1", "nardy_mars_10", "nardy_both"], "six nardy achievements");
    for (const a of A) ok(typeof a.Icon === "function" && ["ru", "en", "hy"].every((l) => C.t_lookup(a.titleKey, l) !== a.titleKey && C.t_lookup(a.descKey, l) !== a.descKey), "achievement has an icon and 3-language texts: " + a.id);
    const ids = (p) => C.computeUnlockedAchievementIds(p).filter((x) => x.startsWith("nardy_"));
    eq(ids({ nardy_games: 1 }), ["nardy_first"], "one game: the first one");
    eq(ids({ nardy_games: 60, nardy_wins: 50, nardy_mars: 10, nardy_short_wins: 30, nardy_long_wins: 20 }), ["nardy_first", "nardy_win_10", "nardy_win_50", "nardy_mars_1", "nardy_mars_10", "nardy_both"], "all six");
    eq(ids({ nardy_games: 5, nardy_wins: 5, nardy_short_wins: 5 }), ["nardy_first"], "short wins only: not «both»");
    const titles = C.PLAYER_TITLES.filter((x) => x.achievementId.startsWith("nardy_"));
    eq(titles.map((x) => x.achievementId).sort(), ["nardy_mars_10", "nardy_win_50"], "two nardy titles");
    const sql = fs.readFileSync(ROOT + "/supabase/nardy_stats.sql", "utf8");
    ok(titles.every((x) => sql.includes("'" + x.achievementId + "'") && x.label.ru && x.label.en && x.label.hy), "the server knows both titles; each has 3 languages");
    ok(["nardy_wins", "nardy_mars"].every((k) => C.TITLE_PROFILE_FIELDS.includes(k)), "leaderboard rows carry what nardy titles need");
    eq(C.getPlayerTitle({ nardy_wins: 50 }).label.ru, "Мастер нард", "50 wins -> «Мастер нард»");
    ok(C.LEADERBOARD_TABS.some((x) => x.key === "nardy") && C.LEADERBOARD_COLUMNS.nardy === "nardy_wins", "a «Нарды» leaderboard tab, by wins");
    ok(["nardy_games", "nardy_wins", "nardy_mars", "nardy_short_wins", "nardy_long_wins"].every((k) => sql.includes(k)), "the database has the columns");
  }

  /* ---------- the referee knows the game ---------- */
  {
    const G = handler._internals.GAMES.nardy;
    eq([G.minPlayers, G.maxPlayers, G.turnMs], [2, 2, 45000], "two players, 45 s a turn");
    eq(G.settings({ variant: "long" }, null), { variant: "long", level: "normal" }, "settings: the variant");
    eq(G.settings({ variant: "x" }, { variant: "long" }), { variant: "long", level: "normal" }, "settings: bad values keep the old ones");
  }

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
