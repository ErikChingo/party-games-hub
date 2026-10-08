// Online card games (Durak, Blot, Blackjack): the referee.
//
//   POST /api/cards  { action, code?, playerId, secret, name?, settings?, move? }
//   -> { ok, code, version, view }   or   { error }
//
// The room state lives in Supabase (table card_rooms); only this function
// writes it, with the service key the Supabase integration put into Vercel
// (SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY). Players read their
// own view between moves through the cards_view() database function, so
// this function only runs when somebody actually does something.
//
// Every write is "update ... where version = what I read": if two players
// act at the same moment, the second one is simply re-applied on top of
// the first.
//
// Actions: create, join, leave, settings, add_bot, remove_bot, start,
// move (play / beat / transfer / take / pass), tick (somebody ran out of
// time), rematch.
//
// A player who leaves a running game, or lets the timer run out twice, is
// replaced by a bot -- the game goes on for everyone else.
//
// Statistics: when an online game with at least two people ends (and after
// every Blot deal and every Blackjack round), the referee adds what it saw
// to each person's profile through cards_record(). Games against bots only
// do not count.

const crypto = require("crypto");
const Durak = require("./_lib/durak.js");
const Blot = require("./_lib/blot.js");
const Blackjack = require("./_lib/blackjack.js");

// Every game here has the same shape: newGame(players, settings, random),
// apply(state, seat, move), timeout(state), nextBotMove(state, isBot),
// viewFor(state, playerId).
const GAMES = {
  durak: {
    engine: Durak,
    minPlayers: 2,
    maxPlayers: 6,
    fill: false,
    settings: (s, old) => ({ transfer: s.transfer === undefined ? !!(old && old.transfer) : !!s.transfer }),
  },
  blot: {
    engine: Blot,
    minPlayers: 1,
    maxPlayers: 4,
    fill: 4, // empty seats are taken by bots when the game starts
    settings: (s, old) => ({ target: [101, 201, 301].includes(Number(s.target)) ? Number(s.target) : (old && old.target) || 101 }),
  },
  blackjack: {
    engine: Blackjack,
    minPlayers: 1,
    maxPlayers: 6,
    fill: false,
    // A table you can sit down at while it is running.
    joinLate: (player) => ({ ...player, chips: Blackjack.START_CHIPS, bet: 0, lastBet: 50, cards: [], done: false, outcome: null, win: 0, afk: 0 }),
    settings: () => ({}),
  },
};
const gameOf = (state) => GAMES[state.game] || GAMES.durak;

const DEFAULT_SUPABASE_URL = "https://zocoaqqcrxpbkyzlfzsf.supabase.co";
const TURN_MS = 30000;
// Blot: how long the score of a deal stays on screen before the next deal.
const SCORE_MS = 9000;
const STALE_ROOM_MS = 6 * 60 * 60 * 1000;
const MAX_BOT_STEPS = 80;

function settings() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return { url, key };
}
function hash(secret) {
  return crypto.createHash("sha256").update(String(secret), "utf8").digest("hex");
}
function fail(res, status, error) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error });
}

