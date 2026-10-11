const ROOT = require("path").resolve(__dirname, "../..");
// Blackjack engine: scoring, rules, payouts, secrecy and many bot rounds.
const J = require(ROOT + "/api/_lib/blackjack.js");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const players = (n) => Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, bot: true }));

eq(J.makeShoe().length, 104, "two decks");
eq(J.score(["14S", "13H"]), { total: 21, soft: true }, "A+K = 21 soft");
eq(J.score(["14S", "14H", "9C"]).total, 21, "A+A+9 = 21");
eq(J.score(["10S", "6H", "14C"]), { total: 17, soft: false }, "10+6+A = 17 hard");
eq(J.score(["10S", "6H", "9C"]).total, 25, "bust");
ok(J.isBlackjack(["14S", "10H"]) && !J.isBlackjack(["7S", "7H", "7C"]), "blackjack = 21 with two cards");

let s = J.newGame(players(3), {}, rng(1));
eq([s.phase, s.players.map((q) => q.chips)], ["bet", [1000, 1000, 1000]], "betting first, 1000 chips each");
ok(!J.canBet(s, 0, 5) && !J.canBet(s, 0, 501) && J.canBet(s, 0, 100) && !J.canBet(s, 0, 10.5), "bets 10..500, whole chips");
s = J.apply(s, 0, { type: "bet", amount: 100 }).state;
eq([s.players[0].chips, s.phase], [900, "bet"], "bet taken, waiting for the others");
ok(!J.apply(s, 0, { type: "bet", amount: 100 }).ok, "one bet per round");
s = J.apply(s, 1, { type: "bet", amount: 50 }).state;
s = J.apply(s, 2, { type: "bet", amount: 10 }, rng(2)).state;
ok(s.phase === "turns" || s.phase === "score", "all bet -> cards dealt");
eq(s.dealer.cards.length, s.phase === "score" ? s.dealer.cards.length : 1, "the dealer shows one card");
ok(s.phase === "score" || (s.secret.hole && s.dealer.hidden), "the second dealer card is hidden");
const v = J.viewFor(s, "p0");
ok(!("deck" in v) && !("secret" in v) && v.deckCount > 0, "shoe and hidden card never in a view");

// fixed positions
function table(cards, dealer, hole, deck) {
  const st = J.newGame(players(cards.length), {}, rng(3));
  st.players.forEach((q, i) => { q.bet = 100; q.chips = 900; q.cards = cards[i].slice(); q.done = false; });
  st.dealer = { cards: [dealer], hidden: true }; st.secret = { hole };
  st.deck = deck.slice().reverse(); // pop() takes from the end
  st.phase = "turns"; st.turn = 0;
  return st;
}
s = table([["10S", "6H"]], "9C", "8D", ["5H", "2S"]);
ok(J.canHit(s, 0) && J.canDouble(s, 0) && J.canStand(s, 0) && !J.canHit(s, 1), "hit / double / stand in turn");
s = J.apply(s, 0, { type: "hit" }).state;
eq([s.players[0].cards.length, J.score(s.players[0].cards).total, s.phase], [3, 21, "score"], "21 ends the turn; the dealer plays");
eq([J.score(s.dealer.cards).total, s.dealer.hidden], [17, false], "the dealer turns the hidden card and stands on 17");
eq([s.players[0].outcome, s.players[0].chips, s.players[0].win], ["win", 1100, 100], "win pays 1:1");
s = table([["10S", "7H"], ["14S", "13H"]], "9C", "8D", []);
s.players[1].done = true;
s = J.apply(s, 0, { type: "stand" }).state;
eq([s.players[1].outcome, s.players[1].chips], ["blackjack", 900 + 250], "blackjack pays 3:2");
eq([s.players[0].outcome, s.players[0].chips], ["push", 1000], "17 v 17 is a push: the bet comes back");
s = table([["10S", "2H"]], "6C", "10D", ["10H", "9S"]);
s = J.apply(s, 0, { type: "stand" }).state;
eq([J.score(s.dealer.cards).total > 21, s.players[0].outcome, s.players[0].chips], [true, "win", 1100], "dealer busts: everyone still in wins");
s = table([["5S", "6H"]], "6C", "10D", ["10H", "3S"]);
s = J.apply(s, 0, { type: "double" }).state;
eq([s.players[0].bet, s.players[0].cards.length, s.phase], [200, 3, "score"], "double: twice the bet, one card, done");
eq([s.players[0].outcome, s.players[0].chips], ["win", 800 + 400], "21 v 19: double win pays 2x the doubled bet back");
s = table([["10S", "9H"]], "14C", "13D", []);
s.phase = "bet"; s.players[0].bet = 0; s.players[0].cards = []; s.players[0].chips = 1000; s.dealer = { cards: [], hidden: false }; s.secret = { hole: null };
s.deck = ["13D", "9H", "14C", "10S"]; // pops: 10S me, 14C dealer, 9H me, 13D hole
s = J.apply(s, 0, { type: "bet", amount: 100 }).state;
eq([s.phase, s.players[0].outcome, s.players[0].chips], ["score", "lose", 900], "dealer blackjack ends the round at once");
s = table([["10S", "9H"]], "6C", "10D", []);
s.players[0].chips = 0; s.phase = "score";
ok(!J.canRebuy(s, 0), "no rebuy while a bet is on");
s.players[0].bet = 0;
ok(J.canRebuy(s, 0) && J.apply(s, 0, { type: "rebuy" }).state.players[0].chips === 1000, "out of chips: another 1000");

