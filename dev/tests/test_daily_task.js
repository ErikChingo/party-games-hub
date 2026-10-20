const ROOT = require("path").resolve(__dirname, "../..");
// The daily task («Задание дня»): which task a date gets, how finished games
// complete it (bots and online included), the run of days, the report to
// record_daily_task(), the Hub card, and the achievements and title.
const fs = require("fs");
const head = fs.readFileSync(__dirname + "/test_mafia_room_client.js", "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["DAILY_TASKS", "dailyTaskFor", "dayBefore", "todayDateString", "trackEvent", "loadDaily", "DailyTaskCard", "Hub", "ACHIEVEMENTS", "PLAYER_TITLES", "TITLE_PROFILE_FIELDS", "computeUnlockedAchievementIds", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS, wait };")(require, m, __dirname);
const { load, React, RDS, wait } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const src = fs.readFileSync(ROOT + "/index.html", "utf8");
const RU = { hatsitSettings: JSON.stringify({ language: "ru" }) };
const html = (el) => RDS.renderToStaticMarkup(el);

// A fake record_daily_task: counts each day once, like the database function.
function server() {
  const row = { id: "anon:t", daily_done: 0, daily_streak: 0, daily_best: 0, daily_last: null };
  const calls = [];
  const rpcAny = (fn, args) => {
    if (fn !== "record_daily_task") return Promise.resolve({ data: null, error: null });
    calls.push(args);
    if (!row.daily_last || args.p_day > row.daily_last) {
      const d = new Date(args.p_day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - 1);
      row.daily_streak = row.daily_last === d.toISOString().slice(0, 10) ? row.daily_streak + 1 : 1;
      row.daily_best = Math.max(row.daily_best, row.daily_streak);
      row.daily_done += 1;
      row.daily_last = args.p_day;
    }
    return Promise.resolve({ data: { ...row }, error: null });
  };
  return { row, calls, rpcAny };
}
// An event that does (or, with miss, does not) complete a task.
function eventFor(task, miss) {
  if (task.need) return { game: "spy" };
  const won = !miss;
  if (task.id.endsWith("_win")) return task.game === "durak" ? { game: "durak", mode: "bots", lost: !won } : { game: task.game, mode: "bots", won };
  return miss ? { game: "spy" } : { game: task.game, mode: "bots" };
}

