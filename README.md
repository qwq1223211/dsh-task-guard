# dsh-task-guard

**任务级工具收窄**：任务开始时按 `groups` 收窄一次工具表，任务结束时恢复。零依赖，纯 Node 内置模块。

> 它不是"又一个任务系统"。它只守一条线：**工具表在一个任务里只准改一次**。
> 因为每改一次就是一次全价前缀重建——本机实测单次最高 56 万 token 全价。

## 三条铁律（这插件全部价值都在这三条）

| 铁律 | 为什么 |
|---|---|
| **只用 `deny`，绝不用 `allow`** | `restrict({allow})` 会藏掉**点不出名字**的工具（作用域本地注册的 `read`/`write`/`send_message`）。实测 4/4 会话丢 `read`，其中一个连 `send_message` 都没了 → 子代理干完活回不来 → **死锁** |
| **一个任务只收窄一次** | 每次改工具表 = 前缀指纹变化 = 一次全价重建 |
| **永不 `deny` 逃生门** | `run_code` 写进列表会**直接抛错**（静默不裁剪）；`subagent`/`send_message` 藏了就断掉委派；`route_*`/`guard_*`/`cache_probe_*` 是你出问题时唯一的退路 |

## 三个工具

| 工具 | 作用 |
|---|---|
| `task_start({ groups, goal? })` | 抢锁 → 收窄一次 → 记账。`groups` 为空直接拒绝（歧义不猜） |
| `task_end()` | 拆限制 → 放锁 → 记账（耗时、摘了多少） |
| `task_status()` | 只读：当前任务、谁持有跨进程锁、状态目录在哪 |

## 安装

```bash
# 开发期（link 安装，改代码后 disable→enable 生效）
dsh plugin --profile desktop add link:C:/path/to/dsh-task-guard

# 或手工：把目录加进 profile 的 dependencies 与 dsh.profile.bundles
```

`cordis.patch.yml` 顶层必须是数组：

```yaml
- insert:
    - id: task-guard
      name: dsh-task-guard
      config:
        lockTtlHours: 6
```

## 状态文件（都在 `~/.dsh/task-guard/`）

| 文件 | 内容 |
|---|---|
| `active.lock` | 跨进程任务锁：`{ taskId, pid, startedAt, groups }`，原子写（tmp + rename） |
| `usage.jsonl` | 每次 `start` / `end` 一行，带 `taskId`、`denyCount`、`durationMs`，字段名与 minimal-router 的探针记录保持一致，便于一起分析 |
| `current.json` | 给 UI 的快照：`active`、`groups`、`denyCount`、`keptCount`、`keptTools`、`deniedTools`、`savingsPerTurn`… |
| `tool-registry.json` | **全量工具清单**（v0.5.0）：`task_start`（**含 dryRun**）时写入，任务结束也不删。认领建议和徽章空态都靠它 |
| `mode.json` | `{"mode":"auto"\|"manual"}`（v0.6.0）：**谁来决定工具表**。徽章写，minimal-router 读 |
| `request.json` | UI 发来的手动动作（v0.6.0）：`{id, action:'start'\|'end', groups, ts}` |
| `request-result.json` | 上一次动作的结果：`{id, ok, error}`，UI 用它显示成功/失败原因 |

> 放家目录而不是包目录：包目录在 pnpm 安装下是只读的，写进去升级就丢。
> 测试可用 `TASK_GUARD_DIR` 环境变量覆盖。

### UI 请求通道（v0.6.0）

浏览器调不了工具，所以徽章的动作走"文件邮箱"：

```
徽章面板 → POST /task-guard/action（badge 插件的 host 路由）
        → 写 request.json
        → 本插件在**下一次 tools/pre-execute** 里消费
        → restrict({deny}) / dispose()  → 写 request-result.json
```

**为什么是 pre-execute**：`restrict()` 必须作用在 `agent.ctx.tools` 上，而 pre-execute 是
唯一每轮都会发生、且能拿到那个作用域的位置（不用额外起定时器）。

三条保护：超过 60 秒的请求不执行、同一个 `id` 只执行一次、失败把原因写进结果文件。


## 成本闸门（v0.2.0）

收窄 = **一次全价前缀重建**，而省下来的钱是**每轮**的。所以它有个回本点。

