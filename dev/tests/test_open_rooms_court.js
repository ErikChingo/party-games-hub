const ROOT = require("path").resolve(__dirname, "../..");
// Open rooms, room name -> profile name, Court statistics/achievements/cases.
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["rememberRoomName", "getPlayerName", "getOpenRoomIdentity", "announceOpenRoom", "closeOpenRoom", "fetchOpenRooms", "useOpenRoomBeacon", "OpenRoomsList", "OpenRoomSwitch", "courtJuryOutcome", "recordCourtCase", "COURT_CASES", "BunkerMenu", "CourtMenu", "BunkerLobby", "CourtLobby", "getPlayerTitleById", "withoutLeftPlayers", "PlayerGoneTag", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS, makeRuntime, wait };")(require, m, __dirname);
const { load, React, RDS, makeRuntime, wait } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const src = fs.readFileSync(ROOT + "/index.html", "utf8");
const html = (el) => RDS.renderToStaticMarkup(el);
const RU = { hatsitSettings: JSON.stringify({ language: "ru" }) };
const noop = () => {};

(async () => {
  /* ---------- room name -> profile name ---------- */
  let env = load({ react: React, local: { ...RU } });
  let C = env.C;
  C.rememberRoomName("  Аня  ");
  eq(C.getPlayerName(), "Аня", "first room name becomes the profile name");
  let call = env.calls.find((c) => c[0] === "set_display_name");
  ok(call && call[1].p_name === "Аня", "and is sent to the server");
  const before = env.calls.length;
  C.rememberRoomName("Боря");
  eq([C.getPlayerName(), env.calls.length], ["Аня", before], "a later room name never overwrites the chosen name");
  C.rememberRoomName("");
  C.rememberRoomName(null);
  eq(C.getPlayerName(), "Аня", "empty input is ignored");
  env = load({ react: React, local: { ...RU } });
  env.C.rememberRoomName("сука");
  ok(!env.C.getPlayerName() || env.C.getPlayerName() !== "сука", "a rude room name is not saved as the profile name");
  ok((src.match(/rememberRoomName\(name\);/g) || []).length === 6, "all six entry points remember the name (Bunker/Court/Mafia/Durak create+join)");
  env = load({ react: React, local: { ...RU, hatsit_player_name_v1: "Вика" } });
  ok(html(React.createElement(env.C.BunkerMenu, { dispatch: noop, onCreate: noop, onJoin: noop, busy: false, error: "", initialCode: "1234" })).includes('value="Вика"'), "Bunker menu pre-fills the saved name");
  ok(html(React.createElement(env.C.CourtMenu, { dispatch: noop, onCreate: noop, onJoin: noop, busy: false, error: "", initialCode: "1234" })).includes('value="Вика"'), "Court menu pre-fills the saved name");
  ok(html(React.createElement(env.C.MafiaRoomMenu, { dispatch: noop, onCreate: noop, onJoin: noop, busy: false, error: null, initialCode: "1234" })).includes('value="Вика"'), "Mafia menu pre-fills the saved name");

  /* ---------- open rooms: identity and calls ---------- */
  let answers = {};
  env = load({ react: React, local: { ...RU }, rpcAny: (fn, args) => Promise.resolve(typeof answers[fn] === "function" ? answers[fn](args) : answers[fn] || { data: null, error: null }) });
  C = env.C;
  const id1 = C.getOpenRoomIdentity();
  ok(/^dev-/.test(id1.id) && id1.secret.length >= 16 && /^[A-Za-z0-9:_-]{4,80}$/.test(id1.id), "device identity has the shape the server accepts: " + id1.id);
  eq(C.getOpenRoomIdentity(), id1, "identity is stable");
  eq(JSON.parse(env.ls.getItem("hatsit_open_room_identity_v1")), id1, "and kept on the device");
  answers.open_room_upsert = { data: { ok: true }, error: null };
  ok((await C.announceOpenRoom("court", "1234", "Аня", 3, null)) === true, "announce reports success");
  call = env.calls.find((c) => c[0] === "open_room_upsert");
  eq(call[1], { p_game: "court", p_code: "1234", p_owner_id: id1.id, p_secret: id1.secret, p_name: "Аня", p_players: 3, p_max: null, p_lang: "ru" }, "announce sends the room and the device secret");
  answers.open_room_upsert = { data: { error: "busy" }, error: null };
  ok((await C.announceOpenRoom("court", "1234", "Аня", 3, null)) === false, "a refused announce is reported as failure");
  await C.closeOpenRoom("court");
  call = env.calls.find((c) => c[0] === "open_room_close");
  eq(call[1], { p_game: "court", p_owner_id: id1.id, p_secret: id1.secret }, "close is authorised the same way");
  answers.open_rooms_list = { data: [{ game: "court", code: "1234", name: "Аня", players: 3, max: null, lang: "ru" }, { game: "court", code: "12", name: "x" }, null, { game: "mafia", code: "7777", name: "", players: 6, max: 20, lang: "en" }], error: null };
  let list = await C.fetchOpenRooms("court");
  eq(list.map((r) => r.code), ["1234", "7777"], "rows without a proper code are dropped");
  eq(env.calls.filter((c) => c[0] === "open_rooms_list").pop()[1], { p_game: "court" }, "list asks for one game");
  await C.fetchOpenRooms(null);
  eq(env.calls.filter((c) => c[0] === "open_rooms_list").pop()[1], { p_game: null }, "the Hub asks for all games");
  answers.open_rooms_list = { data: null, error: { message: "x" } };
  eq(await C.fetchOpenRooms("court"), [], "an error is an empty list, not a crash");
  answers.open_rooms_list = () => { throw new Error("net"); };
  eq(await C.fetchOpenRooms("court"), [], "a thrown error is an empty list too");

  /* ---------- beacon ---------- */
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU }, rpcAny: () => Promise.resolve({ data: { ok: true }, error: null }) });
    const ups = () => e.calls.filter((c) => c[0] === "open_room_upsert");
    const closes = () => e.calls.filter((c) => c[0] === "open_room_close");
    rt.mount(e.C.useOpenRoomBeacon, { game: "bunker", code: "5555", active: false, name: "Хост", players: 1, max: null });
    await wait(10);
    eq([ups().length, closes().length], [0, 0], "a private room is never announced");
    rt.update({ game: "bunker", code: "5555", active: true, name: "Хост", players: 1, max: null });
    await wait(10);
    eq([ups().length, ups()[0][1].p_code, ups()[0][1].p_players], [1, "5555", 1], "switching it on announces at once");
    rt.update({ game: "bunker", code: "5555", active: true, name: "Хост", players: 1, max: null });
    await wait(10);
    eq(ups().length, 1, "re-rendering does not spam the server");
    rt.update({ game: "bunker", code: "5555", active: true, name: "Хост", players: 2, max: null });
    await wait(10);
    eq([ups().length, ups()[1][1].p_players], [2, 2], "a new player is reported immediately");
    rt.update({ game: "bunker", code: "5555", active: false, name: "Хост", players: 2, max: null });
    await wait(10);
    eq([closes().length, closes()[0][1].p_game], [1, "bunker"], "game started / switch off: taken off the list");
    const n = ups().length;
    rt.update({ game: "bunker", code: "5555", active: false, name: "Хост", players: 3, max: null });
    await wait(10);
    eq(ups().length, n, "nothing is announced while it is off");
    rt.update({ game: "bunker", code: "5555", active: true, name: "Хост", players: 3, max: null });
    await wait(10);
    rt.unmount();
    await wait(10);
    eq(closes().length, 2, "host leaves: taken off the list");
  }
  ok(/OPEN_ROOM_BEAT_MS = 15000/.test(src) && /setInterval\(beat, OPEN_ROOM_BEAT_MS\)/.test(src), "the room is re-announced every 15 s (the server forgets it after 45 s)");

  /* ---------- list and switch on screen ---------- */
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU }, rpcAny: (fn) => Promise.resolve({ data: fn === "open_rooms_list" ? [{ game: "court", code: "1234", name: "Аня", players: 3, max: null, lang: "ru" }, { game: "court", code: "8888", name: "", players: 6, max: 20, lang: "en" }] : null, error: null }) });
    let picked = null;
    rt.mount(e.C.OpenRoomsList, { game: "court", color: "var(--court)", onPick: (r) => { picked = r; } });
    let h = html(rt.result);
    ok(h.includes("Открытые комнаты") && !h.includes("Сейчас открытых комнат нет"), "before the answer: title only, no false 'no rooms'");
    await wait(20);
    h = html(rt.result);
    ok(h.includes("Аня") && h.includes("Игроков: 3") && h.includes("RU") && h.includes("Войти"), "rooms are listed with host, players and language");
    ok(h.includes("Игроков: 6/20") && h.includes("Игрок"), "a room with a limit shows it; a hidden name reads as Player");
    const buttons = []; (function walk(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === "button") buttons.push(n); if (n.props) walk(n.props.children); })(rt.result);
    buttons[0].props.onClick();
    eq(picked && picked.code, "1234", "tapping a room hands it to the menu");
    rt.unmount();
  }
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU }, rpcAny: () => Promise.resolve({ data: [], error: null }) });
    rt.mount(e.C.OpenRoomsList, { game: "bunker", color: "x", onPick: noop });
    await wait(20);
    ok(html(rt.result).includes("Сейчас открытых комнат нет"), "empty list explains how to open your own room");
    rt.unmount();
  }
  env = load({ react: React, local: { ...RU } }); C = env.C;
  let h = html(React.createElement(C.OpenRoomSwitch, { isHost: true, isPublic: false, onToggle: noop, color: "red" }));
  ok(h.includes("Открытая комната") && h.includes('aria-checked="false"') && h.includes('role="switch"'), "host sees the switch, off by default");
  ok(html(React.createElement(C.OpenRoomSwitch, { isHost: true, isPublic: true, onToggle: noop, color: "red" })).includes('aria-checked="true"'), "switch shows on");
  eq(html(React.createElement(C.OpenRoomSwitch, { isHost: false, isPublic: false, onToggle: noop, color: "red" })), "", "guests of a private room see nothing");
  ok(html(React.createElement(C.OpenRoomSwitch, { isHost: false, isPublic: true, onToggle: noop, color: "red" })).includes("сюда могут зайти другие игроки"), "guests of an open room are told it is open");
  const lobbyRoom = (isPublic) => ({ status: "lobby", hostId: "h", isPublic, players: { h: { name: "Хост", isHost: true, joinedAt: 1 }, g: { name: "Гость", joinedAt: 2 } } });
  for (const [name, Comp] of [["Bunker", C.BunkerLobby], ["Court", C.CourtLobby]]) {
    let toggled = 0;
    const hostHtml = html(React.createElement(Comp, { room: lobbyRoom(false), roomCode: "1234", playerId: "h", dispatch: noop, onStart: noop, onTogglePublic: () => toggled++, error: "", busy: false, connStatus: "idle" }));
    ok(hostHtml.includes('role="switch"'), name + " lobby: host has the open-room switch");
    const guestHtml = html(React.createElement(Comp, { room: lobbyRoom(true), roomCode: "1234", playerId: "g", dispatch: noop, onStart: noop, onTogglePublic: noop, error: "", busy: false, connStatus: "idle" }));
    ok(!guestHtml.includes('role="switch"') && guestHtml.includes("сюда могут зайти другие игроки"), name + " lobby: guest has no switch, sees the note");
  }
  ok(/active: !!\(room && room\.status === "lobby" && room\.isPublic && room\.hostId === playerId\)/.test(src), "Bunker/Court announce only from the host, only in the lobby, only when switched on");
  ok(/active: !!\(view\.is_host && view\.status === "lobby" && settings\.public\)/.test(src), "Mafia announces only from the host, only in the lobby, only when switched on");
  ok(src.includes('setSetting({ public: !settings.public })'), "Mafia lobby has the open-room switch");
  ok((src.match(/<OpenRoomsList/g) || []).length === 6, "the list is shown in all six online menus (incl. Durak, Blot, Blackjack)");
  ok(src.includes('openCounts[g.id] > 0 ? t("open.hubBadge")'), "the Hub cards show how many rooms are waiting");

  ok(src.includes('moderateDisplayNameClient(payload.name).slice(0, 20) || t("common.player")') && src.includes('moderateDisplayNameClient(payload.name).slice(0, 20) || t("court.participant")') && (src.match(/name: moderateDisplayNameClient\(name\)\.slice\(0, 20\) \|\| t\(/g) || []).length === 2, "names inside Bunker and Court rooms go through the name filter (rooms can be open to strangers now)");
  /* ---------- players who leave ---------- */
  eq(Object.keys(C.withoutLeftPlayers({ a: { name: "A" }, b: { name: "B", left: true }, c: { name: "C", away: true } })), ["a", "c"], "a new game/case is dealt to everyone except those who left (offline ones stay)");
  eq(C.withoutLeftPlayers(null), {}, "no players: no crash");
  ok(html(React.createElement(C.PlayerGoneTag, { player: { left: true } })).includes("вышел"), "left players are tagged «вышел»");
  ok(html(React.createElement(C.PlayerGoneTag, { player: { away: true } })).includes("не в сети"), "closed-page players are tagged «не в сети»");
  eq(html(React.createElement(C.PlayerGoneTag, { player: { name: "x" } })), "", "present players get no tag");
  for (const [name, Comp] of [["Bunker", C.BunkerLobby], ["Court", C.CourtLobby]]) {
    const room = { status: "lobby", hostId: "h", players: { h: { name: "Хост", isHost: true, joinedAt: 1 }, g: { name: "Гость", joinedAt: 2, away: true }, k: { name: "Тут", joinedAt: 3 } } };
    const hostView = html(React.createElement(Comp, { room, roomCode: "1234", playerId: "h", dispatch: noop, onStart: noop, onTogglePublic: noop, onRemovePlayer: noop, error: "", busy: false, connStatus: "idle" }));
    ok(hostView.includes("не в сети") && (hostView.match(/aria-label="Убрать из комнаты"/g) || []).length === 1, name + " lobby: host can remove only the offline player");
    const guestView = html(React.createElement(Comp, { room, roomCode: "1234", playerId: "k", dispatch: noop, onStart: noop, onTogglePublic: noop, onRemovePlayer: noop, error: "", busy: false, connStatus: "idle" }));
    ok(guestView.includes("не в сети") && !guestView.includes("Убрать из комнаты"), name + " lobby: guests see the tag but cannot remove");
  }
  ok(/announceGuestLeft\(\);/.test(src) && /event: gameKey \+ "_leave"/.test(src), "a guest going back to the menu tells the host");
  ok(/if \(current\.status === "lobby"\) delete players\[pid\];\s+else players\[pid\] = \{ \.\.\.players\[pid\], left: true, away: false \};/.test(src), "host: out of the lobby, or marked «left» in a running game");
  ok((src.match(/markGuestPresent\(channel\);/g) || []).length === 3, "guests mark themselves on the channel on join, on reconnect and after a takeover");
  ok(/if \(pid === current\.hostId \|\| !guestsSeenRef\.current\.has\(pid\)\) return;/.test(src), "a guest never seen on the channel (older page) is not marked offline");
  ok((src.match(/const here = withoutLeftPlayers\(current\.players\);/g) || []).length === 4, "Bunker start/restart and Court start/new case skip players who left");
  ok(/filter\(\(pid\) => !room\.players\[pid\]\.away\)\.length/.test(src), "the open-room list counts only players who are here");

  /* ---------- Court: jury outcome and reporting ---------- */
  const J = (votes) => Object.fromEntries(votes.map((v, k) => ["j" + k, { role: "juror", vote: v }]).concat([["a", { role: "guilty", vote: null }], ["v", { role: "victim", vote: "guilty" }]]));
  eq(C.courtJuryOutcome(J(["guilty", "guilty", "victim"])), "guilty", "majority guilty");
  eq(C.courtJuryOutcome(J(["victim", "victim", "guilty"])), "free", "majority not guilty");
  eq(C.courtJuryOutcome(J(["victim", "guilty"])), "tie", "split jury is a tie");
  eq(C.courtJuryOutcome(J([null, null])), "tie", "nobody voted: tie");
  eq(C.courtJuryOutcome(J(["victim"])), "free", "one juror decides alone (table of four)");
  eq(C.courtJuryOutcome({ v: { role: "victim", vote: "guilty" } }), "tie", "only jurors' votes count");
  eq(C.courtJuryOutcome(null), "tie", "no players: no crash");
  let reply = { data: { ok: true }, error: null };
  env = load({ react: React, local: { ...RU, hatsit_player_name_v1: "Аня" }, rpcAny: () => Promise.resolve(reply) }); C = env.C;
  const last = () => env.calls.filter((c) => c[0] === "record_court_case").pop();
  ok((await C.recordCourtCase({ role: "juror", vote: "victim" }, J(["victim", "victim"]))) === true, "counted case is reported as counted");
  eq([last()[1].p_role, last()[1].p_jury, last()[1].p_vote, last()[1].p_name], ["juror", "free", "free", "Аня"], "juror: own vote is sent in plain words");
  await C.recordCourtCase({ role: "guilty", vote: null }, J(["guilty"]));
  eq([last()[1].p_role, last()[1].p_jury, last()[1].p_vote], ["guilty", "guilty", null], "the accused sends no vote");
  await C.recordCourtCase({ role: "judge", vote: "guilty" }, J(["guilty", "victim"]));
  eq([last()[1].p_role, last()[1].p_jury, last()[1].p_vote], ["judge", "tie", null], "only a juror's vote is sent");
  ok(/^(tg|anon):[A-Za-z0-9_-]{1,70}$/.test(last()[1].p_id), "profile id has the shape the server accepts");
  reply = { data: { ok: true, already: true }, error: null };
  ok((await C.recordCourtCase({ role: "judge" }, {})) === false, "a repeat within 20 s is not celebrated twice");
  reply = { data: { error: "bad_request" }, error: null };
  ok((await C.recordCourtCase({ role: "judge" }, {})) === false, "a refused report is not counted");
  const n0 = env.calls.length;
  ok((await C.recordCourtCase({ role: null }, {})) === false && (await C.recordCourtCase(null, {})) === false && env.calls.length === n0, "no role yet: nothing is sent");
  ok(/if \(hasVerdict && !seen\.hasVerdict\) \{\s+const now = latestRef\.current;\s+recordCourtCase\(now\.me, now\.players\)/.test(src), "the case is reported exactly when the verdict appears");

  /* ---------- Court: achievements, titles, cases ---------- */
  const A = C.ACHIEVEMENTS.filter((a) => a.group === "court");
  eq(A.length, 12, "12 Court achievements");
  const unlocked = (profile) => C.computeUnlockedAchievementIds(profile).filter((id) => id.startsWith("court_"));
  eq(unlocked({}), [], "nothing for an empty profile");
  eq(unlocked({ court_played: 1 }), ["court_first"], "existing players get the first one for games already played");
  eq(unlocked({ court_cases: 1 }), ["court_first"], "a first reported case counts too");
  eq(unlocked({ court_played: 50, court_judge: 10, court_juror: 5, court_majority: 5, court_acquitted: 5, court_justice: 3, court_roles_mask: 31 }).length, 12, "a full profile unlocks all twelve");
  eq(unlocked({ court_roles_mask: 15 }), ["court_all_roles"], "four main roles are enough for 'all roles' (secretary not required)");
  eq(unlocked({ court_roles_mask: 16 }), ["court_secretary_1"], "secretary has its own");
  eq(unlocked({ court_roles_mask: 7 }), [], "three of four roles is not enough");
  for (const a of A) ok(typeof a.Icon === "function" && new RegExp('"' + a.titleKey.replace(/\./g, "\\.") + '": \\{ ru: "[^"]+", en: "[^"]+", hy: "[^"]+" \\}').test(src) && new RegExp('"' + a.descKey.replace(/\./g, "\\.") + '": \\{ ru: "[^"]+", en: "[^"]+", hy: "[^"]+" \\}').test(src), "achievement has an icon and 3-language texts: " + a.id);
  const courtTitles = C.PLAYER_TITLES.filter((x) => x.achievementId.startsWith("court_"));
  eq(courtTitles.map((x) => x.achievementId).sort(), ["court_10", "court_acquitted_5", "court_all_roles", "court_judge_10"], "four Court titles");
  ok(courtTitles.every((x) => x.label.ru && x.label.en && x.label.hy && A.some((a) => a.id === x.achievementId)), "each title has 3 languages and a real achievement behind it");
  const sql = fs.readFileSync(ROOT + "/supabase/profile_titles.sql", "utf8");
  ok(courtTitles.every((x) => sql.includes("'" + x.achievementId + "'")), "the server knows every Court title");
  ok(["court_played", "court_judge", "court_acquitted", "court_roles_mask"].every((k) => C.TITLE_PROFILE_FIELDS.includes(k)), "leaderboard rows carry what Court titles need");
  eq(C.getPlayerTitle({ court_judge: 10 }).label.ru, "Ваша честь", "ten verdicts -> «Ваша честь»");
  eq(C.COURT_CASES.length, 20, "20 cases (10 old + 10 new)");
  ok(C.COURT_CASES.every((c) => ["ru", "en", "hy"].every((l) => c.title[l] && c.title[l].length > 5 && c.description[l] && c.description[l].length > 40)), "every case has a title and a description in 3 languages");
  eq(new Set(C.COURT_CASES.map((c) => c.title.ru)).size, 20, "no duplicate cases");
  eq(C.COURT_CASES[0].title.ru, "Дело о похищенном варенье", "old cases keep their numbers (saved history still points at the right case)");
  for (const k of ["open.title", "open.empty", "open.players", "open.join", "open.switchTitle", "open.switchDesc", "open.guestNote", "open.hubBadge", "achievements.groupCourt", "profile.courtTitle", "profile.courtPlayed", "profile.courtJudge", "profile.courtJuror", "profile.courtAcquitted", "profile.courtJustice", "profile.courtMajority"]) {
    ok(new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ ru: "[^"]+", en: "[^"]+", hy: "[^"]+" \\}').test(src), "i18n in 3 languages: " + k);
  }
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
