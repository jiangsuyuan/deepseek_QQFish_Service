import { readFileSync } from "node:fs";
// Web 界面 HTML。

function webHtml(token) {
    // 读 NapCat 的 WebUI token（用来拼「QQ 登录」链接）
    let napcatToken = "";
    try {
      const p = "/root/Napcat/opt/QQ/resources/app/app_launcher/napcat/config/webui.json";
      const j = JSON.parse(readFileSync(p, "utf8"));
      napcatToken = String(j?.token ?? "");
    } catch {
      // 读不到就让链接空着
    }
    const napcatJs = JSON.stringify(napcatToken);
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>肥鱼</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1115; --fg:#e6e6e6; --muted:#8b93a1;
  --line:#23262d; --card:#1a1d24; --card2:#1e222a;
  --me:#2563eb; --her:#1e222a; --her-fg:#e6e6e6;
  --accent:#7cc4ff; --input:#1a1d24; --input-line:#2a2e38;
}
body.light{
  --bg:#f6f7f9; --fg:#1f2328; --muted:#6b7280;
  --line:#e3e6ea; --card:#ffffff; --card2:#ffffff;
  --me:#2563eb; --her:#ffffff; --her-fg:#1f2328;
  --accent:#0969da; --input:#ffffff; --input-line:#d6dae0;
}
body{font:15px/1.6 -apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);
  /* 手机：100vh 含地址栏高度会溢出，用 dvh；再用 --app-h 兜底（键盘弹起时由 JS 改写） */
  height:100vh;height:100dvh;height:var(--app-h,100dvh);
  display:flex;flex-direction:column;overscroll-behavior-y:contain}
