// Blot ("Блот", Armenian bazaar belote) rules engine -- shared by the
// website (games against bots run in the browser) and by /api/cards
// (online games, where the server is the referee). index.html carries a
// copy of everything between the BEGIN/END markers; a test checks the two
// stay identical, so edit this file and re-run the copy step.
//
// Four players in two pairs: seats 0 and 2 against 1 and 3. 32 cards
// (7..A), 8 each. Cards are strings like Durak's: "7S", "10H", "11D" (jack),
// "12" queen, "13" king, "14" ace; suits S C D H.
//
// A deal: bidding (a number from 8 up and a trump suit, or "N" = no trump;
// 25 = капут, all eight tricks), then eight tricks, then scoring.
//
// The rules used here (Armenian home rules differ in details; these follow
// the common online variant):
//  * Bids rise by at least 1. Three passes after a bid end the bidding;
//    four passes with no bid -> the cards are dealt again by the next dealer.
//  * An opponent of the highest bidder may say "контра" on their turn
//    (doubles); the bidding pair may answer "реконтра" (x4). Either ends
//    the bidding.
//  * Follow suit. Cannot: if your partner is winning the trick, play
//    anything; otherwise you must trump, and beat a trump already played if
//    you can (if you cannot, play anything). Trump led: you must beat the
//    highest trump on the table if you can.
//  * Combinations are announced automatically at the start of play:
//    sequences of 3 / 4 / 5+ in a suit = 20 / 50 / 100, four jacks 200, four
//    nines 140, four aces 110, four tens, kings or queens 100 (no trump:
//    four aces 190, four jacks/tens/kings/queens 100, nines 0). Only the
//    pair with the best combination scores its combinations. King + queen
//    of trump in one hand ("блот") = 20 for its holder, always.
//  * Card points: trump J 20, 9 14, A 11, 10 10, K 4, Q 3; other suits
//    A 11, 10 10, K 4, Q 3, J 2; no trump A 19, 10 10, K 4, Q 3, J 2. Last
//    trick +10. All eight tricks to one pair: +90.
//  * The contract is made when the bidding pair's points (cards, last
//    trick, its combinations, блот) reach bid x 10; капут needs all eight
//    tricks. Made: both pairs score their own points / 10 and the bidders
//    add the bid. After a контра the bidders take everything. Failed: the
//    opponents take everything plus the bid. The bid counts x2 for контра,
//    x4 for реконтра, and x2 again for no trump. Points are divided by 10
//    and rounded (a half goes down).
//  * The first pair to reach the target (101 / 201 / 301) wins.