async function db(path, init = {}) {
  const { url, key } = settings();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(6000),
  });
}
async function loadRoom(code) {
  const response = await db(`card_rooms?code=eq.${encodeURIComponent(code)}&select=code,state,version,updated_at`);
  if (!response.ok) throw new Error("load " + response.status);
  const rows = await response.json();
  return rows[0] || null;
}
async function saveRoom(code, version, state) {
  const response = await db(`card_rooms?code=eq.${encodeURIComponent(code)}&version=eq.${version}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ state, version: version + 1, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error("save " + response.status);
  const rows = await response.json();
  return rows.length > 0;
}
async function insertRoom(code, state) {
  const response = await db("card_rooms", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ code, game: state.game, state, version: 1 }),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error("insert " + response.status);
  return true;
}
// The same name filter the rest of the site uses; a rejected name becomes "".
async function moderate(name) {
  const clean = String(name || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
  if (!clean) return "";
  try {
    const response = await db("rpc/moderate_display_name", { method: "POST", body: JSON.stringify({ p_name: clean }) });
    if (!response.ok) return clean;
    const value = await response.json();
    return typeof value === "string" ? value.slice(0, 20) : "";
  } catch (e) {
    return clean;
  }
}

// ---------- the game side ----------
function runBots(state) {
  const engine = gameOf(state).engine;
  let current = state;
  for (let step = 0; step < MAX_BOT_STEPS && current.status === "playing"; step++) {
    const move = engine.nextBotMove(current, (i) => !!current.players[i].bot);
    if (!move) break;
    const result = engine.apply(current, move[0], move[1]);
    if (!result.ok) break;
    current = result.state;
  }
  return current;
}
function stamp(state, now) {
  state.deadline = state.status === "playing" ? now + (state.phase === "score" ? SCORE_MS : TURN_MS) : null;
  return state;
}
function botName(state) {
  const used = new Set(state.players.filter((p) => p.bot).map((p) => p.botNo));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
function lobbyPlayers(state) {
  return state.players.map((p) => ({ id: p.id, name: p.name, bot: !!p.bot, botNo: p.botNo || null, secretHash: p.secretHash || null, profileId: p.profileId || null, joinedAt: p.joinedAt }));
}
const PROFILE_RE = /^(tg|anon):[A-Za-z0-9_-]{1,70}$/;
const cleanProfile = (id) => (typeof id === "string" && PROFILE_RE.test(id) ? id : null);
function deal(state, now) {
  const kind = gameOf(state);
  const players = lobbyPlayers(state).map((p) => (p.left ? { ...p, bot: true } : p));
  if (kind.fill) {
    const probe = { players: players.slice() };
    while (players.length < kind.fill) {
      const n = botName(probe);
      const bot = { id: "bot-" + n + "-" + now.toString(36), name: "Bot " + n, bot: true, botNo: n, joinedAt: now };
      players.push(bot);
      probe.players.push(bot);
    }
  }
  const game = kind.engine.newGame(players, state.settings, Math.random);
  game.hostId = state.hostId;
  game.humans = game.players.filter((p) => !p.bot).length;
  game.round = (state.round || 0) + 1;
  game.open = !!state.open;
  return stamp(runBots(game), now);
}

// Applies one action to a room state. Returns { state } or { error }.
function act(state, body, me, now) {
  const kind = gameOf(state);
  const engine = kind.engine;
  const MAX_PLAYERS = kind.maxPlayers;
  const isHost = state.hostId === body.playerId;
  const idx = state.players.findIndex((p) => p.id === body.playerId);
  switch (body.action) {
    case "join": {
      if (idx >= 0) {
        // Back again (reload, or returning after leaving): take your seat back.
        const players = state.players.slice();
        players[idx] = { ...players[idx], bot: false, afk: 0, left: false, name: me.name || players[idx].name, profileId: me.profileId || players[idx].profileId || null };
        return { state: { ...state, players } };
      }
      const seat = { id: body.playerId, name: me.name, bot: false, secretHash: me.hash, profileId: me.profileId, joinedAt: now };
      if (state.status === "playing" && kind.joinLate) {
        if (state.players.length >= MAX_PLAYERS) return { error: "full" };
        return { state: { ...state, players: state.players.concat([kind.joinLate(seat)]) } };
      }
      if (state.status !== "lobby") return { error: "in_progress" };
      if (state.players.length >= MAX_PLAYERS) return { error: "full" };
      return { state: { ...state, players: state.players.concat([seat]) } };
    }
    case "leave": {
      if (idx < 0) return { state };
      let players = state.players.slice();
      if (state.status === "lobby") players.splice(idx, 1);
      else players[idx] = { ...players[idx], bot: true, left: true };
      let hostId = state.hostId;
      if (hostId === body.playerId) {
        const next = players.find((p) => !p.bot && p.id !== body.playerId);
        hostId = next ? next.id : null;
      }
      const humans = players.filter((p) => !p.bot).length;
      let next = { ...state, players, hostId, status: humans === 0 ? "closed" : state.status };
      if (next.status === "playing") next = stamp(runBots(next), now);
      return { state: next };
    }
    case "settings": {
      if (!isHost || state.status !== "lobby") return { error: "forbidden" };
      const s = body.settings || {};
      return { state: { ...state, settings: kind.settings(s, state.settings), open: s.open === undefined ? !!state.open : !!s.open } };
    }
    case "add_bot": {
      if (!isHost || state.status !== "lobby") return { error: "forbidden" };
      if (state.players.length >= MAX_PLAYERS) return { error: "full" };
      const n = botName(state);
      return { state: { ...state, players: state.players.concat([{ id: "bot-" + n + "-" + now.toString(36), name: "Bot " + n, bot: true, botNo: n, joinedAt: now }]) } };
    }
    case "remove_bot": {
      if (!isHost || state.status !== "lobby") return { error: "forbidden" };
      const k = state.players.map((p) => !!p.bot).lastIndexOf(true);
      if (k < 0) return { state };
      const players = state.players.slice();
      players.splice(k, 1);
      return { state: { ...state, players } };
    }
    case "start":
    case "rematch": {
      if (!isHost) return { error: "forbidden" };
      if (body.action === "start" && state.status !== "lobby") return { error: "in_progress" };
      if (body.action === "rematch" && state.status !== "ended") return { error: "not_ended" };
      if (state.players.length < kind.minPlayers) return { error: "need_players" };
      return { state: deal(state, now) };
    }
    case "move": {
      if (state.status !== "playing") return { error: "not_playing" };
      if (idx < 0) return { error: "not_in_room" };
      const result = engine.apply(state, idx, body.move || {});
      if (!result.ok) return { error: result.error };
      const players = result.state.players.slice();
      players[idx] = { ...players[idx], afk: 0 };
      return { state: stamp(runBots({ ...result.state, players }), now) };
    }
    case "tick": {
      if (state.status !== "playing") return { state };
      if (!state.deadline || state.deadline > now) return { state };
      const result = engine.timeout(state);
      const players = result.state.players.map((p, i) => {
        if (!result.idle.includes(i)) return p;
        const afk = (p.afk || 0) + 1;
        // Twice asleep at the wheel: a bot plays the hand from now on.
        return { ...p, afk, bot: p.bot || afk >= 2 };
      });
      return { state: stamp(runBots({ ...result.state, players }), now) };
    }
    default:
      return { error: "bad_request" };
  }
}

// ---------- statistics ----------
// What this change of state adds to people's profiles: [{ profileId, name, delta }].
// Marks what it has counted inside `next`, so nothing is counted twice.
function statsEvents(prev, next) {
  const out = new Map();
  const add = (p, delta) => {
    if (!p || p.bot || !p.profileId) return;
    const cur = out.get(p.profileId) || { profileId: p.profileId, name: p.name || "", delta: {} };
    Object.keys(delta).forEach((k) => {
      if (k.startsWith("bj_best")) cur.delta[k] = Math.max(cur.delta[k] || 0, delta[k]);
      else cur.delta[k] = (cur.delta[k] || 0) + delta[k];
    });
    out.set(p.profileId, cur);
  };
  const humansNow = next.players ? next.players.filter((p) => !p.bot).length : 0;
  if (next.game === "durak") {
    if (prev.status === "playing" && next.status === "ended" && (next.humans || 0) >= 2) {
      next.players.forEach((p, i) => add(p, { durak_games: 1, durak_wins: !next.draw && next.loser !== i ? 1 : 0, durak_fools: next.loser === i ? 1 : 0, durak_firsts: p.place === 1 ? 1 : 0 }));
    }
  } else if (next.game === "blot") {
    if ((next.humans || 0) >= 2 && Array.isArray(next.history)) {
      const done = next.statsDeal || 0;
      next.history
        .filter((h) => h.deal > done && h.deal <= next.deals)
        .forEach((h) => {
          if (h.made && h.contract) add(next.players[h.contract.seat], { blot_made: 1 });
          if (h.capot !== null && h.capot !== undefined) next.players.forEach((p, i) => i % 2 === h.capot && add(p, { blot_capots: 1 }));
          next.statsDeal = Math.max(next.statsDeal || 0, h.deal);
        });
      if (prev.status === "playing" && next.status === "ended") {
        next.players.forEach((p, i) => add(p, { blot_games: 1, blot_wins: next.winner !== null && i % 2 === next.winner ? 1 : 0 }));
      }
    }
  } else if (next.game === "blackjack") {
    if (next.phase === "score" && next.statsRound !== next.round && humansNow >= 2) {
      next.statsRound = next.round;
      next.players.forEach((p) => {
        if (!(p.bet > 0) || !p.outcome) return;
        add(p, { bj_rounds: 1, bj_wins: p.win > 0 ? 1 : 0, bj_blackjacks: p.outcome === "blackjack" ? 1 : 0, bj_best_chips: p.chips || 0, bj_best_win: Math.max(0, p.win || 0) });
      });
    }
  }
  return Array.from(out.values());
}
async function recordStats(events) {
  await Promise.all(
    events.map((e) =>
      db("rpc/cards_record", { method: "POST", body: JSON.stringify({ p_profile_id: e.profileId, p_name: e.name, p_delta: e.delta }) }).catch(() => null)
    )
  );
}

function newCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method not allowed");
  if (!settings().key) return fail(res, 500, "cards are not configured");
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};
  const { action, playerId, secret } = body;
  if (typeof playerId !== "string" || !/^[A-Za-z0-9:_-]{4,80}$/.test(playerId)) return fail(res, 400, "bad_request");
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 100) return fail(res, 400, "bad_request");
  const me = { hash: hash(secret), name: "", profileId: cleanProfile(body.profileId) };
  const now = Date.now();

  try {
    if (action === "create") {
      me.name = await moderate(body.name);
      const game = GAMES[body.game] ? body.game : "durak";
      const state = {
        v: 1,
        game,
        status: "lobby",
        hostId: playerId,
        settings: GAMES[game].settings(body.settings || {}, null),
        open: false,
        players: [{ id: playerId, name: me.name, bot: false, secretHash: me.hash, profileId: me.profileId, joinedAt: now }],
        createdAt: now,
      };
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = newCode();
        if (await insertRoom(code, state)) return send(res, code, 1, state, playerId);
        // The code is taken: reuse it only if that room is long dead.
        const old = await loadRoom(code);
        if (old && now - Date.parse(old.updated_at) > STALE_ROOM_MS && (await saveRoom(code, old.version, state))) {
          return send(res, code, old.version + 1, state, playerId);
        }
      }
      return fail(res, 503, "busy");
    }

    const code = String(body.code || "").replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) return fail(res, 400, "bad_request");
    if (action === "join") me.name = await moderate(body.name);

    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await loadRoom(code);
      if (!row || row.state.status === "closed") return fail(res, 404, "not_found");
      const seat = row.state.players.find((p) => p.id === playerId);
      if (seat && seat.secretHash !== me.hash) return fail(res, 403, "forbidden");
      if (!seat && action !== "join") return fail(res, 403, "not_in_room");
      const result = act(row.state, body, me, now);
      if (result.error) return fail(res, 409, result.error);
      if (result.state === row.state) return send(res, code, row.version, row.state, playerId);
      const events = statsEvents(row.state, result.state);
      if (await saveRoom(code, row.version, result.state)) {
        if (events.length) await recordStats(events);
        return send(res, code, row.version + 1, result.state, playerId);
      }
      // Someone else moved first: read again and re-apply.
    }
    return fail(res, 409, "busy");
  } catch (e) {
    return fail(res, 502, "storage error");
  }
};

function send(res, code, version, state, playerId) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, code, version, view: gameOf(state).engine.viewFor(state, playerId) });
}

module.exports._internals = { act, runBots, deal, hash, statsEvents, TURN_MS, SCORE_MS, GAMES };
