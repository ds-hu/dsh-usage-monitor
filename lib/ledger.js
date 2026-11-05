// lib/ledger.js — 用量账本的归属判据：一条 DSH 路由 → 一个账本 key。
//
// 账本 key 只有两种形态：
//   - 注册表供应商 id（deepseek / openai-org / …）：可查额度，也可能有百分比
//   - `local:<route>`：仅计量，只有经过 Harness 的 token，没有任何可查询的额度或百分比
//
// 归属是纯函数，只由 route 决定。同一 (session, turn, step) 的替换记账因此不会双计：
// 早期样本落旧 key 时被扣掉，最终样本落到新 key，总量只算一次。

/** 仅计量 id 的前缀。注册表 id 里不会出现 `:`，加上它就不会撞车。 */
export const METERED_PREFIX = "local:";

/**
 * 显式并表：某条到达路径确实属于某个已注册供应商时，把用量并进那一行。
 *
 * `deepseek-account`（桌面登录）与 `deepseek-official` / `deepseek`（API Key）是同一账户的两条路，
 * 余额只能按 API Key 查。拆成两行会把「今日总量」读成两家，而第二行永远拿不到指标。
 * 加这张表要谨慎：并错了就是把两个账户的账混在一起，运行期没有证据可以自动纠正。
 */
export const OWNER_ALIAS = { "deepseek-account": "deepseek" };

/** route → 仅计量账本 key。 */
export const meteredIdOf = (route) => `${METERED_PREFIX}${route}`;

export const isMeteredId = (id) => typeof id === "string" && id.startsWith(METERED_PREFIX);

/** 仅计量 key → route；不是仅计量 key 时返回 null。 */
export const routeOfMeteredId = (id) => (isMeteredId(id) ? id.slice(METERED_PREFIX.length) : null);

/**
 * 一条路由落到哪个账本。
 * @param route       事件里的 provider 字符串
 * @param resolveOwner (route) => supplierId | null，注册表归属（含扫描期 discovery）
 * @returns 账本 key；route 不是非空字符串时 null
 */
export function ledgerKeyOf(route, resolveOwner) {
  if (typeof route !== "string" || !route) return null;
  if (Object.hasOwn(OWNER_ALIAS, route)) return OWNER_ALIAS[route];
  const owner = typeof resolveOwner === "function" ? resolveOwner(route) : null;
  return owner || meteredIdOf(route);
}

/**
 * 仅计量行的显示名：用户改名优先，其次扫描拿到的 DSH displayName，最后是路由 id 本身。
 * @param names        config.meteredNames（route → 名字）
 * @param displayNames route → DSH 里的 displayName
 */
export function meteredNameOf(route, names = {}, displayNames = {}) {
  const pick = (value) => (typeof value === "string" ? value.trim().slice(0, 60) : "");
  if (names && typeof names === "object" && Object.hasOwn(names, route)) {
    const custom = pick(names[route]);
    if (custom) return custom;
  }
  if (displayNames && typeof displayNames === "object" && Object.hasOwn(displayNames, route)) {
    const display = pick(displayNames[route]);
    if (display) return display;
  }
  return String(route).slice(0, 120);
}
