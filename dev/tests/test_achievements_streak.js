// Standalone unit tests for the pure logic behind the new retention
// features, mirroring computeUnlockedAchievementIds() and the streak
// ratchet in the record_daily_play() SQL function, before wiring into the
// app. Run with: node test_achievements_streak.js

const ACHIEVEMENTS = [
  { id: "first_steps", check: (p) => (p.wordless_best || 0) > 0 || (p.countdown_best || 0) > 0 },
  { id: "wordless_5", check: (p) => (p.wordless_best || 0) >= 5 },
  { id: "wordless_10", check: (p) => (p.wordless_best || 0) >= 10 },
  { id: "countdown_5", check: (p) => (p.countdown_best || 0) >= 5 },
  { id: "countdown_10", check: (p) => (p.countdown_best || 0) >= 10 },
  { id: "streak_3", check: (p) => (p.streak_longest || 0) >= 3 },
  { id: "streak_7", check: (p) => (p.streak_longest || 0) >= 7 },
  { id: "streak_30", check: (p) => (p.streak_longest || 0) >= 30 },
];
function computeUnlockedAchievementIds(profile) {
  if (!profile) return [];
  return ACHIEVEMENTS.filter((a) => {
    try {
      return !!a.check(profile);
    } catch (e) {
      return false;
    }
  }).map((a) => a.id);
}

// Mirrors the plpgsql branch in record_daily_play() exactly, so a client
// cache computed with this stays consistent with what the server will
// return.
function computeStreakUpdate(lastPlayedDateStr, prevCurrent, prevLongest, todayStr) {
  let current;
  if (!lastPlayedDateStr) {
    current = 1;
  } else if (lastPlayedDateStr === todayStr) {
    current = prevCurrent || 1;
  } else {
    const last = new Date(lastPlayedDateStr + "T00:00:00Z");
    const today = new Date(todayStr + "T00:00:00Z");
    const diffDays = Math.round((today - last) / 86400000);
    current = diffDays === 1 ? (prevCurrent || 0) + 1 : 1;
  }
  const longest = Math.max(prevLongest || 0, current);
  return { current, longest };
}

let passed = 0, failed = 0;
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  expected ${e}\n  actual   ${a}`);
  }
}

// --- achievements ---
assertEqual(computeUnlockedAchievementIds(null), [], "null profile -> no achievements");
assertEqual(computeUnlockedAchievementIds({ wordless_best: 0, countdown_best: 0, streak_longest: 0 }), [], "all zero -> no achievements");
assertEqual(computeUnlockedAchievementIds({ wordless_best: 1, countdown_best: 0, streak_longest: 0 }), ["first_steps"], "wordless 1 -> first_steps only");
assertEqual(
  computeUnlockedAchievementIds({ wordless_best: 5, countdown_best: 0, streak_longest: 0 }),
  ["first_steps", "wordless_5"],
  "wordless 5 -> first_steps + wordless_5"
);
assertEqual(
  computeUnlockedAchievementIds({ wordless_best: 12, countdown_best: 7, streak_longest: 3 }),
  ["first_steps", "wordless_5", "wordless_10", "countdown_5", "streak_3"],
  "mixed thresholds"
);
assertEqual(
  computeUnlockedAchievementIds({ wordless_best: 99, countdown_best: 99, streak_longest: 99 }),
  ACHIEVEMENTS.map((a) => a.id),
  "everything unlocked"
);

// --- streak ratchet ---
assertEqual(computeStreakUpdate(null, 0, 0, "2026-09-26"), { current: 1, longest: 1 }, "first ever visit -> streak 1");
assertEqual(computeStreakUpdate("2026-09-26", 4, 5, "2026-09-26"), { current: 4, longest: 5 }, "same day again -> unchanged");
assertEqual(computeStreakUpdate("2026-09-25", 4, 5, "2026-09-26"), { current: 5, longest: 5 }, "consecutive day -> +1");
assertEqual(computeStreakUpdate("2026-09-25", 6, 6, "2026-09-26"), { current: 7, longest: 7 }, "consecutive day, new longest");
assertEqual(computeStreakUpdate("2026-09-20", 10, 10, "2026-09-26"), { current: 1, longest: 10 }, "gap of days -> resets to 1, longest kept");
assertEqual(computeStreakUpdate("2026-08-31", 3, 3, "2026-09-01"), { current: 4, longest: 4 }, "consecutive across month boundary");
// Leap year Feb 29 2028 -> Mar 1 2028 is consecutive.
assertEqual(computeStreakUpdate("2028-02-29", 2, 2, "2028-03-01"), { current: 3, longest: 3 }, "consecutive across Feb 29 leap day");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
