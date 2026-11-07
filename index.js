/**
 * ============================================================================
 * dsh-task-guard · 任务级工具收窄（300 行的护城河）
 * ============================================================================
 * 这个插件只干一件事：**任务开始时按 groups 收窄一次工具表，任务结束时恢复。**
 *
 * ---------------------------------------------------------------------------
 * 为什么只做这一件事
 * ---------------------------------------------------------------------------
 * 在 DSH 里，改工具表 = 前缀指纹变化 = 一次**全价重建**。本机实测：一次重载
 * 563,654 token 全价（命中率 0.97%）；长会话里一次重建能到几十万 token。
 * 所以"收窄"只在**任务开头**做**一次**，中途绝不调整——这就是它跟市面那堆
 * "每轮按任务改工具表"的插件的根本区别。
 *
 * ---------------------------------------------------------------------------
 * 为什么只用 deny，绝不用 allow（这是踩出来的，不是理论）
 * ---------------------------------------------------------------------------
 * restrict({ allow }) 的语义是"只留我点名的"。而 read / write / send_message
 * 这类**作用域本地注册**的工具不在 restrictableNames 里——我们点不出名字，
 * 它们就会被"只留点名的"一起藏掉。
 * 实测 4/4 个会话丢掉 read（报 unknown tool "read"），其中一个连 send_message
 * 都没了 → 子代理干完活无法回报 → **父代理永远等不到 → 死锁**。
 *
 * ---------------------------------------------------------------------------
 * 为什么这些工具永远不 deny
 * ---------------------------------------------------------------------------
 *   run_code      DSH 硬拦截：把它写进 allow/deny 会直接抛错，而我们外层是
 *                 try/catch，表现就是"静默不裁剪"
 *   subagent /   藏了它们 = 断掉委派与回报 = 死锁
 *   send_message
 *   route_* /    逃生门与仪表：出问题时你得能切回去、能看账单
 *   guard_* /
 *   cache_probe_*
 *   core 类工具  连读文件都禁掉，任务就没法干了
 * ============================================================================
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  existsSync,
} from 'node:fs'
import { estimateTaskCost, measureDeniedBytes } from './lib/cost-gate.js'
import { buildPreview, summarizeGroups } from './lib/scope-preview.js'

/** 插件名（DSH 里用于配置定位） */
export const name = 'task-guard'
/**
 * 依赖声明。
 * 【必须是硬依赖】apply() 里要调 ctx.tools.register，而 Cordis 规定：
 * 没在 inject 里声明的服务，访问时会抛 `cannot get property "tools" without inject`。
 * （第一版我写成 inject = []，装上去直接报这个错——所以这条不是理论。）
 * 不声明 systemPrompt：本插件**一个字节都不往上下文里塞**。
 */
export const inject = ['tools']

/**
 * 状态目录。
 * 【为什么不在插件目录里】pnpm 安装的包目录是只读/会被覆盖的，
 * 往包内写文件 = 升级即丢数据。必须放到用户家目录。
 * 【为什么允许环境变量覆盖】测试要隔离，不能污染真实状态。
 */
export const STATE_DIR =
  typeof process.env.TASK_GUARD_DIR === 'string' && process.env.TASK_GUARD_DIR
    ? process.env.TASK_GUARD_DIR
    : join(homedir(), '.dsh', 'task-guard')

export const LOCK_FILE = join(STATE_DIR, 'active.lock')
export const USAGE_FILE = join(STATE_DIR, 'usage.jsonl')

/**
 * "当前任务"快照文件。
 * 【为什么要有它】客户端 UI（浏览器里跑的徽章）读不到 Host 进程的内存，
 * 只能靠 HTTP 接口取状态。所以每次任务开始/结束时把快照写下来，UI 去读这个文件。
 */
export const CURRENT_FILE = join(STATE_DIR, 'current.json')
/**
 * 全量工具清单（v0.5.0）。
 * task_start（含 dryRun）会把它写下来；task_end 不影响它。
 * 用途：认领建议、徽章空态显示工具数——这些都不该依赖"当前是否有任务"。
 */
