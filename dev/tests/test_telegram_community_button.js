const ROOT = require("path").resolve(__dirname, "../..");
// Coverage for TelegramCommunityButton, added to the Hub footer next to the
// existing DiscordCommunityButton ("Добавь иконку возле дискорда тоже" ->
// user chose: Telegram bot icon, Hub footer only). Same extraction
// technique as test_telegram_promo_banner.js: pull the real compiled
// components out of dist/index.html via a Function() sandbox and render
// them with react-dom/server.
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

function load(telegramWebApp) {
  const windowStub = buildWindowStub(telegramWebApp);
  windowStub.supabase = fakeSupabase;
  const captured = {};
  const fn = new Function(
    "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
    appCode +
      "\n;__capture.DiscordCommunityButton = typeof DiscordCommunityButton !== 'undefined' ? DiscordCommunityButton : undefined;" +
      "__capture.TelegramCommunityButton = typeof TelegramCommunityButton !== 'undefined' ? TelegramCommunityButton : undefined;" +
      "__capture.TELEGRAM_BOT_USERNAME = typeof TELEGRAM_BOT_USERNAME !== 'undefined' ? TELEGRAM_BOT_USERNAME : undefined;" +
      "__capture.TELEGRAM_MINIAPP_SHORTNAME = typeof TELEGRAM_MINIAPP_SHORTNAME !== 'undefined' ? TELEGRAM_MINIAPP_SHORTNAME : undefined;" +
      "__capture.DISCORD_INVITE_URL = typeof DISCORD_INVITE_URL !== 'undefined' ? DISCORD_INVITE_URL : undefined;"
  );
  fn(windowStub, documentStub, navigatorStub, makeStorage(), makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);
  return captured;
}

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

/* ---- TelegramCommunityButton: outside Telegram ---- */
let cap = load(undefined);
ok(typeof cap.TelegramCommunityButton === "function", "TelegramCommunityButton is exported at module scope");

let markup = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramCommunityButton, { round: true }));
ok(markup.length > 0, "round TelegramCommunityButton renders something outside Telegram");
const expectedTgUrl = `https://t.me/${cap.TELEGRAM_BOT_USERNAME}/${cap.TELEGRAM_MINIAPP_SHORTNAME}`;
ok(markup.includes(`href="${expectedTgUrl}"`), `round button links to the bot's Mini App URL (${expectedTgUrl})`);
ok(markup.includes('target="_blank"'), "round button opens in a new tab");
ok(markup.includes("rounded-full"), "round variant uses the circular button style, matching DiscordCommunityButton's round variant");

markup = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramCommunityButton, {}));
ok(markup.includes(`href="${expectedTgUrl}"`), "non-round variant also links to the Mini App URL");
ok(!markup.includes("rounded-full") || markup.includes("rounded-2xl"), "non-round variant uses the full-width pill style");

/* ---- TelegramCommunityButton: hidden inside a real Telegram session ---- */
cap = load({ platform: "ios", initData: "abc", initDataUnsafe: { user: { id: 12345 } } });
markup = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.TelegramCommunityButton, { round: true }));
ok(markup === "", "renders nothing when genuinely inside Telegram -- no need to link back into Telegram");

/* ---- DiscordCommunityButton: unaffected by Telegram context ---- */
// Discord's button never checked isInsideTelegram() before this change and
// must not start doing so now -- it should render identically regardless.
cap = load(undefined);
ok(typeof cap.DiscordCommunityButton === "function", "DiscordCommunityButton is still exported at module scope");
let discordOutside = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.DiscordCommunityButton, { round: true }));
cap = load({ platform: "ios", initData: "abc", initDataUnsafe: { user: { id: 1 } } });
let discordInside = ReactDOMServer.renderToStaticMarkup(React.createElement(cap.DiscordCommunityButton, { round: true }));
ok(discordOutside.length > 0 && discordInside.length > 0, "DiscordCommunityButton renders both inside and outside Telegram");
ok(discordOutside === discordInside, "DiscordCommunityButton's markup is unaffected by Telegram context (no regression from this change)");
ok(discordOutside.includes(`href="${cap.DISCORD_INVITE_URL}"`), "DiscordCommunityButton still links to the Discord invite URL");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
