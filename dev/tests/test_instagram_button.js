const ROOT = require("path").resolve(__dirname, "../..");
// Hub-footer Instagram button: real compiled component, rendered via react-dom/server.
const fs=require("fs"),React=require("react"),RDS=require("react-dom/server");
const html=fs.readFileSync(ROOT + "/dist/index.html","utf8");
const re=/<script(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g;let m,code="";while((m=re.exec(html)))if(m[1].length>code.length)code=m[1];
const st=()=>{let s={};return{getItem:k=>k in s?s[k]:null,setItem:(k,v)=>{s[k]=String(v)},removeItem:k=>{delete s[k]}}};
const el={style:{},classList:{add(){},remove(){},toggle(){},contains:()=>false},setAttribute(){},getAttribute(){return null},appendChild(){},addEventListener(){},removeEventListener(){},querySelector(){return null},querySelectorAll(){return[]}};
const doc={documentElement:{...el},addEventListener(){},removeEventListener(){},getElementById(){return el},createElement(){return{...el}},querySelector(){return null},querySelectorAll(){return[]},head:el,body:el,visibilityState:"visible"};
const qb={select(){return this},order(){return this},limit(){return this},eq(){return this},gt(){return this},maybeSingle:()=>Promise.resolve({data:null,error:null}),then(r){r({data:[],error:null})}};
const sb={createClient:()=>({from:()=>({...qb}),rpc:()=>Promise.resolve({data:null,error:null})})};
function load(tgApp){const w={location:{origin:"https://hatsit.vercel.app",pathname:"/",search:""},addEventListener(){},removeEventListener(){},matchMedia(){return{matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}}},crypto:{randomUUID:()=>"u"},requestAnimationFrame:c=>setTimeout(c,0),cancelAnimationFrame:clearTimeout,innerWidth:390,innerHeight:844,supabase:sb};w.window=w;w.Telegram=tgApp?{WebApp:tgApp}:undefined;
const cap={};new Function("window","document","navigator","localStorage","sessionStorage","React","ReactDOM","supabase","console","__c",code+";__c.B=InstagramButton;__c.U=INSTAGRAM_URL;")(w,doc,{clipboard:{writeText:()=>Promise.resolve()},userAgent:"t"},st(),st(),React,{createRoot:()=>({render(){}}),createPortal:c=>c},sb,console,cap);return cap;}
let p=0,f=0;const ok=(c,l)=>{c?p++:(f++,console.error("FAIL: "+l))};
let c=load();const out=RDS.renderToStaticMarkup(React.createElement(c.B));
ok(c.U==="https://www.instagram.com/hatsiteverywhere/","URL is the account the user gave");
ok(out.includes('href="https://www.instagram.com/hatsiteverywhere/"'),"links to the account");
ok(out.includes('target="_blank"')&&out.includes('rel="noopener noreferrer"'),"opens in new tab safely");
ok(out.includes("rounded-full")&&out.includes("<svg"),"round button with icon");
c=load({initDataUnsafe:{user:{id:1}}});
ok(RDS.renderToStaticMarkup(React.createElement(c.B)).includes("instagram.com"),"still shown inside Telegram");
console.log(`\n${p} passed, ${f} failed`);process.exit(f?1:0);
