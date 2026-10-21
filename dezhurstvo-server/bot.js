// Бот «Дежурства» для Telegram. Без библиотек (Node.js 18+, встроенный fetch).
// Два режима: вебхук (hook задан — Telegram сам присылает сообщения, так бот будит заснувший сервер на Render)
// и long polling (обычный VPS).
// Команды: /start — кнопка запуска игры, /top — рейтинг, /help — что это.
'use strict';
module.exports=function startBot({token,url,top,info,hook,secret}){
 const API='https://api.telegram.org/bot'+token+'/';
 const call=async(m,p={})=>{ const r=await fetch(API+m,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}); const j=await r.json(); if(!j.ok) throw new Error(m+': '+j.description); return j.result; };
 const play=url?{inline_keyboard:[[{text:'🩺 Начать дежурство',web_app:{url}}]]}:undefined;
 const medal=i=>i<3?['🥇','🥈','🥉'][i]:(i+1)+'.';
 const esc=t=>String(t).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 async function setup(){
  try{
   await call('setMyCommands',{commands:[{command:'start',description:'Открыть игру'},{command:'top',description:'Рейтинг друзей'},{command:'help',description:'Что это'}]});
   if(url) await call('setChatMenuButton',{menu_button:{type:'web_app',text:'Играть',web_app:{url}}});
   const me=await call('getMe'); if(info) info.username=me.username; console.log('Бот запущен: @'+me.username+(url?'':' (WEBAPP_URL не задан — кнопки игры не будет)'));
  }catch(e){ console.error('Бот: ',e.message); }
 }
 async function onMsg(m){
  const t=(m.text||'').split(/[\s@]/)[0], chat=m.chat.id;
  if(t==='/start'){
   return call('sendMessage',{chat_id:chat,parse_mode:'HTML',reply_markup:play,
    text:'<b>Дежурство</b> — симулятор неотложных состояний.\nСМП, поликлиника, приёмное, ОРИТ. Осмотр, диагностика, лечение по КР МЗ РФ, реанимация, маршрутизация и документы.\n\n'+(url?'Нажмите кнопку ниже или «Играть» слева от поля ввода.':'Игра ещё не подключена: администратору нужно задать WEBAPP_URL.')});
  }
  if(t==='/top'){
   const rows=top().slice(0,15);
   const txt=rows.length?rows.map((r,i)=>`${medal(i)} <b>${esc(r.name)}</b> — ${r.r} (кейсов ${r.c}, средний ${r.a}%)`).join('\n'):'Пока никто не играл.';
   return call('sendMessage',{chat_id:chat,parse_mode:'HTML',text:'<b>Рейтинг</b>\n'+txt,reply_markup:play});
  }
  if(t==='/help') return call('sendMessage',{chat_id:chat,text:'Игра открывается внутри Telegram. Вход — по вашему аккаунту Telegram, прогресс сохраняется на сервере, рейтинг общий для всех игроков. Учебный симулятор, не руководство к лечению реальных пациентов.',reply_markup:play});
 }
 async function handle(u){ try{ if(u&&u.message) await onMsg(u.message); }catch(e){ console.error('Бот:',e.message); } }
 if(hook){
  (async()=>{ await setup(); try{ await call('setWebhook',{url:hook,secret_token:secret,allowed_updates:['message'],drop_pending_updates:false}); console.log('Бот: вебхук установлен'); }
   catch(e){ console.error('Бот: вебхук',e.message); } })();
  return {handle};
 }
 let offset=0;
 async function loop(){
  for(;;){
   try{
    const ups=await call('getUpdates',{offset,timeout:50,allowed_updates:['message']});
    for(const u of ups){ offset=u.update_id+1; if(u.message) onMsg(u.message).catch(e=>console.error('Бот:',e.message)); }
   }catch(e){ console.error('Бот:',e.message); await new Promise(r=>setTimeout(r,5000)); }
  }
 }
 (async()=>{ await setup(); try{ await call('deleteWebhook',{}); }catch(e){} loop(); })();
 return {handle};
};
