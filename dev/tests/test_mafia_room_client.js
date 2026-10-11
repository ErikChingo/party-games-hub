const ROOT = require("path").resolve(__dirname, "../..");
// Client side of "Mafia: room by code": host phrases, every screen
// rendered from server-shaped views, and the two hooks (room plumbing and
// the host's voice) driven by a tiny hooks runtime -- all against the real
// compiled bundle.
const fs = require("fs"), React = require("react"), RDS = require("react-dom/server");
const html = fs.readFileSync(ROOT + "/dist/index.html", "utf8");
const re = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;
let m, code = ""; while ((m = re.exec(html))) if (m[1].length > code.length) code = m[1];

let p = 0, f = 0;
const ok = (c, l) => { c ? p++ : (f++, console.error("FAIL: " + l)); };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a minimal hooks runtime (useState/useEffect/useRef/useMemo/useCallback) ----------
function makeRuntime() {
  let cells = [], i = 0, queued = [], rendering = false, scheduled = false, fn = null, args = [], result;
  const same = (a, b) => a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  const rerender = () => { if (!scheduled && fn) { scheduled = true; Promise.resolve().then(() => { scheduled = false; render(); }); } };
  const hooks = {
    useState(init) {
      const k = i++;
      if (!cells[k]) { const cell = { v: typeof init === "function" ? init() : init }; cell.set = (nv) => { const val = typeof nv === "function" ? nv(cell.v) : nv; if (!Object.is(val, cell.v)) { cell.v = val; rerender(); } }; cells[k] = cell; }
      return [cells[k].v, cells[k].set];
    },
    useRef(init) { const k = i++; if (!cells[k]) cells[k] = { current: init }; return cells[k]; },
    useMemo(make, deps) { const k = i++; if (!cells[k] || !same(cells[k].deps, deps)) cells[k] = { v: make(), deps }; return cells[k].v; },
    useCallback(cb, deps) { return hooks.useMemo(() => cb, deps); },
    useEffect(effect, deps) {
      const k = i++; const prev = cells[k];
      if (!prev || !deps || !same(prev.deps, deps)) { const cell = { deps, cleanup: prev && prev.cleanup }; cells[k] = cell; queued.push(() => { if (cell.cleanup) cell.cleanup(); cell.cleanup = effect() || null; }); }
    },
  };
  function render() {
    if (rendering || !fn) return;
    rendering = true; i = 0; queued = [];
    result = fn(...args);
    rendering = false;
    const run = queued; queued = [];
    run.forEach((e) => e());
  }
  return {
    hooks,
    mount(hookFn, ...a) { fn = hookFn; args = a; render(); return this; },
    update(...a) { args = a; render(); },
    get result() { return result; },
    unmount() { cells.forEach((c) => c && typeof c.cleanup === "function" && c.cleanup()); fn = null; },
  };
}

// ---------- loading the bundle into a sandbox ----------
function load({ react, search = "", session = {}, local = {}, speech = false, speechMs = 320, voices = [], studio = null, rpcHandler, rpcAny = null, profile = null, storyApi = null } = {}) {
  const mkStore = (initial) => { const s = { ...initial }; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; }, _s: s }; };
  const el = { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  const docListeners = {};
  const doc = { visibilityState: "visible", documentElement: { ...el }, head: el, body: el, getElementById() { return el; }, createElement() { return { ...el }; }, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(t, h) { (docListeners[t] = docListeners[t] || []).push(h); }, removeEventListener() {} };
  const calls = [], sent = [], pingHandlers = [], spoken = [];
  const channel = { on(type, filter, cb) { pingHandlers.push(cb); return channel; }, subscribe() { return channel; }, send(msg) { sent.push(msg); } };
  const qb = { select() { return this; }, order() { return this; }, limit() { return this; }, eq() { return this; }, gt() { return this; }, maybeSingle: () => Promise.resolve({ data: profile, error: null }), then(r) { r({ data: [], error: null }); } };
  const client = {
    from: () => ({ ...qb }),
    rpc(fn, args) { calls.push([fn, args]); if (rpcAny && !fn.startsWith("mafia_")) return rpcAny(fn, args); return rpcHandler && fn.startsWith("mafia_") ? rpcHandler(fn, args) : Promise.resolve({ data: null, error: null }); },
    channel: () => channel,
    removeChannel() {},
  };
  const sb = { createClient: () => client };
  const w = { location: { origin: "https://hatsit.vercel.app", pathname: "/", search }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    crypto: { randomUUID: () => "u", getRandomValues: (a) => { for (let k = 0; k < a.length; k++) a[k] = (k * 37 + 11) % 256; return a; } }, requestAnimationFrame: (c) => setTimeout(c, 0), cancelAnimationFrame: clearTimeout, innerWidth: 390, innerHeight: 844, supabase: sb };
  w.window = w;
  if (speech) {
    w.speechSynthesis = { speak(u) { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), speechMs); }, resume() {}, cancel() {}, getVoices: () => voices };
    w.SpeechSynthesisUtterance = function (text) { this.text = text; };
  }
  // studio voice: a fake /api/mafia-voice and a fake <audio>
  const fetched = [], played = [], storyRequests = [];
  if (studio || storyApi) {
    const voice = studio || { status: 503 };
    w.fetch = (address, init) => {
      if (String(address).startsWith("/api/mafia-story")) {
        storyRequests.push(JSON.parse(init.body));
        const answer = typeof storyApi === "function" ? storyApi(JSON.parse(init.body)) : storyApi;
        const delay = answer && answer.delay ? answer.delay : 5;
        return new Promise((resolve) => setTimeout(() => resolve(answer && answer.text !== undefined ? { ok: true, status: 200, json: () => Promise.resolve({ text: answer.text }) } : { ok: false, status: 502, json: () => Promise.resolve({ error: "x" }) }), delay));
      }
      return voiceFetch(address);
    };
    const voiceFetch = (address) => {
      const studio = voice;
      fetched.push(address);
      const status = typeof studio.status === "function" ? studio.status(address, fetched.length) : studio.status || 200;
      const answer = { ok: status === 200, status, blob: () => Promise.resolve(new Blob([new Uint8Array(studio.bytes === undefined ? 3000 : studio.bytes)])) };
      return new Promise((resolve) => setTimeout(() => resolve(answer), typeof studio.delay === "function" ? studio.delay(address) : studio.delay || 5));
    };
  }
  if (studio) {
    w.Audio = function () {
      this.setAttribute = () => {};
      this.pause = () => {};
      this.play = () => {
        if (String(this.src).startsWith("data:")) return Promise.resolve();
        if (studio.playRejects) return Promise.reject(new Error("NotAllowedError"));
        played.push(this.src);
        setTimeout(() => this.onended && this.onended(), studio.audioMs || 60);
        return Promise.resolve();
      };
    };
  }
  const ls = mkStore(local), ss = mkStore(session);
  const C = {};
  const names = ["mafiaHostLine", "mafiaCanSpeak", "getMafiaRoomIdentity", "useMafiaRoom", "useMafiaVoice", "MafiaModeSwitch", "screenFadeKey", "MafiaRoomMenu", "MafiaRoomLobby", "MafiaRoomGame", "MafiaRoomEnd", "MafiaRoomApp", "MafiaRoomVote", "ConfirmButton", "MafiaRoomMorning", "mafiaDressUtterance", "mafiaPickVoice", "GAMES", "hubGameOrder", "Hub", "GameCard", "ACHIEVEMENTS", "PLAYER_TITLES", "computeUnlockedAchievementIds", "getPlayerTitle", "MafiaRoomGhostNight", "MafiaRoomGhostPanel", "OwnerStats", "OwnerStatsBars", "trackEvent", "logAppEvent", "mafiaFetchStory", "mafiaMorningWithStory", "LEADERBOARD_TABS", "TITLE_PROFILE_FIELDS", "ProfilePanel", "mafiaHostParts", "mafiaSay", "mafiaStopSaying", "mafiaStudioFetch", "mafiaVoiceWarmup", "mafiaVoiceLookahead", "mafiaPrimeSpeech", "t_lookup", "MafiaSetup", "initialState", "reducer", "nextNightPhase", "SCREENS"];
  new Function("window", "document", "navigator", "localStorage", "sessionStorage", "React", "ReactDOM", "supabase", "console", "__c",
    code + ";" + names.map((n) => `try{__c.${n}=${n};}catch(e){}`).join(""))(w, doc, { clipboard: { writeText: () => Promise.resolve() }, userAgent: "t", vibrate() {}, onLine: true }, ls, ss, react, { createRoot: () => ({ render() {} }), createPortal: (c) => c }, sb, { log() {}, error() {}, warn() {} }, C);
  return { C, calls, sent, pingHandlers, spoken, ls, ss, docListeners, fetched, played, storyRequests };
}

// ---------- views shaped exactly like mafia__view() ----------
const NAMES = ["Аня", "Боря", "Вика", "Гоша", "Даша", "Егор"];
function mkView(over = {}, meOver = {}, playersOver = {}) {
  const roles = ["mafia", "don", "doctor", "sheriff", "civilian", "civilian"];
  const meSeat = meOver.seat === undefined ? 4 : meOver.seat;
  const myRole = meOver.role || roles[meSeat];
  const mafiaSide = myRole === "mafia" || myRole === "don";
  const players = NAMES.map((name, seat) => ({ seat, name, alive: true, warnings: 0, no_vote: false, ready: false, voted: false, online: true, is_host: seat === 0, is_voice: seat === 0, is_me: seat === meSeat,
    role: seat === meSeat ? myRole : mafiaSide && (roles[seat] === "mafia" || roles[seat] === "don") ? roles[seat] : null, complaints: 0, warned_today: false, ...(playersOver[seat] || {}) }));
  return { code: "1234", status: "playing", phase: "roles", phase_role: null, seq: 1, night: 1, ms_left: 30000, settings: { mafia_count: 2, doctor: true, sheriff: true, don: true, maniac: false, putana: false, speech_seconds: 60 },
    is_host: meSeat === 0, is_voice: meSeat === 0, gate_seq: null, speech: [], speaker_seat: null, spoken: 0, alive_count: 6, complaints_needed: 3, last_night: null, lastword_seat: null, vote_result: null, exiled_seat: null, winner: null, players,
    me: { seat: meSeat, name: NAMES[meSeat], role: myRole, alive: true, warnings: 0, no_vote: false, ready: false, can_act: false, needs_close: false, pick: null, result: null, voted: false, vote_target: null, complained: [], ...meOver }, ...over };
}

