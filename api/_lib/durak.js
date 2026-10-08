// Durak ("Дурак") rules engine -- one file shared by the website (games
// against bots run right in the browser) and by /api/cards (online games,
// where the server is the referee). The build of index.html carries a copy
// of everything between the BEGIN/END markers; a test checks the two stay
// identical, so edit this file and re-run the copy step, never the copy.
//
// Cards are strings: rank number + suit letter, e.g. "6S", "10H", "14D"
// (11 jack, 12 queen, 13 king, 14 ace). Suits: S spades, C clubs,
// D diamonds, H hearts. 36-card deck, 6 cards each, the last card of the
// deck is turned up and its suit is the trump.
//
// One "bout" (заход): the attacker leads, the defender beats each card
// (same suit higher, or any trump on a non-trump), everyone else may throw
// in cards of ranks already on the table. It ends when every attacker has
// passed and either all cards are beaten (they go to the discard pile and
// the defender attacks next) or the defender takes them (and loses the
// turn). Then everyone draws back up to 6: the attacker first, the
// defender last. Whoever is left holding cards at the end is the durak.
//
// Optional "transfer" rule (переводной): before beating anything the
// defender may lay a card of the same rank and pass the whole attack to the
// next player.

/* DURAK-ENGINE-BEGIN */
const DurakEngine = (function () {
  const SUITS = ["S", "C", "D", "H"];
  const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
  const HAND = 6;
  const MAX_TABLE = 6;
  const MAX_PLAYERS = 6;
  // A safety net: a game that has gone on this many bouts (players -- or
  // bots -- passing the same cards back and forth forever) ends in a draw.
  const MAX_BOUTS = 250;

  const rank = (card) => parseInt(card, 10);
  const suit = (card) => card.slice(-1);
  const clone = (x) => JSON.parse(JSON.stringify(x));

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
  // Does `card` beat `target` with this trump?
  function beats(card, target, trump) {
    if (suit(card) === suit(target)) return rank(card) > rank(target);
    return suit(card) === trump && suit(target) !== trump;
  }
  // Order for "lowest card first": non-trumps by rank, then trumps.
  function cardValue(card, trump) {
    return rank(card) + (suit(card) === trump ? 100 : 0);
  }
  function sortHand(hand, trump) {
    return hand.slice().sort((a, b) => cardValue(a, trump) - cardValue(b, trump) || SUITS.indexOf(suit(a)) - SUITS.indexOf(suit(b)));
  }

  const isActive = (p) => p && !p.out;
  // Works on the full state and on a player's view of it (where other
  // players' hands are replaced by a count).
  const handSize = (p) => (p.hand ? p.hand.length : p.handCount || 0);
  function nextActive(state, from) {
    const n = state.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (isActive(state.players[i])) return i;
    }
    return -1;
  }
  function activeCount(state) {
    return state.players.filter(isActive).length;
  }
  function uncovered(state) {
    return state.table.filter((pair) => !pair.d).length;
  }
  function ranksOnTable(state) {
    const set = new Set();
    state.table.forEach((pair) => {
      set.add(rank(pair.a));
      if (pair.d) set.add(rank(pair.d));
    });
    return set;
  }
  function attackers(state) {
    return state.players.map((p, i) => i).filter((i) => i !== state.defender && isActive(state.players[i]));
  }
  // Room left on the table this bout.
  function canAddMore(state) {
    if (state.table.length >= state.boutLimit) return false;
    if (state.taking) return true;
    return uncovered(state) < handSize(state.players[state.defender]);
  }

  // ---------- what a player may do ----------
  function canPlay(state, i, card) {
    if (state.status !== "playing" || i === state.defender) return false;
    const p = state.players[i];
    if (!isActive(p) || !p.hand.includes(card)) return false;
    if (state.table.length === 0) return i === state.attacker;
    if (!canAddMore(state)) return false;
    return ranksOnTable(state).has(rank(card));
  }
  function canBeat(state, i, card, target) {
    if (state.status !== "playing" || i !== state.defender || state.taking) return false;
    const p = state.players[i];
    const pair = state.table[target];
    if (!p.hand.includes(card) || !pair || pair.d) return false;
    return beats(card, pair.a, state.trump);
  }
  function canTransfer(state, i, card) {
    if (!state.settings.transfer || state.status !== "playing" || i !== state.defender || state.taking) return false;
    const p = state.players[i];
    if (!p.hand.includes(card) || state.table.length === 0) return false;
    if (state.table.some((pair) => pair.d)) return false;
    if (state.table.some((pair) => rank(pair.a) !== rank(card))) return false;
    const next = nextActive(state, i);
    if (next < 0 || next === i) return false;
    return handSize(state.players[next]) >= state.table.length + 1 && state.table.length + 1 <= MAX_TABLE;
  }
  function canTake(state, i) {
    return state.status === "playing" && i === state.defender && !state.taking && uncovered(state) > 0;
  }
  function canPass(state, i) {
    if (state.status !== "playing" || i === state.defender || !isActive(state.players[i])) return false;
    return state.table.length > 0 && !state.players[i].passed;
  }
  // Cards this player could legally throw in right now.
  function playableCards(state, i) {
    return state.players[i].hand.filter((c) => canPlay(state, i, c));
  }

  // ---------- setting up ----------
  function newGame(players, settings, random) {
    random = random || Math.random;
    const deck = shuffle(makeDeck(), random);
    const trumpCard = deck[0];
    // deck[0] is the bottom card, turned up; cards are drawn from the end.
    const state = {
      v: 1,
      game: "durak",
      status: "playing",
      settings: { transfer: !!(settings && settings.transfer) },
      players: players.map((p) => ({ ...p, hand: [], out: false, place: null, passed: false, afk: p.afk || 0 })),
      deck,
      trump: trumpCard.slice(-1),
      trumpCard,
      discard: 0,
      table: [],
      attacker: 0,
      defender: 1,
      taking: false,
      boutLimit: MAX_TABLE,
      finished: 0,
      bouts: 0,
      loser: null,
      draw: false,
      seq: 0,
      log: [],
    };
    for (let round = 0; round < HAND; round++) state.players.forEach((p) => p.hand.push(state.deck.pop()));
    // The player with the lowest trump leads; with no trumps at all, the first player.
    let best = -1;
    let bestRank = 99;
    state.players.forEach((p, i) => {
      p.hand.forEach((c) => {
        if (suit(c) === state.trump && rank(c) < bestRank) {
          bestRank = rank(c);
          best = i;
        }
      });
    });
    state.attacker = best >= 0 ? best : 0;
    state.defender = nextActive(state, state.attacker);
    startBout(state);
    return state;
  }
  function startBout(state) {
    state.table = [];
    state.taking = false;
    state.players.forEach((p) => {
      p.passed = false;
    });
    state.boutLimit = Math.min(MAX_TABLE, state.players[state.defender].hand.length);
  }
  function log(state, entry) {
    state.seq += 1;
    state.log.push({ seq: state.seq, ...entry });
    if (state.log.length > 30) state.log = state.log.slice(-30);
  }

  // ---------- doing things ----------
  // action: { type: "play", card } | { type: "beat", card, target } |
  //         { type: "transfer", card } | { type: "take" } | { type: "pass" }
  function apply(input, i, action) {
    const state = clone(input);
    if (state.status !== "playing") return { ok: false, error: "not_playing" };
    const p = state.players[i];
    if (!p || !action) return { ok: false, error: "bad_request" };
    switch (action.type) {
      case "play":
        if (!canPlay(state, i, action.card)) return { ok: false, error: "illegal" };
        p.hand.splice(p.hand.indexOf(action.card), 1);
        state.table.push({ a: action.card, d: null });
        resetPasses(state);
        log(state, { t: "play", p: i, c: action.card });
        break;
      case "beat":
        if (!canBeat(state, i, action.card, action.target)) return { ok: false, error: "illegal" };
        p.hand.splice(p.hand.indexOf(action.card), 1);
        state.table[action.target].d = action.card;
        resetPasses(state);
        log(state, { t: "beat", p: i, c: action.card, on: state.table[action.target].a });
        break;
      case "transfer": {
        if (!canTransfer(state, i, action.card)) return { ok: false, error: "illegal" };
        p.hand.splice(p.hand.indexOf(action.card), 1);
        state.table.push({ a: action.card, d: null });
        const next = nextActive(state, i);
        state.attacker = i;
        state.defender = next;
        state.boutLimit = Math.min(MAX_TABLE, state.players[next].hand.length);
        resetPasses(state);
        log(state, { t: "transfer", p: i, c: action.card, to: next });
        break;
      }
      case "take":
        if (!canTake(state, i)) return { ok: false, error: "illegal" };
        state.taking = true;
        resetPasses(state);
        log(state, { t: "take", p: i });
        break;
      case "pass":
        if (!canPass(state, i)) return { ok: false, error: "illegal" };
        p.passed = true;
        break;
      default:
        return { ok: false, error: "bad_request" };
    }
    settle(state);
    return { ok: true, state };
  }
  function resetPasses(state) {
    state.players.forEach((p) => {
      p.passed = false;
    });
  }
  // Attackers who cannot add anything are counted as having passed, and a
  // bout that nobody can or will continue is closed.
  function settle(state) {
    if (state.status !== "playing" || state.table.length === 0) return;
    attackers(state).forEach((i) => {
      if (!state.players[i].passed && playableCards(state, i).length === 0) state.players[i].passed = true;
    });
    const allPassed = attackers(state).every((i) => state.players[i].passed);
    const allBeaten = uncovered(state) === 0;
    if (!allPassed) return;
    if (state.taking) endBout(state, false);
    else if (allBeaten) endBout(state, true);
  }
  function endBout(state, defended) {
    const cards = [];
    state.table.forEach((pair) => {
      cards.push(pair.a);
      if (pair.d) cards.push(pair.d);
    });
    const defender = state.defender;
    const attacker = state.attacker;
    if (defended) {
      state.discard += cards.length;
      log(state, { t: "beaten", p: defender, n: cards.length });
    } else {
      state.players[defender].hand.push(...cards);
      log(state, { t: "took", p: defender, n: cards.length });
    }
    state.table = [];
    // Draw back up to six: attacker, then the others in turn, defender last.
    const order = [attacker];
    for (let k = 1; k < state.players.length; k++) {
      const i = (attacker + k) % state.players.length;
      if (i !== defender && i !== attacker) order.push(i);
    }
    order.push(defender);
    order.forEach((i) => {
      const p = state.players[i];
      if (p.out) return;
      while (p.hand.length < HAND && state.deck.length > 0) p.hand.push(state.deck.pop());
    });
    // Out of cards with an empty deck: out of the game (in that order).
    if (state.deck.length === 0) {
      order.forEach((i) => {
        const p = state.players[i];
        if (!p.out && p.hand.length === 0) {
          p.out = true;
          state.finished += 1;
          p.place = state.finished;
          log(state, { t: "out", p: i });
        }
      });
    }
    state.bouts = (state.bouts || 0) + 1;
    const left = state.players.map((p, i) => i).filter((i) => isActive(state.players[i]));
    if (left.length > 1 && state.bouts >= MAX_BOUTS) {
      state.status = "ended";
      state.loser = null;
      state.draw = true;
      log(state, { t: "end", p: null });
      return;
    }
    if (left.length <= 1) {
      state.status = "ended";
      state.loser = left.length === 1 ? left[0] : null;
      state.draw = left.length === 0;
      log(state, { t: "end", p: state.loser });
      return;
    }
    // Who attacks next: the defender after a defence, the one after them after a take.
    let nextAttacker = defended ? defender : nextActive(state, defender);
    if (!isActive(state.players[nextAttacker])) nextAttacker = nextActive(state, nextAttacker);
    state.attacker = nextAttacker;
    state.defender = nextActive(state, nextAttacker);
    startBout(state);
  }

  // ---------- a player who does not move in time ----------
  // Leading with nothing on the table: the lowest card goes. A defender with
  // unbeaten cards takes them. Everyone else simply passes.
  function timeout(input) {
    let state = clone(input);
    if (state.status !== "playing") return { state, idle: [] };
    const idle = [];
    if (state.table.length === 0) {
      const lead = sortHand(state.players[state.attacker].hand, state.trump)[0];
      idle.push(state.attacker);
      return { state: apply(state, state.attacker, { type: "play", card: lead }).state, idle };
    }
    if (!state.taking && uncovered(state) > 0) {
      idle.push(state.defender);
      state = apply(state, state.defender, { type: "take" }).state;
    }
    attackers(state).forEach((i) => {
      if (state.status === "playing" && canPass(state, i)) {
        state = apply(state, i, { type: "pass" }).state;
      }
    });
    return { state, idle };
  }

  // ---------- bots ----------
  // A plain, sensible player: leads and throws in low cards, keeps trumps
  // and high cards for later while the deck is full, beats with the
  // cheapest card that works, takes when it cannot beat everything.
  function botMove(state, i) {
    const p = state.players[i];
    if (!p || !isActive(p) || state.status !== "playing") return null;
    const trump = state.trump;
    const deckLeft = state.deck.length;
    const hand = sortHand(p.hand, trump);
    if (i === state.defender) {
      if (state.taking) return null;
      const open = state.table.map((pair, k) => ({ pair, k })).filter((x) => !x.pair.d);
      if (open.length === 0) return null;
      // Passing the attack back and forth between the last two players
      // with an empty deck goes nowhere.
      if (state.settings.transfer && !(deckLeft === 0 && activeCount(state) === 2)) {
        const cheap = hand.find((c) => canTransfer(state, i, c) && suit(c) !== trump && rank(c) <= 11);
        if (cheap) return { type: "transfer", card: cheap };
      }
      // Plan covers for every open card with the cheapest cards available.
      const used = new Set();
      const plan = [];
      for (const { pair, k } of open) {
        const card = hand.find((c) => !used.has(c) && beats(c, pair.a, trump));
        if (!card) return { type: "take" };
        used.add(card);
        plan.push({ card, target: k });
      }
      // Early in the game, do not spend a high trump on a small attack.
      const costly = plan.some((x) => suit(x.card) === trump && rank(x.card) >= 12);
      if (costly && deckLeft > 12 && state.table.length <= 2) return { type: "take" };
      return { type: "beat", card: plan[0].card, target: plan[0].target };
    }
    if (state.table.length === 0) {
      if (i !== state.attacker) return null;
      // Lead the lowest non-trump; prefer a rank we hold twice (more to throw later).
      const plain = hand.filter((c) => suit(c) !== trump);
      const pool = plain.length ? plain : hand;
      const counts = {};
      pool.forEach((c) => {
        counts[rank(c)] = (counts[rank(c)] || 0) + 1;
      });
      const low = pool[0];
      const pairCard = pool.find((c) => counts[rank(c)] > 1 && rank(c) <= rank(low) + 2);
      return { type: "play", card: pairCard || low };
    }
    if (p.passed) return null;
    const options = playableCards(state, i).filter((c) => suit(c) !== trump || deckLeft === 0);
    const sorted = sortHand(options, trump);
    const card = sorted.find((c) => deckLeft === 0 || rank(c) <= 11 || state.taking);
    if (card) return { type: "play", card };
    return canPass(state, i) ? { type: "pass" } : null;
  }
  // The next bot that has something to do, as [index, action], or null.
  function nextBotMove(state, isBot) {
    if (state.status !== "playing") return null;
    const order = [];
    if (state.table.length === 0) order.push(state.attacker);
    order.push(state.defender);
    attackers(state).forEach((i) => order.push(i));
    for (const i of order) {
      if (!isBot(i)) continue;
      const move = botMove(state, i);
      if (move) return [i, move];
    }
    return null;
  }

  // ---------- what one player is allowed to see ----------
  function viewFor(state, playerId) {
    const out = clone(state);
    delete out.deck;
    out.deckCount = state.deck ? state.deck.length : out.deckCount || 0;
    out.players = state.players.map((p) => {
      const q = { ...p };
      delete q.secretHash;
      if (p.id !== playerId) {
        q.handCount = p.hand ? p.hand.length : p.handCount || 0;
        delete q.hand;
      } else {
        q.handCount = p.hand ? p.hand.length : 0;
      }
      return q;
    });
    return out;
  }

  return {
    SUITS, RANKS, HAND, MAX_TABLE, MAX_PLAYERS, MAX_BOUTS,
    rank, suit, beats, sortHand, makeDeck, shuffle, nextActive, activeCount, uncovered, attackers, ranksOnTable,
    canPlay, canBeat, canTransfer, canTake, canPass, playableCards, handSize,
    newGame, apply, timeout, botMove, nextBotMove, viewFor,
  };
})();
/* DURAK-ENGINE-END */

if (typeof module !== "undefined" && module.exports) module.exports = DurakEngine;
