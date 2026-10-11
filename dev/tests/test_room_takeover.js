const ROOT = require("path").resolve(__dirname, "../..");
// Bunker/Court rooms on a fake Realtime server: host vanishes -> next player
// takes over; old host comes back -> becomes a guest; leaving guests;
// leave guard (two presses).
const fs = require("fs");
const realST = setTimeout;
// Speed up only the takeover waits (30 s / 5 s) so the test runs in ms.
global.setTimeout = (fn, ms, ...a) => realST(fn, ms >= 4000 ? ms / 100 : ms, ...a);
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["useGameRoom", "confirmLeave", "isLeaveGuarded", "LEAVE_GUARD_SCREENS", "leaveHintListeners", "useLeaveGuard", ')
  .replace("return { C, calls, sent,", "return { client, C, calls, sent,");
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, makeRuntime, wait };")(require, m, __dirname);
const { load, React, makeRuntime, wait } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

// ---------- a tiny Realtime: broadcast + presence ----------
function makeHub() {
  const channels = []; // { name, owner, handlers: [{type, event, cb}], presence: payload|null, online }
  const syncAll = (name) => channels.filter((c) => c.name === name && c.online && c.subscribed).forEach((c) => c.handlers.filter((h) => h.type === "presence").forEach((h) => h.cb({})));
  const hub = {
    channels,
    clientFor(owner) {
      return {
        channel(name) {
          const ch = { name, owner, handlers: [], presence: null, online: true, subscribed: false };
          const api = {
            on(type, filter, cb) { ch.handlers.push({ type, event: filter && filter.event, cb }); return api; },
            subscribe(cb) { realST(() => { ch.subscribed = true; cb && cb("SUBSCRIBED"); syncAll(name); }, 1); return api; },
            send(msg) {
              if (!ch.online) return;
              channels.filter((c) => c.name === name && c.online && c.subscribed).forEach((c) =>
                c.handlers.filter((h) => h.type === "broadcast" && h.event === msg.event).forEach((h) => realST(() => h.cb({ payload: msg.payload }), 0)));
            },
            track(payload) { ch.presence = payload; realST(() => syncAll(name), 0); },
            presenceState() {
              const out = {};
              channels.filter((c) => c.name === name && c.online && c.presence).forEach((c, k) => { out["k" + k + c.owner] = [c.presence]; });
              return out;
            },
          };
          ch.api = api;
          channels.push(ch);
          return api;
        },
        removeChannel(api) { const i = channels.findIndex((c) => c.api === api); if (i >= 0) { const name = channels[i].name; channels.splice(i, 1); realST(() => syncAll(name), 0); } },
        rpc() { return Promise.resolve({ data: null, error: null }); },
        from() { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, gt: () => q, maybeSingle: () => Promise.resolve({ data: null }), then: (r) => r({ data: [] }) }; return q; },
      };
    },
    drop(owner) { channels.filter((c) => c.owner === owner).forEach((c) => { c.online = false; }); const names = new Set(channels.map((c) => c.name)); names.forEach(syncAll); },
    restore(owner) { channels.filter((c) => c.owner === owner).forEach((c) => { c.online = true; }); const names = new Set(channels.map((c) => c.name)); names.forEach(syncAll); },
  };
  return hub;
}

function player(hub, id, extraConfig = {}) {
  const rt = makeRuntime();
  const e = load({ react: { ...React, ...rt.hooks }, local: { hatsitSettings: JSON.stringify({ language: "ru" }) } });
  const c = hub.clientFor(id);
  Object.assign(e.client, { channel: c.channel, removeChannel: c.removeChannel, rpc: c.rpc });
  let n = 0;
  const config = {
    gameKey: "court",
    genPlayerId: () => id,
    genRoomCode: () => "1234",
    buildInitialRoom: (pid, name) => ({ status: "lobby", hostId: pid, players: { [pid]: { name, isHost: true, joinedAt: 1, role: null } } }),
    hostEvents: {
      join: (current, payload) => {
        const players = { ...current.players };
        const existing = players[payload.playerId];
        players[payload.playerId] = { name: payload.name, isHost: payload.playerId === current.hostId, joinedAt: existing ? existing.joinedAt : Date.now() + ++n, role: existing ? existing.role : null };
        return { ...current, players };
      },
    },
    messages: { enterCode4: "x", enterNameError: "x", connectFailed: "x", notFound: "x", defaultName: "Игрок" },
    ...extraConfig,
  };
  rt.mount(e.C.useGameRoom, config);
  return { id, rt, e, get r() { return rt.result; } };
}

