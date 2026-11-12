// 只读看板：概览 / 群 / 她 / 记录 / 系统
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
nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:#0f1319;border-top:1px solid var(--line);padding:6px 0 calc(6px + env(safe-area-inset-bottom));z-index:9}
nav button{flex:1;background:none;border:0;color:var(--dim);font-size:12px;padding:6px 0;display:flex;flex-direction:column;gap:2px;align-items:center}
nav button .ic{font-size:16px;line-height:1}
nav button.on{color:var(--acc)}
main{padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}
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
.msg .who{color:var(--acc);font-size:11px;white-space:nowrap;min-width:60px}
.msg.me .who{color:var(--ok)}
.msg .tx{flex:1;word-break:break-word}
.tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:6px;background:var(--card2);color:var(--dim);margin-left:4px}
.chip{display:inline-block;font-size:11px;padding:3px 9px;border-radius:20px;background:var(--card2);color:var(--dim);margin:0 6px 6px 0}
pre{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:11px;margin:0;color:#9aa7b6}
.empty{padding:18px;text-align:center;color:var(--dim);font-size:13px}
.spark{width:100%;height:56px;display:block}
.hr{height:1px;background:var(--line);margin:10px 0}
.small{font-size:12px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--dim)}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.rowline{display:flex;align-items:center;gap:10px}
.rowline .fill{flex:1}
.chips{display:flex;gap:6px;overflow-x:auto;padding:2px 0 6px}
.chips::-webkit-scrollbar{display:none}
.chips b{font-weight:500;font-size:12px;padding:5px 11px;border-radius:20px;background:var(--card2);color:var(--dim);white-space:nowrap}
.chips b.on{background:#1e3a5f;color:#9dc8ff}
.step3{display:grid;grid-template-columns:30px 1fr;gap:8px;margin:6px 0}
.step3 .n{font-size:11px;color:var(--dim);text-align:center;padding-top:3px}
.step3 .b{background:var(--card2);border-radius:10px;padding:8px;white-space:pre-wrap;word-break:break-word}
.step3 .lbl{font-size:10px;color:var(--dim);margin-bottom:2px}
.turn{display:flex;flex-direction:column;margin:8px 0}
.turn.me{align-items:flex-end}
.turn.her{align-items:flex-start}
.bub{max-width:82%;padding:8px 11px;border-radius:14px;background:var(--card2);white-space:pre-wrap;word-break:break-word}
.turn.me .bub{background:#1e3a5f}
.turn .twho{font-size:10px;color:var(--dim);margin-top:3px}
.tile{background:var(--card2);border-radius:12px;padding:14px 12px;display:flex;align-items:baseline;justify-content:space-between}
.tile .tn{font-size:14px}
.tile .tc{font-size:20px;font-weight:600;color:var(--acc);font-variant-numeric:tabular-nums}
.back{color:var(--acc);font-weight:500;padding:4px 2px}
.gridimg{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.gridimg figure{margin:0;background:var(--card2);border-radius:10px;overflow:hidden}
.gridimg img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.gridimg figcaption{font-size:10px;color:var(--dim);padding:3px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head>
<body>
<main id="main"></main>
<nav>
  <button data-tab="home" class="on"><span class="ic">◎</span>概览</button>
  <button data-tab="groups"><span class="ic">▤</span>群</button>
  <button data-tab="her"><span class="ic">☺</span>她</button>
  <button data-tab="records"><span class="ic">✎</span>记录</button>
  <button data-tab="sys"><span class="ic">⚙</span>系统</button>
</nav>
<script>
const TOKEN = ${JSON.stringify(t)};
const main = document.getElementById('main');
let tab = 'home';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e8) return (n/1e8).toFixed(2)+'亿'; if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(1)+'k'; return String(n); };
const ago = (ts) => { if (!ts) return '—'; const d = (Date.now()-ts)/1000; if (d<60) return Math.round(d)+'秒前'; if (d<3600) return Math.round(d/60)+'分钟前'; if (d<86400) return Math.round(d/3600)+'小时前'; return Math.round(d/86400)+'天前'; };
const hm = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false }).slice(5, 16);
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
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values.map((v,i)=> (i*step).toFixed(2) + ',' + (h - (v/max)*h).toFixed(2)).join(' ');
  el.innerHTML = '<svg class="spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'
    + '<polyline fill="none" stroke="'+color+'" stroke-width="1.6" points="'+pts+'"/></svg>';
}
function delta(nowV, oldV){
  if (!oldV) return '';
  const pct = Math.round((nowV - oldV) / oldV * 100);
  if (!pct) return '';
  return '<span class="u" style="color:' + (pct > 0 ? 'var(--ok)' : 'var(--dim)') + '">' + (pct > 0 ? ' ↑' : ' ↓') + Math.abs(pct) + '%</span>';
}

