const ROOT = require("path").resolve(__dirname, "../..");
// The statistics page counts "game_started" and "game_completed". A game may
// count as completed at most once per start on the same device: Blackjack's
// endless rounds, Alias's round-end screen or a refresh on an end screen must
// not inflate it, and a guest in an online room (the host logged the start)
// adds nothing. Drives the real compiled trackEvent and watches log_event.
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
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
  documentElement: { ...fakeElement }, addEventListener(){}, removeEventListener(){}, getElementById(){ return fakeElement; },
  createElement(){ return { ...fakeElement }; }, querySelector(){ return null; }, querySelectorAll(){ return []; },
  head: fakeElement, body: fakeElement, visibilityState: "visible",
};
const makeNavigator = (extra) => ({ clipboard: { writeText: () => Promise.resolve() }, vibrate(){}, userAgent: "unit-test", share: undefined, ...extra });
const React = require("react");
const ReactDOMStub = { createRoot: () => ({ render(){} }), createPortal: (children) => children };
const logged = [];
const fakeQueryBuilder = {
  select(){ return this; }, order(){ return this; }, limit(){ return this; }, eq(){ return this; }, gt(){ return this; },
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  insert: () => Promise.resolve({ data: null, error: null }),
  then(resolve){ resolve({ data: [], error: null, count: 0 }); },
};
const rpc = (fn, args) => { if (fn === "log_event") logged.push(args.p_name + ":" + args.p_game); return Promise.resolve({ data: null, error: null }); };
const fakeSupabase = { createClient: () => ({ from: () => ({ ...fakeQueryBuilder }), rpc }) };

function load(navigatorExtra) {
  const navigatorStub = makeNavigator(navigatorExtra);
  const windowStub = {
    location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" },
    addEventListener(){}, removeEventListener(){},
    matchMedia(){ return { matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }; },
    crypto: { randomUUID: () => "test-uuid-0000-0000-0000-000000000000" },
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 390, innerHeight: 844, va: () => {}, supabase: fakeSupabase,
  };
  windowStub.window = windowStub;
  const captured = {};
  new Function(
    "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
    appCode + "\n;__capture.trackEvent = trackEvent;"
  )(windowStub, documentStub, navigatorStub, makeStorage(), makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);
  return captured.trackEvent;
}

let passed = 0, failed = 0;
const eq = (a, b, label) => {
  if (JSON.stringify(a) === JSON.stringify(b)) passed++;
  else { failed++; console.log(`FAIL: ${label}\n  expected ${JSON.stringify(b)}\n  actual   ${JSON.stringify(a)}`); }
};
const run = (steps, navigatorExtra) => {
  const track = load(navigatorExtra);
  logged.length = 0;
  steps.forEach(([name, game]) => track(name, { game }));
  return logged.slice();
};

eq(run([["game_started", "durak"], ["game_completed", "durak"]]), ["game_started:durak", "game_completed:durak"], "start + end -> both logged");
eq(run([["game_started", "blackjack"], ["game_completed", "blackjack"], ["game_completed", "blackjack"], ["game_completed", "blackjack"]]),
  ["game_started:blackjack", "game_completed:blackjack"], "Blackjack: many rounds -> one completed");
eq(run([["game_completed", "blot"]]), [], "guest who did not start the game -> nothing");
eq(run([["game_started", "durak"], ["game_completed", "blot"]]), ["game_started:durak"], "a different game ending -> nothing");
eq(run([["game_started", "court"], ["game_completed", "court"], ["game_started", "court"], ["game_completed", "court"]]),
  ["game_started:court", "game_completed:court", "game_started:court", "game_completed:court"], "Court: each new case pairs again");
eq(run([["app_open", undefined]]), ["app_open:null"], "other events pass untouched");

// Robots are not written to the statistics; real phones and Telegram are.
const UA = {
  googlebot: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  yandex: "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  headless: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
  lighthouse: "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  cubot: "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  telegramDesktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 TelegramDesktop",
};
for (const k of ["googlebot", "yandex", "headless", "lighthouse"]) {
  eq(run([["app_open", undefined], ["game_started", "durak"]], { userAgent: UA[k] }), [], `robot (${k}) -> nothing logged`);
}
eq(run([["app_open", undefined]], { userAgent: UA.android, webdriver: true }), [], "automated browser (webdriver) -> nothing logged");
for (const k of ["iphone", "android", "cubot", "telegramDesktop"]) {
  eq(run([["app_open", undefined]], { userAgent: UA[k], webdriver: false }), ["app_open:null"], `real device (${k}) -> logged`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
