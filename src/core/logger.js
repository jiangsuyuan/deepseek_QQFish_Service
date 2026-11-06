// 共享日志器：模块级函数拿不到闭包里的 logger，统一从这里取。
let current = null;

export function setLogger(l) {
  current = l;
}

export function getLogger() {
  return current;
}

export { current };