(async () => {
  const hub = makeHub();
  const judgeSwap = (next, oldHost, newHost) => {
    const a = next.players[oldHost], b = next.players[newHost];
    if (!a || !b || a.role !== "judge") return next;
    return { ...next, players: { ...next.players, [oldHost]: { ...a, role: b.role }, [newHost]: { ...b, role: "judge" } } };
  };
  const A = player(hub, "A", { onHostTakeover: judgeSwap });
  A.r.handleCreate("Аня");
  await wait(30);
  ok(A.r.room && A.r.room.hostId === "A" && A.r.room.hostSince > 0, "host creates the room with a hostSince stamp");
  const B = player(hub, "B", { onHostTakeover: judgeSwap });
  B.r.handleJoin("Боря", "1234");
  await wait(30);
  const Cc = player(hub, "C", { onHostTakeover: judgeSwap });
  Cc.r.handleJoin("Вика", "1234");
  await wait(40);
  eq(Object.keys(A.r.room.players).sort(), ["A", "B", "C"], "everyone is in the host's room");
  eq(Cc.r.room && Object.keys(Cc.r.room.players).sort(), ["A", "B", "C"], "guests see the same room");

  // give roles: A judge, B juror, C accused
  A.r.broadcastState({ ...A.r.room, status: "playing", players: { ...A.r.room.players, A: { ...A.r.room.players.A, role: "judge" }, B: { ...A.r.room.players.B, role: "juror" }, C: { ...A.r.room.players.C, role: "guilty" } } });
  await wait(20);
  eq(B.r.room.players.A.role, "judge", "roles reach the guests");

  // --- host vanishes without a word (crash / lost signal)
  hub.drop("A");
  await wait(20);
  eq([B.r.connStatus, Cc.r.connStatus], ["host_left", "host_left"], "guests see that the host is gone");
  await wait(500);
  eq(B.r.room.hostId, "B", "the earliest guest still here takes the room over");
  ok(B.r.isHostRef.current === true && Cc.r.isHostRef.current === false, "exactly one new host");
  eq(Cc.r.room.hostId, "B", "the other guest follows the new host");
  eq([Cc.r.connStatus, B.r.connStatus], ["idle", "idle"], "the 'host left' banner goes away");
  eq([B.r.room.players.B.role, B.r.room.players.A.role], ["judge", "juror"], "Court: the new host takes the judge's chair, the old judge gets the new host's role");
  ok(B.r.room.players.A.away === true && B.r.room.players.A.isHost === false, "the old host is marked offline");
  ok(B.r.room.hostSince > A.r.room.hostSince, "takeover gives the room a newer hostSince");
  ok(B.r.room.status === "playing", "the game carries on where it was");

  // --- new host can act: a vote request is resolved by B
  const before = B.r.room.players.C.name;
  Cc.r.sendEvent("join", { playerId: "D", name: "Гоша" });
  await wait(30);
  ok(B.r.room.players.D && Cc.r.room.players.D, "the new host handles requests and everyone gets the result");

  // --- the old host comes back with its stale room
  hub.restore("A");
  A.r.broadcastState(A.r.room); // what a reloaded former host does
  await wait(60);
  eq([B.r.room.hostId, Cc.r.room.hostId], ["B", "B"], "a stale copy from the former host is ignored");
  await wait(60);
  ok(A.r.isHostRef.current === false, "the former host steps down");
  eq(A.r.room.hostId, "B", "and carries on as a guest of the new host");
  await wait(60);
  ok(B.r.room.players.A && !B.r.room.players.A.away, "the former host is back in the room, no longer offline");

  // --- a guest who leaves on purpose
  Cc.rt.unmount();
  await wait(40);
  ok(B.r.room.players.C && B.r.room.players.C.left === true, "a guest who goes back to the menu mid-game is marked «left»");

  // --- host leaves on purpose in the lobby: fast takeover
  const hub2 = makeHub();
  const X = player(hub2, "X");
  X.r.handleCreate("Хост");
  await wait(30);
  const Y = player(hub2, "Y");
  Y.r.handleJoin("Гость", "1234");
  await wait(40);
  const Z = player(hub2, "Z");
  Z.r.handleJoin("Третий", "1234");
  await wait(40);
  Z.rt.unmount();
  await wait(40);
  eq(Object.keys(X.r.room.players).sort(), ["X", "Y"], "lobby: a guest who leaves is taken out of the room");
  X.rt.unmount();
  await wait(120);
  eq(Y.r.room && Y.r.room.hostId, "Y", "host goes back to the menu: the remaining player becomes host");

  // --- leave guard (real clock from here on)
  global.setTimeout = realST;
  const env = load({ react: React, local: { hatsitSettings: JSON.stringify({ language: "ru" }) } });
  const hints = [];
  env.C.leaveHintListeners.add((text) => hints.push(text));
  let left = 0;
  ok(env.C.confirmLeave(() => left++) === false && left === 0, "first press does not leave");
  eq(hints, ["Нажмите ещё раз, чтобы выйти из игры"], "and shows the hint");
  ok(env.C.confirmLeave(() => left++) === true && left === 1, "second press within 2.5 s leaves");
  ok(env.C.confirmLeave(() => left++) === false && left === 1, "the next press starts over");
  await wait(2600);
  env.C.confirmLeave(() => left++, "leave.hintMafia");
  ok(/выбываете/.test(hints[hints.length - 1]) && left === 1, "Mafia warns that leaving drops you out");
  await wait(2600);
  ok(env.C.confirmLeave(() => left++) === false && left === 1, "after 2.5 s it asks again");
  ok(env.C.isLeaveGuarded("spy-playing") && env.C.isLeaveGuarded("mafia-game") && !env.C.isLeaveGuarded("hub") && !env.C.isLeaveGuarded("spy-setup") && !env.C.isLeaveGuarded("spy-end"), "local games are guarded only while under way");
  const src = fs.readFileSync(ROOT + "/index.html", "utf8");
  ok(/window\.addEventListener\("popstate", onPop\)/.test(src) && /window\.addEventListener\("pointerdown", arm, true\)/.test(src), "phone 'back' (edge swipe, Android button) is caught after the first touch");
  ok(/showLeaveHint\("leave\.hintSite"\)/.test(src), "on the main screen a second 'back' closes the site");
  ok(/const onBack = \(\) => dispatchRef\.current\(\{ type: "GO_HUB" \}\);/.test(src), "Telegram's back button goes through the same guard");
  eq((src.match(/onConfirm=\{\(\) => dispatch\(\{ type: "GO_HUB", leaveConfirmed: true \}\)\}/g) || []).length, 8, "exit buttons that already ask for confirmation are not asked twice");
  ok(/useLeaveGuard\(!!me\.alive, \{ messageKey: "leave\.hintMafia", onLeave: leave \}\)/.test(src), "Mafia: only a living player is guarded, and 'back' really leaves the server room");
  ok((src.match(/useLeaveGuard\(!!\(roomCode && room && \(room\.status !== "lobby" \|\| room\.hostId === playerId\)\)/g) || []).length === 2, "Bunker and Court guard a running game, and the host in the lobby");
  for (const k of ["leave.hint", "leave.hintMafia", "leave.hintSite", "leave.confirmMafia", "mhost.leftGame", "mhost.goneGame"]) {
    ok(new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ ru: "[^"]+", en: "[^"]+", hy: "[^"]+" \\}').test(src), "i18n in 3 languages: " + k);
  }
  global.setTimeout = realST;
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