/* BLOT-ENGINE-BEGIN */
const BlotEngine = (function () {
  const SUITS = ["S", "C", "D", "H"];
  const RANKS = [7, 8, 9, 10, 11, 12, 13, 14];
  const HAND = 8;
  const CAPUT = 25;
  const TARGETS = [101, 201, 301];
  const MAX_DEALS = 60;

  const rank = (card) => parseInt(card, 10);
  const suit = (card) => card.slice(-1);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const team = (seat) => seat % 2;
  const next = (seat) => (seat + 1) % 4;

  function makeDeck() {
    const deck = [];
    SUITS.forEach((s) => RANKS.forEach((r) => deck.push(r + s)));
    return deck;
  }
  function shuffle(list, random) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }
  const TRUMP_ORDER = [7, 8, 12, 13, 10, 14, 9, 11];
  const PLAIN_ORDER = [7, 8, 9, 11, 12, 13, 10, 14];
  // Strength of a card within its suit (higher beats lower).
  function power(card, trump) {
    return (suit(card) === trump ? TRUMP_ORDER : PLAIN_ORDER).indexOf(rank(card));
  }
  function points(card, trump) {
    const r = rank(card);
    if (trump === "N") return { 14: 19, 10: 10, 13: 4, 12: 3, 11: 2 }[r] || 0;
    if (suit(card) === trump) return { 11: 20, 9: 14, 14: 11, 10: 10, 13: 4, 12: 3 }[r] || 0;
    return { 14: 11, 10: 10, 13: 4, 12: 3, 11: 2 }[r] || 0;
  }
  function sortHand(hand, trump) {
    const order = (c) => SUITS.indexOf(suit(c)) * 100 + (trump && trump !== "N" && suit(c) === trump ? 400 : 0) + power(c, trump);
    return hand.slice().sort((a, b) => order(a) - order(b));
  }
  const handSize = (p) => (p.hand ? p.hand.length : p.handCount || 0);

  // ---------- the trick ----------
  // Index (in trick) of the card winning so far.
  function trickLeader(trick, trump) {
    if (trick.length === 0) return -1;
    const led = suit(trick[0].card);
    let best = 0;
    for (let k = 1; k < trick.length; k++) {
      const c = trick[k].card;
      const b = trick[best].card;
      const cTrump = trump !== "N" && suit(c) === trump;
      const bTrump = trump !== "N" && suit(b) === trump;
      if (cTrump && !bTrump) best = k;
      else if (cTrump === bTrump && suit(c) === suit(b) && power(c, trump) > power(b, trump)) best = k;
      else if (!cTrump && !bTrump && suit(c) === led && suit(b) !== led) best = k;
    }
    return best;
  }
  function legalCards(state, seat) {
    const hand = state.players[seat].hand || [];
    const trick = state.trick;
    const trump = state.trump;
    if (trick.length === 0) return hand.slice();
    const led = suit(trick[0].card);
    const follow = hand.filter((c) => suit(c) === led);
    const topTrump = () => {
      let top = -1;
      trick.forEach((t) => {
        if (suit(t.card) === trump) top = Math.max(top, power(t.card, trump));
      });
      return top;
    };
    if (trump === "N") return follow.length ? follow : hand.slice();
    if (led === trump) {
      if (!follow.length) return hand.slice();
      const top = topTrump();
      const over = follow.filter((c) => power(c, trump) > top);
      return over.length ? over : follow;
    }
    if (follow.length) return follow;
    const winner = trick[trickLeader(trick, trump)].seat;
    if (team(winner) === team(seat)) return hand.slice();
    const trumps = hand.filter((c) => suit(c) === trump);
    if (!trumps.length) return hand.slice();
    const top = topTrump();
    if (top < 0) return trumps;
    const over = trumps.filter((c) => power(c, trump) > top);
    return over.length ? over : hand.slice();
  }

  // ---------- combinations ----------
  const QUAD_VALUES = { 11: 200, 9: 140, 14: 110, 10: 100, 13: 100, 12: 100 };
  const QUAD_VALUES_N = { 14: 190, 11: 100, 10: 100, 13: 100, 12: 100 };
  function findCombos(hand, trump) {
    const out = [];
    const used = new Set();
    const values = trump === "N" ? QUAD_VALUES_N : QUAD_VALUES;
    Object.keys(values).forEach((r) => {
      const cards = SUITS.map((s) => r + s);
      if (values[r] > 0 && cards.every((c) => hand.includes(c))) {
        out.push({ kind: "quad", rank: Number(r), value: values[r], cards });
        cards.forEach((c) => used.add(c));
      }
    });
    SUITS.forEach((s) => {
      const have = RANKS.filter((r) => hand.includes(r + s) && !used.has(r + s));
      let run = [];
      const flush = () => {
        if (run.length >= 3) {
          const len = run.length;
          out.push({ kind: "seq", suit: s, len, top: run[len - 1], value: len >= 5 ? 100 : len === 4 ? 50 : 20, cards: run.map((r) => r + s) });
        }
        run = [];
      };
      RANKS.forEach((r) => {
        if (have.includes(r)) run.push(r);
        else flush();
      });
      flush();
    });
    return out;
  }
  // Compare two combinations: > 0 when a is better.
  function comboKey(c, trump) {
    if (c.kind === "quad") return [2, c.value, c.rank, 0];
    return [1, Math.min(c.len, 5), c.top, c.suit === trump ? 1 : 0];
  }
  function compareCombos(a, b, trump) {
    const ka = comboKey(a, trump);
    const kb = comboKey(b, trump);
    for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) return ka[k] - kb[k];
    return 0;
  }
  // Who scores combinations this deal: the pair holding the best one (an
  // exact tie goes to the player who plays first).
  function settleCombos(state) {
    const all = [];
    for (let k = 0; k < 4; k++) {
      const seat = (state.leader + k) % 4;
      findCombos(state.players[seat].hand, state.trump).forEach((c) => all.push({ seat, ...c }));
    }
    let best = null;
    all.forEach((c) => {
      if (!best || compareCombos(c, best, state.trump) > 0) best = c;
    });
    const winnerTeam = best ? team(best.seat) : null;
    state.combos = all.map((c) => ({ ...c, counts: winnerTeam !== null && team(c.seat) === winnerTeam }));
    state.comboTeam = winnerTeam;
    state.belot = null;
    if (state.trump !== "N") {
      for (let seat = 0; seat < 4; seat++) {
        const h = state.players[seat].hand;
        if (h.includes("13" + state.trump) && h.includes("12" + state.trump)) state.belot = { seat, shown: false };
      }
    }
  }

  // ---------- setting up ----------
  function newGame(players, settings, random) {
    random = random || Math.random;
    const target = TARGETS.includes(Number(settings && settings.target)) ? Number(settings.target) : 101;
    const state = {
      v: 1,
      game: "blot",
      status: "playing",
      settings: { target },
      players: players.slice(0, 4).map((p) => ({ ...p, hand: [], afk: p.afk || 0 })),
      dealer: Math.floor(random() * 4),
      deals: 0,
      scores: [0, 0],
      history: [],
      seq: 0,
      log: [],
      winner: null,
    };
    startDeal(state, random);
    return state;
  }
  function startDeal(state, random) {
    random = random || Math.random;
    const deck = shuffle(makeDeck(), random);
    // 3 + 3 + 2, starting left of the dealer.
    state.players.forEach((p) => {
      p.hand = [];
    });
    let k = 0;
    [3, 3, 2].forEach((n) => {
      for (let i = 1; i <= 4; i++) {
        const seat = (state.dealer + i) % 4;
        for (let j = 0; j < n; j++) state.players[seat].hand.push(deck[k++]);
      }
    });
    state.deals += 1;
    state.phase = "bid";
    state.bidding = { turn: next(state.dealer), high: null, passes: 0, contra: 0, contraBy: null, calls: [] };
    state.contract = null;
    state.trump = null;
    state.trick = [];
    state.leader = next(state.dealer);
    state.turn = state.bidding.turn;
    state.points = [0, 0];
    state.tricks = [0, 0];
    state.lastTrick = null;
    state.combos = [];
    state.comboTeam = null;
    state.belot = null;
    state.result = null;
  }
  function note(state, entry) {
    state.seq += 1;
    state.log.push({ seq: state.seq, ...entry });
    if (state.log.length > 40) state.log = state.log.slice(-40);
  }

  // ---------- what a player may do ----------
  function minBid(state) {
    const high = state.bidding && state.bidding.high;
    return high ? Math.min(CAPUT, high.level + 1) : 8;
  }
  function canBid(state, seat, level, s) {
    if (state.status !== "playing" || state.phase !== "bid" || state.bidding.turn !== seat || state.bidding.contra) return false;
    if (!["S", "C", "D", "H", "N"].includes(s)) return false;
    const high = state.bidding.high;
    if (high && high.level >= CAPUT) return false;
    level = Number(level);
    if (!Number.isInteger(level) || level < minBid(state) || level > CAPUT) return false;
    return true;
  }
  function canContra(state, seat) {
    const b = state.bidding;
    return state.status === "playing" && state.phase === "bid" && b.turn === seat && !!b.high && !b.contra && team(b.high.seat) !== team(seat);
  }
  function canRecontra(state, seat) {
    const b = state.bidding;
    return state.status === "playing" && state.phase === "bid" && b.turn === seat && b.contra === 1 && !!b.high && team(b.high.seat) === team(seat);
  }
  function canPassBid(state, seat) {
    return state.status === "playing" && state.phase === "bid" && state.bidding.turn === seat;
  }
  function canPlay(state, seat, card) {
    return state.status === "playing" && state.phase === "play" && state.turn === seat && legalCards(state, seat).includes(card);
  }

  // ---------- doing things ----------
  // action: { type: "bid", level, suit } | { type: "pass" } | { type: "contra" }
  //       | { type: "recontra" } | { type: "play", card } | { type: "next" }
  function apply(input, seat, action, random) {
    const state = clone(input);
    if (state.status !== "playing") return { ok: false, error: "not_playing" };
    if (!state.players[seat] || !action) return { ok: false, error: "bad_request" };
    const b = state.bidding;
    switch (action.type) {
      case "bid":
        if (!canBid(state, seat, action.level, action.suit)) return { ok: false, error: "illegal" };
        b.high = { level: Number(action.level), suit: action.suit, seat };
        b.passes = 0;
        b.calls.push({ seat, t: "bid", level: Number(action.level), suit: action.suit });
        note(state, { t: "bid", p: seat, level: Number(action.level), suit: action.suit });
        b.turn = next(seat);
        break;
      case "pass":
        if (state.phase !== "bid") return { ok: false, error: "illegal" };
        if (!canPassBid(state, seat)) return { ok: false, error: "illegal" };
        b.calls.push({ seat, t: "pass" });
        if (b.contra === 1) {
          // The bidders let the контра stand.
          return { ok: true, state: finishBidding(state) };
        }
        b.passes += 1;
        if (!b.high && b.passes >= 4) {
          note(state, { t: "redeal" });
          state.dealer = next(state.dealer);
          startDeal(state, random);
          return { ok: true, state };
        }
        if (b.high && b.passes >= 3) return { ok: true, state: finishBidding(state) };
        b.turn = next(seat);
        break;
      case "contra":
        if (!canContra(state, seat)) return { ok: false, error: "illegal" };
        b.contra = 1;
        b.contraBy = seat;
        b.calls.push({ seat, t: "contra" });
        note(state, { t: "contra", p: seat });
        // The bidding pair answers: the next of them after this player.
        b.turn = next(seat);
        break;
      case "recontra":
        if (!canRecontra(state, seat)) return { ok: false, error: "illegal" };
        b.contra = 2;
        b.calls.push({ seat, t: "recontra" });
        note(state, { t: "recontra", p: seat });
        return { ok: true, state: finishBidding(state) };
      case "play": {
        if (!canPlay(state, seat, action.card)) return { ok: false, error: "illegal" };
        const p = state.players[seat];
        if (state.trick.length === 0 && state.tricks[0] + state.tricks[1] === 0 && !state.combosShown) state.combosShown = true;
        p.hand.splice(p.hand.indexOf(action.card), 1);
        state.trick.push({ seat, card: action.card });
        if (state.belot && state.belot.seat === seat && (rank(action.card) === 12 || rank(action.card) === 13) && suit(action.card) === state.trump) state.belot.shown = true;
        note(state, { t: "play", p: seat, c: action.card });
        if (state.trick.length < 4) {
          state.turn = next(seat);
        } else {
          closeTrick(state);
        }
        break;
      }
      case "next":
        if (state.phase !== "score") return { ok: false, error: "illegal" };
        state.dealer = next(state.dealer);
        startDeal(state, random);
        break;
      default:
        return { ok: false, error: "bad_request" };
    }
    return { ok: true, state };
  }
  function finishBidding(state) {
    const b = state.bidding;
    const high = b.high;
    state.contract = { level: high.level, suit: high.suit, seat: high.seat, team: team(high.seat), contra: b.contra };
    state.trump = high.suit;
    state.phase = "play";
    state.leader = next(state.dealer);
    state.turn = state.leader;
    state.trick = [];
    state.combosShown = false;
    settleCombos(state);
    note(state, { t: "contract", p: high.seat, level: high.level, suit: high.suit, contra: b.contra });
    return state;
  }
  function closeTrick(state) {
    const w = state.trick[trickLeader(state.trick, state.trump)].seat;
    let pts = state.trick.reduce((sum, t) => sum + points(t.card, state.trump), 0);
    const last = state.tricks[0] + state.tricks[1] === 7;
    if (last) pts += 10;
    state.points[team(w)] += pts;
    state.tricks[team(w)] += 1;
    state.lastTrick = { cards: state.trick, winner: w, seq: state.seq + 1 };
    note(state, { t: "trick", p: w, n: pts });
    state.trick = [];
    state.turn = w;
    if (last) scoreDeal(state);
  }
  const round10 = (x) => Math.floor((x + 4) / 10);
  function scoreDeal(state) {
    const c = state.contract;
    const bid = c.team;
    const opp = 1 - bid;
    const combo = [0, 0];
    state.combos.forEach((x) => {
      if (x.counts) combo[team(x.seat)] += x.value;
    });
    const belot = [0, 0];
    if (state.belot) belot[team(state.belot.seat)] += 20;
    const capot = state.tricks[0] === 8 ? 0 : state.tricks[1] === 8 ? 1 : null;
    const cards = state.points.slice();
    if (capot !== null) cards[capot] += 90;
    const total = [cards[0] + combo[0] + belot[0], cards[1] + combo[1] + belot[1]];
    const made = c.level >= CAPUT ? state.tricks[bid] === 8 : total[bid] >= c.level * 10;
    const bidValue = c.level * (c.contra === 2 ? 4 : c.contra === 1 ? 2 : 1) * (c.suit === "N" ? 2 : 1);
    const gain = [0, 0];
    if (made && !c.contra) {
      gain[bid] = round10(total[bid]) + bidValue;
      gain[opp] = round10(total[opp]);
    } else if (made) {
      gain[bid] = round10(total[0] + total[1]) + bidValue;
    } else {
      gain[opp] = round10(total[0] + total[1]) + bidValue;
    }
    state.scores = [state.scores[0] + gain[0], state.scores[1] + gain[1]];
    state.result = { made, total, cards, combo, belot, capot, gain, bidValue };
    state.history.push({ deal: state.deals, contract: c, made, gain });
    if (state.history.length > 30) state.history = state.history.slice(-30);
    state.phase = "score";
    state.turn = null;
    note(state, { t: "score", made, gain });
    const target = state.settings.target;
    const reached = state.scores[0] >= target || state.scores[1] >= target;
    if ((reached && state.scores[0] !== state.scores[1]) || state.deals >= MAX_DEALS) {
      state.status = "ended";
      state.winner = state.scores[0] === state.scores[1] ? null : state.scores[0] > state.scores[1] ? 0 : 1;
      note(state, { t: "end", winner: state.winner });
    }
  }

  // ---------- a player who does not move in time ----------
  function timeout(input, random) {
    const state = clone(input);
    if (state.status !== "playing") return { state, idle: [] };
    if (state.phase === "bid") {
      const seat = state.bidding.turn;
      return { state: apply(state, seat, { type: "pass" }, random).state, idle: [seat] };
    }
    if (state.phase === "play") {
      const seat = state.turn;
      const legal = sortHand(legalCards(state, seat), state.trump);
      const card = legal.slice().sort((a, b) => points(a, state.trump) - points(b, state.trump))[0];
      return { state: apply(state, seat, { type: "play", card }, random).state, idle: [seat] };
    }
    if (state.phase === "score") return { state: apply(state, 0, { type: "next" }, random).state, idle: [] };
    return { state, idle: [] };
  }

  // ---------- bots ----------
  // What a hand is worth with this trump, roughly in card points the pair
  // can expect to take (the partner is assumed to bring an average hand).
  function handValue(hand, s) {
    let v = 0;
    const trumps = s === "N" ? [] : hand.filter((c) => suit(c) === s);
    hand.forEach((c) => {
      v += points(c, s);
      if (s !== "N" && suit(c) !== s && rank(c) === 14) v += 4;
      if (s === "N" && rank(c) === 14) v += 6;
    });
    if (s !== "N") {
      v += Math.max(0, trumps.length - 2) * 9;
      if (!trumps.some((c) => rank(c) === 11)) v -= 18;
      if (trumps.length < 3) v -= 25;
    } else {
      const aces = hand.filter((c) => rank(c) === 14).length;
      if (aces < 3) v -= 40;
    }
    const combos = findCombos(hand, s);
    combos.forEach((c) => {
      v += c.value * 0.8;
    });
    if (s !== "N" && hand.includes("13" + s) && hand.includes("12" + s)) v += 20;
    return v + 32;
  }
  // How many points this pair can expect to take with trump `s`, played by
  // `bidder`: the unseen 24 cards are dealt at random many times and each
  // deal is played out by the bots (who only ever look at their own cards
  // and the table). Seeded from the hand, so a bot always says the same
  // thing about the same cards.
  function seeded(seed) {
    let x = seed >>> 0 || 1;
    return () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >> 17;
      x ^= x << 5;
      x >>>= 0;
      return x / 4294967296;
    };
  }
  const SAMPLES = 14;
  // Points kept in reserve when bidding (the partner's cards are unknown).
  const MARGIN = Number((typeof process !== "undefined" && process.env && process.env.BLOT_MARGIN) || 25);
  function estimate(state, seat, s, bidder, samples, salt) {
    const mine = state.players[seat].hand;
    let h = 7;
    mine.concat([s, String(bidder), String(state.deals), salt || ""]).join("").split("").forEach((ch) => {
      h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    });
    const random = seeded(h);
    const unseen = makeDeck().filter((c) => !mine.includes(c));
    const totals = [0, 0];
    for (let k = 0; k < samples; k++) {
      const pool = shuffle(unseen, random);
      const sim = {
        status: "playing",
        phase: "play",
        settings: state.settings,
        players: state.players.map((p, i) => ({ id: p.id, hand: i === seat ? mine.slice() : [] })),
        dealer: state.dealer,
        deals: state.deals,
        scores: [0, 0],
        history: [],
        seq: 0,
        log: [],
        trick: [],
        points: [0, 0],
        tricks: [0, 0],
        lastTrick: null,
        winner: null,
      };
      let n = 0;
      for (let i = 0; i < 4; i++) if (i !== seat) for (let j = 0; j < HAND; j++) sim.players[i].hand.push(pool[n++]);
      sim.bidding = { turn: bidder, high: { level: 8, suit: s, seat: bidder }, passes: 0, contra: 0, calls: [] };
      finishBidding(sim);
      // Play it out fast (no copying): the same choices the bots make.
      for (let trickNo = 0; trickNo < HAND; trickNo++) {
        for (let k = 0; k < 4; k++) {
          const who = sim.turn;
          const card = botPlay(sim, who).card;
          const hand = sim.players[who].hand;
          hand.splice(hand.indexOf(card), 1);
          sim.trick.push({ seat: who, card });
          sim.turn = next(who);
        }
        const w = sim.trick[trickLeader(sim.trick, sim.trump)].seat;
        let pts = sim.trick.reduce((sum, t) => sum + points(t.card, sim.trump), 0);
        if (trickNo === HAND - 1) pts += 10;
        sim.points[team(w)] += pts;
        sim.tricks[team(w)] += 1;
        sim.trick = [];
        sim.turn = w;
      }
      const combo = [0, 0];
      sim.combos.forEach((x) => {
        if (x.counts) combo[team(x.seat)] += x.value;
      });
      if (sim.belot) combo[team(sim.belot.seat)] += 20;
      for (let t = 0; t < 2; t++) totals[t] += sim.points[t] + combo[t] + (sim.tricks[t] === HAND ? 90 : 0);
    }
    return [totals[0] / samples, totals[1] / samples];
  }
  // The bid this hand can carry with trump s (0 = none), leaving a margin.
  function carry(state, seat, s, bidder, samples, salt) {
    const avg = estimate(state, seat, s, bidder, samples || SAMPLES, salt)[team(seat)];
    return { avg, level: Math.min(16, Math.floor((avg - MARGIN) / 10)) };
  }
  function botBid(state, seat) {
    const b = state.bidding;
    if (b.contra) return { type: "pass" };
    const min = minBid(state);
    const high = b.high;
    // Opponents hold the bid: double it if they look set to fall short.
    if (high && team(high.seat) !== team(seat) && high.level >= 10) {
      const theirs = estimate(state, seat, high.suit, high.seat, SAMPLES * 2, "contra")[team(high.seat)];
      if (theirs < high.level * 10 - 80) return { type: "contra" };
    }
    if (high && team(high.seat) === team(seat)) {
      // Partner's bid: raise it only if their trump is clearly good for us too.
      const c = carry(state, seat, high.suit, high.seat);
      if (c.level >= high.level + 2 && min <= 16) return { type: "bid", level: min, suit: high.suit };
      return { type: "pass" };
    }
    let best = null;
    ["S", "C", "D", "H", "N"].forEach((s) => {
      const c = carry(state, seat, s, seat);
      if (!best || c.level > best.level || (c.level === best.level && c.avg > best.avg)) best = { s, ...c };
    });
    if (best.level < Math.max(8, min)) return { type: "pass" };
    // The best of five rough guesses is flattered by luck: check it again on
    // fresh deals before saying a number.
    const sure = carry(state, seat, best.s, seat, SAMPLES * 2, "check");
    best = { s: best.s, ...sure };
    if (best.level < Math.max(8, min)) return { type: "pass" };
    // First bid: say what the hand is worth; against opponents, the least that wins the bid.
    return { type: "bid", level: high ? min : best.level, suit: best.s };
  }
  function botPlay(state, seat) {
    const trump = state.trump;
    const legal = legalCards(state, seat);
    const byPoints = (list) => list.slice().sort((a, b) => points(a, trump) - points(b, trump) || power(a, trump) - power(b, trump));
    const isTrump = (c) => trump !== "N" && suit(c) === trump;
    const trick = state.trick;
    if (trick.length === 0) {
      const myTeamBid = state.contract && state.contract.team === team(seat);
      const trumps = legal.filter(isTrump).sort((a, b) => power(b, trump) - power(a, trump));
      if (myTeamBid && trumps.length && rank(trumps[0]) === 11) return { type: "play", card: trumps[0] };
      const aces = legal.filter((c) => !isTrump(c) && rank(c) === 14);
      if (aces.length) return { type: "play", card: aces[0] };
      const plain = legal.filter((c) => !isTrump(c));
      return { type: "play", card: byPoints(plain.length ? plain : legal)[0] };
    }
    const lead = trickLeader(trick, trump);
    const winnerSeat = trick[lead].seat;
    const partnerWinning = team(winnerSeat) === team(seat);
    const lastToPlay = trick.length === 3;
    const beats = (c) => trickLeader(trick.concat([{ seat, card: c }]), trump) === trick.length;
    const tricksPts = trick.reduce((s, t) => s + points(t.card, trump), 0);
    if (partnerWinning) {
      const safe = lastToPlay || (!isTrump(trick[lead].card) ? rank(trick[lead].card) === 14 : power(trick[lead].card, trump) >= 6);
      const plain = legal.filter((c) => !isTrump(c));
      const pool = plain.length ? plain : legal;
      const sorted = byPoints(pool);
      return { type: "play", card: safe ? sorted[sorted.length - 1] : sorted[0] };
    }
    const winners = legal.filter(beats).sort((a, b) => power(a, trump) - power(b, trump) || points(a, trump) - points(b, trump));
    if (winners.length && (tricksPts >= 10 || lastToPlay || !isTrump(winners[0]))) return { type: "play", card: winners[0] };
    const plain = legal.filter((c) => !isTrump(c));
    return { type: "play", card: byPoints(plain.length ? plain : legal)[0] };
  }
  function botMove(state, seat) {
    if (state.status !== "playing") return null;
    if (state.phase === "bid") {
      if (state.bidding.turn !== seat) return null;
      return botBid(state, seat);
    }
    if (state.phase === "play") {
      if (state.turn !== seat) return null;
      return botPlay(state, seat);
    }
    return null;
  }
  function nextBotMove(state, isBot) {
    if (state.status !== "playing") return null;
    const seat = state.phase === "bid" ? state.bidding.turn : state.phase === "play" ? state.turn : null;
    if (seat === null || seat === undefined || !isBot(seat)) return null;
    const move = botMove(state, seat);
    return move ? [seat, move] : null;
  }

  // ---------- what one player is allowed to see ----------
  function viewFor(state, playerId) {
    const out = clone(state);
    delete out.deck;
    out.players = state.players.map((p) => {
      const q = { ...p };
      delete q.secretHash;
      q.handCount = p.hand ? p.hand.length : p.handCount || 0;
      if (p.id !== playerId) delete q.hand;
      return q;
    });
    return out;
  }

  return {
    SUITS, RANKS, HAND, CAPUT, TARGETS, MAX_DEALS,
    rank, suit, team, power, points, sortHand, makeDeck, shuffle, handSize,
    trickLeader, legalCards, findCombos, compareCombos, minBid,
    canBid, canContra, canRecontra, canPassBid, canPlay,
    newGame, startDeal, apply, timeout, botMove, nextBotMove, viewFor, handValue,
  };
})();
/* BLOT-ENGINE-END */

if (typeof module !== "undefined" && module.exports) module.exports = BlotEngine;
