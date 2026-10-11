const ROOT = require("path").resolve(__dirname, "../..");
// Blot engine: rules, scoring and thousands of bot-only games.
const B = require(ROOT + "/api/_lib/blot.js");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const players = () => Array.from({ length: 4 }, (_, i) => ({ id: "p" + i, name: "P" + i, bot: true }));

// --- deck, deal
eq(B.makeDeck().length, 32, "32 cards");
let s = B.newGame(players(), { target: 201 }, rng(5));
eq(s.players.map((q) => q.hand.length), [8, 8, 8, 8], "eight each");
eq(new Set(s.players.flatMap((q) => q.hand)).size, 32, "every card dealt once");
eq([s.phase, s.bidding.turn, s.settings.target], ["bid", (s.dealer + 1) % 4, 201], "bidding starts left of the dealer");
eq(B.newGame(players(), { target: 999 }, rng(5)).settings.target, 101, "unknown target -> 101");

// --- card order and points
const T = "H";
ok(B.power("11H", T) > B.power("9H", T) && B.power("9H", T) > B.power("14H", T) && B.power("14H", T) > B.power("10H", T) && B.power("10H", T) > B.power("13H", T), "trump order J 9 A 10 K");
ok(B.power("14S", T) > B.power("10S", T) && B.power("10S", T) > B.power("13S", T) && B.power("12S", T) > B.power("11S", T) && B.power("11S", T) > B.power("9S", T), "plain order A 10 K Q J 9");
const sum = (trump) => B.makeDeck().reduce((a, c) => a + B.points(c, trump), 0);
eq([sum("H"), sum("N")], [152, 152], "card points total 152 in a suit contract and in no trump");

// --- bidding
s = B.newGame(players(), {}, rng(9));
const d = s.dealer, a = (d + 1) % 4, b2 = (d + 2) % 4, c = (d + 3) % 4;
ok(!B.canBid(s, a, 7, "S") && B.canBid(s, a, 8, "S") && !B.canBid(s, b2, 8, "S") && !B.canBid(s, a, 8, "X"), "first bid 8+, only in turn, valid suit");
s = B.apply(s, a, { type: "bid", level: 8, suit: "S" }).state;
ok(!B.canBid(s, b2, 8, "H") && B.canBid(s, b2, 9, "H"), "each bid higher than the last");
ok(B.canContra(s, b2) && !B.canRecontra(s, b2), "the next opponent may say контра");
s = B.apply(s, b2, { type: "pass" }).state;
s = B.apply(s, c, { type: "pass" }).state;
eq(s.phase, "bid", "two passes: still bidding");
s = B.apply(s, d, { type: "pass" }).state;
eq([s.phase, s.contract.level, s.contract.suit, s.contract.seat, s.trump, s.turn], ["play", 8, "S", a, "S", a], "three passes after a bid: contract, the player left of the dealer leads");
// all pass -> redeal
s = B.newGame(players(), {}, rng(11));
const dealer0 = s.dealer;
for (let k = 1; k <= 4; k++) s = B.apply(s, (dealer0 + k) % 4, { type: "pass" }).state;
eq([s.phase, s.dealer, s.deals], ["bid", (dealer0 + 1) % 4, 2], "four passes: dealt again by the next dealer");
// contra / recontra
s = B.newGame(players(), {}, rng(12));
{
  const d0 = s.dealer, x = (d0 + 1) % 4, y = (d0 + 2) % 4, z = (d0 + 3) % 4;
  s = B.apply(s, x, { type: "bid", level: 9, suit: "D" }).state;
  s = B.apply(s, y, { type: "contra" }).state;
  ok(s.phase === "bid" && s.bidding.turn === z && B.canRecontra(s, z) && !B.canBid(s, z, 10, "D"), "after контра the bidders may only answer реконтра or pass");
  const after = B.apply(s, z, { type: "recontra" }).state;
  eq([after.phase, after.contract.contra], ["play", 2], "реконтра ends the bidding");
  const passed = B.apply(s, z, { type: "pass" }).state;
  eq([passed.phase, passed.contract.contra], ["play", 1], "pass after контра: the контра stands");
}

