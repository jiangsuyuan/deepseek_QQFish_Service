// 人物档案。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();

const USERS_PATH = join(HOME, ".dsh/onebot-bridge/users.json");

const USERS_DIR = join(HOME, ".dsh/onebot-bridge/users");

const people = {
  data: {},
  loaded: false,
  _saved: {},
  load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      mkdirSync(USERS_DIR, { recursive: true });
      const files = readdirSync(USERS_DIR).filter((f) => f.endsWith(".json"));
      if (files.length) {
        for (const f of files) {
          try {
            const rec = JSON.parse(readFileSync(join(USERS_DIR, f), "utf8"));
            const qq = f.replace(/\.json$/, "");
            if (rec && typeof rec === "object") this.data[qq] = rec;
          } catch {
            // 单人文件坏了跳过
          }
        }
      } else {
        // 迁移：老的 users.json → 一人一个文件
        this.data = JSON.parse(readFileSync(USERS_PATH, "utf8")) || {};
        this.save();
      }
    } catch {
      this.data = {};
    }
  },
  save() {
    try {
      mkdirSync(USERS_DIR, { recursive: true });
      const seen = new Set();
      for (const [qq, rec] of Object.entries(this.data)) {
        if (!/^\d{5,20}$/.test(qq)) continue;
        seen.add(qq);
        const json = JSON.stringify(rec);
        if (this._saved[qq] === json) continue;
        writeFileSync(join(USERS_DIR, qq + ".json"), json);
        this._saved[qq] = json;
      }
      for (const qq of Object.keys(this._saved)) {
        if (!seen.has(qq)) {
          try {
            unlinkSync(join(USERS_DIR, qq + ".json"));
          } catch {
            // 忽略
          }
          delete this._saved[qq];
        }
      }
    } catch {
      // 写失败不影响对话
    }
  },
  markDirty() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, 8000);
    this._timer.unref?.();
  },
  recordTopics(userId, text) {
    this.load();
    const id = String(userId);
    const rec = this.data[id];
    if (!rec) return;
    try {
      const pure = String(text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, " ");
      const stop = new Set([
        "这个", "那个", "就是", "什么", "没有", "可以", "不是", "我们", "他们", "你们",
        "现在", "然后", "因为", "所以", "还是", "已经", "一个", "怎么", "为什么", "这么",
        "知道", "觉得", "应该", "可能", "真的", "有点", "一直", "时候", "自己",
      ]);
      rec.topics = rec.topics && typeof rec.topics === "object" ? rec.topics : {};
      for (const chunk of pure.split(/\s+/)) {
        for (let n = 2; n <= 4; n++) {
          for (let i = 0; i + n <= chunk.length; i++) {
            const w = chunk.slice(i, i + n);
            if (stop.has(w)) continue;
            rec.topics[w] = (rec.topics[w] ?? 0) + 1;
          }
        }
      }
      // 只保留前 30 个
      const top = Object.entries(rec.topics).sort((a, b) => b[1] - a[1]).slice(0, 30);
      rec.topics = Object.fromEntries(top);
    } catch {
      // 忽略
    }
  },

  setAddress(userId, address) {
    this.load();
    const id = String(userId);
    const rec = this.data[id] ?? (this.data[id] = { notes: [] });
    rec.address = String(address || "").trim().slice(0, 12);
    this.save();
    return rec.address;
  },
  touch(userId, name, groupId, text) {
    this.load();
    const id = String(userId);
    const rec = this.data[id] ?? (this.data[id] = { notes: [] });
    if (name) rec.name = name;
    rec.lastSeen = Date.now();
    rec.count = (rec.count ?? 0) + 1;
    // 活跃时段画像
    try {
      const h = String(new Date().getHours());
      rec.activeHours = rec.activeHours && typeof rec.activeHours === "object" ? rec.activeHours : {};
      rec.activeHours[h] = (rec.activeHours[h] ?? 0) + 1;
    } catch {
      // 忽略
    }
    if (groupId) {
      const gid = String(groupId);
      rec.groups = Array.isArray(rec.groups) ? rec.groups : [];
      if (!rec.groups.includes(gid)) rec.groups.push(gid);
      // 跨群发言摘要：每人每群留最近 3 条
      const t = String(text || "").trim();
      if (t) {
        rec.recentByGroup =
          rec.recentByGroup && typeof rec.recentByGroup === "object" ? rec.recentByGroup : {};
        const arr = Array.isArray(rec.recentByGroup[gid]) ? rec.recentByGroup[gid] : [];
        const last = arr[arr.length - 1];
        if (!last || last.text !== t.slice(0, 80)) {
          arr.push({ text: t.slice(0, 80), at: Date.now() });
          if (arr.length > 3) arr.shift();
          rec.recentByGroup[gid] = arr;
        }
      }
    }
    // 落盘（debounce 5 秒，避免每条消息都写）
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.dirty) {
          this.dirty = false;
          this.save();
        }
      }, 5000);
      this.timer.unref?.();
    }
    return rec;
  },
  remember(userId, note) {
    this.load();
    const id = String(userId);
    const rec = this.data[id] ?? (this.data[id] = { notes: [] });
    const text = String(note || "").trim().slice(0, 200);
    if (text) {
      rec.notes = Array.isArray(rec.notes) ? rec.notes : [];
      if (!rec.notes.includes(text)) rec.notes.push(text);
      this.save();
    }
    return rec;
  },
  /** 拼进提示词的人物描述 */
  describe(userId) {
    this.load();
    const rec = this.data[String(userId)];
    if (!rec) return "";
    const bits = [];
    if (rec.style) bits.push(rec.style);
    if (Array.isArray(rec.notes) && rec.notes.length) bits.push(rec.notes.slice(-5).join("；"));
    if (rec.address) bits.push(`你平时叫 TA「${rec.address}」`);
    // 活跃时段
    try {
      const hours = Object.entries(rec.activeHours ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([h]) => `${String(h).padStart(2, "0")} 点`);
      if (hours.length && Number(rec.count ?? 0) >= 5) bits.push(`TA 常在 ${hours.join("、")} 出没`);
    } catch {
      // 忽略
    }
    // 常聊话题
    try {
      const topics = Object.entries(rec.topics ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => w);
      if (topics.length) bits.push(`TA 常聊：${topics.join("、")}`);
    } catch {
      // 忽略
    }
    const cnt = Number(rec.count ?? 0);
    if (cnt >= 3) {
      bits.push(`你们聊过 ${cnt} 次`);
    }
    if (Array.isArray(rec.groups) && rec.groups.length > 1) {
      bits.push(`你们在 ${rec.groups.length} 个群里都聊过`);
    }
    return bits.length ? "\n[你对 TA 的印象] " + bits.join("；") : "";
  },
};

export { HOME, USERS_PATH, USERS_DIR, people };
