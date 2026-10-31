/**
 * dsh-task-guard 单测（零依赖，用 node:test）
 * 跑法：node test/task-guard.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须先设状态目录，再 import —— index.js 在模块加载时就定了路径
process.env.TASK_GUARD_DIR = mkdtempSync(join(tmpdir(), 'task-guard-test-'))

const mod = await import('../index.js')
const { apply, computeDeny, tagOf, USAGE_FILE, LOCK_FILE, readLock } = mod
const { estimateTaskCost, measureDeniedBytes, FULL_PRICE_CONTEXT, MIN_TURNS_TO_PAYBACK } = await import(
  '../lib/cost-gate.js'
)

// 每个用例都从"没有锁"开始，否则前一个用例留下的锁会串到下一个
beforeEach(() => {
  rmSync(LOCK_FILE, { force: true })
})

/** 造一个假环境：足够让 apply() 跑起来，并记录 restrict 调用 */
function makeEnv(toolNames) {
  const tools = new Map()
  const restricts = []
  const disposers = []
  const schemas = () => toolNames.map((n) => ({ name: n }))

  const ctx = {
    effect(fn) {
      const out = fn()
      if (typeof out === 'function') disposers.push(out)
      return () => {}
    },
    on() {},
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => {}
      },
      schemas,
    },
  }

  const agent = {
    ctx: {
      tools: {
        schemas,
        restrict(filter) {
          restricts.push(filter)
          // 真实 DSH 返回一个 dispose；测试里也要能查到"被调用了几次"
          return () => restricts.push({ __dispose: true })
        },
      },
    },
  }

  apply(ctx, {})
  return {
    tools,
    restricts,
    disposers,
    agent,
    async call(name, args) {
      const tool = tools.get(name)
      assert.ok(tool, `工具 ${name} 应该注册过`)
      return tool.execute(args, { agent })
    },
  }
}

const TOOLS = [
  'read',
  'write',
  'shell',
  'task_start',
  'task_end',
  'task_status',
  'route_stage',
  'guard_reset',
  'cache_probe_report',
  'subagent',
  'send_message',
  'run_code',
  'unity_object_create',
  'unity_screenshot',
  'asset_audit',
  'art_generate_image',
  'mcp__meshy__meshy_text_to_3d',
]

test('tagOf：基础工具 / 普通前缀 / MCP 三种形态都认', () => {
  assert.equal(tagOf('read'), 'core')
  assert.equal(tagOf('unity_object_create'), 'unity')
  assert.equal(tagOf('mcp__meshy__meshy_text_to_3d'), 'meshy')
  assert.equal(tagOf(''), 'unknown')
})

test('computeDeny：只摘任务组之外的，基础工具与逃生门一律保留', () => {
  const { deny, kept } = computeDeny(TOOLS, ['unity'])
  assert.ok(deny.includes('art_generate_image'))
  assert.ok(deny.includes('asset_audit'))
  assert.ok(deny.includes('mcp__meshy__meshy_text_to_3d'))
  // 保留：基础工具 + 逃生门 + 任务组
  for (const name of ['read', 'write', 'shell', 'task_start', 'route_stage', 'guard_reset', 'cache_probe_report', 'unity_screenshot']) {
    assert.ok(kept.includes(name), `${name} 必须保留`)
  }
})

test('computeDeny：run_code / subagent / send_message 永远不进 deny（否则抛错或死锁）', () => {
  const { deny } = computeDeny(TOOLS, ['unity'])
  for (const name of ['run_code', 'subagent', 'send_message']) {
    assert.equal(deny.includes(name), false, `${name} 不能被摘掉`)
  }
})

test('task_start：只调一次 restrict，且只传 deny（绝不传 allow）', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_start', { groups: ['unity'] })
  assert.equal(out.ok, true)
  assert.equal(out.applied, true)
  assert.equal(env.restricts.filter((r) => !r.__dispose).length, 1, '只该收窄一次')
  const filter = env.restricts[0]
  assert.ok(Array.isArray(filter.deny), '必须用 deny')
  assert.equal(filter.allow, undefined, '绝不能传 allow（会藏掉点不出名字的工具）')
  assert.ok(filter.deny.length > 0)
})

test('task_start：groups 为空直接拒绝（歧义不许猜）', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_start', { groups: [] })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'EMPTY_GROUPS')
  assert.equal(env.restricts.length, 0, '拒绝时不该动工具表')
  assert.equal(readLock(), null, '拒绝时不该占锁')
})

test('task_start：同一会话重复开任务被拒绝', async () => {
  const env = makeEnv(TOOLS)
  await env.call('task_start', { groups: ['unity'] })
  const second = await env.call('task_start', { groups: ['art'] })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'ALREADY_ACTIVE')
})

test('task_start：写不存在的组名要明确报出来（否则"装了没效果"）', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_start', { groups: ['unity', 'snowluma'] })
  assert.deepEqual(out.unknownGroups, ['snowluma'])
})

test('task_end：拆掉限制、释放锁、清掉会话状态', async () => {
  const env = makeEnv(TOOLS)
  await env.call('task_start', { groups: ['unity'] })
  assert.ok(readLock(), '开任务后应该有锁文件')

  const out = await env.call('task_end', {})
  assert.equal(out.ok, true)
  assert.equal(out.restored, true)
  assert.equal(env.restricts.filter((r) => r.__dispose).length, 1, 'dispose 必须被调一次')
  assert.equal(readLock(), null, '锁文件该被清空')
})

