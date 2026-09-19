
Legend, Connected

















Support ticket · JS
// Serverless proxy for the Хатсит (Hatsit) support widget.
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
// — they can only fill in "problem" and "contact" text, which we place
// into a fixed, fixed-shape embed below.
//
// Deploy note: this file must be uploaded to the "api/support-ticket.js"
// path in the GitHub repo (same repo as index.html) — Vercel automatically
// turns any file under /api into a serverless function, no extra config
// needed for this project.
 
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
 
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    // Env var not set yet in the Vercel dashboard — fail loudly so this
    // is easy to notice while setting things up, instead of silently
    // swallowing every ticket.
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
 
  const problem = String(body.problem || "").trim().slice(0, 1000);
  const contact = String(body.contact || "").trim().slice(0, 200);
  const userAgent = String(body.userAgent || "").trim().slice(0, 500);
 
  if (!problem) {
    res.status(400).json({ error: "problem is required" });
    return;
  }
 
  // Best-effort throttle against casual spam/double-clicks: at most 10
  // tickets/minute per warm function instance. This resets whenever
  // Vercel spins up a fresh instance (cold start), so it's a deterrent,
  // not a hard guarantee — a real guarantee needs a shared store like
  // Vercel KV or Upstash, which is more setup than this app needs today.
  // Discord's own webhook rate limit (~30 requests/min) is the real
  // backstop behind this.
  const now = Date.now();
  global.__hatsitTicketLog = (global.__hatsitTicketLog || []).filter((t) => now - t < 60000);
  if (global.__hatsitTicketLog.length >= 10) {
    res.status(429).json({ error: "too many requests, try again in a minute" });
    return;
  }
  global.__hatsitTicketLog.push(now);
 
  const payload = {
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
}
 

This file type cannot be opened.

