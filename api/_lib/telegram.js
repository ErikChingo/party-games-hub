// Messages from @hatsit_games_bot: checking who is asking (Telegram's
// signed initData), sending a message with a button that opens the Mini App,
// and the texts. Used by api/notify.js and api/cards.js.
//
// Needs TELEGRAM_BOT_TOKEN in Vercel (from @BotFather). Without it nothing is
// sent and nothing breaks.

const crypto = require("crypto");

const SITE = "https://hatsit.org";
const token = () => process.env.TELEGRAM_BOT_TOKEN || "";

// Telegram's check for Mini App data: HMAC-SHA256 with a key derived from the
// bot token. Returns the user ({ id, language_code, first_name, ... }) or null.
function verifyInitData(initData, maxAgeSeconds = 7 * 24 * 3600) {
  const bot = token();
  if (!bot || typeof initData !== "string" || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = Array.from(params.entries())
    .map(([k, v]) => k + "=" + v)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(bot).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (expected.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && Number.isSafeInteger(user.id) ? user : null;
  } catch (e) {
    return null;
  }
}

// { ok } or { ok: false, blocked: true } when the person blocked the bot.
async function sendMessage(chatId, text, button) {
  const bot = token();
  if (!bot) return { ok: false };
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (button) body.reply_markup = { inline_keyboard: [[{ text: button.text, web_app: { url: button.url } }]] };
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, blocked: res.status === 403 };
  } catch (e) {
    return { ok: false };
  }
}

// The daily tasks, in the same order as DAILY_TASKS in index.html (a test
// checks): the same date gives the same task on the site and in the reminder.
const DAILY_ORDER = ["nardy_play", "durak_win", "blot_play", "two_games", "nardy_win", "durak_play", "blackjack_play", "blot_win"];
const DAILY_GAME = { nardy_play: "nardy", durak_win: "durak", blot_play: "blot", two_games: null, nardy_win: "nardy", durak_play: "durak", blackjack_play: "blackjack", blot_win: "blot" };
function dailyTaskFor(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  const n = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  return DAILY_ORDER[((n % DAILY_ORDER.length) + DAILY_ORDER.length) % DAILY_ORDER.length];
}
// Today in Yerevan (UTC+4), where the reminder goes out at 19:00.
const yerevanToday = (now = Date.now()) => new Date(now + 4 * 3600 * 1000).toISOString().slice(0, 10);

const TEXT = {
  ru: {
    task: {
      nardy_play: "Сыграйте партию в нарды", nardy_win: "Выиграйте партию в нарды — хотя бы у бота",
      durak_play: "Сыграйте партию в дурака", durak_win: "Сыграйте в дурака и не останьтесь дураком",
      blot_play: "Доиграйте партию в блот", blot_win: "Выиграйте партию в блот",
      blackjack_play: "Сыграйте раздачу в блэкджек", two_games: "Сыграйте в две разные игры",
    },
    daily: "🎯 Задание дня: {task}.",
    streak: "🔥 Серия {n} дн. — не прервите её сегодня!",
    play: "Играть",
    games: { nardy: "нарды", durak: "дурака", blot: "блот", blackjack: "блэкджек", mafia: "мафию", bunker: "Бункер", court: "Суд" },
    // «в нардах» (where): for «Ваш ход в …».
    gamesIn: { nardy: "нардах", durak: "дураке", blot: "блоте", blackjack: "блэкджеке" },
    room: "🎲 {name} ждёт игроков в {game} — заходите!",
    someone: "Кто-то",
    join: "Войти в комнату",
    turn: "⏰ Ваш ход в {game}! Соперник уже сходил.",
    back: "Вернуться в игру",
    welcome: "🔔 Готово! Буду напоминать о задании дня и звать, когда кто-то ждёт соперника. Отключить можно в настройках Хатсита.",
  },
  en: {
    task: {
      nardy_play: "Play a game of nardy", nardy_win: "Win a game of nardy — a bot counts",
      durak_play: "Play a game of durak", durak_win: "Play durak and don’t be the fool",
      blot_play: "Finish a game of blot", blot_win: "Win a game of blot",
      blackjack_play: "Play a round of blackjack", two_games: "Play two different games",
    },
    daily: "🎯 Daily task: {task}.",
    streak: "🔥 A {n}-day streak — keep it going today!",
    play: "Play",
    games: { nardy: "nardy", durak: "durak", blot: "blot", blackjack: "blackjack", mafia: "Mafia", bunker: "Bunker", court: "Court" },
    gamesIn: { nardy: "nardy", durak: "durak", blot: "blot", blackjack: "blackjack" },
    room: "🎲 {name} is waiting for players in {game} — join in!",
    someone: "Someone",
    join: "Join the room",
    turn: "⏰ Your turn in {game}! Your opponent has moved.",
    back: "Back to the game",
    welcome: "🔔 Done! I’ll remind you of the daily task and call you when someone is waiting for an opponent. You can turn this off in Hatsit’s settings.",
  },
  hy: {
    task: {
      nardy_play: "Խաղացեք նարդու մեկ պարտիա", nardy_win: "Հաղթեք նարդու պարտիա՝ թեկուզ բոտի դեմ",
      durak_play: "Խաղացեք դուրակի մեկ պարտիա", durak_win: "Խաղացեք դուրակ և մի մնացեք դուրակ",
      blot_play: "Ավարտեք բլոտի մեկ պարտիա", blot_win: "Հաղթեք բլոտի մեկ պարտիա",
      blackjack_play: "Խաղացեք բլեքջեքի մեկ բաժանում", two_games: "Խաղացեք երկու տարբեր խաղ",
    },
    daily: "🎯 Օրվա առաջադրանք՝ {task}։",
    streak: "🔥 {n} օր անընդմեջ — մի ընդհատեք այսօր։",
    play: "Խաղալ",
    games: { nardy: "նարդի", durak: "դուրակ", blot: "բլոտ", blackjack: "բլեքջեք", mafia: "մաֆիա", bunker: "Բունկեր", court: "Դատարան" },
    gamesIn: { nardy: "նարդիում", durak: "դուրակում", blot: "բլոտում", blackjack: "բլեքջեքում" },
    room: "🎲 {name}-ը սպասում է խաղացողների՝ {game} — միացեք։",
    someone: "Ինչ-որ մեկը",
    join: "Մտնել սենյակ",
    turn: "⏰ Ձեր քայլն է {game}։ Մրցակիցն արդեն քայլել է։",
    back: "Վերադառնալ խաղին",
    welcome: "🔔 Պատրաստ է։ Կհիշեցնեմ օրվա առաջադրանքի մասին և կկանչեմ, երբ ինչ-որ մեկը մրցակից սպասի։ Անջատել կարելի է Հաթսիթի կարգավորումներում։",
  },
};
const textFor = (lang) => TEXT[lang] || TEXT.ru;

// The Mini App address that opens a room (the same shape as invite links).
// Open rooms list Mafia as "mafia"; its screen and invite key is "mafiaroom".
function roomUrl(game, code) {
  return `${SITE}/?room=${encodeURIComponent(code)}&game=${game === "mafia" ? "mafiaroom" : game}`;
}

module.exports = { SITE, verifyInitData, sendMessage, dailyTaskFor, DAILY_ORDER, DAILY_GAME, yerevanToday, TEXT, textFor, roomUrl };
