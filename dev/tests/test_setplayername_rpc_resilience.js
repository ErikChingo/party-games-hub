const ROOT = require("path").resolve(__dirname, "../..");
// Regression test for the live bug reported 27 сентября: "ник не меняется
// без обновления страницы" (name doesn't change without refreshing the
// page). Root cause found via live debugging on hatsit.vercel.app: the app
// loads supabase-js unpinned from a CDN (@supabase/supabase-js@2), and the
// version currently served returns a thenable from .rpc(...) that has
// .then() but NOT .catch()/.finally() (confirmed live: hasThen:"function",
// hasCatch:"undefined"). setPlayerName() used to do
// `supabaseClient.rpc(...).catch(e => ...)` as a fire-and-forget call --
// calling .catch on that thenable threw "...catch is not a function"
// *synchronously*, which aborted saveName() in ProfilePanel right after
// setPlayerName's own localStorage write but before saveName() reached its
// setNameInput/setNameJustSaved calls. Net effect: the name/DB update
// actually succeeded, but the panel's visible name+title never
// re-rendered until a full page reload re-read localStorage from scratch.
//
// This test exercises the real, compiled setPlayerName/getPlayerName
// functions (extracted from the built bundle, same technique as
// test_analytics_and_moderation.js) against several shapes .rpc(...)
// could plausibly return, and asserts setPlayerName never throws and
// always completes its localStorage write + return value regardless.
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

// Swappable per-test: what supabaseClient.rpc(...) returns/does.
let rpcImpl = () => Promise.resolve({ data: null, error: null });
const fakeQueryBuilder = {
  select(){ return this; }, order(){ return this; }, limit(){ return this; }, eq(){ return this; }, gt(){ return this; },
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  insert: () => Promise.resolve({ data: null, error: null }),
  then(resolve){ resolve({ data: [], error: null, count: 0 }); },
};
const fakeSupabase = { createClient: () => ({ from: () => ({ ...fakeQueryBuilder }), rpc: (...args) => rpcImpl(...args) }) };
windowStub.supabase = fakeSupabase;

const storage = makeStorage();
const captured = {};
const fn = new Function(
  "window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__capture",
  appCode +
    "\n;__capture.setPlayerName = typeof setPlayerName !== 'undefined' ? setPlayerName : undefined;" +
    "__capture.getPlayerName = typeof getPlayerName !== 'undefined' ? getPlayerName : undefined;"
);
fn(windowStub, documentStub, navigatorStub, storage, makeStorage(), React, ReactDOMStub, fakeSupabase, console, captured);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const setPlayerName = captured.setPlayerName;
const getPlayerName = captured.getPlayerName;
ok(typeof setPlayerName === "function", "setPlayerName is exported at module scope");

// Case 1: the exact live shape found on hatsit.vercel.app -- a thenable
// with .then but no .catch/.finally (a plain object, not a real Promise).
rpcImpl = () => ({ then(onFulfilled) { onFulfilled && onFulfilled({ data: null, error: null }); return this; } });
let threw = false, ret;
try { ret = setPlayerName("ThenOnlyName"); } catch (e) { threw = true; }
ok(!threw, "setPlayerName does not throw when rpc() returns a then-only thenable (no .catch) -- the exact live bug");
ok(ret === "ThenOnlyName", "setPlayerName still returns the saved name in that case");
ok(storage.getItem("hatsit_player_name_v1") === "ThenOnlyName", "localStorage is still updated in that case");

// Case 2: rpc() itself throws synchronously (e.g. a malformed client).
rpcImpl = () => { throw new Error("boom-sync"); };
threw = false;
try { ret = setPlayerName("SyncThrowName"); } catch (e) { threw = true; }
ok(!threw, "setPlayerName does not throw when rpc() itself throws synchronously");
ok(ret === "SyncThrowName", "setPlayerName still returns the saved name when rpc() throws synchronously");
ok(storage.getItem("hatsit_player_name_v1") === "SyncThrowName", "localStorage is still updated when rpc() throws synchronously");

// Case 3: rpc() returns a real rejected Promise (the "normal" async-failure
// case this code always needed to handle, and did before this fix too).
rpcImpl = () => Promise.reject(new Error("network-fail"));
threw = false;
try { ret = setPlayerName("RejectedPromiseName"); } catch (e) { threw = true; }
ok(!threw, "setPlayerName does not throw when rpc() returns a rejected Promise");
ok(ret === "RejectedPromiseName", "setPlayerName still returns the saved name when rpc() rejects");
ok(storage.getItem("hatsit_player_name_v1") === "RejectedPromiseName", "localStorage is still updated when rpc() rejects");
// Let the rejected promise settle so it doesn't surface as an unhandled
// rejection in this test process.
process.on("unhandledRejection", () => {});

// Case 4: rpc() returns undefined (defensive; should still be a no-op, not
// a crash).
rpcImpl = () => undefined;
threw = false;
try { ret = setPlayerName("UndefinedRpcName"); } catch (e) { threw = true; }
ok(!threw, "setPlayerName does not throw when rpc() returns undefined");
ok(ret === "UndefinedRpcName", "setPlayerName still returns the saved name when rpc() returns undefined");

// Case 5: the normal/happy path (a real resolved Promise, as most
// supabase-js versions actually return) must still work exactly as before.
rpcImpl = () => Promise.resolve({ data: { id: "x" }, error: null });
ret = setPlayerName("HappyPathName");
ok(ret === "HappyPathName", "happy path (real resolved Promise) is unaffected by the fix");
ok(storage.getItem("hatsit_player_name_v1") === "HappyPathName", "happy path still writes localStorage");
ok(getPlayerName() === "HappyPathName", "getPlayerName() reflects the just-saved name immediately (no reload needed)");

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, 50);
