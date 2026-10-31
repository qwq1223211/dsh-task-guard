/**
 * ============================================================================
 * lib/scope-preview.js · "先看后付"用的纯函数
 * ============================================================================
 * 为什么需要它（真实事故，2026-10-31）：
 *   一次 task_start 用了 groups:["unity"]，结果把 `plugin_manager`（标签 plugin）
 *   和 `cordis_inspect_*`（标签 cordis）一起摘掉了 —— 而那正是当时在做的活。
 *   根因不是逻辑错，是**调用方不知道有哪些组可以选**：领域（"开发 DSH 插件"）
 *   这个说法在工具表里根本没有对应标签，它的工具散在 plugin / cordis / web / skill 里。
 *
 * 所以这里提供两件东西：
 *   1. summarizeGroups —— 把"这台机器上真实存在的组"列出来（组名 → 工具数）
 *   2. buildPreview    —— 一次收窄会保留什么、摘掉什么（含少量样例）
 *
 * 两者都是**纯函数**，不碰 IO、不碰工具表，可以在 dryRun 里零成本调用。
 * ============================================================================
 */

/** 预览里每边最多列几个名字（全列会刷屏，也没人看） */
export const SAMPLE_SIZE = 8

/**
 * 统计这台机器上真实存在的工具组。
 * @param {Array<{name?: string}>} schemas
 * @param {(name: string) => string} tagOf
 * @returns {Record<string, number>} 组名 → 工具数，按数量降序
 */
export function summarizeGroups(schemas, tagOf) {
  const counts = new Map()
  try {
    for (const tool of Array.isArray(schemas) ? schemas : []) {
      const name = tool && typeof tool.name === 'string' ? tool.name : ''
      if (!name) continue
      const tag = tagOf(name)
      counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  } catch {
    return {}
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return Object.fromEntries(sorted)
}

/**
 * 组一次收窄的预览。
 * @param {{deny: string[], kept: string[], availableGroups: Record<string, number>, groups: string[]}} input
 * @returns {object}
 */
export function buildPreview(input) {
  const deny = Array.isArray(input && input.deny) ? input.deny : []
  const kept = Array.isArray(input && input.kept) ? input.kept : []
  const availableGroups = (input && input.availableGroups) || {}
  const groups = Array.isArray(input && input.groups) ? input.groups : []

  // 用户点名的组里，哪些在这台机器上真的存在
  const foundGroups = groups.filter((g) => Object.hasOwn(availableGroups, g))
  const missingGroups = groups.filter((g) => !Object.hasOwn(availableGroups, g))

  return {
    groups,
    foundGroups,
    missingGroups,
    availableGroups,
    willKeep: kept.length,
    willDeny: deny.length,
    keepSample: kept.slice(0, SAMPLE_SIZE),
    denySample: deny.slice(0, SAMPLE_SIZE),
  }
}
