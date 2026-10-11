const ROOT = require("path").resolve(__dirname, "../..");
// Blackjack in the page: engine copy, Hub, screens, the bot game and the online
// hook played end to end against the real /api/cards handler.
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["BlackjackEngine", "BlackjackApp", "BlackjackTable", "BlackjackLocalGame", "BlackjackLobby", "useBlackjackRoom", "blackjackPredict", "blackjackLocalPlayers", "BlotEngine", "BlotApp", "BlotTable", "BlotLocalGame", "BlotLobby", "BlotDealResult", "BlotGameOver", "BlotBidPanel", "useBlotRoom", "blotPredict", "blotLocalPlayers", "DurakEngine", "DurakApp", "DurakTable", "DurakResult", "DurakLocalGame", "DurakLobby", "useDurakRoom", "getCardsIdentity", "durakLocalPlayers", "loadHubSection", "HUB_SECTIONS", "SCREEN_COMPONENTS", ');
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

const BJ = require(ROOT + "/api/_lib/blackjack.js");
// Bots in the browser wait ~1 s between moves; run those waits fast here.
const realSetTimeout = global.setTimeout;
let fast = false;
global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, fast && ms >= 500 ? 1 : ms, ...rest);
(async () => {
  const block = (s, b, e) => s.slice(s.indexOf(b), s.indexOf(e));
  const B0 = "/* BLACKJACK-ENGINE-BEGIN */", E0 = "/* BLACKJACK-ENGINE-END */";
  const serverBlock = block(fs.readFileSync(ROOT + "/api/_lib/blackjack.js", "utf8"), B0, E0);
  ok(serverBlock.length > 5000 && block(src, B0, E0) === serverBlock, "index.html carries an exact copy of api/_lib/blackjack.js");
  let env = load({ react: React, local: { ...RU } });
  let C = env.C;
  const t = (k) => C.t_lookup(k, "ru");
  const page = html(React.createElement(load({ react: React, local: { ...RU, hatsit_hub_section_v1: "cards" } }).C.Hub, { state: { feedbackPending: null }, dispatch: noop }));
  const at = (x) => page.indexOf(">" + x + "<");
  ok(at("Блот") > 0 && at("Блот") < at("Блэкджек") && at("Блэкджек") < at("Дурак"), "Карточные: Блот, Блэкджек, Дурак");
  eq(C.reducer(C.initialState, { type: "OPEN_BLACKJACK" }).screen, "blackjack", "OPEN_BLACKJACK");
  ok(/blackjack: BlackjackApp,/.test(src) && /\|blackjack(\|[a-z]+)*\)_\(/.test(src), "screen routed; Telegram invite accepted");

  /* hooks stable */
  {
    const rt = makeRuntime();
    let count = 0;
    const counted = {};
    for (const k of Object.keys(rt.hooks)) counted[k] = (...a) => { count++; return rt.hooks[k](...a); };
    const e = load({ react: { ...React, ...counted }, local: { ...RU } });
    const counts = [];
    rt.mount((props) => { count = 0; const r = e.C.BlackjackApp(props); counts.push(count); return r; }, { dispatch: noop });
    const text = (el) => (el == null || typeof el === "boolean" ? "" : typeof el === "string" || typeof el === "number" ? String(el) : Array.isArray(el) ? el.map(text).join("") : el.props ? text(el.props.children) : "");
    const find = (el, label) => {
      if (el == null || typeof el !== "object") return null;
      if (Array.isArray(el)) { for (const x of el) { const r = find(x, label); if (r) return r; } return null; }
      if (el.type === "button" && text(el).includes(label)) return el;
      return el.props ? find(el.props.children, label) : null;
    };
    const press = async (label) => { const b = find(rt.result, label); ok(!!b, "button " + label); if (b) b.props.onClick(); await wait(5); };
    await press("Играть с ботами");
    await press("Начать игру");
    rt.unmount();
    ok(counts.length >= 3 && counts.every((c) => c === counts[0]), "BlackjackApp calls the same hooks on every screen: " + counts.join(","));
  }

  /* screens */
  let st = C.BlackjackEngine.newGame(C.blackjackLocalPlayers(t, 2), {});
  let pg = html(React.createElement(C.BlackjackTable, { view: C.BlackjackEngine.viewFor(st, "me"), meIndex: 0, onMove: noop }));
  ok(pg.includes("Выберите ставку") && pg.includes("Поставить 50") && pg.includes(">500<"), "betting: chips and the bet button");
  st = C.BlackjackEngine.apply(st, 0, { type: "bet", amount: 100 }).state;
  st = C.BlackjackEngine.apply(st, 1, { type: "bet", amount: 50 }).state;
  st = C.BlackjackEngine.apply(st, 2, { type: "bet", amount: 50 }).state;
  if (st.phase === "turns" && st.turn === 0) {
    pg = html(React.createElement(C.BlackjackTable, { view: C.BlackjackEngine.viewFor(st, "me"), meIndex: 0, onMove: noop }));
    ok(pg.includes(">Ещё<") && pg.includes(">Хватит<") && pg.includes(">Удвоить<") && pg.includes("+?"), "my turn: hit / stand / double; dealer's second card hidden");
  }
  let g = st; let guard = 0;
  while (g.phase !== "score" && guard++ < 50) { const mv = C.BlackjackEngine.nextBotMove(g, () => true); g = mv ? C.BlackjackEngine.apply(g, mv[0], mv[1]).state : C.BlackjackEngine.timeout(g).state; }
  pg = html(React.createElement(C.BlackjackTable, { view: C.BlackjackEngine.viewFor(g, "me"), meIndex: 0, onMove: noop, onNext: noop }));
  ok(pg.includes("Следующая раздача") && /(Выигрыш|Проигрыш|Ничья|Перебор|Блэкджек!)/.test(pg), "round result and next button");

  /* bot table on the phone */
  {
    fast = true;
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU } });
    const g0 = e.C.BlackjackEngine.newGame(e.C.blackjackLocalPlayers((k) => e.C.t_lookup(k, "ru"), 3), {});
    rt.mount((props) => e.C.BlackjackLocalGame(props), { initial: g0 });
    const tbl = () => rt.result.props.children.props;
    let rounds = 0, steps = 0;
    while (steps++ < 3000 && rounds < 10) {
      const full = JSON.parse(e.ss.getItem("hatsit_blackjack_local_v1"));
      if (full.phase === "score") { rounds++; tbl().onNext(); await wait(2); continue; }
      const mine = e.C.BlackjackEngine.botMove(full, 0);
      if (mine) tbl().onMove(mine);
      await wait(2);
    }
    ok(rounds >= 10, "ten rounds with three bots on the phone (" + steps + " steps)");
    rt.unmount();
    fast = false;
  }

  /* online table */
  {
    const mk = (id) => {
      const rt = makeRuntime();
      const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU, hatsit_cards_identity_v1: JSON.stringify({ id, secret: "secret-secret-" + id }) }, rpcAny });
      rt.mount(e.C.useBlackjackRoom);
      return { rt, e, get room() { return rt.result; } };
    };
    const A = mk("c-alice1"), Bp = mk("c-boris2"), V = mk("c-vika33");
    await A.room.create("Аня", {});
    await wait(5);
    const code = A.room.code;
    eq(rooms[code].state.game, "blackjack", "Аня opens a table");
    await Bp.room.join("Боря", code);
    await A.room.call("start");
    await wait(2700);
    eq(Bp.room.view.phase, "bet", "Боря sees the betting");
    apiDelay = 200;
    A.room.move({ type: "bet", amount: 100 });
    await wait(5);
    ok(A.room.view.players[0].bet === 100 && rooms[code].state.players[0].bet === 0, "my bet shows at once, before the server has it");
    await wait(300);
    apiDelay = 0;
    eq(rooms[code].state.players[0].bet, 100, "and the server took it");
    ok(!("secret" in A.room.view) && !("deck" in A.room.view), "the shoe and the hidden card never reach a phone");
    await V.room.join("Вика", code);
    ok(V.room.view && V.room.view.status === "playing" && V.room.view.players.length === 3, "Вика sits down at the running table");
    let rounds = 0;
    for (let step = 0; step < 600 && rounds < 6; step++) {
      const s2 = rooms[code].state;
      if (s2.phase === "score") { rounds++; s2.deadline = Date.now() - 1; await A.room.call("tick"); continue; }
      let moved = false;
      for (const [who, seat] of [[A, 0], [Bp, 1], [V, 2]]) {
        const mv = BJ.botMove(s2, seat);
        if (mv) { const r = await who.room.call("move", { move: mv }); ok(r && r.ok, "move " + JSON.stringify(mv)); moved = true; break; }
      }
      if (!moved) { s2.deadline = Date.now() - 1; await A.room.call("tick"); }
    }
    ok(rounds >= 6, "six online rounds with three phones");
    A.rt.unmount(); Bp.rt.unmount(); V.rt.unmount();
  }
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
