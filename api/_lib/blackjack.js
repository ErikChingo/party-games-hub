// Blackjack ("Очко" / 21) rules engine -- shared by the website (games with
// bots run in the browser) and by /api/cards (online tables, where the
// server deals). index.html carries a copy of everything between the
// BEGIN/END markers; a test checks the two stay identical.
//
// Everyone plays against the dealer (the game itself). Play chips only,
// no money: each player starts with 1000; out of chips -> "Ещё фишек"
// gives another 1000.
//
// A round: bets (10..500) -> two cards each, the dealer one face up and one
// face down -> players in turn: "Ещё" (hit), "Хватит" (stand), "Удвоить"
// (double: twice the bet, exactly one more card, only on the first two
// cards) -> the dealer turns the hidden card and draws to 17 (stands on
// every 17) -> pay out: blackjack (21 with two cards) 3:2, a win 1:1, a tie
// returns the bet. If the dealer's first two cards are a blackjack, the
// round ends at once.
//
// Cards: "2S".."10S", "11S" jack, "12S" queen, "13S" king, "14S" ace; two
// 52-card decks, reshuffled when fewer than 30 cards are left. The shoe and
// the dealer's hidden card live in state.deck / state.secret, which nobody's
// view ever contains.

/* BLACKJACK-ENGINE-BEGIN */
const BlackjackEngine = (function () {
  const SUITS = ["S", "C", "D", "H"];
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const START_CHIPS = 1000;
  const MIN_BET = 10;
  const MAX_BET = 500;
  const DECKS = 2;
  const RESHUFFLE_AT = 30;
  const MAX_PLAYERS = 6;

  const rank = (card) => parseInt(card, 10);
  const suit = (card) => card.slice(-1);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function makeShoe() {
    const shoe = [];
    for (let d = 0; d < DECKS; d++) SUITS.forEach((s) => RANKS.forEach((r) => shoe.push(r + s)));
    return shoe;
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
  const cardValue = (card) => {
    const r = rank(card);
    return r === 14 ? 11 : r >= 10 ? 10 : r;
  };
  // { total, soft } -- soft: an ace still counted as 11.
  function score(cards) {
    let total = 0;
    let aces = 0;
    (cards || []).forEach((c) => {
      total += cardValue(c);
      if (rank(c) === 14) aces++;
    });
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }
    return { total, soft: aces > 0 };
  }
  const isBlackjack = (cards) => cards.length === 2 && score(cards).total === 21;

  function draw(state, random) {
    if (!state.deck || state.deck.length === 0) state.deck = shuffle(makeShoe(), random || Math.random);
    return state.deck.pop();
  }
  function note(state, entry) {
    state.seq += 1;
    state.log.push({ seq: state.seq, ...entry });
    if (state.log.length > 40) state.log = state.log.slice(-40);
  }
  // Seated players who take part in this round.
  const inRound = (p) => p.bet > 0;

  // ---------- setting up ----------
  function newGame(players, settings, random) {
    random = random || Math.random;
    const state = {
      v: 1,
      game: "blackjack",
      status: "playing",
      settings: {},
      players: players.slice(0, MAX_PLAYERS).map((p) => ({ ...p, chips: START_CHIPS, bet: 0, lastBet: 50, cards: [], done: false, outcome: null, win: 0, afk: p.afk || 0 })),
      deck: shuffle(makeShoe(), random),
      secret: { hole: null },
      dealer: { cards: [], hidden: false },
      round: 0,
      phase: "bet",
      turn: null,
      seq: 0,
      log: [],
    };
    startRound(state, random);
    return state;
  }
  function startRound(state, random) {
    state.round += 1;
    if (!state.deck || state.deck.length < RESHUFFLE_AT) {
      state.deck = shuffle(makeShoe(), random || Math.random);
      note(state, { t: "shuffle" });
    }
    state.phase = "bet";
    state.turn = null;
    state.dealer = { cards: [], hidden: false };
    state.secret = { hole: null };
    state.players.forEach((p) => {
      p.bet = 0;
      p.cards = [];
      p.done = false;
      p.doubled = false;
      p.outcome = null;
      p.win = 0;
      p.sitOut = false;
    });
  }
  function deal(state, random) {
    const seats = state.players.map((p, i) => i).filter((i) => inRound(state.players[i]));
    for (let round = 0; round < 2; round++) {
      seats.forEach((i) => state.players[i].cards.push(draw(state, random)));
      if (round === 0) state.dealer.cards.push(draw(state, random));
      else state.secret.hole = draw(state, random);
    }
    state.dealer.hidden = true;
    note(state, { t: "deal" });
    // The dealer peeks: a dealer blackjack ends the round at once.
    if (isBlackjack([state.dealer.cards[0], state.secret.hole])) return finishRound(state, random);
    seats.forEach((i) => {
      if (isBlackjack(state.players[i].cards)) state.players[i].done = true;
    });
    state.phase = "turns";
    state.turn = nextTurn(state, -1);
    if (state.turn === null) dealerPlays(state, random);
  }
  function nextTurn(state, from) {
    for (let i = from + 1; i < state.players.length; i++) {
      const p = state.players[i];
      if (inRound(p) && !p.done) return i;
    }
    return null;
  }
  function dealerPlays(state, random) {
    state.dealer.cards.push(state.secret.hole);
    state.secret.hole = null;
    state.dealer.hidden = false;
    // Only draw if somebody is still in with a hand that has not busted.
    const live = state.players.some((p) => inRound(p) && score(p.cards).total <= 21 && !isBlackjack(p.cards));
    while (live && score(state.dealer.cards).total < 17) state.dealer.cards.push(draw(state, random));
    finishRound(state, random);
  }
  function finishRound(state) {
    if (state.secret.hole) {
      state.dealer.cards.push(state.secret.hole);
      state.secret.hole = null;
    }
    state.dealer.hidden = false;
    const d = score(state.dealer.cards).total;
    const dealerBJ = isBlackjack(state.dealer.cards);
    state.players.forEach((p) => {
      if (!inRound(p)) return;
      const s = score(p.cards).total;
      const bj = isBlackjack(p.cards);
      let outcome;
      let back;
      if (s > 21) {
        outcome = "bust";
        back = 0;
      } else if (bj && !dealerBJ) {
        outcome = "blackjack";
        back = p.bet + Math.floor((p.bet * 3) / 2);
      } else if (dealerBJ && !bj) {
        outcome = "lose";
        back = 0;
      } else if (d > 21 || s > d) {
        outcome = "win";
        back = p.bet * 2;
      } else if (s === d) {
        outcome = "push";
        back = p.bet;
      } else {
        outcome = "lose";
        back = 0;
      }
      p.chips += back;
      p.win = back - p.bet;
      p.outcome = outcome;
      p.done = true;
    });
    state.phase = "score";
    state.turn = null;
    note(state, { t: "result", dealer: d });
  }

  // ---------- what a player may do ----------
  function canBet(state, seat, amount) {
    const p = state.players[seat];
    amount = Number(amount);
    return state.status === "playing" && state.phase === "bet" && !!p && p.bet === 0 && !p.out && Number.isInteger(amount) && amount >= MIN_BET && amount <= Math.min(MAX_BET, p.chips);
  }
  function canHit(state, seat) {
    return state.status === "playing" && state.phase === "turns" && state.turn === seat && score(state.players[seat].cards).total < 21;
  }
  const canStand = (state, seat) => state.status === "playing" && state.phase === "turns" && state.turn === seat;
  function canDouble(state, seat) {
    const p = state.players[seat];
    return canHit(state, seat) && p.cards.length === 2 && p.chips >= p.bet;
  }
  function canRebuy(state, seat) {
    const p = state.players[seat];
    return state.status === "playing" && !!p && p.chips < MIN_BET && p.bet === 0;
  }
  // Seats that still have to bet this round (have chips, have not bet).
  function waitingBets(state) {
    return state.players.map((p, i) => i).filter((i) => {
      const p = state.players[i];
      return p.bet === 0 && p.chips >= MIN_BET && !p.sitOut;
    });
  }

  // ---------- doing things ----------
  // action: { type: "bet", amount } | { type: "hit" } | { type: "stand" }
  //       | { type: "double" } | { type: "rebuy" } | { type: "next" }
  function apply(input, seat, action, random) {
    const state = clone(input);
    if (state.status !== "playing") return { ok: false, error: "not_playing" };
    const p = state.players[seat];
    if (!p || !action) return { ok: false, error: "bad_request" };
    switch (action.type) {
      case "bet":
        if (!canBet(state, seat, action.amount)) return { ok: false, error: "illegal" };
        p.bet = Number(action.amount);
        p.lastBet = p.bet;
        p.chips -= p.bet;
        p.sitOut = false;
        note(state, { t: "bet", p: seat, n: p.bet });
        if (waitingBets(state).length === 0) deal(state, random);
        break;
      case "hit": {
        if (!canHit(state, seat)) return { ok: false, error: "illegal" };
        const c = draw(state, random);
        p.cards.push(c);
        note(state, { t: "hit", p: seat, c });
        if (score(p.cards).total >= 21) endTurn(state, seat, random);
        break;
      }
      case "double": {
        if (!canDouble(state, seat)) return { ok: false, error: "illegal" };
        p.chips -= p.bet;
        p.bet *= 2;
        p.doubled = true;
        const c = draw(state, random);
        p.cards.push(c);
        note(state, { t: "double", p: seat, c });
        endTurn(state, seat, random);
        break;
      }
      case "stand":
        if (!canStand(state, seat)) return { ok: false, error: "illegal" };
        note(state, { t: "stand", p: seat });
        endTurn(state, seat, random);
        break;
      case "rebuy":
        if (!canRebuy(state, seat)) return { ok: false, error: "illegal" };
        p.chips += START_CHIPS;
        p.rebuys = (p.rebuys || 0) + 1;
        note(state, { t: "rebuy", p: seat });
        break;
      case "next":
        if (state.phase !== "score") return { ok: false, error: "illegal" };
        startRound(state, random);
        break;
      default:
        return { ok: false, error: "bad_request" };
    }
    return { ok: true, state };
  }
  function endTurn(state, seat, random) {
    state.players[seat].done = true;
    state.turn = nextTurn(state, seat);
    if (state.turn === null) dealerPlays(state, random);
  }

  // ---------- a player who does not move in time ----------
  // Bets: whoever has not bet sits this round out. Turns: stand.
  function timeout(input, random) {
    const state = clone(input);
    if (state.status !== "playing") return { state, idle: [] };
    if (state.phase === "bet") {
      const idle = waitingBets(state);
      idle.forEach((i) => {
        state.players[i].sitOut = true;
      });
      if (state.players.some(inRound)) deal(state, random);
      else startRound(state, random);
      return { state, idle };
    }
    if (state.phase === "turns") {
      const seat = state.turn;
      return { state: apply(state, seat, { type: "stand" }, random).state, idle: [seat] };
    }
    if (state.phase === "score") return { state: apply(state, 0, { type: "next" }, random).state, idle: [] };
    return { state, idle: [] };
  }

  // ---------- bots ----------
  // Bets its usual stake; plays a simplified basic strategy.
  function botMove(state, seat) {
    const p = state.players[seat];
    if (!p || state.status !== "playing") return null;
    if (state.phase === "bet") {
      if (p.bet > 0 || p.sitOut) return null;
      if (p.chips < MIN_BET) return { type: "rebuy" };
      return { type: "bet", amount: Math.max(MIN_BET, Math.min(p.lastBet || 50, p.chips, MAX_BET)) };
    }
    if (state.phase !== "turns" || state.turn !== seat) return null;
    const { total, soft } = score(p.cards);
    const up = cardValue(state.dealer.cards[0]);
    if (p.cards.length === 2 && p.chips >= p.bet && !soft && (total === 11 || (total === 10 && up <= 9))) return { type: "double" };
    if (soft) return total <= 17 ? { type: "hit" } : { type: "stand" };
    if (total <= 11) return { type: "hit" };
    if (total <= 16) return up >= 7 ? { type: "hit" } : total === 12 && up <= 3 ? { type: "hit" } : { type: "stand" };
    return { type: "stand" };
  }
  function nextBotMove(state, isBot) {
    if (state.status !== "playing") return null;
    if (state.phase === "bet") {
      for (let i = 0; i < state.players.length; i++) {
        if (!isBot(i)) continue;
        const m = botMove(state, i);
        if (m) return [i, m];
      }
      return null;
    }
    if (state.phase === "turns" && state.turn !== null && isBot(state.turn)) {
      const m = botMove(state, state.turn);
      return m ? [state.turn, m] : null;
    }
    return null;
  }

  // ---------- what one player is allowed to see ----------
  function viewFor(state, playerId) {
    const out = clone(state);
    delete out.deck;
    delete out.secret;
    out.deckCount = state.deck ? state.deck.length : 0;
    out.players = state.players.map((p) => {
      const q = { ...p };
      delete q.secretHash;
      return q;
    });
    return out;
  }

  return {
    SUITS, RANKS, START_CHIPS, MIN_BET, MAX_BET, MAX_PLAYERS,
    rank, suit, score, cardValue, isBlackjack, makeShoe, shuffle,
    canBet, canHit, canStand, canDouble, canRebuy, waitingBets,
    newGame, startRound, apply, timeout, botMove, nextBotMove, viewFor,
  };
})();
/* BLACKJACK-ENGINE-END */

if (typeof module !== "undefined" && module.exports) module.exports = BlackjackEngine;