test('task_end：没有任务时报 NO_ACTIVE_TASK（而不是静默成功）', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_end', {})
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NO_ACTIVE_TASK')
})

test('usage.jsonl：start / end 都带 taskId，且能对上', async () => {
  const env = makeEnv(TOOLS)
  const started = await env.call('task_start', { groups: ['unity'], goal: '收网' })
  await env.call('task_end', {})

  assert.ok(existsSync(USAGE_FILE), '流水文件应该被创建')
  const lines = readFileSync(USAGE_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const start = lines.find((l) => l.event === 'start' && l.taskId === started.taskId)
  const end = lines.find((l) => l.event === 'end' && l.taskId === started.taskId)
  assert.ok(start, '要有 start 记录')
  assert.ok(end, '要有 end 记录')
  assert.deepEqual(start.groups, ['unity'])
  assert.ok(start.denyCount > 0)
  assert.ok(typeof end.durationMs === 'number')
})

test('插件卸载：会把工具表还回去（防"限制永远留着"）', async () => {
  const env = makeEnv(TOOLS)
  await env.call('task_start', { groups: ['unity'] })
  // 跑所有 effect 的 disposer，模拟插件被禁用/热重载
  for (const dispose of env.disposers) dispose()
  assert.equal(env.restricts.filter((r) => r.__dispose).length, 1, '卸载时必须 dispose 限制')
  assert.equal(readLock(), null, '卸载时必须放锁')
})

test('task_status：能读到当前任务与锁', async () => {
  const env = makeEnv(TOOLS)
  const started = await env.call('task_start', { groups: ['unity'] })
  const status = await env.call('task_status', {})
  assert.equal(status.ok, true)
  assert.equal(status.active.taskId, started.taskId)
  assert.equal(status.lock.mine, true)
  assert.equal(status.stateDir, process.env.TASK_GUARD_DIR)
})

// ============================================================================
// 六、成本闸门（收窄 = 一次全价重建，跑不够轮数就是亏）
// ============================================================================

test('成本闸门：没东西可摘时不拦（nothing-to-deny）', () => {
  const report = estimateTaskCost({ contextTokens: 500_000, turns: 2, deniedBytes: 0 })
  assert.equal(report.allow, true)
  assert.equal(report.reason, 'nothing-to-deny')
})

test('成本闸门：没给上下文大小时不拦，但要如实说"算不出来"', () => {
  const report = estimateTaskCost({ contextTokens: null, turns: 2, deniedBytes: 100_000 })
  assert.equal(report.allow, true)
  assert.equal(report.reason, 'insufficient-data')
  assert.ok(report.message.includes('cache_probe_report'), '要告诉用户数据从哪来')
})

test('成本闸门：大上下文 + 短任务 → 拒绝，并给出回本账', () => {
  const report = estimateTaskCost({ contextTokens: 280_000, turns: 3, deniedBytes: 174_575 })
  assert.equal(report.allow, false)
  assert.equal(report.reason, 'not-worth-it')
  assert.ok(report.paybackTurns >= 1)
  assert.ok(report.message.includes('拒绝收窄'))
  assert.ok(report.message.includes('force'), '要告诉用户怎么强切')
})

test('成本闸门：大上下文 + 长任务 → 放行（够轮数回本）', () => {
  const report = estimateTaskCost({
    contextTokens: 280_000,
    turns: MIN_TURNS_TO_PAYBACK + 4,
    deniedBytes: 174_575,
  })
  assert.equal(report.allow, true)
  assert.equal(report.reason, 'ok')
})

test('成本闸门：小上下文 + 短任务 → 放行（重建本来就便宜）', () => {
  const report = estimateTaskCost({ contextTokens: FULL_PRICE_CONTEXT - 1, turns: 2, deniedBytes: 100_000 })
  assert.equal(report.allow, true)
})

test('measureDeniedBytes：只量被摘掉的那些', () => {
  const schemas = [
    { name: 'read', description: 'x'.repeat(100) },
    { name: 'unity_object_create', description: 'y'.repeat(400) },
  ]
  const bytes = measureDeniedBytes(schemas, new Set(['unity_object_create']))
  assert.ok(bytes > 400, '应该量到 unity 那个')
  assert.ok(bytes < 600, '不该把 read 算进去')
  assert.equal(measureDeniedBytes(schemas, new Set()), 0)
})

test('task_start：被闸门拒绝时不碰工具表、不占锁', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_start', { groups: ['unity'], contextTokens: 300_000, turns: 2 })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'COST_GATE')
  assert.equal(env.restricts.length, 0, '拒绝时绝不能动工具表')
  assert.equal(readLock(), null, '拒绝时绝不能占锁')
  assert.ok(out.message.includes('拒绝收窄'))
})

test('task_start：force: true 可以强行绕过闸门', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_start', { groups: ['unity'], contextTokens: 300_000, turns: 2, force: true })
  assert.equal(out.ok, true)
  assert.equal(out.applied, true)
  assert.equal(env.restricts.length, 1)
})

test('task_start：通过闸门时把经济账一起返回来', async () => {
  const env = makeEnv(TOOLS)
  const out = await env.call('task_start', { groups: ['unity'], contextTokens: 50_000, turns: 10 })
  assert.equal(out.ok, true)
  assert.ok(out.cost, '要带 cost 报告')
  assert.ok(out.cost.savingsPerTurn > 0)
  assert.ok(typeof out.cost.paybackTurns === 'number')
})
