const ROOT = require("path").resolve(__dirname, "../..");
// Offline test of the permanent store in api/mafia-voice.js (Supabase Storage faked).
const fs = require("fs");
const handler = require(ROOT + "/api/mafia-voice.js");
const { storePath } = handler._internals;
const sample = fs.readFileSync(__dirname + "/fixtures/voice-sample.wav");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
function call(query) {
  return new Promise((resolve) => {
    const res = { headers: {}, code: 0, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; resolve(this); }, send(b) { this.body = b; resolve(this); } };
    handler({ method: "GET", query }, res);
  });
}
const BASE = "https://zocoaqqcrxpbkyzlfzsf.supabase.co/storage/v1/object/";
let gemini = [], reads = [], writes = [], files = {}, writeStatus = 200, readThrows = false, geminiStatus = 200;
global.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith(BASE + "public/mafia-voice/")) {
    reads.push(url);
    if (readThrows) throw new Error("timeout");
    const file = files[url.slice((BASE + "public/mafia-voice/").length)];
    return file ? { ok: true, status: 200, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.length) } : { ok: false, status: 400, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  if (url.startsWith(BASE + "mafia-voice/")) {
    writes.push({ url, init });
    if (writeStatus === 200) files[url.slice((BASE + "mafia-voice/").length)] = Buffer.from(init.body);
    return { ok: writeStatus === 200, status: writeStatus };
  }
  gemini.push(url);
  if (geminiStatus !== 200) return { ok: false, status: geminiStatus, text: async () => "quota" };
  return { ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ content: [{ type: "audio", data: sample.toString("base64") }] }] }) };
};
const reset = () => { gemini = []; reads = []; writes = []; };

(async () => {
  process.env.GEMINI_API_KEY = "k";
  delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_SECRET_KEY; delete process.env.SUPABASE_URL;

  // no store key: works as before
  let r = await call({ l: "ru", v: "1", t: "Наступает ночь." });
  eq([r.code, r.headers["x-voice-store"], gemini.length, writes.length], [200, "off", 1, 0], "no key: audio from Gemini, nothing written");
  eq(reads.length, 1, "the store is still looked at first (reading needs no key)");

  // with key: first time generated and saved
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key"; reset();
  r = await call({ l: "ru", v: "1", t: "  Наступает   ночь. " });
  eq([r.code, r.headers["x-voice-store"], gemini.length, writes.length], [200, "saved", 1, 1], "first request: generated once and saved");
  const w = writes[0];
  ok(/^https:\/\/zocoaqqcrxpbkyzlfzsf\.supabase\.co\/storage\/v1\/object\/mafia-voice\/v1\/ru\/[0-9a-f]{40}\.wav$/.test(w.url), "saved under v1/ru/<hash>.wav: " + w.url);
  eq([w.init.method, w.init.headers.Authorization, w.init.headers.apikey, w.init.headers["Content-Type"], w.init.headers["x-upsert"]], ["POST", "Bearer service-key", "service-key", "audio/wav", "true"], "upload request is authorised and typed");
  ok(Buffer.compare(Buffer.from(w.init.body), r.body) === 0, "what is saved is exactly what was sent to the phone");
  ok(!w.url.includes("service-key") && !JSON.stringify(r.headers).includes("service-key"), "the key never appears in an address or an answer");

  // second time: from the store, Gemini untouched
  reset();
  const first = r.body;
  r = await call({ l: "ru", v: "1", t: "Наступает ночь." });
  eq([r.code, r.headers["x-voice-store"], gemini.length, writes.length], [200, "hit", 0, 0], "second request: from the store, Gemini not asked");
  ok(Buffer.compare(r.body, first) === 0 && r.headers["content-type"] === "audio/wav" && /immutable/.test(r.headers["cache-control"]), "same audio, same caching");

  // stored sentences keep working when the quota is gone
  reset(); geminiStatus = 429;
  r = await call({ l: "ru", v: "1", t: "Наступает ночь." });
  eq([r.code, gemini.length], [200, 0], "quota exhausted: stored sentence still plays");
  r = await call({ l: "ru", v: "1", t: "Совсем новая фраза." });
  eq([r.code, r.headers["cache-control"], writes.length], [429, "no-store", 0], "quota exhausted: a new sentence is a 429, not cached, not saved");
  geminiStatus = 200;

  // different sentence / language / version -> different files
  reset();
  await call({ l: "ru", v: "1", t: "Город засыпает." });
  await call({ l: "en", v: "1", t: "Наступает ночь." });
  await call({ l: "ru", v: "2", t: "Наступает ночь." });
  eq([gemini.length, new Set(writes.map((x) => x.url)).size], [3, 3], "another sentence, language or version is recorded separately");
  ok(writes[2].url.includes("/v2/ru/") && writes[1].url.includes("/v1/en/"), "version and language are in the path");
  const base = { version: "1", lang: "ru", model: "m", voice: "Charon", style: "s", text: "x" };
  ok(storePath(base) === storePath({ ...base }) && storePath(base) !== storePath({ ...base, voice: "Kore" }) && storePath(base) !== storePath({ ...base, style: "t" }) && storePath(base) !== storePath({ ...base, model: "n" }), "changing voice, style or model makes a new recording");
  ok(/^v1\/ru\/[0-9a-f]{40}\.wav$/.test(storePath({ ...base, version: "../../x" }).replace(/^vx/, "v1")) && !storePath({ ...base, version: "../../etc" }).includes(".."), "a strange version cannot escape the folder");

  // store trouble never costs the player the phrase
  reset(); writeStatus = 500;
  r = await call({ l: "ru", v: "1", t: "Фраза при сбое записи." });
  eq([r.code, r.headers["x-voice-store"], r.headers["content-type"]], [200, "error", "audio/wav"], "store refuses the upload: audio still delivered");
  writeStatus = 200; reset(); readThrows = true;
  r = await call({ l: "ru", v: "1", t: "Наступает ночь." });
  eq([r.code, gemini.length], [200, 1], "store unreachable: falls back to Gemini");
  readThrows = false;
  files["v1/ru/" + "0".repeat(40) + ".wav"] = Buffer.from("<html>not audio</html>".repeat(100));
  const junkKey = Object.keys(files).find((k) => k.includes("0".repeat(40)));
  reset(); const realKey = storePath({ version: "1", lang: "ru", model: "gemini-3.8-flash-tts", voice: "Charon", style: "Rich, velvety, unhurried audiobook narration setting an atmospheric evening scene.", text: "Мусор в хранилище." });
  files[realKey] = files[junkKey];
  r = await call({ l: "ru", v: "1", t: "Мусор в хранилище." });
  eq([r.code, gemini.length, r.body.toString("ascii", 0, 4)], [200, 1, "RIFF"], "a stored file that is not audio is ignored and re-recorded");

  // SUPABASE_URL from the integration is honoured
  process.env.SUPABASE_URL = "https://other.supabase.co/"; reset();
  let seen = [];
  const orig = global.fetch; global.fetch = async (url, init) => { seen.push(String(url)); return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "x" }; };
  await call({ l: "ru", v: "1", t: "Адрес из окружения." });
  ok(seen[0].startsWith("https://other.supabase.co/storage/v1/object/public/mafia-voice/"), "SUPABASE_URL from the environment is used: " + seen[0]);
  global.fetch = orig; delete process.env.SUPABASE_URL;

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
