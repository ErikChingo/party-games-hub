// The Mafia host's studio voice: turns one short host sentence into audio
// with Gemini text-to-speech.
//
//   GET /api/mafia-voice?l=ru&v=1&t=<sentence>      -> audio/wav
//   GET /api/mafia-voice?...&diag=1                 -> same, but errors carry
//                                                      the upstream detail
//
// Why GET: the answer for one sentence never changes, so it is sent with a
// year-long immutable Cache-Control and Vercel's CDN (and the phone) keep
// it. "Night falls. The city goes to sleep." is generated once, not once
// per game. Sentences with player names are generated when first asked for.
//
// The key is the same GEMINI_API_KEY the support chat uses (Vercel →
// Project → Settings → Environment Variables). Optional overrides, also
// there, no redeploy of code needed:
//   GEMINI_TTS_MODEL  model id            (default below)
//   GEMINI_TTS_VOICE  prebuilt voice name (default below)
//   GEMINI_TTS_STYLE  how to read it      (default below)
// After changing voice or style, bump MAFIA_VOICE_VERSION in index.html (or
// redeploy) so phones stop using the sentences they already cached.
//
// Every sentence is also kept for good in Supabase Storage (public bucket
// "mafia-voice"), because the CDN forgets everything on each new deploy and
// Gemini's quota is small: with the store a sentence is paid for once, ever.
// The store needs SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) in the
// environment -- the Supabase integration for Vercel adds it. Without the
// key the function works exactly as before, just without the store. The
// answer says what happened in the X-Voice-Store header: hit, saved, off
// or error.
//
// If anything here fails the phones fall back to their own built-in voice,
// so a missing key or an exhausted quota never stops a game.

const crypto = require("crypto");

const DEFAULT_MODEL = "gemini-3.8-flash-tts";
const DEFAULT_VOICE = "Charon";
const DEFAULT_STYLE = "Rich, velvety, unhurried audiobook narration setting an atmospheric evening scene.";

const MAX_TEXT_LENGTH = 240;
const LANGS = ["ru", "en", "hy"];
// Per warm instance; a cheap brake on someone hammering the endpoint. The
// CDN answers repeats of a sentence without ever reaching this code.
const MAX_GENERATIONS_PER_MINUTE = 60;

const SAMPLE_RATE = 24000;

const DEFAULT_SUPABASE_URL = "https://zocoaqqcrxpbkyzlfzsf.supabase.co";
const STORE_BUCKET = "mafia-voice";
const STORE_TIMEOUT_MS = 4000;

function storeSettings() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  return { url, key };
}

// One file per (version, language, model, voice, style, sentence): change
// any of them and a fresh recording is made instead of reusing the old one.
function storePath({ version, lang, model, voice, style, text }) {
  const hash = crypto.createHash("sha256").update([model, voice, style, text].join("\n")).digest("hex").slice(0, 40);
  const safeVersion = String(version || "1").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "1";
  return `v${safeVersion}/${lang}/${hash}.wav`;
}

