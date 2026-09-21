// Serverless function for the Discord bot's /join command.
//
// Same style/reasoning as api/ai-chat.js and api/support-ticket.js in this
// project: a plain Vercel Node.js function (CommonJS, module.exports), not
// a Next.js route — this repo doesn't use Next.js, so app/api/.../route.js
// or pages/api/*.js would NOT be picked up here. This file goes straight
// into the existing api/ folder, next to ai-chat.js.
//
// GET /api/discord-verify?code=482913&userId=123456789012345678
// Called only by the Discord bot (see its DISCORD_BOT_API_SECRET), never
// the browser.
//
// NOTE on the response shape: this returns a table NAME, not a channel ID.
// The bot creates a fresh voice channel per code on demand (named after
// this tableName) instead of granting access to a pre-made fixed channel —
// that's what lets it coexist cleanly with VoiceMaster's own "create on
// demand, delete when empty" channels, just in a separate category. This
// endpoint doesn't need to know about Discord channel IDs at all.
//
// ⚠️ Mock data below — two things to fix before this is real:
//
// 1. IN-MEMORY STORAGE DOES NOT WORK ON VERCEL. Serverless functions don't
//    run as one long-lived process — each call can land on a different
//    execution environment, and a "warm" one still gets recycled without
//    notice. The MOCK_TABLES_DB object below resets constantly and is
//    never shared across concurrent calls, so "mark this code as used"
//    logic written against it will look like it works in manual testing
//    and then fail for real. Swap it for Vercel KV / Upstash Redis (fast
//    key lookup + built-in expiry — a good fit here) or your existing
//    database before relying on single-use or expiring codes.
//
// 2. This endpoint hands out voice-channel access from a short code with
//    no login step, so it's worth keeping it behind the shared-secret
//    header below (must match the bot's DISCORD_BOT_API_SECRET) — otherwise
//    it's brute-forceable by anyone who finds the URL.
const MOCK_TABLES_DB = {
  "482913": { tableName: "Бункер — стол 1" },
  "119284": { tableName: "Мафия — стол 2" },
  "700501": { tableName: "Алиас — стол 3" },
};

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const secret = req.headers["x-hatsit-bot-secret"];
  if (!process.env.DISCORD_BOT_API_SECRET || secret !== process.env.DISCORD_BOT_API_SECRET) {
    res.status(401).json({ success: false, error: "unauthorized" });
    return;
  }

  const code = String(req.query.code || "").trim();
  const userId = String(req.query.userId || "").trim();

  if (!code || !userId) {
    res.status(400).json({ success: false, error: "code and userId are required" });
    return;
  }

  const table = MOCK_TABLES_DB[code];
  if (!table) {
    res.status(200).json({ success: false, error: "invalid or expired code" });
    return;
  }

  // TODO (once this is backed by a real store): mark `code` as consumed by
  // `userId` here, and reject it on a second attempt — codes should be
  // single-use. Also worth stamping an expiry (e.g. 10 minutes) when the
  // site first issues the code.

  res.status(200).json({ success: true, tableName: table.tableName });
};
