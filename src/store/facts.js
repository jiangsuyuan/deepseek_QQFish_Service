// 事实记忆。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
/** 插件自己所在的目录（发布版不再写死绝对路径） */
const HERE = dirname(fileURLToPath(import.meta.url));

const FACTS_PATH = join(HOME, ".dsh/onebot-bridge/facts.json");

const SENSITIVE = /(\d{6,12})|sk-[A-Za-z0-9]{10,}|\/root\/|token|password|密码|口令|api[_-]?key/i;

const facts = {
  data: [],
  loaded: false,
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(readFileSync(FACTS_PATH, "utf8"));
      this.data = Array.isArray(raw) ? raw : Array.isArray(raw?.facts) ? raw.facts : [];
    } catch {
      this.data = [];
    }
  },
  save() {
    try {
      mkdirSync(join(HOME, ".dsh/onebot-bridge"), { recursive: true });
      writeFileSync(FACTS_PATH, JSON.stringify({ facts: this.data }, null, 2));
    } catch {
      // 写失败不影响对话
    }
  },
  add(text, source) {
    const t = String(text || "").trim().replace(/^[，,：:\s]+/, "").slice(0, 80);
    if (!t || SENSITIVE.test(t)) return null;
    this.load();
    if (this.data.some((f) => f.text === t)) return t;
    this.data.push({ text: t, at: Date.now(), source: source || "unknown" });
    this.save();
    return t;
  },
  /** 注入用：最近 n 条拼成一行（再过一次过滤） */
  render(n = 6) {
    this.load();
    const list = this.data
      .slice(-n)
      .map((f) => f.text)
      .filter((t) => t && !SENSITIVE.test(t));
    return list.join("；");
  },
};

export { HOME, FACTS_PATH, SENSITIVE, facts };
