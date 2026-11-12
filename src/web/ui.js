// 只读看板：概览 / 群 / 日志 / 她 / 系统
// 没有任何输入框，也不发消息——要看对话去 /groups，要发消息去 QQ。
export function webHtml(token) {
  const t = String(token || "").replace(/[<>&"]/g, "");
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<title>肥鱼 · 看板</title>
<link rel="manifest" href="/manifest.json">
<style>
:root{--bg:#0b0d10;--card:#151a20;--line:#232a33;--fg:#e6edf3;--dim:#8b96a5;--acc:#4da3ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:0 0 70px}
header{position:sticky;top:0;background:rgba(11,13,16,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;align-items:center;gap:10px;z-index:9}
header .t{font-weight:600}
header .s{font-size:12px;color:var(--dim);margin-left:auto}
nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:#10141a;border-top:1px solid var(--line);padding:6px 0 calc(6px + env(safe-area-inset-bottom))}
nav button{flex:1;background:none;border:0;color:var(--dim);font-size:12px;padding:6px 0}
nav button.on{color:var(--acc)}
main{padding:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px}
.k{font-size:12px;color:var(--dim)}
.v{font-size:22px;font-weight:600;margin-top:2px}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row>.card{flex:1 1 45%;margin-bottom:0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.dim{color:var(--dim)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.msg{padding:6px 0;border-bottom:1px solid var(--line)}
.msg .who{color:var(--acc);font-size:12px}
.msg.me .who{color:var(--ok)}
pre{white-space:pre-wrap;word-break:break-all;font-size:12px;margin:0}
.hide{display:none}
</style></head>
<body>
<header><span class="t">肥鱼</span><span class="s" id="hdr">连接中…</span></header>
<main id="main"></main>
<nav>
  <button data-tab="home" class="on">概览</button>
  <button data-tab="groups">群</button>
  <button data-tab="logs">日志</button>
  <button data-tab="her">她</button>
  <button data-tab="sys">系统</button>
</nav>
<script>
const TOKEN = ${JSON.stringify(t)};
const main = document.getElementById('main');
const hdr = document.getElementById('hdr');
let tab = 'home';
async function api(p){
  const r = await fetch(p, { headers: { 'x-webui-token': TOKEN } });
  if(!r.ok) throw new Error(p + ' ' + r.status);
  return r.json();
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function fmt(n){ n=Number(n)||0; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function ago(ts){ if(!ts) return '—'; const d=(Date.now()-ts)/1000; if(d<60) return Math.round(d)+'秒前'; if(d<3600) return Math.round(d/60)+'分钟前'; if(d<86400) return Math.round(d/3600)+'小时前'; return Math.round(d/86400)+'天前'; }

async function renderHome(){
  const s = await api('/api/stats');
  hdr.textContent = s.online ? '在线' : '离线';
  hdr.className = 's ' + (s.online ? 'ok' : 'bad');
  main.innerHTML = \`
    <div class="row">
      <div class="card"><div class="k">今天收到</div><div class="v">\${fmt(s.today.in)}</div></div>
      <div class="card"><div class="k">她说了</div><div class="v">\${fmt(s.today.out)}</div></div>
    </div>
    <div class="card" style="margin-top:10px">
      <div class="k">今天 token（估算）</div>
      <div class="v">\${fmt(s.tokens.input + s.tokens.cache + s.tokens.output)}</div>
      <div class="dim" style="font-size:12px">输入 \${fmt(s.tokens.input)} ｜ 缓存 \${fmt(s.tokens.cache)} ｜ 输出 \${fmt(s.tokens.output)}</div>
    </div>
    <div class="card">
      <div class="k">会话上下文</div>
      <table><tr><th>会话</th><th>token</th></tr>
      \${(s.sessions||[]).map(x=>\`<tr><td class="mono">\${esc(x.key)}</td><td>\${fmt(x.total)}</td></tr>\`).join('') || '<tr><td colspan=2 class="dim">暂无</td></tr>'}
      </table>
    </div>
    <div class="card">
      <div class="k">心情</div>
      <div class="v">\${s.mood.mood} <span class="dim" style="font-size:14px">/100</span></div>
      <div class="dim" style="font-size:12px">\${esc(s.mood.why || '没记为什么')} · \${ago(s.mood.updatedAt)}</div>
    </div>
    <div class="card">
      <div class="k">最近活动</div>
      \${(s.activities||[]).map(a=>\`<div class="msg"><div class="who">\${esc(a.time)} · \${esc(a.kind)}</div><div>\${esc(a.intent)}</div></div>\`).join('') || '<div class="dim">还没做过活动</div>'}
    </div>\`;
}

async function renderGroups(){
  const list = await api('/api/groups');
  main.innerHTML = \`<div class="card"><div class="k">群（按今天消息数）</div>
    <table><tr><th>群</th><th>今天</th><th>她</th><th>最后</th></tr>
    \${list.map(g=>\`<tr data-gid="\${esc(g.gid)}" class="grow"><td>\${esc(g.name||g.gid)}</td><td>\${g.in}</td><td>\${g.out}</td><td class="dim">\${esc(g.last||'')}</td></tr>\`).join('')}
    </table></div><div id="gdetail"></div>\`;
  document.querySelectorAll('.grow').forEach(tr=>tr.onclick=()=>openGroup(tr.dataset.gid));
}
async function openGroup(gid){
  const d = await api('/api/group?id=' + encodeURIComponent(gid));
  const box = document.getElementById('gdetail');
  box.innerHTML = \`<div class="card"><div class="k">\${esc(d.name||gid)} · 最近 \${d.messages.length} 条</div>
    \${d.messages.map(m=>\`<div class="msg \${m.me?'me':''}"><div class="who">\${esc(m.time)} · \${esc(m.who)}\${m.at?' · @她':''}</div><div>\${esc(m.text)}</div></div>\`).join('')}
  </div>\`;
  box.scrollIntoView({behavior:'smooth'});
}

async function renderLogs(){
  const l = await api('/api/logs');
  main.innerHTML = \`
    <div class="card"><div class="k">错误（最近）</div>
      \${l.errors.length? l.errors.map(x=>\`<pre class="bad">\${esc(x)}</pre>\`).join('') : '<div class="dim">没有错误</div>'}</div>
    <div class="card"><div class="k">审计（最近）</div>
      \${l.audit.map(x=>\`<pre>\${esc(x)}</pre>\`).join('') || '<div class="dim">空</div>'}</div>
    <div class="card"><div class="k">运行日志（尾 60 行）</div>
      <pre class="dim">\${esc((l.tail||[]).join('\\n'))}</pre></div>\`;
}

async function renderHer(){
  const h = await api('/api/her');
  main.innerHTML = \`
    <div class="card"><div class="k">心情曲线</div>
      <div class="mono">\${(h.mood.history||[]).slice(-24).map(x=>Math.round(x.mood)).join(' → ') || '—'}</div></div>
    <div class="card"><div class="k">人格（P0 \${h.persona.P0} / P1 \${h.persona.P1} / P2 \${h.persona.P2}）</div>
      \${(h.items||[]).map(i=>\`<div class="msg"><div class="who">\${esc(i.layer)}\${i.archived?' · 已归档':''}</div><div>\${esc(i.text)}</div></div>\`).join('')}</div>
    <div class="card"><div class="k">活动时间线</div>
      \${(h.acts||[]).map(a=>\`<div class="msg"><div class="who">\${esc(a.time)} · \${esc(a.kind)}</div><div>\${esc(a.did)}</div></div>\`).join('') || '<div class="dim">还没做过</div>'}</div>\`;
}

async function renderSys(){
  const s = await api('/api/sys');
  main.innerHTML = \`<div class="card"><div class="k">状态</div>
    <table>
    <tr><td>QQ 连接</td><td class="\${s.online?'ok':'bad'}">\${s.online?'已连':'断开'}</td></tr>
    <tr><td>运行时长</td><td>\${esc(s.uptime)}</td></tr>
    <tr><td>版本</td><td>\${esc(s.version)}</td></tr>
    <tr><td>会话数</td><td>\${s.sessions}</td></tr>
    <tr><td>入队等待</td><td>\${s.pending}</td></tr>
    </table></div>
    <div class="card"><div class="k">配置（只读）</div>
      <table>\${Object.entries(s.cfg).map(([k,v])=>k==='styleHint'? \`<tr><td>\${esc(k)}</td><td class="mono">\${esc(String(v).slice(0,120))}</td></tr>\` : \`<tr><td>\${esc(k)}</td><td class="mono">\${esc(String(v))}</td></tr>\`).join('')}</table></div>\`;
}

const render = {home:renderHome, groups:renderGroups, logs:renderLogs, her:renderHer, sys:renderSys};
async function go(t){
  tab=t; document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on', b.dataset.tab===t));
  main.innerHTML='<div class="dim" style="padding:20px">加载中…</div>';
  try{ await render[t](); }catch(e){ main.innerHTML='<div class="bad" style="padding:20px">'+esc(e.message)+'</div>'; }
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>go(b.dataset.tab));
go('home');
setInterval(()=>{ if(tab==='home') go('home'); }, 20000);
</script>
</body></html>`;
}
