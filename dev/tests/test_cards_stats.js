const ROOT = require("path").resolve(__dirname, "../..");
// Card game statistics: what /api/cards adds to profiles (cards_record).
const crypto = require("crypto");
const handler = require(ROOT + "/api/cards.js");
const E = require(ROOT + "/api/_lib/durak.js");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const rooms = {}; const recorded = []; let failNextSave = 0; const requests = [];
global.fetch = async (url, init = {}) => {
  url = String(url); requests.push({ url, init });
  const m = url.match(/\/rest\/v1\/(.*)$/); const path = m[1];
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (path.startsWith("rpc/cards_record")) { recorded.push(JSON.parse(init.body)); return json(200, { ok: true }); }
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
function call(body) {
  return new Promise((resolve) => {
    const res = { headers: {}, code: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; resolve(this); } };
    handler({ method: "POST", body }, res);
  });
}
const S = (n) => "secret-secret-secret-" + n;
const Bl = require(ROOT + "/api/_lib/blot.js");
const J = require(ROOT + "/api/_lib/blackjack.js");
const sum = (pid, key) => recorded.filter((r) => r.p_profile_id === pid).reduce((a, r) => a + (r.p_delta[key] || 0), 0);
const max = (pid, key) => recorded.filter((r) => r.p_profile_id === pid).reduce((a, r) => Math.max(a, r.p_delta[key] || 0), 0);
async function playDurak(code, humans) {
  for (let k = 0; k < 800 && rooms[code].state.status === "playing"; k++) {
    const st = rooms[code].state;
    let moved = false;
    for (const [i, n] of humans) {
      const mv = E.botMove(st, i);
      if (mv) { await call({ action: "move", code, playerId: st.players[i].id, secret: S(n), move: mv }); moved = true; break; }
    }
    if (!moved) { st.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: st.players[humans[0][0]].id, secret: S(humans[0][1]) }); }
  }
}
(async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  /* Durak, two people and a bot */
  let r = await call({ action: "create", playerId: "anon:a1", secret: S(1), name: "Аня", profileId: "anon:prof-anya" });
  let code = r.body.code;
  ok(!JSON.stringify(r.body.view).includes("prof-anya"), "a profile id never goes back out");
  await call({ action: "join", code, playerId: "anon:b2", secret: S(2), name: "Боря", profileId: "tg:12345" });
  await call({ action: "add_bot", code, playerId: "anon:a1", secret: S(1) });
  r = await call({ action: "start", code, playerId: "anon:a1", secret: S(1) });
  eq(rooms[code].state.humans, 2, "two people at the deal");
  ok(!JSON.stringify(r.body.view).includes("tg:12345"), "nobody sees anyone's profile id");
  await playDurak(code, [[0, 1], [1, 2]]);
  const st = rooms[code].state;
  eq(st.status, "ended", "durak game played out");
  eq([sum("anon:prof-anya", "durak_games"), sum("tg:12345", "durak_games")], [1, 1], "both people get one game");
  const fools = sum("anon:prof-anya", "durak_fools") + sum("tg:12345", "durak_fools");
  const wins = sum("anon:prof-anya", "durak_wins") + sum("tg:12345", "durak_wins");
  eq(fools + wins, st.draw ? 0 : 2, "each is either the fool or not (" + wins + " wins, " + fools + " fools)");
  ok(fools === (st.loser === 0 || st.loser === 1 ? 1 : 0), "the fool is the loser");
  ok(!recorded.some((x) => !/^(tg|anon):/.test(x.p_profile_id)), "bots are never recorded");
  const before = recorded.length;
  await call({ action: "move", code, playerId: "anon:a1", secret: S(1), move: { type: "pass" } });
  await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) });
  eq(recorded.length, before, "nothing counted twice after the end");
  /* rematch counts again */
  await call({ action: "rematch", code, playerId: "anon:a1", secret: S(1) });
  await playDurak(code, [[0, 1], [1, 2]]);
  eq(sum("anon:prof-anya", "durak_games"), 2, "a rematch is a second game");

  /* Durak alone with bots: online, but not counted */
  recorded.length = 0;
  r = await call({ action: "create", playerId: "anon:c3", secret: S(3), name: "Вика", profileId: "anon:prof-vika" });
  code = r.body.code;
  await call({ action: "add_bot", code, playerId: "anon:c3", secret: S(3) });
  await call({ action: "start", code, playerId: "anon:c3", secret: S(3) });
  await playDurak(code, [[0, 3]]);
  eq([rooms[code].state.status, recorded.length], ["ended", 0], "one person against bots: no statistics");

  /* Blot, two people + two bots */
  recorded.length = 0;
  r = await call({ action: "create", game: "blot", playerId: "anon:a1", secret: S(1), name: "Аня", profileId: "anon:prof-anya", settings: { target: 101 } });
  code = r.body.code;
  await call({ action: "join", code, playerId: "anon:b2", secret: S(2), name: "Боря", profileId: "tg:12345" });
  await call({ action: "start", code, playerId: "anon:a1", secret: S(1) });
  let deals = 0;
  for (let k = 0; k < 3000 && rooms[code].state.status === "playing"; k++) {
    const s2 = rooms[code].state;
    if (s2.phase === "score") { deals++; s2.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); continue; }
    const seat = s2.phase === "bid" ? s2.bidding.turn : s2.turn;
    const n = seat === 0 ? 1 : 2;
    await call({ action: "move", code, playerId: s2.players[seat].id, secret: S(n), move: Bl.botMove(s2, seat) });
  }
  const bs = rooms[code].state;
  eq(bs.status, "ended", "blot game played out (" + deals + " deals)");
  eq([sum("anon:prof-anya", "blot_games"), sum("tg:12345", "blot_games")], [1, 1], "a blot game each");
  eq(sum("anon:prof-anya", "blot_wins") + sum("tg:12345", "blot_wins"), bs.winner === null ? 0 : 1, "seats 0 and 1 are on different teams: exactly one of them wins");
  const madeByUs = bs.history.filter((h) => h.made && (h.contract.seat === 0 || h.contract.seat === 1)).length;
  const histDeals = bs.history.length;
  // every scored deal is in the history; deals where all four passed are redealt and leave none
  ok((histDeals >= deals && histDeals <= bs.deals) || bs.deals > 30, `history covers the deals (${histDeals} in history, ${deals} scored, ${bs.deals} dealt)`);
  eq(sum("anon:prof-anya", "blot_made") + sum("tg:12345", "blot_made"), madeByUs, "each contract a person made is counted once (" + madeByUs + ")");
  const capotsUs = bs.history.filter((h) => h.capot !== null && h.capot !== undefined).length;
  eq(sum("anon:prof-anya", "blot_capots") + sum("tg:12345", "blot_capots"), capotsUs, "every капут counted for the person on that team (" + capotsUs + ")");

  /* Blackjack: two people */
  recorded.length = 0;
  r = await call({ action: "create", game: "blackjack", playerId: "anon:a1", secret: S(1), name: "Аня", profileId: "anon:prof-anya" });
  code = r.body.code;
  await call({ action: "start", code, playerId: "anon:a1", secret: S(1) });
  await call({ action: "join", code, playerId: "anon:b2", secret: S(2), name: "Боря", profileId: "tg:12345" });
  let rounds = 0, outcomes = { anya: 0, bj: 0, wins: 0 }, bestWin = 0, bestChips = 0;
  for (let k = 0; k < 600 && rounds < 12; k++) {
    const s2 = rooms[code].state;
    if (s2.phase === "score") {
      if (s2.players[0].bet > 0) { outcomes.anya++; if (s2.players[0].outcome === "blackjack") outcomes.bj++; if (s2.players[0].win > 0) outcomes.wins++; bestWin = Math.max(bestWin, s2.players[0].win); bestChips = Math.max(bestChips, s2.players[0].chips); }
      rounds++; s2.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); continue;
    }
    let moved = false;
    for (const [i, n] of [[0, 1], [1, 2]]) { const mv = J.botMove(s2, i); if (mv) { await call({ action: "move", code, playerId: s2.players[i].id, secret: S(n), move: mv }); moved = true; break; } }
    if (!moved) { s2.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:a1", secret: S(1) }); }
  }
  eq(sum("anon:prof-anya", "bj_rounds"), outcomes.anya, "every round Аня played is counted (" + outcomes.anya + ")");
  eq([sum("anon:prof-anya", "bj_wins"), sum("anon:prof-anya", "bj_blackjacks")], [outcomes.wins, outcomes.bj], "wins and blackjacks counted");
  eq([max("anon:prof-anya", "bj_best_chips"), max("anon:prof-anya", "bj_best_win")], [bestChips, Math.max(0, bestWin)], "best chips and best win kept as records");
  /* a table of one person and a bot: not counted */
  recorded.length = 0;
  r = await call({ action: "create", game: "blackjack", playerId: "anon:c3", secret: S(3), name: "Вика", profileId: "anon:prof-vika" });
  code = r.body.code;
  await call({ action: "add_bot", code, playerId: "anon:c3", secret: S(3) });
  await call({ action: "start", code, playerId: "anon:c3", secret: S(3) });
  for (let k = 0; k < 60; k++) {
    const s2 = rooms[code].state;
    const mv = J.botMove(s2, 0);
    if (mv) await call({ action: "move", code, playerId: "anon:c3", secret: S(3), move: mv });
    else { s2.deadline = Date.now() - 1; await call({ action: "tick", code, playerId: "anon:c3", secret: S(3) }); }
  }
  eq(recorded.length, 0, "one person and bots at a blackjack table: no statistics");
  /* bad profile ids are ignored */
  r = await call({ action: "create", playerId: "anon:d4", secret: S(4), name: "Гоша", profileId: "evil'; drop" });
  eq(rooms[r.body.code].state.players[0].profileId, null, "a malformed profile id is not stored");
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
