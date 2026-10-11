const ROOT = require("path").resolve(__dirname, "../..");
// Lobby settings must react to a tap at once (no waiting for the database)
// and still end up exactly as the server says. Runs the real compiled
// MafiaRoomLobby inside a tiny hooks runtime and "taps" its controls by
// calling the onChange handlers found in the element tree it returns.
const fs = require("fs"), React = require("react");
const html = fs.readFileSync(ROOT + "/dist/index.html", "utf8");
const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, code = ""; while ((m = re.exec(html))) if (m[1].length > code.length) code = m[1];
let p = 0, f = 0;
const ok = (c, l) => { c ? p++ : (f++, console.error("FAIL: " + l)); };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRuntime() {
  let cells = [], i = 0, queued = [], rendering = false, scheduled = false, fn = null, args = [], result;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  const rerender = () => { if (!scheduled && fn) { scheduled = true; Promise.resolve().then(() => { scheduled = false; render(); }); } };
  const hooks = {
    useState(init) { const k = i++; if (!cells[k]) { const cell = { v: typeof init === "function" ? init() : init }; cell.set = (nv) => { const val = typeof nv === "function" ? nv(cell.v) : nv; if (!Object.is(val, cell.v)) { cell.v = val; rerender(); } }; cells[k] = cell; } return [cells[k].v, cells[k].set]; },
    useRef(init) { const k = i++; if (!cells[k]) cells[k] = { current: init }; return cells[k]; },
    useMemo(make, deps) { const k = i++; if (!cells[k] || !same(cells[k].deps, deps)) cells[k] = { v: make(), deps }; return cells[k].v; },
    useCallback(cb, deps) { return hooks.useMemo(() => cb, deps); },
    useEffect(effect, deps) { const k = i++; const prev = cells[k]; if (!prev || !deps || !same(prev.deps, deps)) { const cell = { deps, cleanup: prev && prev.cleanup }; cells[k] = cell; queued.push(() => { if (cell.cleanup) cell.cleanup(); cell.cleanup = effect() || null; }); } },
  };
  function render() { if (rendering || !fn) return; rendering = true; i = 0; queued = []; result = fn(...args); rendering = false; const run = queued; queued = []; run.forEach((e) => e()); }
  return { hooks, mount(h, ...a) { fn = h; args = a; render(); return this; }, update(...a) { args = a; render(); }, get result() { return result; }, unmount() { cells.forEach((c) => c && typeof c.cleanup === "function" && c.cleanup()); fn = null; } };
}

function load(react) {
  const st = () => { const s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; };
  const el = { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const doc = { visibilityState: "visible", documentElement: { ...el }, head: el, body: el, getElementById() { return el; }, createElement() { return { ...el }; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} };
  const qb = { select() { return this; }, order() { return this; }, limit() { return this; }, eq() { return this; }, gt() { return this; }, maybeSingle: () => Promise.resolve({ data: null, error: null }), then(r) { r({ data: [], error: null }); } };
  const sb = { createClient: () => ({ from: () => ({ ...qb }), rpc: () => Promise.resolve({ data: null, error: null }), channel: () => ({ on() { return this; }, subscribe() { return this; }, send() {} }), removeChannel() {} }) };
  const w = { location: { origin: "https://hatsit.vercel.app", pathname: "/", search: "" }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }), crypto: { randomUUID: () => "u" }, requestAnimationFrame: (c) => setTimeout(c, 0), cancelAnimationFrame: clearTimeout, innerWidth: 390, innerHeight: 844, supabase: sb };
  w.window = w;
  const C = {};
  new Function("window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__c", code + ";__c.MafiaRoomLobby=MafiaRoomLobby;")(w, doc, { clipboard: { writeText: () => Promise.resolve() }, userAgent: "t", vibrate() {}, onLine: true }, st(), st(), react, { createRoot: () => ({ render() {} }), createPortal: (c) => c }, sb, { log() {}, error() {}, warn() {} }, C);
  return C;
}

// every element in a tree returned by a component (children are not rendered)
function walk(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (node && typeof node === "object" && node.props) { out.push(node); walk(node.props.children, out); }
  return out;
}
const controls = (tree) => {
  const all = walk(tree);
  const steppers = all.filter((e) => e.props && typeof e.props.onChange === "function" && typeof e.props.max === "number");
  const toggles = all.filter((e) => e.props && typeof e.props.onChange === "function" && "checked" in e.props);
  const start = all.find((e) => e.type === "button" && e.props.disabled !== undefined && walk(e.props.children).some((c) => typeof c.type === "function") && String(JSON.stringify(e.props.children)).includes("Начать игру"));
  return { mafia: steppers[0], speech: steppers[1], toggles, start };
};

