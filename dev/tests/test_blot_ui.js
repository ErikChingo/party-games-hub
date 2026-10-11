const ROOT = require("path").resolve(__dirname, "../..");
// Blot in the page: engine copy, Hub, screens, the bot game and the online
// hook played end to end against the real /api/cards handler.
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["BlotEngine", "BlotApp", "BlotTable", "BlotLocalGame", "BlotLobby", "BlotDealResult", "BlotGameOver", "BlotBidPanel", "useBlotRoom", "blotPredict", "blotLocalPlayers", "DurakEngine", "DurakApp", "DurakTable", "DurakResult", "DurakLocalGame", "DurakLobby", "useDurakRoom", "getCardsIdentity", "durakLocalPlayers", "loadHubSection", "HUB_SECTIONS", "SCREEN_COMPONENTS", ');
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

// ---------- fake Supabase REST + the real /api/cards ----------
const handler = require(ROOT + "/api/cards.js");
const E = require(ROOT + "/api/_lib/durak.js");
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
const rooms = {};
const apiCalls = [];
let apiDelay = 0, apiRefuse = false;
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function rest(url, init) {
  const path = url.match(/\/rest\/v1\/(.*)$/)[1];
  if (path.startsWith("rpc/moderate_display_name")) return json(200, JSON.parse(init.body).p_name);
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
    apiCalls.push(body);
    if (apiRefuse && body.action === "move") return new Promise((resolve) => setTimeout(() => resolve(json(409, { error: "illegal" })), apiDelay));
    return new Promise((resolve) => {
      const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve(json(this.code, o)); } };
      setTimeout(() => handler({ method: "POST", body }, res), apiDelay);
    });
  }
  return json(404, {});
};
// cards_view(), as the database function does it
function cardsView(args) {
  const row = rooms[args.p_code];
  if (!row || row.state.status === "closed") return { data: { error: "not_found" }, error: null };
  const seat = row.state.players.find((q) => q.id === args.p_player_id);
  if (!seat || seat.secretHash !== require("crypto").createHash("sha256").update(args.p_secret).digest("hex")) return { data: { error: "not_in_room" }, error: null };
  return { data: { ok: true, code: row.code, version: row.version, view: E.viewFor(row.state, args.p_player_id) }, error: null };
}
const rpcAny = (fn, args) => Promise.resolve(fn === "cards_view" ? cardsView(args) : { data: null, error: null });