async function renderHome(){
  const s = await api('/api/stats');
  const c = s.context || { total: 0, sessions: 0 };
  const m = s.mood || { mood: 70, why: '', updatedAt: 0 };
  const t = s.today || { in: 0, out: 0, groups: 0, hourly: [] };
  const y = s.yesterday || { in: 0, out: 0 };
  const moodColor = m.mood >= 70 ? 'var(--ok)' : m.mood >= 45 ? 'var(--warn)' : 'var(--bad)';
  main.innerHTML = ''
    + '<div class="rowline" style="padding:0 2px 2px"><span class="dot '+(s.online?'ok':'bad')+'"></span>'
    +   '<span class="small '+(s.online?'ok':'bad')+'">'+(s.online?'在线':'离线')+'</span>'
    +   '<span class="fill small dim" style="text-align:right">'+(t.groups||0)+' 个群今天有动静</span></div>'
    + '<div class="grid3">'
    +   '<div class="kpi"><div class="k">今日收到</div><div class="v">'+fmt(t.in)+delta(t.in, y.in)+'</div></div>'
    +   '<div class="kpi"><div class="k">她说了</div><div class="v">'+fmt(t.out)+delta(t.out, y.out)+'</div></div>'
    +   '<div class="kpi"><div class="k">活跃群</div><div class="v">'+fmt(t.groups)+'</div></div>'
    + '</div>'
    + '<div class="card"><h3>消息走势</h3>'
    +   '<div class="chips" id="rchips"><b data-r="day" class="on">今天</b><b data-r="week">一周</b><b data-r="month">一月</b></div>'
    +   '<div id="sp1"></div><div class="small dim" id="sphint" style="margin-top:4px">每小时收到的条数</div></div>'
    + '<div class="grid2">'
    +   '<div class="kpi"><div class="k">上下文合计</div><div class="v">'+fmt(c.total)+'<span class="u"> · '+c.sessions+' 会话</span></div></div>'
    +   '<div class="kpi"><div class="k">心情</div><div class="v" style="color:'+moodColor+'">'+Math.round(m.mood)+'<span class="u"> /100</span></div></div>'
    + '</div>'
    + '<div class="card"><h3>会话上下文（每轮重读的量）</h3>'
    +   ((s.sessions||[]).length ? '<table>' + s.sessions.map(x =>
          '<tr><td class="mono">'+esc(x.key)+'</td><td class="dim" style="text-align:right;white-space:nowrap">'+fmt(x.total)+'</td></tr>').join('') + '</table>'
        : '<div class="empty">暂无</div>')
    + '</div>'
    + '<div class="card"><h3>她今天在哪说话</h3>'
    +   (s.lastHer ? '<div class="small dim" style="margin-bottom:6px">最后一句：'+ago(s.lastHer.at)+'（群 '+esc(s.lastHer.gid)+'）</div>' : '<div class="empty">今天还没说话</div>')
    +   ((s.herByGroup||[]).length ? '<table>' + s.herByGroup.map(g =>
          '<tr><td class="mono">'+esc(g.gid)+'</td><td style="text-align:right" class="ok">'+g.n+' 条</td></tr>').join('') + '</table>' : '')
    + '</div>'
    + '<div class="card"><h3>最近活动</h3>'
    +   ((s.activities||[]).length ? s.activities.map(a =>
          '<div class="msg"><div class="who">'+esc(a.time)+'</div><div class="tx">'+esc(a.intent||'')+'<span class="tag">'+esc(a.kind)+'</span></div></div>').join('')
        : '<div class="empty">还没做过活动</div>')
    + '</div>';
  const sp = document.getElementById('sp1');
  if (sp) spark(sp, (t.hourly||[]).map(x => x.in), '#4da3ff');
  let ovRange = 'day';
  const paint = async (r) => {
    ovRange = r;
    document.querySelectorAll('#rchips b').forEach(b => b.classList.toggle('on', b.dataset.r === r));
    const o = await api('/api/overview?range=' + r);
    const el = document.getElementById('sp1');
    if (!el) return;
    spark(el, o.series.map(x => x.in), '#4da3ff');
    const hint = document.getElementById('sphint');
    if (hint) hint.textContent = (r === 'day' ? '每小时' : r === 'week' ? '每天（7 天）' : '每天（30 天）')
      + '｜合计收到 ' + o.totals.in + ' 条 · 她说了 ' + o.totals.out + ' 条';
  };
  document.querySelectorAll('#rchips b').forEach(b => b.onclick = () => paint(b.dataset.r));
}

