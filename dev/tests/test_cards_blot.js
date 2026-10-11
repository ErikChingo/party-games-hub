const ROOT = require("path").resolve(__dirname, "../..");
// /api/cards with Blot, against an in-memory stand-in for Supabase's REST API.
const crypto = require("crypto");
const handler = require(ROOT + "/api/cards.js");
const E = require(ROOT + "/api/_lib/durak.js");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const rooms = {}; let failNextSave = 0; const requests = [];
global.fetch = async (url, init = {}) => {
  url = String(url); requests.push({ url, init });
  const m = url.match(/\/rest\/v1\/(.*)$/); const path = m[1];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (path.startsWith("rpc/moderate_display_name")) { const n = JSON.parse(init.body).p_name; return json(200, /сука/i.test(n) ? null : n); }
  if (path.startsWith("card_rooms")) {
    const q = new URLSearchParams(path.split("?")[1] || "");
    const code = (q.get("code") || "").replace("eq.", "");
    if (!init.method || init.method === "GET") return json(200, rooms[code] ? [JSON.parse(JSON.stringify(rooms[code]))] : []);
    if (init.method === "POST") { const b = JSON.parse(init.body); if (rooms[b.code]) return json(409, {}); rooms[b.code] = { code: b.code, state: b.state, version: 1, updated_at: new Date().toISOString() }; return json(201, null); }
    if (init.method === "PATCH") {
      const v = Number((q.get("version") || "").replace("eq.", ""));
      if (failNextSave > 0) { failNextSave--; rooms[code].version += 1; return json(200, []); } // someone else wrote first
      if (!rooms[code] || rooms[code].version !== v) return json(200, []);
      const b = JSON.parse(init.body); rooms[code] = { ...rooms[code], state: b.state, version: b.version, updated_at: b.updated_at }; return json(200, [rooms[code]]);
    }
  }
  return json(404, {});
};
function call(body, method = "POST") {
  return new Promise((resolve) => {
    const res = { headers: {}, code: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; resolve(this); } };
    handler({ method, body }, res);
  });
}
const S = (n) => "secret-secret-secret-" + n;
const B = require(ROOT + "/api/_lib/blot.js");
(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  let r = await call({ action: "create", game: "blot", playerId: "anon:a1", secret: S(1), name: "Аня", settings: { target: 201 } });
  ok(r.code === 200, "blot room created");
  const code = r.body.code;
  let st = rooms[code].state;
  eq([st.game, st.settings.target, st.status], ["blot", 201, "lobby"], "game and target stored");
  ok(requests.some((x) => x.init.method === "POST" && JSON.parse(x.init.body).game === "blot"), "the row is marked as a blot room");
  r = await call({ action: "settings", code, playerId: "anon:a1", secret: S(1), settings: { target: 999, open: true } });
  eq([rooms[code].state.settings.target, rooms[code].state.open], [201, true], "a bad target is ignored, open switch works");
  r = await call({ action: "settings", code, playerId: "anon:a1", secret: S(1), settings: { target: 301, open: true } });
  eq(rooms[code].state.settings.target, 301, "host changes the target");
  r = await call({ action: "join", code, playerId: "anon:b2", secret: S(2), name: "Боря" });
  r = await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  r = await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  eq(rooms[code].state.players.length, 4, "four seats");
  r = await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  eq([r.code, r.body.error], [409, "full"], "no fifth seat in Blot");
  r = await call({ action: "join", code, playerId: "anon:c3", secret: S(3), name: "Вика" });
  eq(r.body.error, "full", "a fifth person cannot join");
  r = await call({ action: "remove_bot", code, playerId: "anon:a1", secret: S(1) });
  r = await call({ action: "start", code, playerId: "anon:a1", secret: S(1) });
  st = rooms[code].state;
  ok(r.code === 200 && st.status === "playing" && st.players.length === 4 && st.players.filter((q) => q.bot).length === 2, "start fills the empty seat with a bot");
  ok(Array.isArray(r.body.view.players[0].hand) && !("hand" in r.body.view.players[1]), "own hand only");
  ok(["bid", "play"].includes(st.phase) && st.deadline > Date.now(), "bidding (or play) under way with a timer");
  // play the whole game: humans move like bots; score pauses are ticked through
  let steps = 0, deals = 0;
  for (; steps < 3000 && rooms[code].state.status === "playing"; steps++) {
    st = rooms[code].state;
    if (st.phase === "score") {
      ok(st.deadline - Date.now() <= 9000 + 50, "the score of a deal stays a few seconds");
      st.deadline = Date.now() - 1;
      deals++;
      await call({ action: "tick", code, playerId: "anon:b2", secret: S(2) });
      continue;
    }
    const seat = st.phase === "bid" ? st.bidding.turn : st.turn;
    const id = st.players[seat].id;
    if (st.players[seat].bot) { console.log("waiting on a bot?", st.phase, seat); break; }
    const mv = B.botMove(st, seat);
    const res = await call({ action: "move", code, playerId: id, secret: S(id === "anon:a1" ? 1 : 2), move: mv });
    if (res.code !== 200) { ok(false, "move refused " + JSON.stringify(mv) + " " + JSON.stringify(res.body)); break; }
  }
  st = rooms[code].state;
  eq(st.status, "ended", "a whole Blot game to 301 plays out through the function (" + deals + " deals, " + steps + " steps)");
  ok(st.winner !== null && st.scores[st.winner] >= 301, "the winner reached the target: " + st.scores.join(":"));
  r = await call({ action: "move", code, playerId: "anon:a1", secret: S(1), move: { type: "pass" } });
  eq(r.code, 409, "no moves after the end");
  r = await call({ action: "rematch", code, playerId: "anon:a1", secret: S(1) });
  ok(rooms[code].state.status === "playing" && rooms[code].state.scores.join() === "0,0" && rooms[code].state.settings.target === 301, "rematch: new game, same target");
  // a refused move, and idle players
  st = rooms[code].state;
  const humanTurn = () => { const s2 = rooms[code].state; const seat = s2.phase === "bid" ? s2.bidding.turn : s2.turn; return [0, 1].includes(seat) ? seat : null; };
  const seat = humanTurn();
  if (seat !== null) {
    const id = rooms[code].state.players[seat].id;
    r = await call({ action: "move", code, playerId: id, secret: S(seat + 1), move: { type: "play", card: "7Z" } });
    eq([r.code, r.body.error], [409, "illegal"], "an illegal move is refused");
    for (let k = 0; k < 2; k++) {
      const s2 = rooms[code].state; const t = s2.phase === "bid" ? s2.bidding.turn : s2.turn;
      if (t !== seat) break;
      s2.deadline = Date.now() - 1;
      await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) });
    }
  }
  // leaving mid-game hands the seat to a bot; the host moves on
  r = await call({ action: "leave", code, playerId: "anon:a1", secret: S(1) });
  st = rooms[code].state;
  ok(st.players[0].bot && st.players[0].left && st.hostId === "anon:b2", "the host leaves: a bot plays the seat, Боря hosts");
  // durak still works the same
  r = await call({ action: "create", playerId: "anon:z9", secret: S(9), name: "Зоя" });
  eq(rooms[r.body.code].state.game, "durak", "no game named -> Durak, as before");
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