const BE = require(ROOT + "/api/_lib/blot.js");
// Bots in the browser wait ~1 s between moves; run those waits fast here.
const realSetTimeout = global.setTimeout;
let fast = false;
global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, fast && ms >= 500 ? 1 : ms, ...rest);
(async () => {
  const block = (s, b, e) => s.slice(s.indexOf(b), s.indexOf(e));
  const serverBlock = block(fs.readFileSync(ROOT + "/api/_lib/blot.js", "utf8"), "/* BLOT-ENGINE-BEGIN */", "/* BLOT-ENGINE-END */");
  ok(serverBlock.length > 5000 && block(src, "/* BLOT-ENGINE-BEGIN */", "/* BLOT-ENGINE-END */") === serverBlock, "index.html carries an exact copy of api/_lib/blot.js");
  let env = load({ react: React, local: { ...RU } });
  let C = env.C;
  const t = (k) => C.t_lookup(k, "ru");

  /* hub */
  const page = html(React.createElement(load({ react: React, local: { ...RU, hatsit_hub_section_v1: "cards" } }).C.Hub, { state: { feedbackPending: null }, dispatch: noop }));
  ok(page.indexOf(">Блот<") > 0 && page.indexOf(">Блот<") < page.indexOf(">Дурак<"), "Карточные: Блот first, then Дурак");
  eq((page.match(/>НОВОЕ</g) || []).length, 4, "all four games in the tab (nardy and three card games) carry the NEW badge");
  eq(C.reducer(C.initialState, { type: "OPEN_BLOT" }).screen, "blot", "OPEN_BLOT opens Blot");
  ok(/blot: BlotApp,/.test(src) && /startParam\.match\(\/\^\(bunker\|court\|mafiaroom[^)]*\bblot\b[^)]*\)_\(\\d\{4\}\)\$\//.test(src), "screen routed; Telegram invite blot_1234 accepted");
  eq(C.reducer({ ...C.initialState, screen: "blot" }, { type: "GO_HUB" }).feedbackPending, "blot", "rating asked after Blot");

  /* menu + hooks stable across screens */
  {
    const rt = makeRuntime();
    let count = 0;
    const counted = {};
    for (const k of Object.keys(rt.hooks)) counted[k] = (...a) => { count++; return rt.hooks[k](...a); };
    const e = load({ react: { ...React, ...counted }, local: { ...RU } });
    const counts = [];
    rt.mount((props) => { count = 0; const r = e.C.BlotApp(props); counts.push(count); return r; }, { dispatch: noop });
    const text = (el) => (el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el) : Array.isArray(el) ? el.map(text).join("") : el.props ? text(el.props.children) : "");
    const find = (el, label) => {
      if (el == null || typeof el !== "object") return null;
      if (Array.isArray(el)) { for (const x of el) { const r = find(x, label); if (r) return r; } return null; }
      if (el.type === "button" && text(el).includes(label)) return el;
      return el.props ? find(el.props.children, label) : null;
    };
    const press = async (label) => { const b = find(rt.result, label); ok(!!b, "button " + label); if (b) b.props.onClick(); await wait(5); };
    ok(text(rt.result).includes("Армянский блот"), "Blot menu");
    await press("Играть с ботами");
    await press("Начать игру");
    await press && rt.unmount();
    ok(counts.length >= 3 && counts.every((c) => c === counts[0]), "BlotApp calls the same hooks on every screen: " + counts.join(","));
  }

  /* screens */
  let st = C.BlotEngine.newGame(C.blotLocalPlayers(t), { target: 101 });
  st.bidding.turn = 0; st.turn = 0;
  let pg = html(React.createElement(C.BlotTable, { view: C.BlotEngine.viewFor(st, "me"), meIndex: 0, onMove: noop }));
  ok(pg.includes(">Пас<") && pg.includes("♠") && pg.includes(">БК<") && pg.includes("Ваше слово"), "my turn to bid: suits, no trump, pass");
  eq((pg.match(/class="relative shrink-0 rounded-lg/g) || []).length, 8, "eight cards in my hand");
  ok(pg.includes(">Мы 0<") || pg.includes("Мы 0"), "score shown");
  // play phase
  let g = C.BlotEngine.newGame(C.blotLocalPlayers(t), {});
  for (let k = 0; k < 40 && g.phase === "bid"; k++) { const mv = C.BlotEngine.nextBotMove(g, () => true) || [g.bidding.turn, { type: "pass" }]; g = C.BlotEngine.apply(g, mv[0], mv[1]).state; }
  if (g.phase === "play") {
    g.turn = 0; g.trick = []; 
    pg = html(React.createElement(C.BlotTable, { view: C.BlotEngine.viewFor(g, "me"), meIndex: 0, onMove: noop }));
    ok(pg.includes("Ваш ход") && !/filter:brightness\(0\.5\)/.test(pg), "leading: every card playable");
    ok(pg.includes("Мы") && (pg.includes("×") || pg.includes(" · ")), "contract shown");
  }
  // a scored deal
  let sc = C.BlotEngine.newGame(C.blotLocalPlayers(t), {});
  let guard = 0;
  while (sc.phase !== "score" && guard++ < 400) { const mv = C.BlotEngine.nextBotMove(sc, () => true); sc = mv ? C.BlotEngine.apply(sc, mv[0], mv[1]).state : C.BlotEngine.timeout(sc).state; }
  pg = html(React.createElement(C.BlotTable, { view: C.BlotEngine.viewFor(sc, "me"), meIndex: 0, onMove: noop, onNext: noop }));
  // usually deal 1, but if everybody passed the cards are redealt
  ok(/Раздача \d+/.test(pg) && (pg.includes("Заявка сыграла") || pg.includes("Заявка не сыграла")) && pg.includes("Следующая раздача"), "deal result with the next-deal button");
  pg = html(React.createElement(C.BlotGameOver, { view: { ...sc, status: "ended", winner: 0, scores: [105, 40] }, meIndex: 0, onAgain: noop, onExit: noop }));
  ok(pg.includes("Мы выиграли!") && pg.includes("105 : 40"), "game over");

  /* the bot game plays itself between my moves */
  {
    fast = true;
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU } });
    const g0 = e.C.BlotEngine.newGame(e.C.blotLocalPlayers((k) => e.C.t_lookup(k, "ru")), { target: 101 });
    rt.mount((props) => e.C.BlotLocalGame(props), { initial: g0, onExit: noop, onAgain: noop });
    const tbl = () => rt.result.props.children[0].props;
    let steps = 0;
    while (steps++ < 9000) {
      const full = JSON.parse(e.ss.getItem("hatsit_blot_local_v1"));
      if (full.status !== "playing") break;
      if (full.phase === "score") { tbl().onNext(); await wait(2); continue; }
      const mine = e.C.BlotEngine.botMove(full, 0);
      if (mine) tbl().onMove(mine);
      await wait(2);
    }
    const end = JSON.parse(e.ss.getItem("hatsit_blot_local_v1"));
    eq(end.status, "ended", "a game to 101 against bots plays out on the phone (" + end.deals + " deals)");
    ok(end.scores[end.winner] >= 101, "the winner reached 101: " + end.scores.join(":"));
    rt.unmount();
    fast = false;
  }

  /* online: two phones + two bots */
  {
    const mk = (id) => {
      const rt = makeRuntime();
      const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU, hatsit_cards_identity_v1: JSON.stringify({ id, secret: "secret-secret-" + id }) }, rpcAny });
      rt.mount(e.C.useBlotRoom);
      return { rt, e, get room() { return rt.result; } };
    };
    const A = mk("c-alice1"), Bp = mk("c-boris2");
    await A.room.create("Аня", { target: 101 });
    await wait(5);
    const code = A.room.code;
    eq([rooms[code].state.game, rooms[code].state.settings.target], ["blot", 101], "Аня creates a Blot room");
    await Bp.room.join("Боря", code);
    await A.room.call("start");
    await wait(2700);
    eq([Bp.room.view.status, Bp.room.view.players.length, Bp.room.view.players.filter((q) => q.bot).length], ["playing", 4, 2], "start fills two seats with bots; Боря's phone sees the game");
    ok(Array.isArray(Bp.room.view.players[1].hand) && !Bp.room.view.players[0].hand, "only his own hand");
    let steps = 0, instant = 0;
    for (; steps < 3000 && rooms[code].state.status === "playing"; steps++) {
      const s2 = rooms[code].state;
      if (s2.phase === "score") { s2.deadline = Date.now() - 1; await A.room.call("tick"); continue; }
      const seat = s2.phase === "bid" ? s2.bidding.turn : s2.turn;
      const who = seat === 0 ? A : seat === 1 ? Bp : null;
      if (!who) { ok(false, "waiting on a bot " + seat); break; }
      await who.room.call("tick").catch(() => {}); // refresh this phone's view
      const mv = BE.botMove(s2, seat);
      if (mv.type === "play" && steps % 5 === 0) {
        apiDelay = 200;
        who.room.move(mv);
        await wait(5);
        const v = who.room.view;
        if (v && !v.players[seat].hand.includes(mv.card) && rooms[code].state.players[seat].hand.includes(mv.card)) instant++;
        await wait(260);
        apiDelay = 0;
      } else {
        const r = await who.room.call("move", { move: mv });
        if (!r || !r.ok) { ok(false, "move refused " + JSON.stringify(mv) + JSON.stringify(r)); break; }
      }
    }
    eq(rooms[code].state.status, "ended", "a whole online Blot game to 101 (" + steps + " steps)");
    ok(instant > 3, "played cards leave the hand at once (" + instant + " times)");
    A.rt.unmount(); Bp.rt.unmount();
  }
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
