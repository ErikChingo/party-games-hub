const ROOT = require("path").resolve(__dirname, "../..");
// Unit tests for the three "давай займёмся всеми 3мя" items added this
// pass: analytics (trackEvent + dispatch wrapping + hook points),
// display-name moderation (moderateDisplayNameClient), and the
// RPC-returns-profile-row wiring (recordWordlessScore/recordCountdownScore
// now return data instead of undefined). Extracts the real functions out
// of the compiled app bundle via a Function() sandbox, same technique as
// render_new_components_test.js, so this exercises the actual shipped
// code, not a reimplementation.
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

const vaCalls = [];
const windowStub = {
  location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" },
  addEventListener(){}, removeEventListener(){},
  matchMedia(){ return { matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }; },
  crypto: { randomUUID: () => "test-uuid-0000-0000-0000-000000000000" },
  requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
  innerWidth: 390, innerHeight: 844,
  va: (...args) => vaCalls.push(args),
};
windowStub.window = windowStub;
windowStub.Telegram = undefined;

const React = require("react");
const ReactDOMStub = { createRoot: () => ({ render(){} }), createPortal: (children) => children };
const fakeQueryBuilder = {
  select(){ return this; }, order(){ return this; }, limit(){ return this; }, eq(){ return this; }, gt(){ return this; },
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  insert: () => Promise.resolve({ data: null, error: null }),
  then(resolve){ resolve({ data: [], error: null, count: 0 }); },
};
const fakeSupabase = { createClient: () => ({ from: () => ({ ...fakeQueryBuilder }), rpc: () => Promise.resolve({ data: null, error: null }) }) };
windowStub.supabase = fakeSupabase;

const captured = {};
const fn = new Function(
  "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
  appCode +
    "\n;__capture.trackEvent = typeof trackEvent !== 'undefined' ? trackEvent : undefined;" +
    "__capture.LAUNCH_ACTION_TO_GAME = typeof LAUNCH_ACTION_TO_GAME !== 'undefined' ? LAUNCH_ACTION_TO_GAME : undefined;" +
    "__capture.moderateDisplayNameClient = typeof moderateDisplayNameClient !== 'undefined' ? moderateDisplayNameClient : undefined;"
);
fn(windowStub, documentStub, navigatorStub, makeStorage(), makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);

