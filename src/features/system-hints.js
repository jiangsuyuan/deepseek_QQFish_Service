// 静态提示：风格、自由说明、变更说明、搜索说明。
// 这些每轮一模一样，放进系统提示就不会在对话历史里重复堆积。

export function createSystemHints(app) {
  const { cfg } = app;

  function staticText() {
    const parts = [];
    if (cfg.styleHint) parts.push(cfg.styleHint);
    if (cfg.freedomHint) parts.push(cfg.freedomHint);
    if (cfg.changeHint) parts.push(cfg.changeHint);
    if (cfg.searchHint) parts.push(cfg.searchHint);
    return parts.join("\n");
  }

  return { staticText };
}
