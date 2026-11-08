// 她自己的想法/反省。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));
import { SENSITIVE, facts } from "./facts.js";
import { renameSync } from "node:fs";
import { getLogger } from "../core/logger.js";

const SELF_PATH = join(HOME, ".dsh/onebot-bridge/self.json");

const selfViews = {
  data: [],
  reflections: [],
  loaded: false,
  load() {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(readFileSync(SELF_PATH, "utf8"));
      if (Array.isArray(raw)) {
        this.data = raw;
        this.reflections = [];
      } else {
        this.data = Array.isArray(raw?.views) ? raw.views : [];
        this.reflections = Array.isArray(raw?.reflections) ? raw.reflections : [];
      }
      // 只有真读到才置位：读失败时保持 loaded=false，下次再试
      this.loaded = true;
    } catch {
      // 读失败：不清空内存（可能已经有数据）、不缓存「空」状态。
      // 之前这里是 this.loaded = true 在前 + 清空数组，
      // 结果一次临时读失败就把「我没有观点」缓存住，紧接着 save() 还会把文件写空。
    }
  },
  save() {
    // 写之前确保真的加载过。没加载成功就宁可不写，也别把文件冲成空。
    if (!this.loaded) this.load();
    if (!this.loaded) {
      getLogger()?.warn?.("[onebot] 观点没能加载，这次不写盘（避免把原文件清空）");
      return;
    }
    try {
      mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
      const tmp = `${SELF_PATH}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ views: this.data, reflections: this.reflections }, null, 2),
        "utf8",
      );
      renameSync(tmp, SELF_PATH); // 原子替换，写到一半挂了也不会毁原文件
    } catch (err) {
      getLogger()?.warn?.(`[onebot] 观点写盘失败：${err?.message ?? err}`);
    }
  },
  addReflection(text) {
    const t = String(text || "").trim().slice(0, 2000);
    if (!t) return null;
    this.load();
    this.reflections.push({ text: t, at: Date.now() });
    this.save();
    return t;
  },
  renderReflections(n = 2) {
    this.load();
    return this.reflections
      .slice(-n)
      .map((r) => r.text)
      .join("\n");
  },
  add(text) {
    const t = String(text || "").trim().slice(0, 60);
    if (!t || SENSITIVE.test(t)) return null;
    this.load();
    if (this.data.some((v) => v.text === t)) return t;
    this.data.push({ text: t, at: Date.now() });
    this.save();
    return t;
  },
  /** 反思时改写某条旧想法：按原文精确匹配，匹配不到就按「包含」找 */
  revise(oldText, newText) {
    const o = String(oldText || "").trim();
    const t = String(newText || "").trim().slice(0, 60);
    if (!o || !t || SENSITIVE.test(t)) return null;
    this.load();
    let idx = this.data.findIndex((v) => v.text === o);
    if (idx < 0) idx = this.data.findIndex((v) => v.text.includes(o));
    if (idx < 0) return null;
    const before = this.data[idx].text;
    this.data[idx] = { text: t, at: Date.now() };
    this.save();
    return { before, after: t };
  },
  /** 反思时删掉某条想法（不确定的、过时的、不认同的） */
  remove(text) {
    const o = String(text || "").trim();
    if (!o) return null;
    this.load();
    let idx = this.data.findIndex((v) => v.text === o);
    if (idx < 0) idx = this.data.findIndex((v) => v.text.includes(o));
    if (idx < 0) return null;
    const [gone] = this.data.splice(idx, 1);
    this.save();
    return gone?.text ?? null;
  },
  /** 注入用：默认全量（按字数预算从新往旧取），也可只取最近 n 条 */
  render(n = 0) {
    this.load();
    const list = this.data.filter((v) => !SENSITIVE.test(v.text));
    const picked = n > 0 ? list.slice(-n) : list;
    const budget = 1200;
    const out = [];
    let used = 0;
    for (let i = picked.length - 1; i >= 0; i--) {
      const t = picked[i].text;
      if (out.length && used + t.length + 1 > budget) break;
      out.unshift(t);
      used += t.length + 1;
    }
    return out.join("；");
  },
};

export { HOME, SELF_PATH, selfViews };
