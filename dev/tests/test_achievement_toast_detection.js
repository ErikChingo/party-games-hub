// Mirrors detectNewlyUnlockedAchievements()'s logic standalone: given a
// profile snapshot and a per-device "seen" set persisted in localStorage,
// decide which achievements should fire a celebratory toast right now,
// and make sure (a) each one only ever fires once, and (b) upgrading an
// existing player to this feature doesn't flood them with toasts for
// achievements they already earned long before the feature existed.
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

// Fake localStorage, same shape as the real one used in index.html.
function makeStorage() {
  let store = {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

const ACHIEVEMENTS_SEEN_KEY = "hatsit_achievements_seen_v1";
function makeDetector(localStorage) {
  function loadSeenAchievementIds() {
    try {
      const raw = localStorage.getItem(ACHIEVEMENTS_SEEN_KEY);
      if (raw === null) return null;
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) {
      return null;
    }
  }
  function saveSeenAchievementIds(idsSet) {
    try {
      localStorage.setItem(ACHIEVEMENTS_SEEN_KEY, JSON.stringify(Array.from(idsSet)));
    } catch (e) {}
  }
  return function detectNewlyUnlockedAchievements(profile) {
    const unlockedNow = computeUnlockedAchievementIds(profile);
    const seen = loadSeenAchievementIds();
    if (seen === null) {
      saveSeenAchievementIds(new Set(unlockedNow));
      return [];
    }
    const freshIds = unlockedNow.filter((id) => !seen.has(id));
    if (freshIds.length > 0) {
      const next = new Set(seen);
      unlockedNow.forEach((id) => next.add(id));
      saveSeenAchievementIds(next);
    }
    return freshIds.map((id) => ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean);
  };
}

let passed = 0, failed = 0;
function check(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL: ${label}\n  expected ${e}\n  actual   ${a}`); }
}

// Brand-new device, never played: first call ever adopts the current
// (empty) state silently -- nothing to celebrate yet.
{
  const ls = makeStorage();
  const detect = makeDetector(ls);
  check(detect({ wordless_best: 0, countdown_best: 0, streak_longest: 0 }).map((a) => a.id), [], "new device, no stats -> nothing fresh");
}

// Existing player upgrading to this feature: they already have real
// progress (wordless_best 12) the very first time this code ever runs on
// their device. Must NOT dump every already-earned achievement on them as
// "new" -- that's the "silent migration" requirement.
{
  const ls = makeStorage();
  const detect = makeDetector(ls);
  const existingProfile = { wordless_best: 12, countdown_best: 3, streak_longest: 1 };
  check(detect(existingProfile).map((a) => a.id), [], "existing player's first-ever check -> adopted silently, nothing fresh");
  // From then on, genuinely new progress on the SAME device does fire.
  check(
    detect({ ...existingProfile, wordless_best: 15 }).map((a) => a.id),
    [],
    "no new threshold crossed yet -> still nothing (wordless_5/10 already adopted)"
  );
}

// Fresh progression, one achievement at a time, each fires exactly once.
{
  const ls = makeStorage();
  const detect = makeDetector(ls);
  check(detect({ wordless_best: 0, countdown_best: 0, streak_longest: 0 }), [], "seed silent baseline");
  check(detect({ wordless_best: 1, countdown_best: 0, streak_longest: 0 }).map((a) => a.id), ["first_steps"], "first ever score -> first_steps fires once");
  check(detect({ wordless_best: 1, countdown_best: 0, streak_longest: 0 }).map((a) => a.id), [], "re-checking same profile -> does not re-fire");
  check(
    detect({ wordless_best: 5, countdown_best: 0, streak_longest: 0 }).map((a) => a.id),
    ["wordless_5"],
    "crossing 5 -> only the newly crossed one fires, not first_steps again"
  );
}

// Multiple thresholds crossed in a single jump (e.g. a great first game)
// -- all of them should fire, none should be skipped or duplicated.
{
  const ls = makeStorage();
  const detect = makeDetector(ls);
  check(detect({ wordless_best: 0, countdown_best: 0, streak_longest: 0 }), [], "seed silent baseline");
  const fresh = detect({ wordless_best: 10, countdown_best: 0, streak_longest: 0 }).map((a) => a.id).sort();
  check(fresh, ["first_steps", "wordless_10", "wordless_5"], "jumping straight to level 10 -> all three fire together");
  check(detect({ wordless_best: 10, countdown_best: 0, streak_longest: 0 }).map((a) => a.id), [], "same profile again -> none re-fire");
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
