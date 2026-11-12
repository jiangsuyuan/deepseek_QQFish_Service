// 只读看板：概览 / 群 / 日志 / 她 / 系统
// 没有任何输入框，也不发消息——要看对话去「群」，要发消息去 QQ。
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
:root{--bg:#0b0d10;--card:#151a20;--card2:#1b222b;--line:#242c36;--fg:#e6edf3;--dim:#8b96a5;--acc:#4da3ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--pink:#db61a2}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:0 0 72px}
header{position:sticky;top:0;background:rgba(11,13,16,.94);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:12px 14px;display:flex;align-items:center;gap:8px;z-index:9}
header .t{font-weight:600;font-size:16px}
header .s{font-size:12px;margin-left:auto;padding:3px 8px;border-radius:20px;background:var(--card2)}
nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:#0f1319;border-top:1px solid var(--line);padding:6px 0 calc(6px + env(safe-area-inset-bottom));z-index:9}
nav button{flex:1;background:none;border:0;color:var(--dim);font-size:12px;padding:6px 0;display:flex;flex-direction:column;gap:2px;align-items:center}
nav button .ic{font-size:16px;line-height:1}
nav button.on{color:var(--acc)}
main{padding:12px;display:flex;flex-direction:column;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px}
.card h3{margin:0 0 8px;font-size:13px;font-weight:500;color:var(--dim);display:flex;align-items:center;gap:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.kpi{background:var(--card2);border-radius:12px;padding:10px}
.kpi .k{font-size:11px;color:var(--dim)}
.kpi .v{font-size:20px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
.kpi .u{font-size:11px;color:var(--dim);font-weight:400}
.dim{color:var(--dim)}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.acc{color:var(--acc)}
.bar{height:6px;background:#0e1318;border-radius:3px;overflow:hidden;display:flex}
.bar i{display:block;height:100%}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 4px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--dim);font-weight:500;font-size:12px}
tr:last-child td{border-bottom:0}
.msg{padding:7px 0;border-bottom:1px solid var(--line);display:flex;gap:8px}
.msg:last-child{border-bottom:0}
.msg .who{color:var(--acc);font-size:11px;white-space:nowrap;min-width:64px}
.msg.me .who{color:var(--ok)}
.msg .tx{flex:1;word-break:break-word}
.tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:6px;background:var(--card2);color:var(--dim);margin-left:4px}
.chip{display:inline-block;font-size:11px;padding:3px 9px;border-radius:20px;background:var(--card2);color:var(--dim);margin:0 6px 6px 0}
.chip.on{background:#1e3a5f;color:#9dc8ff}
pre{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:11px;margin:0;color:#9aa7b6}
.empty{padding:18px;text-align:center;color:var(--dim);font-size:13px}
.spark{width:100%;height:56px;display:block}
.hr{height:1px;background:var(--line);margin:10px 0}
.small{font-size:12px}
.rowline{display:flex;align-items:center;gap:8px}
.rowline .fill{flex:1}
.pill{padding:2px 8px;border-radius:20px;font-size:11px;background:var(--card2)}
</style></head>
<body>
<header><span class="t">肥鱼</span><span class="s" id="hdr">…</span></header>
<main id="main"></main>
<nav>
  <button data-tab="home" class="on"><span class="ic">◎</span>概览</button>
  <button data-tab="groups"><span class="ic">▤</span>群</button>
  <button data-tab="logs"><span class="ic">≣</span>日志</button>
  <button data-tab="her"><span class="ic">☺</span>她</button>
  <button data-tab="sys"><span class="ic">⚙</span>系统</button>
</nav>
<script>
const TOKEN = ${JSON.stringify(t)};
const main = document.getElementById('main');
const hdr = document.getElementById('hdr');
let tab = 'home';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e8) return (n/1e8).toFixed(2)+'亿'; if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(1)+'k'; return String(n); };
const ago = (ts) => { if (!ts) return '—'; const d = (Date.now()-ts)/1000; if (d<60) return Math.round(d)+'秒前'; if (d<3600) return Math.round(d/60)+'分钟前'; if (d<86400) return Math.round(d/3600)+'小时前'; return Math.round(d/86400)+'天前'; };
async function api(p){
  const url = p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN);
  const r = await fetch(url, { headers: { 'x-webui-token': TOKEN } });
  if (r.status === 429) throw new Error('被限流锁定了：等一会儿，或重启 dsh-web');
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return r.json();
}
function spark(el, values, color){
  const max = Math.max(1, ...values);
  const w = 100, h = 30;
  const pts = values.map((v,i)=> (i/(values.length-1||1))*w + ',' + (h - (v/max)*h)).join(' ');
  el.innerHTML = '<svg class="spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
    + '<polyline fill="none" stroke="'+color+'" stroke-width="1.6" points="'+pts+'"/></svg>';
}