export const REGISTRY_FILE = join(STATE_DIR, 'tool-registry.json')

/** 任务锁存活上限（毫秒）：超过就算僵尸锁，直接回收 */
export const LOCK_TTL_MS = 6 * 3600 * 1000

/** 永远不 deny 的**标签**：task/route/guard/cache 这几组是逃生门与仪表 */
export const KEEP_TAGS = Object.freeze(new Set(['task', 'route', 'guard', 'cache']))

/** 永远不 deny 的**具体工具名**（原因见文件头注释） */
export const KEEP_NAMES = Object.freeze(
  new Set(['run_code', 'subagent', 'subagent_fork', 'workflow', 'send_message', 'todo_write']),
)

/**
 * 【DSH 强制】每个工具必须声明 output：{ schema, render }。
 * 少了它注册直接抛 TypeError: tool "x" must declare output { schema, render, presentationMeta? }
 * 形状和 dsh-minimal-router 里的一致（纯 JSON 文本输出）。
 */
const RENDER = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

// ============================================================================
// 一、纯函数层（可单测，不碰 IO）
// ============================================================================

/**
 * 从工具名推标签。规则和 minimal-router 保持一致：
 *   read                        → core     （没有下划线）
 *   unity_object_create         → unity
 *   task_start                  → task
 *   mcp__meshy__meshy_image_to_3d → meshy  （MCP 的组在中间）
 * @param {string} toolName
 * @returns {string}
 */
export function tagOf(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) return 'unknown'
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    return parts.length >= 3 && parts[1] ? parts[1] : 'mcp'
  }
  const cut = toolName.indexOf('_')
  return cut <= 0 ? 'core' : toolName.slice(0, cut)
}

/**
 * 算出要摘掉哪些工具。
 *
 * 【关键】这里只返回 deny 列表，**永远不构造 allow 列表**。
 *
 * @param {string[]} toolNames 当前这个会话能看见的工具名
 * @param {string[]} groups 任务要保留的组
 * @returns {{ deny: string[], kept: string[], unknownGroups: string[] }}
 */
export function computeDeny(toolNames, groups) {
  const want = new Set(
    (Array.isArray(groups) ? groups : [])
      .map((g) => (typeof g === 'string' ? g.trim().toLowerCase() : ''))
      .filter(Boolean),
  )
  const names = Array.isArray(toolNames) ? toolNames : []
  const deny = []
  const kept = []
  const seenGroups = new Set()

  for (const toolName of names) {
    if (typeof toolName !== 'string' || toolName.length === 0) continue
    const tag = tagOf(toolName)
    seenGroups.add(tag)
    const alwaysKeep =
      KEEP_NAMES.has(toolName) || tag === 'core' || KEEP_TAGS.has(tag) || want.has(tag)
    if (alwaysKeep) kept.push(toolName)
    else deny.push(toolName)
  }

  // 用户写的组名如果在这台机器上根本不存在，要明确告诉他（否则"装了没效果"）
  const unknownGroups = [...want].filter((g) => !seenGroups.has(g))
  return { deny, kept, unknownGroups }
}

// ============================================================================
// 二、IO 层（原子写 + 锁）
// ============================================================================

/** 目录按需创建（幂等） */
export function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true })
}

/**
 * 原子写 JSON：先写 tmp 再 rename。
 * 【为什么】直接 writeFileSync 在写入过程中崩溃会留下半个文件，
 * 下次读 JSON.parse 直接抛，整个插件起不来。rename 在同一分区上是原子的。
 */
