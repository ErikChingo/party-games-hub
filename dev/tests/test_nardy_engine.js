const ROOT = require("path").resolve(__dirname, "../..");
// Nardy rules engine (api/_lib/nardy.js): both variants played out by bots
// many times with the invariants checked after every turn, then each rule
// on a hand-made position.
const E = require(ROOT + "/api/_lib/nardy.js");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const players = () => [{ id: "a", name: "A", bot: true }, { id: "b", name: "B", bot: true }];

// A position from [seat, own point, count] (point 25 = the bar).
function make(variant, list, opts = {}) {
  const st = E.newGame(players(), { variant });
  st.board = new Array(24).fill(0);
  st.bar = [0, 0];
  st.off = [E.CHECKERS, E.CHECKERS];
  list.forEach(([seat, pt, n]) => {
    if (pt === 25) st.bar[seat] += n;
    else st.board[E.abs(variant, seat, pt)] += seat === 0 ? n : -n;
    st.off[seat] -= n;
  });
  st.turn = opts.turn || 0;
  st.dice = opts.dice;
  st.firstTurn = opts.firstTurn || [false, false];
  return st;
}
const steps = (st) => E.legalSteps(E.turnContext(st)).map((s) => s.from + "/" + s.die).sort();
const count = (st, seat) => st.board.reduce((n, v) => n + (seat === 0 ? Math.max(v, 0) : Math.max(-v, 0)), 0) + st.bar[seat] + st.off[seat];

// ---------- numbering and the start ----------
for (const v of E.VARIANTS) for (const seat of [0, 1]) {
  let good = true;
  for (let pt = 1; pt <= 24; pt++) if (E.own(v, seat, E.abs(v, seat, pt)) !== pt) good = false;
  ok(good, `${v}: own() undoes abs() for seat ${seat}`);
}
eq([E.abs("short", 0, 24), E.abs("short", 1, 24)], [23, 0], "short: the players start at opposite ends");
eq([E.abs("long", 0, 24), E.abs("long", 1, 24)], [23, 11], "long: the heads are opposite each other");
{
  const s = E.startPosition("short"), l = E.startPosition("long");
  eq([E.pips(s, "short", 0), E.pips(s, "short", 1)], [167, 167], "short: 167 pips each at the start");
  eq([E.pips(l, "long", 0), E.pips(l, "long", 1)], [360, 360], "long: 360 pips each at the start");
}
{
  const st = E.newGame(players(), { variant: "short" });
  ok(st.opening[0] !== st.opening[1] && st.turn === (st.opening[0] > st.opening[1] ? 0 : 1), "the higher opening die starts");
  eq(st.dice.slice().sort(), st.opening.slice().sort(), "short: the opening roll is played");
  eq(st.settings, { variant: "short", level: "normal" }, "default settings");
  eq(E.newGame(players(), { variant: "nope", level: "x" }).settings, { variant: "short", level: "normal" }, "unknown settings fall back");
}