async function renderHome(){
  const s = await api('/api/stats');
  const c = s.context || { total: 0, sessions: 0 };
  const m = s.mood || { mood: 70, why: '', updatedAt: 0 };
  const t = s.today || { in: 0, out: 0, groups: 0, hourly: [] };
  const y = s.yesterday || { in: 0, out: 0 };
  const delta = (nowV, oldV) => {
    if (!oldV) return '';
    const pct = Math.round((nowV - oldV) / oldV * 100);
    if (!pct) return '';
    const up = pct > 0;
    return '<span class="u" style="color:' + (up ? 'var(--ok)' : 'var(--dim)') + '"> ' + (up ? '↑' : '↓') + Math.abs(pct) + '%</span>';
  };
  hdr.textContent = s.online ? '在线' : '离线';
  hdr.className = 's ' + (s.online ? 'ok' : 'bad');
  const hourly = (t.hourly || []).map(x => x.in);
  const moodColor = m.mood >= 70 ? 'var(--ok)' : m.mood >= 45 ? 'var(--warn)' : 'var(--bad)';
  main.innerHTML = ''
    + '<div class="grid3">'
    +   '<div class="kpi"><div class="k">今日收到</div><div class="v">'+fmt(t.in)+delta(t.in, y.in)+'</div></div>'
    +   '<div class="kpi"><div class="k">她说了</div><div class="v">'+fmt(t.out)+delta(t.out, y.out)+'</div></div>'
    +   '<div class="kpi"><div class="k">活跃群</div><div class="v">'+fmt(t.groups)+'</div></div>'
    + '</div>'
    + '<div class="card"><h3>今天的消息</h3><div id="sp1"></div>'
    +   '<div class="small dim" style="margin-top:4px">每小时收到的条数（0–23 点）</div></div>'
    + '<div class="grid2">'
    +   '<div class="kpi"><div class="k">上下文合计</div><div class="v">'+fmt(c.total)+'<span class="u"> · '+c.sessions+' 会话</span></div></div>'
    +   '<div class="kpi"><div class="k">心情</div><div class="v" style="color:'+moodColor+'">'+Math.round(m.mood)+'<span class="u"> /100</span></div></div>'
    + '</div>'
    + '<div class="card"><h3>会话上下文（每轮重读的量）</h3>'
    +   (s.sessions && s.sessions.length ? '<table>' + s.sessions.map(x =>
          '<tr><td class="mono">'+esc(x.key)+'</td><td class="dim" style="white-space:nowrap">'+fmt(x.total)+'</td></tr>').join('') + '</table>'
        : '<div class="empty">暂无</div>')
    + '</div>'
    + '<div class="card"><h3>她今天在哪说话</h3>'
    +   (s.lastHer ? '<div class="small dim" style="margin-bottom:6px">最后一句：'+esc(ago(s.lastHer.at))+'（群 '+esc(s.lastHer.gid)+'）</div>' : '<div class="empty">今天还没说话</div>')
    +   ((s.herByGroup||[]).length ? '<table>' + s.herByGroup.map(g =>
          '<tr><td class="mono">'+esc(g.gid)+'</td><td style="text-align:right" class="ok">'+g.n+' 条</td></tr>').join('') + '</table>' : '')
    + '</div>'
    + '<div class="card"><h3>最近活动</h3>'
    +   (s.activities && s.activities.length ? s.activities.map(a =>
          '<div class="msg"><div class="who">'+esc(a.time)+'</div><div class="tx">'+esc(a.intent||'')+'<span class="tag">'+esc(a.kind)+'</span></div></div>').join('')
        : '<div class="empty">还没做过活动</div>')
    + '</div>';
  const sp = document.getElementById('sp1');
  if (sp) spark(sp, hourly.length ? hourly : new Array(24).fill(0), '#4da3ff');
}

