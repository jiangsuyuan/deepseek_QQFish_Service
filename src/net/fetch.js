// 出网抓取：图片、链接预览、热点新闻。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { smartCut, safeSlice, stripLoneSurrogates } from "../util/text.js";
import { statSync } from "node:fs";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

async function downloadImage(url, maxBytes) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://qq.com/" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return null;
    const ct = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!ct.startsWith("image/")) return null;
    return { data: buf, mediaType: ct };
  } catch {
    return null;
  }
}

const POLITICAL =
  /长征|党史|习近平|总书记|主席|总理|国务院|外交部|政治局|人大|政协|两会|军委|国防|军事|台独|两岸|中美|中日|中俄|朝鲜|金正恩|访问|会见|会谈|宣誓|就职|抗战|烈士|革命|红色|党建|干部|巡视|反腐|纪委|涉政|领导人|中央|批示|调研|座谈/;

const NEWS_CACHE = join(HOME, ".dsh/onebot-bridge/news.json");

async function fetchHotNews(cfg, logger) {
  try {
    const st = statSync(NEWS_CACHE);
    const cached = JSON.parse(readFileSync(NEWS_CACHE, "utf8"));
    if (Date.now() - st.mtimeMs < (Number(cfg.newsCacheMinutes) || 30) * 60000 && Array.isArray(cached.items)) {
      return cached.items;
    }
  } catch {
    // 没缓存就抓
  }
  try {
    const res = await fetch(cfg.newsUrl || "https://top.baidu.com/board?tab=realtime", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(12000),
    });
    const html = await res.text();
    const re = /class="c-single-text-ellipsis"[^>]*>([^<]{4,60})</g;
    const items = [];
    let m;
    while ((m = re.exec(html)) !== null && items.length < 60) {
      const t = m[1].trim();
      if (!t || POLITICAL.test(t)) continue;
      if (!items.includes(t)) items.push(t);
    }
    const picked = items.slice(0, Number(cfg.newsMaxItems) || 8);
    try {
      writeFileSync(NEWS_CACHE, JSON.stringify({ at: Date.now(), items: picked }), "utf8");
    } catch {
      // 缓存失败不影响
    }
    logger?.info?.(`[onebot] 抓到 ${picked.length} 条非时政热点`);
    return picked;
  } catch (err) {
    logger?.warn?.(`[onebot] 抓新闻失败：${err?.message ?? err}`);
    return [];
  }
}

function isPrivateHost(host) {
  const h = String(host || "").toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripToText(html) {
    let h = String(html || "");
    h = h.replace(/<script[\s\S]*?<\/script>/gi, " ");
    h = h.replace(/<style[\s\S]*?<\/style>/gi, " ");
    h = h.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    h = h.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
    h = h.replace(/<iframe[\s\S]*?<\/iframe>/gi, " ");
    h = h.replace(/<(nav|footer|aside|form|button)[\s\S]*?<\/\1>/gi, " ");

    const tm = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = tm ? tm[1].replace(/<[^>]*>/g, "").trim() : "";

    // 优先 article / main
    let body = h;
    const art = h.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
    if (art && art[2].length > 600) body = art[2];

    // 有像样的 <p> 就只取段落，否则整块
    const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
    let text = paras.join("").length > 250 ? paras.join("\n\n") : body;

    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n");
    text = text.replace(/<[^>]+>/g, "");
    // HTML 实体：&emsp; 这类中文站常用，之前漏掉了
    const ENT = {
      nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "",
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
      mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
      ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
      laquo: "«", raquo: "»", times: "×", divide: "÷", deg: "°",
      copy: "©", reg: "®", trade: "™", yen: "¥", euro: "€",
    };
    text = text
      .replace(/&([a-z]+);/gi, (m, k) => (ENT[k.toLowerCase()] !== undefined ? ENT[k.toLowerCase()] : m))
      .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
      .replace(/[ \t\u00a0\u3000]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // 去导航噪音：短、没标点、不像句子的行（"用微信扫码二维码" "分享至好友和朋友圈"）
    const NOISE =
      /^(点击播报本文.*|用微信扫码.*|分享至.*|扫一扫.*|下载.*客户端.*|打开.*APP.*|广告|登录|注册|首页|上一页|下一页|返回顶部|查看更多|阅读全文|相关阅读|责任编辑[:：].*|原标题[:：].*|本文来源[:：].*)$/;
    text = text
      .split("\n")
      .map((ln) => ln.trim())
      .filter((ln) => {
        if (!ln) return false;
        if (NOISE.test(ln)) return false;
        // 很短又不含标点的，多半是导航碎片
        if (ln.length < 12 && !/[，。！？；：、,.!?;:]/.test(ln)) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return { title, text };
  }

async function fetchLinkPreview(url, maxChars, logger) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) return null;
    const res = await fetch(url, {
      // UA 要完整：之前只到 "(Windows NT 10.0; Win64; x64)"，
      // 少了 AppleWebKit/... Chrome/... Safari/... 的尾巴，比爬虫还像爬虫。
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "upgrade-insecure-requests": "1",
      },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return null;
    const html = buf.toString("utf8");
    const title = (html.match(/<title[^>]*>([^<]{1,120})/i) || [])[1]?.trim() || "";
    const full = stripToText(html).text;
    // 只给摘要，但把总字数带出去 —— 让她知道有全文、自己决定要不要看
    const text = smartCut(full, maxChars || 600);
    if (!text && !title) return null;
    return { url, title, text, totalChars: full.length };
  } catch (err) {
    logger?.debug?.(`[onebot] 链接抓取失败 ${url}：${err?.message ?? err}`);
    return null;
  }
}

export { HOME, downloadImage, POLITICAL, NEWS_CACHE, fetchHotNews, isPrivateHost, htmlToText, stripToText, fetchLinkPreview };
