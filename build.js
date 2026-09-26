#!/usr/bin/env node
// Precompiles index.html's inline JSX into plain JS before deploy, so a
// visitor's browser never has to load Babel Standalone or transpile
// ~13,000 lines of JSX on every single page load. The source file stays
// exactly as it is today — a single index.html with one
// <script type="text/babel"> block, still the file to edit day to day —
// this only runs at BUILD time and writes the compiled result into
// dist/, which is what actually gets deployed (see vercel.json).
//
// Uses the TypeScript compiler's transpileModule() as a JSX-to-JS engine
// (jsx:"react" emits the same React.createElement(...)/React.Fragment
// calls Babel Standalone already produced at runtime, so behavior is
// unchanged) rather than pulling in Babel — TypeScript is an extremely
// standard, widely-installed tool and this is a well-worn use of it.
//
// The compiled JS is then run through esbuild's minifier (below) before
// being written to dist/ — it was previously shipped byte-for-byte as
// TypeScript emits it (readable, full variable names, all comments kept),
// which meant every visitor downloaded and parsed a much bigger script
// than necessary on every first visit. That matters more than usual here:
// this is a Telegram Mini App, opened on phones, often on slow mobile
// connections, for a party game where the whole point is getting the
// group playing quickly — extra load-time latency directly works against
// that. Minifying only changes whitespace/names/dead code, not behavior,
// so this is safe to add without touching the JSX source at all.

const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const esbuild = require("esbuild");

const ROOT = __dirname;
const OUT_DIR = path.join(ROOT, "dist");

function readSource() {
  return fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
}

// Finds the <script type="text/babel">...</script> block and returns its
// exact position in the file plus its inner JSX source, so the caller can
// splice in the compiled replacement without disturbing anything else.
function extractBabelScript(html) {
  const openTagRe = /<script type="text\/babel"[^>]*>/;
  const openMatch = html.match(openTagRe);
  if (!openMatch) {
    throw new Error('build.js: could not find a <script type="text/babel"> block in index.html — did the source file change shape?');
  }
  const contentStart = openMatch.index + openMatch[0].length;
  const closeIdx = html.indexOf("</script>", contentStart);
  if (closeIdx === -1) {
    throw new Error("build.js: found the opening babel <script> tag but no matching </script> — the file may be truncated.");
  }
  return {
    tagStart: openMatch.index,
    tagEnd: closeIdx + "</script>".length,
    jsxCode: html.slice(contentStart, closeIdx),
  };
}

function compileJsx(jsxCode) {
  const result = ts.transpileModule(jsxCode, {
    fileName: "app.tsx",
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      target: ts.ScriptTarget.ES2019,
    },
    reportDiagnostics: true,
  });
  if (result.diagnostics && result.diagnostics.length) {
    const messages = result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
    throw new Error("build.js: JSX failed to compile:\n" + messages);
  }
  return result.outputText;
}

// Shrinks the already-compiled JS (whitespace, identifier names, dead
// code) without changing what it does. Kept as its own step, separate
// from compileJsx above, so a minification problem is easy to tell apart
// from a JSX/TypeScript one — if this ever needs to be temporarily
// disabled, the fix is to make this function return `code` unchanged.
function minifyJs(code) {
  const result = esbuild.transformSync(code, {
    loader: "js",
    target: "es2019",
    minify: true,
    // Without this, esbuild defaults to escaping every non-ASCII
    // character as \uXXXX for safety on pages that don't declare an
    // encoding -- which more than doubles the file size here, since the
    // Russian/Armenian I18N dictionary is most of this script's text.
    // index.html declares <meta charset="utf-8">, so real UTF-8 bytes are
    // safe to keep as-is.
    charset: "utf8",
  });
  return result.code;
}

function build() {
  const source = readSource();
  const { tagStart, tagEnd, jsxCode } = extractBabelScript(source);
  const compiled = compileJsx(jsxCode);
  const minified = minifyJs(compiled);

  let html = source.slice(0, tagStart) + "<script>" + minified + "</script>" + source.slice(tagEnd);

  // Babel Standalone's only job was transpiling the block above at
  // runtime — once that block is plain JS, loading the library is pure
  // dead weight (and one fewer render-blocking request on every visit).
  html = html.replace(/[ \t]*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]*"><\/script>\n?/, "");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "index.html"), html);

  // Everything else the deployed site needs as a real file. Icons and the
  // manifest are inlined as data: URIs inside index.html itself (see its
  // <head>), so they don't need copying here.
  const staticFiles = ["og-image.png", "robots.txt", "sitemap.xml", "sw.js", "google9a30da4fd0ae13b5.html", "yandex_710e03779ae07f36.html"];
  for (const name of staticFiles) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, name));
    } else {
      console.warn(`build.js: expected static file "${name}" not found next to index.html, skipping`);
    }
  }

  console.log(
    `build.js: wrote dist/index.html — JSX source ${(jsxCode.length / 1024).toFixed(0)} KB -> compiled ${(compiled.length / 1024).toFixed(0)} KB -> minified ${(minified.length / 1024).toFixed(0)} KB`
  );
}

build();