async function renderGroups(){
  const list = await api('/api/groups');
  const total = list.reduce((a,b)=>a+b.in,0) || 1;
  main.innerHTML = '<div class="card"><h3>群 · 今天</h3>'
    + (list.length ? '<table><tr><th>群</th><th>今日</th><th>她</th></tr>' + list.map(g =>
        '<tr data-gid="'+esc(g.gid)+'" class="grow"><td>'
        + '<div>'+esc(g.name || g.gid)+'</div>'
        + '<div class="small dim" style="margin-top:3px">'+esc(g.last||'')+'</div></td>'
        + '<td style="width:88px"><div class="small">'+g.in+'</div>'
        + '<div class="bar" style="margin-top:4px"><i style="width:'+Math.round(g.in/total*100)+'%;background:#4da3ff"></i></div></td>'
        + '<td style="width:52px" class="dim">'+fmt(g.week||0)+'</td>'
        + '<td style="width:44px" class="'+(g.out?'ok':'dim')+'">'+g.out+'</td></tr>').join('') + '</table>'
      : '<div class="empty">今天还没有群消息</div>')
    + '</div><div id="gdetail"></div>';
  document.querySelectorAll('.grow').forEach(tr => tr.onclick = () => openGroup(tr.dataset.gid));
}
async function openGroup(gid){
  const box = document.getElementById('gdetail');
  box.innerHTML = '<div class="card"><div class="empty">读取 ' + esc(gid) + ' …</div></div>';
  const d = await api('/api/group?id=' + encodeURIComponent(gid));
  box.innerHTML = '<div class="card"><h3>'+esc(d.name || d.gid)+' · 最近 '+d.messages.length+' 条</h3>'
    + (d.messages.length ? d.messages.map(m =>
        '<div class="msg '+(m.me?'me':'')+'"><div class="who">'+esc(m.who)+'<br><span class="dim" style="font-size:10px">'+esc(m.time)+'</span></div>'
        + '<div class="tx">'+esc(m.text)+(m.at?'<span class="tag">@她</span>':'')+'</div></div>').join('')
      : '<div class="empty">今天没有消息</div>')
    + '</div>';
  box.scrollIntoView({ behavior: 'smooth' });
}

async function renderLogs(){
  const l = await api('/api/logs');
  const kinds = Object.entries(l.kinds || {}).sort((a,b)=>b[1]-a[1]).slice(0,12);
  main.innerHTML = '<div class="card"><h3>审计类型（最近 400 条）</h3>'
    + (kinds.length ? kinds.map(([k,n]) => '<span class="chip">'+esc(k)+' '+n+'</span>').join('') : '<div class="empty">空</div>')
    + '</div><div class="card"><h3>错误</h3>'
    + (l.errors && l.errors.length ? l.errors.map(x => '<pre class="bad" style="margin-bottom:6px">'+esc(x)+'</pre>').join('') : '<div class="empty">没有错误</div>')
    + '</div>'
    + '<div class="card"><h3>审计</h3>'
    + (l.audit && l.audit.length ? l.audit.map(x => '<pre style="margin-bottom:6px">'+esc(x)+'</pre>').join('') : '<div class="empty">空</div>')
    + '</div>'
    + '<div class="card"><h3>运行日志</h3><pre>'+(l.tail||[]).map(esc).join('\\n')+'</pre></div>';
}

