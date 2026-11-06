import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();

// DSH 会话文件定位。

function listSessionFiles(limit = 20) {
    const base = join(HOME, ".dsh/sessions");
    const out = [];
    try {
      for (const d of readdirSync(base)) {
        const p = join(base, d);
        let subs = [];
        try {
          subs = readdirSync(p);
        } catch {
          continue;
        }
        for (const sid of subs) {
          const f = join(p, sid, "session.v4.jsonl.zstd");
          try {
            const st = statSync(f);
            out.push({ sid, file: f, mtime: st.mtimeMs });
          } catch {
            // 跳过
          }
        }
      }
    } catch {
      return [];
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, limit);
  }

function findSessionFile(sid) {
    try {
      const base = join(HOME, ".dsh/sessions");
      for (const d of readdirSync(base)) {
        const f = join(base, d, String(sid), "session.v4.jsonl.zstd");
        if (existsSync(f)) return f;
      }
    } catch {
      // 找不到就算了
    }
    return null;
  }

export { HOME, listSessionFiles, findSessionFile };
