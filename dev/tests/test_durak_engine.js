const ROOT = require("path").resolve(__dirname, "../..");
// Durak engine: rules and thousands of bot-only games.
const E = require(ROOT + "/api/_lib/durak.js");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const players = (n) => Array.from({ length: n }, (_, i) => ({ id: "p" + i, name: "P" + i, bot: true }));
const total = (s) => s.deck.length + s.discard + s.table.reduce((a, t) => a + 1 + (t.d ? 1 : 0), 0) + s.players.reduce((a, q) => a + q.hand.length, 0);

// --- basics
eq(E.makeDeck().length, 36, "36 cards");
eq(new Set(E.makeDeck()).size, 36, "no duplicates");
ok(E.beats("7H", "6H", "S") && !E.beats("6H", "7H", "S") && E.beats("6S", "14H", "S") && !E.beats("14H", "6S", "S") && !E.beats("7D", "6H", "S") && E.beats("10S", "9S", "S"), "beating rules");
let s = E.newGame(players(4), {}, rng(7));
eq(s.players.map((q) => q.hand.length), [6, 6, 6, 6], "six cards each");
eq(s.deck.length, 12, "12 left in the deck with 4 players");
eq(total(s), 36, "all cards accounted for");
eq(s.trump, s.trumpCard.slice(-1), "trump from the turned-up card");
eq(s.deck[0], s.trumpCard, "turned-up card is drawn last");
const lowest = Math.min(...s.players.flatMap((q) => q.hand.filter((c) => c.endsWith(s.trump)).map((c) => parseInt(c, 10))));
ok(s.players[s.attacker].hand.some((c) => c.endsWith(s.trump) && parseInt(c, 10) === lowest), "lowest trump leads");
eq(s.defender, (s.attacker + 1) % 4, "defender is the next player");

// --- a hand-made position
function fixed(hands, opts = {}) {
  const st = E.newGame(players(hands.length), opts, rng(1));
  st.players.forEach((q, i) => { q.hand = hands[i].slice(); });
  st.trump = opts.trump || "S"; st.trumpCard = "6" + st.trump; st.deck = opts.deck || ["6" + st.trump];
  st.attacker = 0; st.defender = 1; st.table = []; st.taking = false; st.discard = 0;
  st.boutLimit = Math.min(6, hands[1].length);
  st.players.forEach((q) => { q.passed = false; q.out = false; });
  return st;
}
s = fixed([["7H", "7D", "9C", "12H"], ["8H", "8D", "14S", "6C"], ["7C", "10H", "11H"]]);
ok(!E.canPlay(s, 2, "7C"), "only the attacker leads");
ok(E.canPlay(s, 0, "9C") && !E.canPlay(s, 1, "8H"), "attacker may lead anything, defender may not lead");
let r = E.apply(s, 0, { type: "play", card: "7H" }); s = r.state;
ok(r.ok && s.table.length === 1, "lead");
ok(E.canThrow(s, 2, "7C") && !E.canThrow(s, 2, "10H"), "others throw in only matching ranks");
eq([E.thrower(s), E.throwOrder(s)], [0, [0, 2]], "throwing in goes in turn: the main attacker first");
ok(!E.canPlay(s, 2, "7C") && !E.canPass(s, 2) && !E.apply(s, 2, { type: "play", card: "7C" }).ok, "a co-attacker cannot throw in or pass out of turn");
ok(!E.canBeat(s, 1, "6C", 0) && E.canBeat(s, 1, "8H", 0) && E.canBeat(s, 1, "14S", 0), "defender beats with higher same suit or trump");
ok(!E.apply(s, 1, { type: "beat", card: "6C", target: 0 }).ok, "illegal beat refused");
s = E.apply(s, 1, { type: "beat", card: "8H", target: 0 }).state;
ok(E.canPlay(s, 0, "7D") && !E.canPlay(s, 2, "7C"), "after a beat the main attacker has the first word again");
s = E.apply(s, 0, { type: "pass" }).state;
ok(E.thrower(s) === 2 && E.canPlay(s, 2, "7C") && !E.canPlay(s, 0, "7D"), "after the main attacker's «Бито» the next player may throw in");
s = E.apply(s, 2, { type: "play", card: "7C" }).state;
ok(!s.players[0].passed && E.thrower(s) === 0, "a new card gives the main attacker the first word again");
s = E.apply(s, 1, { type: "take" }).state;
ok(s.taking && E.canPlay(s, 0, "7D"), "after 'take', attackers may still add cards");
s = E.apply(s, 0, { type: "play", card: "7D" }).state;
ok(s.status === "playing" && s.table.length === 0, "nobody has anything left to add -> the bout closes by itself and the defender takes");
eq(s.players[1].hand.length, 7, "defender keeps 3 and takes the 4 table cards (the last deck card went to the attacker)");
eq(s.attacker, 2, "after a take, the player after the defender attacks");
eq(total(s), 12, "cards conserved in the hand-made position");

// beaten bout -> discard, defender attacks
s = fixed([["7H", "9C"], ["8H", "10C", "6D"], ["11D"]], { deck: ["6S", "13D", "12D"] });
s = E.apply(s, 0, { type: "play", card: "7H" }).state;
s = E.apply(s, 1, { type: "beat", card: "8H", target: 0 }).state;
eq([s.discard, s.attacker, s.defender], [2, 1, 2], "beaten: cards discarded, the defender attacks next");