(async () => {
  const C = load({ react: React, local: { ...RU } }).C;

  /* ---------- the task of the day ---------- */
  const days = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 9, 20 + i)).toISOString().slice(0, 10));
  eq(new Set(days.map((d) => C.dailyTaskFor(d).id)).size, C.DAILY_TASKS.length, "eight days in a row bring all eight tasks");
  eq(C.dailyTaskFor("2026-10-20").id, C.dailyTaskFor("2026-10-20").id, "the same date, the same task for everyone");
  ok(days.slice(1).every((d, i) => C.dailyTaskFor(d).id !== C.dailyTaskFor(days[i]).id), "never the same task two days running");
  eq(C.dayBefore("2026-11-01"), "2026-10-31", "the day before, across a month");
  ok(C.DAILY_TASKS.every((t) => !t.game || ["nardy", "durak", "blot", "blackjack"].includes(t.game)), "every task can be done alone, with a bot");
  for (const t of C.DAILY_TASKS) ok(["ru", "en", "hy"].every((l) => C.t_lookup("daily.task." + t.id, l) !== "daily.task." + t.id), "3-language text: " + t.id);

  /* ---------- every task, on a day that has it (the clock is set to that day) ---------- */
  const RealDate = Date;
  const at = (day) => { const fixed = new RealDate(day + "T12:00:00"); global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed.getTime()])); } static now() { return fixed.getTime(); } }; };
  for (const task of C.DAILY_TASKS) {
    const day = days.find((d) => C.dailyTaskFor(d).id === task.id);
    at(day);
    const sv = server();
    const e = load({ react: React, local: { ...RU, hatsit_player_id_v1: "anon:t" }, rpcAny: sv.rpcAny });
    const done = () => e.C.loadDaily().done;
    eq(e.C.todayDateString(), day, task.id + ": the clock is on " + day);
    e.C.trackEvent("game_completed", eventFor(task, true));
    eq(done(), false, task.id + ": a game that does not fit leaves it open");
    e.C.trackEvent("game_completed", task.need ? { game: "durak", mode: "bots", lost: true } : eventFor(task, false));
    eq(done(), true, task.id + ": " + (task.need ? "a second, different game" : "its game") + " completes it");
    await wait(5);
    eq(sv.calls.map((c) => c.p_day), [day], task.id + ": the day goes to the server once");
    if (task.game) ok(e.C.trackEvent("game_completed", { game: task.game, mode: "online", won: true }) === undefined && sv.calls.length === 1, task.id + ": nothing more that day");
  }
  global.Date = RealDate;

  /* ---------- today's task, end to end: progress, run of days, report, toast data ---------- */
  {
    const sv = server();
    const e = load({ react: React, local: { ...RU, hatsit_player_id_v1: "anon:t" }, rpcAny: sv.rpcAny });
    const today = e.C.todayDateString();
    const task = e.C.dailyTaskFor(today);
    const yesterday = e.C.dayBefore(today);
    sv.row.daily_last = yesterday; sv.row.daily_streak = 4; sv.row.daily_best = 4; sv.row.daily_done = 9;
    e.ls.setItem("hatsit_daily_v1", JSON.stringify({ day: yesterday, done: true, games: ["nardy"], streak: 4, best: 4, total: 9, lastDone: yesterday }));
    const card = () => html(React.createElement(e.C.DailyTaskCard, { dispatch() {} }));
    let pg = card();
    ok(pg.includes("Задание дня") && pg.includes(e.C.t_lookup("daily.task." + task.id, "ru")) && pg.includes("4 дн. подряд"), "a new day: the new task, yesterday's run still shown");
    ok(task.game ? pg.includes(">Играть<") : pg.includes("Сыграно: 0 из 2"), "a button to the game (or the progress of «two games»)");
    e.C.trackEvent("game_completed", task.need ? { game: "spy" } : eventFor(task, false));
    if (task.need) e.C.trackEvent("game_completed", { game: "durak", mode: "bots", lost: true });
    await wait(5);
    const st = e.C.loadDaily();
    eq([st.done, st.streak, st.total], [true, 5, 10], "done: five days in a row, ten in all (as the server counted)");
    pg = card();
    ok(pg.includes("✅") && pg.includes("Новое задание — завтра") && !pg.includes(">Играть<"), "the card shows it done");
    e.C.trackEvent("game_completed", { game: "nardy", mode: "bots", won: true });
    await wait(5);
    eq(sv.calls.length, 1, "more games the same day are not reported again");
    // Missed a day: the run starts over.
    e.ls.setItem("hatsit_daily_v1", JSON.stringify({ day: e.C.dayBefore(yesterday), done: true, games: [], streak: 7, best: 7, total: 20, lastDone: e.C.dayBefore(yesterday) }));
    pg = card();
    ok(!pg.includes("дн. подряд"), "after a missed day the run is not shown");
  }

  /* ---------- the Hub, achievements, title, server ---------- */
  {
    const pg = html(React.createElement(C.Hub, { state: { feedbackPending: null }, dispatch() {} }));
    ok(pg.includes("Задание дня"), "the card is on the Hub");
    const A = C.ACHIEVEMENTS.filter((a) => a.id.startsWith("daily_"));
    eq(A.map((a) => a.id), ["daily_1", "daily_7", "daily_30"], "three daily-task achievements");
    ok(A.every((a) => !a.group && ["ru", "en", "hy"].every((l) => C.t_lookup(a.titleKey, l) !== a.titleKey && C.t_lookup(a.descKey, l) !== a.descKey)), "in the general group, with 3-language texts");
    eq(C.computeUnlockedAchievementIds({ daily_done: 7 }).filter((x) => x.startsWith("daily_")), ["daily_1", "daily_7"], "seven tasks: two of them");
    const title = C.PLAYER_TITLES.find((x) => x.achievementId === "daily_30");
    ok(title && title.label.ru === "Мастер заданий" && C.TITLE_PROFILE_FIELDS.includes("daily_done"), "the «Мастер заданий» title");
    const sql = fs.readFileSync(ROOT + "/supabase/daily_task.sql", "utf8");
    ok(sql.includes("function public.record_daily_task") && sql.includes("'daily_30'") && /current_date - 1 or p_day > current_date \+ 1/.test(sql), "the database counts each day once, near today only, and knows the title");
    ok(/if \(name === "game_completed"\) noteDailyGame\(data\);\n  if \(!pairGameEvent/.test(src), "a guest's online game counts too (before the start/end pairing)");
    ok(/won: wonOnline/.test(src), "online games tell whether I won");
  }

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