本机实测（2026-10-31，一次真实收窄）：

```
272 个工具 / 232,458 字节  →  78 个 / 57,883 字节   （摘掉 174,575 字节，−75.1%）
那一次请求：promptTokens 285,701，cacheRead 仅 4,608  →  命中率 1.61%
一次性成本 ≈ 28.1 万全价 token；每轮省 ≈ 5.2 万 → 回本 ≈ 5.4 轮
```

所以 `task_start` 加了闸门（实现见 `lib/cost-gate.js`）：

| 条件 | 行为 |
|---|---|
| 上下文 > 200,000 token **且** 预估轮数 < 6 | **拒绝**，报 `COST_GATE`，提示跑不够就亏 |
| 同上但传 `force: true` | 放行（你自己认这笔账） |
| 没传 `contextTokens` | 放行，但如实说"算不出来"，并告诉你数据从哪取 |
| 本来就没东西可摘 | 放行（没有切换成本） |

```jsonc
task_start({
  "groups": ["unity"],
  "contextTokens": 285701,   // 从 cache_probe_report 的 lastPromptTokens 取
  "turns": 12,               // 预估轮数
  "force": false
})
```

返回里会带上这笔账：`cost.savingsPerTurn` / `cost.paybackTurns` / `cost.message`。

## 先看后付：`dryRun`（v0.3.0）

**起因是一次真实事故**：一次 `groups:["unity"]` 摘掉 194 个工具——连带摘掉了
`plugin_manager`（标签 `plugin`）和 `cordis_inspect_*`（标签 `cordis`），
而那正是当时在做的事。**是用户看截图发现的，插件自己不知道。**

根因不是逻辑错，是**调用方不知道有哪些组可以选**："开发 DSH 插件"这个领域在工具表里
没有对应标签，它的工具散在 `plugin` / `cordis` / `web` / `skill` 里。

所以加了 `dryRun`（**成本 0**：不抢锁、不动工具表、不写任务状态）：

```jsonc
task_start({ "groups": ["core", "plugin", "cordis"], "dryRun": true })
```

| 返回字段 | 含义 |
|---|---|
| `availableGroups` | **这台机器上真实存在的组**（组名 → 工具数，降序） |
| `foundGroups` / `missingGroups` | 你点名的组里，哪些存在、哪些写错了 |
| `willKeep` / `willDeny` | 会保留几个、摘掉几个 |
| `keepSample` / `denySample` | 各给 8 个样例（不用翻全表） |
| `cost` | 回本账（即使闸门会拒，也照样算给你看） |

**正确姿势：先 `dryRun` 看清单 → 改对了再去掉 `dryRun` 真开。**

## 多领域的唯一纪律

| 场景 | 做法 |
|---|---|
| 开头就知道要跨领域 | **开头取并集**（`["unity","art"]`），一次收窄 |
| 中途才跨领域 | **不要重开任务**（再付一次重建）。要么接受工具不够，要么 `task_end` 后重开 |
| 完全不确定 | 先 `dryRun` 看清楚，别急着开 |

> **铁律：任务中途永远不改工具表。** 多领域靠"开头想清楚"，不靠"动态调整"。

> **为什么不做成"永远拦"**：数据不全时拦人 = 让人以为插件坏了。
> 拿不到就明说"算不出来"，把判断权交回去。

## 已知边界（写在前面）

1. **跨进程锁是"全机器一把"**：同一台机器同时只允许一个任务。同进程多会话由内存 Map 守卫。
2. **只按 `deny` 算**：如果某个工具不在这个 agent 的注册表里、但存在于更大的全局表，我们摘不掉它——结果是**欠收窄**（安全方向），不是错杀。
3. **不碰 prompt**：它不往上下文里塞一个字（可选的尾巴提示默认关）。
4. **`taskId` 写在自己文件的 `usage.jsonl` 里**，不写入 minimal-router 的探针文件（避免跨插件写别人的数据）。要对齐两边，用 `at` 时间窗口 join，或给 router 的探针加一个扩展点。

## 测试

```bash
node test/task-guard.test.mjs   # 12 项，零依赖（node:test）
```

## 规模

- `index.js`：**347 行代码**（不含注释）+ 178 行中文注释
- 依赖：**0**