(async () => {
  /* ================= host phrases ================= */
  let env = load({ react: React });
  let C = env.C;
  const view = mkView();
  const say = (key, params, lang = "ru") => C.mafiaHostLine({ seq: 1, key, params }, view, lang);
  eq(say("night_start", { night: 1 }), "Наступает ночь. Город засыпает. Все закрывают глаза.", "night_start line");
  ok(say("wake_mafia").includes("Просыпается мафия") && say("sleep_sheriff") === "Шериф засыпает.", "wake/sleep lines per role");
  eq(say("morning", { victims: [{ seat: 3, role: "sheriff" }], saved: false, missed: false }), "Наступает утро. Город просыпается. Все открывают глаза. Этой ночью город потерял игрока: Гоша. Роль: Шериф.", "morning with a victim");
  ok(say("morning", { victims: [], saved: true, missed: false }).endsWith("доктор спас жертву."), "morning: doctor saved");
  ok(say("morning", { victims: [], saved: false, missed: true }).includes("промахнулась") && say("morning", { victims: [], saved: false, missed: true }).endsWith("никто не погиб."), "morning: mafia missed, nobody died");
  eq(say("day_first", { seat: 1 }), "Начинается обсуждение. Первым говорит Боря.", "first speaker");
  eq(say("vote_result", { exiled: 2, tie: false }), "Город решил. Вика покидает игру.", "vote: exiled");
  eq(say("vote_result", { exiled: null, tie: true }), "Голоса разделились. Никто не покидает игру.", "vote: tie");
  eq(say("vote_result", { exiled: null, tie: false }), "Город никого не выгнал.", "vote: nobody");
  eq(say("reveal", { seat: 2, role: "doctor" }), "Вика. Роль: Доктор.", "reveal");
  ok(say("warning", { seat: 5, count: 3, by: "players" }).includes("Егор получает предупреждение: 3 из 4") && say("warning", { seat: 5, count: 3, by: "players" }).includes("пропускает ближайшее голосование"), "3rd warning mentions the lost vote");
  ok(say("warning", { seat: 5, count: 1, by: "host" }).startsWith("Создатель комнаты выдал предупреждение") && !say("warning", { seat: 5, count: 1, by: "host" }).includes("пропускает"), "host warning line");
  ok(say("removed", { seat: 5, role: "civilian" }).includes("Егор получает четвёртое предупреждение"), "removed line");
  eq(say("win", { winner: "mafia" }), "Игра окончена. Победила мафия.", "win line");
  const allKeys = [["roles_dealt"], ["night_start"], ["vote_start"], ["lastword", { seat: 0 }], ["day_speaker", { seat: 0 }], ["win", { winner: "town" }], ["win", { winner: "maniac" }],
    ...["putana", "mafia", "don", "maniac", "doctor", "sheriff"].flatMap((r) => [["wake_" + r], ["sleep_" + r]])];
  for (const lang of ["ru", "en", "hy"]) {
    ok(allKeys.every(([k, prm]) => { const s = say(k, prm, lang); return s && s.length > 5 && !s.includes("{") && !s.startsWith("mhost."); }), `every host line resolves in ${lang}`);
  }
  ok(say("morning", { victims: [{ seat: 0, role: "mafia" }], saved: false, missed: false }, "en").includes("Аня. Role: Mafia."), "English line keeps names and translates roles");

  /* ================= screens ================= */
  const noop = () => {};
  const roomOf = (v, extra = {}) => ({ view: v, code: "1234", act: noop, error: null, connStatus: "idle", deadlineAt: Date.now() + 30000, handleLeave: noop, handleStart: noop, ...extra });
  const game = (v, hostLine = "") => RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomGame, { room: roomOf(v), dispatch: noop, hostLine }));
  let mk;

  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomMenu, { dispatch: noop, onCreate: noop, onJoin: noop, busy: false, error: null, initialCode: "" }));
  ok(mk.includes("Создать комнату") && mk.includes("Войти по коду") && mk.includes("Один телефон") && mk.includes("Онлайн") && mk.includes("НОВОЕ"), "menu: mode tabs on top, create / join below");
  ok(/aria-pressed="true"[^>]*>Онлайн/.test(mk) && /aria-pressed="false"[^>]*>Один телефон/.test(mk), "menu: the Online tab is the selected one");
  ok(!mk.includes("Мафия: комната"), "menu: same page title as the one-phone setup");
  { const sent = []; let el; RDS.renderToStaticMarkup(React.createElement(function Cap() { el = C.MafiaModeSwitch({ mode: "online", dispatch: (a) => sent.push(a.type) }); return el; }));
    const btns = []; (function walk(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === "button") btns.push(n); if (n.props) walk(n.props.children); })(el);
    eq(btns.length, 2, "switch: two tabs"); eq(btns[0].props.className.split("text-center ")[0], btns[1].props.className.split("text-center ")[0], "switch: both tabs share the same box so the labels line up");
    btns[1].props.onClick(); eq(sent.length, 0, "switch: tapping the selected tab does nothing"); btns[0].props.onClick(); eq(sent.join(), "OPEN_MAFIA_SETUP", "switch: Online -> One phone"); }
  { const sent = []; let el; RDS.renderToStaticMarkup(React.createElement(function Cap() { el = C.MafiaModeSwitch({ mode: "onePhone", dispatch: (a) => sent.push(a.type) }); return el; }));
    const btns = []; (function walk(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk); if (n.type === "button") btns.push(n); if (n.props) walk(n.props.children); })(el);
    btns[1].props.onClick(); eq(sent.join(), "OPEN_MAFIA_ROOM", "switch: One phone -> Online"); }
  eq(C.screenFadeKey("mafiaroom"), C.screenFadeKey("mafia-setup"), "switching tabs does not replay the screen-change animation");
  eq(C.screenFadeKey("bunker"), "bunker", "other screens keep their own animation key");
  eq(C.reducer({ ...C.initialState, screen: "mafiaroom" }, { type: "GO_HUB", noFeedback: true }).feedbackPending, null, "backing out of the Online tab does not ask for a rating");
  eq(C.reducer({ ...C.initialState, screen: "mafiaroom" }, { type: "GO_HUB" }).feedbackPending, "mafia", "leaving a played room still asks for a rating");
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomMenu, { dispatch: noop, onCreate: noop, onJoin: noop, busy: false, error: null, initialCode: "4821" }));
  ok(mk.includes('value="4821"'), "menu opens on 'join' with the invite code filled in");

  const lobbyView = (meSeat) => { const v = mkView({ status: "lobby", phase: "lobby", ms_left: null }, { seat: meSeat }); v.players.forEach((pl) => { pl.role = null; }); v.me.role = null; return v; };
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomLobby, { room: roomOf(lobbyView(0)), dispatch: noop }));
  ok(mk.includes("1234") && NAMES.every((n) => mk.includes(n)) && mk.includes("Начать игру") && mk.includes("Время на речь игрока") && mk.includes("Создатель"), "lobby (creator): code, players, settings, start");
  ok(mk.includes("Этот телефон не может говорить") && mk.includes("обычном браузере"), "lobby warns when the voice phone cannot speak");
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomLobby, { room: roomOf(lobbyView(3)), dispatch: noop }));
  ok(!mk.includes("Начать игру") && mk.includes("Ждём создателя комнаты") && mk.includes("Настройки игры"), "lobby (guest): no start button, read-only settings");
  const few = lobbyView(0); few.players = few.players.slice(0, 3);
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomLobby, { room: roomOf(few), dispatch: noop }));
  ok(mk.includes("Нужно минимум 5 игроков") && /<button[^>]*disabled[^>]*>[^<]*<svg/.test(mk), "start is disabled under 5 players");

  mk = game(mkView({ phase: "roles" }), "Роли розданы.");
  ok(mk.includes("Показать роль") && !mk.includes("МИРНЫЙ ЖИТЕЛЬ") && mk.includes("Роли розданы."), "roles: role hidden until tapped, host line shown as text");
  ok(mk.includes("0/6"), "roles: ready counter");
  ok(!mk.includes("Не ждать остальных"), "roles: only the creator can skip the wait");
  ok(game(mkView({ phase: "roles" }, { seat: 0 })).includes("Не ждать остальных"), "roles: creator sees the skip button");

  // night: a civilian sees the same "close your eyes" screen in every night phase
  const nightScreens = ["night_start", "night_wake", "night_act", "night_sleep"].map((ph) => game(mkView({ phase: ph, phase_role: ph === "night_start" ? null : "sheriff" })));
  ok(nightScreens.every((s) => s.includes("Закройте глаза") && !s.includes("Ваш ход")), "night: non-acting player only sees 'close your eyes'");
  ok(nightScreens.every((s) => !["Гоша", "Аня", "Боря"].some((n) => s.includes(">" + n + "<"))), "night: no player list on a sleeping phone");
  // sheriff's turn
  mk = game(mkView({ phase: "night_act", phase_role: "sheriff" }, { seat: 3, can_act: true }), "Просыпается шериф.");
  ok(mk.includes("Кого проверить?") && mk.includes("Аня") && mk.includes("Егор") && !mk.includes(">Гоша<"), "sheriff: list of the others, not himself");
  ok(!mk.includes("Просыпается шериф."), "host caption is hidden on the acting phone");
  mk = game(mkView({ phase: "night_act", phase_role: "sheriff" }, { seat: 3, needs_close: true, pick: 0, result: { seat: 0, blocked: false, is_mafia: true } }));
  ok(mk.includes("Аня — мафия.") && mk.includes("Закрыть"), "sheriff: answer + Close");
  mk = game(mkView({ phase: "night_act", phase_role: "sheriff" }, { seat: 3, needs_close: true, pick: 4, result: { seat: 4, blocked: false, is_mafia: false } }));
  ok(mk.includes("Даша — не мафия."), "sheriff: negative answer");
  mk = game(mkView({ phase: "night_act", phase_role: "sheriff" }, { seat: 3, needs_close: true, pick: 0, result: { seat: 0, blocked: true, is_mafia: false } }));
  ok(mk.includes("вас заблокировали") && !mk.includes("мафия."), "sheriff: blocked answer reveals nothing");
  mk = game(mkView({ phase: "night_act", phase_role: "don" }, { seat: 1, needs_close: true, pick: 3, result: { seat: 3, blocked: false, is_sheriff: true } }));
  ok(mk.includes("Гоша — шериф."), "don: answer");
  // mafia's turn: teammates are not targets
  mk = game(mkView({ phase: "night_act", phase_role: "mafia" }, { seat: 0, can_act: true }));
  ok(mk.includes("Кого убивает мафия?") && mk.includes(">Вика<") && !mk.includes(">Боря<") && !mk.includes(">Аня<"), "mafia: cannot target itself or the don");
  mk = game(mkView({ phase: "night_act", phase_role: "mafia" }, { seat: 0, can_act: false, pick: 4 }));
  ok(mk.includes("Выбор принят: Даша.") && mk.includes("Ждём остальных") && !mk.includes(">Закрыть<"), "mafia: picked, waiting for the others");
  mk = game(mkView({ phase: "night_act", phase_role: "doctor" }, { seat: 2, can_act: true }));
  ok(mk.includes(">Вика<"), "doctor may pick himself");
  // dead player at night
  ok(game(mkView({ phase: "night_act", phase_role: "sheriff" }, { seat: 3, alive: false })).includes("Вы выбыли из игры"), "dead player sees no night action");

  mk = game(mkView({ phase: "morning", last_night: { victims: [{ seat: 3, role: "sheriff" }], saved: false, missed: false } }));
  ok(mk.includes("Гоша") && mk.includes("Шериф"), "morning: victim and role");
  mk = game(mkView({ phase: "morning", last_night: { victims: [], saved: true, missed: true } }));
  ok(mk.includes("Никто не погиб") || mk.includes("никто не погиб") || mk.includes("Мафия не договорилась"), "morning: nobody died / missed");

  mk = game(mkView({ phase: "day_speech", speaker_seat: 1, spoken: 2, ms_left: 42000 }, {}, { 5: { complaints: 2, warnings: 1 }, 2: { warned_today: true, warnings: 3, no_vote: true } }));
  ok(mk.includes("Боря") && mk.includes("2/6") && mk.includes("Пожаловаться") && mk.includes("жалоб 2/3") && mk.includes("Без голоса"), "day: speaker, counter, complaints, no-vote badge");
  ok(!mk.includes("Я закончил") && !mk.includes("Пропустить игрока") && !mk.includes("+1"), "day: a regular player has no speaker/creator buttons");
  mk = game(mkView({ phase: "day_speech", speaker_seat: 4, spoken: 1 }, { complained: [5] }));
  ok(mk.includes("Ваша очередь говорить") && mk.includes("Я закончил") && mk.includes("Жалоба подана"), "day: my turn + my complaint marked");
  mk = game(mkView({ phase: "day_speech", speaker_seat: 1 }, { seat: 0 }, { 2: { warnings: 3 } }));
  ok(mk.includes("Пропустить игрока") && mk.includes("+1"), "day: creator can skip and warn");
  mk = game(mkView({ phase: "day_speech", speaker_seat: 1 }, { alive: false }));
  ok(!mk.includes(">Пожаловаться<"), "dead players cannot complain");
  mk = game(mkView({ phase: "lastword", lastword_seat: 3 }, {}, { 3: { alive: false, role: "sheriff" } }));
  ok(mk.includes("Последнее слово") && mk.includes("Гоша") && !mk.includes("Пожаловаться"), "last word screen");

  mk = game(mkView({ phase: "vote" }, {}, { 0: { voted: true }, 5: { no_vote: true } }));
  ok(mk.includes("Голосование") && mk.includes("Проголосовали: 1 из 5") && mk.includes("Никого") && mk.includes(">Аня<") && !mk.includes(">Даша<"), "vote: targets (not myself), progress");
  ok(mk.includes("В этом голосовании не участвуют") && mk.includes("Егор"), "vote: who sits it out");
  ok(game(mkView({ phase: "vote" }, { voted: true, vote_target: 0 })).includes("Голос принят"), "vote: accepted state");
  ok(game(mkView({ phase: "vote" }, { no_vote: true })).includes("У вас 3 предупреждения"), "vote: player with 3 warnings cannot vote");
  const vr = { exiled: 2, tie: false, votes: [{ from: 0, to: 2 }, { from: 1, to: 2 }, { from: 3, to: null }] };
  mk = game(mkView({ phase: "vote_result", vote_result: vr, exiled_seat: 2 }, {}, { 2: { alive: false } }));
  ok(mk.includes("Вика") && mk.includes("Кто за кого голосовал") && mk.includes("Никого") && !mk.includes("Доктор"), "vote result: who voted for whom, role still hidden");
  mk = game(mkView({ phase: "reveal", vote_result: vr, exiled_seat: 2 }, {}, { 2: { alive: false, role: "doctor" } }));
  ok(mk.includes("Доктор"), "reveal: role shown");
  ok(game(mkView({ phase: "vote_result", vote_result: { exiled: null, tie: true, votes: [] } })).includes("Голоса разделились"), "vote result: tie");

  const endView = mkView({ status: "ended", phase: "ended", winner: "town", ms_left: null });
  ["mafia", "don", "doctor", "sheriff", "civilian", "civilian"].forEach((r, i) => { endView.players[i].role = r; });
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomEnd, { view: endView, act: noop, onLeave: noop }));
  ok(mk.includes("Дон") && mk.includes("Шериф") && mk.includes("Выйти из комнаты") && !mk.includes("Играть ещё") && !mk.includes("Сыграть ещё"), "end: all roles; guest has no 'play again'");

  // the app root and the entry from the one-phone setup
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaRoomApp, { dispatch: noop }));
  ok(mk.includes("Создать комнату") && mk.includes("Онлайн"), "app root renders the menu when not in a room");
  mk = RDS.renderToStaticMarkup(React.createElement(C.MafiaSetup, { state: C.initialState, dispatch: noop }));
  ok(/aria-pressed="true"[^>]*>Один телефон/.test(mk) && mk.includes("Онлайн") && mk.includes("НОВОЕ") && !mk.includes("Комната по коду"), "one-phone setup: tabs with One phone selected, Online marked NEW");
  eq(C.reducer(C.initialState, { type: "OPEN_MAFIA_ROOM" }).screen, "mafiaroom", "OPEN_MAFIA_ROOM routes to the room screen");
  ok(typeof C.SCREENS === "undefined" || true, "");

  // offline fix: the putana gets her turn, a lone don still gets the kill step
  eq(C.nextNightPhase(["putana", "mafia", "civilian"], [true, true, true], null), "night-putana", "one-phone night starts with the putana when she is alive");
  eq(C.nextNightPhase(["mafia", "civilian"], [true, true], null), "night-mafia", "…and with the mafia otherwise");
  eq(C.nextNightPhase(["putana", "don", "mafia", "civilian"], [true, true, false, true], "putana"), "night-mafia", "a lone don still gets the kill step");
  let st = C.reducer(C.initialState, { type: "MAFIA_SET_COUNT", value: 6 });
  st = { ...st, screen: "mafia-roster", mafia: { ...st.mafia, roles: ["putana", "mafia", "doctor", "sheriff", "civilian", "civilian"], alive: [true, true, true, true, true, true], phase: "roster" } };
  eq(C.reducer(st, { type: "MAFIA_CONTINUE" }).mafia.phase, "night-putana", "one-phone game: night 1 begins with the putana");

  /* ================= useMafiaRoom ================= */
  const lobby = { code: "1234", status: "lobby", phase: "lobby", ms_left: null, players: [], me: {}, speech: [], settings: {} };
  {
    const rt = makeRuntime();
    const FakeReact = { ...React, ...rt.hooks };
    let handler = (fn) => Promise.resolve({ data: fn === "mafia_create_room" ? lobby : { ...lobby, seq: 2 }, error: null });
    const e = load({ react: FakeReact, rpcHandler: (fn, args) => handler(fn, args) });
    rt.mount(e.C.useMafiaRoom);
    eq([rt.result.code, rt.result.view], [null, null], "hook starts outside any room");
    rt.result.handleCreate("Аня");
    await wait(20);
    eq(rt.result.code, "1234", "create: enters the room");
    const [fn0, a0] = e.calls.find((c) => c[0] === "mafia_create_room");
    ok(a0.p_name === "Аня" && typeof a0.p_player_id === "string" && a0.p_player_id.length >= 3 && a0.p_secret.length >= 16 && a0.p_can_speak === false, "create: sends id, secret, name, can_speak");
    ok(JSON.parse(e.ss._s.hatsit_mafiaroom_session_v1).code === "1234", "create: room remembered for a reload");
    const saved = JSON.parse(e.ls._s.hatsit_mafia_identity_v1);
    ok(saved.id === a0.p_player_id && saved.secret === a0.p_secret, "identity is stored on the device");
    // an action applies its answer and pings the others
    handler = () => Promise.resolve({ data: { ...lobby, seq: 7 }, error: null });
    await rt.result.act("mafia_update_settings", { p_settings: { don: true } });
    await wait(5);
    ok(rt.result.view.seq === 7 && e.sent.some((s) => s.event === "ping"), "action: view updated, ping sent");
    const lastCall = e.calls[e.calls.length - 1];
    ok(lastCall[0] === "mafia_update_settings" && lastCall[1].p_code === "1234" && lastCall[1].p_settings.don === true, "action: carries the room code and arguments");
    // a ping from another phone triggers a refetch
    const before = e.calls.filter((c) => c[0] === "mafia_view").length;
    handler = () => Promise.resolve({ data: { ...lobby, seq: 8 }, error: null });
    e.pingHandlers.forEach((h) => h({}));
    await wait(200);
    ok(e.calls.filter((c) => c[0] === "mafia_view").length === before + 1 && rt.result.view.seq === 8, "ping from another phone -> refetch");
    // out-of-order answers: an older request finishing later must not win
    let releaseSlow;
    handler = (fn) => (fn === "mafia_vote" ? new Promise((r) => { releaseSlow = () => r({ data: { ...lobby, seq: 100 }, error: null }); }) : Promise.resolve({ data: { ...lobby, seq: 200 }, error: null }));
    const slow = rt.result.act("mafia_vote", { p_target: 1 });
    await rt.result.act("mafia_ready");
    releaseSlow(); await slow; await wait(5);
    eq(rt.result.view.seq, 200, "a stale answer never overwrites a newer one");
    // deadline: asks the server right after the phase time is up
    handler = () => Promise.resolve({ data: { ...lobby, status: "playing", seq: 201, ms_left: 80 }, error: null });
    await rt.result.act("mafia_ready");
    const n1 = e.calls.filter((c) => c[0] === "mafia_view").length;
    handler = () => Promise.resolve({ data: { ...lobby, status: "playing", seq: 202, ms_left: null }, error: null });
    await wait(500);
    ok(e.calls.filter((c) => c[0] === "mafia_view").length > n1 && rt.result.view.seq === 202, "refetches when the phase deadline passes");
    // network failure -> banner state, then the room disappearing -> back to the menu
    handler = () => Promise.resolve({ data: null, error: { message: "TypeError: Failed to fetch" } });
    e.pingHandlers.forEach((h) => h({})); await wait(200);
    eq(rt.result.connStatus, "reconnecting", "failed poll shows the reconnecting banner");
    eq(rt.result.code, "1234", "…without leaving the room");
    handler = () => Promise.resolve({ data: { error: "not_in_room" }, error: null });
    e.pingHandlers.forEach((h) => h({})); await wait(200);
    eq([rt.result.code, rt.result.error], [null, "Комната закрыта."], "room gone -> menu with a message");
    ok(!("hatsit_mafiaroom_session_v1" in e.ss._s), "…and the saved room is forgotten");
    // join errors are explained
    handler = () => Promise.resolve({ data: { error: "not_found" }, error: null });
    rt.result.handleJoin("Боря", "9999"); await wait(20);
    eq(rt.result.error, "Комната не найдена. Проверьте код.", "join: unknown code");
    handler = () => Promise.resolve({ data: { error: "started" }, error: null });
    rt.result.handleJoin("Боря", "9999"); await wait(20);
    eq(rt.result.error, "Игра в этой комнате уже началась.", "join: game already started");
    rt.unmount();
  }
  {
    // reload inside a room: silently rejoins with the same identity
    const rt = makeRuntime();
    const identity = { id: "m-saved-identity", secret: "s".repeat(40) };
    const e = load({ react: { ...React, ...rt.hooks },
      session: { hatsit_app_state_v1: JSON.stringify({ savedAt: Date.now(), state: { screen: "mafiaroom" } }), hatsit_mafiaroom_session_v1: JSON.stringify({ code: "4321" }) },
      local: { hatsit_mafia_identity_v1: JSON.stringify(identity) },
      rpcHandler: (fn) => Promise.resolve({ data: { ...lobby, code: "4321", status: "playing" }, error: null }) });
    rt.mount(e.C.useMafiaRoom);
    await wait(20);
    const join = e.calls.find((c) => c[0] === "mafia_join_room");
    ok(join && join[1].p_code === "4321" && join[1].p_player_id === identity.id && join[1].p_secret === identity.secret, "reload: rejoins the saved room as the same player");
    eq(rt.result.code, "4321", "reload: back in the room");
    rt.unmount();
  }
  {
    // opening the screen from the Hub (not a reload) never resurrects an old room
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, session: { hatsit_mafiaroom_session_v1: JSON.stringify({ code: "4321" }) }, rpcHandler: () => Promise.resolve({ data: lobby, error: null }) });
    rt.mount(e.C.useMafiaRoom);
    await wait(20);
    ok(!e.calls.some((c) => c[0] === "mafia_join_room") && rt.result.code === null, "fresh visit: no silent rejoin");
    rt.unmount();
  }
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, search: "?room=4821&game=mafiaroom" });
    rt.mount(e.C.useMafiaRoom);
    eq(rt.result.inviteCode, "4821", "invite link fills in the room code");
    eq(e.C.reducer(e.C.initialState, { type: "GO_HUB" }).screen, "hub", "");
    rt.unmount();
  }

  /* ================= useMafiaVoice ================= */
  const voiceView = (over) => ({ ...mkView({ is_voice: true, ...over }) });
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(null); };
    ok(e.C.mafiaCanSpeak(), "speech is detected when the browser has it");
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [] }), act);
    rt.update(voiceView({ speech: [{ seq: 1, key: "roles_dealt", params: {} }], gate_seq: null }), act);
    await wait(30);
    eq(e.spoken, ["Роли розданы. Посмотрите свою роль на телефоне и нажмите «Готов»."], "voice phone speaks the first line");
    eq(acts, [], "a line no phase waits for is not reported");
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "roles_dealt", params: {} }, { seq: 2, key: "night_start", params: { night: 1 } }], gate_seq: 2 }), act);
    await wait(1400);
    eq(e.spoken.length, 2, "next line spoken once (the old one is not repeated)");
    eq(acts, [["mafia_speech_done", { p_seq: 2 }]], "tells the server when the awaited line has been said");
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "roles_dealt", params: {} }, { seq: 2, key: "night_start", params: { night: 1 } }], gate_seq: 2 }), act);
    await wait(30);
    eq(e.spoken.length, 2, "polling the same view again does not repeat the line");
    // two lines arriving together are both spoken, in order
    rt.update(voiceView({ phase: "day_speech", speech: [{ seq: 2, key: "night_start", params: {} }, { seq: 3, key: "removed", params: { seat: 5, role: "civilian" } }, { seq: 4, key: "day_speaker", params: { seat: 1 } }], gate_seq: null }), act);
    await wait(1500);
    ok(e.spoken.length === 5 && e.spoken[2].includes("Егор") && e.spoken[3].startsWith("Роль:") && e.spoken[4] === "Говорит Боря.", "back-to-back lines are spoken one after another, sentence by sentence: " + JSON.stringify(e.spoken.slice(2)));
    eq(rt.result, "Говорит Боря.", "latest line is returned as text for the screen");
    await wait(500);
    ok(e.C.mafiaCanSpeak(), "a phone that takes real time to speak keeps the voice");
    rt.unmount();
  }
  {
    // the bug from the live playtest: a phone with no voice for the language
    // "speaks" in a few milliseconds without a sound
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true, speechMs: 5 });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(null); };
    ok(e.C.mafiaCanSpeak(), "silent phone: not known before it tries");
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [] }), act);
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "night_start", params: { night: 1 } }], gate_seq: 1 }), act);
    await wait(500);
    ok(!e.C.mafiaCanSpeak(), "silent phone: caught after the first sentence, reports it cannot speak");
    eq(acts, [["mafia_speech_done", { p_seq: 1 }]], "silent phone: still reports the line so the game moves (the server keeps the screen up for its minimum time)");
    rt.unmount();
  }
  {
    // "hidden roles" room: the server sends no role, the host must not invent one
    const e = load({ react: React });
    const v = mkView({});
    const nm = (seat) => v.players.find((pl) => pl.seat === seat).name;
    const shown = e.C.mafiaHostLine({ seq: 1, key: "morning", params: { victims: [{ seat: 1, role: "sheriff" }], saved: false, missed: false } }, v, "ru");
    const hidden = e.C.mafiaHostLine({ seq: 1, key: "morning", params: { victims: [{ seat: 1, role: null }], saved: false, missed: false } }, v, "ru");
    ok(shown.includes("Роль:") && shown.includes(nm(1)), "normal room: morning names the role");
    ok(!hidden.includes("Роль") && !hidden.includes("undefined") && !hidden.includes("null") && hidden.includes("город потерял игрока: " + nm(1) + "."), "hidden roles: morning names the player only: " + hidden);
    for (const lang of ["en", "hy"]) { const x = e.C.mafiaHostLine({ seq: 1, key: "morning", params: { victims: [{ seat: 1, role: null }] } }, v, lang); ok(x.includes(nm(1)) && !/undefined|null|\{/.test(x), "hidden roles morning in " + lang); }
    const removed = e.C.mafiaHostLine({ seq: 2, key: "removed", params: { seat: 1, role: null } }, v, "ru");
    ok(removed === nm(1) + " получает четвёртое предупреждение и выбывает из игры.", "hidden roles: 4th warning without the role: " + removed);
    ok(e.C.mafiaHostLine({ seq: 2, key: "removed", params: { seat: 1, role: "mafia" } }, v, "ru").includes("Роль: Мафия"), "normal room: 4th warning names the role");
    const night = { victims: [{ seat: 1, role: null }], saved: false, missed: false };
    let mk2 = RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomMorning, { view: { ...v, last_night: night } }));
    ok(mk2.includes(nm(1)) && !mk2.includes(" — "), "hidden roles: morning screen shows the name without a role");
    mk2 = RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomMorning, { view: { ...v, last_night: { ...night, victims: [{ seat: 1, role: "doctor" }] } } }));
    ok(mk2.includes(nm(1) + " — Доктор"), "normal room: morning screen shows the role");
    // lobby: the creator gets the switch, others get a note when it is on
    const lobbyOf = (isHost, hide) => { const lv = mkView({ status: "lobby", phase: "lobby", ms_left: null, is_host: isHost, settings: { ...v.settings, hide_roles: hide } }); return RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomLobby, { room: { view: lv, code: "1234", act: () => Promise.resolve(null), error: null, connStatus: "idle", handleLeave() {}, handleStart() {} }, dispatch() {} })); };
    ok(lobbyOf(true, false).includes("Скрытые роли"), "lobby: creator sees the Hidden roles switch");
    ok(lobbyOf(false, true).includes("роли выбывших откроются в конце игры") && !lobbyOf(false, false).includes("роли выбывших откроются"), "lobby: others see a note only when it is on");
  }
  {
    // host sentences: the split into parts must read exactly like the old single templates
    const e = load({ react: React });
    const v = mkView({});
    const nm = (seat) => v.players.find((pl) => pl.seat === seat).name;
    for (const lang of ["ru", "en", "hy"]) {
      const L = (key) => e.C.t_lookup("mhost." + key, lang);
      const role = e.C.t_lookup("role.sheriff.name", lang);
      const line = (entry) => e.C.mafiaHostLine(entry, v, lang);
      eq(line({ key: "morning", params: { victims: [{ seat: 1, role: "sheriff" }] } }), L("morning") + " " + L("morningVictim").replace("{name}", nm(1)).replace("{role}", role), "parts == old morning template, " + lang);
      eq(line({ key: "reveal", params: { seat: 1, role: "sheriff" } }), L("reveal").replace("{name}", nm(1)).replace("{role}", role), "parts == old reveal template, " + lang);
      eq(line({ key: "removed", params: { seat: 1, role: "sheriff" } }), L("removed").replace("{name}", nm(1)).replace("{role}", role), "parts == old removed template, " + lang);
      eq(line({ key: "day_first", params: { seat: 1 } }), L("day_first").replace("{name}", nm(1)), "parts == old day_first template, " + lang);
    }
    eq(e.C.mafiaHostParts({ key: "morning", params: { victims: [{ seat: 1, role: "doctor" }], missed: true } }, v, "ru").length, 4, "morning with a miss and a victim is four sentences");
    eq(e.C.mafiaHostParts({ key: "night_start", params: { night: 1 } }, v, "ru"), ["Наступает ночь. Город засыпает. Все закрывают глаза."], "a fixed line stays one sentence");
    // what gets prepared in advance
    const lobby = e.C.mafiaVoiceWarmup({ ...v, status: "lobby", settings: { ...v.settings, doctor: true, sheriff: true, don: false, maniac: false, putana: false } }, "ru");
    ok(lobby.includes("Наступает ночь. Город засыпает. Все закрывают глаза.") && lobby.includes("Доктор засыпает.") && !lobby.includes("Дон засыпает.") && !lobby.some((x) => x.includes(nm(1))), "lobby warm-up: fixed lines for the enabled roles, no names yet");
    const game = e.C.mafiaVoiceWarmup({ ...v, status: "playing" }, "ru");
    ok(game.includes("Говорит " + nm(1) + ".") && game.includes("Роль: Мирный житель.") && game.includes("Игра окончена. Победила мафия."), "game warm-up adds the lines with names, roles and endings");
    ok(!e.C.mafiaVoiceWarmup({ ...v, status: "playing", settings: { ...v.settings, hide_roles: true } }, "ru").some((x) => x.startsWith("Роль:")), "hidden roles: no role lines prepared");
    eq(e.C.mafiaVoiceLookahead({ key: "vote_result", params: { exiled: 1 } }, v, "ru"), ["Последнее слово: " + nm(1) + ".", nm(1) + "."], "after the vote: the exiled player's lines are fetched ahead");
    eq(e.C.mafiaVoiceLookahead({ key: "morning", params: { victims: [{ seat: 2, role: null }] } }, v, "ru"), ["Последнее слово: " + nm(2) + "."], "after the night: the victim's last word is fetched ahead");
  }
  {
    // studio voice works: audio is played, the phone's own voice stays quiet
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true, studio: {} });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(null); };
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [] }), act);
    await wait(4500);
    ok(e.fetched.length > 5 && e.fetched.every((a) => a.startsWith("/api/mafia-voice?l=ru&v=1&t=")), "voice phone in the lobby prepares the fixed lines: " + e.fetched.length);
    ok(e.fetched.some((a) => decodeURIComponent(a).endsWith("t=Наступает ночь. Город засыпает. Все закрывают глаза.")), "…including the night line");
    const before = e.fetched.length;
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "night_start", params: { night: 1 } }], gate_seq: 1 }), act);
    await wait(700);
    eq([e.played.length, e.spoken.length], [1, 0], "studio voice plays the line; the phone's own voice is not used");
    ok(String(e.played[0]).startsWith("blob:"), "plays the fetched audio");
    eq(acts, [["mafia_speech_done", { p_seq: 1 }]], "reports the line as said after the audio ends");
    ok(e.fetched.slice(0, before).filter((a) => decodeURIComponent(a).includes("Наступает ночь")).length === 1 && !e.fetched.slice(before).some((a) => decodeURIComponent(a).includes("Наступает ночь. Город")), "a prepared line is not requested twice");
    // morning with a name: both sentences requested at once, played in order
    rt.update(voiceView({ phase: "morning", speech: [{ seq: 1, key: "night_start", params: {} }, { seq: 2, key: "morning", params: { victims: [{ seat: 1, role: "doctor" }] } }], gate_seq: 2 }), act);
    await wait(900);
    eq([e.played.length, e.spoken.length], [4, 0], "morning: three sentences, all in the studio voice");
    eq(acts.length, 2, "morning reported once, after its last sentence");
    ok(e.fetched.some((a) => decodeURIComponent(a).includes("Последнее слово: Боря.")), "the victim's last-word line is fetched ahead");
    rt.unmount();
  }
  {
    // a phone with no speech of its own (Telegram) can be the voice once the studio voice answers
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: false, studio: {} });
    ok(!e.C.mafiaCanSpeak(), "WebView: cannot speak before the studio voice has answered");
    rt.mount(e.C.useMafiaVoice, { ...mkView({ is_voice: false, status: "lobby" }) }, () => Promise.resolve(null));
    await wait(80);
    eq(e.fetched.length, 1, "a non-voice phone asks for just one sentence, to learn the studio voice works");
    ok(e.C.mafiaCanSpeak(), "WebView: can be the host's voice through the studio voice");
    rt.unmount();
  }
  {
    // quota exhausted: stop asking, the phone's own voice takes over at once
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true, studio: { status: 429 } });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(null); };
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [] }), act);
    await wait(120);
    const asked = e.fetched.length;
    ok(asked >= 1 && asked <= 2, "after a 429 the warm-up stops: " + asked);
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "night_start", params: { night: 1 } }], gate_seq: 1 }), act);
    await wait(900);
    eq([e.played.length, e.spoken.length, e.fetched.length], [0, 1, asked], "quota hit: the phone speaks itself and no more requests are made");
    eq(acts, [["mafia_speech_done", { p_seq: 1 }]], "…and the game still moves on");
    ok(e.C.mafiaCanSpeak(), "…this phone can still be the voice with its own speech");
    rt.unmount();
  }
  {
    // the browser refuses to play audio (no tap yet): the phone's voice says the line
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true, studio: { playRejects: true } });
    const act = () => Promise.resolve(null);
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [] }), act);
    await wait(100);
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "night_start", params: { night: 1 } }], gate_seq: 1 }), act);
    await wait(600);
    eq([e.played.length, e.spoken.length], [0, 1], "audio refused -> spoken by the phone instead");
    rt.unmount();
  }
  {
    // audio that takes too long to arrive is not waited for
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true, studio: { delay: (a) => (decodeURIComponent(a).includes("Говорит") ? 6000 : 5) } });
    const act = () => Promise.resolve(null);
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [] }), act);
    await wait(100);
    rt.update(voiceView({ phase: "day_speech", speech: [{ seq: 1, key: "day_speaker", params: { seat: 1 } }], gate_seq: null }), act);
    await wait(3000);
    eq(e.spoken.length, 0, "waits a little for the studio voice…");
    await wait(1000);
    eq([e.played.length, e.spoken], [0, ["Говорит Боря."]], "…then the phone says the line itself");
    rt.unmount();
  }
  {
    // Hub: games marked as new come first and carry a NEW badge
    const e = load({ react: React });
    const ids = e.C.hubGameOrder(e.C.GAMES).map((g) => g.id);
    eq(ids.slice(0, 6), ["mafia", "court", "nardy", "blot", "blackjack", "durak"], "new games lead the list, in their written order");
    eq(ids.slice(6), e.C.GAMES.filter((g) => !g.isNew).map((g) => g.id), "the rest keep their order");
    eq(ids.slice().sort(), e.C.GAMES.map((g) => g.id).sort(), "no game lost or duplicated");
    eq(e.C.hubGameOrder([{ id: "a" }, { id: "b" }]).map((g) => g.id), ["a", "b"], "nothing marked new -> order untouched");
    const hub = RDS.renderToStaticMarkup(React.createElement(e.C.Hub, { state: e.C.initialState, dispatch() {} }));
    const at = (title) => hub.indexOf(">" + title + "<");
    ok(at("Мафия") > 0 && at("Мафия") < at("Суд") && at("Суд") < at("Шпион") && at("Шпион") < at("Бункер"), "Hub shows Mafia, then Court, then the others");
    eq((hub.match(/>НОВОЕ</g) || []).length, 2, "exactly the two new party games carry the badge (Durak sits under Карточные)");
    ok(hub.includes("теперь и онлайн"), "Mafia's tile mentions the online mode");
    const card = (isNew) => RDS.renderToStaticMarkup(React.createElement(e.C.GameCard, { title: "X", subtitle: "y", Icon: () => null, active: true, isNew, badge: "Онлайн" }));
    ok(card(true).includes("НОВОЕ") && card(true).includes("Онлайн") && !card(false).includes("НОВОЕ"), "the NEW badge sits alongside the Online badge and is off by default");
  }
  {
    // ---------- Mafia achievements ----------
    const e = load({ react: React });
    const A = e.C.ACHIEVEMENTS;
    const mafia = A.filter((a) => a.group === "mafia");
    eq(mafia.length, 21, "21 Mafia achievements");
    eq(A.length, 56, "56 achievements in total (8 general, 21 Mafia, 12 Court, 15 card games)");
    eq(A.filter((a) => a.group === "cards").length, 15, "15 for the card games");
    eq(new Set(A.map((a) => a.id)).size, A.length, "achievement ids are unique");
    const un = (p) => e.C.computeUnlockedAchievementIds(p).filter((id) => id.startsWith("mafia_"));
    eq(un({}), [], "an empty profile has no Mafia achievements");
    eq(un({ mafia_games: 1 }), ["mafia_first"], "one game -> First night only");
    eq(un({ mafia_games: 10, mafia_wins: 1, mafia_town_wins: 1, mafia_survived: 5 }), ["mafia_first", "mafia_10", "mafia_win_1", "mafia_survivor_5"], "thresholds are exact");
    ok(!un({ mafia_wins: 9 }).includes("mafia_win_10") && un({ mafia_wins: 10 }).includes("mafia_win_10"), "10 wins boundary");
    ok(un({ mafia_mafia_wins: 5 }).includes("mafia_godfather") && !un({ mafia_mafia_wins: 4 }).includes("mafia_godfather"), "godfather at 5 mafia wins");
    ok(un({ mafia_finds: 1 }).includes("mafia_sheriff_1") && un({ mafia_saves: 10 }).includes("mafia_doctor_10") && un({ mafia_kills: 25 }).includes("mafia_killer_25") && un({ mafia_good_votes: 10 }).includes("mafia_votes_10"), "role achievements");
    ok(un({ mafia_best_streak: 3 }).includes("mafia_streak_3") && !un({ mafia_best_streak: 3 }).includes("mafia_streak_5"), "streak uses the best streak");
    ok(!un({ mafia_roles_mask: 1 | 2 | 8 }).includes("mafia_all_roles") && un({ mafia_roles_mask: 1 | 2 | 8 | 16 }).includes("mafia_all_roles") && un({ mafia_roles_mask: 127 }).includes("mafia_all_roles"), "all four core roles needed");
    const all = un({ mafia_games: 50, mafia_wins: 25, mafia_town_wins: 5, mafia_mafia_wins: 5, mafia_maniac_wins: 1, mafia_finds: 10, mafia_saves: 10, mafia_kills: 25, mafia_good_votes: 10, mafia_survived: 20, mafia_best_streak: 5, mafia_roles_mask: 27 });
    eq(all.length, 21, "a maxed profile unlocks all 21");
    for (const lang of ["ru", "en", "hy"]) ok(mafia.every((a) => { const x = e.C.t_lookup(a.titleKey, lang), y = e.C.t_lookup(a.descKey, lang); return x && y && x !== a.titleKey && y !== a.descKey; }), "every Mafia achievement has a title and a description in " + lang);
    ok(e.C.PLAYER_TITLES.filter((x) => x.achievementId.startsWith("mafia_")).every((x) => A.some((a) => a.id === x.achievementId)), "every Mafia title belongs to an achievement");
    eq(e.C.getPlayerTitle({ mafia_wins: 1 }).achievementId, "mafia_win_1", "first Mafia win gives a title");
    eq(e.C.getPlayerTitle({ mafia_wins: 25, mafia_mafia_wins: 5 }).achievementId, "mafia_win_25", "the legend outranks the godfather");
    eq(e.C.getPlayerTitle({ mafia_wins: 25, mafia_mafia_wins: 5, selected_title: "mafia_godfather" }).achievementId, "mafia_godfather", "a chosen Mafia title is respected");
    ok(e.C.LEADERBOARD_TABS.some((x) => x.key === "mafia") && ["mafia_wins", "mafia_mafia_wins", "mafia_finds", "mafia_saves"].every((f) => e.C.TITLE_PROFILE_FIELDS.includes(f)), "leaderboard has a Mafia tab and fetches what the titles need");
  }
  {
    // ---------- end of game: personal result, claim, toast ----------
    const rt = makeRuntime();
    const prof = { id: "anon:x", mafia_games: 1, mafia_wins: 1, mafia_town_wins: 1 };
    const e = load({ react: { ...React, ...rt.hooks }, profile: prof, local: { hatsit_achievements_seen_v1: "[]" } });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(fn === "mafia_claim_result" ? { ok: true, won: true, side: "town" } : null); };
    const ended = mkView({ status: "ended", phase: "ended", winner: "town", seq: 77 }, { seat: 3, role: "sheriff", stats: { finds: 2, good_votes: 1 }, claimed: false });
    rt.mount(e.C.MafiaRoomEnd, { view: ended, act, onLeave() {} });
    await wait(60);
    eq(acts.length, 1, "the result is claimed once");
    eq(acts[0][0], "mafia_claim_result", "…through mafia_claim_result");
    ok(/^(anon|tg):/.test(acts[0][1].p_profile_id), "…for this device's profile id: " + acts[0][1].p_profile_id);
    const flat = (n) => (n === null || n === undefined || typeof n === "boolean" ? "" : typeof n !== "object" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.props && n.props.children));
    const all = (n, out = []) => { if (Array.isArray(n)) n.forEach((x) => all(x, out)); else if (n && typeof n === "object" && n.props) { out.push(n); all(n.props.children, out); } return out; };
    let text = flat(rt.result);
    ok(text.includes("Вы победили!") && text.includes("Ваша роль: Шериф") && text.includes("Удачных проверок: 2") && text.includes("Верных голосов: 1") && !text.includes("Спасено"), "end screen: own result with only the stats that happened");
    ok(text.includes("Результат записан в профиль"), "end screen says the result was saved");
    const toast = all(rt.result).find((x) => typeof x.type === "function" && x.props.achievement);
    ok(toast && ["mafia_first", "mafia_win_1"].includes(toast.props.achievement.id), "a newly unlocked Mafia achievement is celebrated");
    rt.update({ view: { ...ended, me: { ...ended.me, claimed: true } }, act, onLeave() {} });
    await wait(30);
    eq(acts.length, 1, "re-rendering does not claim again");
    rt.unmount();
    // a loser, and a view already claimed
    const rt2 = makeRuntime();
    const e2 = load({ react: { ...React, ...rt2.hooks } });
    const acts2 = [];
    rt2.mount(e2.C.MafiaRoomEnd, { view: mkView({ status: "ended", phase: "ended", winner: "town" }, { seat: 0, role: "mafia", stats: { kills: 2 }, claimed: true }), act: (fn) => { acts2.push(fn); return Promise.resolve(null); }, onLeave() {} });
    await wait(30);
    text = flat(rt2.result);
    ok(text.includes("Вы проиграли") && text.includes("Убийств: 2"), "end screen for the losing side");
    eq(acts2, [], "an already claimed game is not claimed again");
    rt2.unmount();
  }
  {
    // ---------- spectators ----------
    const e = load({ react: React });
    const roles = ["mafia", "don", "doctor", "sheriff", "civilian", "civilian"];
    const ghostView = (over) => { const v = mkView({ ghost: true, phase: "night_act", phase_role: "mafia", ghost_night: { putana: null, mafia: null, don: null, maniac: null, doctor: null, sheriff: null, mafia_picks: [{ seat: 0, target: 4 }, { seat: 1, target: null }] }, ...over }, { seat: 5, alive: false }); v.players.forEach((pl, k) => { pl.role = roles[k]; }); v.players[5].alive = false; return v; };
    let mk3 = RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomGhostNight, { view: ghostView({}) }));
    ok(mk3.includes("Ночь глазами зрителя") && mk3.includes("Аня: Даша") && mk3.includes("Боря: выбирает…"), "spectator sees each mafia member's pick as it happens");
    ok(mk3.includes("Доктор") && mk3.includes("ещё не ходил") && !mk3.includes("Путана") && !mk3.includes("Маньяк"), "only roles that are in the game and alive are listed");
    mk3 = RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomGhostNight, { view: ghostView({ phase: "night_act", phase_role: "sheriff", ghost_night: { mafia: 4, don: 3, doctor: 4, sheriff: null, mafia_picks: [] } }) }));
    ok(mk3.includes("→ Даша") && mk3.includes("→ Гоша") && mk3.includes("выбирает…"), "later in the night: earlier picks are shown, the current role is choosing");
    mk3 = RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomGhostPanel, { view: ghostView({}) }));
    ok(mk3.includes("Вы зритель") && mk3.includes("Не подсказывайте") && mk3.includes("Шериф") && mk3.includes("Дон"), "spectator panel: a warning and the table with all roles");
    const game = (v) => RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomGame, { room: { view: v, code: "1234", act: () => Promise.resolve(null), error: null, connStatus: "idle", deadlineAt: Date.now() + 30000, handleLeave() {}, handleStart() {} }, dispatch() {}, hostLine: "" }));
    ok(game(ghostView({})).includes("Ночь глазами зрителя") && game(ghostView({})).includes("Вы зритель"), "game screen switches to the spectator night");
    const plainDead = mkView({ ghost: false, phase: "night_act", phase_role: "mafia" }, { seat: 5, alive: false });
    ok(!game(plainDead).includes("Вы зритель") && game(plainDead).includes("Наблюдайте молча"), "with spectators off a dead player just waits");
    ok(game(ghostView({ phase: "day_speech", phase_role: null, ghost_night: null, speaker_seat: 2 })).includes("Вы зритель"), "the spectator panel stays during the day");
    // lobby switches
    const lobbyOf = (isHost, st) => { const lv = mkView({ status: "lobby", phase: "lobby", ms_left: null, is_host: isHost, settings: { mafia_count: 1, doctor: true, sheriff: true, speech_seconds: 60, ...st } }); return RDS.renderToStaticMarkup(React.createElement(e.C.MafiaRoomLobby, { room: { view: lv, code: "1234", act: () => Promise.resolve(null), error: null, connStatus: "idle", handleLeave() {}, handleStart() {} }, dispatch() {} })); };
    ok(lobbyOf(true, {}).includes("Зрители") && lobbyOf(true, {}).includes("Истории ведущего"), "lobby: creator sees the Spectators and Stories switches");
    ok(lobbyOf(false, { ghosts: false, stories: false }).includes("Выбывшие не видят роли") && !lobbyOf(false, { ghosts: false, stories: false }).includes("Истории ведущего"), "lobby: others see what is switched off");
    ok(lobbyOf(false, {}).includes("Истории ведущего") && !lobbyOf(false, {}).includes("Выбывшие не видят роли"), "lobby: defaults are spectators on, stories on");
  }
  {
    // ---------- events go to our own database ----------
    const e = load({ react: React, local: { hatsit_player_id_v1: "anon:test-device" } });
    e.calls.length = 0;
    e.C.trackEvent("game_started", { game: "spy", players: 5 });
    e.C.trackEvent("share_clicked", null);
    const logged = e.calls.filter((c) => c[0] === "log_event");
    eq(logged.length, 2, "each tracked event is logged once");
    eq(logged[0][1], { p_name: "game_started", p_game: "spy", p_player_id: "anon:test-device", p_lang: "ru", p_platform: "web", p_extra: { players: 5 } }, "event row: name, game, device, language, platform, extras");
    eq([logged[1][1].p_game, logged[1][1].p_extra], [null, null], "an event without details is logged bare");
  }
  {
    // ---------- the host's morning story ----------
    const v = mkView({ night: 2, settings: { mafia_count: 2, doctor: true, sheriff: true, don: true, stories: true, speech_seconds: 60 } });
    const morning = { seq: 5, key: "morning", params: { victims: [{ seat: 1, role: "doctor" }], saved: false, missed: false } };
    let e = load({ react: React, storyApi: { text: "Туман рассеялся, но Боря так и не вышел из дома." } });
    eq(await e.C.mafiaFetchStory(morning, v, "ru"), "Туман рассеялся, но Боря так и не вышел из дома.", "a good story is accepted");
    eq(e.storyRequests[0], { lang: "ru", victims: ["Боря"], saved: false, missed: false, night: 2 }, "the request carries only names and the night's outcome -- no roles");
    e = load({ react: React, storyApi: { text: "Этой ночью город потерял одного жителя, и никто не знает почему." } });
    eq(await e.C.mafiaFetchStory(morning, v, "ru"), null, "a story that does not name the victim is rejected");
    e = load({ react: React, storyApi: { text: "Боря не проснулся, а Вика что-то знает об этом." } });
    eq(await e.C.mafiaFetchStory(morning, v, "ru"), null, "a story that names another player is rejected");
    e = load({ react: React, storyApi: { text: "Боря. " + "Очень длинная история. ".repeat(10) } });
    eq(await e.C.mafiaFetchStory(morning, v, "ru"), null, "an over-long story is rejected");
    e = load({ react: React, storyApi: {} });
    eq(await e.C.mafiaFetchStory(morning, v, "ru"), null, "a server error gives no story");
    e = load({ react: React });
    eq(await e.C.mafiaFetchStory(morning, v, "ru"), null, "no network API -> no story, no crash");
    // parts: opening, then story + role, with the plain sentences as the fallback
    e = load({ react: React, storyApi: { text: "Туман рассеялся, но Боря так и не вышел из дома." } });
    const parts = e.C.mafiaMorningWithStory(morning, v, "ru");
    eq(parts[0], "Наступает утро. Город просыпается. Все открывают глаза.", "the fixed opening comes first");
    eq(parts[1].fallback, ["Этой ночью город потерял игрока: Боря.", "Роль: Доктор."], "fallback = the plain sentences");
    eq(await parts[1].lazy, ["Туман рассеялся, но Боря так и не вышел из дома.", "Роль: Доктор."], "story replaces the plain death sentence, the role still follows");
    const hidden = e.C.mafiaMorningWithStory({ seq: 5, key: "morning", params: { victims: [{ seat: 1, role: null }] } }, v, "ru");
    eq(await hidden[1].lazy, ["Туман рассеялся, но Боря так и не вышел из дома."], "hidden roles: the story is not followed by a role");
    // spoken end to end by the voice phone (phone voice, no studio)
    const rt = makeRuntime();
    e = load({ react: { ...React, ...rt.hooks }, speech: true, storyApi: { text: "Туман рассеялся, но Боря так и не вышел из дома." } });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(null); };
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby", speech: [], settings: v.settings }), act);
    rt.update(voiceView({ phase: "morning", night: 2, settings: v.settings, speech: [morning], gate_seq: 5 }), act);
    await wait(2200);
    eq(e.spoken, ["Наступает утро. Город просыпается. Все открывают глаза.", "Туман рассеялся, но Боря так и не вышел из дома.", "Роль: Доктор."], "the host tells the story in place of the plain sentence");
    eq(acts, [["mafia_speech_done", { p_seq: 5 }]], "…and reports the morning as said once, at the end");
    rt.unmount();
    // stories switched off, and a failed story
    for (const [label, opts, settings] of [["stories off", { text: "Боря исчез в тумане этой ночью." }, { ...v.settings, stories: false }], ["story failed", {}, v.settings]]) {
      const rt3 = makeRuntime();
      const e3 = load({ react: { ...React, ...rt3.hooks }, speech: true, storyApi: opts });
      rt3.mount(e3.C.useMafiaVoice, voiceView({ status: "lobby", speech: [], settings }), act);
      rt3.update(voiceView({ phase: "morning", night: 2, settings, speech: [morning], gate_seq: 5 }), act);
      await wait(2200);
      eq(e3.spoken, ["Наступает утро. Город просыпается. Все открывают глаза.", "Этой ночью город потерял игрока: Боря.", "Роль: Доктор."], label + ": the plain sentences are said");
      if (label === "stories off") eq(e3.storyRequests.length, 0, "stories off: no request is made");
      rt3.unmount();
    }
  }
  {
    // ---------- owner statistics page ----------
    const stats = { ok: true, totals: { profiles: 63, new_7d: 52, new_prev_7d: 11, active_7d: 20, came_back: 6, came_back_3: 3, named: 4, games_started_7d: 31, games_completed_7d: 12, events_since: "2026-10-07T10:00:00Z", feedback: 7, rating: 4.86, mafia_rooms_now: 1, mafia_players: 2 },
      days: Array.from({ length: 14 }, (_, k) => ({ day: "2026-09-" + String(24 + k > 30 ? k - 6 : 24 + k).padStart(2, "0"), new: k, active: k + 1, opens: k * 2, started: k === 13 ? 9 : 0, completed: 0 })),
      games: [{ game: "mafiaroom", started: 9, completed: 4, players: 3, started_all: 9 }, { game: "spy", started: 3, completed: 1, players: 2, started_all: 3 }],
      feedback: [{ game: "mafia", n: 4, rating: 5 }], comments: [{ game: "spy", rating: 4, comment: "Отличная игра", language: "ru", created_at: "2026-09-26T10:07:49Z" }, { game: "mafia", rating: 5, comment: null, language: "ru", created_at: "2026-10-06T12:40:12Z" }],
      split: { platform: { web: 15, telegram: 5 }, lang: { ru: 18, hy: 2 } } };
    const flat = (n) => (n === null || n === undefined || typeof n === "boolean" ? "" : typeof n !== "object" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : flat(n.props && n.props.children));
    const expand = (n) => { if (Array.isArray(n)) return n.map(expand); if (n && typeof n === "object" && n.props) { if (typeof n.type === "function" && n.type.name.startsWith("OwnerStats")) return expand(n.type(n.props)); return { ...n, props: { ...n.props, children: expand(n.props.children) } }; } return n; };
    for (const [answer, expected, label] of [[{ error: "not_configured" }, "Пароль ещё не задан", "no password set yet -> shows how to set it"], [{ error: "forbidden" }, "Неверный пароль", "wrong password"]]) {
      const rt = makeRuntime();
      const e = load({ react: { ...React, ...rt.hooks }, session: { hatsit_owner_stats_pw_v1: "saved-pass" }, rpcAny: (fn) => Promise.resolve({ data: fn === "admin_stats" ? answer : null, error: null }) });
      rt.mount(e.C.OwnerStats, { dispatch() {} });
      await wait(40);
      const text = flat(rt.result);
      ok(text.includes(expected) && !text.includes("Всего посетителей"), "stats page: " + label);
      if (answer.error === "not_configured") ok(text.includes("select set_stats_password("), "…with the exact line to run");
      rt.unmount();
    }
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, session: { hatsit_owner_stats_pw_v1: "saved-pass" }, rpcAny: (fn, args) => Promise.resolve({ data: fn === "admin_stats" && args.p_password === "saved-pass" ? stats : null, error: null }) });
    rt.mount(e.C.OwnerStats, { dispatch() {} });
    await wait(40);
    eq(e.calls.filter((c) => c[0] === "admin_stats").map((c) => c[1].p_password), ["saved-pass"], "stats page: the password is sent to the server to be checked there");
    // OwnerStatsBars uses hooks, so expand only the tiles by hand and read the rest as text
    const text = flat(rt.result) + all2(rt.result).filter((x) => typeof x.type === "function" && x.type.name === "OwnerStatsTile").map((x) => flat(x.type(x.props))).join(" | ");
    function all2(n, out = []) { if (Array.isArray(n)) n.forEach((x) => all2(x, out)); else if (n && typeof n === "object" && n.props) { out.push(n); all2(n.props.children, out); } return out; }
    ok(text.includes("Всего посетителей") && text.includes("63") && text.includes("неделей раньше: 11 (+41)"), "stats page: headline numbers with the week-over-week change");
    ok(text.includes("Мафия онлайн") && text.includes("начато") && text.includes("Шпион"), "stats page: per-game table with readable game names");
    ok(text.includes("Сайт — 15 · Telegram — 5") && text.includes("русский — 18 · армянский — 2"), "stats page: where visitors come from");
    ok(text.includes("Отличная игра") && text.includes("считаются с 7.10"), "stats page: comments and the honest note about when counting began");
    const charts = all2(rt.result).filter((x) => typeof x.type === "function" && x.type.name === "OwnerStatsBars");
    eq(charts.map((x) => x.props.field), ["new", "opens", "started"], "stats page: three separate one-measure charts (no shared axis)");
    rt.unmount();
    // the chart itself
    const rtb = makeRuntime();
    const eb = load({ react: { ...React, ...rtb.hooks } });
    rtb.mount(eb.C.OwnerStatsBars, { title: "Запущено игр по дням", days: stats.days, field: "started" });
    const bars = all2(rtb.result).filter((x) => x.type === "button");
    eq(bars.length, 14, "chart: one bar per day");
    ok(flat(rtb.result).includes("за 14 дней: 9") && bars[13].props["aria-label"] === "7.09: 9", "chart: total and a readable label per bar");
    const heights = bars.map((b) => all2(b).find((x) => x.type === "span").props.style.height);
    ok(heights[13] === "100%" && heights[0] === "0%", "chart: bar heights follow the values, zero stays zero");
    rtb.unmount();
  }
  {
    // nicest available voice
    const pick = (list) => { const e = load({ react: React, speech: true, voices: list }); const u = e.C.mafiaDressUtterance({}, "ru"); return [u.lang, u.voice ? u.voice.name : null]; };
    eq(pick([{ lang: "ru-RU", name: "Milena Compact" }, { lang: "ru-RU", name: "Milena (Enhanced)" }, { lang: "en-US", name: "Samantha (Premium)" }]), ["ru-RU", "Milena (Enhanced)"], "voice: enhanced beats compact, other languages ignored");
    eq(pick([{ lang: "ru-RU", name: "Microsoft Irina", localService: true }, { lang: "ru-RU", name: "Microsoft Svetlana Online (Natural)", localService: false }]), ["ru-RU", "Microsoft Svetlana Online (Natural)"], "voice: natural online voice preferred");
    eq(pick([{ lang: "en-US", name: "David" }]), ["ru-RU", null], "voice: none for the language -> phone default, language still set");
    eq(pick([]), ["ru-RU", null], "voice: empty list -> phone default");
  }
  {
    const only = (langs) => load({ react: React, speech: true, voices: langs.map((lang) => ({ lang })) }).C.mafiaCanSpeak();
    ok(!only(["en-US", "en-GB"]), "voices listed but none for Russian -> cannot be the host's voice");
    ok(only(["en-US", "ru-RU"]), "a Russian voice among others -> can speak");
    ok(only(["ru_RU"]), "Android-style ru_RU is recognised");
    ok(only([]), "empty voice list (not loaded yet) is not treated as mute");
  }
  {
    // voting: a pick, then a separate confirm tap
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks } });
    const acts = [];
    const act = (fn, args) => { acts.push([fn, args]); return Promise.resolve(null); };
    const v = mkView({ phase: "vote" });
    const walkAll = (n, out = []) => { if (Array.isArray(n)) n.forEach((x) => walkAll(x, out)); else if (n && typeof n === "object" && n.props) { out.push(n); walkAll(n.props.children, out); } return out; };
    const textOf = (n) => (n === null || n === undefined || typeof n === "boolean" ? "" : typeof n !== "object" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : textOf(n.props && n.props.children));
    rt.mount(e.C.MafiaRoomVote, { view: v, act, seconds: 30 });
    let els = walkAll(rt.result);
    let confirm = els.find((x) => x.type === "button" && x.props.disabled !== undefined);
    ok(confirm && confirm.props.disabled === true && textOf(confirm) === "Выберите игрока и подтвердите", "vote: confirm button is off until someone is picked");
    const playerBtns = els.filter((x) => typeof x.type === "function" && x.props.selected !== undefined);
    ok(playerBtns.length >= 2, "vote: player buttons listed");
    playerBtns[0].props.onClick(playerBtns[0].props.index);
    await wait(20);
    eq(acts, [], "vote: tapping a player only picks, nothing is sent");
    els = walkAll(rt.result);
    confirm = els.find((x) => x.type === "button" && x.props.disabled !== undefined);
    ok(confirm.props.disabled === false && textOf(confirm).startsWith("Проголосовать: "), "vote: confirm button names the pick: " + textOf(confirm));
    ok(els.filter((x) => typeof x.type === "function" && x.props.selected === true).length === 1, "vote: the pick is highlighted");
    // change of mind before confirming
    const nobody = els.find((x) => x.type === "button" && textOf(x) === "Никого");
    nobody.props.onClick();
    await wait(20);
    els = walkAll(rt.result);
    confirm = els.find((x) => x.type === "button" && x.props.disabled !== undefined);
    eq(textOf(confirm), "Проголосовать: Никого", "vote: the pick can be changed before confirming");
    confirm.props.onClick();
    await wait(20);
    eq(acts, [["mafia_vote", { p_target: null }]], "vote: sent once, on confirm");
    rt.unmount();
  }
  {
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true });
    const acts = [];
    rt.mount(e.C.useMafiaVoice, { ...mkView({ is_voice: false, status: "lobby" }) }, (fn, a) => acts.push([fn, a]));
    rt.update({ ...mkView({ is_voice: false, phase: "night_start", speech: [{ seq: 1, key: "night_start", params: {} }], gate_seq: 1 }) }, (fn, a) => acts.push([fn, a]));
    await wait(450);
    eq([e.spoken, acts, rt.result], [[], [], "Наступает ночь. Город засыпает. Все закрывают глаза."], "a non-voice phone stays silent but shows the text");
    rt.unmount();
  }
  {
    // joined in the middle of a game: nothing already said is replayed
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: true });
    const acts = [];
    const act = (fn, a) => acts.push([fn, a]);
    rt.mount(e.C.useMafiaVoice, voiceView({ phase: "day_speech", speech: [{ seq: 8, key: "day_speaker", params: { seat: 1 } }] }), act);
    await wait(30);
    eq(e.spoken, [], "mid-game join does not replay old lines");
    rt.update(voiceView({ phase: "vote", speech: [{ seq: 8, key: "day_speaker", params: { seat: 1 } }, { seq: 9, key: "vote_start", params: {} }] }), act);
    await wait(30);
    eq(e.spoken.length, 1, "…but new lines are spoken");
    rt.unmount();
  }
  {
    // voice role on a phone that cannot speak (Telegram): don't make the table wait in silence
    const rt = makeRuntime();
    const e = load({ react: { ...React, ...rt.hooks }, speech: false });
    const acts = [];
    const act = (fn, a) => acts.push([fn, a]);
    ok(!e.C.mafiaCanSpeak(), "no speech in a WebView");
    rt.mount(e.C.useMafiaVoice, voiceView({ status: "lobby" }), act);
    rt.update(voiceView({ phase: "night_start", speech: [{ seq: 1, key: "night_start", params: {} }], gate_seq: 1 }), act);
    await wait(450);
    eq(acts, [["mafia_speech_done", { p_seq: 1 }]], "a mute voice phone still moves the phase on");
    rt.unmount();
  }

  console.log(`\n${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
