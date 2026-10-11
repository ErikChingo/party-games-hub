const ROOT = require("path").resolve(__dirname, "../..");
// Static checks for the small fixes from the 6 Oct live playtest.
const fs = require("fs");
const src = fs.readFileSync(ROOT + "/index.html", "utf8");
let p = 0, f = 0;
const ok = (c, m) => { if (c) p++; else { f++; console.log("FAIL: " + m); } };
ok(/const onHub = useHatsitCurrentScreen\(\) === "hub";\s+if \(isInsideTelegram\(\) \|\| dismissed \|\| !onHub\) return null;/.test(src), "promo banner hidden outside the Hub");
ok(/hatsitScreenListeners\.add\(setScreen\);[\s\S]{0,400}setScreen\(hatsitCurrentScreen\);/.test(src), "screen subscribers catch up with a first screen that is not the Hub");
ok(/html\[data-feedback="1"\] \.support-fab\{ display:none; \}/.test(src), "chat button hidden while the rating card is up");
ok(src.includes('document.documentElement.setAttribute("data-feedback", feedbackShown ? "1" : "0")'), "App publishes that the rating card is up");
ok(src.includes('className="support-fab '), "chat button still carries the class the CSS targets");
ok(src.includes('className="telegram-promo-banner '), "banner still carries the class the CSS targets");
ok(/setTimeout\(\(\) => setArmed\(false\), 4000\)/.test(src), "confirm buttons stay armed for 4 s");
ok(!/onClick=\{\(\) => act\("mafia_host_warn"/.test(src) && (src.match(/onConfirm=\{\(\) => act\("mafia_host_warn"/g) || []).length === 1, "+1 warning always takes two taps");
ok(!/onClick=\{[^}]*act\("mafia_vote"/.test(src), "no button sends a vote on a single tap");
ok(/\(mine \? "text-3xl" : "text-4xl truncate"\)/.test(src), "own-turn title is smaller and not cut off");
for (const k of ["mroom.voiceHereSilent", "mroom.voteConfirm", "mroom.votePick", "mroom.voiceUnavailable"]) {
  const m = src.match(new RegExp('"' + k.replace(".", "\\.") + '": \\{ ru: "[^"]+", en: "[^"]+", hy: "[^"]+" \\}'));
  ok(!!m, "i18n key in 3 languages: " + k);
}
const sql = fs.readFileSync(ROOT + "/supabase/mafia_online.sql", "utf8");
ok(sql.includes("phase_min_until") && sql.includes("least(phase_deadline, greatest(now(), coalesce(phase_min_until, now())))"), "server file has the minimum phase time");
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
