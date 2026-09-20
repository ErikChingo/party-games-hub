// Serverless proxy for the Хатсит (Hatsit) support widget — and, as of
// the "type":"crash" branch below, for silent automatic crash reports too.
//
// Why this file exists: index.html is a static, single-file client app —
// anything written inside it ships to every visitor's browser and can be
// read with "View Source". A Discord webhook URL is a bearer secret:
// whoever has it can post anything into that channel. So the real webhook
// URL never appears in index.html — it lives ONLY in this function's
// environment variable, set in the Vercel dashboard (Project → Settings →
// Environment Variables → DISCORD_WEBHOOK_URL). The browser only ever
// talks to this endpoint, and this endpoint is the only thing that knows
// the real Discord URL.
//
// This also means an attacker poking at the client can no longer send
// Discord an arbitrary embed (e.g. an @everyone ping or a phishing link)
// — they can only fill in a small set of plain-text fields, which we place
// into one of two fixed, fixed-shape embeds below.
//
// Crash reports: index.html's crash overlay (see hatsitShowCrashOverlay)
// beacons here automatically, once per page load, whenever the app hits
// an uncaught error — no button press needed. This is the "how would we
// even find out" fix: before this, the only way a crash reached anyone
// was a user manually copying the on-screen report and sending it in.
// It's deliberately not full analytics (no tracking of normal usage, no
// third-party service) — just this same Discord channel, so bugs surface
// as soon as they happen instead of only when someone complains.
//
// Deploy note: this file must be uploaded to the "api/support-ticket.js"
// path in the GitHub repo (same repo as index.html) — Vercel automatically
// turns any file under /api into a serverless function, no extra config
// needed for this project.

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    // Env var not set yet in the Vercel dashboard — fail loudly so this
    // is easy to notice while setting things up, instead of silently
    // swallowing every ticket. A crash beacon's own fetch/sendBeacon call
    // is fire-and-forget on the client and ignores this response either
    // way, so this never surfaces as a second error to whoever crashed.
    res.status(500).json({ error: "support channel is not configured" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const isCrash = body.type === "crash";

  // Best-effort throttle against casual spam/double-clicks (and, for
  // crashes, a boot loop hammering this endpoint): at most 10
  // tickets+crashes combined per minute per warm function instance. This
  // resets whenever Vercel spins up a fresh instance (cold start), so
  // it's a deterrent, not a hard guarantee — a real guarantee needs a
  // shared store like Vercel KV or Upstash, which is more setup than this
  // app needs today. Discord's own webhook rate limit (~30 requests/min)
  // is the real backstop behind this. Sharing one bucket between manual
  // tickets and crash beacons is deliberate: either way the goal is
  // "don't overwhelm the same Discord channel."
  const now = Date.now();
  global.__hatsitTicketLog = (global.__hatsitTicketLog || []).filter((t) => now - t < 60000);
  if (global.__hatsitTicketLog.length >= 10) {
    res.status(429).json({ error: "too many requests, try again in a minute" });
    return;
  }
  global.__hatsitTicketLog.push(now);

  let payload;

  if (isCrash) {
    const message = String(body.message || "").trim().slice(0, 500) || "(без сообщения)";
    const stack = String(body.stack || "").trim().slice(0, 900);
    const screen = String(body.screen || "").trim().slice(0, 100) || "неизвестен";
    const userAgent = String(body.userAgent || "").trim().slice(0, 500) || "неизвестно";
    const online = body.online === false ? "нет" : "да";

    payload = {
      embeds: [
        {
          title: "💥 Автоматический отчёт о падении (Hatsit)",
          color: parseInt("e2585a", 16),
          fields: [
            { name: "Сообщение", value: message },
            { name: "Экран", value: screen, inline: true },
            { name: "Онлайн", value: online, inline: true },
            { name: "Stack", value: stack ? "```\n" + stack + "\n```" : "нет" },
            { name: "User Agent", value: userAgent },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };
  } else {
    const problem = String(body.problem || "").trim().slice(0, 1000);
    const contact = String(body.contact || "").trim().slice(0, 200);
    const userAgent = String(body.userAgent || "").trim().slice(0, 500);

    if (!problem) {
      res.status(400).json({ error: "problem is required" });
      return;
    }

    payload = {
      embeds: [
        {
          title: "🚨 Новое обращение в поддержку (Hatsit)",
          color: parseInt("a855f7", 16),
          fields: [
            { name: "Проблема", value: problem || "—" },
            { name: "Контакт", value: contact || "не указан" },
            { name: "User Agent", value: userAgent || "неизвестно" },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  try {
    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!discordRes.ok) {
      res.status(502).json({ error: "discord rejected the message" });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "failed to reach discord" });
  }
};