async function renderGroups(){
  const list = await api('/api/groups');
  const total = list.reduce((a,b)=>a+b.in,0) || 1;
  const card = (g) => {
    const pf = g.profile || {};
    const bits = [pf.purpose, pf.topics, pf.style].filter(Boolean);
    const hours = g.hours || [];
    const maxH = Math.max(1, ...hours);
    return '<div class="card grow" data-gid="'+esc(g.gid)+'" style="margin:0">'
      + '<div class="rowline"><div class="fill"><div style="font-weight:600">'+esc(g.name || ('群 '+g.gid))+'</div>'
      +   '<div class="small dim">'+esc(g.gid)+(g.members?' · '+g.members+' 人':'')+' · '+ago(g.lastAt)+'</div></div>'
      +   '<div style="text-align:right"><div class="v" style="font-size:18px">'+g.in+'</div><div class="small dim">今天</div></div>'
      + '</div>'
      + '<div class="bar" style="margin:8px 0 6px"><i style="width:'+Math.round(g.in/total*100)+'%;background:#4da3ff"></i></div>'
      + '<div class="rowline small dim"><span>7 天 '+fmt(g.week||0)+'</span><span class="fill"></span><span class="'+(g.out?'ok':'')+'">她 '+g.out+' 条</span></div>'
      + (bits.length ? '<div class="small" style="margin-top:6px">'+esc(bits.join(' · '))+'</div>' : '<div class="small dim" style="margin-top:6px">还没有印象</div>')
      + (pf.people ? '<div class="small dim">常出现的人：'+esc(pf.people)+'</div>' : '')
      + '<div style="display:flex;gap:1px;align-items:flex-end;height:22px;margin-top:8px">'
      +   hours.map((n)=>'<i style="flex:1;height:'+Math.max(2, Math.round(n/maxH*22))+'px;background:#2d6cb5;border-radius:1px"></i>').join('')
      + '</div>'
      + '<div class="small dim" style="font-size:10px">0 ────────── 23 点</div>'
      + '</div>';
  };
  main.innerHTML = '<div class="chips"><b class="on">今天 '+list.length+' 个群</b></div>'
    + '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(card).join('') + '</div>'
    + '<div id="gdetail"></div>';
  document.querySelectorAll('.grow').forEach(el => el.onclick = () => {
    try { history.pushState({ grp: el.dataset.gid }, ''); } catch {}
    openGroup(el.dataset.gid);
  });
}

let groupOpen = false;
async function openGroup(gid){
  groupOpen = true;
  const box = document.getElementById('gdetail');
  box.innerHTML = '<div class="card"><div class="empty">读取 ' + esc(gid) + ' …</div></div>';
  const d = await api('/api/group?id=' + encodeURIComponent(gid));
  box.innerHTML = '<div class="card"><h3>'+esc(d.name || ('群 ' + d.gid))+' · 最近 '+d.messages.length+' 条</h3>'
    + (d.messages.length ? d.messages.map(m =>
        '<div class="msg '+(m.me?'me':'')+'"><div class="who">'+esc(m.who)+'<br><span class="dim" style="font-size:10px">'+esc(m.time)+'</span></div>'
        + '<div class="tx">'+esc(m.text)+(m.at?'<span class="tag">@她</span>':'')+'</div></div>').join('')
      : '<div class="empty">今天没有消息</div>')
    + '</div>';
  box.scrollIntoView({ behavior: 'smooth' });
}

