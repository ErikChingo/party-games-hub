const ROOT = require("path").resolve(__dirname, "../..");
// Regression test for the "не могу изменить имя" bug report: on a plain
// web visit, Telegram's own telegram-web-app.js script creates
// window.Telegram.WebApp unconditionally (platform: "unknown",
// initData: "" -- verified live on hatsit.vercel.app), so the old
// `isPlayerNameEditable() { return !tg(); }` was always false outside
// Telegram too, permanently hiding the name input for every non-Telegram
// visitor. The fix checks for an actual Telegram user
// (initDataUnsafe.user), matching getPlayerId()/getPlayerName()'s existing
// pattern. This test drives the real compiled function with three
// scenarios: no Telegram object at all, the "loaded but not really inside
// Telegram" stub (the actual bug), and a genuine Telegram session.
const fs = require("fs");
const path = require("path");

const DEPLOY_DIR = ROOT;
const html = fs.readFileSync(path.join(DEPLOY_DIR, "dist", "index.html"), "utf8");
const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, appCode = "";
while ((m = re.exec(html))) { if (m[1].length > appCode.length) appCode = m[1]; }

function makeStorage() {
  let store = {};
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
const React = require("react");
const ReactDOMStub = { createRoot: () => ({ render(){} }), createPortal: (children) => children };
const fakeQueryBuilder = {
  select(){ return this; }, order(){ return this; }, limit(){ return this; }, eq(){ return this; }, gt(){ return this; },
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  insert: () => Promise.resolve({ data: null, error: null }),
  then(resolve){ resolve({ data: [], error: null, count: 0 }); },
};
const fakeSupabase = { createClient: () => ({ from: () => ({ ...fakeQueryBuilder }), rpc: () => Promise.resolve({ data: null, error: null }) }) };

function runWithTelegram(telegramValue) {
  const windowStub = {
    location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" },
    addEventListener(){}, removeEventListener(){},
    matchMedia(){ return { matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }; },
    crypto: { randomUUID: () => "test-uuid-0000-0000-0000-000000000000" },
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 390, innerHeight: 844,
    va: () => {},
    supabase: fakeSupabase,
    Telegram: telegramValue,
  };
  windowStub.window = windowStub;
  const captured = {};
  const fn = new Function(
    "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
    appCode + "\n;__capture.isPlayerNameEditable = typeof isPlayerNameEditable !== 'undefined' ? isPlayerNameEditable : undefined;"
  );
  fn(windowStub, documentStub, navigatorStub, makeStorage(), makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);
  return captured.isPlayerNameEditable();
}

let passed = 0, failed = 0;
function check(actual, expected, label) {
  if (actual === expected) passed++;
  else { failed++; console.error(`FAIL: ${label}\n  expected ${expected}\n  actual   ${actual}`); }
}

// 1. No Telegram script loaded at all (window.Telegram undefined) -- name
// must be editable.
check(runWithTelegram(undefined), true, "no window.Telegram at all -> editable");

// 2. THE BUG: telegram-web-app.js loaded on a plain web visit. This is the
// exact shape confirmed live on hatsit.vercel.app just now: WebApp exists,
// but platform is "unknown" and initData/initDataUnsafe are empty -- no
// real Telegram session behind it. Must still be editable.
check(
  runWithTelegram({
    WebApp: {
      platform: "unknown",
      initData: "",
      initDataUnsafe: {},
      ready(){}, expand(){}, setHeaderColor(){}, setBackgroundColor(){},
      HapticFeedback: undefined,
      BackButton: { show(){}, hide(){}, onClick(){}, offClick(){} },
    },
  }),
  true,
  "telegram-web-app.js loaded on a plain web visit (the actual bug) -> must still be editable"
);

// 3. A genuine Telegram session (real initData + a real user in
// initDataUnsafe) -- name should NOT be editable, since it comes from the
// Telegram account instead.
check(
  runWithTelegram({
    WebApp: {
      platform: "ios",
      initData: "user=%7B%22id%22...",
      initDataUnsafe: { user: { id: 123456, first_name: "Erik" } },
      ready(){}, expand(){}, setHeaderColor(){}, setBackgroundColor(){},
      HapticFeedback: { notificationOccurred(){} },
      BackButton: { show(){}, hide(){}, onClick(){}, offClick(){} },
    },
  }),
  false,
  "genuine Telegram session with a real user -> not editable (name comes from Telegram)"
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