let passed = 0, failed = 0;
function check(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL: ${label}\n  expected ${e}\n  actual   ${a}`); }
}
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

/* ---- trackEvent ---- */
ok(typeof captured.trackEvent === "function", "trackEvent is exported at module scope");
vaCalls.length = 0;
captured.trackEvent("game_started", { game: "spy" });
check(vaCalls, [["event", { name: "game_started", data: { game: "spy" } }]], "trackEvent calls window.va with the right shape");

vaCalls.length = 0;
captured.trackEvent("no_data_event");
check(vaCalls, [["event", { name: "no_data_event", data: {} }]], "trackEvent defaults data to {} when omitted");

// Must never throw even if window.va is missing or throws -- this is
// best-effort analytics, not allowed to break the app.
const originalVa = windowStub.va;
windowStub.va = undefined;
let threw = false;
try { captured.trackEvent("x", {}); } catch (e) { threw = true; }
ok(!threw, "trackEvent does not throw when window.va is missing");
windowStub.va = () => { throw new Error("boom"); };
threw = false;
try { captured.trackEvent("x", {}); } catch (e) { threw = true; }
ok(!threw, "trackEvent does not throw when window.va itself throws");
windowStub.va = originalVa;

/* ---- LAUNCH_ACTION_TO_GAME ---- */
check(
  captured.LAUNCH_ACTION_TO_GAME,
  {
    LAUNCH_SPY: "spy",
    ALIAS_LAUNCH: "alias",
    CROC_LAUNCH: "croc",
    WORDLESS_LAUNCH: "wordless",
    COUNTDOWN_LAUNCH: "countdown",
    TELEPHONE_LAUNCH: "telephone",
    MAFIA_LAUNCH: "mafia",
  },
  "LAUNCH_ACTION_TO_GAME covers exactly the 7 offline games' launch actions"
);

/* ---- moderateDisplayNameClient ---- */
const mod = captured.moderateDisplayNameClient;
ok(typeof mod === "function", "moderateDisplayNameClient is exported at module scope");
check(mod("  Hello   World  "), "Hello World", "trims and collapses whitespace");
check(mod("Артём"), "Артём", "clean Cyrillic name passes through unchanged");
check(mod(""), "", "empty string -> empty");
check(mod(null), "", "null -> empty (no throw)");
check(mod("a".repeat(60)), "a".repeat(40), "truncates to 40 chars");
check(mod("fuck you"), "", "English profanity rejected");
check(mod("FuCkYoU"), "", "profanity check is case-insensitive");
check(mod("пиздец"), "", "Russian profanity rejected");
// Regression for the live gap the user found: "СУКА" (and related forms)
// were accepted, saved, and shown on the public leaderboard before this
// fix.
check(mod("СУКА"), "", "Russian 'сука' (bitch) rejected -- the exact live bug report");
check(mod("сука"), "", "lowercase 'сука' rejected");
check(mod("сучка"), "", "'сучка' (different root spelling, ч not к) rejected");
check(mod("падла"), "", "'падла' rejected");
check(mod("гнида"), "", "'гнида' rejected");
check(mod("шлюха"), "", "'шлюха' rejected");
check(mod("тварь"), "", "'тварь' rejected");
check(mod("мразь"), "", "'мразь' rejected");
check(mod("судьба"), "судьба", "'судьба' (unrelated word) is not a false positive");
check(mod("visit t.me/spam"), "", "t.me link rejected as spam");
check(mod("check out www.example.com"), "", "www. link rejected as spam");
check(mod("hey http://evil.test now"), "", "http(s) link rejected as spam");
check(mod("normal player name"), "normal player name", "ordinary English name passes through unchanged");

// Седьмой заход: comprehensive EN+RU word lists (user asked to cover
// "all English and Russian words", not just patch individual gaps).
// -- concatenation evasion (no space) must still be caught for the most
// common, most recognizable slurs:
check(mod("xXshitheadXx"), "", "'shithead' concatenated into a decorated nickname is still rejected");
check(mod("IHateYouBitch"), "", "'bitch' with no surrounding spaces is still rejected");
check(mod("naeburinigger123"), "", "'nigger' concatenated with other text is still rejected");
// -- but words that merely CONTAIN a short profanity root as a substring
// must NOT be blocked (this was the false-positive bug class fixed this
// pass -- word-boundary matching for the riskier short English words):
check(mod("classy"), "classy", "'ass' inside 'classy' is not a false positive");
check(mod("assistant"), "assistant", "'ass' inside 'assistant' is not a false positive");
check(mod("cockpit"), "cockpit", "'cock' inside 'cockpit' is not a false positive");
check(mod("Sussex"), "Sussex", "'sex' inside 'Sussex' is not a false positive");
check(mod("scumbag"), "scumbag", "'cum' inside 'scumbag' is not a false positive");
check(mod("Dickens"), "Dickens", "'dick' inside 'Dickens' is not a false positive");
check(mod("title"), "title", "'tit' inside 'title' is not a false positive");
// -- expanded Russian coverage (roots catch prefixed/suffixed forms):
check(mod("наебал"), "", "'наебал' (prefixed eb-root form) is rejected");
check(mod("охуенно"), "", "'охуенно' rejected");
check(mod("хер"), "", "bare 'хер' rejected");
check(mod("пидор"), "", "'пидор' rejected");
check(mod("гандон"), "", "'гандон' rejected");
check(mod("говнюк"), "", "'говнюк' rejected");
check(mod("дерьмо"), "", "'дерьмо' rejected");
// -- Russian roots must not break real, common words that happen to
// contain them as a substring (this is exactly the class of bug the
// "СУКА" fix introduced with the earlier "сук"/"суч" roots -- these are
// the specific collisions found this pass and special-cased):
check(mod("барсук"), "барсук", "'барсук' (badger) is not a false positive despite containing 'сук'");
check(mod("команда"), "команда", "'команда' (team) is not a false positive");
check(mod("оскорблять"), "оскорблять", "'оскорблять' (to insult) is not a false positive despite containing 'бля'");
check(mod("корабль"), "корабль", "'корабль' (ship) is not a false positive despite containing 'бля'");
check(mod("плохую"), "плохую", "'плохую' (bad, fem.) is not a false positive despite containing 'хую'");
check(mod("парикмахер"), "парикмахер", "'парикмахер' (hairdresser) is not a false positive despite containing 'хер'");
check(mod("педикюр"), "педикюр", "'педикюр' (pedicure) is not a false positive despite containing 'педик'");
check(mod("документ"), "документ", "'документ' is not a false positive");
check(mod("инструмент"), "инструмент", "'инструмент' is not a false positive");
check(mod("чмокнуть"), "чмокнуть", "'чмокнуть' (to peck/kiss) is not a false positive");
check(mod("волшебник"), "волшебник", "'волшебник' (wizard) is not a false positive despite containing 'ебн'");
check(mod("дебаты"), "дебаты", "'дебаты' (debates) is not a false positive despite containing 'ебат'");
// Zero-width / bidi-override characters get stripped, not just rejected --
// mirrors the server-side moderate_display_name() SQL function exactly.
check(mod("A​b‮c"), "Abc", "zero-width and bidi-override characters are stripped");
check(mod("\u0007\u007FBob"), "Bob", "ASCII control characters are stripped");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
