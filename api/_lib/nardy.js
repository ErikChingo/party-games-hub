// Nardy (backgammon) rules engine -- shared by the website (games with a bot
// run in the browser) and by /api/cards (online games, where the server
// rolls the dice). index.html carries a copy of everything between the
// BEGIN/END markers; a test checks the two stay identical.
//
// Two players, 15 checkers each, two dice. Each player counts the points
// from its own side: 24 is where it starts, 1..6 is its home, and it moves
// from higher to lower numbers. All 15 at home -> bear them off; the first
// to bear off all 15 wins. If the loser has not borne off a single checker
// it is a "марс" and counts double.
//
// Short nardy ("короткие", the Armenian նարդի, i.e. backgammon without the
// doubling cube): the players move towards each other. Start: 2 on 24, 5 on
// 13, 3 on 8, 5 on 6. A single checker (a blot) may be hit: it goes to the
// bar and has to come back in (on point 25 - die) before anything else
// moves. A point with two or more checkers is closed to the other player.
// The first move is made with the opening roll (one die each).
//
// Long nardy ("длинные"): both players move the same way round, starting
// with all 15 checkers on their "head" (point 24); the heads are opposite
// each other. Nothing is ever hit: a point with any of the other player's
// checkers is closed. Only one checker may leave the head per turn (two on
// a player's very first turn when it rolls 6-6, 4-4 or 3-3). Six closed
// points in a row are allowed only if at least one of the other player's
// checkers is already past them. The opening roll only decides who starts.
//
// Both: a roll must be used in full if at all possible (doubles = four
// moves); if only one die can be used it must be the larger one when that
// is possible. A whole turn is sent at once: { type: "turn", steps: [{ from,
// die }, ...] } with `from` the player's own point (25 = the bar).
//
// The board: state.board[a], a = 0..23 the same for both players; > 0 are
// seat 0's (white) checkers, < 0 seat 1's (black).

