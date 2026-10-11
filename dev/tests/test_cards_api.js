const ROOT = require("path").resolve(__dirname, "../..");
// /api/cards against an in-memory stand-in for Supabase's REST API.
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
(async () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SECRET_KEY;
  let r = await call({ action: "create", playerId: "anon:a1", secret: S(1), name: "Аня" });
  eq([r.code, r.body.error], [500, "cards are not configured"], "without the service key the function says so");
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  eq((await call({}, "GET")).code, 405, "GET refused");
  eq((await call({ action: "create", playerId: "x", secret: S(1) })).code, 400, "bad player id refused");
  eq((await call({ action: "create", playerId: "anon:a1", secret: "short" })).code, 400, "short secret refused");

  r = await call({ action: "create", playerId: "anon:a1", secret: S(1), name: "Аня", settings: { transfer: true } });
  ok(r.code === 200 && /^\d{4}$/.test(r.body.code), "room created: " + r.body.code);
  const code = r.body.code;
  const stored = rooms[code].state;
  ok(stored.players[0].secretHash === crypto.createHash("sha256").update(S(1)).digest("hex") && !("secretHash" in r.body.view.players[0]), "secret stored as a hash, never sent back");
  eq([stored.status, stored.hostId, stored.settings.transfer], ["lobby", "anon:a1", true], "lobby with settings");
  ok(requests.every((x) => x.init.headers.Authorization === "Bearer svc"), "the service key is used for every storage call");

  r = await call({ action: "join", code, playerId: "anon:b2", secret: S(2), name: "сука" });
  eq([r.code, rooms[code].state.players[1].name], [200, ""], "a rude name is dropped");
  r = await call({ action: "join", code, playerId: "anon:b2", secret: S(9), name: "Боря" });
  eq(r.code, 403, "someone else cannot take a seat by its id");
  r = await call({ action: "start", code, playerId: "anon:b2", secret: S(2) });
  eq([r.code, r.body.error], [409, "forbidden"], "only the host starts");
  r = await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  r = await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  eq(rooms[code].state.players.map((q) => q.bot), [false, false, true, true], "host adds bots");
  r = await call({ action: "remove_bot", code, playerId: "anon:a1", secret: S(1) });
  eq(rooms[code].state.players.length, 3, "and removes one");
  r = await call({ action: "settings", code, playerId: "anon:a1", secret: S(1), settings: { transfer: false, open: true } });
  eq([rooms[code].state.settings.transfer, rooms[code].state.open], [false, true], "host changes settings");

  r = await call({ action: "start", code, playerId: "anon:a1", secret: S(1) });
  let st = rooms[code].state;
  ok(r.code === 200 && st.status === "playing" && st.players.length === 3, "game started");
  ok(st.deadline > Date.now() + 20000, "a move timer is running");
  ok(Array.isArray(r.body.view.players[0].hand) && !("hand" in r.body.view.players[1]) && !("deck" in r.body.view), "the host sees only their own cards");
  ok(st.hostId === "anon:a1", "host kept after dealing");
  // whoever must act now, if it is a human, makes a legal move; bots answered by themselves
  for (let k = 0; k < 400 && rooms[code].state.status === "playing"; k++) {
    st = rooms[code].state;
    const humans = [0, 1];
    let done = false;
    for (const i of humans) {
      const mv = E.botMove(st, i);
      if (mv) { const res = await call({ action: "move", code, playerId: st.players[i].id, secret: S(i + 1), move: mv }); ok(res.code === 200, "legal human move accepted " + JSON.stringify(mv) + " " + JSON.stringify(res.body)); done = true; break; }
    }
    if (!done) { const t = rooms[code].state; t.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); }
  }
  eq(rooms[code].state.status, "ended", "a whole game plays out through the function (humans + bot)");
  r = await call({ action: "move", code, playerId: "anon:a1", secret: S(1), move: { type: "pass" } });
  eq(r.code, 409, "no moves after the end");

  // rematch, illegal move, tick before time, afk -> bot
  r = await call({ action: "rematch", code, playerId: "anon:a1", secret: S(1) });
  eq(rooms[code].state.status, "playing", "rematch deals again");
  st = rooms[code].state;
  const someone = st.players.findIndex((q, i) => !q.bot && i !== st.attacker);
  r = await call({ action: "move", code, playerId: st.players[someone].id, secret: S(someone + 1), move: { type: "play", card: st.players[someone].hand[0] } });
  ok(r.code === 409 && r.body.error === "illegal" || st.table.length > 0, "illegal move refused");
  const v0 = rooms[code].version;
  r = await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) });
  eq(rooms[code].version, v0, "a tick before the deadline changes nothing");
  // make a human the attacker and let them sleep twice
  for (let k = 0; k < 2; k++) {
    st = rooms[code].state; st.deadline = Date.now() - 1;
    await call({ action: "tick", code, playerId: "anon:b2", secret: S(2) });
  }
  ok(rooms[code].state.players.some((q) => q.afk >= 1) || rooms[code].state.status !== "playing", "sleeping players are counted");

  // leaving mid-game: a bot takes the seat, the host moves on
  const code2 = (await call({ action: "create", playerId: "anon:c3", secret: S(3), name: "Вика" })).body.code;
  await call({ action: "join", code: code2, playerId: "anon:d4", secret: S(4), name: "Гоша" });
  await call({ action: "join", code: code2, playerId: "anon:e5", secret: S(5), name: "Даша" });
  await call({ action: "start", code: code2, playerId: "anon:c3", secret: S(3) });
  r = await call({ action: "leave", code: code2, playerId: "anon:c3", secret: S(3) });
  st = rooms[code2].state;
  ok(st.players[0].bot && st.players[0].left && st.hostId === "anon:d4" && st.status === "playing", "host leaves mid-game: a bot plays the hand, the next human hosts");
  r = await call({ action: "join", code: code2, playerId: "anon:c3", secret: S(3), name: "Вика" });
  ok(!rooms[code2].state.players[0].bot && r.code === 200, "coming back takes the seat back from the bot");
  r = await call({ action: "join", code: code2, playerId: "anon:z9", secret: S(9), name: "Чужой" });
  eq(r.body.error, "in_progress", "strangers cannot join a running game");
  await call({ action: "leave", code: code2, playerId: "anon:c3", secret: S(3) });
  await call({ action: "leave", code: code2, playerId: "anon:d4", secret: S(4) });
  await call({ action: "leave", code: code2, playerId: "anon:e5", secret: S(5) });
  eq(rooms[code2].state.status, "closed", "a room with no humans left is closed");
  eq((await call({ action: "join", code: code2, playerId: "anon:c3", secret: S(3) })).code, 404, "a closed room cannot be joined");

  // lobby leave and full room
  const code3 = (await call({ action: "create", playerId: "anon:f6", secret: S(6), name: "Хост" })).body.code;
  for (let i = 0; i < 5; i++) await call({ action: "add_bot", code: code3, playerId: "anon:f6", secret: S(6) });
  eq((await call({ action: "join", code: code3, playerId: "anon:g7", secret: S(7), name: "Лишний" })).body.error, "full", "six seats at most");
  await call({ action: "remove_bot", code: code3, playerId: "anon:f6", secret: S(6) });
  await call({ action: "join", code: code3, playerId: "anon:g7", secret: S(7), name: "Гость" });
  await call({ action: "leave", code: code3, playerId: "anon:f6", secret: S(6) });
  st = rooms[code3].state;
  ok(st.hostId === "anon:g7" && !st.players.some((q) => q.id === "anon:f6"), "host leaves the lobby: out of the list, the next human hosts");

  // two players at the same moment: the second is re-applied on fresh state
  const code4 = (await call({ action: "create", playerId: "anon:h8", secret: S(8), name: "А" })).body.code;
  failNextSave = 1;
  r = await call({ action: "add_bot", code: code4, playerId: "anon:h8", secret: S(8) });
  ok(r.code === 200 && rooms[code4].state.players.length === 2, "a write that lost the race is retried");

  // stale code reuse
  rooms["7777"] = { code: "7777", state: { status: "ended", players: [] }, version: 5, updated_at: new Date(Date.now() - 7 * 3600e3).toISOString() };
  const realRandom = Math.random;
  const r7777 = 6777.5 / 9000;
  Math.random = () => r7777;
  r = await call({ action: "create", playerId: "anon:i9", secret: S(9), name: "Ира" });
  Math.random = realRandom;
  eq([r.code, r.body.code, r.body.version, rooms["7777"].state.hostId], [200, "7777", 6, "anon:i9"], "a code of a long-dead room is reused");
  let n = 0;
  Math.random = () => (n++ === 0 ? r7777 : 0.1);
  r = await call({ action: "create", playerId: "anon:j1", secret: S(10), name: "Ян" });
  Math.random = realRandom;
  ok(r.code === 200 && r.body.code !== "7777" && rooms["7777"].state.hostId === "anon:i9", "a live room's code is never taken over: got " + r.body.code);
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