async function renderHer(){
  const h = await api('/api/her');
  const p = h.persona || { P0:0, P1:0, P2:0 };
  const a = h.archived || { P0:0, P1:0, P2:0 };
  const m = h.mood || { mood: 70, history: [] };
  const items = h.items || [];
  const layer = (L, title) => {
    const rows = items.filter(x => x.layer === L);
    return '<div class="card"><h3>'+title+' · '+rows.length+' 条'+(a[L]?'（另 '+a[L]+' 条已归档）':'')+'</h3>'
      + (rows.length ? rows.map(x => '<div class="msg"><div class="tx">'+esc(x.text)+'</div></div>').join('') : '<div class="empty">空的</div>')
      + '</div>';
  };
  const hist = (m.history || []).map(x => Math.round(Number(x.mood) || 0));
  main.innerHTML = ''
    + '<div class="card"><h3>心情</h3><div class="rowline">'
    +   '<div class="v" style="font-size:28px;font-weight:600">'+Math.round(m.mood)+'</div>'
    +   '<div class="fill small dim">'+esc(m.why || '没记为什么')+'<br>'+ago(m.updatedAt)+'</div></div>'
    +   (hist.length ? '<div id="spm"></div>' : '')
    + '</div>'
    + '<div class="card"><h3>认同层的构成</h3>'
    +   (h.types ? Object.entries(h.types).sort((a,b)=>b[1]-a[1]).map(([k,n]) => '<span class="chip">'+esc(k)+' '+n+'</span>').join('') : '<div class="empty">空</div>')
    +   (h.moodWeek ? '<div class="hr"></div><div class="small dim">最近 7 天心情：'+h.moodWeek.n+' 次记录，最低 '+h.moodWeek.min+'、最高 '+h.moodWeek.max+'、平均 '+h.moodWeek.avg+'</div>' : '')
    + '</div>'
    + layer('P0', 'P0 身份')
    + layer('P1', 'P1 底色')
    + layer('P2', 'P2 认同')
    + '<div class="card"><h3>活动时间线</h3>'
    + ((h.acts||[]).length ? (h.acts||[]).map(x =>
        '<div class="msg"><div class="who">'+esc(x.time)+'</div><div class="tx">'+esc(x.did)+'<span class="tag">'+esc(x.kind)+'</span></div></div>').join('')
      : '<div class="empty">还没做过</div>')
    + '</div>';
  const sp = document.getElementById('spm');
  if (sp && hist.length) spark(sp, hist, '#db61a2');
}

async function renderSys(){
  const s = await api('/api/sys');
  const cfg = s.cfg || {};
  main.innerHTML = '<div class="card"><h3>状态</h3><table>'
    + '<tr><td>QQ 连接</td><td class="'+(s.online?'ok':'bad')+'" style="text-align:right">'+(s.online?'已连':'断开')+'</td></tr>'
    + '<tr><td>运行</td><td style="text-align:right">'+esc(s.uptime)+'</td></tr>'
    + '<tr><td>版本</td><td style="text-align:right" class="mono">'+esc(s.version)+'</td></tr>'
    + '<tr><td>会话</td><td style="text-align:right">'+s.sessions+'</td></tr>'
    + '<tr><td>排队</td><td style="text-align:right">'+s.pending+'</td></tr>'
    + '</table></div>'
    + '<div class="card"><h3>能力</h3><table>'
    + Object.entries(s.caps || {}).map(([k,v]) => '<tr><td>'+esc(k)+'</td><td style="text-align:right" class="'+(v?'ok':'dim')+'">'+(v?'开':'关')+'</td></tr>').join('')
    + '</table></div>'
    + '<div class="card"><h3>配置（只读）</h3><table>'
    + Object.keys(cfg).map(k => '<tr><td class="mono">'+esc(k)+'</td><td class="mono dim" style="text-align:right;word-break:break-all">'+esc(String(cfg[k]).slice(0,90))+'</td></tr>').join('')
    + '</table></div>';
}

const render = { home: renderHome, groups: renderGroups, logs: renderLogs, her: renderHer, sys: renderSys };
async function go(t){
  tab = t;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  main.innerHTML = '<div class="empty">加载中…</div>';
  try { await render[t](); }
  catch (e) { main.innerHTML = '<div class="card"><div class="bad">'+esc(e.message)+'</div></div>'; }
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
go('home');
setInterval(() => { if (tab === 'home') go('home'); }, 30000);
</script>
</body></html>`;
}