const players = Array.from({ length: 8 }, (_, seat) => ({ seat, name: "P" + seat, alive: true, warnings: 0, no_vote: false, ready: false, voted: false, online: true, is_host: seat === 0, is_voice: seat === 0, is_me: seat === 0, role: null, complaints: 0, warned_today: false }));
const mkView = (settings) => ({ code: "1234", status: "lobby", phase: "lobby", ms_left: null, is_host: true, is_voice: true, players, speech: [], me: { seat: 0, name: "P0" },
  settings: { mafia_count: 2, doctor: true, sheriff: true, don: false, maniac: false, putana: false, speech_seconds: 60, ...settings } });

(async () => {
  const rt = makeRuntime();
  const C = load({ ...React, ...rt.hooks });
  const calls = [];
  let respond = null; // null = answer at once; otherwise a list of pending resolvers
  let view = mkView();
  const order = [];
  const room = () => ({ view, code: "1234", error: null, connStatus: "idle", deadlineAt: null, handleLeave() {},
    handleStart: async () => { order.push("start"); },
    act: (fn, args) => { calls.push([fn, args]); order.push(fn);
      const answer = () => { view = mkView({ ...view.settings, ...args.p_settings }); rt.update({ room: room(), dispatch() {} }); return view; };
      if (!respond) return Promise.resolve().then(answer);
      return new Promise((resolve) => respond.push(() => resolve(answer()))); } });
  rt.mount(C.MafiaRoomLobby, { room: room(), dispatch() {} });
  const c = () => controls(rt.result);

  eq([c().mafia.props.value, c().mafia.props.max, c().speech.props.value], [2, 3, 60], "lobby shows the server's settings");

  // a tap changes the number at once, before anything is sent
  c().mafia.props.onChange(3);
  await wait(5);
  eq([c().mafia.props.value, calls.length], [3, 0], "tap: the value changes immediately, nothing sent yet");
  // quick taps on another control are merged into the same request
  c().speech.props.onChange(75); await wait(5);
  c().speech.props.onChange(90); await wait(5);
  c().toggles[2].props.onChange(); await wait(5);
  eq([c().speech.props.value, c().toggles[2].props.checked, calls.length], [90, true, 0], "more taps: all visible at once, still nothing sent");
  await wait(450);
  eq(calls, [["mafia_update_settings", { p_settings: { mafia_count: 3, speech_seconds: 90, don: true } }]], "one request carries all the quick taps");
  eq([c().mafia.props.value, c().speech.props.value, c().toggles[2].props.checked], [3, 90, true], "after the server answers the screen still shows the new values");

  // a poll bringing the old settings must not undo what was just tapped
  c().speech.props.onChange(105); await wait(5);
  view = mkView({ ...view.settings }); // server still has 90
  rt.update({ room: room(), dispatch() {} });
  eq(c().speech.props.value, 105, "a stale poll does not roll the tap back");
  await wait(450);
  eq(calls[calls.length - 1][1].p_settings, { speech_seconds: 105 }, "the pending change is then sent");

  // slow connection: a second tap while the first request is still on its way
  respond = [];
  c().mafia.props.onChange(2); await wait(400);
  eq(respond.length, 1, "first request is in flight");
  c().mafia.props.onChange(1); await wait(5);
  eq(c().mafia.props.value, 1, "second tap shows at once");
  respond.shift()(); await wait(20);
  eq(c().mafia.props.value, 1, "the late answer to the first request does not overwrite the newer tap");
  await wait(450);
  eq(respond.length, 1, "the newer value gets its own request");
  respond.shift()(); await wait(20);
  eq([c().mafia.props.value, view.settings.mafia_count], [1, 1], "…and the server ends up with the last value");
  respond = null;

  // limits are applied on the phone too, so the number never jumps back
  c().mafia.props.onChange(9); await wait(5);
  eq(c().mafia.props.value, 3, "mafia count is capped locally at the room's maximum");
  c().speech.props.onChange(5); await wait(5);
  eq(c().speech.props.value, 15, "speech time is capped locally at the minimum");
  await wait(450);

  // "Start" right after a tap: the change is sent first
  order.length = 0;
  c().toggles[3].props.onChange(); await wait(5);
  const allEls = walk(rt.result);
  const startBtn = allEls.filter((e) => e.type === "button" && typeof e.props.onClick === "function").pop();
  await startBtn.props.onClick();
  await wait(20);
  eq(order, ["mafia_update_settings", "start"], "starting sends the pending change before the game begins");

  // leaving the lobby with an unsent change still sends it
  const before = calls.length;
  c().speech.props.onChange(120); await wait(5);
  rt.unmount();
  await wait(20);
  eq([calls.length, calls[calls.length - 1][1].p_settings.speech_seconds], [before + 1, 120], "an unsent change is sent when the lobby closes");

  console.log(`\n${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
