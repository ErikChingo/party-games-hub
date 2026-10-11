const ROOT = require("path").resolve(__dirname, "../..");
// Bunker and Court fixes from the 7 Oct playtest.
const fs = require("fs");
const path = __dirname + "/test_mafia_room_client.js";
const head = fs.readFileSync(path, "utf8").split("// ---------- views shaped")[0]
  .replace('const names = [', 'const names = ["COURT_EVIDENCE_BY_ROLE", "COURT_EVIDENCE_JUROR", "dealBunkerDossiers", "resolveBunkerVote", "assignCourtRound", "BUNKER_TRAIT_DEFS", "COURT_CASES", "CourtDossierTab", "CourtTableTab", "BunkerVotingCard", "BunkerDossierTab", "ConnStatusBanner", "BunkerGame", "CourtGame", ');
const m = { exports: {} };
new Function("require", "module", "__dirname", head + "\nmodule.exports = { load, React, RDS, makeRuntime: typeof makeRuntime === 'function' ? makeRuntime : null };")(require, m, __dirname);
const { load, React, RDS } = m.exports;
let p = 0, f = 0;
const ok = (c, msg) => { if (c) p++; else { f++; console.log("FAIL: " + msg); } };
const src = fs.readFileSync(ROOT + "/index.html", "utf8");
const { C, ls } = load({ react: React, local: { hatsitSettings: JSON.stringify({ language: "ru" }) } });
const html = (el) => RDS.renderToStaticMarkup(el);

/* ---- Bunker: dossiers ---- */
const ids = ["a", "b", "c", "d", "e", "f"];
for (let run = 0; run < 30; run++) {
  const d = C.dealBunkerDossiers(ids);
  for (const trait of C.BUNKER_TRAIT_DEFS) {
    const vals = ids.map((id) => d[id][trait.key].valueIndex);
    const uniq = new Set(vals).size;
    if (uniq !== Math.min(ids.length, trait.list.ru.length)) { ok(false, "duplicate " + trait.key + " in one deal"); run = 99; break; }
  }
}
ok(true, "no duplicate traits across 30 deals");
const d1 = C.dealBunkerDossiers(ids);
ok(ids.every((id) => C.BUNKER_TRAIT_DEFS.every((t) => d1[id][t.key].revealed === false && Number.isInteger(d1[id][t.key].valueIndex))), "every player gets every trait, hidden");

/* ---- Bunker: vote ---- */
const mk = (n, capacity, votes, excludeCount = 1, exiled = []) => ({ capacity, voting: { round: 1, excludeCount, votes },
  players: Object.fromEntries(ids.slice(0, n).map((id) => [id, { name: id, exiled: exiled.includes(id) }])) });
let r = C.resolveBunkerVote(mk(3, 2, { a: "b", b: "c", c: "a" }));
ok(r.tie === true && r.exiled.length === 0, "1:1:1 tie exiles nobody (was: everybody)");
r = C.resolveBunkerVote(mk(3, 2, { a: "b", c: "b", b: "a" }));
ok(r.tie === false && r.exiled.join() === "b", "2:1 exiles the leader");
r = C.resolveBunkerVote(mk(3, 2, { a: "b", c: "b", b: "a" }, 2));
ok(r.exiled.length === 1, "never exiles below the bunker's capacity");
r = C.resolveBunkerVote(mk(6, 2, { a: "b", c: "b", d: "b", b: "c", e: "c", f: "d" , }, 2));
ok(r.exiled.join() === "b,c" && !r.tie, "two clear leaders are both exiled");
r = C.resolveBunkerVote(mk(6, 2, { a: "b", c: "b", d: "b", b: "c", e: "d" }, 2));
ok(r.tie && r.exiled.join() === "b", "tie for the last place: only the clear leader goes");
r = C.resolveBunkerVote(mk(4, 2, { a: "b", b: "a", c: "b", d: "b" }, 1, ["d"]));
ok(r.tally.b === 2 && r.exiled.join() === "b", "votes of exiled players are not counted");
r = C.resolveBunkerVote(mk(4, 2, { a: "d", b: "d", c: "a" }, 1, ["d"]));
ok(!r.tally.d && r.exiled.join() === "a", "votes against exiled players are not counted");
r = C.resolveBunkerVote(mk(3, 2, {}));
ok(r.exiled.length === 0 && !r.tie, "no votes: nobody exiled");
r = C.resolveBunkerVote(mk(2, 2, { a: "b" }));
ok(r.exiled.length === 0, "bunker already fits everyone: nobody exiled");