// limit: no more uncovered cards than the defender holds
s = fixed([["7H", "7D", "7C"], ["8S"], ["9H"]]);
s.boutLimit = 1;
s = E.apply(s, 0, { type: "play", card: "7H" }).state;
ok(!E.canPlay(s, 0, "7D"), "cannot throw more cards than the defender can answer");

// transfer
s = fixed([["7H", "9C"], ["7D", "10C"], ["11D", "12D", "13D"]], { transfer: true });
s.settings.transfer = true;
s = E.apply(s, 0, { type: "play", card: "7H" }).state;
ok(E.canTransfer(s, 1, "7D") && !E.canTransfer(s, 1, "10C"), "transfer with the same rank only");
s = E.apply(s, 1, { type: "transfer", card: "7D" }).state;
eq([s.attacker, s.defender, s.table.length], [1, 2, 2], "transfer passes the attack to the next player");
s = fixed([["7H"], ["7D"], ["11D"]], { transfer: true }); s.settings.transfer = true;
s = E.apply(s, 0, { type: "play", card: "7H" }).state;
ok(!E.canTransfer(s, 1, "7D"), "no transfer when the next player could not answer");
s = fixed([["7H"], ["7D", "8H"], ["11D", "12D"]]);
s = E.apply(s, 0, { type: "play", card: "7H" }).state;
ok(!E.canTransfer(s, 1, "7D"), "no transfer unless the rule is switched on");

// timeout
s = fixed([["7H", "9C"], ["8C", "10C"], ["11D"]]);
let t = E.timeout(s);
eq([t.state.table.length, t.idle], [1, [0]], "idle leader: lowest card goes");
t = E.timeout(t.state);
ok(t.idle.includes(1) && t.state.table.length === 0 && t.state.players[1].hand.length >= 3, "idle defender takes");

// timeout passes only the one whose turn it is, and only they count as idle
s = fixed([["7H", "7D", "9C"], ["8H", "8D", "14S", "6C"], ["7C", "8C", "10H"], ["8S", "12C"]]);
s = E.apply(s, 0, { type: "play", card: "7H" }).state;
s = E.apply(s, 1, { type: "beat", card: "8H", target: 0 }).state;
eq(E.thrower(s), 0, "4 players: attacker first");
t = E.timeout(s);
eq([t.idle, E.thrower(t.state)], [[0], 2], "idle main attacker passes; the player after the defender is next");
t = E.timeout(t.state);
eq([t.idle, E.thrower(t.state)], [[2], 3], "then the next one");
t = E.timeout(t.state);
eq([t.idle, t.state.table.length, t.state.discard], [[3], 0, 2], "all passed with everything beaten: the bout closes");
// order after the defender, wrapping round
s = fixed([["7H"], ["8H"], ["7C"], ["7D"], ["7S"]]);
s.attacker = 2; s.defender = 3;
s.table = [{ a: "7H", d: null }];
eq(E.throwOrder(s), [2, 4, 0, 1], "order: main attacker, then clockwise from the defender");

// view
s = E.newGame(players(3), {}, rng(3));
s.players[0].secretHash = "x";
const v = E.viewFor(s, "p0");
ok(!("deck" in v) && v.deckCount === s.deck.length, "deck hidden, count shown");
ok(Array.isArray(v.players[0].hand) && !("hand" in v.players[1]) && v.players[1].handCount === 6, "only own hand visible");
ok(!("secretHash" in v.players[0]), "secrets never leave the server");

// --- many bot games
let games = 0, ends = 0, draws = 0, maxSteps = 0, transfers = 0, bad = 0;
for (let seed = 1; seed <= 3000; seed++) {
  const n = 2 + (seed % 5);
  const random = rng(seed * 2654435761);
  let st = E.newGame(players(n), { transfer: seed % 2 === 0 }, random);
  let steps = 0;
  while (st.status === "playing" && steps < 2000) {
    const mv = seed % 7 === 0 && steps % 9 === 4 ? null : E.nextBotMove(st, () => true);
    if (!mv) { st = E.timeout(st).state; } else {
      const res = E.apply(st, mv[0], mv[1]);
      if (!res.ok) { bad++; console.log("illegal bot move", seed, mv, res.error); break; }
      if (mv[1].type === "transfer") transfers++;
      st = res.state;
    }
    steps++;
    if (total(st) !== 36) { bad++; console.log("cards lost", seed, steps); break; }
  }
  games++;
  maxSteps = Math.max(maxSteps, steps);
  if (st.status === "ended") ends++;
  if (st.draw) draws++;
  if (st.status === "ended" && !st.draw) {
    const loser = st.players[st.loser];
    if (!loser || loser.out || loser.hand.length === 0) { bad++; console.log("bad loser", seed); }
    if (st.players.filter((q) => !q.out).length !== 1) { bad++; console.log("more than one left", seed); }
  }
}
eq(bad, 0, "3000 bot games: no illegal bot move, no lost card, sane endings");
eq(ends, games, "every game finishes (longest took " + maxSteps + " moves)");
ok(transfers > 0, "bots use transfers in the transfer variant (" + transfers + ")");
ok(draws < games * 0.2, "draws are rare (" + draws + ")");
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