let herTab = 'persona';
async function renderHer(){
  const h = await api('/api/her');
  const a = h.archived || { P0:0, P1:0, P2:0 };
  const m = h.mood || { mood: 70, history: [] };
  const items = h.items || [];
  const chips = [['persona','人格'],['mood','心情'],['acts','活动三步']];
  let body = '';
  if (herTab === 'persona') {
    const layer = (L, title) => {
      const rows = items.filter(x => x.layer === L);
      return '<div class="card"><h3>'+title+' · '+rows.length+' 条'+(a[L]?'（已归档 '+a[L]+'）':'')+'</h3>'
        + (rows.length ? rows.map(x => '<div class="msg"><div class="tx">'+esc(x.text)+'</div></div>').join('') : '<div class="empty">空的</div>')
        + '</div>';
    };
    body = layer('P0','P0 身份') + layer('P1','P1 底色') + layer('P2','P2 认同');
  } else if (herTab === 'mood') {
    const hist = (m.history || []).map(x => Math.round(Number(x.mood) || 0));
    body = '<div class="card"><h3>心情</h3>'
      + '<div class="rowline"><div style="font-size:34px;font-weight:600">'+Math.round(m.mood)+'</div>'
      + '<div class="fill small dim">'+esc(m.why || '没记为什么')+'<br>'+ago(m.updatedAt)+'</div></div>'
      + (hist.length ? '<div id="spm"></div><div class="small dim">最近 '+hist.length+' 次记录</div>' : '<div class="empty">还没记过心情（她可以用 feel）</div>')
      + (h.moodWeek ? '<div class="hr"></div><div class="small dim">7 天内 '+h.moodWeek.n+' 次：最低 '+h.moodWeek.min+' / 最高 '+h.moodWeek.max+' / 平均 '+h.moodWeek.avg+'</div>' : '')
      + '</div>'
      + '<div class="card"><h3>认同层的构成</h3>'
      + (h.types ? Object.entries(h.types).sort((x,y)=>y[1]-x[1]).map(([k,n]) => '<span class="chip">'+esc(k)+' '+n+'</span>').join('') : '<div class="empty">空</div>')
      + '</div>';
  } else {
    const acts = await api('/api/acts');
    const list = acts.items || [];
    body = list.length ? list.map(x => '<div class="card"><h3>'+esc(hm(x.at))+' · '+esc(x.kind)+'</h3>'
        + '<div class="step3"><div class="n">想</div><div class="b"><div class="lbl">想做</div>'+esc(x.intent||'')+'</div></div>'
        + (x.why ? '<div class="step3"><div class="n"></div><div class="b"><div class="lbl">为什么</div>'+esc(x.why)+'</div></div>' : '')
        + ((x.looked||[]).length ? '<div class="step3"><div class="n"></div><div class="b"><div class="lbl">看了</div>'+esc(x.looked.join('、'))+'</div></div>' : '')
        + '<div class="step3"><div class="n">做</div><div class="b">'+esc((x.did||'').slice(0,320))+'</div></div>'
        + (x.reflect ? '<div class="step3"><div class="n">回看</div><div class="b">'+esc(x.reflect.slice(0,320))+'</div></div>' : '')
        + '</div>').join('') : '<div class="empty">还没做过活动</div>';
  }
  main.innerHTML = '<div class="chips">' + chips.map(([k,t]) =>
    '<b data-her="'+k+'" class="'+(herTab===k?'on':'')+'">'+t+'</b>').join('') + '</div>' + body;
  document.querySelectorAll('[data-her]').forEach(el => el.onclick = () => { herTab = el.dataset.her; renderHer(); });
  if (herTab === 'mood') {
    const sp = document.getElementById('spm');
    const hist = (m.history || []).map(x => Math.round(Number(x.mood) || 0));
    if (sp && hist.length) spark(sp, hist, '#db61a2');
  }
}

