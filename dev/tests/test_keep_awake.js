const ROOT = require("path").resolve(__dirname, "../..");
// Keep-awake: App-level useWakeLock + the silent-video fallback for
// WebViews (Telegram / Instagram in-app browsers have no Wake Lock API).
// Runs the real compiled hook with effects executed synchronously.
const fs = require("fs"), RealReact = require("react");
const html = fs.readFileSync(ROOT + "/dist/index.html", "utf8");
const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, code = ""; while ((m = re.exec(html))) if (m[1].length > code.length) code = m[1];

function load({ wakeLock, storage, visibility = "visible" }) {
  const listeners = {};
  const created = [];
  const mkEl = (tag) => {
    const el = { tag, attrs: {}, style: {}, children: [], handlers: {}, paused: true, currentTime: 0, playCalls: 0, removed: false, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, appendChild(c) { this.children.push(c); }, addEventListener(t, h) { this.handlers[t] = h; }, removeEventListener() {},
      play() { this.playCalls++; this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, remove() { this.removed = true; }, querySelector() { return null; }, querySelectorAll() { return []; } };
    created.push(el); return el;
  };
  const body = mkEl("body");
  const doc = { visibilityState: visibility, documentElement: mkEl("html"), head: mkEl("head"), body, getElementById: () => mkEl("div"), createElement: mkEl, querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, h) { (listeners[t] = listeners[t] || []).push(h); }, removeEventListener(t, h) { listeners[t] = (listeners[t] || []).filter((x) => x !== h); } };
  const nav = { clipboard: { writeText: () => Promise.resolve() }, userAgent: "t", vibrate() {} };
  if (wakeLock) nav.wakeLock = wakeLock;
  const store = storage || {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const qb = { select() { return this; }, order() { return this; }, limit() { return this; }, eq() { return this; }, gt() { return this; }, maybeSingle: () => Promise.resolve({ data: null, error: null }), then(r) { r({ data: [], error: null }); } };
  const sb = { createClient: () => ({ from: () => ({ ...qb }), rpc: () => Promise.resolve({ data: null, error: null }) }) };
  const w = { location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), crypto: { randomUUID: () => "u" }, requestAnimationFrame: (c) => setTimeout(c, 0), cancelAnimationFrame: clearTimeout, innerWidth: 390, innerHeight: 844, supabase: sb };
  w.window = w;
  let cleanup = null;
  const FakeReact = { ...RealReact, useRef: (v) => ({ current: v }), useEffect: (fn) => { cleanup = fn() || null; } };
  const C = {};
  new Function("window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__c",
    code + ";__c.useWakeLock=useWakeLock;__c.video=screenAwakeVideo;__c.reducer=reducer;__c.initialState=initialState;")(w, doc, nav, ls, { getItem: () => null, setItem() {}, removeItem() {} }, FakeReact, { createRoot: () => ({ render() {} }), createPortal: (c) => c }, sb, console, C);
  const videos = () => created.filter((e) => e.tag === "video");
  return { C, doc, store, listeners, videos, body, run: (active) => { cleanup = null; C.useWakeLock(active); return () => cleanup && cleanup(); }, fire: (t) => (listeners[t] || []).forEach((h) => h({})) };
}
let p = 0, f = 0; const ok = (c, l) => { c ? p++ : (f++, console.error("FAIL: " + l)); };
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  // 1. Browser with the real API: use it, no video.
  let released = 0, requested = [];
  let env = load({ wakeLock: { request: (type) => { requested.push(type); return Promise.resolve({ release: () => { released++; return Promise.resolve(); }, addEventListener() {} }); } } });
  let stop = env.run(true); await tick();
  ok(requested.length === 1 && requested[0] === "screen", "asks the browser for a screen wake lock");
  ok(env.videos().length === 0, "no video is created when the real API works");
  stop(); await tick();
  ok(released === 1, "releases the lock when leaving the games (back on the Hub)");

  // 2. active=false (Hub): nothing at all.
  requested = [];
  env = load({ wakeLock: { request: (t) => { requested.push(t); return Promise.resolve({ release: () => Promise.resolve() }); } } });
  env.run(false); await tick();
  ok(requested.length === 0 && env.videos().length === 0, "does nothing on the Hub");

  // 3. WebView without the API (Telegram / Instagram): silent video.
  env = load({});
  stop = env.run(true); await tick();
  let v = env.videos()[0];
  ok(!!v && env.body.children.includes(v), "falls back to a hidden video when the API is missing");
  ok("playsinline" in v.attrs && "webkit-playsinline" in v.attrs, "video is marked inline (must never open fullscreen)");
  ok(!("muted" in v.attrs) && v.muted !== true, "video is not muted (a muted clip would not keep the phone awake)");
  ok(v.children.length === 2 && v.children[0].type === "video/mp4" && v.children[0].src.startsWith("data:video/mp4;base64,") && v.children[1].type === "video/webm", "clip ships as mp4 (iPhone) with a webm alternative");
  ok(/opacity:0/.test(v.style.cssText) && /pointer-events:none/.test(v.style.cssText), "video is invisible and can't be tapped");
  ok(v.playCalls >= 1 && !v.paused, "tries to start right away");
  v.paused = true; const before = v.playCalls;
  env.fire("pointerdown");
  ok(v.playCalls === before + 1 && !v.paused, "a tap (re)starts the clip if the phone had blocked or paused it");
  v.currentTime = 1.5; v.handlers.timeupdate();
  ok(v.currentTime <= 0.5, "clip jumps back before reaching its end");
  env.doc.visibilityState = "hidden"; v.paused = true; const c2 = v.playCalls; env.fire("pointerdown");
  ok(v.playCalls === c2, "does not play while the page is hidden");
  env.doc.visibilityState = "visible"; env.fire("visibilitychange");
  ok(!v.paused, "resumes when the player comes back to the page");
  stop();
  ok(v.paused, "stops the clip when leaving the games");
  env.fire("pointerdown");
  ok(v.paused, "taps on the Hub no longer start it");
  env.run(true);
  ok(env.videos().length === 1 && !v.paused, "re-entering a game reuses the same clip element");

  // 4. API present but refused -> same fallback.
  env = load({ wakeLock: { request: () => Promise.reject(new Error("NotAllowedError")) } });
  env.run(true); await tick();
  ok(env.videos().length === 1 && !env.videos()[0].paused, "falls back to the video when the browser refuses the wake lock");
  // ...but not when it was refused only because the page is hidden
  env = load({ wakeLock: { request: () => Promise.reject(new Error("hidden")) }, visibility: "hidden" });
  env.run(true); await tick();
  ok(env.videos().length === 0, "a refusal while hidden does not switch to the video");

  // 5. Fullscreen safety net.
  env = load({});
  env.run(true); await tick(); v = env.videos()[0];
  v.handlers.webkitbeginfullscreen();
  ok(v.removed && v.paused && env.store.hatsit_awake_video_off_v1 === "1", "if the clip ever opens fullscreen it is closed and switched off for this device");
  env.fire("pointerdown");
  ok(env.videos().length === 1, "…and is not created again afterwards");
  env = load({ storage: { hatsit_awake_video_off_v1: "1" } });
  env.run(true); await tick();
  ok(env.videos().length === 0, "a device where it was switched off never gets the clip");

  console.log(`\n${p} passed, ${f} failed`); process.exit(f ? 1 : 0);
})();
