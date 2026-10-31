/**
 * ============================================================================
 * lib/cost-gate.js · 收窄的"经济账"
 * ============================================================================
 * 任务收窄是**一次性全价重建 + 每轮持续省钱**。所以它有个回本点：
 *
 *   成本   = 切换那一刻的整段上下文（contextTokens，全价重算）
 *   每轮省 = 被摘掉工具声明的字节数 × 每字节 token 数（0.3，和 router 同一口径）
 *   回本   = 成本 / 每轮省
 *
 * 实测依据（本机，2026-10-31，一次真实收窄）：
 *   272 个工具 / 232,458 字节 → 78 个 / 57,883 字节（摘掉 174,575 字节）
 *   那一次请求：promptTokens 285,701，cacheRead 只有 4,608 → 命中率 1.61%
 *   → 一次性成本 ≈ 28.1 万全价 token，按 0.3 算每轮省 ≈ 5.2 万 → 回本 ≈ 5.4 轮
 *
 * 结论：**任务跑不够约 6 轮，收窄就是纯亏。** 这个文件就是把这条账做成门槛。
 * ============================================================================
 */

/** 上下文超过这个量级，一次重建就非常贵了（实测 33 万上下文 ≈ 28 万全价 token） */
export const FULL_PRICE_CONTEXT = 200_000

/** 低于这个预估轮数、且上下文已经很大时，收窄不划算 */
export const MIN_TURNS_TO_PAYBACK = 6

/**
 * 每字节约等于多少 token。
 *
 * 【实测校准（2026-10-31）】Web UI 的「用量 → 工具定义」显示约 58.3K token，
 * 而探针的 toolsChars 是 232,458 字节 → 232,458 / 58,300 ≈ 3.99 字节/token，
 * 也就是 **0.25 token/字节**。
 *
 * 原来按 router 的 switchSavingsPerByte = 0.3 填的，**高估约 20%**：
 * 每轮省会被算大，回本被算短。这里改成实测值，宁可保守也不要乐观。
 */
export const SAVINGS_PER_BYTE = 0.25

/**
 * 量一下"这次要摘掉多少字节的工具声明"。
 * 和 router 里的算法一致：把 name/description/parameters 序列化后计长。
 * @param {Array<{name?:string, description?:string, parameters?:object}>} schemas
 * @param {Set<string>} denySet 要摘掉的名字集合
 * @returns {number} 字节数
 */
export function measureDeniedBytes(schemas, denySet) {
  try {
    const list = Array.isArray(schemas) ? schemas : []
    if (!(denySet instanceof Set) || denySet.size === 0) return 0
    let bytes = 0
    for (const tool of list) {
      if (!tool || typeof tool.name !== 'string' || !denySet.has(tool.name)) continue
      bytes += JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length
    }
    return bytes
  } catch {
    return 0
  }
}

/**
 * 算这笔账。
 *
 * 【诚实原则】`contextTokens` 和 `turns` 都是**调用方给的**，我们不会去猜，也不会去读
 * 别的插件的数据文件（跨插件读别人的账单属于隐性耦合）。拿不到就如实说"数据不足"。
 *
 * @param {{contextTokens?: number|null, turns?: number|null, deniedBytes?: number}} input
 * @returns {{
 *   allow: boolean,
 *   reason: 'ok'|'not-worth-it'|'insufficient-data'|'nothing-to-deny',
 *   costTokens: number|null,
 *   savingsPerTurn: number,
 *   paybackTurns: number|null,
 *   deniedBytes: number,
 *   message: string,
 * }}
 */
export function estimateTaskCost(input) {
  const rawContext = Number(input && input.contextTokens)
  const contextTokens = Number.isFinite(rawContext) && rawContext > 0 ? Math.trunc(rawContext) : null
  const rawTurns = Number(input && input.turns)
  const turns = Number.isFinite(rawTurns) && rawTurns > 0 ? Math.trunc(rawTurns) : null
  const deniedBytes = Math.max(0, Math.trunc(Number(input && input.deniedBytes) || 0))

  const savingsPerTurn = Math.round(deniedBytes * SAVINGS_PER_BYTE)

  // 没什么可摘的 → 不用算，也不会亏
  if (deniedBytes === 0) {
    return {
      allow: true,
      reason: 'nothing-to-deny',
      costTokens: contextTokens,
      savingsPerTurn: 0,
      paybackTurns: null,
      deniedBytes: 0,
      message: '这个任务本来就不需要摘工具，没有切换成本。',
    }
  }

  // 数据不足 → 不拦（拦了会让人以为插件坏了），但明确说"没算出来"
  if (contextTokens === null) {
    return {
      allow: true,
      reason: 'insufficient-data',
      costTokens: null,
      savingsPerTurn,
      paybackTurns: null,
      deniedBytes,
      message: `没拿到当前上下文大小，无法估算回本。每轮约省 ${savingsPerTurn} token；想让我算清楚就传 contextTokens（可从 cache_probe_report 的 lastPromptTokens 取）。`,
    }
  }

  const paybackTurns = savingsPerTurn > 0 ? Math.ceil(contextTokens / savingsPerTurn) : null

  // 【主判据】用户的显式规则：上下文已经很大 + 任务又短 → 拒绝
  const tooExpensive = contextTokens > FULL_PRICE_CONTEXT
  const tooShort = turns !== null && turns < MIN_TURNS_TO_PAYBACK
  const notWorthIt = tooExpensive && tooShort

  if (notWorthIt) {
    return {
      allow: false,
      reason: 'not-worth-it',
      costTokens: contextTokens,
      savingsPerTurn,
      paybackTurns,
      deniedBytes,
      message:
        `【拒绝收窄】当前上下文 ${contextTokens} token，收窄会触发一次约 ${contextTokens} token 的全价重建；` +
        `而这次任务预估只有 ${turns} 轮，每轮约省 ${savingsPerTurn} token，` +
        `需要 ${paybackTurns ?? '>99'} 轮才回本（阈值 ${MIN_TURNS_TO_PAYBACK} 轮）——跑不够就是亏。` +
        '确实要切就传 force: true。',
    }
  }

  return {
    allow: true,
    reason: 'ok',
    costTokens: contextTokens,
    savingsPerTurn,
    paybackTurns,
    deniedBytes,
    message:
      `收窄一次性成本约 ${contextTokens} token，每轮约省 ${savingsPerTurn} token` +
      (paybackTurns === null ? '。' : `，约 ${paybackTurns} 轮回本。`),
  }
}