const ACT_ZH = { explore:'探索', read:'读书', think:'思考', write:'写东西', play:'玩', recall:'回忆', dream:'憧憬', study:'研究', watch_groups:'看群' };
const TOOL_ZH = {
  qq_send:'发消息', reply_to:'回复', at_person:'@人', look_image:'看图', draw_image:'画图', draw_svg:'画矢量图',
  save_sticker:'存表情', send_sticker:'发表情', list_stickers:'看表情库', search_messages:'搜聊天记录',
  read_context:'看上下文', read_person:'看某人', read_chat_with:'看和某人的对话', read_pdf:'读 PDF', read_page:'读网页',
  web_search:'上网搜', hot_news:'看热榜', zhihu_daily:'看知乎日报', remember:'记东西', memory:'查记忆', recall:'回忆',
  remember_fact:'记事实', remember_self:'记自我', revise_self:'改自我', forget_self:'忘掉', my_memory:'看我的记忆',
  my_digest:'看日记', my_wants:'看想做的', note_want:'记想做', resolve_want:'划掉想做', drop_want:'删想做',
  write_notebook:'写本子', read_notebook:'翻本子', list_notes:'看文件区', files:'管文件', note_file:'建文件',
  my_status:'看状态', my_balance:'看余额', my_activities:'看活动', my_adventures:'看走过的路', my_thoughts:'看想法',
  my_schedule:'看日程', my_source:'看源码', read_source:'读源码', propose_patch:'提改动申请', my_patch_proposals:'看改动申请',
  patch_guide:'看申请写法', exec_sandbox:'跑沙箱', my_capabilities:'看能力', my_changelog:'看更新日志', my_context:'看上下文用量',
  my_outages:'看掉线', group_activity:'看群活跃', group_patrol:'巡群', group_recap:'群小结', group_impressions:'看群印象',
  handle_request:'处理申请', manage_group:'管群', notify_owner:'提醒主人', set_reminder:'设提醒', run_activity:'开始活动',
  assistant_channel:'助手通道', feel:'记心情', my_watchlist:'看关注', watch_topic:'关注话题', unwatch_topic:'取消关注',
  list_requests:'看申请', add_webui_button:'加按钮', render_page:'做网页', list_requests:'看申请', search_web:'上网搜',
};
const REC_GROUPS = [
  ['facts','事实'],['people','人物'],['views','想法'],['wants','想做的'],
  ['plans','日程'],['explore','探索'],['stickers','表情包'],['files','文件'],
  ['assistant','助手'],['proposals','改动'],['digest','日记'],
];
let recTab = 'facts';
let showOldProposals = false;
let recOpen = false;
async function renderRecords(){
  const d = await api('/api/records?part=' + recTab);
  const d2 = recOpen ? { inbox: [], outbox: [] } : await api('/api/assistant').catch(() => ({ inbox: [], outbox: [] }));
  const d3 = recOpen ? { total: 0 } : await api('/api/proposals').catch(() => ({ total: 0 }));
  const items = d.items || [];
  let body = '';
  if (recTab === 'facts') {
    body = '<div class="card"><h3>事实 · 共 '+(d.total||0)+' 条</h3>' + (items.length ? items.map(x =>
      '<div class="msg"><div class="tx">'+esc(x.text)+'<div class="small dim">'+ago(x.at)+' · '+esc(x.source||'')+'</div></div></div>').join('') : '<div class="empty">还没记事实</div>') + '</div>';
  } else if (recTab === 'people') {
    body = '<div class="card"><h3>人物 · 共 '+(d.total||0)+' 位</h3>' + (items.length ? items.map(x =>
      '<div class="msg"><div class="who">'+esc(x.name||x.uid)+'</div><div class="tx">'
      + (x.notes||[]).map(n => '<div>'+esc(n)+'</div>').join('')
      + '<div class="small dim">'+ago(x.lastSeen)+'</div></div></div>').join('') : '<div class="empty">还没记人物</div>') + '</div>';
  } else if (recTab === 'views') {
    body = '<div class="card"><h3>想法 · 共 '+(d.total||0)+' 条</h3>' + (items.length ? items.map(x =>
      '<div class="msg"><div class="tx">'+esc(x.text)+'<div class="small dim">'+ago(x.at)+'</div></div></div>').join('') : '<div class="empty">空</div>') + '</div>';
  } else if (recTab === 'wants') {
    body = '<div class="card"><h3>想做的 · 共 '+(d.total||0)+' 条</h3>' + (items.length ? items.map(x =>
      '<div class="msg"><div class="tx">'+esc(x.what)+(x.why?'<div class="small dim">'+esc(x.why)+'</div>':'')+'<div class="small dim">'+ago(x.at)+' · '+esc(x.kind||'')+'</div></div></div>').join('') : '<div class="empty">空</div>') + '</div>';
  } else if (recTab === 'plans') {
    body = '<div class="card"><h3>日程 · 共 '+(d.total||0)+' 条</h3>' + (items.length ? items.map(x =>
      '<div class="msg"><div class="who">'+esc(hm(x.at))+'</div><div class="tx">'+esc(x.note)+'<span class="tag">'+esc(x.status)+'</span></div></div>').join('') : '<div class="empty">空</div>') + '</div>';
  } else if (recTab === 'explore') {
    body = items.length ? items.map(x => '<div class="card"><h3>'+esc(hm(x.at))+'</h3>'
      + '<div style="margin-bottom:6px">'+esc(x.topic)+'</div>'
      + (x.stops||[]).map(y => '<div class="msg"><div class="tx"><div>'+esc(y.stop)+'</div><div class="small dim">'+esc(y.why)+'</div></div></div>').join('')
      + '</div>').join('') : '<div class="empty">还没记录探索</div>';
  } else if (recTab === 'stickers') {
    body = '<div class="card"><h3>表情包 · '+(d.total||0)+' 张</h3>'
      + '<div style="margin-bottom:8px">' + Object.entries(d.tags||{}).sort((x,y)=>y[1]-x[1]).slice(0,10).map(([k,n]) => '<span class="chip">'+esc(k)+' '+n+'</span>').join('') + '</div>'
      + '<div class="gridimg">' + items.map(x => '<figure><img loading="lazy" src="/sticker/'+encodeURIComponent(x.file)+'?token='+encodeURIComponent(TOKEN)+'" alt=""><figcaption>'+esc((x.tags||[]).join('/')||x.file)+'</figcaption></figure>').join('') + '</div>'
      + '</div>';
  } else if (recTab === 'files') {
    const group = (title, arr, hint) => {
      if (!arr || !arr.length) return '<div class="card"><h3>'+title+'</h3><div class="empty">'+(hint||'空')+'</div></div>';
      return '<div class="card"><h3>'+title+' · '+arr.length+'</h3>'
        + '<div class="gridimg">' + arr.filter(x=>x.kind==='img').map(x =>
            '<figure><a href="/file/'+esc(x.path)+'?token='+encodeURIComponent(TOKEN)+'" target="_blank"><img loading="lazy" src="/file/'+esc(x.path)+'?token='+encodeURIComponent(TOKEN)+'" alt=""></a><figcaption>'+esc(x.name)+'</figcaption></figure>').join('') + '</div>'
        + '<table style="margin-top:8px">' + arr.filter(x=>x.kind!=='img').map(x =>
            '<tr><td><a class="acc" href="/file/'+esc(x.path)+'?token='+encodeURIComponent(TOKEN)+'" target="_blank">'+esc(x.name)+'</a></td>'
            + '<td class="dim" style="text-align:right;white-space:nowrap">'+Math.round(x.size/1024)+' KB · '+ago(x.at)+'</td></tr>').join('')
        + '</table></div>';
    };
    body = group('桌面（她写下的文件）', d.desk, '她还什么都没往桌上放')
      + group('她画的', d.art, '还没画过')
      + group('她写的代码', d.code, '还没写过代码')
      + group('她做的页面', d.pages, '还没做过');
  } else if (recTab === 'assistant') {
    const a2 = await api('/api/assistant');
    const thread = a2.thread || [];
    const bubble = (m) => {
      const mine = m.dir === 'to';  // 助手发出
      return '<div class="turn '+(mine?'me':'her')+'">'
        + '<div class="bub">'+esc(m.text)+'</div>'
        + '<div class="twho">'+esc(mine?'助手':'她')+' · '+esc(ago(m.at))+'</div></div>';
    };
    body = '<div class="card"><h3>这是什么</h3><div class="small dim">'
      + '这是<b>执行助手</b>（跑活的 agent）和她的专用通道：不走 QQ、不进群。'
      + '创造者跟她说话仍走 QQ。</div></div>'
      + '<div class="card"><h3>对话</h3>'
      + (thread.length ? thread.map(bubble).join('') : '<div class="empty">还没有来往</div>')
      + '</div>';
  } else if (recTab === 'proposals') {
    const p2 = await api('/api/proposals' + (showOldProposals ? '?all=1' : ''));
    body = '<div class="card"><h3>改动申请 · '+(p2.total||0)+' 份</h3>'
      + '<div class="small dim" style="margin-bottom:6px">待执行 '+(p2.pending||0)+' 份'
      + ((p2.hidden||0) ? ' · <b class="back" id="oldu">'+(showOldProposals?'收起':'看已处理 '+(p2.hidden||0)+' 份')+'</b>' : '')+'</div>'
      + ((p2.items||[]).length ? p2.items.map(x =>
          '<div class="msg"><div class="tx"><div>'+esc(x.title||x.id)+' <span class="tag">'+esc(x.status)+'</span></div>'
          + '<div class="small dim">'+ago(x.at)+' · '+Math.round((x.size||0)/1024)+' KB'+(x.note?' · '+esc(x.note):'')+'</div>'
          + '<pre style="margin-top:6px;max-height:160px;overflow:auto">'+esc(x.head||'')+'</pre></div></div>').join('')
        : '<div class="empty">她还没提过改动</div>')
      + '</div>';
  } else if (recTab === 'digest') {
    body = items.length ? items.map(x => '<div class="card"><h3>'+esc(hm(x.to))+'</h3><div class="small">'+esc(x.text)+'</div></div>').join('') : '<div class="empty">还没有日记</div>';
  }
  // 入口网格：先看有哪几类，点一个进来看内容（不再横向滑动）
  if (!recOpen) {
    const cc = (await api('/api/records?part=counts').catch(() => ({ counts: {} }))).counts || {};
    const counts = {
      facts: cc.facts || 0, people: cc.people || 0, views: cc.views || 0, wants: cc.wants || 0,
      plans: cc.plans || 0, explore: cc.explore || 0, stickers: cc.stickers || 0,
      files: cc.files || 0, assistant: cc.assistant || 0, proposals: cc.proposals || 0, digest: cc.digest || 0,
    };
    main.innerHTML = '<div class="grid2">' + REC_GROUPS.map(([k,t]) =>
      '<div class="tile" data-rec="'+k+'"><div class="tn">'+t+'</div><div class="tc">'+(counts[k]||0)+'</div></div>').join('') + '</div>';
    const ou = document.getElementById('oldu');
  if (ou) ou.onclick = () => { showOldProposals = !showOldProposals; renderRecords(); };
  document.querySelectorAll('[data-rec]').forEach(el => el.onclick = () => {
      recTab = el.dataset.rec;
      recOpen = true;
      try { history.pushState({ rec: recTab }, ''); } catch {}
      renderRecords();
    });
    return;
  }
  main.innerHTML = '<div class="rowline" style="margin-bottom:2px"><b class="back" id="recback">‹ 返回</b>'
    + '<span class="fill"></span><b class="small dim">'+ (REC_GROUPS.find(x=>x[0]===recTab)||['',''])[1] +'</b></div>' + body;
  const bk = document.getElementById('recback');
  if (bk) bk.onclick = () => { try { history.back(); } catch { recOpen = false; renderRecords(); } };
  return;
document.querySelectorAll('[data-rec]').forEach(el => el.onclick = () => { recTab = el.dataset.rec; renderRecords(); });
}

