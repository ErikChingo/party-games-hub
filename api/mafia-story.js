// The Mafia host's morning story: one short atmospheric sentence about what
// happened in the city at night, written by Gemini.
//
//   POST /api/mafia-story  { lang, victims: ["Name"], saved, missed, night }
//   -> { text }
//
// The game itself decides who died -- this only dresses the fact up. The
// answer is checked before it is trusted: it has to be short and has to
// name every victim exactly as given. Anything else is an error, and the
// phone then says the plain standard sentence instead, so a bad or slow
// answer can never change what the players are told.
//
// Uses the same GEMINI_API_KEY as the support chat. GEMINI_STORY_MODEL is
// optional (default below).

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const LANGS = ["ru", "en", "hy"];
const MAX_NAME_LENGTH = 24;
const MAX_STORY_LENGTH = 130;
const MAX_REQUESTS_PER_MINUTE = 40;
const UPSTREAM_TIMEOUT_MS = 6000;

const PROMPTS = {
  ru: {
    system:
      "Ты — ведущий настольной игры «Мафия». Напиши ОДНО короткое предложение (не длиннее 100 символов) — атмосферный утренний рассказ о том, что случилось этой ночью в городе. Спокойный тон загадочной истории, без крови и жестоких подробностей. Не называй ничьих ролей и не раскрывай, кто мафия. Имена игроков пиши в точности так, как они даны, не изменяя и не склоняя их, и не упоминай никаких других имён. Ответь только самим предложением, без кавычек.",
    died: (names) => `Этой ночью погибли: ${names.join(", ")}. Обязательно назови каждое имя.`,
    saved: "Этой ночью на одного жителя напали, но доктор успел его спасти. Никто не погиб. Имён не называй.",
    missed: "Этой ночью мафия не смогла договориться и никого не убила. Никто не погиб. Имён не называй.",
    quiet: "Эта ночь прошла спокойно, никто не погиб. Имён не называй.",
    night: (n) => `Это ночь номер ${n}.`,
  },
  en: {
    system:
      "You are the host of the party game Mafia. Write ONE short sentence (no longer than 100 characters): an atmospheric morning tale of what happened in the city last night. A calm mystery-story tone, no gore or cruel detail. Never mention anyone's role and never reveal who the mafia is. Write player names exactly as given and mention no other names. Answer with the sentence only, no quotation marks.",
    died: (names) => `Last night these players died: ${names.join(", ")}. You must mention every name.`,
    saved: "Last night someone was attacked, but the doctor saved them in time. Nobody died. Mention no names.",
    missed: "Last night the mafia could not agree and killed nobody. Nobody died. Mention no names.",
    quiet: "Last night was quiet, nobody died. Mention no names.",
    night: (n) => `This is night number ${n}.`,
  },
  hy: {
    system:
      "Դու «Մաֆիա» խաղի վարողն ես։ Գրիր ՄԵԿ կարճ նախադասություն (100 նիշից ոչ երկար)՝ մթնոլորտային առավոտյան պատմություն այն մասին, թե ինչ է կատարվել քաղաքում այս գիշեր։ Հանգիստ, խորհրդավոր տոն, առանց արյան և դաժան մանրամասների։ Ոչ մեկի դերը մի նշիր և մի բացահայտիր, թե ով է մաֆիան։ Խաղացողների անունները գրիր ճիշտ այնպես, ինչպես տրված են, առանց փոփոխելու, և ուրիշ անուններ մի հիշատակիր։ Պատասխանիր միայն նախադասությամբ, առանց չակերտների։",
    died: (names) => `Այս գիշեր զոհվել են՝ ${names.join(", ")}։ Պարտադիր նշիր յուրաքանչյուր անունը։`,
    saved: "Այս գիշեր բնակիչներից մեկի վրա հարձակվել են, բայց բժիշկը հասցրել է փրկել նրան։ Ոչ ոք չի զոհվել։ Անուններ մի նշիր։",
    missed: "Այս գիշեր մաֆիան չկարողացավ պայմանավորվել և ոչ ոքի չսպանեց։ Ոչ ոք չի զոհվել։ Անուններ մի նշիր։",
    quiet: "Այս գիշերն անցավ հանգիստ, ոչ ոք չի զոհվել։ Անուններ մի նշիր։",
    night: (n) => `Սա ${n}-րդ գիշերն է։`,
  },
};

function fail(res, status, error) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error });
}

// Keeps a player's name from carrying instructions into the prompt.
function cleanName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F"'`<>{}\[\]\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function tidy(text) {
  return String(text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s"'«»“”„]+|[\s"'«»“”„]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method not allowed");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fail(res, 500, "stories are not configured");

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};
  const lang = LANGS.includes(body.lang) ? body.lang : null;
  if (!lang) return fail(res, 400, "bad request");
  const victims = (Array.isArray(body.victims) ? body.victims : []).slice(0, 3).map(cleanName).filter(Boolean);
  const night = Math.max(1, Math.min(99, parseInt(body.night, 10) || 1));

  const now = Date.now();
  global.__hatsitStoryLog = (global.__hatsitStoryLog || []).filter((stamp) => now - stamp < 60000);
  if (global.__hatsitStoryLog.length >= MAX_REQUESTS_PER_MINUTE) return fail(res, 429, "too many requests");
  global.__hatsitStoryLog.push(now);

  const words = PROMPTS[lang];
  const facts = victims.length > 0 ? words.died(victims) : body.saved ? words.saved : body.missed ? words.missed : words.quiet;
  const model = process.env.GEMINI_STORY_MODEL || DEFAULT_MODEL;

  try {
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      // Gemini now and then hangs on a request. The phone gives up after
      // 7 seconds anyway, so stop waiting here too instead of running into
      // the function's time limit.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${words.night(night)} ${facts}` }] }],
        systemInstruction: { parts: [{ text: words.system }] },
        generationConfig: { maxOutputTokens: 120, temperature: 1.0 },
      }),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok || !data) return fail(res, upstream.status === 429 ? 429 : 502, "story generation failed");
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    const text = tidy(parts && parts[0] && parts[0].text);
    if (text.length < 12 || text.length > MAX_STORY_LENGTH) return fail(res, 502, "unusable story");
    const lower = text.toLocaleLowerCase();
    if (!victims.every((name) => lower.includes(name.toLocaleLowerCase()))) return fail(res, 502, "unusable story");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ text });
  } catch (e) {
    fail(res, e && e.name === "TimeoutError" ? 504 : 502, e && e.name === "TimeoutError" ? "story took too long" : "failed to reach gemini");
  }
};

module.exports._internals = { cleanName, tidy, PROMPTS };
