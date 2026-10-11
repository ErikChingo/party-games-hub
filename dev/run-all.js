// Runs every dev/tests/test_*.js against the current index.html / dist /
// api files and prints one line per suite. Build the site first
// (`npm run build` in the repo root) -- the UI tests load dist/index.html.
// Usage: node run-all.js [filter]   e.g. node run-all.js durak
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "tests");
const filter = process.argv[2] || "";
const dist = path.resolve(__dirname, "..", "dist", "index.html");
if (!fs.existsSync(dist)) {
  console.error("dist/index.html is missing: run `npm run build` in the repo root first.");
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => /^test_.*\.js$/.test(f) && f.includes(filter)).sort();
let failed = 0;
for (const f of ["static_check.js", ...files]) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8", timeout: 15 * 60 * 1000 });
  const out = (r.stdout || "").trim().split("\n");
  const summary = out.filter((l) => /passed|invariants/.test(l)).pop() || out[out.length - 1] || (r.stderr || "").trim().split("\n").pop() || "";
  const bad = r.status !== 0 || out.some((l) => /^(FAIL|CRASH)/.test(l)) || / [1-9]\d* failed\s*$/.test(summary);
  if (bad) failed++;
  console.log((bad ? "FAIL " : "ok   ") + f.padEnd(42) + " " + summary);
  if (bad) out.concat((r.stderr || "").split("\n")).filter((l) => /FAIL|CRASH|Error/.test(l)).slice(0, 8).forEach((l) => console.log("       " + l));
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