async function capsBlock(){
  const c = await api('/api/caps');
  const acts = (c.activities||[]).filter(x => x.total > 0);
  return '<div class="card"><h3>她能做的活动</h3><table><tr><th>活动</th><th>今天</th><th>7天</th><th>总</th></tr>'
    + acts.map(x => '<tr><td>'+esc(ACT_ZH[x.kind]||x.kind)+'<span class="dim" style="font-size:10px"> '+esc(x.kind)+'</span></td><td>'+x.today+'</td><td>'+x.week+'</td><td class="dim">'+x.total+'</td></tr>').join('')
    + '</table></div>'
    + '<div class="card"><h3>工具（'+((c.tools||[]).length)+' 个）</h3>'
    + (c.tools||[]).map(t => '<span class="chip">'+esc(TOOL_ZH[t]||t)+'<span class="dim" style="font-size:9px"> '+esc(t)+'</span></span>').join('')
    + '</div>';
}
async function usageBlock(){
  let bal = null;
  try { bal = await api('/api/balance'); } catch {}
  let tok = null, tok7 = null;
  try { tok = await api('/api/tokens?days=1'); tok7 = await api('/api/tokens?days=7'); } catch {}
  const t1 = (tok && tok.totals) || { input:0, cache:0, output:0, calls:0 };
  const t7 = (tok7 && tok7.totals) || { input:0, cache:0, output:0, calls:0 };
  const money = bal && bal.ok
    ? '<div class="grid2"><div class="kpi"><div class="k">余额</div><div class="v">¥'+Number(bal.balance).toFixed(2)+'</div><div class="k">充值 '+bal.toppedUp+' / 赠送 '+bal.granted+'</div></div>'
      + '<div class="kpi"><div class="k">状态</div><div class="v '+(bal.available?'ok':'bad')+'">'+(bal.available?'可用':'不可用')+'</div></div></div>'
    : '<div class="empty">'+(bal?esc(bal.reason||'查不到余额'):'余额接口不可用')+'</div>';
  return '<div class="card"><h3>用量与余额</h3>' + money
    + '<div class="hr"></div><table>'
    + '<tr><th></th><th>今天</th><th>7 天</th></tr>'
    + '<tr><td>输入</td><td>'+fmt(t1.input)+'</td><td>'+fmt(t7.input)+'</td></tr>'
    + '<tr><td>缓存读</td><td>'+fmt(t1.cache)+'</td><td>'+fmt(t7.cache)+'</td></tr>'
    + '<tr><td>输出</td><td>'+fmt(t1.output)+'</td><td>'+fmt(t7.output)+'</td></tr>'
    + '<tr><td>调用次数</td><td>'+t1.calls+'</td><td>'+t7.calls+'</td></tr>'
    + '</table><div class="small dim" style="margin-top:4px">数字来自每次回复的用量记录，按天累加</div></div>';
}

