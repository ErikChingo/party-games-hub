const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["useCardAchievements", "AchievementUnlockToast", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS, makeRuntime, wait };")(require, m, __dirname);
const { load, React, RDS, makeRuntime, wait } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const RU = { hatsitSettings: JSON.stringify({ language: "ru" }) };
(async () => {
  let C = load({ react: React, local: { ...RU } }).C;
  const ids = (prof) => C.computeUnlockedAchievementIds(prof).filter((id) => /^(durak|blot|bj)_/.test(id)).sort();
  eq(ids({}), [], "nothing without card games");
  eq(ids({ durak_games: 1, durak_wins: 10, durak_firsts: 10, durak_fools: 10 }), ["durak_first", "durak_first_10", "durak_fool_10", "durak_win_10"].sort(), "Durak achievements by the numbers");
  eq(ids({ blot_games: 1, blot_wins: 50, blot_made: 10, blot_capots: 1 }), ["blot_capot_1", "blot_first", "blot_made_10", "blot_win_10", "blot_win_50"].sort(), "Blot achievements");
  eq(ids({ bj_rounds: 1, bj_blackjacks: 10, bj_wins: 50, bj_best_chips: 5000 }), ["bj_blackjack_1", "bj_blackjack_10", "bj_chips_5000", "bj_first", "bj_win_50"].sort(), "Blackjack achievements");
  eq(C.getPlayerTitle({ blot_wins: 50, durak_wins: 50 }).achievementId, "blot_win_50", "Мастер блота outranks Козырной туз");
  eq(C.getPlayerTitle({ durak_fools: 10 }).label.ru, "Почётный дурак", "the fool's title exists");
  ok(C.ACHIEVEMENTS.filter((a) => a.group === "cards").every((a) => C.t_lookup(a.titleKey, "ru") !== a.titleKey && C.t_lookup(a.descKey, "hy") !== a.descKey), "every card achievement has its texts");
  ok(C.LEADERBOARD_TABS.some((x) => x.key === "blot") && C.LEADERBOARD_TABS.some((x) => x.key === "blackjack") && C.LEADERBOARD_TABS.some((x) => x.key === "durak"), "leaderboard tabs for the card games");
  // the toast after an online game
  for (const [label, view0, view1, toast] of [
    ["Durak, two people", { game: "durak", status: "playing", humans: 2, players: [] }, { game: "durak", status: "ended", humans: 2, round: 1, players: [] }, true],
    ["Durak against bots", { game: "durak", status: "playing", humans: 1, players: [] }, { game: "durak", status: "ended", humans: 1, round: 1, players: [] }, false],
    ["Blackjack round", { game: "blackjack", status: "playing", phase: "turns", round: 3, players: [{ bot: false }, { bot: false }] }, { game: "blackjack", status: "playing", phase: "score", round: 3, players: [{ bot: false }, { bot: false }] }, true],
  ]) {
    const rt = makeRuntime();
    const profile = { id: "anon:x", durak_games: 1, durak_wins: 1, bj_rounds: 1 };
    const e = load({ react: { ...React, ...rt.hooks }, local: { ...RU, hatsit_achievements_seen_v1: "[]" }, profile });
    let fetched = 0;
    rt.mount((v) => e.C.useCardAchievements(v), view0);
    rt.update(view1);
    await wait(1700);
    const shown = !!rt.result;
    eq(shown, toast, label + (toast ? ": new achievement celebrated" : ": nothing to celebrate"));
    rt.unmount();
  }
  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
