// Serverless proxy for the Хатсит (Hatsit) AI support chat, backed by
// Google Gemini.
//
// Same reasoning as api/support-ticket.js: index.html is a static file
// that ships in full to every visitor's browser, so a real API key can
// never live there. The Gemini key lives ONLY in the GEMINI_API_KEY
// environment variable here (Vercel → Project → Settings → Environment
// Variables). The client only ever calls this endpoint.
//
// GEMINI_MODEL is optional (defaults below) — if Google ever renames or
// retires the default model, override it in that same Environment
// Variables screen without touching this file or redeploying code.

const DEFAULT_MODEL = "gemini-3.5-flash-lite";

// Everything the bot is allowed to "know" — kept short and grounded in
// what the app actually does, so it answers accurately instead of
// guessing at features that don't exist.
const SYSTEM_PROMPT = `Ты — бот-помощник платформы «Хатсит» (Hatsit) — сайта с играми для компании: Шпион, Алиас, Мафия (офлайн, по одному телефону, передаваемому по кругу) и Бункер, Суд (сетевые, каждый на своём телефоне, подключение по коду комнаты).

Факты о приложении, на которые можно опираться:
- Шпион: 3–8 игроков, 1+ шпионов не знают локацию и должны её вычислить по вопросам остальных, не выдав себя.
- Алиас: 2–4 команды по очереди объясняют друг другу слова на время.
- Мафия: 5–20 игроков, телефон работает как панель ведущего, подсказывающая очередность ночи и дня.
- Бункер: сетевая игра. Хост нажимает «Создать комнату» и получает код, остальные вводят его через «Войти по коду». Каждому выдаётся досье (профессия, здоровье, хобби, фобия, багаж), которое можно постепенно раскрывать за столом.
- Суд: сетевой процесс, минимум 4 участника, тоже по коду комнаты — роли, улики и голосование.
- Пригласить друга: в лобби Бункера и Суда есть кнопка «Поделиться ссылкой» — она отправляет прямую ссылку, по которой код комнаты подставляется автоматически, вводить его вручную не нужно.
- Установка на телефон: кнопка «Установить приложение» на главном экране (если браузер её предлагает), либо вручную через меню браузера — «Добавить на главный экран» в Chrome (Android), «Поделиться» → «На экран «Домой»» в Safari (iPhone).
- Полные правила каждой игры показаны прямо в приложении — на экране настройки игры (в Бункере и Суде — в лобби комнаты).

Правила общения: отвечай кратко (обычно 2–4 предложения), дружелюбно, только по темам этого приложения. Если вопрос не по теме, или ты не уверен в ответе, или речь о технической проблеме/баге — честно скажи, что не знаешь или не можешь помочь, и предложи нажать «Позвать человека / Сообщить о баге» в этом же окне. Никогда не выдумывай функции или правила, которых нет в списке выше.`;

// Appended to the system prompt so the bot answers in whichever UI
// language the visitor currently has selected, instead of always
// replying in Russian regardless of what they see on screen.
const LANG_INSTRUCTIONS = {
  ru: "Отвечай по-русски.",
  en: "Reply in English, even though the facts above are written in Russian.",
  hy: "Պատասխանիր հայերեն, նույնիսկ եթե վերևի փաստերը գրված են ռուսերեն։",
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "AI chat is not configured" });
    return;
  }
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  // Keep only the last 12 turns and clamp each message's length — this is
  // a small FAQ widget, not an open-ended chat, so there's no reason to
  // forward unbounded history or megabyte-sized messages to Gemini.
  const contents = rawMessages.slice(-12).map((m) => ({
    role: m && m.role === "model" ? "model" : "user",
    parts: [{ text: String((m && m.text) || "").slice(0, 2000) }],
  }));

  if (contents.length === 0) {
    res.status(400).json({ error: "messages is required" });
    return;
  }

  const lang = Object.prototype.hasOwnProperty.call(LANG_INSTRUCTIONS, body.lang) ? body.lang : "ru";
  const systemPrompt = SYSTEM_PROMPT + "\n\n" + LANG_INSTRUCTIONS[lang];

  // Best-effort throttle, same pattern and same caveats as
  // support-ticket.js: resets on cold start, deterrent rather than a
  // hard guarantee.
  const now = Date.now();
  global.__hatsitAiLog = (global.__hatsitAiLog || []).filter((t) => now - t < 60000);
  if (global.__hatsitAiLog.length >= 20) {
    res.status(429).json({ error: "too many requests, try again in a minute" });
    return;
  }
  global.__hatsitAiLog.push(now);

  try {
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
      }),
    });
    const data = await geminiRes.json().catch(() => null);
    if (!geminiRes.ok || !data) {
      res.status(502).json({ error: "gemini request failed" });
      return;
    }
    const text = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!text) {
      res.status(502).json({ error: "empty response from gemini" });
      return;
    }
    res.status(200).json({ text: text.trim() });
  } catch (e) {
    res.status(502).json({ error: "failed to reach gemini" });
  }
};