async function renderSys(){
  const s = await api('/api/sys');
  const l = await api('/api/logs').catch(() => ({ audit: [], tail: [], errors: [], kinds: {} }));
  const kinds = Object.entries(l.kinds || {}).sort((a,b)=>b[1]-a[1]).slice(0,12);
  const cfg = s.cfg || {};
  main.innerHTML = '<div class="card"><h3>状态</h3><table>'
    + '<tr><td>QQ 连接</td><td class="'+(s.online?'ok':'bad')+'" style="text-align:right">'+(s.online?'已连':'断开')+'</td></tr>'
    + '<tr><td>运行</td><td style="text-align:right">'+esc(s.uptime)+'</td></tr>'
    + '<tr><td>版本</td><td style="text-align:right" class="mono">'+esc(s.version)+'</td></tr>'
    + '<tr><td>会话</td><td style="text-align:right">'+s.sessions+'</td></tr>'
    + '<tr><td>排队</td><td style="text-align:right">'+s.pending+'</td></tr>'
    + '</table></div>'
    + await capsBlock()
    + usageBlock()
    + '<div class="card"><h3>能力开关</h3><table>'
    + Object.entries(s.caps || {}).filter(([k]) => !k.includes('已删')).map(([k,v]) => '<tr><td>'+esc(k)+'</td><td style="text-align:right" class="'+(v?'ok':'dim')+'">'+(v?'开':'关')+'</td></tr>').join('')
    + '</table></div>'
    + '<div class="card"><h3>审计类型</h3>'
    + (kinds.length ? kinds.map(([k,n]) => '<span class="chip">'+esc(k)+' '+n+'</span>').join('') : '<div class="empty">空</div>')
    + '</div>'
    + '<div class="card"><h3>错误</h3>'
    + ((l.errors||[]).length ? l.errors.map(x => '<pre class="bad" style="margin-bottom:6px">'+esc(x)+'</pre>').join('') : '<div class="empty">没有错误</div>')
    + '</div>'
    + '<div class="card"><h3>运行日志</h3><pre>'+((l.tail||[]).map(esc).join('\\n'))+'</pre></div>'
    + '<div class="card"><h3>配置（只读）</h3><table>'
    + Object.keys(cfg).map(k => '<tr><td class="mono">'+esc(k)+'</td><td class="mono dim" style="text-align:right;word-break:break-all">'+esc(String(cfg[k]).slice(0,90))+'</td></tr>').join('')
    + '</table></div>';
}

const render = { home: renderHome, groups: renderGroups, her: renderHer, records: renderRecords, sys: renderSys };
async function go(t){
  tab = t;
  recOpen = false; groupOpen = false;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  main.innerHTML = '<div class="empty">加载中…</div>';
  try { await render[t](); }
  catch (e) { main.innerHTML = '<div class="card"><div class="bad">'+esc(e.message)+'</div></div>'; }
}
// 左滑返回 / 系统返回键：先回上一层（详情 → 列表），再退到首页
window.addEventListener('popstate', () => {
  if (recOpen) { recOpen = false; recTab = 'facts'; renderRecords(); return; }
  if (groupOpen) { groupOpen = false; renderGroups(); return; }
});

document.querySelectorAll('nav button').forEach(b => b.onclick = () => go(b.dataset.tab));
go('home');
setInterval(() => { if (tab === 'home') go('home'); }, 30000);
</script>
</body></html>`;
}
