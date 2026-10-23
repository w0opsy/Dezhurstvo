// Сервер «Дежурства»: раздаёт игру, хранит аккаунты, прогресс и общий рейтинг.
// Node.js 18+. Запуск: node server.js  (порт — переменная PORT, по умолчанию 8080)
// Хранилище: файл data/db.json, а если задан DATABASE_URL — Postgres (Neon и т. п.; нужен пакет pg: npm install).
// На Render файловая система стирается при перезапуске — там обязательно DATABASE_URL.
'use strict';
const http=require('http'), fs=require('fs'), path=require('path'), crypto=require('crypto');
const PORT=+process.env.PORT||8080;
const BOT_TOKEN=process.env.BOT_TOKEN||'';
// ADMIN_KEY — ключ для просмотра баг-репортов: https://сервер/reports?key=КЛЮЧ
// ADMIN_CHAT — ваш chat id в Telegram: бот будет присылать туда каждый репорт (узнать: написать боту /myid)
const AI=require('./ai.js');
const ADMIN_KEY=process.env.ADMIN_KEY||'', ADMIN_CHAT=process.env.ADMIN_CHAT||'';
// TG_API — адрес посредника для Bot API (Cloudflare Worker), если api.telegram.org с сервера недоступен      // токен бота от @BotFather — нужен для входа через Telegram и для бота
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
 if(p==='/api/ping') return send(res,200,{ok:true,tg:!!BOT_TOKEN,bot:BOT.username||null,ai:AI.enabled()});
 // ИИ-пациент: живой ответ вместо шаблонного; при любой ошибке клиент оставит ответ движка
 if(p==='/api/talk'&&req.method==='POST'){
  if(!AI.enabled()) return send(res,501,{error:'ИИ не настроен.'});
  const u=auth(req); if(!u) return send(res,401,{error:'Нужно войти.'});
  if(!AI.allowed(u.name)) return send(res,429,{error:'Слишком много вопросов, ИИ отдыхает.'});
  const b=await body(req);
  try{ const t=AI.clean(await AI.complete(b)); if(!t) return send(res,502,{error:'Пустой ответ.'}); return send(res,200,{text:t}); }
  catch(e){ console.warn('AI',e.message); return send(res,502,{error:'ИИ недоступен.'}); }
 }
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
 if(p==='/api/report'&&req.method==='POST'){
  if(limited(ip,'rep',6)) return send(res,429,{error:'Слишком много отчётов подряд, подождите минуту.'});
  const b=await body(req); const text=String(b.text||'').trim().slice(0,2000);
  if(text.length<3) return send(res,400,{error:'Опишите ошибку хотя бы парой слов.'});
  const u=auth(req);
  const rep={id:crypto.randomBytes(4).toString('hex'),at:Date.now(),who:u?u.name:String(b.who||'гость').slice(0,40),cat:String(b.cat||'').slice(0,40),text,
   ctx:JSON.stringify(b.ctx||{}).length<8000?b.ctx:{note:'контекст слишком большой'},ua:String(req.headers['user-agent']||'').slice(0,160)};
  db.reports=db.reports||[]; db.reports.unshift(rep); db.reports=db.reports.slice(0,200); save();
  if(bot&&bot.notify&&ADMIN_CHAT) bot.notify(ADMIN_CHAT,'🐞 <b>'+esc(rep.cat||'Ошибка')+'</b> от '+esc(rep.who)+(rep.ctx&&rep.ctx.case?' · кейс '+esc(rep.ctx.case):'')+'\n'+esc(text)).catch(()=>{});
  return send(res,200,{ok:true,id:rep.id});
 }
 if(p==='/api/me'){ const u=auth(req); if(!u) return send(res,401,{error:'Нужно войти.'}); return send(res,200,{name:u.name,prog:u.prog}); }
 if(p==='/api/progress'&&req.method==='PUT'){
  const u=auth(req); if(!u) return send(res,401,{error:'Нужно войти.'});
  const b=await body(req); if(!b.prog||typeof b.prog!=='object') return send(res,400,{error:'Нет данных.'});
  u.prog=b.prog; u.seen=Date.now(); save(); return send(res,200,{ok:true});
 }
 // Публичный профиль игрока: лучшие результаты по кейсам и достижения (без истории вызовов)
 if(p==='/api/profile'){
  const q=new URL(req.url,'http://x').searchParams.get('name')||''; const u=Object.values(db.users).find(x=>x.name===q);
  if(!u) return send(res,404,{error:'Игрок не найден.'});
  const P=u.prog||{}; const cases={}; for(const [id,c] of Object.entries(P.cases||{})) cases[id]={best:c.best|0,n:c.n|0,locs:c.locs||[]};
  return send(res,200,{name:u.name,photo:u.photo||null,since:u.created||null,prog:{cases,ach:P.ach||{},total:P.total||{n:0,sum:0},runs:[],stats:{}}});
 }
 if(p==='/api/board'){
  const me=auth(req);
  const rows=Object.values(db.users).filter(u=>u.prog||u===me).map(u=>({name:u.name,photo:u.photo||null,me:u===me,ach:Object.keys((u.prog&&u.prog.ach)||{}).slice(0,80),...summary(u.prog)})).sort((a,b)=>b.r-a.r).slice(0,100);
  return send(res,200,{rows});
 }
 send(res,404,{error:'Нет такого адреса.'});
}

