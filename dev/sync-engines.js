// index.html carries an exact copy of each game engine from api/_lib
// (between the *-ENGINE-BEGIN / *-ENGINE-END markers) -- the same code runs
// the bot games in the browser and referees online games on the server.
// After editing api/_lib/*.js, run this to copy the engines into index.html.
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const file = path.join(root, "index.html");
let html = fs.readFileSync(file, "utf8");
for (const [name, lib] of [["DURAK", "durak.js"], ["BLOT", "blot.js"], ["BLACKJACK", "blackjack.js"], ["NARDY", "nardy.js"]]) {
  const src = fs.readFileSync(path.join(root, "api", "_lib", lib), "utf8").replace(/\r\n/g, "\n");
  const B = `/* ${name}-ENGINE-BEGIN */`;
  const E = `/* ${name}-ENGINE-END */`;
  const block = src.slice(src.indexOf(B), src.indexOf(E) + E.length);
  const a = html.indexOf(B);
  const b = html.indexOf(E) + E.length;
  if (a < 0 || b < E.length) throw new Error(name + " markers not found in index.html");
  const same = html.slice(a, b) === block;
  html = html.slice(0, a) + block + html.slice(b);
  console.log(name.padEnd(10), same ? "already the same" : "updated");
}
fs.writeFileSync(file, html);
