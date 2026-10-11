const ROOT = require("path").resolve(__dirname, "../..");
const fs=require("fs");
const src=fs.readFileSync(ROOT + "/index.html","utf8");
const dist=fs.readFileSync(ROOT + "/dist/index.html","utf8");
// 1. dist script syntax
const scripts=[...dist.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(x=>x.length>100000);
scripts.forEach((code,i)=>{ new Function(code); console.log("dist script",i,"syntax ok",code.length); });
// 2. duplicate top-level declarations in source babel script
const body=src.match(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/)[1];
const names={};
for (const m of body.matchAll(/^(?:const|let|var|function|async function|class) ([A-Za-z_$][\w$]*)/gm)) names[m[1]]=(names[m[1]]||0)+1;
const dups=Object.entries(names).filter(([k,v])=>v>1);
console.log("duplicate top-level:", dups.length?dups:"none");
// 3. i18n keys used vs defined
const start=body.indexOf("const I18N = {");
const defined=new Set([...body.slice(start, body.indexOf("\n};",start)).matchAll(/^  "([^"]+)":/gm)].map(m=>m[1]));
const used=new Set([...body.matchAll(/\bt\("([a-zA-Z0-9_.]+)"\)/g)].map(m=>m[1]));
for (const m of body.matchAll(/(?:titleKey|subtitleKey|labelKey|messageKey|badgeKey)[:=]\s*"([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
for (const m of body.matchAll(/setError\("([a-zA-Z0-9_.]+)"\)|"(durak\.[a-zA-Z]+)"/g)) used.add(m[1]||m[2]);
const missing=[...used].filter(k=>!defined.has(k) && k!=="some.key");
console.log("defined",defined.size,"missing:",missing.length?missing:"none");

if (dups.length || missing.length) { console.log("FAIL: static check"); process.exit(1); }
console.log("static checks passed");
