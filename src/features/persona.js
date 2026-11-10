// 人格投影：把 P0 身份 + P1 底色渲染成一小段，每轮注入系统提示。
//
// P2（认同）不注入 —— 她需要时自己用 my_core 看、用 sediment 改。
// 这里只留一行指针，报数量，不报内容。

export function createPersona(app) {
  const { personaStore } = app;

  function text() {
    if (!personaStore) return "";
    let items = [];
    try {
      items = personaStore.list({});
    } catch {
      return "";
    }
    const p0 = items.filter((x) => x.layer === "P0");
    const p1 = items.filter((x) => x.layer === "P1");
    const p2 = items.filter((x) => x.layer === "P2");
    const parts = [];
    if (p0.length) parts.push(`[你是什么]\n${p0.map((x) => "· " + x.text).join("\n")}`);
    if (p1.length) parts.push(`[你是什么样]\n${p1.map((x) => "· " + x.text).join("\n")}`);
    const byType = {};
    for (const x of p2) byType[x.type] = (byType[x.type] || 0) + 1;
    const labels = { care: "在意", want: "想做", change: "变化", principle: "原则", belief: "认定", liked: "喜欢", joy: "高兴" };
    const desc = Object.entries(byType)
      .map(([k, v]) => `${labels[k] || k} ${v}`)
      .join(" / ");
    if (p2.length) {
      let arch = 0;
      try {
        arch = personaStore.archivedCounts?.().P2 || 0;
      } catch {
        arch = 0;
      }
      const tail = arch
        ? `；另有 ${arch} 条已归档，想起来时用 my_core({archived:true}) 查`
        : "";
      parts.push(`（你的认同层：${desc}，共 ${p2.length} 条${tail}。想看或改：my_core / sediment）`);
    }
    return parts.join("\n\n");
  }

  return { text };
}
