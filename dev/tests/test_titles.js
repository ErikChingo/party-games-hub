// Mirrors getPlayerTitle()'s priority logic standalone.
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
  return ACHIEVEMENTS.filter((a) => !!a.check(profile)).map((a) => a.id);
}
const PLAYER_TITLES = [
  { achievementId: "streak_30", label: "Бесконечный" },
  { achievementId: "streak_7", label: "Преданный" },
  { achievementId: "wordless_10", label: "Мастер тишины" },
  { achievementId: "countdown_10", label: "Несгибаемый" },
  { achievementId: "streak_3", label: "Постоянный" },
  { achievementId: "wordless_5", label: "Молчун" },
  { achievementId: "countdown_5", label: "Стойкий" },
  { achievementId: "first_steps", label: "Новичок" },
];
function getPlayerTitle(profile) {
  if (!profile) return null;
  const unlocked = new Set(computeUnlockedAchievementIds(profile));
  for (const tier of PLAYER_TITLES) {
    if (unlocked.has(tier.achievementId)) return tier;
  }
  return null;
}

let passed = 0, failed = 0;
function check(actual, expected, label) {
  if (actual === expected) passed++;
  else { failed++; console.error(`FAIL: ${label} -> expected ${expected}, got ${actual}`); }
}

check(getPlayerTitle(null), null, "null profile -> no title");
check(getPlayerTitle({}) === null, true, "empty stats -> null title");
check(getPlayerTitle({ wordless_best: 1 }).label, "Новичок", "first game only -> Новичок");
check(getPlayerTitle({ wordless_best: 5 }).label, "Молчун", "wordless 5 -> Молчун beats Новичок");
check(getPlayerTitle({ wordless_best: 10, streak_longest: 5 }).label, "Мастер тишины", "wordless10 + streak3-tier both unlocked -> higher-priority wordless_10 wins");
check(getPlayerTitle({ streak_longest: 30, wordless_best: 10 }).label, "Бесконечный", "everything unlocked -> top tier streak_30 wins");
check(getPlayerTitle({ countdown_best: 5 }).label, "Стойкий", "countdown 5 only");
check(getPlayerTitle({ streak_longest: 7 }).label, "Преданный", "streak 7 beats streak 3");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