// ---------- bots play whole games ----------
const t0 = Date.now();
for (const v of E.VARIANTS) {
  let ended = 0, mars = 0, broken = "", maxTurns = 0, hitsInLong = 0;
  for (let g = 0; g < 120; g++) {
    let st = E.newGame(players(), { variant: v, level: g % 2 ? "easy" : "normal" });
    for (let k = 0; k < 800 && st.status === "playing"; k++) {
      const mv = E.nextBotMove(st, () => true);
      const r = E.apply(st, mv[0], mv[1]);
      if (!r.ok) { broken = broken || `${v}: a bot move was refused (${r.error})`; break; }
      st = r.state;
      if (count(st, 0) !== 15 || count(st, 1) !== 15) broken = broken || `${v}: checkers appeared or vanished`;
      if (v === "long" && (st.bar[0] || st.bar[1])) hitsInLong++;
      if (st.last && st.last.steps.length > 4) broken = broken || `${v}: more than four moves in a turn`;
      if (v === "long" && st.last && st.last.steps.filter((s) => s.from === 24).length > 2) broken = broken || "long: more than two checkers left the head";
    }
    if (st.status === "ended") {
      ended++;
      if (st.mars) mars++;
      maxTurns = Math.max(maxTurns, st.turns);
      if (st.off[st.winner] !== 15 || st.points !== (st.mars ? 2 : 1)) broken = broken || `${v}: wrong result`;
    }
  }
  ok(!broken, broken || `${v}: rules held in every turn`);
  eq(ended, 120, `${v}: all 120 bot games finish`);
  ok(mars > 0 && mars < 120, `${v}: some games end in марс (${mars})`);
  if (v === "long") eq(hitsInLong, 0, "long: nobody is ever hit");
}
ok(Date.now() - t0 < 120000, `240 bot games in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// The normal bot should beat the easy one most of the time.
for (const v of E.VARIANTS) {
  let wins = 0;
  for (let g = 0; g < 60; g++) {
    let st = E.newGame(players(), { variant: v, level: "normal" });
    const strong = g % 2;
    for (let k = 0; k < 800 && st.status === "playing"; k++) {
      const seat = st.turn;
      const level = seat === strong ? "normal" : "easy";
      const mv = E.botMove({ ...st, settings: { ...st.settings, level } }, seat);
      st = E.apply(st, seat, mv).state;
    }
    if (st.winner === strong) wins++;
  }
  ok(wins >= 36, `${v}: the normal bot beats the easy one (${wins} of 60)`);
}

// ---------- short nardy, rule by rule ----------
{
  // A blot is hit and goes to the bar.
  const st = make("short", [[0, 13, 1], [1, 15, 1]], { dice: [3, 1] }); // seat 1's own 15 = seat 0's 10
  const r = E.apply(st, 0, { type: "turn", steps: [{ from: 13, die: 3 }, { from: 10, die: 1 }] });
  ok(r.ok && r.state.bar[1] === 1, "short: landing on a single checker hits it to the bar");
}
{
  // On the bar: nothing else moves until it is back in.
  const st = make("short", [[0, 25, 1], [0, 13, 2], [1, 1, 2]], { dice: [6, 2] });
  ok(steps(st).every((s) => s.startsWith("25/")), "short: a checker on the bar must come in first");
  eq(steps(st), ["25/2", "25/6"], "short: it comes in on point 25 - die");
}
// Dice in a fixed order: die = 1 + floor(r * 6).
const fixedDice = (...dice) => { const r = dice.map((d) => (d - 1 + 0.5) / 6); let i = 0; return () => r[i++ % r.length]; };
{
  // Entering blocked: the roll is lost, shown, and the turn passes back.
  // Seat 0 is on the bar and comes in on its 19/20 = seat 1's 6/5, both closed.
  const st = make("short", [[0, 25, 1], [0, 13, 1], [1, 6, 2], [1, 5, 2], [1, 13, 1]], { dice: [2, 1], turn: 1 });
  const r = E.apply(st, 1, { type: "turn", steps: [{ from: 13, die: 2 }, { from: 11, die: 1 }] }, fixedDice(6, 5, 3, 2));
  ok(r.ok && r.state.last.seat === 0 && r.state.last.blocked && r.state.last.dice.join() === "6,5", "short: a roll that cannot be played is kept to be shown");
  ok(r.ok && r.state.turn === 1 && r.state.dice.join() === "3,2", "short: and the turn passes straight back");
}
{
  // Only one of the two dice can be played: it has to be the larger one.
  // A lone checker on 10 with 6-2: 10->4 or 10->8, but 2 (seat 1's 23) is closed either way.
  const st = make("short", [[0, 10, 1], [1, 23, 2]], { dice: [6, 2] });
  eq(steps(st), ["10/6"], "short: when only one die can be played, the larger one");
}
{
  // Both dice must be used if any order allows it: 12 with a 1 leaves the 6 unplayable.
  // Closed: 14 and 5 (seat 1's 11 and 20).
  const st = make("short", [[0, 12, 1], [0, 20, 1], [1, 11, 2], [1, 20, 2]], { dice: [6, 1] });
  eq(steps(st), ["12/6", "20/1"], "short: a move that would waste the other die is not allowed");
}
{
  // Bearing off: a higher die only from the highest point. 1 is closed (seat 1's 24).
  const st = make("short", [[0, 5, 1], [0, 3, 1], [1, 24, 2]], { dice: [6, 4] });
  eq(steps(st), ["5/6"], "short: the 6 bears off the highest checker; the 4 may not bear off 3 while 5 is there");
  const ctx = E.turnContext(make("short", [[0, 5, 1], [0, 8, 1], [1, 24, 2]], { dice: [6, 5] }));
  ok(!E.legalSteps(ctx).some((s) => s.to === 0), "short: nothing is borne off while a checker is still outside home");
}
{
  // Mars: the loser has borne nothing off.
  const st = make("short", [[0, 1, 1], [1, 6, 15]], { dice: [3, 2] });
  const r = E.apply(st, 0, { type: "turn", steps: [{ from: 1, die: 3 }] });
  ok(r.ok && r.state.status === "ended" && r.state.winner === 0 && r.state.mars && r.state.points === 2, "short: winning while the other has borne off nothing is a марс (2 points)");
  const st2 = make("short", [[0, 1, 1], [1, 6, 14]], { dice: [3, 2] });
  const r2 = E.apply(st2, 0, { type: "turn", steps: [{ from: 1, die: 3 }] });
  ok(r2.ok && !r2.state.mars && r2.state.points === 1, "short: an ordinary win is 1 point");
}

// ---------- long nardy, rule by rule ----------
{
  // Never lands on any of the other player's checkers, even a single one.
  // Seat 1's own 4 is seat 0's 16; seat 0 on 19 with 3-1 may only go 19->18->15.
  eq(E.own("long", 0, E.abs("long", 1, 4)), 16, "long: seat 1's 4 is seat 0's 16");
  const st = make("long", [[0, 19, 1], [1, 4, 1]], { dice: [3, 1] });
  eq(steps(st), ["19/1"], "long: a point with even one of theirs is closed");
}
{
  // Head: one checker per turn...
  const st = make("long", [[0, 24, 15], [1, 24, 15]], { dice: [5, 2], firstTurn: [false, false] });
  const turns = E.allTurns(st);
  ok(turns.every((c) => c.steps.filter((s) => s.from === 24).length <= 1), "long: only one checker leaves the head per turn");
  // ...two on the very first turn with 6-6, 4-4 or 3-3.
  const st6 = make("long", [[0, 24, 15], [1, 24, 15]], { dice: [6, 6], firstTurn: [true, true] });
  ok(E.allTurns(st6).some((c) => c.steps.filter((s) => s.from === 24).length === 2), "long: 6-6 on the first turn takes two from the head");
  const st5 = make("long", [[0, 24, 15], [1, 24, 15]], { dice: [5, 5], firstTurn: [true, true] });
  ok(E.allTurns(st5).every((c) => c.steps.filter((s) => s.from === 24).length <= 1), "long: 5-5 on the first turn still takes one");
}
{
  // Six in a row with nobody of theirs past it is not allowed.
  // Seat 0 holds 18..22 and its head; 24->23 would close 18..23 = seat 1's 6..11.
  const row = [[0, 18, 1], [0, 19, 1], [0, 20, 1], [0, 21, 1], [0, 22, 1], [0, 24, 10]];
  const st = make("long", row.concat([[1, 24, 15]]), { dice: [1, 1] });
  ok(!steps(st).includes("24/1"), "long: a sixth point in a row with none of theirs past it is refused");
  ok(steps(st).length > 0, "long: other moves stay possible");
  const st2 = make("long", row.concat([[1, 24, 14], [1, 3, 1]]), { dice: [1, 1] });
  ok(steps(st2).includes("24/1"), "long: allowed once one of theirs is past it");
}

// ---------- the referee side ----------
{
  const st = E.newGame(players(), { variant: "short" });
  const wrong = 1 - st.turn;
  eq(E.apply(st, wrong, { type: "turn", steps: [] }).error, "illegal", "a turn out of turn is refused");
  eq(E.apply(st, st.turn, { type: "turn", steps: [] }).error, "illegal", "an unfinished turn is refused");
  eq(E.apply(st, st.turn, { type: "roll" }).error, "bad_request", "unknown actions are refused");
  const mv = E.botMove(st, st.turn);
  ok(E.apply(st, st.turn, { type: "turn", steps: mv.steps.concat([{ from: 1, die: 1 }]) }).ok === false, "an extra step after the roll is used up is refused");
  const tm = E.timeout(st);
  ok(tm.state.turn !== st.turn && tm.idle[0] === st.turn && tm.state.last.seat === st.turn, "out of time: the turn is played for the player");
  const v = E.viewFor({ ...st, players: st.players.map((q) => ({ ...q, secretHash: "x", profileId: "anon:1" })) });
  ok(v.players.every((q) => !q.secretHash && !q.profileId), "the view never carries secrets");
}

console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
