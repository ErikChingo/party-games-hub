const ROOT = require("path").resolve(__dirname, "../..");
// Regression/coverage test for the cosmetics feature added 29 сентября
// ("давай добавим все типы которые ты перечислил"): PLAYER_TITLES gaining
// icon+rare fields, getPlayerTitle() respecting profile.selected_title, and
// the new setSelectedTitle() client wrapper around the set_selected_title
// RPC. Extracts the real compiled functions out of dist/index.html via a
// Function() sandbox, same technique as test_setplayername_rpc_resilience.js
// and test_analytics_and_moderation.js, so this exercises the actual
// shipped code, not a reimplementation.
const fs = require("fs");
const path = require("path");

const DEPLOY_DIR = ROOT;
const html = fs.readFileSync(path.join(DEPLOY_DIR, "dist", "index.html"), "utf8");
const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, appCode = "";
while ((m = re.exec(html))) { if (m[1].length > appCode.length) appCode = m[1]; }

function makeStorage(initial) {
  let store = { ...(initial || {}) };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}
const fakeElement = {
  style: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
  setAttribute(){}, getAttribute(){ return null; }, appendChild(){}, addEventListener(){}, removeEventListener(){},
  querySelector(){ return null; }, querySelectorAll(){ return []; },
};
const documentStub = {
  documentElement: { ...fakeElement, setAttribute(name, val){ this[name] = val; } },
  addEventListener(){}, removeEventListener(){}, getElementById(){ return fakeElement; },
  createElement(){ return { ...fakeElement }; }, querySelector(){ return null; }, querySelectorAll(){ return []; },
  head: fakeElement, body: fakeElement, visibilityState: "visible",
};
const navigatorStub = { clipboard: { writeText: () => Promise.resolve() }, vibrate(){}, userAgent: "unit-test", share: undefined };

const windowStub = {
  location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" },
  addEventListener(){}, removeEventListener(){},
  matchMedia(){ return { matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }; },
  crypto: { randomUUID: () => "test-uuid-0000-0000-0000-000000000000" },
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
  innerWidth: 390, innerHeight: 844,
  va: () => {},
};
windowStub.window = windowStub;
windowStub.Telegram = undefined;

const React = require("react");
const ReactDOMStub = { createRoot: () => ({ render(){} }), createPortal: (children) => children };

// Swappable per-test: what supabaseClient.rpc(...) returns/does, and what
// calls it actually recorded (so setSelectedTitle's arguments can be
// asserted on).
let rpcImpl = () => Promise.resolve({ data: null, error: null });
const rpcCalls = [];
const fakeQueryBuilder = {
  select(){ return this; }, order(){ return this; }, limit(){ return this; }, eq(){ return this; }, gt(){ return this; },
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  insert: () => Promise.resolve({ data: null, error: null }),
  then(resolve){ resolve({ data: [], error: null, count: 0 }); },
};
const fakeSupabase = {
  createClient: () => ({
    from: () => ({ ...fakeQueryBuilder }),
    rpc: (name, args) => {
      rpcCalls.push([name, args]);
      return rpcImpl(name, args);
    },
  }),
};
windowStub.supabase = fakeSupabase;

