// Сервер «Дежурства»: раздаёт игру, хранит аккаунты, прогресс и общий рейтинг.
// Node.js 18+. Запуск: node server.js  (порт — переменная PORT, по умолчанию 8080)
// Хранилище: файл data/db.json, а если задан DATABASE_URL — Postgres (Neon и т. п.; нужен пакет pg: npm install).
// На Render файловая система стирается при перезапуске — там обязательно DATABASE_URL.
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const PORT=+process.env.PORT||8080;
const BOT_TOKEN=process.env.BOT_TOKEN||'';      // токен бота от @BotFather — нужен для входа через Telegram и для бота
const EXT=(process.env.RENDER_EXTERNAL_URL||'').replace(/\/?$/,'/');   // Render задаёт адрес сервиса сам
// Адрес самого сервера (для вебхука и для игры, если она лежит отдельно)
const SELF_URL=((process.env.PUBLIC_URL||process.env.WEBAPP_URL||(process.env.RENDER_EXTERNAL_URL?EXT:''))||'').replace(/\/?$/,'/').replace(/^\/$/,'');
// Игра может лежать отдельно — на GitHub Pages (GAME_URL). Тогда кнопка «Играть» ведёт на GAME_URL?api=SELF_URL:
// тяжёлый файл игры грузится с GitHub, а сервер отдаёт только маленькие ответы (рейтинг, сохранения).
const GAME_URL=process.env.GAME_URL||'';
const WEBAPP_URL=GAME_URL&&SELF_URL?GAME_URL+(GAME_URL.includes('?')?'&':'?')+'api='+encodeURIComponent(SELF_URL):SELF_URL;   // кнопка «Играть»
// С каких сайтов можно обращаться к API (через запятую). По умолчанию — с любых: вход по токену, cookies не используются.
const ALLOW_ORIGIN=(process.env.ALLOW_ORIGIN||'*').split(',').map(x=>x.trim()).filter(Boolean);
const WEBHOOK=process.env.WEBHOOK==='0'?false:!!(process.env.WEBHOOK||process.env.RENDER_EXTERNAL_URL);   // бот через вебхук (будит заснувший сервер)
const DATABASE_URL=process.env.DATABASE_URL||'';
const BOT={username:null};
const PUB=path.join(__dirname,'public'), DATA=path.join(__dirname,'data'), DBF=path.join(DATA,'db.json');
fs.mkdirSync(DATA,{recursive:true});
let db={users:{},tokens:{}};
let pool=null;
async function loadDb(){
 if(DATABASE_URL){
  const {Pool}=require('pg');
  pool=new Pool({connectionString:DATABASE_URL,ssl:/localhost|127\.0\.0\.1/.test(DATABASE_URL)?false:{rejectUnauthorized:false},max:3,idleTimeoutMillis:20000});
  pool.on('error',e=>console.error('Postgres:',e.message));          // Neon усыпляет базу через 5 минут — переподключимся сами
  await pool.query('create table if not exists dezh_kv (k text primary key, v jsonb not null, at timestamptz default now())');
  const r=await pool.query("select v from dezh_kv where k='db'"); if(r.rows[0]) db=r.rows[0].v;
  console.log('Хранилище: Postgres, игроков '+Object.keys(db.users||{}).length);
 } else {
  try{ db=JSON.parse(fs.readFileSync(DBF,'utf8')); }catch(e){}
  console.log('Хранилище: файл '+DBF+(process.env.RENDER?' — ВНИМАНИЕ: на Render он сотрётся при перезапуске, задайте DATABASE_URL':''));
 }
 db.users=db.users||{}; db.tokens=db.tokens||{};
 const now=Date.now(); for(const t in db.tokens) if(db.tokens[t].exp<now) delete db.tokens[t];
}
let saveT=null, saving=false, again=false;
async function flush(){
 if(saving){ again=true; return; } saving=true;
 try{
  if(pool){ for(let i=0;i<3;i++){ try{ await pool.query("insert into dezh_kv(k,v,at) values('db',$1,now()) on conflict (k) do update set v=excluded.v, at=now()",[JSON.stringify(db)]); break; }catch(e){ console.error('Сохранение:',e.message); await new Promise(r=>setTimeout(r,1500)); } } }
  else { const tmp=DBF+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(db)); fs.renameSync(tmp,DBF); }
 } finally { saving=false; if(again){ again=false; flush(); } }
}
function save(){ clearTimeout(saveT); saveT=setTimeout(flush,pool?800:300); }

