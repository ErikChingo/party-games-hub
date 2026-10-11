const ROOT = require("path").resolve(__dirname, "../..");
// Offline test of api/mafia-voice.js: Gemini is faked, the audio is the
// real sample the user generated in Google AI Studio.
const fs = require("fs");
const handler = require(ROOT + "/api/mafia-voice.js");
const sample = fs.readFileSync(__dirname + "/fixtures/voice-sample.wav");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ` (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

function call(query, method = "GET") {
  return new Promise((resolve) => {
    const res = { headers: {}, code: 0, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(o) { this.body = o; resolve(this); },
      send(b) { this.body = b; resolve(this); } };
    handler({ method, query }, res);
  });
}
const rms = (buf) => { let s = 0, n = 0; for (let i = 44; i + 1 < buf.length; i += 2) { const v = buf.readInt16LE(i) / 32768; if (Math.abs(v) > 0.01) { s += v * v; n++; } } return Math.sqrt(s / n); };
const peak = (buf) => { let m = 0; for (let i = 44; i + 1 < buf.length; i += 2) m = Math.max(m, Math.abs(buf.readInt16LE(i))); return m / 32768; };

(async () => {
  let requests = [];
  const fake = (make) => { global.fetch = async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return make(url); }; };
  const good = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

  delete process.env.GEMINI_API_KEY;
  let r = await call({ l: "ru", t: "Наступает ночь." });
  eq([r.code, r.headers["cache-control"]], [500, "no-store"], "no key -> 500, never cached");

  process.env.GEMINI_API_KEY = "test-key";
  r = await call({ l: "ru", t: "x" }, "POST"); eq(r.code, 405, "POST refused");
  r = await call({ l: "xx", t: "Наступает ночь." }); eq(r.code, 400, "unknown language refused");
  r = await call({ l: "ru", t: "" }); eq(r.code, 400, "empty text refused");
  r = await call({ l: "ru", t: "а".repeat(241) }); eq(r.code, 400, "over-long text refused");
  eq(requests.length, 0, "nothing reaches Gemini for refused requests");

  // Gemini 3.8: Interactions API, WAV in steps[].content[].data
  fake(() => good({ id: "i1", steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: sample.toString("base64") }] }] }));
  r = await call({ l: "ru", v: "1", t: "  Наступает ночь.   Город засыпает. " });
  eq(r.code, 200, "interactions: ok");
  eq(r.headers["content-type"], "audio/wav", "answers with audio/wav");
  ok(/immutable/.test(r.headers["cache-control"]) && /s-maxage=31536000/.test(r.headers["cache-control"]), "cached for a year by phone and CDN");
  const q = requests[0];
  eq(q.url, "https://generativelanguage.googleapis.com/v1beta/interactions", "interactions endpoint");
  eq(q.init.headers["x-goog-api-key"], "test-key", "key goes in a header, not in the address");
  eq(q.body.model, "gemini-3.8-flash-tts", "default model");
  eq(q.body.input[0].content[0].text, "Наступает ночь. Город засыпает.", "text is trimmed and sent verbatim");
  ok(q.body.input[0].content[0].annotations[0].type === "speech_metadata" && /velvety/.test(q.body.input[0].content[0].annotations[0].style), "the user's style goes as speech metadata, not into the text");
  eq(q.body.generation_config.speech_config[0].voice, "Charon", "default voice");
  const out = r.body;
  ok(out.toString("ascii", 0, 4) === "RIFF" && out.readUInt32LE(24) === 24000 && out.readUInt16LE(22) === 1 && out.readUInt16LE(34) === 16, "output is 24 kHz mono 16-bit WAV");
  const secIn = (sample.length - 44) / 48000, secOut = (out.length - 44) / 48000;
  ok(secOut < secIn && secOut > secIn - 1.2, `edges trimmed, speech kept: ${secIn.toFixed(2)}s -> ${secOut.toFixed(2)}s`);
  // polish() aims at rms 0.16; this sample is already ~0.1, so expect a clear lift, not a fixed ratio
  ok(rms(out) > rms(sample) * 1.3 && rms(out) > 0.12, `louder: rms ${rms(sample).toFixed(3)} -> ${rms(out).toFixed(3)}`);
  ok(peak(out) <= 0.99, `no clipping: peak ${peak(out).toFixed(3)}`);
  fs.writeFileSync(require("path").join(require("os").tmpdir(), "hatsit_api_output_sample.wav"), out);

  // overrides from the environment
  process.env.GEMINI_TTS_VOICE = "Algenib"; process.env.GEMINI_TTS_STYLE = "calm";
  requests = [];
  r = await call({ l: "hy", t: "Գիշերը գալիս է։" });
  eq([requests[0].body.generation_config.speech_config[0].voice, requests[0].body.input[0].content[0].annotations[0].style], ["Algenib", "calm"], "voice and style can be changed in Vercel settings");

  // an older model: generateContent, bare PCM in inlineData
  process.env.GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";
  requests = [];
  fake(() => good({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: sample.subarray(44, 44 + sample.readUInt32LE(40)).toString("base64") } }] } }] }));
  r = await call({ l: "ru", t: "Наступает ночь." });
  eq(r.code, 200, "generateContent: ok");
  ok(requests[0].url.endsWith("/models/gemini-3.1-flash-tts-preview:generateContent"), "older models use generateContent");
  ok(requests[0].body.contents[0].parts[0].text.includes("# Director's note\nStyle: calm") && requests[0].body.contents[0].parts[0].text.endsWith("## Transcript:\nНаступает ночь."), "prompt is laid out the way AI Studio does it");
  eq(requests[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Algenib", "voice in the older format");
  ok(Math.abs(r.body.length - out.length) < 2000, "bare PCM gives the same audio as the WAV");
  delete process.env.GEMINI_TTS_MODEL;

  // failures: never cached, quota passed on as 429, details only with diag=1
  fake(() => ({ ok: false, status: 429, text: async () => '{"error":{"message":"quota exceeded"}}' }));
  r = await call({ l: "ru", t: "Наступает ночь." });
  eq([r.code, r.headers["cache-control"], r.body.detail], [429, "no-store", undefined], "quota -> 429, not cached, no details by default");
  r = await call({ l: "ru", t: "Наступает ночь.", diag: "1" });
  ok(r.code === 429 && /quota exceeded/.test(r.body.detail), "diag=1 shows what Google answered");
  ok(!JSON.stringify(r.body).includes("test-key"), "the key never appears in an answer");
  fake(() => ({ ok: false, status: 400, text: async () => "bad model" }));
  r = await call({ l: "ru", t: "Наступает ночь." }); eq(r.code, 502, "other Google errors -> 502");
  fake(() => good({ steps: [] }));
  r = await call({ l: "ru", t: "Наступает ночь." }); eq([r.code, r.body.error], [502, "empty audio"], "no audio in the answer -> 502");
  global.fetch = async () => { throw new Error("network down"); };
  r = await call({ l: "ru", t: "Наступает ночь." }); eq(r.code, 502, "network failure -> 502");

  console.log(`${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