/* NARDY-ENGINE-BEGIN */
const NardyEngine = (function () {
  const CHECKERS = 15;
  const BAR = 25;
  const VARIANTS = ["short", "long"];
  const LEVELS = ["easy", "normal"];

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const rollDie = (random) => 1 + Math.floor((random || Math.random)() * 6);

  // A seat's own point (1..24) <-> the shared board index (0..23).
  function abs(variant, seat, p) {
    if (seat === 0) return p - 1;
    return variant === "long" ? (p + 11) % 24 : 24 - p;
  }
  function own(variant, seat, a) {
    if (seat === 0) return a + 1;
    return variant === "long" ? ((a + 12) % 24) + 1 : 24 - a;
  }
  const sign = (seat) => (seat === 0 ? 1 : -1);
  function mine(pos, variant, seat, p) {
    const v = pos.b[abs(variant, seat, p)] * sign(seat);
    return v > 0 ? v : 0;
  }
  function theirs(pos, variant, seat, p) {
    const v = pos.b[abs(variant, seat, p)] * sign(seat);
    return v < 0 ? -v : 0;
  }
  const posKey = (pos) => pos.b.join(",") + "|" + pos.bar.join(",") + "|" + pos.off.join(",");
  const copyPos = (pos) => ({ b: pos.b.slice(), bar: pos.bar.slice(), off: pos.off.slice() });

  function startPosition(variant) {
    const pos = { b: new Array(24).fill(0), bar: [0, 0], off: [0, 0] };
    const layout = variant === "long" ? [[24, 15]] : [[24, 2], [13, 5], [8, 3], [6, 5]];
    [0, 1].forEach((seat) => layout.forEach(([p, n]) => (pos.b[abs(variant, seat, p)] += n * sign(seat))));
    return pos;
  }

  // Everything at home (points 1..6), nothing on the bar.
  function allHome(pos, variant, seat) {
    if (pos.bar[seat] > 0) return false;
    for (let p = 7; p <= 24; p++) if (mine(pos, variant, seat, p) > 0) return false;
    return true;
  }
  function pips(pos, variant, seat) {
    let n = pos.bar[seat] * 25;
    for (let p = 1; p <= 24; p++) n += mine(pos, variant, seat, p) * p;
    return n;
  }

  // Long nardy: six of my points in a row are fine only if one of the other
  // player's checkers is already past them (only a run that really is six in
  // a row on the other player's way can shut it in). Only rows through
  // point `at` (where a checker just landed) are checked: a row made earlier,
  // when it was allowed, never blocks later moves.
  function blockAllowed(pos, seat, at) {
    const other = 1 - seat;
    let run = 0;
    for (let p = 24; p >= 1; p--) {
      run = mine(pos, "long", seat, p) > 0 ? run + 1 : 0;
      if (run < 6 || at < p || at > p + 5) continue;
      const theirsPts = [];
      for (let k = p; k < p + 6; k++) theirsPts.push(own("long", other, abs("long", seat, k)));
      const lo = Math.min.apply(null, theirsPts);
      if (Math.max.apply(null, theirsPts) - lo !== 5) continue; // split on their way: shuts nothing in
      let past = false;
      for (let q = 1; q < lo && !past; q++) if (mine(pos, "long", other, q) > 0) past = true;
      if (!past) return false;
    }
    return true;
  }

  // ---------- one turn: a position plus the dice still to use ----------
  // ctx = { variant, seat, pos, dice: [remaining], used: [], headMoves, headLimit, steps: [] }
  function turnContext(state) {
    const seat = state.turn;
    const variant = state.settings.variant;
    const d = state.dice || [];
    const dice = d.length === 2 && d[0] === d[1] ? [d[0], d[0], d[0], d[0]] : d.slice();
    const first = variant === "long" && state.firstTurn && state.firstTurn[seat];
    const headLimit = variant === "long" ? (first && d[0] === d[1] && [6, 4, 3].includes(d[0]) ? 2 : 1) : 99;
    return { variant, seat, pos: copyPos({ b: state.board, bar: state.bar, off: state.off }), dice, headMoves: 0, headLimit, steps: [] };
  }

  // Where one checker would go with one die, or null if it may not.
  function stepTarget(ctx, from, die) {
    const { pos, variant, seat } = ctx;
    if (variant === "short" && pos.bar[seat] > 0 && from !== BAR) return null;
    if (from === BAR) {
      if (variant !== "short" || pos.bar[seat] === 0) return null;
      const to = 25 - die;
      return theirs(pos, variant, seat, to) <= 1 ? to : null;
    }
    if (from < 1 || from > 24 || mine(pos, variant, seat, from) === 0) return null;
    if (variant === "long" && from === 24 && ctx.headMoves >= ctx.headLimit) return null;
    const to = from - die;
    if (to >= 1) {
      const t = theirs(pos, variant, seat, to);
      if (variant === "long" ? t > 0 : t > 1) return null;
      return to;
    }
    if (!allHome(pos, variant, seat)) return null;
    if (to === 0) return 0;
    for (let p = from + 1; p <= 6; p++) if (mine(pos, variant, seat, p) > 0) return null;
    return 0;
  }
  function applyStep(ctx, from, die) {
    const to = stepTarget(ctx, from, die);
    if (to === null) return null;
    const { variant, seat } = ctx;
    const pos = copyPos(ctx.pos);
    const s = sign(seat);
    let hit = false;
    if (from === BAR) pos.bar[seat] -= 1;
    else pos.b[abs(variant, seat, from)] -= s;
    if (to === 0) pos.off[seat] += 1;
    else {
      const a = abs(variant, seat, to);
      if (pos.b[a] * s < 0) {
        pos.b[a] = 0;
        pos.bar[1 - seat] += 1;
        hit = true;
      }
      pos.b[a] += s;
    }
    if (variant === "long" && to > 0 && !blockAllowed(pos, seat, to)) return null;
    const k = ctx.dice.indexOf(die);
    const dice = ctx.dice.slice();
    dice.splice(k, 1);
    return {
      ...ctx,
      pos,
      dice,
      headMoves: ctx.headMoves + (variant === "long" && from === 24 ? 1 : 0),
      steps: ctx.steps.concat([{ from, die, to, hit }]),
    };
  }
  function rawSteps(ctx) {
    const out = [];
    const seen = new Set();
    ctx.dice.forEach((die) => {
      if (seen.has(die)) return;
      seen.add(die);
      const froms = ctx.variant === "short" && ctx.pos.bar[ctx.seat] > 0 ? [BAR] : [];
      if (!froms.length) for (let p = 24; p >= 1; p--) if (mine(ctx.pos, ctx.variant, ctx.seat, p) > 0) froms.push(p);
      froms.forEach((from) => {
        const next = applyStep(ctx, from, die);
        if (next) out.push({ from, die, to: next.steps[next.steps.length - 1].to, next });
      });
    });
    return out;
  }
  const ctxKey = (ctx) => posKey(ctx.pos) + "#" + ctx.dice.slice().sort().join("") + "#" + ctx.headMoves;
  // How many of the remaining dice can still be used, at most.
  function maxUse(ctx, memo) {
    if (ctx.dice.length === 0) return 0;
    const key = ctxKey(ctx);
    if (memo.has(key)) return memo.get(key);
    let best = 0;
    const steps = rawSteps(ctx);
    for (let i = 0; i < steps.length && best < ctx.dice.length; i++) best = Math.max(best, 1 + maxUse(steps[i].next, memo));
    memo.set(key, best);
    return best;
  }
  // The single moves allowed now: each one keeps the most dice playable.
  function legalSteps(ctx) {
    const memo = new Map();
    const need = maxUse(ctx, memo);
    if (need === 0) return [];
    let steps = rawSteps(ctx).filter((s) => 1 + maxUse(s.next, memo) === need);
    // Only one of two different dice can be played: the larger one if it can.
    if (need === 1 && ctx.steps.length === 0 && ctx.dice.length === 2 && ctx.dice[0] !== ctx.dice[1]) {
      const big = Math.max(ctx.dice[0], ctx.dice[1]);
      if (steps.some((s) => s.die === big)) steps = steps.filter((s) => s.die === big);
    }
    return steps;
  }
  function ctxStep(ctx, from, die) {
    const s = legalSteps(ctx).find((x) => x.from === from && x.die === die);
    return s ? s.next : null;
  }
  const turnOver = (ctx) => legalSteps(ctx).length === 0;

  // ---------- setting up ----------
  function note(state, entry) {
    state.seq += 1;
    state.log.push({ seq: state.seq, ...entry });
    if (state.log.length > 40) state.log = state.log.slice(-40);
  }
  function newGame(players, settings, random) {
    random = random || Math.random;
    const variant = VARIANTS.includes(settings && settings.variant) ? settings.variant : "short";
    const level = LEVELS.includes(settings && settings.level) ? settings.level : "normal";
    const pos = startPosition(variant);
    let a = rollDie(random);
    let b = rollDie(random);
    while (a === b) {
      a = rollDie(random);
      b = rollDie(random);
    }
    const state = {
      v: 1,
      game: "nardy",
      status: "playing",
      settings: { variant, level },
      players: players.slice(0, 2).map((p) => ({ ...p, afk: p.afk || 0 })),
      board: pos.b,
      bar: pos.bar,
      off: pos.off,
      opening: [a, b],
      turn: a > b ? 0 : 1,
      dice: null,
      firstTurn: [true, true],
      turns: 0,
      last: null,
      winner: null,
      mars: false,
      points: 0,
      seq: 0,
      log: [],
    };
    note(state, { t: "opening", dice: [a, b] });
    // Short nardy plays the opening roll itself; long nardy rolls afresh.
    beginTurn(state, random, variant === "short" ? [Math.max(a, b), Math.min(a, b)] : null);
    return state;
  }
  // Rolls for state.turn; a roll that cannot be played at all passes on
  // (it stays in state.last so it can be shown).
  function beginTurn(state, random, given) {
    for (let guard = 0; guard < 12; guard++) {
      state.dice = given || [rollDie(random), rollDie(random)];
      given = null;
      if (!turnOver(turnContext(state))) return;
      state.last = { seat: state.turn, dice: state.dice.slice(), steps: [], blocked: true };
      note(state, { t: "blocked", p: state.turn, dice: state.dice.slice() });
      state.firstTurn[state.turn] = false;
      state.turns += 1;
      state.turn = 1 - state.turn;
    }
  }

  // ---------- doing things ----------
  // action: { type: "turn", steps: [{ from, die }, ...] } -- a whole turn.
  function apply(input, seat, action, random) {
    if (!input || input.status !== "playing") return { ok: false, error: "not_playing" };
    if (!action || action.type !== "turn" || !Array.isArray(action.steps) || action.steps.length > 4) return { ok: false, error: "bad_request" };
    if (input.turn !== seat || !input.dice) return { ok: false, error: "illegal" };
    let ctx = turnContext(input);
    for (const s of action.steps) {
      const next = s && ctxStep(ctx, Number(s.from), Number(s.die));
      if (!next) return { ok: false, error: "illegal" };
      ctx = next;
    }
    if (!turnOver(ctx)) return { ok: false, error: "illegal" };
    const state = clone(input);
    state.board = ctx.pos.b;
    state.bar = ctx.pos.bar;
    state.off = ctx.pos.off;
    state.last = { seat, dice: input.dice.slice(), steps: ctx.steps.map((s) => ({ from: s.from, to: s.to, die: s.die, hit: s.hit })) };
    note(state, { t: "turn", p: seat, dice: input.dice.slice(), n: ctx.steps.length });
    state.firstTurn[seat] = false;
    state.turns += 1;
    if (state.off[seat] >= CHECKERS) {
      state.status = "ended";
      state.winner = seat;
      state.mars = state.off[1 - seat] === 0;
      state.points = state.mars ? 2 : 1;
      state.dice = null;
      state.turn = null;
      note(state, { t: "won", p: seat, mars: state.mars });
      return { ok: true, state };
    }
    state.turn = 1 - seat;
    beginTurn(state, random);
    return { ok: true, state };
  }

  // ---------- bots ----------
  // Every different way to play the whole roll, ending positions deduplicated.
  function allTurns(state) {
    const out = new Map();
    const seen = new Set();
    (function walk(ctx) {
      const key = ctxKey(ctx);
      if (seen.has(key)) return;
      seen.add(key);
      const steps = legalSteps(ctx);
      if (steps.length === 0) {
        const k = posKey(ctx.pos);
        if (!out.has(k)) out.set(k, ctx);
        return;
      }
      steps.forEach((s) => walk(s.next));
    })(turnContext(state));
    return Array.from(out.values());
  }
  // How good a position is for `seat` (bigger is better).
  function evaluate(pos, variant, seat) {
    const other = 1 - seat;
    if (pos.off[seat] >= CHECKERS) return 1e6;
    let score = pips(pos, variant, other) - pips(pos, variant, seat) + 4 * (pos.off[seat] - pos.off[other]);
    // The other player's checkers, as points in their own numbering.
    const theirOwn = [];
    for (let q = 1; q <= 24; q++) if (mine(pos, variant, other, q) > 0) theirOwn.push(q);
    if (pos.bar[other] > 0) theirOwn.push(BAR);
    let made = 0;
    let run = 0;
    let bestRun = 0;
    for (let p = 1; p <= 24; p++) {
      const n = mine(pos, variant, seat, p);
      // My point p in their numbering: they still have to pass it from any higher point.
      const op = own(variant, other, abs(variant, seat, p));
      if (n > 3) score -= 0.6 * (n - 3);
      if (variant === "short") {
        if (n >= 2) {
          made += p <= 7 ? 3 : 2;
          run += 1;
        } else run = 0;
        if (n === 1) {
          // A blot: what being hit costs, times how many of theirs are in reach.
          let near = 0;
          let far = 0;
          theirOwn.forEach((q) => {
            const dist = q - op;
            if (dist >= 1 && dist <= 6) near += 1;
            else if (dist >= 7 && dist <= 12) far += 1;
          });
          score -= (near + far * 0.35) * ((25 - p) / 8);
        }
      } else if (n > 0) {
        made += 0.5;
        // A run of mine that their checkers still have to get past holds them up.
        run = theirOwn.some((q) => q > op) ? run + 1 : 0;
      } else run = 0;
      bestRun = Math.max(bestRun, run);
    }
    score += made + (variant === "short" ? 0.8 : 0.9) * bestRun * bestRun;
    if (variant === "short") score += 6 * pos.bar[other] - 6 * pos.bar[seat];
    return score;
  }
  function chooseTurn(state, seat, random) {
    random = random || Math.random;
    const turns = allTurns(state);
    if (turns.length === 0) return [];
    const variant = state.settings.variant;
    const noise = state.settings.level === "easy" ? 14 : 0;
    let best = null;
    let bestScore = -Infinity;
    turns.forEach((ctx) => {
      const s = evaluate(ctx.pos, variant, seat) + (noise ? (random() - 0.5) * noise : 0);
      if (s > bestScore) {
        bestScore = s;
        best = ctx;
      }
    });
    return best.steps.map((s) => ({ from: s.from, die: s.die }));
  }
  function botMove(state, seat, random) {
    if (!state || state.status !== "playing" || state.turn !== seat || !state.dice) return null;
    return { type: "turn", steps: chooseTurn(state, seat, random) };
  }
  function nextBotMove(state, isBot) {
    if (!state || state.status !== "playing" || state.turn === null || !isBot(state.turn)) return null;
    const m = botMove(state, state.turn);
    return m ? [state.turn, m] : null;
  }

  // ---------- a player who does not move in time ----------
  // The turn is played for them (the way the easy bot would).
  function timeout(input, random) {
    if (!input || input.status !== "playing" || input.turn === null) return { state: input, idle: [] };
    const seat = input.turn;
    const easy = { ...input, settings: { ...input.settings, level: "easy" } };
    const result = apply(input, seat, { type: "turn", steps: chooseTurn(easy, seat, random) }, random);
    return { state: result.ok ? result.state : input, idle: [seat] };
  }

  // ---------- what one player is allowed to see ----------
  // Nothing is hidden in nardy; only the seats' secrets are taken out.
  function viewFor(state) {
    const out = clone(state);
    out.players = state.players.map((p) => {
      const q = { ...p };
      delete q.secretHash;
      delete q.profileId;
      return q;
    });
    return out;
  }

  return {
    CHECKERS, BAR, VARIANTS, LEVELS,
    abs, own, startPosition, pips, allHome, blockAllowed, posKey,
    turnContext, legalSteps, ctxStep, turnOver, allTurns, evaluate, chooseTurn,
    newGame, apply, timeout, botMove, nextBotMove, viewFor,
  };
})();
/* NARDY-ENGINE-END */

if (typeof module !== "undefined" && module.exports) module.exports = NardyEngine;