/* ---- Court: roles ---- */
const roles = (n) => { const pl = Object.fromEntries(ids.concat(["g", "h"]).slice(0, n).map((id) => [id, { name: id }])); const out = C.assignCourtRound(pl, "a"); return Object.values(out.players).map((x) => x.role).sort().join(","); };
ok(roles(4) === "guilty,judge,juror,victim", "4 players: a juror, no secretary -> " + roles(4));
ok(roles(5) === "guilty,judge,juror,secretary,victim", "5 players: secretary appears -> " + roles(5));
ok(roles(8) === "guilty,judge,juror,juror,juror,juror,secretary,victim", "8 players: 4 jurors -> " + roles(8));
let judgeOk = true; for (let i = 0; i < 20; i++) { const out = C.assignCourtRound({ a: {}, b: {}, c: {}, d: {} }, "c"); if (out.players.c.role !== "judge") judgeOk = false; }
ok(judgeOk, "host is always the judge");

/* ---- Court: screens ---- */
const four = C.assignCourtRound({ a: { name: "Аня" }, b: { name: "Боря" }, c: { name: "Вика" }, d: { name: "Гоша" } }, "a");
const room4 = { caseIndex: 0, players: four.players, history: [] };
const noop = () => {};
const order4 = ["a", "b", "c", "d"];
let h = html(React.createElement(C.CourtTableTab, { room: room4, players: four.players, orderedIds: order4, playerId: "a", onVote: noop, onTally: noop, onVerdict: noop, onNewCase: noop, onStartVoteTimer: noop, onStopVoteTimer: noop }));
ok(!h.includes("Итог Секретаря") && !h.includes("Секретарь ещё не отправил"), "judge at a table of 4 is not told to wait for a secretary");
ok(h.includes("Вынести") || /textarea/.test(h), "judge at a table of 4 can still rule");
const five = C.assignCourtRound({ a: { name: "Аня" }, b: { name: "Боря" }, c: { name: "Вика" }, d: { name: "Гоша" }, e: { name: "Даша" } }, "a");
h = html(React.createElement(C.CourtTableTab, { room: { caseIndex: 0, players: five.players, history: [] }, players: five.players, orderedIds: order4.concat("e"), playerId: "a", onVote: noop, onTally: noop, onVerdict: noop, onNewCase: noop, onStartVoteTimer: noop, onStopVoteTimer: noop }));
ok(h.includes("Итог Секретаря") && h.includes("Секретарь ещё не отправил"), "with 5 players the judge still sees the secretary's block");
const guiltyId = order4.find((id) => four.players[id].role === "guilty");
h = html(React.createElement(C.CourtDossierTab, { me: four.players[guiltyId], room: room4, onReveal: noop }));
const caseTitle = C.COURT_CASES[0].title.ru;
ok(h.includes("Обвиняемый") && !h.includes("Виновный"), "role is called «Обвиняемый»");
ok(h.includes(caseTitle.replace(/"/g, "&quot;")) || h.includes(caseTitle), "own-evidence tab names the case");
ok(h.includes("Общий стол"), "own-evidence tab points to the shared table");

/* ---- Bunker: screens ---- */
const bp = { a: { name: "Аня", exiled: false, dossier: d1.a }, b: { name: "Боря", exiled: false, dossier: d1.b }, c: { name: "Вика", exiled: true, dossier: d1.c } };
const broom = { capacity: 2, catastropheIndex: 0, players: bp, voting: null, history: [] };
h = html(React.createElement(C.BunkerVotingCard, { room: broom, players: bp, orderedIds: ["a", "b", "c"], playerId: "a", isHost: true, onOpenVoting: noop, onCastVote: noop, onCloseVoting: noop, onRestart: noop }));
ok(h.includes("Аня, Боря") && h.includes("Вика"), "final card names who is in and who is out");
ok(/<button/.test(h), "host gets a button to start again");
h = html(React.createElement(C.BunkerVotingCard, { room: broom, players: bp, orderedIds: ["a", "b", "c"], playerId: "b", isHost: false, onOpenVoting: noop, onCastVote: noop, onCloseVoting: noop, onRestart: noop }));
ok(h.includes("Аня, Боря") && !/<button/.test(h), "guests see the ending without the restart button");
let crashed = null;
try { h = html(React.createElement(C.BunkerDossierTab, { me: bp.a, room: broom, playersCount: 3, onReveal: noop })); } catch (e) { crashed = e; }
ok(!crashed, "own dossier renders" + (crashed ? ": " + crashed.message : ""));
ok(!crashed && !/class="[^"]*truncate[^"]*"[^>]*>[^<]{25,}/.test(h), "long own values are not cut off");

/* ---- host left ---- */
h = html(React.createElement(C.ConnStatusBanner, { status: "host_left" }));
ok(h.includes("Хост вышел из комнаты"), "guests are told the host left");
ok(html(React.createElement(C.ConnStatusBanner, { status: "connected" })) === "", "no banner while connected");
ok(/event: gameKey \+ "_host_left"/.test(src) && /addEventListener\("pagehide", announceHostLeft\)/.test(src), "host announces leaving on unmount and page close");
ok(/setTab\("table"\)/.test(src) && /casesDone > seen\.casesDone\) setTab\("evidence"\)/.test(src), "tabs follow the game (vote/verdict -> table, new case -> evidence)");
for (const k of ["conn.hostLeft", "bunker.tieNote", "bunker.finalTitle", "bunker.finalIn", "bunker.finalOut", "court.seeTable"]) {
  ok(new RegExp('"' + k.replace(".", "\\.") + '": \\{ ru: "[^"]+", en: "[^"]+", hy: "[^"]+" \\}').test(src), "i18n in 3 languages: " + k);
}

/* ---- follow-up after the live check ---- */
let secretaryMention = 0;
for (let i = 0; i < 300; i++) { const out = C.assignCourtRound({ a: {}, b: {}, c: {}, d: {} }, "a"); for (const id of ["a", "b", "c", "d"]) { const pl = out.players[id]; const pool = pl.role === "juror" ? "juror" : pl.role; const text = (C.COURT_EVIDENCE_BY_ROLE[pl.role] || C.COURT_EVIDENCE_JUROR).ru[pl.evidence.textIndex]; if (typeof text !== "string" || /Секретар/i.test(text)) secretaryMention++; } }
ok(secretaryMention === 0, "4-player deals never hand out evidence about a secretary (300 deals)");
ok(/if \(!hasSecretary\) choices = choices\.filter/.test(src), "evidence about the secretary is skipped when there is none");
ok(/channel\.on\("presence", \{ event: "sync" \}/.test(src) && /channel\.track\(\{ host: true, player: playerId \}\)/.test(src), "host presence is tracked and watched");
ok(!src.includes("Shared table"), "English text names the tab as it is labelled (Common table)");
const story = fs.readFileSync(ROOT + "/api/mafia-story.js", "utf8");
ok(/signal: AbortSignal\.timeout\(UPSTREAM_TIMEOUT_MS\)/.test(story) && /UPSTREAM_TIMEOUT_MS = 6000/.test(story), "story endpoint stops waiting for Gemini after 6 s");
console.log(`${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
