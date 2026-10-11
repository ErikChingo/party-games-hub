const ROOT = require("path").resolve(__dirname, "../..");
// Coverage for the Telegram-bot promo banner added 1 октября ("мне надо
// чтобы мы поместили сылку на телеграм бота в платформе" -> user chose
// "banner, only outside Telegram"). Covers isInsideTelegram() (the named,
// reusable check factored out of isPlayerNameEditable() in this same pass)
// and TelegramPromoBanner's visibility/content, via real React
// (react-dom/server) against the actual compiled bundle -- same technique
// as render_new_components_test.js.
const fs = require("fs");
const path = require("path");
const React = require("react");
const ReactDOMServer = require("react-dom/server");

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
const navigatorStub = { clipboard: { writeText: () => Promise.resolve() }, vibrate(){}, userAgent: "render-test", share: undefined };

function buildWindowStub(telegramWebApp) {
  const w = {
    location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" },
    addEventListener(){}, removeEventListener(){},
    matchMedia(){ return { matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }; },
    crypto: { randomUUID: () => "test-uuid-0000-0000-0000-000000000000" },
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    innerWidth: 390, innerHeight: 844,
  };
  w.window = w;
  w.Telegram = telegramWebApp === undefined ? undefined : { WebApp: telegramWebApp };
  return w;
}

const ReactDOMStub = { createRoot: () => ({ render(){} }), createPortal: (children) => children };
const fakeQueryBuilder = {
  select(){ return this; }, order(){ return this; }, limit(){ return this; }, eq(){ return this; }, gt(){ return this; },
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  insert: () => Promise.resolve({ data: null, error: null }),
  then(resolve){ resolve({ data: [], error: null, count: 0 }); },
};
const fakeSupabase = { createClient: () => ({ from: () => ({ ...fakeQueryBuilder }), rpc: () => Promise.resolve({ data: null, error: null }) }) };

function load(telegramWebApp, storage) {
  const windowStub = buildWindowStub(telegramWebApp);
  windowStub.supabase = fakeSupabase;
  const captured = {};
  const fn = new Function(
    "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
    appCode +
      "\n;__capture.isInsideTelegram = typeof isInsideTelegram !== 'undefined' ? isInsideTelegram : undefined;" +
      "__capture.TelegramPromoBanner = typeof TelegramPromoBanner !== 'undefined' ? TelegramPromoBanner : undefined;" +
      "__capture.TELEGRAM_BOT_USERNAME = typeof TELEGRAM_BOT_USERNAME !== 'undefined' ? TELEGRAM_BOT_USERNAME : undefined;" +
      "__capture.TELEGRAM_MINIAPP_SHORTNAME = typeof TELEGRAM_MINIAPP_SHORTNAME !== 'undefined' ? TELEGRAM_MINIAPP_SHORTNAME : undefined;" +
      "__capture.TELEGRAM_PROMO_DISMISSED_KEY = typeof TELEGRAM_PROMO_DISMISSED_KEY !== 'undefined' ? TELEGRAM_PROMO_DISMISSED_KEY : undefined;"
  );
  fn(windowStub, documentStub, navigatorStub, storage, makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);
  return captured;
}

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

/* ---- isInsideTelegram() ---- */
let cap = load(undefined, makeStorage());
ok(typeof cap.isInsideTelegram === "function", "isInsideTelegram is exported at module scope");
ok(cap.isInsideTelegram() === false, "no window.Telegram at all -> not inside Telegram");

cap = load({ platform: "unknown", initData: "", initDataUnsafe: {} }, makeStorage());
ok(cap.isInsideTelegram() === false, "WebApp present but empty initDataUnsafe.user (the exact live shape outside Telegram) -> not inside Telegram");

cap = load({ platform: "ios", initData: "abc", initDataUnsafe: { user: { id: 12345 } } }, makeStorage());
ok(cap.isInsideTelegram() === true, "WebApp with a real initDataUnsafe.user -> genuinely inside Telegram");

/* ---- TelegramPromoBanner: visibility ---- */
// Outside Telegram, not dismissed -> renders the banner with a working link.
cap = load(undefined, makeStorage());
let markup = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramPromoBanner));
ok(markup.length > 0, "renders something when outside Telegram and not dismissed");
const expectedUrl = `https://t.me/${cap.TELEGRAM_BOT_USERNAME}/${cap.TELEGRAM_MINIAPP_SHORTNAME}`;
ok(markup.includes(`href="${expectedUrl}"`), `link points at the bot's Mini App URL (${expectedUrl})`);
ok(markup.includes('target="_blank"'), "link opens in a new tab/window rather than navigating away from the app");

// Inside a real Telegram session -> renders nothing.
cap = load({ platform: "ios", initData: "abc", initDataUnsafe: { user: { id: 1 } } }, makeStorage());
markup = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramPromoBanner));
ok(markup === "", "renders nothing when genuinely inside Telegram -- nothing to promote");

// Previously dismissed on this device -> renders nothing even outside Telegram.
cap = load(undefined, makeStorage({ [cap.TELEGRAM_PROMO_DISMISSED_KEY || "hatsit_telegram_promo_dismissed_v1"]: "1" }));
markup = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramPromoBanner));
ok(markup === "", "renders nothing once the user has dismissed it on this device (localStorage flag respected)");

// Never calling localStorage before the dismissed check must never throw,
// even if localStorage access itself throws (private-browsing style) --
// mirrors the try/catch guards used elsewhere in the file for storage.
cap = load(undefined, { getItem() { throw new Error("storage blocked"); }, setItem(){}, removeItem(){} });
let threw = false;
try {
  ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramPromoBanner));
} catch (e) {
  threw = true;
}
ok(!threw, "does not throw when localStorage.getItem itself throws");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