const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Статистика для автора игры: /stats?key=ADMIN_KEY — игроки, активность по дням, популярные и трудные кейсы
let CASES={}; try{ CASES=require('./cases.json'); }catch(e){}
function statsPage(res,q){
 if(!ADMIN_KEY||q.get('key')!==ADMIN_KEY){ res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Нужен ключ: /stats?key=ADMIN_KEY'); }
 const users=Object.values(db.users), now=Date.now(), DAY=864e5;
 const dayKey=t=>new Date(t+3*36e5).toISOString().slice(0,10); // день по Москве
 const runs=[]; for(const u of users) for(const r of ((u.prog&&u.prog.runs)||[])) runs.push({...r,who:u.name});
 const lastAct=u=>Math.max(u.seen||0,...(((u.prog&&u.prog.runs)||[]).map(r=>r.at||0)));
 const played=users.filter(u=>u.prog&&u.prog.total&&u.prog.total.n>0);
 const act=d=>users.filter(u=>now-lastAct(u)<d*DAY).length;
 const totalRuns=played.reduce((a,u)=>a+(u.prog.total.n|0),0);
 const days=[]; for(let i=13;i>=0;i--){ const k=dayKey(now-i*DAY); days.push({k,runs:runs.filter(r=>dayKey(r.at)===k).length,players:new Set(runs.filter(r=>dayKey(r.at)===k).map(r=>r.who)).size,newU:users.filter(u=>u.created&&dayKey(u.created)===k).length}); }
 const per={}; for(const u of played) for(const [id,c] of Object.entries(u.prog.cases||{})){ const x=per[id]=per[id]||{id,players:0,tries:0,best:0}; x.players++; x.tries+=c.n|0; x.best+=c.best|0; }
 const cs=Object.values(per).map(x=>({...x,avg:Math.round(x.best/x.players)}));
 const pop=[...cs].sort((a,b)=>b.tries-a.tries), hard=cs.filter(x=>x.players>=2).sort((a,b)=>a.avg-b.avg).slice(0,10);
 const never=Object.keys(CASES).filter(id=>!per[id]);
 const nm=id=>CASES[id]?esc(CASES[id].t)+' <span class="m">· '+esc(CASES[id].dx)+'</span>':esc(id);
 const max=Math.max(1,...days.map(d=>d.runs));
 const top=played.map(u=>({u,...summary(u.prog)})).sort((a,b)=>b.r-a.r);
 const fmt=t=>t?new Date(t).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'});
 res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Статистика</title>
<style>body{font:14px/1.45 system-ui,sans-serif;background:#0c1513;color:#dbe7e2;margin:0;padding:16px;max-width:960px}h1{font-size:20px}h2{font-size:16px;margin:22px 0 8px}
.k{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}.k div{background:#13201d;border:1px solid #25403a;border-radius:10px;padding:10px}.k b{display:block;font-size:24px;color:#e8a33a}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid #1d2b28;text-align:left;vertical-align:top}th{color:#87a39b;font-weight:500}.n{text-align:right;font-variant-numeric:tabular-nums}
.bar{display:flex;align-items:flex-end;gap:4px;height:120px;border-bottom:1px solid #25403a}.bar div{flex:1;background:#4cc38a;border-radius:3px 3px 0 0;min-height:2px;position:relative}.bar span{position:absolute;top:-17px;left:0;right:0;text-align:center;font-size:11px;color:#87a39b}
.lbl{display:flex;gap:4px}.lbl span{flex:1;text-align:center;font-size:10px;color:#87a39b}.m{color:#87a39b;font-size:12px}a{color:#e8a33a}</style>
<h1>Дежурство — статистика</h1><p class="m">Обновлено ${fmt(now)} (МСК) · <a href="/reports?key=${encodeURIComponent(ADMIN_KEY)}">баг-репорты</a></p>
<div class="k"><div>Игроков всего<b>${users.length}</b></div><div>Сыграли хотя бы раз<b>${played.length}</b></div><div>Активны сегодня<b>${act(1)}</b></div><div>За 7 дней<b>${act(7)}</b></div><div>Вызовов сыграно<b>${totalRuns}</b></div><div>Средний балл<b>${totalRuns?Math.round(played.reduce((a,u)=>a+u.prog.total.sum,0)/totalRuns):0}%</b></div></div>
<h2>Вызовы по дням (14 дней)</h2><div class="bar">${days.map(d=>`<div style="height:${Math.round(d.runs/max*100)}%" title="${d.k}: ${d.runs} вызовов, ${d.players} игроков, новых ${d.newU}"><span>${d.runs||''}</span></div>`).join('')}</div>
<div class="lbl">${days.map(d=>`<span>${d.k.slice(8)}.${d.k.slice(5,7)}</span>`).join('')}</div>
<table><tr><th>День</th><th class="n">Вызовов</th><th class="n">Игроков</th><th class="n">Новых</th></tr>${days.slice().reverse().filter(d=>d.runs||d.newU).map(d=>`<tr><td>${d.k.slice(8)}.${d.k.slice(5,7)}</td><td class="n">${d.runs}</td><td class="n">${d.players}</td><td class="n">${d.newU}</td></tr>`).join('')}</table>
<h2>Популярные кейсы</h2><table><tr><th>Кейс</th><th class="n">Игроков</th><th class="n">Попыток</th><th class="n">Средний лучший</th></tr>${pop.map(x=>`<tr><td>${nm(x.id)}</td><td class="n">${x.players}</td><td class="n">${x.tries}</td><td class="n">${x.avg}%</td></tr>`).join('')}</table>
<h2>Самые трудные (от 2 игроков)</h2><table>${hard.map(x=>`<tr><td>${nm(x.id)}</td><td class="n">${x.avg}%</td></tr>`).join('')||'<tr><td class="m">Пока мало данных</td></tr>'}</table>
${never.length?`<h2>Ещё никто не играл (${never.length})</h2><p class="m">${never.map(id=>esc(CASES[id].t)).join(' · ')}</p>`:''}
<h2>Игроки</h2><table><tr><th>Игрок</th><th class="n">Рейтинг</th><th class="n">Кейсов</th><th class="n">Вызовов</th><th class="n">Ср. балл</th><th>Был в игре</th></tr>${top.map(x=>`<tr><td>${esc(x.u.name)}${x.u.tg?' <span class="m">TG</span>':''}</td><td class="n">${x.r}</td><td class="n">${x.c}</td><td class="n">${x.n}</td><td class="n">${x.a}%</td><td class="m">${fmt(lastAct(x.u))}</td></tr>`).join('')}</table>
<h2>Последние вызовы</h2><table>${runs.sort((a,b)=>b.at-a.at).slice(0,30).map(r=>`<tr><td class="m">${fmt(r.at)}</td><td>${esc(r.who)}</td><td>${nm(r.c)}</td><td class="n">${r.pct}%</td></tr>`).join('')}</table>`);
}
// Страница баг-репортов для автора игры (по ключу ADMIN_KEY)
function reportsPage(res,q){
 if(!ADMIN_KEY||q.get('key')!==ADMIN_KEY){ res.writeHead(403,{'Content-Type':'text/plain; charset=utf-8'}); return res.end('Нужен ключ: /reports?key=ADMIN_KEY'); }
 const list=db.reports||[]; const fmt=t=>new Date(t).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'});
 if(q.get('format')==='json'){ res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); return res.end(JSON.stringify(list,null,1)); }
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex'});
 res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Баг-репорты</title>
<style>body{font:14px/1.45 system-ui,sans-serif;background:#0c1513;color:#dbe7e2;margin:0;padding:16px;max-width:900px}h1{font-size:20px}
.r{background:#13201d;border:1px solid #25403a;border-radius:10px;padding:12px;margin:10px 0}.m{color:#87a39b;font-size:12px}.t{white-space:pre-wrap;margin:6px 0}
details{font-size:12px;color:#87a39b}pre{white-space:pre-wrap;word-break:break-word;background:#0c1513;padding:8px;border-radius:6px}.c{color:#e8a33a;font-weight:600}</style>
<h1>Баг-репорты (${list.length})</h1>${list.map(r=>`<div class="r"><div class="m">${fmt(r.at)} · ${esc(r.who)} · <span class="c">${esc(r.cat||'—')}</span>${r.ctx&&r.ctx.case?' · кейс '+esc(r.ctx.case)+' ('+esc(r.ctx.loc||'')+')':''} · #${r.id}</div>
<div class="t">${esc(r.text)}</div><details><summary>Данные вызова</summary><pre>${esc(JSON.stringify(r.ctx,null,1))}</pre><div class="m">${esc(r.ua)}</div></details></div>`).join('')||'<p>Пока пусто.</p>'}`);
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','same-origin');
 const U=new URL(req.url,'http://x'), p=decodeURIComponent(U.pathname);
 try{
  if(p==='/reports') return reportsPage(res,U.searchParams);
  if(p==='/stats') return statsPage(res,U.searchParams);
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
 if(BOT_TOKEN) bot=require('./bot.js')({token:BOT_TOKEN,apiBase:process.env.TG_API||'',url:WEBAPP_URL,info:BOT,hook:WEBHOOK&&SELF_URL?SELF_URL.replace(/\/$/,'')+HOOK:null,secret:HOOK_SECRET,top:()=>Object.values(db.users).filter(u=>u.prog).map(u=>({name:u.name,...summary(u.prog)})).sort((a,b)=>b.r-a.r)});
}).catch(e=>{ console.error('Не удалось открыть хранилище:',e.message); process.exit(1); });
for(const sig of ['SIGTERM','SIGINT']) process.on(sig,async()=>{ clearTimeout(saveT); try{ await flush(); }catch(e){} process.exit(0); });
