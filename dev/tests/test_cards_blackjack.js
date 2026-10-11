const ROOT = require("path").resolve(__dirname, "../..");
// /api/cards with Blackjack, against an in-memory stand-in for Supabase's REST API.
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
const J = require(ROOT + "/api/_lib/blackjack.js");
(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  let r = await call({ action: "create", game: "blackjack", playerId: "anon:a1", secret: S(1), name: "Аня" });
  const code = r.body.code;
  eq([rooms[code].state.game, rooms[code].state.status], ["blackjack", "lobby"], "blackjack table created");
  await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  r = await call({ action: "start", code, playerId: "anon:a1", secret: S(1) });
  let st = rooms[code].state;
  ok(r.code === 200 && st.status === "playing" && st.phase === "bet", "one person and a bot can start");
  ok(st.players[1].bet > 0 && st.players[0].bet === 0, "the bot has bet; Аня's turn to bet");
  ok(!("deck" in r.body.view) && !("secret" in r.body.view), "the shoe never leaves the server");
  r = await call({ action: "move", code, playerId: "anon:a1", secret: S(1), move: { type: "bet", amount: 100 } });
  st = rooms[code].state;
  ok(["turns", "score"].includes(st.phase), "after the last bet the cards are dealt");
  if (st.phase === "turns") ok(!("secret" in r.body.view) && r.body.view.dealer.cards.length === 1, "the dealer's second card stays hidden");
  // someone sits down mid-game
  r = await call({ action: "join", code, playerId: "anon:b2", secret: S(2), name: "Боря" });
  st = rooms[code].state;
  eq([r.code, st.players.length, st.players[2].chips, st.players[2].bet], [200, 3, 1000, 0], "Боря sits down at a running table with 1000 chips");
  // play rounds
  let rounds = 0;
  for (let step = 0; step < 400 && rounds < 8; step++) {
    st = rooms[code].state;
    if (st.phase === "score") { rounds++; st.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:b2", secret: S(2) }); continue; }
    let moved = false;
    for (const [id, n, seat] of [["anon:a1", 1, 0], ["anon:b2", 2, 2]]) {
      const mv = J.botMove(st, seat);
      if (mv) { const res = await call({ action: "move", code, playerId: id, secret: S(n), move: mv }); ok(res.code === 200, "move " + JSON.stringify(mv)); moved = true; break; }
    }
    if (!moved) { st.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); }
  }
  ok(rounds >= 8, "eight rounds played through the function");
  st = rooms[code].state;
  ok(st.players.every((q) => q.chips >= 0), "chips never negative: " + st.players.map((q) => q.chips).join(","));
  // idle at the betting stage: sits out, then a bot takes over
  for (let k = 0; k < 3; k++) {
    st = rooms[code].state;
    if (st.phase === "score") { st.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); st = rooms[code].state; }
    if (st.phase === "bet") { st.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); }
    st = rooms[code].state;
    while (st.phase === "turns") { st.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); st = rooms[code].state; }
  }
  ok(rooms[code].state.players[0].bot && rooms[code].state.players[2].bot, "asleep twice: bots take the seats");
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