const storage = makeStorage();
const captured = {};
const fn = new Function(
  "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
  appCode +
    "\n;__capture.getPlayerTitle = typeof getPlayerTitle !== 'undefined' ? getPlayerTitle : undefined;" +
    "__capture.PLAYER_TITLES = typeof PLAYER_TITLES !== 'undefined' ? PLAYER_TITLES : undefined;" +
    "__capture.setSelectedTitle = typeof setSelectedTitle !== 'undefined' ? setSelectedTitle : undefined;"
);
fn(windowStub, documentStub, navigatorStub, storage, makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}
function check(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL: ${label}\n  expected ${e}\n  actual   ${a}`); }
}

const getPlayerTitle = captured.getPlayerTitle;
const PLAYER_TITLES = captured.PLAYER_TITLES;
const setSelectedTitle = captured.setSelectedTitle;

/* ---- PLAYER_TITLES: icon + rare fields ---- */
ok(Array.isArray(PLAYER_TITLES) && PLAYER_TITLES.length === 24, "PLAYER_TITLES has 24 tiers (8 original + 5 for online Mafia + 4 for Court + 4 for card games + 2 for nardy + 1 for daily tasks)");
ok(PLAYER_TITLES.every((t) => typeof t.icon === "string" && t.icon.length > 0), "every tier has a non-empty icon");
ok(PLAYER_TITLES.every((t) => typeof t.rare === "boolean"), "every tier has a boolean rare flag");
const rareTiers = PLAYER_TITLES.filter((t) => t.rare);
check(rareTiers.map((x) => x.achievementId).join(), "streak_30,mafia_win_25,blot_win_50,nardy_win_50", "the rare tiers: month streak, Mafia legend, Blot master, Nardy master");
check(rareTiers[0] && rareTiers[0].achievementId, "streak_30", "the rare tier is streak_30 (the top/rarest achievement)");

/* ---- getPlayerTitle(): selected_title support ---- */
ok(typeof getPlayerTitle === "function", "getPlayerTitle is exported at module scope");

// No selection made yet (selected_title absent/null) -> old auto-highest
// behavior is unchanged.
check(getPlayerTitle({ wordless_best: 10, streak_longest: 7 }).achievementId, "streak_7", "no selected_title -> falls back to highest-unlocked tier (unchanged behavior)");

// A valid, unlocked selection is honored even when it's not the highest tier.
check(
  getPlayerTitle({ wordless_best: 10, streak_longest: 7, selected_title: "wordless_10" }).achievementId,
  "wordless_10",
  "selected_title picks a lower, still-unlocked tier instead of the auto-highest one"
);

// A selection for something NOT actually unlocked (stale local data, or a
// tampered value) must never be honored -- falls back to auto-highest.
check(
  getPlayerTitle({ wordless_best: 10, streak_longest: 7, selected_title: "streak_30" }).achievementId,
  "streak_7",
  "selected_title for an un-unlocked tier is ignored -- falls back to auto-highest"
);

// An unrecognized id (typo, future removed tier) also falls back cleanly
// instead of throwing or returning null.
check(
  getPlayerTitle({ wordless_best: 10, selected_title: "not_a_real_tier" }).achievementId,
  "wordless_10",
  "unknown selected_title id falls back to auto-highest without throwing"
);

// Nothing unlocked at all -> still null regardless of selected_title.
check(getPlayerTitle({ selected_title: "streak_30" }), null, "selected_title can't grant a title with nothing actually unlocked");

/* ---- setSelectedTitle(): RPC wrapper ---- */
ok(typeof setSelectedTitle === "function", "setSelectedTitle is exported at module scope");

rpcImpl = () => Promise.resolve({ data: null, error: null });
rpcCalls.length = 0;
setSelectedTitle("streak_7").then((ok1) => {
  ok(ok1 === true, "setSelectedTitle resolves true on success");
  check(rpcCalls[rpcCalls.length - 1][0], "set_selected_title", "calls the set_selected_title RPC");
  check(rpcCalls[rpcCalls.length - 1][1].p_title_id, "streak_7", "passes the chosen tier id as p_title_id");

  rpcImpl = () => Promise.resolve({ data: null, error: null });
  rpcCalls.length = 0;
  setSelectedTitle(null).then((ok2) => {
    ok(ok2 === true, "setSelectedTitle(null) (reset to automatic) also resolves true");
    check(rpcCalls[rpcCalls.length - 1][1].p_title_id, null, "passes null through as p_title_id to reset to automatic mode");

    rpcImpl = () => Promise.resolve({ data: null, error: { message: "boom" } });
    setSelectedTitle("streak_30").then((ok3) => {
      ok(ok3 === false, "setSelectedTitle resolves false when the RPC returns an error");

      rpcImpl = () => Promise.reject(new Error("network-fail"));
      setSelectedTitle("streak_30").then((ok4) => {
        ok(ok4 === false, "setSelectedTitle resolves false (never throws) when the RPC call itself rejects");

        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed ? 1 : 0);
      });
    });
  });
});
