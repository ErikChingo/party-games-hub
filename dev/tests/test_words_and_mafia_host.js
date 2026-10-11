const ROOT = require("path").resolve(__dirname, "../..");
// Covers the 4 Oct changes against the real compiled bundle:
//  - Alias/Charades "simple words" default + difficulty switch
//  - Mafia: host hand-off before the role table, per-speaker timer with
//    "next player", and the warnings system (3 = no vote once, 4 = out).
const fs = require("fs"), React = require("react"), RDS = require("react-dom/server");
const html = fs.readFileSync(ROOT + "/dist/index.html", "utf8");
const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, code = ""; while ((m = re.exec(html))) if (m[1].length > code.length) code = m[1];
const st = () => { let s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; };
const el = { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
const doc = { documentElement: { ...el }, addEventListener() {}, removeEventListener() {}, getElementById() { return el; }, createElement() { return { ...el }; }, querySelector() { return null; }, querySelectorAll() { return []; }, head: el, body: el, visibilityState: "visible" };
const qb = { select() { return this; }, order() { return this; }, limit() { return this; }, eq() { return this; }, gt() { return this; }, maybeSingle: () => Promise.resolve({ data: null, error: null }), then(r) { r({ data: [], error: null }); } };
const sb = { createClient: () => ({ from: () => ({ ...qb }), rpc: () => Promise.resolve({ data: null, error: null }) }) };
const w = { location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" }, addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; }, crypto: { randomUUID: () => "u" }, requestAnimationFrame: (c) => setTimeout(c, 0), cancelAnimationFrame: clearTimeout, innerWidth: 390, innerHeight: 844, supabase: sb };
w.window = w; w.Telegram = undefined;
const names = ["reducer", "initialState", "getActiveAliasWords", "getAliasCategoryWords", "ALIAS_CATEGORIES", "MafiaRoster", "MafiaGame", "MafiaSetup", "AliasSetup", "CrocSetup", "firstMafiaSpeaker", "nextAliveMafiaIndex"];
const C = {};
new Function("window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__c",
  code + ";" + names.map((n) => `__c.${n}=${n};`).join(""))(w, doc, { clipboard: { writeText: () => Promise.resolve() }, userAgent: "t", vibrate() {} }, st(), st(), React, { createRoot: () => ({ render() {} }), createPortal: (c) => c }, sb, console, C);

let p = 0, f = 0;
const ok = (c, l) => { c ? p++ : (f++, console.error("FAIL: " + l)); };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const render = (Comp, state) => RDS.renderToStaticMarkup(React.createElement(Comp, { state, dispatch() {} }));
const R = C.reducer;

/* ---------------- words ---------------- */
const allOn = C.initialState.config.aliasCategories;
const simple = C.getActiveAliasWords(allOn, false), all = C.getActiveAliasWords(allOn, true);
eq(simple.length, 1893, "simple pool size");
eq(all.length, 5384, "full pool size");
ok(simple.every((x) => all.includes(x)), "every simple word is also in the full pool");
for (const hard of ["Ондатра", "Выхухоль", "Синхрофазотрон", "Фагот", "Бланширование", "Маркшейдер", "Замиокулькас"]) ok(!simple.includes(hard) && all.includes(hard), `"${hard}" is only in the full pool`);
for (const easy of ["Кошка", "Медведь", "Пицца", "Врач", "Футбол", "Гитара", "Новый год", "Бежать"]) ok(simple.includes(easy), `"${easy}" is in the simple pool`);
ok(!all.some((x) => ["Саудовская", "Аравия", "Зеландия", "Тагил"].includes(x)) && all.includes("Саудовская Аравия") && all.includes("Новая Зеландия"), "split place names were merged back");
for (const k of Object.keys(C.ALIAS_CATEGORIES)) {
  const c = C.ALIAS_CATEGORIES[k];
  ok(c.ru.length === c.en.length && c.ru.length === c.hy.length && c.hard.ru.length === c.hard.en.length && c.hard.ru.length === c.hard.hy.length, `category ${k}: three languages stay aligned`);
  ok(c.ru.length >= 40, `category ${k}: simple set is big enough to play (${c.ru.length})`);
}
eq(C.getAliasCategoryWords("general", "en", false).length, 41, "per-language count uses the simple set");
eq(C.initialState.config.aliasHardWords, false, "Alias defaults to simple words");
eq(C.initialState.config.crocHardWords, false, "Charades defaults to simple words");
let s = R(C.initialState, { type: "ALIAS_LAUNCH" });
eq(s.alias.pool.length, 1893, "Alias launches with the simple pool by default");
s = R(R(C.initialState, { type: "ALIAS_SET_HARD_WORDS", value: true }), { type: "ALIAS_LAUNCH" });
eq(s.alias.pool.length, 5384, "Alias launches with every word after switching to 'all'");
s = R(C.initialState, { type: "CROC_LAUNCH" });
eq(s.croc.pool.length, 1893, "Charades launches with the simple pool by default");
s = R(R(C.initialState, { type: "CROC_SET_HARD_WORDS", value: true }), { type: "CROC_LAUNCH" });
eq(s.croc.pool.length, 5384, "Charades launches with every word after switching to 'all'");
// a state saved before this update has no aliasHardWords key at all
const legacyCfg = { ...C.initialState.config }; delete legacyCfg.aliasHardWords;
eq(R({ ...C.initialState, config: legacyCfg }, { type: "ALIAS_LAUNCH" }).alias.pool.length, 1893, "saved state without the new key still launches (simple)");
let mk = render(C.AliasSetup, C.initialState);
ok(mk.includes("Сложность слов") && mk.includes("1893"), "Alias setup shows the difficulty switch and the simple count");
mk = render(C.CrocSetup, R(C.initialState, { type: "CROC_SET_HARD_WORDS", value: true }));
ok(mk.includes("Сложность слов") && mk.includes("5384"), "Charades setup shows the full count when 'all words' is on");

/* ---------------- mafia: helpers ---------------- */
eq(C.nextAliveMafiaIndex([true, false, true, true], 0), 2, "next alive skips the dead");
eq(C.nextAliveMafiaIndex([true, false, true, true], 3), 0, "next alive wraps round the table");
eq(C.nextAliveMafiaIndex([false, false], 0), null, "nobody alive -> null");
eq(C.firstMafiaSpeaker([true, true, true], 1), 0, "day 1 opens with seat 1");
eq(C.firstMafiaSpeaker([true, true, true], 2), 1, "day 2 opens with seat 2");
eq(C.firstMafiaSpeaker([true, false, true], 2), 2, "opening seat is dead -> next alive opens");

/* ---------------- mafia: setup + hand-off ---------------- */
eq(C.initialState.config.mafiaSpeechSeconds, 60, "speech time defaults to 60s");
eq(R(C.initialState, { type: "MAFIA_SET_SPEECH_SECONDS", value: 5 }).config.mafiaSpeechSeconds, 15, "speech time clamps at 15s");
eq(R(C.initialState, { type: "MAFIA_SET_SPEECH_SECONDS", value: 999 }).config.mafiaSpeechSeconds, 300, "speech time clamps at 300s");
ok(render(C.MafiaSetup, C.initialState).includes("Время на речь игрока"), "setup shows the per-player speech time");

let base = R(C.initialState, { type: "MAFIA_SET_COUNT", value: 6 });
base = { ...base, config: { ...base.config, mafiaNames: ["Аня", "Боря", "Вика", "Гоша", "Даша", "Егор"] } };
let g = R(base, { type: "MAFIA_LAUNCH" });
eq(g.mafia.warnings, [0, 0, 0, 0, 0, 0], "everyone starts with 0 warnings");
for (let i = 0; i < 6; i++) g = R(g, { type: "MAFIA_NEXT_REVEAL" });
eq(g.screen, "mafia-roster", "after the last card the app goes to the host screen");
mk = render(C.MafiaRoster, g);
ok(mk.includes("Передай телефон Ведущему"), "host screen first shows the hand-off");
ok(!["Аня", "Боря", "Вика", "Гоша", "Даша", "Егор"].some((n) => mk.includes(n)), "hand-off shows no player rows (so no roles)");
ok(!/Мирн|Доктор|Шериф/.test(mk), "hand-off shows no role names");

/* ---------------- mafia: day timer + speakers ---------------- */
const day = (over, cfg) => R({ ...g, config: { ...g.config, ...(cfg || {}) }, screen: "mafia-game", mafia: { ...g.mafia, roles: ["mafia", "civilian", "civilian", "doctor", "sheriff", "civilian"], phase: "night-result", night: 1, ...over } }, { type: "MAFIA_CONTINUE" });
let d = day();
eq([d.mafia.phase, d.mafia.dayTimer, d.mafia.speakerIndex, d.mafia.speakerTurn], ["day", { remaining: 60, running: true }, 0, 0], "day starts: 60s running, seat 1 speaks");
eq(day({}, { mafiaSpeechSeconds: 90 }).mafia.dayTimer.remaining, 90, "day uses the configured speech time");
const legacy = { ...g.config }; delete legacy.mafiaSpeechSeconds;
eq(R({ ...g, config: legacy, screen: "mafia-game", mafia: { ...g.mafia, phase: "night-result", night: 1 } }, { type: "MAFIA_CONTINUE" }).mafia.dayTimer.remaining, 60, "saved state without the new key falls back to 60s");
eq(day({ night: 2 }).mafia.speakerIndex, 1, "day 2 opens with seat 2");
for (let i = 0; i < 25; i++) d = R(d, { type: "MAFIA_DAY_TICK" });
eq(d.mafia.dayTimer.remaining, 35, "timer counts down");
let d2 = R(d, { type: "MAFIA_RESTART_DAY_TIMER" });
eq([d2.mafia.dayTimer, d2.mafia.speakerIndex], [{ remaining: 60, running: true }, 0], "restart: full time again, same speaker");
d2 = R(d, { type: "MAFIA_NEXT_SPEAKER" });
eq([d2.mafia.dayTimer, d2.mafia.speakerIndex, d2.mafia.speakerTurn], [{ remaining: 60, running: true }, 1, 1], "next player: full time again, next seat");
let dd = day({ alive: [true, false, false, true, true, true] });
dd = R(dd, { type: "MAFIA_NEXT_SPEAKER" });
eq(dd.mafia.speakerIndex, 3, "next player skips eliminated seats");
for (let i = 0; i < 3; i++) dd = R(dd, { type: "MAFIA_NEXT_SPEAKER" });
eq(dd.mafia.speakerIndex, 0, "speaker order wraps back to the start");
let paused = R(d, { type: "MAFIA_TOGGLE_DAY_TIMER" });
eq(R(paused, { type: "MAFIA_DAY_TICK" }).mafia.dayTimer.remaining, 35, "paused timer does not tick");
let zero = d; for (let i = 0; i < 40; i++) zero = R(zero, { type: "MAFIA_DAY_TICK" });
eq(zero.mafia.dayTimer, { remaining: 0, running: false }, "timer stops at zero");
mk = render(C.MafiaGame, d);
ok(mk.includes("Аня") && mk.includes("Следующий: Боря") && mk.includes("0:35"), "day screen shows who speaks, who is next and the time");

/* ---------------- mafia: warnings ---------------- */
const W = (state, i) => R(state, { type: "MAFIA_WARN", index: i });
let x = W(W(d, 2), 2);
eq([x.mafia.warnings[2], x.mafia.noVote[2], x.mafia.alive[2], x.mafia.phase], [2, false, true, "day"], "2 warnings: nothing happens yet");
x = W(x, 2);
eq([x.mafia.warnings[2], x.mafia.noVote[2], x.mafia.alive[2]], [3, true, true], "3 warnings: loses the vote, stays in the game");
ok(x.mafia.log.some((e) => e.type === "warn-novote" && e.index === 2), "3rd warning is written to the history");
let opened = R(x, { type: "MAFIA_OPEN_EXILE" });
mk = render(C.MafiaGame, opened);
ok(mk.includes("В этом голосовании не участвуют") && mk.includes("Вика"), "vote screen reminds the host who is not voting");
let undone = R(x, { type: "MAFIA_UNWARN", index: 2 });
eq([undone.mafia.warnings[2], undone.mafia.noVote[2], undone.mafia.log.some((e) => e.type === "warn-novote")], [2, false, false], "taking the 3rd warning back restores the vote and the history");
eq(R(d, { type: "MAFIA_UNWARN", index: 2 }).mafia.warnings[2], 0, "can't go below 0 warnings");
let voted = R(opened, { type: "MAFIA_EXILE", index: null });
eq([voted.mafia.noVote[2], voted.mafia.warnings[2]], [false, 3], "after that one vote the player votes again, count stays at 3");
let day2 = R({ ...voted, mafia: { ...voted.mafia, phase: "night-result", night: 2 } }, { type: "MAFIA_CONTINUE" });
let out = W(day2, 2);
eq([out.mafia.warnings[2], out.mafia.alive[2], out.mafia.phase, out.mafia.removedIndex, out.mafia.dayTimer.running, out.mafia.winner], [4, false, "day-removed", 2, false, null], "4th warning: player is out, timer pauses");
ok(out.mafia.log.some((e) => e.type === "warn-out" && e.index === 2), "removal is written to the history");
mk = render(C.MafiaGame, out);
ok(mk.includes("Вика выбывает из игры") && mk.includes("Продолжить день"), "removal screen names the player and offers to continue");
let cont = R(out, { type: "MAFIA_CONTINUE" });
eq([cont.mafia.phase, cont.screen, cont.mafia.removedIndex], ["day", "mafia-game", null], "game carries on with the day after a removal");
eq(W(cont, 2).mafia.warnings[2], 4, "a removed player can't be warned again");
// speaker removed -> floor passes on
let sp = { ...day2, mafia: { ...day2.mafia, speakerIndex: 2 } };
eq(W(sp, 2).mafia.speakerIndex, 3, "if the speaker is removed the floor passes to the next player");
// removing the last mafia ends the game
let last = { ...d, mafia: { ...d.mafia, warnings: [3, 0, 0, 0, 0, 0], noVote: [true, false, false, false, false, false] } };
last = W(last, 0);
eq([last.mafia.winner, last.mafia.phase], ["town", "day-removed"], "removing the only mafia makes the town win");
eq(R(last, { type: "MAFIA_CONTINUE" }).screen, "mafia-end", "…and continue goes to the results");
// only during the day
const night = { ...d, mafia: { ...d.mafia, phase: "night-mafia" } };
eq(W(night, 1).mafia.warnings[1], 0, "warnings can't be given at night");
// panel + roster
mk = render(C.MafiaGame, R(x, { type: "MAFIA_TOGGLE_WARNINGS" }));
ok(mk.includes("Предупреждения") && mk.includes("3/4") && mk.includes("Без голоса") && mk.includes("Аня"), "warnings panel lists players, counts and the no-vote badge");
mk = render(C.MafiaGame, R(x, { type: "MAFIA_TOGGLE_ROSTER" }));
ok(mk.includes("Вика") && />3</.test(mk), "roster shows the warning count next to the player");
mk = render(C.MafiaGame, R(out, { type: "MAFIA_TOGGLE_HISTORY" }));
ok(mk.includes("Вика выбывает: 4 предупреждения") && mk.includes("3 предупреждения — пропускает голосование"), "history lists both warning events");

console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