const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const send=(res,code,obj)=>{ res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(obj)); };
const hashPass=(pass,salt)=>crypto.scryptSync(String(pass),salt,64).toString('hex');
const okName=n=>typeof n==='string'&&/^[\p{L}\p{N} _.-]{2,24}$/u.test(n.trim());
const hits=new Map();
function limited(ip,key,max){ const k=ip+key, now=Date.now(); const a=(hits.get(k)||[]).filter(t=>now-t<60000); a.push(now); hits.set(k,a); return a.length>max; }
function body(req){ return new Promise((resolve,reject)=>{ let n=0, chunks=[]; req.on('data',c=>{ n+=c.length; if(n>400000){ reject(new Error('too big')); req.destroy(); } else chunks.push(c); }); req.on('end',()=>{ try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')); }catch(e){ reject(e); } }); }); }
function auth(req){ const t=(req.headers.authorization||'').replace(/^Bearer /,''); const s=db.tokens[t]; if(!s||s.exp<Date.now()) return null; return db.users[s.key]||null; }
function newToken(key){ const t=crypto.randomBytes(32).toString('hex'); db.tokens[t]={key,exp:Date.now()+90*864e5}; return t; }
function summary(p){
 const cs=Object.values((p&&p.cases)||{}); const tot=(p&&p.total)||{n:0,sum:0};
 return {r:Math.round(cs.reduce((a,c)=>a+Math.min(150,Math.max(0,+c.bestW||+c.best||0)),0)),c:cs.length,a:tot.n?Math.round(tot.sum/tot.n):0,n:tot.n|0};
}

// Проверка подписи Telegram (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
function checkInitData(initData){
 try{
  const q=new URLSearchParams(initData), hash=q.get('hash'); if(!hash) return null; q.delete('hash');
  const dcs=[...q.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+'='+v).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const h=crypto.createHmac('sha256',secret).update(dcs).digest('hex');
  if(h.length!==hash.length||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(hash))) return null;
  if(Date.now()/1000-(+q.get('auth_date')||0)>7*86400) return null;
  const u=JSON.parse(q.get('user')||'null'); return u&&u.id?u:null;
 }catch(e){ return null; }
}
// Проверка виджета «Войти через Telegram» (core.telegram.org/widgets/login#checking-authorization)
function checkWidget(d){
 try{
  if(!d||typeof d!=='object'||!d.hash||!d.id) return null;
  const dcs=Object.keys(d).filter(k=>k!=='hash'&&d[k]!==undefined&&d[k]!==null).sort().map(k=>k+'='+d[k]).join('\n');
  const secret=crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const h=crypto.createHmac('sha256',secret).update(dcs).digest('hex');
  if(h.length!==String(d.hash).length||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(String(d.hash)))) return null;
  if(Date.now()/1000-(+d.auth_date||0)>86400) return null;
  return {id:d.id,first_name:d.first_name,last_name:d.last_name,username:d.username,photo_url:d.photo_url};
 }catch(e){ return null; }
}
let bot=null;
const HOOK='/tg/'+crypto.createHash('sha256').update('hook:'+BOT_TOKEN).digest('hex').slice(0,24);
const HOOK_SECRET=crypto.createHash('sha256').update('secret:'+BOT_TOKEN).digest('hex').slice(0,48);
async function apiRoute(req,res,p){
 const ip=req.socket.remoteAddress;
 if(p==='/api/ping') return send(res,200,{ok:true,tg:!!BOT_TOKEN,bot:BOT.username||null});
 if(p==='/api/register'&&req.method==='POST'){
  if(limited(ip,'reg',5)) return send(res,429,{error:'Слишком много попыток, подождите минуту.'});
  const b=await body(req); const name=String(b.name||'').trim();
  if(!okName(name)) return send(res,400,{error:'Имя: 2–24 символа, буквы, цифры, пробел.'});
  if(String(b.pass||'').length<6) return send(res,400,{error:'Пароль — минимум 6 символов.'});
  const key=name.toLowerCase(); if(db.users[key]||Object.values(db.users).some(x=>x.name.toLowerCase()===key)) return send(res,409,{error:'Это имя уже занято.'});
  const salt=crypto.randomBytes(16).toString('hex');
  db.users[key]={name,salt,hash:hashPass(b.pass,salt),prog:null,created:Date.now()}; const token=newToken(key); save();
  return send(res,200,{token,name});
 }
 if(p==='/api/login'&&req.method==='POST'){
  if(limited(ip,'login',10)) return send(res,429,{error:'Слишком много попыток, подождите минуту.'});
  const b=await body(req); const key=String(b.name||'').trim().toLowerCase(); const u=db.users[key];
  if(!u||!crypto.timingSafeEqual(Buffer.from(hashPass(b.pass||'',u.salt),'hex'),Buffer.from(u.hash,'hex'))) return send(res,401,{error:'Неверное имя или пароль.'});
  const token=newToken(key); save(); return send(res,200,{token,name:u.name,prog:u.prog});
 }
 if((p==='/api/tg'||p==='/api/tglogin')&&req.method==='POST'){
  if(!BOT_TOKEN) return send(res,501,{error:'На сервере не задан BOT_TOKEN.'});
  if(limited(ip,'tg',20)) return send(res,429,{error:'Слишком много попыток.'});
  const b=await body(req); const tu=p==='/api/tg'?checkInitData(String(b.initData||'')):checkWidget(b);
  if(!tu) return send(res,401,{error:'Не удалось проверить вход через Telegram.'});
  const key='tg:'+tu.id;
  let base=([tu.first_name,tu.last_name].filter(Boolean).join(' ').trim()||tu.username||'Доктор').slice(0,24);
  let u=db.users[key];
  if(!u){ let name=base, i=2; const taken=n=>Object.values(db.users).some(x=>x.name.toLowerCase()===n.toLowerCase());
   while(taken(name)) name=base.slice(0,21)+' '+(i++);
   u=db.users[key]={name,tg:tu.id,prog:null,created:Date.now()}; }
  u.photo=typeof tu.photo_url==='string'&&/^https:\/\/t\.me\//.test(tu.photo_url)?tu.photo_url:(u.photo||null); u.seen=Date.now();
  const token=newToken(key); save(); return send(res,200,{token,name:u.name,prog:u.prog});
 }
 if(p==='/api/me'){ const u=auth(req); if(!u) return send(res,401,{error:'Нужно войти.'}); return send(res,200,{name:u.name,prog:u.prog}); }
 if(p==='/api/progress'&&req.method==='PUT'){
  const u=auth(req); if(!u) return send(res,401,{error:'Нужно войти.'});
  const b=await body(req); if(!b.prog||typeof b.prog!=='object') return send(res,400,{error:'Нет данных.'});
  u.prog=b.prog; save(); return send(res,200,{ok:true});
 }
 if(p==='/api/board'){
  const me=auth(req);
  const rows=Object.values(db.users).filter(u=>u.prog||u===me).map(u=>({name:u.name,photo:u.photo||null,me:u===me,...summary(u.prog)})).sort((a,b)=>b.r-a.r).slice(0,100);
  return send(res,200,{rows});
 }
 send(res,404,{error:'Нет такого адреса.'});
}

const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin');
 const p=decodeURIComponent(new URL(req.url,'http://x').pathname);
 try{
  if(p.startsWith('/api/')){
   const o=req.headers.origin;
   if(o&&(ALLOW_ORIGIN.includes('*')||ALLOW_ORIGIN.includes(o))){ res.setHeader('Access-Control-Allow-Origin',ALLOW_ORIGIN.includes('*')?'*':o); res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS'); res.setHeader('Access-Control-Max-Age','86400'); }
   if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }
   return await apiRoute(req,res,p);
  }
  if(BOT_TOKEN&&p===HOOK&&req.method==='POST'){
   if(req.headers['x-telegram-bot-api-secret-token']!==HOOK_SECRET){ res.writeHead(403); return res.end(); }
   const upd=await body(req); res.writeHead(200); res.end('ok'); if(bot) bot.handle(upd); return;
  }
  let f=path.normalize(path.join(PUB,p==='/'?'index.html':p));
  if(!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f,(err,data)=>{
   if(err){ res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Не найдено'); }
   res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','Cache-Control':f.endsWith('.html')?'no-cache':'max-age=86400'}); res.end(data);
  });
 }catch(e){ send(res,400,{error:'Неверный запрос.'}); }
});
loadDb().then(()=>{
 server.listen(PORT,()=>console.log('Дежурство работает: порт '+PORT+(WEBAPP_URL?' · '+WEBAPP_URL:'')));
 if(BOT_TOKEN) bot=require('./bot.js')({token:BOT_TOKEN,url:WEBAPP_URL,info:BOT,hook:WEBHOOK&&SELF_URL?SELF_URL.replace(/\/$/,'')+HOOK:null,secret:HOOK_SECRET,top:()=>Object.values(db.users).filter(u=>u.prog).map(u=>({name:u.name,...summary(u.prog)})).sort((a,b)=>b.r-a.r)});
}).catch(e=>{ console.error('Не удалось открыть хранилище:',e.message); process.exit(1); });
for(const sig of ['SIGTERM','SIGINT']) process.on(sig,async()=>{ clearTimeout(saveT); try{ await flush(); }catch(e){} process.exit(0); });