// --- legal cards
function playing(hands, trump, leader, trick) {
  const st = B.newGame(players(), {}, rng(1));
  st.players.forEach((q, i) => { q.hand = hands[i].slice(); });
  st.phase = "play"; st.trump = trump; st.contract = { level: 8, suit: trump, seat: 0, team: 0, contra: 0 };
  st.trick = trick || []; st.turn = (leader + (trick ? trick.length : 0)) % 4; st.leader = leader; st.combos = []; st.belot = null;
  return st;
}
s = playing([["7S", "10H"], ["8S", "9C", "11H"], ["14D"], ["7C"]], "H", 0, [{ seat: 0, card: "7S" }]);
eq(B.legalCards(s, 1), ["8S"], "follow suit");
s = playing([["7S"], ["9C", "11H", "7H"], ["14D"], ["7C"]], "H", 0, [{ seat: 0, card: "7S" }]);
eq(B.legalCards(s, 1).sort(), ["11H", "7H"], "cannot follow, opponent winning: must trump");
s = playing([["7S"], ["9C", "8H"], ["14S"], ["7C"]], "H", 3, [{ seat: 3, card: "14S" }, { seat: 0, card: "10S" }]);
eq(B.legalCards(s, 1).sort(), ["8H", "9C"], "partner winning: any card");
s = playing([["7S"], ["9C", "8H", "11H"], ["14S"], ["7C"]], "H", 3, [{ seat: 3, card: "10S" }, { seat: 0, card: "9H" }]);
eq(B.legalCards(s, 1), ["11H"], "opponent trumped: overtrump if possible");
s = playing([["7S"], ["9C", "8H"], ["14S"], ["7C"]], "H", 3, [{ seat: 3, card: "10S" }, { seat: 0, card: "9H" }]);
eq(B.legalCards(s, 1).sort(), ["8H", "9C"], "cannot overtrump: anything");
s = playing([["7S"], ["7H", "11H", "9C"], ["14S"], ["10H"]], "H", 3, [{ seat: 3, card: "10H" }, { seat: 0, card: "14H" }]);
eq(B.legalCards(s, 1), ["11H"], "trump led: beat the highest trump if you can");
s = playing([["7S"], ["7H", "8H", "9C"], ["14S"], ["10H"]], "H", 3, [{ seat: 3, card: "10H" }, { seat: 0, card: "14H" }]);
eq(B.legalCards(s, 1).sort(), ["7H", "8H"], "trump led, cannot beat: still follow with a trump");
s = playing([["7S"], ["9C", "8H"], ["14S"], ["7C"]], "N", 0, [{ seat: 0, card: "7S" }]);
eq(B.legalCards(s, 1).sort(), ["8H", "9C"], "no trump: cannot follow -> anything");
eq(B.trickLeader([{ seat: 0, card: "7S" }, { seat: 1, card: "14S" }, { seat: 2, card: "7H" }, { seat: 3, card: "11S" }], "H"), 2, "a trump wins the trick");
eq(B.trickLeader([{ seat: 0, card: "7S" }, { seat: 1, card: "14D" }, { seat: 2, card: "10S" }], "N"), 2, "off-suit never wins");

// --- combinations
const comb = (hand, trump) => B.findCombos(hand, trump).map((x) => x.kind + ":" + x.value);
eq(comb(["11S", "11C", "11D", "11H", "7S"], "H"), ["quad:200"], "four jacks 200");
eq(comb(["9S", "9C", "9D", "9H"], "N"), [], "four nines are nothing in no trump");
eq(comb(["14S", "14C", "14D", "14H"], "N"), ["quad:190"], "four aces 190 in no trump");
eq(comb(["7S", "8S", "9S", "12D", "13D", "14D", "11D"], "H"), ["seq:20", "seq:50"], "терц and 50");
eq(comb(["7C", "8C", "9C", "10C", "11C", "12C"], "H"), ["seq:100"], "five or more in a row = 100");
ok(B.compareCombos({ kind: "quad", value: 100, rank: 12 }, { kind: "seq", len: 5, top: 14, suit: "S" }, "H") > 0, "any four-of-a-kind beats any sequence");
ok(B.compareCombos({ kind: "seq", len: 3, top: 14, suit: "S" }, { kind: "seq", len: 3, top: 13, suit: "H" }, "H") > 0, "same length: higher top card");
ok(B.compareCombos({ kind: "seq", len: 3, top: 13, suit: "H" }, { kind: "seq", len: 3, top: 13, suit: "S" }, "H") > 0, "same height: the trump one");

