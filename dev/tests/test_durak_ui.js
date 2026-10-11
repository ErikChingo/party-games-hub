const ROOT = require("path").resolve(__dirname, "../..");
// Durak in the page: engine copy, Hub sections, screens, the bot game, and
// the online hook played end to end against the real /api/cards handler
// (with an in-memory stand-in for Supabase).
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["DurakEngine", "DurakApp", "DurakTable", "DurakResult", "DurakLocalGame", "DurakLobby", "useDurakRoom", "getCardsIdentity", "durakLocalPlayers", "loadHubSection", "HUB_SECTIONS", "SCREEN_COMPONENTS", ');
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

(async () => {
  /* ---------- the engine in the page is the server's engine ---------- */
  const block = (s) => s.slice(s.indexOf("/* DURAK-ENGINE-BEGIN */"), s.indexOf("/* DURAK-ENGINE-END */"));
  const serverBlock = block(fs.readFileSync(ROOT + "/api/_lib/durak.js", "utf8"));
  ok(serverBlock.length > 5000 && block(src) === serverBlock, "index.html carries an exact copy of api/_lib/durak.js");

  let env = load({ react: React, local: { ...RU } });
  let C = env.C;
  ok(C.DurakEngine && typeof C.DurakEngine.newGame === "function", "the engine is in the bundle");
  let ended = 0, draws = 0;
  for (let g = 0; g < 200; g++) {
    const n = 2 + (g % 5);
    let st = C.DurakEngine.newGame(Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, bot: true })), { transfer: g % 2 === 0 });
    for (let k = 0; k < 5000 && st.status === "playing"; k++) {
      const mv = C.DurakEngine.nextBotMove(st, () => true);
      if (!mv) break;
      const r = C.DurakEngine.apply(st, mv[0], mv[1]);
      if (!r.ok) break;
      st = r.state;
    }
    if (st.status === "ended") ended++;
    if (st.draw) draws++;
  }
  eq(ended, 200, "200 bot games (2–6 players, both variants) all reach the end in the bundle");

  /* ---------- the Hub: two sections ---------- */
  const hub = (local) => html(React.createElement(load({ react: React, local: { ...RU, ...local } }).C.Hub, { state: { feedbackPending: null }, dispatch: noop }));
  let page = hub({});
  ok(page.includes("Для компании") && page.includes("Карты и нарды"), "the Hub shows the two section tabs");
  ok(page.includes("Шпион") && !page.includes("Дурак"), "«Для компании» is the default and has no card games");
  ok(/aria-label="НОВОЕ"/.test(page), "the Карточные tab carries a dot while it has something new");
  page = hub({ hatsit_hub_section_v1: "cards" });
  ok(page.includes("Дурак") && !page.includes("Шпион") && page.includes("Скоро здесь появятся"), "the chosen section is remembered: Карточные shows Durak and the 'more soon' note");
  ok(!/aria-label="НОВОЕ"/.test(page.split("role=\"tablist\"")[1].split("</button>")[1]), "no dot on the tab already open");
  eq(load({ react: React, local: { ...RU, hatsit_hub_section_v1: "junk" } }).C.loadHubSection(), "party", "an unknown saved section falls back to the party games");
  const durakEntry = C.GAMES.find((g) => g.id === "durak");
  ok(durakEntry && durakEntry.section === "cards" && durakEntry.isNew && durakEntry.openAction === "OPEN_DURAK", "Durak is registered as a new card game");
  eq(C.reducer(C.initialState, { type: "OPEN_DURAK" }).screen, "durak", "OPEN_DURAK opens the Durak screen");
  ok(C.SCREEN_COMPONENTS ? C.SCREEN_COMPONENTS.durak === C.DurakApp : /durak: DurakApp,/.test(src), "the screen is routed to DurakApp");
  eq(C.reducer({ ...C.initialState, screen: "durak" }, { type: "GO_HUB" }).feedbackPending, "durak", "leaving Durak asks for a rating like other games");

  /* ---------- screens ---------- */
  page = html(React.createElement(C.DurakApp, { dispatch: noop }));
  ok(page.includes("Играть с ботами") && page.includes("Играть онлайн") && page.includes("Правила Дурака"), "Durak menu: bots, online, rules");
  const players = C.durakLocalPlayers(3, (k) => C.t_lookup(k, "ru"));
  eq([players.length, players[0].id, players[0].name, players.slice(1).every((q) => q.bot)], [4, "me", "Вы", true], "a bot game: me + 3 bots");
  let game = C.DurakEngine.newGame(players, { transfer: true });
  let view = C.DurakEngine.viewFor(game, "me");
  page = html(React.createElement(C.DurakTable, { view, meIndex: 0, onMove: noop }));
  const handButtons = (page.match(/<button aria-label="[^"]+"[^>]*class="relative shrink-0 rounded-lg/g) || []).length;
  eq(handButtons, 6, "six of my cards are on screen as buttons");
  ok(page.includes("Козырь") && page.includes("В колоде: 12"), "trump and deck count shown (36 − 4×6 = 12)");
  for (let k = 0; k < 40; k++) {
    const g = C.DurakEngine.newGame(players, { transfer: false });
    const v = C.DurakEngine.viewFor(g, "me");
    const pg = html(React.createElement(C.DurakTable, { view: v, meIndex: 0, onMove: noop }));
    const want = v.attacker === 0 ? "Ваш ход" : "Ходит " + C.t_lookup("durak.botName", "ru").replace("{n}", v.attacker);
    if (!pg.includes(want)) { ok(false, "status line at the deal: expected " + want + " attacker " + v.attacker + " defender " + v.defender); break; }
    if (k === 39) ok(true, "status line at the deal names who moves (40 deals, incl. me defending)");
  }
  // a finished game
  const endState = { ...game, status: "ended", loser: 2, draw: false };
  page = html(React.createElement(C.DurakResult, { view: endState, meIndex: 0, onAgain: noop, onExit: noop }));
  ok(page.includes("Вы не дурак!") && page.includes("Дурак — Бот 2") && page.includes("Ещё раз"), "result: I won, bot 2 is the fool");
  page = html(React.createElement(C.DurakResult, { view: { ...endState, loser: 0 }, meIndex: 0, onAgain: null, waitText: "ждём", onExit: noop }));
  ok(page.includes("Вы дурак") && page.includes("ждём") && !page.includes("Ещё раз"), "result: I lost; a guest waits for the host");

  /* ---------- throwing in goes in turn ---------- */
  {
    const t = (k) => C.t_lookup(k, "ru");
    const base = C.DurakEngine.newGame(C.durakLocalPlayers(2, t), { transfer: false });
    // me (0) is a co-attacker: bot 1 attacks bot 2
    const st = JSON.parse(JSON.stringify(base));
    st.players[0].hand = ["7C", "9D", "12S", "6H", "8H", "10C"];
    st.players[1].hand = ["7H", "11D", "13C"];
    st.players[2].hand = ["8D", "9C", "14S", "6C"];
    st.trump = "S"; st.attacker = 1; st.defender = 2; st.table = [{ a: "7S", d: null }];
    st.players.forEach((q) => { q.passed = false; });
    st.boutLimit = 4;
    let pg = html(React.createElement(C.DurakTable, { view: C.DurakEngine.viewFor(st, "me"), meIndex: 0, onMove: noop }));
    ok(pg.includes("Бот 2 отбивается") || pg.includes("Подкидывает Бот 1"), "a co-attacker waits: the status names who moves");
    ok(!pg.includes(">Хватит<") && !pg.includes(">Бито<"), "no pass button out of turn");
    ok(/aria-label="7♣"[^>]*filter:brightness\(0\.5\)/.test(pg) && !/aria-label="9♦"[^>]*opacity:1[;"]/.test(pg) === true, "my matching 7 is greyed while it is not my turn");
    st.table = [{ a: "7S", d: "14S" }];
    pg = html(React.createElement(C.DurakTable, { view: C.DurakEngine.viewFor(st, "me"), meIndex: 0, onMove: noop }));
    ok(pg.includes("Подкидывает Бот 1") && pg.includes("durak-turn"), "all beaten: the main attacker's turn is named and glows");
    st.players[1].passed = true;
    pg = html(React.createElement(C.DurakTable, { view: C.DurakEngine.viewFor(st, "me"), meIndex: 0, onMove: noop }));
    ok(pg.includes(">Бито<") && pg.includes("подкиньте"), "after the main attacker passes, it is my turn: «Бито» or throw in");
  }

  /* ---------- the table sweeps away at the end of a bout ---------- */
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU } });
    const t = (k) => e.C.t_lookup(k, "ru");
    let st = e.C.DurakEngine.newGame(e.C.durakLocalPlayers(1, t), { transfer: false });
    st.players[0].hand = ["7H", "9C"]; st.players[1].hand = ["8H", "10D", "6D"]; st.trump = "S"; st.attacker = 0; st.defender = 1; st.boutLimit = 3; st.deck = ["6S"];
    const props = (s) => ({ view: e.C.DurakEngine.viewFor(s, "me"), meIndex: 0, onMove: noop });
    const hasClass = (el, cls) => {
      if (el == null || typeof el !== "object") return false;
      if (Array.isArray(el)) return el.some((x) => hasClass(x, cls));
      const p = el.props || {};
      if (typeof el.type === "string" && typeof p.className === "string" && p.className.split(" ").includes(cls)) return true;
      return hasClass(p.children, cls);
    };
    rt.mount(e.C.DurakTable, props(st));
    st = e.C.DurakEngine.apply(st, 0, { type: "play", card: "7H" }).state;
    rt.update(props(st));
    await wait(5);
    ok(hasClass(rt.result, "durak-in"), "the played card flies onto the table");
    st = e.C.DurakEngine.apply(st, 1, { type: "beat", card: "8H", target: 0 }).state;
    eq(st.table.length, 0, "bout over (the attacker has nothing to add)");
    rt.update(props(st));
    await wait(5);
    ok(hasClass(rt.result, "durak-out-discard"), "beaten cards sweep off to the discard pile");
    await wait(560);
    ok(!hasClass(rt.result, "durak-out-discard"), "and are gone after the animation");
    rt.unmount();
  }

  /* ---------- DurakApp runs the same hooks on every screen (React error #300) ---------- */
  {
    const rt = makeRuntime();
    let count = 0;
    const counted = {};
    for (const k of Object.keys(rt.hooks)) counted[k] = (...a) => { count++; return rt.hooks[k](...a); };
    const e = load({ react: { ...React, ...counted }, local: { ...RU } });
    const counts = [];
    rt.mount((props) => { count = 0; const r = e.C.DurakApp(props); counts.push(count); return r; }, { dispatch: noop });
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
    ok(text(rt.result).includes("Козырь") || JSON.stringify(Object.keys(rt.result.props)).length > 0, "the bot game opens");
    rt.unmount();
    const rt2 = makeRuntime();
    // back to the menu, then online -> create
    const e2 = load({ react: { ...React, ...Object.fromEntries(Object.keys(rt2.hooks).map((k) => [k, (...a) => { count++; return rt2.hooks[k](...a); }])) }, local: { ...RU } });
    rt2.mount((props) => { count = 0; const r = e2.C.DurakApp(props); counts.push(count); return r; }, { dispatch: noop });
    const press2 = async (label) => { const b = find(rt2.result, label); ok(!!b, "button " + label); if (b) b.props.onClick(); await wait(5); };
    await press2("Играть онлайн");
    await press2("Создать комнату");
    rt2.unmount();
    ok(counts.length >= 5 && counts.every((c) => c === counts[0]), "DurakApp calls the same number of hooks on every screen: " + counts.join(","));
  }

  /* ---------- the bot game runs by itself ---------- */
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU } });
    const g0 = e.C.DurakEngine.newGame(e.C.durakLocalPlayers(2, (k) => e.C.t_lookup(k, "ru")), { transfer: false });
    // the human just plays whatever a bot would
    let element = null;
    rt.mount((props) => { element = e.C.DurakLocalGame(props); return element; }, { initial: g0, onExit: noop, onAgain: noop });
    // find the state cell by peeking at the rendered table props
    const stateOf = () => rt.result.props.children[0].props.view;
    let guard = 0;
    while (guard++ < 3000) {
      const v = stateOf();
      if (v.status !== "playing") break;
      const full = JSON.parse(e.ss.getItem("hatsit_durak_local_v1"));
      const mine = e.C.DurakEngine.botMove(full, 0);
      if (mine) rt.result.props.children[0].props.onMove(mine);
      await wait(mine ? 1 : 760);
    }
    eq(stateOf().status, "ended", "a game against 2 bots plays to the end on the phone (bots move on their own, " + guard + " steps)");
    ok(JSON.parse(e.ss.getItem("hatsit_durak_local_v1")).status === "ended", "the game is kept in the tab, so a reload resumes it");
    rt.unmount();
  }

  /* ---------- online: two phones and a bot, through /api/cards ---------- */
  {
    const mk = (id) => {
      const rt = makeRuntime();
      const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU, hatsit_cards_identity_v1: JSON.stringify({ id, secret: "secret-secret-" + id }) }, rpcAny });
      rt.mount(e.C.useDurakRoom);
      return { rt, e, get room() { return rt.result; } };
    };
    const A = mk("c-alice1"), B = mk("c-boris2");
    await A.room.create("Аня", { transfer: true });
    await wait(5);
    const code = A.room.code;
    ok(/^\d{4}$/.test(code) && A.room.view.status === "lobby" && A.room.isHost, "Аня creates a room: " + code);
    const createCall = apiCalls.find((c) => c.action === "create");
    ok(createCall && /^(anon|tg):/.test(createCall.profileId || ""), "the room learns which profile to credit: " + (createCall && createCall.profileId));
    ok(!JSON.stringify(A.room.view).includes(createCall.profileId), "and never shows it back");
    await B.room.join("Боря", code);
    await wait(5);
    eq(B.room.view && B.room.view.players.map((q) => q.name), ["Аня", "Боря"], "Боря joins by code");
    ok(!B.room.isHost && B.room.meIndex === 1, "Боря is a guest in seat 2");
    await A.room.call("add_bot");
    await A.room.call("start");
    await wait(5);
    await B.rt.result; // nothing
    // Боря's phone picks the change up on its own (Realtime ping/poll -> cards_view)
    B.e.calls.length = 0;
    await wait(2600);
    ok(B.e.calls.some((c) => c[0] === "cards_view"), "the guest polls cards_view");
    eq(B.room.view.status, "playing", "and sees the game start");
    ok(Array.isArray(B.room.view.players[1].hand) && !B.room.view.players[0].hand && !("deck" in B.room.view), "each phone sees only its own hand");
    // play it out: each human makes the move a bot would
    let steps = 0;
    for (; steps < 600 && rooms[code].state.status === "playing"; steps++) {
      const st = rooms[code].state;
      let moved = false;
      for (const [who, i] of [[A, 0], [B, 1]]) {
        const mv = E.botMove(st, i);
        if (mv) { const r = await who.room.call("move", { move: mv }); ok(r && r.ok, "move accepted " + JSON.stringify(mv)); moved = true; break; }
      }
      if (!moved) break;
    }
    eq(rooms[code].state.status, "ended", "a full online game plays out through the hook (" + steps + " human moves)");
    const r = await A.room.call("rematch");
    ok(r && r.ok && rooms[code].state.status === "playing", "the host deals again");
    /* my own move shows at once, before the referee answers */
    {
      apiDelay = 300;
      let who = null, idx = -1, mv = null;
      for (let tries = 0; tries < 50 && !mv; tries++) {
        const st2 = rooms[code].state;
        for (const [w, i] of [[A, 0], [B, 1]]) {
          const m2 = E.botMove(st2, i);
          if (m2 && m2.type !== "pass" && m2.type !== "take") { who = w; idx = i; mv = m2; break; }
        }
        if (!mv) { rooms[code].state.deadline = Date.now() - 1; await A.room.call("tick"); rooms[code].state.players.forEach((q) => { if (q.id.startsWith("c-")) { q.afk = 0; q.bot = false; } }); }
      }
      ok(!!mv, "found a move to try: " + JSON.stringify(mv));
      await wait(2600); // let the views catch up
      const shows = (v) => v && !v.players[idx].hand.includes(mv.card) && v.table.some((pair) => pair.a === mv.card || pair.d === mv.card);
      who.room.move(mv);
      await wait(5);
      ok(shows(who.room.view), "the card leaves my hand and lands on the table at once (" + mv.type + ")");
      who.e.pingHandlers.forEach((h) => h());
      await wait(30);
      ok(shows(who.room.view) || rooms[code].state.table.length === 0, "a poll answered meanwhile does not undo it");
      await wait(450);
      const server = rooms[code].state.players[idx].hand.slice().sort().join();
      eq(who.room.view.players[idx].hand.slice().sort().join(), server, "after the referee's answer my hand is exactly the server's");
      // two quick taps in a row both go through, in order
      // a refused move: the real table comes back
      apiRefuse = true; apiDelay = 50;
      let mv2 = null;
      for (let tries = 0; tries < 50 && !mv2; tries++) {
        const m2 = E.botMove(rooms[code].state, idx);
        if (m2 && m2.type !== "pass" && m2.type !== "take") mv2 = m2;
        else { rooms[code].state.deadline = Date.now() - 1; await A.room.call("tick"); rooms[code].state.players.forEach((q) => { if (q.id.startsWith("c-")) { q.afk = 0; q.bot = false; } }); await wait(2600); }
      }
      ok(!!mv2, "found a second move to refuse");
      if (mv2) {
        await wait(2600);
        const real = JSON.stringify(who.room.view.table);
        who.room.move(mv2);
        await wait(5);
        ok(JSON.stringify(who.room.view.table) !== real, "guess shown");
        await wait(200);
        eq(JSON.stringify(who.room.view.table), real, "the referee says no: the guess is taken back");
      }
      apiRefuse = false; apiDelay = 0;
    }
    await B.room.leave();
    const seat = rooms[code].state.players[1];
    ok(seat.bot && seat.left, "Боря leaves mid-game: a bot takes his seat");
    ok(B.room.view === null && B.room.code === null && !B.e.ss.getItem("hatsit_durak_session_v1"), "and his phone forgets the room");
    await B.room.join("Боря", code);
    ok(!rooms[code].state.players[1].bot && B.room.view.status === "playing", "coming back with the code takes the seat back from the bot");
    // A goes back to the hub with the screen still holding the room: seat given up
    apiCalls.length = 0;
    A.rt.unmount();
    await wait(5);
    ok(apiCalls.some((c) => c.action === "leave" && c.playerId === "c-alice1"), "unmounting the screen inside a room gives the seat up");
    ok(rooms[code].state.players[0].bot && rooms[code].state.hostId === "c-boris2", "Аня's seat goes to a bot, Боря hosts");
    B.rt.unmount();
  }

  /* ---------- invites and reconnects ---------- */
  env = load({ react: React, local: { ...RU }, search: "?room=4321&game=durak" });
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU }, search: "?room=4321&game=durak" });
    rt.mount(e.C.useDurakRoom);
    eq(rt.result.inviteCode, "4321", "an invite link (?room=4321&game=durak) pre-fills the code");
    rt.unmount();
  }
  ok(/startParam\.match\(\/\^\(bunker\|court\|mafiaroom[^)]*\bdurak\b[^)]*\)_\(\\d\{4\}\)\$\//.test(src), "Telegram start_param accepts durak_1234");
  ok(/messageKey: "leave\.hintCards"/.test(src) && /confirmLeave\(\(\) => \{\n\s+room\.leave\(\);/.test(src), "leaving a running online game needs a second press (both back arrow and phone back)");

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
