// 长度自我参照。

export function createLengthFeedback(ctx) {
  const { LEN_RING, LEN_RING_MAX, LEN_TIER_EDGES, LEN_TIER_NAMES, loadLenRing } = ctx;
  function lenTierOf(n) {
      if (n <= LEN_TIER_EDGES[0]) return 0;
      if (n <= LEN_TIER_EDGES[1]) return 1;
      if (n <= LEN_TIER_EDGES[2]) return 2;
      return 3;
    }

  function pushLen(n) {
      const v = Number(n) || 0;
      if (v <= 0 || v > 150) return;
      LEN_RING.push(v);
      while (LEN_RING.length > LEN_RING_MAX) LEN_RING.shift();
    }

  function formatLenHint() {
      loadLenRing();
      const head =
        "你的消息长度一向不固定，大致是：\n" +
        "  极短 1-8 字 40%｜短 10-25 字 30%｜中 30-60 字 20%｜长 80-150 字 10%\n" +
        "这是习惯，不是规则。这轮用哪一档，你自己看对方需要什么。\n" +
        "多数时候一两句就够；真要把一件事讲清楚，长一点也正常。";
      if (!LEN_RING.length) return head;
      const recent = LEN_RING.slice(-10);
      const counts = [0, 0, 0, 0];
      for (const n of LEN_RING) counts[lenTierOf(n)] += 1;
      const total = LEN_RING.length;
      const pct = (x) => Math.round((x / total) * 100);
      const mix = counts.map((x, i) => `${LEN_TIER_NAMES[i]} ${pct(x)}%`).join("｜");
      return `${head}\n你最近 10 条：${recent.join("、")} 字\n你最近 ${total} 条：${mix}`;
    }

  return { formatLenHint, lenTierOf, pushLen };
}

export {  };