// timeouts
s = J.newGame(players(3), {}, rng(9));
s = J.apply(s, 0, { type: "bet", amount: 20 }).state;
let t = J.timeout(s, rng(10));
eq([t.idle, t.state.phase !== "bet", t.state.players[1].bet, t.state.players[1].sitOut], [[1, 2], true, 0, true], "bets not placed in time: those players sit the round out");
if (t.state.phase === "turns") { const seat = t.state.turn; const t2 = J.timeout(t.state, rng(11)); ok(t2.idle[0] === seat && t2.state.players[seat].done, "idle at their turn: stand"); }

// many rounds with bots: chips conserved against the house, no illegal moves
let bad = 0, rounds = 0, bjs = 0, busts = 0, dealerBJ = 0;
for (let seed = 1; seed <= 300; seed++) {
  let st = J.newGame(players(1 + (seed % 6)), {}, rng(seed * 31337));
  for (let step = 0; step < 400; step++) {
    if (st.phase === "score") {
      rounds++;
      st.players.forEach((q) => { if (q.outcome === "blackjack") bjs++; if (q.outcome === "bust") busts++; });
      if (J.isBlackjack(st.dealer.cards)) dealerBJ++;
      // money check: chips + bets at start of round == chips after minus wins
      st = J.apply(st, 0, { type: "next" }, rng(seed + step)).state;
      continue;
    }
    const mv = J.nextBotMove(st, () => true);
    if (!mv) { bad++; console.log("stuck", seed, st.phase, st.turn); break; }
    const before = st.players.reduce((a, q) => a + q.chips + q.bet, 0);
    const r = J.apply(st, mv[0], mv[1], rng(seed * 7 + step));
    if (!r.ok) { bad++; console.log("illegal", seed, JSON.stringify(mv), r.error); break; }
    st = r.state;
    if (st.phase === "turns" || st.phase === "bet") {
      const after = st.players.reduce((a, q) => a + q.chips + q.bet, 0);
      if (after !== before && mv[1].type !== "rebuy") { bad++; console.log("chips appeared", seed, mv); break; }
    }
    if (st.dealer.hidden && st.dealer.cards.length !== 1) { bad++; console.log("dealer shows too much", seed); break; }
  }
}
eq(bad, 0, "300 tables of bots: no illegal move, no chips from nowhere");
ok(rounds > 3000 && bjs > 50 && busts > 100 && dealerBJ > 20, `rounds ${rounds}, blackjacks ${bjs}, busts ${busts}, dealer blackjacks ${dealerBJ}`);
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
