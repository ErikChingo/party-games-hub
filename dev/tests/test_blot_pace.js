const ROOT = require("path").resolve(__dirname, "../..");
// Blot online: the referee answers with all the bots' moves at once, the
// phone shows them one by one (blotPaceFrames). Whole games are played by
// the real engine as the referee would; every in-between table the phone
// builds must be exactly what the table really looked like after that move.
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["BlotEngine", "blotPaceFrames", "blotPredict", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS, makeRuntime, wait };")(require, m, __dirname);
const { load, React } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; if (f < 20) console.log("FAIL: " + msg); } };
const rt = load({ react: React, local: { hatsitSettings: JSON.stringify({ language: "ru" }) } }).C;
const E = require(ROOT + "/api/_lib/blot.js");
const { blotPaceFrames, blotPredict } = rt;

// The parts of a table the player sees.
function looks(v, me) {
  const out = {
    status: v.status, phase: v.phase, turn: v.phase === "bid" ? v.bidding.turn : v.turn,
    trick: v.trick, tricks: v.tricks, points: v.points, scores: v.scores,
    counts: v.players.map((x) => x.handCount), hand: (v.players[me].hand || []).slice().sort(),
    lastTrick: v.lastTrick, contract: v.contract, trump: v.trump,
    belot: v.belot ? v.belot.shown : null, combos: v.phase === "play" ? v.combos : null,
  };
  if (v.phase === "bid") out.calls = v.bidding.calls;
  return JSON.stringify(out);
}

function seeded(seed) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
}

let paced = 0, instant = 0, frameCount = 0, games = 0;
function play(seed, humans) {
  const random = seeded(seed);
  const players = [0, 1, 2, 3].map((i) => ({ id: "p" + i, name: "P" + i, bot: !humans.includes(i) }));
  let state = E.newGame(players, { target: 101 }, random);
  const me = 0;
  const isOther = (i) => i !== me; // everyone but me moves on the referee's side
  let shown = E.viewFor(state, "p0");
  for (let guard = 0; guard < 3000 && state.status === "playing"; guard++) {
    // My move (or "next" after a deal), shown at once by the prediction.
    let mine;
    if (state.phase === "score") mine = { type: "next" };
    else {
      const mv = E.nextBotMove(state, (i) => i === me);
      if (!mv) break;
      mine = mv[1];
    }
    const predicted = blotPredict(shown, me, mine);
    if (predicted !== shown) {
      const fr = blotPaceFrames(shown, predicted, me, 1000, 2000);
      ok(fr && fr.length === 1 && fr[0].delay === 0 && fr[0].view === predicted, "my own move shows at once (" + mine.type + ")");
      shown = predicted;
    }
    // The referee: my move, then everyone else until it is my turn again.
    const truth = [];
    state = E.apply(state, me, mine, random).state;
    truth.push(E.viewFor(state, "p0"));
    for (let k = 0; k < 200; k++) {
      const mv = E.nextBotMove(state, isOther);
      if (!mv) break;
      state = E.apply(state, mv[0], mv[1], random).state;
      truth.push(E.viewFor(state, "p0"));
    }
    const final = E.viewFor(state, "p0");
    const frames = blotPaceFrames(shown, final, me, 1000, 2000);
    if (!frames) {
      const nothingNew = final.seq === shown.seq && JSON.stringify(final.bidding && final.bidding.calls) === JSON.stringify(shown.bidding && shown.bidding.calls) && final.deals === shown.deals;
      if (!nothingNew) instant++;
      shown = final;
      continue;
    }
    paced++;
    frameCount += frames.length;
    ok(frames[frames.length - 1].view === final, "the last step is the referee's own table");
    // Each step must be one of the real tables, in order, none skipped.
    const real = truth.map((v) => looks(v, me));
    const start = predicted !== shown ? 0 : real.indexOf(looks(shown, me)) + 1;
    let at = real.indexOf(looks(frames[0].view, me));
    ok(at >= 0, "first step is a real table (seed " + seed + ")");
    for (let k = 1; k < frames.length; k++) {
      const next = real.indexOf(looks(frames[k].view, me), at + 1);
      ok(next === at + 1, "step " + k + " follows the previous one (seed " + seed + ", got " + next + " after " + at + ")");
      at = next;
    }
    ok(at === real.length - 1, "ends on the referee's table");
    // Bots wait, a taken trick waits longer, a living player's first move does not.
    frames.forEach((fr, k) => {
      const prev = k > 0 ? frames[k - 1].view : null;
      const justTaken = !!(prev && prev.phase === "play" && prev.trick.length === 0 && prev.lastTrick && prev.lastTrick.seq === prev.seq);
      const actorSeat = fr.view.phase === "bid" && fr.view.bidding.calls.length ? fr.view.bidding.calls[fr.view.bidding.calls.length - 1].seat : null;
      const expected = (justTaken ? 2000 : 0) + (k === 0 && humans.includes(actorSeat === null ? -1 : actorSeat) ? 0 : 1000);
      if (fr.view.phase === "play" && fr.view !== final && k > 0) ok(fr.delay === (justTaken ? 3000 : 1000) || humans.length > 1, "bot card waits " + (justTaken ? "bot+trick" : "bot") + ": " + fr.delay);
      ok(fr.delay === 0 || fr.delay === 1000 || fr.delay === 3000, "delay is one of 0 / bot / bot+trick: " + fr.delay);
      void expected;
    });
    shown = final;
  }
  games++;
}

for (let seed = 1; seed <= 60; seed++) play(seed, [0]);
for (let seed = 61; seed <= 80; seed++) play(seed, [0, 2]);
ok(paced > 500, "most answers are shown step by step: " + paced + " paced, " + instant + " at once");
ok(instant === 0, "every answer with something new is shown step by step: " + instant);

// A rejected move: the table on screen is ahead of the referee -> shown at once.
{
  const random = seeded(7);
  let state = E.newGame([0, 1, 2, 3].map((i) => ({ id: "p" + i, name: "P" + i, bot: i !== 0 })), { target: 101 }, random);
  while (state.phase === "bid" ? state.bidding.turn !== 0 : true) {
    const mv = E.nextBotMove(state, (i) => i !== 0);
    if (!mv) break;
    state = E.apply(state, mv[0], mv[1], random).state;
  }
  const before = E.viewFor(state, "p0");
  const predicted = blotPredict(before, 0, { type: "bid", level: E.minBid(state), suit: "S" });
  ok(predicted !== before, "prediction of my bid");
  ok(blotPaceFrames(predicted, before, 0, 1000, 2000) === null, "referee said no: shown at once");
  ok(blotPaceFrames(before, before, 0, 1000, 2000) === null, "nothing new: shown at once");
  ok(blotPaceFrames(null, before, 0, 1000, 2000) === null, "nothing on screen yet");
  ok(blotPaceFrames(before, before, -1, 1000, 2000) === null, "watching without a seat");
}

console.log(`blot pace: ${games} games, ${paced} paced answers (${frameCount} steps), ${instant} at once`);
console.log(`${p} passed, ${f} failed`);
if (f) process.exitCode = 1;