// --- a whole deal, scored by hand
function playOut(st) {
  let guard = 0;
  while (st.phase === "play" && guard++ < 100) {
    const mv = B.botMove(st, st.turn);
    const r = B.apply(st, st.turn, mv);
    if (!r.ok) throw new Error("illegal bot move " + JSON.stringify(mv));
    st = r.state;
  }
  return st;
}
let made = 0, failed = 0, capots = 0, combosSeen = 0, belots = 0, contras = 0;
for (let seed = 1; seed <= 400; seed++) {
  let st = B.newGame(players(), {}, rng(seed * 7919));
  let guard = 0;
  while (st.phase === "bid" && guard++ < 40) { const mv = B.nextBotMove(st, () => true); st = B.apply(st, mv[0], mv[1], rng(seed)).state; }
  if (st.phase !== "play") continue;
  if (seed % 5 === 0) { st.contract.contra = 1; contras++; }
  const before = st.scores.slice();
  const pts0 = st.players.flatMap((q) => q.hand).length;
  st = playOut(st);
  const r = st.result;
  ok(r && st.phase !== "play", "deal " + seed + " scored");
  ok(st.points[0] + st.points[1] === 162, "deal " + seed + ": card points + last trick = 162 (" + (st.points[0] + st.points[1]) + ")");
  ok(st.tricks[0] + st.tricks[1] === 8 && pts0 === 32, "eight tricks");
  const c = st.contract, bid = c.team, opp = 1 - bid;
  const tot = r.total;
  const madeCalc = c.level >= 25 ? st.tricks[bid] === 8 : tot[bid] >= c.level * 10;
  ok(r.made === madeCalc, "made iff the bidders reached the bid");
  const round = (x) => Math.floor((x + 4) / 10);
  const bidVal = c.level * (c.contra === 2 ? 4 : c.contra === 1 ? 2 : 1) * (c.suit === "N" ? 2 : 1);
  const exp = [0, 0];
  if (r.made && !c.contra) { exp[bid] = round(tot[bid]) + bidVal; exp[opp] = round(tot[opp]); }
  else if (r.made) exp[bid] = round(tot[0] + tot[1]) + bidVal;
  else exp[opp] = round(tot[0] + tot[1]) + bidVal;
  eq(r.gain, exp, "deal " + seed + " gains");
  eq([st.scores[0] - before[0], st.scores[1] - before[1]], exp, "scores updated");
  if (r.made) made++; else failed++;
  if (r.capot !== null) capots++;
  if (r.combo[0] + r.combo[1] > 0) combosSeen++;
  if (r.belot[0] + r.belot[1] > 0) belots++;
}
console.log(`stats: ${made} made, ${failed} failed, ${capots} капут, ${combosSeen} combos, ${belots} блот`);
ok(made > 50 && failed > 5, `bots both make and fail contracts (${made} made, ${failed} failed, ${capots} капут, ${combosSeen} with combinations, ${belots} блот, ${contras} контра)`);
eq(Math.floor((165 + 4) / 10) + "," + Math.floor((166 + 4) / 10), "16,17", "a half rounds down, more rounds up");

// --- full games
let ends = 0, games = 0, bad = 0, maxDeals = 0;
for (let seed = 1; seed <= 300; seed++) {
  const target = [101, 201, 301][seed % 3];
  let st = B.newGame(players(), { target }, rng(seed * 104729));
  let steps = 0;
  while (st.status === "playing" && steps++ < 5000) {
    if (st.phase === "score") { st = B.apply(st, 0, { type: "next" }, rng(seed + steps)).state; continue; }
    const mv = seed % 9 === 0 && steps % 7 === 3 ? null : B.nextBotMove(st, () => true);
    if (!mv) { st = B.timeout(st, rng(seed + steps)).state; continue; }
    const r = B.apply(st, mv[0], mv[1], rng(seed + steps));
    if (!r.ok) { bad++; console.log("illegal", seed, JSON.stringify(mv), r.error); break; }
    st = r.state;
    const cards = st.players.reduce((a, q) => a + q.hand.length, 0) + (st.trick ? st.trick.length : 0);
    if (st.phase === "play" && cards + 4 * (st.tricks[0] + st.tricks[1]) !== 32) { bad++; console.log("cards lost", seed); break; }
  }
  games++;
  if (st.status === "ended") {
    ends++;
    maxDeals = Math.max(maxDeals, st.deals);
    if (st.winner !== null && st.scores[st.winner] < target) { bad++; console.log("winner below target", seed); }
  }
}
eq(bad, 0, "300 games: no illegal move, no lost card, sane winners");
eq(ends, games, "every game ends (longest " + maxDeals + " deals)");

// --- view
s = B.newGame(players(), {}, rng(3));
s.players[1].secretHash = "x";
const v = B.viewFor(s, "p1");
ok(Array.isArray(v.players[1].hand) && !("hand" in v.players[0]) && v.players[0].handCount === 8 && !("secretHash" in v.players[1]), "only own hand visible");
// timeout
s = B.newGame(players(), {}, rng(4));
const t1 = B.timeout(s);
eq([t1.idle, t1.state.bidding.passes], [[s.bidding.turn], 1], "idle bidder passes");
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