export function atomicWriteJson(file, value) {
  ensureDir()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/**
 * pid 还活着吗？
 * 【注意 EPERM】kill(pid,0) 在无权限时抛 EPERM，但那说明进程**存在**，要当活着。
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

/** 读当前锁（没有/坏文件都返回 null，不抛） */
export function readLock() {
  try {
    if (!existsSync(LOCK_FILE)) return null
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 抢锁。已有一个**活着且没超时**的任务 → 抛 TASK_LOCKED。
 * @param {{taskId:string, groups:string[], cwd?:string}} info
 */
export function acquireLock(info) {
  const current = readLock()
  if (current && current.taskId !== info.taskId) {
    const ageMs = Date.now() - Number(current.startedAt || 0)
    // 同进程内允许多次（不同会话各自有 Map 守卫），跨进程才靠这把锁
    if (pidAlive(Number(current.pid)) && current.pid !== process.pid && ageMs < LOCK_TTL_MS) {
      const error = new Error(
        `另一个任务还在跑：${current.taskId}（pid ${current.pid}，已 ${Math.round(ageMs / 1000)} 秒）`,
      )
      error.code = 'TASK_LOCKED'
      throw error
    }
  }
  atomicWriteJson(LOCK_FILE, {
    taskId: info.taskId,
    pid: process.pid,
    startedAt: Date.now(),
    groups: info.groups,
    cwd: info.cwd || '',
  })
}

/**
 * 放锁。只放自己那把（taskId 对不上就不动，避免把别人的锁删了）。
 * @param {string} taskId
 */
export function releaseLock(taskId) {
  const current = readLock()
  if (!current) return false
  if (taskId && current.taskId !== taskId) return false
  try {
    if (existsSync(LOCK_FILE)) writeFileSync(LOCK_FILE, '', 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 往任务流水里追加一条记录（JSONL，一行一条）。
 * 字段刻意和 minimal-router 的探针记录保持同一套命名，方便一起分析。
 * @param {object} record
 */
export function appendRecord(record) {
  ensureDir()
  const line = JSON.stringify({
    v: 1,
    at: Date.now(),
    iso: new Date().toISOString(),
    pid: process.pid,
    ...record,
  })
  appendFileSync(USAGE_FILE, `${line}\n`, 'utf8')
}

// ============================================================================
// 三、会话状态
// ============================================================================

/**
 * 写"当前任务"快照（给 UI 读）。
 * 失败不抛：UI 是锦上添花，不能因为它让任务开不起来。
 * @param {object} state
 */
export function writeCurrent(state) {
  try {
    atomicWriteJson(CURRENT_FILE, { ...state, at: Date.now() })
  } catch {
    /* UI 快照失败不影响主流程 */
  }
}

/** 每个会话当前在跑的任务：key → { taskId, groups, startedAt, dispose, applied, denyCount } */
const activeTasks = new Map()

/**
 * 给 agent 对象分配稳定 key。
 * 【为什么用 WeakMap】没有 id 的 agent（测试里常见）如果退化成同一个字符串，
 * 多会话状态会互相污染——minimal-router 在这上面踩过坑。
 */
const agentKeys = new WeakMap()
let agentSeq = 0

export function keyOf(exec) {
  const agent = exec && exec.agent
  if (agent && typeof agent === 'object') {
    let key = agentKeys.get(agent)
    if (!key) {
      agentSeq += 1
      key = `agent-${agentSeq}`
      agentKeys.set(agent, key)
    }
    return key
  }
  const sessionId = exec && exec.sessionId
  return `session-${typeof sessionId === 'string' && sessionId ? sessionId : 'unknown'}`
}

/** 生成任务 id：时间可读 + 随机后缀防撞 */
function newTaskId() {
  return `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

// ============================================================================
// 四、插件入口
// ============================================================================

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{lockTtlHours?: number}} config
 */
export function apply(ctx, config = {}) {
  ensureDir()

  // 【卸载保护】插件被禁用/热重载时，必须把工具表还回去。
  // 否则会出现"任务没结束但限制永远留着"——最恶心的一种残留。
  ctx.effect(
    () => () => {
      for (const [key, task] of activeTasks) {
        try {
          if (typeof task.dispose === 'function') task.dispose()
        } catch {
          /* 卸载时的异常不该影响主流程 */
        }
        releaseLock(task.taskId)
        appendRecord({ event: 'end', taskId: task.taskId, reason: 'plugin-teardown', key })
        activeTasks.delete(key)
      }
    },
  )

  // --------------------------------------------------------------------------
  // task_start —— 开任务 + 收窄一次
  // --------------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'task_start',
      output: RENDER,
      description:
        'Start a task and narrow the visible tool groups once (deny-only). Tools outside the named groups are removed for the duration of the task and restored by task_end. Call this once at the beginning — do not re-narrow mid-task (each change costs a full-price prefix rebuild).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool groups to keep for this task, e.g. ["unity","asset"]. Base tools, route_*/guard_*/cache_probe_* are always kept.',
          },
          goal: {
            type: 'string',
            description: 'Optional one-line goal, recorded in the usage log.',
          },
          contextTokens: {
            type: 'integer',
            description:
              'Current context size in tokens (take lastPromptTokens from cache_probe_report). Narrowing costs one full-price rebuild of about this size, so it is needed to decide whether narrowing pays off.',
          },
          turns: {
            type: 'integer',
            description:
              'Roughly how many turns this task will take. In a large context, fewer than 6 turns cannot pay back the rebuild and is refused unless force is set.',
          },
          force: {
            type: 'boolean',
            description: 'Narrow even when the cost gate says it will not pay back — you accept one full-price rebuild.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'Preview only: report what would be kept or removed plus availableGroups, without touching the tool table or taking the lock. Costs nothing. Use it to pick the right groups before committing.',
          },
        },
        required: ['groups'],
      },
      async execute(args, exec) {
        const key = keyOf(exec)
        if (activeTasks.has(key)) {
          const running = activeTasks.get(key)
          return { ok: false, code: 'ALREADY_ACTIVE', taskId: running.taskId, hint: '先 task_end 结束当前任务' }
        }

        const groups = (Array.isArray(args?.groups) ? args.groups : [])
          .map((g) => (typeof g === 'string' ? g.trim().toLowerCase() : ''))
          .filter(Boolean)

        // 【歧义就报错，不要猜】groups: [] 可以理解成"只留基础工具"，也可以理解成"不收窄"。
        // 两种都合理，但选错一次就把任务需要的工具全摘了。所以直接拒绝，让调用方写清楚。
        if (groups.length === 0) {
          return {
            ok: false,
            code: 'EMPTY_GROUPS',
            message: 'groups 不能为空：要收窄就写至少一个组名；不想收窄就别开任务。',
          }
        }

        // 拿到这个会话真实的工具清单（优先 agent 作用域）
        const agent = exec && exec.agent
        const scoped = agent && agent.ctx && agent.ctx.tools
        let schemas = []
        try {
          if (scoped && typeof scoped.schemas === 'function') schemas = scoped.schemas()
          else if (typeof ctx.tools.schemas === 'function') schemas = ctx.tools.schemas()
        } catch {
          schemas = []
        }
        // 只要名字给算法层；原始 schema 留着给成本估算量字节
        const toolNames = (Array.isArray(schemas) ? schemas : [])
          .map((t) => (t && typeof t.name === 'string' ? t.name : ''))
          .filter(Boolean)

        const { deny, kept, unknownGroups } = computeDeny(toolNames, groups)

        // 【v0.5.0】持久工具清单：dryRun 也会写（不花重建成本）。
        // 为什么需要：task_end 之后的快照里没有名单，而"认领建议 / 空态显示工具数"
        // 都需要一份全量工具名。这份文件是唯一的长期来源。
        try {
          atomicWriteJson(REGISTRY_FILE, { at: Date.now(), count: toolNames.length, tools: toolNames })
        } catch {
          // 写不了就算了，不影响任务
        }

        // 【B】把这台机器上真实存在的组列出来——否则调用方只能凭记忆猜组名。
        const availableGroups = summarizeGroups(schemas, tagOf)

        // 【成本闸门】收窄 = 一次全价重建（实测 33 万上下文 ≈ 28 万全价 token）。
        // 数据由调用方给，拿不到就如实说"算不出来"，绝不猜。
        const deniedBytes = measureDeniedBytes(schemas, new Set(deny))
        const cost = estimateTaskCost({
          contextTokens: args?.contextTokens,
          turns: args?.turns,
          deniedBytes,
        })

        // 【A】dryRun：只看不碰。不抢锁、不动工具表、不写任务状态，成本 0。
        // 连成本闸门的拒绝也一并展示出来——你需要看到"为什么不该切"。
        if (args?.dryRun === true) {
          const preview = buildPreview({ deny, kept, availableGroups, groups })
          appendRecord({ event: 'dry-run', groups, denyCount: deny.length, deniedBytes, gate: cost.reason })
          return {
            ok: true,
            dryRun: true,
            ...preview,
            unknownGroups,
            cost,
            message:
              `预览：会保留 ${preview.willKeep} 个、摘掉 ${preview.willDeny} 个。` +
              (preview.missingGroups.length > 0 ? `这些组名在这台机器上不存在：${preview.missingGroups.join(', ')}。` : '') +
              '确认无误后去掉 dryRun 再调一次。',
          }
        }

        if (!cost.allow && args?.force !== true) {
          appendRecord({ event: 'gate-refused', groups, denyCount: deny.length, deniedBytes, cost })
          return { ok: false, code: 'COST_GATE', message: cost.message, cost, availableGroups }
        }

        const taskId = newTaskId()

        // 先抢锁（跨进程唯一），失败就不要动工具表
        try {
          acquireLock({ taskId, groups, cwd: process.cwd() })
        } catch (error) {
          return { ok: false, code: error.code || 'LOCK_FAILED', message: String(error.message || error) }
        }

        // 只在 agent.ctx.tools 上调（全局调用 DSH 会直接拒绝）
        let dispose = null
        let restrictError = ''
        if (deny.length > 0) {
          if (scoped && typeof scoped.restrict === 'function') {
            try {
              // 只用 deny。allow 会藏掉点不出名字的工具（实测 4/4 丢 read）
              dispose = scoped.restrict({ deny })
            } catch (error) {
              restrictError = String((error && error.message) || error)
            }
          } else {
            restrictError = 'no-scoped-tools'
          }
        }

        // 收窄失败就别占着锁（否则后面的任务都进不来）
        if (!dispose && deny.length > 0) {
          releaseLock(taskId)
          appendRecord({ event: 'start-failed', taskId, groups, denyCount: deny.length, error: restrictError })
          return { ok: false, code: 'RESTRICT_FAILED', message: restrictError, denyCount: deny.length }
        }

        const task = {
          taskId,
          groups,
          goal: typeof args?.goal === 'string' ? args.goal.slice(0, 200) : '',
          startedAt: Date.now(),
          dispose,
          applied: Boolean(dispose),
          denyCount: deny.length,
          knownTools: toolNames.length,
          cost,
        }
        activeTasks.set(key, task)

        // 给 UI 的快照（浏览器读不到内存，只能读文件）
        // 【v0.4.0】除了数字，也把**具体工具名**写进去：面板要能回答"保留了什么、砍了什么"。
        const countByTag = (names) => {
          const out = {}
          for (const name of names) {
            const tag = tagOf(name)
            out[tag] = (out[tag] || 0) + 1
          }
          return out
        }
        writeCurrent({
          active: true,
          taskId,
          groups,
          goal: task.goal,
          denyCount: deny.length,
          keptCount: kept.length,
          keptTools: kept,
          deniedTools: deny,
          deniedByTag: countByTag(deny),
          deniedBytes,
          startedAt: task.startedAt,
          applied: task.applied,
          savingsPerTurn: cost.savingsPerTurn,
          paybackTurns: cost.paybackTurns,
        })

        appendRecord({
          event: 'start',
          taskId,
          key,
          goal: task.goal,
          groups,
          denyCount: deny.length,
          keptCount: kept.length,
          knownTools: toolNames.length,
          applied: task.applied,
          unknownGroups,
          // 经济账也一起记下来，事后能复盘"这次收窄到底值不值"
          deniedBytes,
          costTokens: cost.costTokens,
          savingsPerTurn: cost.savingsPerTurn,
          paybackTurns: cost.paybackTurns,
          gate: cost.reason,
        })

        return {
          ok: true,
          taskId,
          groups,
          // 注意：这是"我们摘掉了多少"，不是"还剩多少"。真实剩余以探针为准。
          denyCount: deny.length,
          keptCount: kept.length,
          applied: task.applied,
          unknownGroups,
          // 【B】也带一份组清单：任务跑起来后你还想知道"当初如果有别的组可不可以选"
          availableGroups,
          cost,
          note: '工具表已按任务收窄；结束时调 task_end 恢复。中途不要改。',
        }
      },
    }),
  )

  // --------------------------------------------------------------------------
  // task_end —— 结束任务 + 恢复全量
  // --------------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'task_end',
      output: RENDER,
      description:
        'End the current task: dispose the tool restriction (restore every tool) and release the task lock. Returns the task summary recorded in the usage log.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute(_args, exec) {
        const key = keyOf(exec)
        const task = activeTasks.get(key)
        if (!task) return { ok: false, code: 'NO_ACTIVE_TASK', hint: '当前会话没有在跑的任务' }

        let restored = false
        try {
          if (typeof task.dispose === 'function') {
            task.dispose()
            restored = true
          }
        } catch (error) {
          appendRecord({ event: 'end-error', taskId: task.taskId, key, error: String((error && error.message) || error) })
        }
        releaseLock(task.taskId)
        activeTasks.delete(key)

        // 告诉 UI：任务结束了（保留工具总数，好让徽章显示"工具表：全开（N 个）"）
        writeCurrent({
          active: false,
          taskId: task.taskId,
          groups: task.groups,
          denyCount: task.denyCount,
          keptCount: Math.max(0, (task.knownTools || 0) - task.denyCount),
          knownTools: task.knownTools,
          endedAt: Date.now(),
        })

        const durationMs = Date.now() - task.startedAt
        appendRecord({
          event: 'end',
          taskId: task.taskId,
          key,
          groups: task.groups,
          denyCount: task.denyCount,
          durationMs,
          restored,
        })

        return {
          ok: true,
          taskId: task.taskId,
          durationMs,
          restored,
          denyCount: task.denyCount,
          note: restored ? '工具表已恢复全量' : '本来就没收窄（或限制已被外部拆除）',
        }
      },
    }),
  )

  // --------------------------------------------------------------------------
  // task_status —— 只读（没有它，出问题只能靠猜）
  // --------------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'task_status',
      output: RENDER,
      description:
        'Read-only: the active task for this session (id, groups, how many tools were denied, elapsed), plus whoever holds the cross-process lock. Changes nothing.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute(_args, exec) {
        const key = keyOf(exec)
        const task = activeTasks.get(key)
        const lock = readLock()
        return {
          ok: true,
          active: task
            ? {
                taskId: task.taskId,
                groups: task.groups,
                goal: task.goal,
                applied: task.applied,
                denyCount: task.denyCount,
                knownTools: task.knownTools,
                durationMs: Date.now() - task.startedAt,
              }
            : null,
          lock: lock
            ? {
                taskId: lock.taskId,
                pid: lock.pid,
                alive: pidAlive(Number(lock.pid)),
                ageMs: Date.now() - Number(lock.startedAt || 0),
                mine: lock.pid === process.pid,
              }
            : null,
          stateDir: STATE_DIR,
        }
      },
    }),
  )
}