/* 关掉移动端点击高亮和长按选择（气泡/按钮更像原生） */
*{-webkit-tap-highlight-color:transparent}
#log,#live{-webkit-overflow-scrolling:touch}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex:none}
h1{font-size:15px;font-weight:600}
#pg{margin-left:auto;font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--input-line);border-radius:12px;padding:3px 10px}
#pg:hover{background:var(--card)}
#qq{font-size:13px;color:#f0a020;text-decoration:none;border:1px solid var(--input-line);border-radius:12px;padding:3px 10px}
#qq:hover{background:var(--card)}
#qq.warn{color:#f87171;border-color:#7f1d1d}
#theme{font-size:15px;background:none;border:0;cursor:pointer;color:var(--muted);padding:2px 6px;line-height:1}
#theme:hover{color:var(--fg)}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80}
.dot.off{background:#f87171}
#live{display:none;flex:none;padding:8px 12px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);max-height:110px;overflow-y:auto;line-height:1.6}
#live.on{display:block}
#live .l{opacity:.85}
#live .l b{color:var(--accent);font-weight:500}
#btns{display:none;flex:none;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--line)}
#btns.on{display:flex}
#btns button{background:var(--card2);border:1px solid var(--input-line);color:var(--fg);border-radius:14px;padding:4px 12px;font:13px inherit;cursor:pointer}
#btns button:hover{background:var(--line);border-color:var(--muted)}
#log{flex:1 1 0;min-height:140px;overflow-y:auto;padding:16px 16px 34px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:80%;padding:8px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.me{align-self:flex-end;background:var(--me);color:#fff;border-bottom-right-radius:4px}
.her{align-self:flex-start;background:var(--her);color:var(--her-fg);border-bottom-left-radius:4px}
.tool{align-self:flex-start;font-size:11px;padding:2px 10px;border-radius:10px;margin:1px 0 1px 4px;font-weight:500}
/* 夜间：高饱和的深色底 + 亮色字，不要灰 */
.t-chat{background:#1e4d7a;color:#a6dbff}
.t-mem{background:#452a70;color:#d8bcff}
.t-self{background:#1d5138;color:#96e8bb}
.t-code{background:#5c3917;color:#ffd39a}
.t-want{background:#5e2544;color:#ffb0cd}
.t-net{background:#154e4e;color:#96e8e8}
.t-draw{background:#3d2b70;color:#c9b4ff}
.t-other{background:#2f3a5e;color:#b6c6f0}
/* 日间：淡但依然有色相，不灰 */
body.light .t-chat{background:#cfe8ff;color:#0a4d91}
body.light .t-mem{background:#e8dbff;color:#5b2fa8}
body.light .t-self{background:#cdf5dd;color:#15703f}
body.light .t-code{background:#ffe6c4;color:#8a4b00}
body.light .t-want{background:#ffd9e7;color:#a01d54}
body.light .t-net{background:#c9f2f2;color:#0d6363}
body.light .t-draw{background:#e0d4ff;color:#4a2fa8}
body.light .t-other{background:#dde4f7;color:#3a4a75}
footer{padding:12px;padding-bottom:calc(12px + env(safe-area-inset-bottom,0px));
  border-top:1px solid var(--line);display:flex;gap:8px;flex:none;
  padding-left:calc(12px + env(safe-area-inset-left,0px));
  padding-right:calc(12px + env(safe-area-inset-right,0px))}
/* 窄屏（手机竖屏）：缩间距、按钮矮一点、输入框字号 ≥16px 防 iOS 聚焦放大 */
@media (max-width:480px){
  body{font-size:15px}
  #log{padding:12px 12px 24px;gap:8px}
  footer{padding:8px;gap:6px;padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}
  footer textarea{padding:8px 10px !important;font-size:16px !important}
  #send,#imgBtn{padding:0 12px !important;font-size:14px !important;height:38px !important}
  #imgBtn{margin-right:2px !important}
  header{padding:8px 12px !important}
  header h1{font-size:14px !important}
  .msg{font-size:15px;padding:8px 11px !important}
}
/* 横屏/平板：别把气泡拉太宽 */
@media (min-width:768px){ .msg{max-width:80%} }
#in{flex:1;background:var(--input);border:1px solid var(--input-line);color:var(--fg);border-radius:8px;padding:10px 12px;font:inherit;resize:none;height:44px}
#send{background:var(--me);border:0;color:#fff;border-radius:8px;padding:0 18px;font:inherit;cursor:pointer}
#send:disabled{opacity:.5}
.mk{display:inline-block;font-size:10px;line-height:1;padding:3px 5px;border-radius:4px;
  background:#ffc747;color:#5c3a00;margin:0 6px 4px 0;vertical-align:middle;font-weight:600}
.imgov{position:fixed;inset:0;background:rgba(0,0,0,.88);display:flex;align-items:center;
  justify-content:center;z-index:99;padding:16px;cursor:zoom-out}
.imgov img{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.6)}
#imgBtn{background:var(--card);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:0 12px;font:inherit;cursor:pointer;margin-right:6px}
#imgBtn:hover{border-color:var(--me)}
</style></head><body>
<header><span class="dot" id="dot"></span><h1>肥鱼</h1><a id="qq" href="#" target="_blank" rel="noopener" title="扫码登录 QQ（NapCat WebUI）">QQ 登录</a><span id="st" style="font-size:12px;color:#8b93a1"></span><a id="pg" href="/pages?token=${encodeURIComponent(token)}" target="_blank">页面</a><button id="theme" title="切换日夜">☾</button></header>
<div id="live"></div>
<div id="log"></div>
<footer><textarea id="in" placeholder="说点什么…（Enter 发送，Shift+Enter 换行，可 Ctrl+V 贴图）"></textarea><button id="imgBtn" title="发一张图给她">图</button><input type="file" id="pickImg" accept="image/*" style="display:none"><button id="send">发送</button></footer>
<script>
const T=${JSON.stringify(token)}, log=document.getElementById('log'),
      inp=document.getElementById('in'), btn=document.getElementById('send'),
      dot=document.getElementById('dot'), st=document.getElementById('st');
function linkify(el,text){
  // 把 /page/xxx 或 http://host:port/page/xxx 变成可点链接（并纠正端口到当前 WebUI）
  const re=new RegExp('(?:https?:[/][/][^\\s]+)?[/]page[/]([a-z0-9]+)','gi');
  let last=0, m;
  el.textContent='';
  while((m=re.exec(text))!==null){
    if(m.index>last) el.appendChild(document.createTextNode(text.slice(last,m.index)));
    const a=document.createElement('a');
    a.href='/page/'+m[1]+'?token='+T;
    a.target='_blank';
    a.textContent='打开页面';
    a.style.color='#7cc4ff';
    el.appendChild(a);
    last=m.index+m[0].length;
  }
  if(last<text.length) el.appendChild(document.createTextNode(text.slice(last)));
}
function add(cls,text){
  const d=document.createElement('div');d.className='msg '+cls;
  if(cls==='her'&&new RegExp('[/]page[/][a-z0-9]+','i').test(text)) linkify(d,text); else d.textContent=text;
  log.appendChild(d);log.scrollTop=log.scrollHeight;return d
}
// 工具中文名（后端也会带，这里兜底）
const TOOL_ZH={
  send_sticker:"发表情",list_stickers:"看表情库",save_sticker:"存表情",send_face:"发小黄脸",
  at_person:"艾特别人",draw_image:"画图",draw_svg:"画SVG",web_search:"搜网",web_fetch:"读网页",
  hot_news:"查热点",recall:"翻旧对话",remember_fact:"记事实",remember_person:"记人物",
  remember_self:"记想法",revise_self:"改想法",forget_self:"忘想法",my_memory:"查记忆",
  memory_index:"看记忆目录",my_digest:"看近期摘要",person_dossier:"查人物档案",
  group_recap:"看群记录",who_said:"查谁说的",view_avatar:"看头像",my_status:"看状态",
  my_activities:"看活动记录",my_adventures:"看探险记录",my_capabilities:"看能力清单",
  my_changelog:"看更新日志",my_source:"看源码片段",my_outages:"看掉线记录",my_schedule:"看排期",
  exec_sandbox:"跑代码",read_source:"读源码",note_want:"记需求",my_wants:"看需求本",
  resolve_want:"标记需求完成",drop_want:"删需求",request_feature:"申请功能",
  render_page:"做网页",add_webui_button:"加按钮",remove_webui_button:"删按钮",
  read_forward_more:"展开转发",refuse_person:"拒聊",owner_commands:"查指令清单",
  remember:"记东西",memory:"查记忆",search:"搜索",read:"读东西",write:"写东西",
  run_activity:"开始活动",set_reminder:"设提醒",group_impressions:"看群印象",
  my_thoughts:"看我的想法",
  write_notebook:"写本子",
  read_notebook:"翻本子",
  read_pdf:"读PDF",
  propose_patch:"提改动申请",
  my_patch_proposals:"看改动申请",patch_guide:"看申请写法",zhihu_daily:"看知乎日报",news_now:"看热榜",sandbox_files:"管沙箱文件",read_page:"读网页正文",files:"管文件",notify_owner:"主动找他",audit_self:"审视自己",
  note_file:"建文件",read_note:"读文件",list_notes:"看文件区"
};
// 分类颜色
const TOOL_KIND={
  send_sticker:"chat",list_stickers:"chat",save_sticker:"chat",send_face:"chat",at_person:"chat",
  draw_image:"draw",draw_svg:"draw",render_page:"draw",
  my_memory:"mem",memory_index:"mem",my_digest:"mem",recall:"mem",remember_fact:"mem",
  remember_person:"mem",remember_self:"mem",revise_self:"mem",forget_self:"mem",
  person_dossier:"mem",group_recap:"mem",who_said:"mem",view_avatar:"mem",
  my_status:"self",my_activities:"self",my_adventures:"self",my_capabilities:"self",
  my_changelog:"self",my_source:"self",my_outages:"self",my_schedule:"self",
  exec_sandbox:"code",read_source:"code",
  note_want:"want",my_wants:"want",resolve_want:"want",drop_want:"want",request_feature:"want",
  owner_commands:"self",
  web_search:"net",web_fetch:"net",hot_news:"net",
  write_notebook:"mem",
  read_notebook:"mem",
  read_pdf:"mem",
  propose_patch:"code",patch_guide:"code",zhihu_daily:"net",news_now:"net",sandbox_files:"code",read_page:"net",files:"code",notify_owner:"chat",audit_self:"self",
  note_file:"note",read_note:"note",list_notes:"note",
  my_patch_proposals:"code",
  run_activity:"self",
  set_reminder:"self",
  group_impressions:"mem",
  my_thoughts:"mem"
};
function addTool(name){
  // 注意：这里在模板字符串里，正则的 \[ \] 会被吃掉，只能用字符串操作
  let raw=String(name||'').trim();
  if(raw.startsWith('[')) raw=raw.slice(1);
  if(raw.endsWith(']')) raw=raw.slice(0,-1);
  raw=raw.trim();
  // 没配中文名的也别露出英文（界面里不该出现技术名词）
  let zh=TOOL_ZH[raw];
  if(!zh){
    zh=/^[a-z0-9_]+$/i.test(raw) ? '某个操作' : raw;
  }
  const kind=TOOL_KIND[raw]||'other';
  const d=document.createElement('div');
  d.className='tool t-'+kind;
  d.textContent=zh;
  log.appendChild(d);log.scrollTop=log.scrollHeight;
}
let typing=null;
function setTyping(on){if(on&&!typing){typing=add('her','…');}else if(!on&&typing){typing.remove();typing=null;}}
// 日夜切换（记在 localStorage）
const themeBtn=document.getElementById('theme');
function applyTheme(t){
  if(t==='light'){document.body.classList.add('light');themeBtn.textContent='☀';}
  else{document.body.classList.remove('light');themeBtn.textContent='☾';}
}
try{applyTheme(localStorage.getItem('fish-theme')||'dark');}catch(e){applyTheme('dark');}
themeBtn.onclick=()=>{
  const now=document.body.classList.contains('light')?'dark':'light';
  applyTheme(now);
  try{localStorage.setItem('fish-theme',now);}catch(e){}
};

const live=document.getElementById('live');
function addLive(d){
  live.className='on';
  const el=document.createElement('div');el.className='l';
  if(d.time){
    const t=document.createElement('span');
    t.textContent=d.time+' ';
    t.style.color='var(--muted)';t.style.fontVariantNumeric='tabular-nums';
    el.appendChild(t);
  }
  const b=document.createElement('b');b.textContent=(d.kind?({explore:'出门',read:'读书',play:'玩',think:'想事',write:'写',recall:'整理记忆',dream:'想以后',study:'研究代码'}[d.kind]||d.kind):'')+' ';
  el.appendChild(b);el.appendChild(document.createTextNode(d.text||''));
  live.appendChild(el);
  while(live.children.length>3) live.removeChild(live.firstChild);
  live.scrollTop=live.scrollHeight;
}
fetch('/activities?token='+T).then(r=>r.json()).then(list=>{
  if(!Array.isArray(list)||!list.length) return;
  live.className='on';
  for(const a of list.slice(0,3).reverse()) addLive({kind:a.kind,text:a.intent||a.did,time:a.time});
}).catch(()=>{});
// 刚本地显示过的消息，等后端 SSE 回推同一句时跳过，避免显示两份
let pendingMeText = "";

// 快捷入口不放在聊天页（占地方），统一放到右上角「页面」里

fetch('/history?token='+T).then(r=>r.ok?r.json():r.json().then(e=>Promise.reject(e))).then(list=>{
  if(!Array.isArray(list)) return;
  for(const m of list){
    if(m.image){
      const wrap=document.createElement('div');wrap.className='msg her';
      const img=document.createElement('img');img.src=m.image+'?token='+T;
      img.style.maxWidth='200px';img.style.borderRadius='8px';img.style.display='block';
      wrap.appendChild(img);log.appendChild(wrap);
    }
    else if(m.role==='me') add('me',m.text||'');
    else if(m.role==='tool') addTool(m.text||'');
    else add('her',m.text||'');
  }
}).catch(function(e){
  // 以前这里没有 catch：读失败了页面就是一片空白，看着像"没有历史"
  addTool('历史读取失败：'+((e&&e.error)||(e&&e.message)||'接口异常')+'（不是没有记录，是读不出来）');
});
// QQ 登录：NapCat WebUI（6099），用当前页面的 host 拼
(function(){
  var qq=document.getElementById('qq');
  if(!qq) return;
  var nt=${napcatJs};
  if(!nt){ qq.textContent='QQ 登录'; qq.href='#'; qq.title='没读到 NapCat token'; qq.onclick=function(e){e.preventDefault();alert('没读到 NapCat 的 webui.json，无法生成登录链接');}; return; }
  var host=location.hostname||'127.0.0.1';
  qq.href='http://'+host+':6099/webui?token='+encodeURIComponent(nt);
  qq.title='扫码登录 QQ（新窗口打开 NapCat WebUI）';
})();
const es=new EventSource('/stream?token='+T);
es.onopen=()=>{dot.className='dot';st.textContent='在线';};
es.onerror=()=>{dot.className='dot off';st.textContent='断线重连中…';};
es.onmessage=e=>{
  const d=JSON.parse(e.data);
  if(d.role==='tool'){addTool(d.text);return;}
  if(d.role==='activity'){addLive(d);return;}
  if(d.role==='typing'){setTyping(d.on);return;}
  setTyping(false);

  const isMe = d.role==='me';
  const t = String(d.text||'');

  // 本地刚显示过的文本跳过（否则显示两份）—— 但有图时不能整条丢掉
  if(isMe && t && pendingMeText && (t===pendingMeText || t.includes(pendingMeText))){
    pendingMeText='';
    if(!d.image) return;
  }

  // 有图：图和文字一起渲染（以前只在 her 分支画图，主人的图直接不显示）
  if(d.image){
    const wrap=document.createElement('div');
    wrap.className='msg '+(isMe?'me':'her');
    if(d.via==='assistant'){
      const mk=document.createElement('span');mk.className='mk';mk.textContent='助手';
      wrap.appendChild(mk);
    }
    const img=document.createElement('img');
    img.src=d.image+'?token='+T;
    img.style.maxWidth='200px';img.style.borderRadius='8px';img.style.display='block';
    img.loading='lazy';
    img.onclick=function(){
      const ov=document.createElement('div');ov.className='imgov';
      const big=document.createElement('img');big.src=img.src;
      ov.appendChild(big);
      ov.onclick=function(){ document.body.removeChild(ov); };
      document.body.appendChild(ov);
    };
    wrap.appendChild(img);
    if(t.trim()){
      const tx=document.createElement('div');
      tx.style.marginTop='6px';
      tx.textContent=t;
      wrap.appendChild(tx);
    }
    log.appendChild(wrap);log.scrollTop=log.scrollHeight;
    return;
  }

  if(isMe){
    const el=add('me',t);
    if(d.via==='assistant' && el){
      const mk=document.createElement('span');mk.className='mk';mk.textContent='助手';
      el.insertBefore(mk, el.firstChild);
    }
    return;
  }
  add('her',t);
};
// 发图：读文件转 base64（也支持粘贴）
async function sendImage(fileOrBlob, name){
  if(!fileOrBlob) return;
  if(fileOrBlob.size > 8*1024*1024){ addTool('图片超过 8MB'); return; }
  const cap = inp.value.trim();
  inp.value='';
  btn.disabled=true; if(imgBtnEl) imgBtnEl.disabled=true;
  try{
    const b64 = await new Promise((res,rej)=>{
      const fr=new FileReader();
      fr.onload=()=>{
        const r=String(fr.result||'');
        const i=r.indexOf(',');
        res(i>=0?r.slice(i+1):r);
      };
      fr.onerror=rej;
      fr.readAsDataURL(fileOrBlob);
    });
    const mime = fileOrBlob.type || 'image/png';
    add('me', cap ? ('［图］'+cap) : '［图］');
    await fetch('/send?token='+T,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({text:cap, image:'data:'+mime+';base64,'+b64, imageName:name||'粘贴的图'})
    });
  }catch(e){ addTool('发图失败：'+e.message); }
  setTimeout(()=>{ btn.disabled=false; if(imgBtnEl) imgBtnEl.disabled=false; },800);
}

async function send(from){
  if(typeof from!=='string') from='';
  const t=inp.value.trim(); if(!t) return;
  inp.value=''; btn.disabled=true;
  if(from&&from.startsWith('button:')){
    const d=document.createElement('div');d.className='msg me';
    const tag=document.createElement('span');
    tag.textContent='['+from.slice(7)+'] ';
    tag.style.opacity='.65';tag.style.fontSize='12px';
    d.appendChild(tag);d.appendChild(document.createTextNode(t));
    log.appendChild(d);log.scrollTop=log.scrollHeight;
  } else { add('me',t); pendingMeText=t; }
  try{
    await fetch('/send?token='+T,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t,from:from||''})});
  }catch(e){addTool('发送失败：'+e.message);}
  setTimeout(()=>btn.disabled=false,600);
}
btn.onclick=()=>send();

// ── 手机键盘适配：键盘弹起时 visualViewport 变矮，把页面高度跟着改，
//    输入框才不会被顶出屏幕（安卓 Chrome 尤其明显）──
(function fitMobile(){
  var vv = window.visualViewport;
  function apply(){
    var h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty('--app-h', h + 'px');
    // 键盘开着时把聊天区滚到底，免得看不到刚发的
    if (vv && vv.height < window.innerHeight - 120) {
      var logEl = document.getElementById('log');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  }
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', function(){ setTimeout(apply, 220); });
  apply();
})();

// ── Service Worker：只在 HTTPS 下注册（HTTP 下浏览器不允许，静默跳过）──
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js?token='+encodeURIComponent(T), { scope: '/' })
    .catch(function(){ /* 没 sw.js 或注册失败都不影响用 */ });
}

const imgBtnEl=document.getElementById('imgBtn');
const pickImgEl=document.getElementById('pickImg');
if(imgBtnEl&&pickImgEl){
  imgBtnEl.onclick=()=>pickImgEl.click();
  pickImgEl.onchange=()=>{
    const f=pickImgEl.files&&pickImgEl.files[0];
    pickImgEl.value='';
    if(f) sendImage(f,f.name);
  };
}
// Ctrl+V 贴图
inp.addEventListener('paste',e=>{
  try{
    const items=(e.clipboardData||{}).items||[];
    for(const it of items){
      if(it.type&&it.type.indexOf('image/')===0){
        const f=it.getAsFile();
        if(f){ e.preventDefault(); sendImage(f,'粘贴的图'); return; }
      }
    }
  }catch{}
});

inp.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
</script></body></html>`;
  }

export { webHtml };