// Reading needs no key: the bucket is public.
async function storeRead(path) {
  const { url } = storeSettings();
  try {
    const response = await fetch(`${url}/storage/v1/object/public/${STORE_BUCKET}/${path}`, { signal: AbortSignal.timeout(STORE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
    return buffer;
  } catch (e) {
    return null;
  }
}

async function storeWrite(path, wav) {
  const { url, key } = storeSettings();
  if (!key) return "off";
  try {
    const response = await fetch(`${url}/storage/v1/object/${STORE_BUCKET}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "audio/wav", "Cache-Control": "max-age=31536000", "x-upsert": "true" },
      body: wav,
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
    });
    return response.ok ? "saved" : "error";
  } catch (e) {
    return "error";
  }
}

function sendWav(res, wav, extra) {
  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Content-Length", String(wav.length));
  res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
  Object.keys(extra || {}).forEach((name) => res.setHeader(name, extra[name]));
  res.status(200).send(wav);
}

function fail(res, status, error, detail, diag) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(diag && detail ? { error, detail: String(detail).slice(0, 600) } : { error });
}

// Finds 16-bit mono PCM in whatever Gemini sent: a WAV file (RIFF header)
// or bare samples.
function toPcm16(buffer) {
  if (buffer.length > 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let sampleRate = SAMPLE_RATE;
    let channels = 1;
    let bits = 16;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString("ascii", offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (id === "fmt ") {
        channels = buffer.readUInt16LE(start + 2);
        sampleRate = buffer.readUInt32LE(start + 4);
        bits = buffer.readUInt16LE(start + 14);
      } else if (id === "data") {
        const end = Math.min(buffer.length, start + size);
        if (bits !== 16) return null;
        const frames = Math.floor((end - start) / (2 * channels));
        const samples = new Int16Array(frames);
        for (let i = 0; i < frames; i++) {
          let sum = 0;
          for (let c = 0; c < channels; c++) sum += buffer.readInt16LE(start + (i * channels + c) * 2);
          samples[i] = Math.round(sum / channels);
        }
        return { samples, sampleRate };
      }
      offset = start + size + (size % 2);
    }
    return null;
  }
  const frames = Math.floor(buffer.length / 2);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = buffer.readInt16LE(i * 2);
  return { samples, sampleRate: SAMPLE_RATE };
}

// Gemini's audio is quiet for a phone speaker in a noisy room and comes
// with silence around it. Trim the edges and bring it up to a steady level.
function polish(samples, sampleRate) {
  const threshold = 0.012 * 32768;
  let first = 0;
  let last = samples.length - 1;
  while (first < last && Math.abs(samples[first]) < threshold) first++;
  while (last > first && Math.abs(samples[last]) < threshold) last--;
  const pad = Math.round(sampleRate * 0.08);
  first = Math.max(0, first - pad);
  last = Math.min(samples.length - 1, last + Math.round(sampleRate * 0.22));
  const cut = samples.subarray(first, last + 1);

  let sumSquares = 0;
  let counted = 0;
  for (let i = 0; i < cut.length; i++) {
    const value = cut[i] / 32768;
    if (Math.abs(value) > 0.01) {
      sumSquares += value * value;
      counted++;
    }
  }
  const rms = counted > 0 ? Math.sqrt(sumSquares / counted) : 0;
  const gain = rms > 0 ? Math.min(6, Math.max(1, 0.16 / rms)) : 1;
  const out = new Int16Array(cut.length);
  for (let i = 0; i < cut.length; i++) {
    let value = (cut[i] / 32768) * gain;
    // Soft limiter: untouched below 0.7, gently squeezed above.
    const magnitude = Math.abs(value);
    if (magnitude > 0.7) value = Math.sign(value) * (0.7 + 0.28 * Math.tanh((magnitude - 0.7) / 0.28));
    out[i] = Math.max(-32767, Math.min(32767, Math.round(value * 32767)));
  }
  return out;
}

function toWav(samples, sampleRate) {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i++) body.writeInt16LE(samples[i], i * 2);
  return Buffer.concat([header, body]);
}

// Walks any JSON shape and returns the longest base64-looking "data"
// string -- the audio, wherever this API version happens to put it.
function findAudioBase64(node, best = "") {
  if (!node || typeof node !== "object") return best;
  if (Array.isArray(node)) {
    for (const item of node) best = findAudioBase64(item, best);
    return best;
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === "data" && typeof value === "string" && value.length > best.length) best = value;
    else if (value && typeof value === "object") best = findAudioBase64(value, best);
  }
  return best;
}

// Gemini 3.8 TTS: the Interactions API, style kept apart from the text.
async function generateWithInteractions({ apiKey, model, voice, style, text }) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  return response;
}

// Earlier TTS models: generateContent, style written above the text the way
// Google AI Studio does it.
async function generateWithGenerateContent({ apiKey, model, voice, style, text }) {
  const prompt = `Read the following transcript based on the director's note.\n\n# Director's note\nStyle: ${style}\n\n## Transcript:\n${text}`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  return response;
}

module.exports = async function handler(req, res) {
  const query = req.query || {};
  const diag = query.diag === "1";
  if (req.method !== "GET") return fail(res, 405, "method not allowed");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail(res, 500, "voice is not configured");

  const lang = LANGS.includes(query.l) ? query.l : null;
  const text = typeof query.t === "string" ? query.t.replace(/\s+/g, " ").trim() : "";
  if (!lang || !text || text.length > MAX_TEXT_LENGTH) return fail(res, 400, "bad request");

  const settings = {
    apiKey,
    model: process.env.GEMINI_TTS_MODEL || DEFAULT_MODEL,
    voice: process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE,
    style: process.env.GEMINI_TTS_STYLE || DEFAULT_STYLE,
    text,
  };

  // Already recorded once? Then Gemini is not asked at all.
  const path = storePath({ version: query.v, lang, ...settings });
  const stored = await storeRead(path);
  if (stored) return sendWav(res, stored, { "X-Voice-Store": "hit", "X-Voice-Model": settings.model, "X-Voice-Name": settings.voice });

  const now = Date.now();
  global.__hatsitVoiceLog = (global.__hatsitVoiceLog || []).filter((stamp) => now - stamp < 60000);
  if (global.__hatsitVoiceLog.length >= MAX_GENERATIONS_PER_MINUTE) return fail(res, 429, "too many requests");
  global.__hatsitVoiceLog.push(now);

  try {
    const started = Date.now();
    const useInteractions = /^gemini-3\.[89]|^gemini-[4-9]/.test(settings.model);
    const upstream = useInteractions ? await generateWithInteractions(settings) : await generateWithGenerateContent(settings);
    const raw = await upstream.text();
    if (!upstream.ok) {
      // 429 from Google = quota; pass it on so phones stop asking for a while.
      return fail(res, upstream.status === 429 ? 429 : 502, "voice generation failed", `${upstream.status} ${raw}`, diag);
    }
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return fail(res, 502, "voice generation failed", "not json: " + raw, diag);
    }
    const base64 = findAudioBase64(data);
    if (base64.length < 2000) return fail(res, 502, "empty audio", raw, diag);
    const pcm = toPcm16(Buffer.from(base64, "base64"));
    if (!pcm || pcm.samples.length < pcm.sampleRate * 0.2) return fail(res, 502, "unreadable audio", raw.slice(0, 300), diag);

    const wav = toWav(polish(pcm.samples, pcm.sampleRate), pcm.sampleRate);
    const voiceMs = Date.now() - started;
    // Saved before answering: a serverless function may be frozen the
    // moment the answer is sent.
    const storeResult = await storeWrite(path, wav);
    sendWav(res, wav, { "X-Voice-Ms": String(voiceMs), "X-Voice-Model": settings.model, "X-Voice-Name": settings.voice, "X-Voice-Store": storeResult });
  } catch (e) {
    fail(res, 502, "failed to reach gemini", e && e.message, diag);
  }
};

// Exposed for the offline tests only.
module.exports._internals = { toPcm16, polish, toWav, findAudioBase64, storePath };
