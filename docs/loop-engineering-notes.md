# Loop engineering 调研笔记

面向 KiroLex 的循环能力（`src/renderer/loopMachine.ts` + `src/main/loopVerify.ts`）。
记录外部资料里可判据化的部分，以及 KiroLex 当前落在哪一格。

来源：
- arXiv:2607.00038（2026-06-28）《Stop Hand-Holding Your Coding Agent》——loop specification 的分类学，手工编码了公开 Loop Library 的 50 个真实 loop
- Orkes/Conductor "Building Durable Loops" Part 1（2026-06-30）、"How to Make Distributed Workflows Retry-Safe"（2026-03-06）、"Workflow Versioning and Backward Compatibility"（2026-03-17）
- OpenHands Agent Canvas 文档（Critic / Managing automations）
- Warp Oz Scheduled Agents 文档
- LangGraph fault-tolerance 文档、Temporal retry policy 文档

---

## 1. 五件套：一个 loop specification 由什么组成

trigger + goal + verification + stopping rule + memory。

判据（论文的"黄金判据"）：**只有当上一轮的结果会改变下一轮的动作时，才值得做成 loop**；
否则它只是个定时一次性任务，不需要循环机制。

KiroLex 的对应物是 `nextPromptText()`——把上一轮校验输出回灌进下一轮 prompt。
没有这一步，加了校验也只是给"重复同一句话"加了个停止条件。

## 2. 五级验证阶梯

| 级 | 含义 | 区域 |
|---|---|---|
| 1 | 确定性：断言、exit code、golden output | 自主区 |
| 2 | 规则：linter、schema、policy | 自主区 |
| 3 | 延迟真值：测试、部署、真实反馈（真实但慢） | 客观区 |
| 4 | 模型评委：按 rubric 打分（是意见，不是事实） | 辅助流 |
| 5 | 人工检查点（这是监督，不是自动校验） | 辅助流 |

语料实证：50 个 loop 中 70% 落在 L1–L2，76% 在 L1–L3，22% 依赖 L4，仅 1 个以人工检查为主。

核心纪律：**不要把某一级当另一级声明**。一个 loop 的自主程度不超过它的校验器真实所在的层级。

KiroLex 现状：类型支持 `level: 1|2|3`，但 `ChatArea.tsx` 的 `draftLoopSpec` 硬编码 `level: 1`，
所以 `npm test`（实为 L3）会被标成 "L1 命令校验"。**这是一处等级声明不准确，待修。**

## 3. 命名终止状态

论文集合：success / no-op / blocked / stalled / exhausted。铁律是**错误与预算耗尽永不算成功**。
语料实证：74% 的 loop 明确命名了终止状态。

产品对照：
- OpenHands run status：`PENDING` `RUNNING` `COMPLETED` `FAILED` `CANCELLED` `SKIPPED`
  （`SKIPPED` = 后端并发上限导致本次没跑，是一个**无害的独立状态**，不是失败）
- KiroLex `LoopTerminal`：success / no-op / blocked / stalled / exhausted / aborted /
  superseded / torn-down / discarded —— 后四个把"发生在 loop 身上的事"与"loop 自己的结论"分开，
  比上述两家都细。`OUTCOME_TERMINALS` 常量守着这个区分。

## 4. 持久化循环的四条性质（Orkes/Conductor）

一个循环是"持久的"，当且仅当：

1. **循环计数器归 runtime 所有** —— 第几轮是服务端状态，不是进程内变量；重启后读回而非归零
2. **每轮 checkpoint** —— 一轮结果提交后下一轮才开始，迭代边界同时是恢复点
3. **迭代边界幂等** —— 崩溃后重跑那一步，外部效果与只跑一次相同
4. **终止显式** —— 同时有条件和天花板

> **durability ≠ continuity**：把状态存盘只保证数据活下来（durability）；
> continuity 是"知道崩的时候哪一步在飞行中、它的副作用是否已落地"。
> 持久循环需要两者。

量化依据：每步成功率 99% 时，20 步任务整体成功率 0.99²⁰ ≈ 82%，100 步降到 37%。
跑得越长，"至少一步失败"几乎必然——这是停滞检测与轮数上限的必要性来源，不是保守。

**KiroLex 现状：只满足第 4 条。**
`LoopRun` 被刻意设计成 JSON-serializable（timer 与 stopped 移到 driver 的 `LoopHandle`，
`tests/loopMachine.test.ts` 有一条测试守这个性质），这是前提已就位；
但计数器实际活在 renderer 的 `loopsRef` 里，关窗口或刷新即归零。
第 1、2 条需要把驱动从 renderer 移到 main（同时也是定时触发的前提）。

### 幂等的具体形态（Orkes 的 `TryStart` 模式）

worker 每次执行前先对幂等存储做 `TryStart`：
- 首次有效执行 → 执行副作用，把结果持久化
- 若同一逻辑操作被重放 → 读到已有记录，**返回存储的结果而不重新触发副作用**

关键失败窗口是"副作用已成功、完成状态尚未写入"。这个窗口只能靠"先记 in-flight、
再提交结果"的两阶段记录来覆盖，不能靠事后推断。

映射到 KiroLex：一轮 loop 的副作用是 agent 改文件、跑命令（本地或 EC2 上），
不可撤销且已落盘。若窗口在 turn 进行中被关闭，重开后无法判断那一轮是否已执行。
需要在发送前写 in-flight 标记、收到 `stopReason` 后再提交该轮。

### 状态跨崩溃的一个具体坑

Conductor 里 `${think.output.draft}` 解析到的是**最近一个** task 实例，
所以一轮超时重跑时读到的是那个超时实例的空输出，而不是最后一次好的 draft。
结论：当循环必须携带累积状态穿过一次中途失败时，要显式引用**最后一次已提交**的输出。

映射到 KiroLex：见下节"已知缺口"。

### 剩余性质（Conductor 生产级 agent 参考架构）

Part 1 的四条之外，Conductor 的 "Production Agent Architecture" 把余下的关注点逐一映射到原语。
与 KiroLex 相关的部分：

**a. 重试是步骤级的，而不是整轮的。**
重试配置挂在任务定义上：`retryCount` / `retryLogic`（`FIXED` | `EXPONENTIAL_BACKOFF` |
`LINEAR_BACKOFF`）/ `retryDelaySeconds` / `responseTimeoutSeconds`。
文档里有一句关键的话：MCP server 挂掉时 Conductor 用指数退避重试，
**"LLM 不会被重新调用——只有失败的那个工具调用重试"**。

→ 这是 KiroLex 当前实现的一个真实成本问题，见 §10 第 1 条。

**b. 人工批准是持久化闸门（`HUMAN` task）。**
工作流停下、持久化状态，只在人通过 Task Update API 响应时恢复；
这个暂停挺过服务器重启、部署和基建变更。审阅者 5 秒还是 5 天响应都一样，
状态保留、从原地恢复。三种模式：

1. **执行前审阅** —— LLM 规划动作，人先批准再执行，agent 无批准不能继续。
   用于有真实后果的动作（发邮件、改数据、下单）。
2. **条件式执行后审阅** —— 先执行，只在条件满足时才送人审
   （置信度低于阈值、金额超限、涉及敏感数据）。多数动作自动放行。
3. **LLM-as-judge 自动审 + 被拒才升级给人** —— 判审可以用不同的 provider/model
   （快模型起草、强模型判审），也可以串多个判审。

关键的省钱性质：**因为每个 LLM 调用是独立持久化的 task，判审或人审步骤失败时，
生成步骤永不重跑**——那个花了 10 秒和一堆 token 的生成被保留，只有审阅决定需要重来。

**c. 补偿（`failureWorkflow`）。**
agent 已经产生真实副作用之后才失败时，自动跑补偿任务撤销：撤回 API 调用、发通知、释放资源。
补偿工作流收到完整执行上下文——哪些动作成功、哪些失败、为什么。
这是"幂等"之外的另一半：幂等保证重试不重复副作用，补偿处理"已经做了但整体失败"。

**d. 长等待是持久化的（`WAIT` task）。**
基于定时器的暂停（限流、冷却期、定时动作），**等待期间不消耗资源**，挺过重启。
与"每 N 秒轮询一次"是本质不同的机制。

**e. 可观测性是自动的，不是额外埋点。**
UI 上可见：本次执行的确切任务图、每个 LLM 的 prompt 与 response、每个工具调用的
输入输出与耗时、每个人工批准（谁批的、何时）、迭代计数与循环状态、任何失败任务的重试历史、
完整的输入输出与变量。

**f. 委派给专家 agent（`SUB_WORKFLOW`）。**
父 agent 等子完成，失败向上传播，整棵 agent 树在 UI 里可从父钻到子再钻到孙。

## 5. 第五条性质：改定义不破坏在飞行中的运行（版本化）

长跑循环有时间维度——定义会在运行还没结束时被改掉。安全的版本化模型需要三条：

1. **启动是确定的** —— 调用方可以钉住版本；不钉版本时按可预期的规则解析到最新版
2. **执行连续性是显式的** —— 正在跑的执行不会静默切换到另一个定义，除非操作者显式请求
3. **存在兼容窗口** —— 迁移期内要同时接受旧版与新版输入形状，且不引入不确定的副作用

Conductor 的做法：不带版本的 start 用最新注册定义；带版本的 start 跑那个确切定义；
运行中的执行不自动切换定义；`restart` 默认保留当前语义，`restart --use-latest` 才切到最新。

产品对照：
- Warp Scheduled Agents：改 schedule 配置**只影响未来的运行**，历史运行与其 session 记录不变
- OpenHands 自动化导出为 `{version, kind, spec}` 版本化 JSON，可 git 管理、可 diff、可手写；
  **导入后默认 disabled**，要人看一遍配置再启用

映射到 KiroLex：`LoopSpec` 目前无版本号。做 spec 存盘时，外壳应带 `version`，
且"改配置只影响新启动的 loop"这条语义要写明——这与既有的
"只有新建会话读 config.json"是同一条设计取向。

## 6. 重试与容错：opt-in 还是默认

LangGraph 的节点重试是 **opt-in** 的：

```ts
.addNode("callApi", callApi, { retryPolicy: { maxAttempts: 3 } })
```

文档明确：**没有配 retryPolicy 时，第一次失败就结束这次尝试**。
Temporal 同样把 retry policy 与 timeout 做成每个 Activity 的标准配置项。

KiroLex 现状：已实现 `stop.maxUnrunnableRounds`（默认见 `DEFAULT_MAX_UNRUNNABLE_ROUNDS`）。
设计要点，都已落地：
- 被容错的一轮按"没测到任何东西"处理，既不算进展也不算失败，**且不打断 pass streak**
- 它**仍然消耗一轮预算**，所以一次网络中断买不到无限重试
- 重试前至少等 `TOLERATED_RETRY_FLOOR_SEC`（15s），否则容错会变成快速烧 turn 的通道

## 7. 反模式清单

- **while-true around a stranger** —— 无具名 skill、无真实校验的无界重试：看着忙，产出少
- **自我批准（reward hacking）** —— 生成者与评判者同模型时，分数上升而质量停滞或下降；
  缓解是结构性的（maker ≠ checker），不是靠叮嘱
- **规格博弈** —— 改测试而非改代码、硬编码期望输出；防御是 agent 没改过的 hold-out、
  被证明能抓到 bug 的校验器（红-绿验证）、绝不允许 agent 关掉失败的检查
- **把 L4 当 L1** —— 用确定性检查的口气报告一个模型的意见
- **无人值守失控** —— 无停止条件、无停滞检测、无预算天花板

反面教材：n8n 的 `max iterations` 只报 "Agent stopped due to max iterations"，
社区里大量帖子在问怎么调大它。教训：**上限如果不同时说明"为什么到上限"和"下一步怎么办"，
用户只会把它当障碍绕过去。** KiroLex 的 `terminalSummary()` 带轮数、耗时、校验等级、
最后一次 exit code，以及 L0 时那句"没有任何校验运行过，因此无法判定目标是否达成"，
是对这条教训的正面回应。

## 8. 健康指标

**cost per accepted change** = 花掉的 token 或钱 / 通过校验的改动数。
论文说这个指标几乎没人测；原始 token 消耗是错的数字。
一个烧预算而没有产出被接受改动的 loop，即使看着很忙也是坏的。

`LoopRun.acceptedChanges` 是这个指标的分母，目前尚未接入分子（token 计数）。
renderer 侧没有可靠的每轮 token 数（usage map 是展示用的近似值），
所以 `LoopSpec` 刻意没有声明 token 预算字段——半实现的分支比缺字段更糟。

## 9. 业界 UI 形态对照

| 工具 | 验证 | 触发 | 备注 |
|---|---|---|---|
| OpenHands Agent Canvas | `Settings > Verification` 独立分区：Enable Critic / Iterative Refinement / Critic Threshold(0.6) / Max Refinement Iterations(3)；**L4 模型评委** | Automate 视图：schedule / webhook / event，可 pause，可导出导入 | 结果**内联在时间线**、紧贴被评估的消息；紧凑态只显示成功概率，展开看问题类别与概率。`Critic Mode` 默认 `finish_and_message`（不是每个 tool call 后都评，性能考量）。既有会话保留创建时的设置 |
| Claude Code | `/goal` = 完成条件，每轮结束由一个**小而快的独立模型**判断；达成后自动清除 goal。**L4** | `/loop` 管节奏 | CLI，无图形界面 |
| Warp Oz Scheduled Agents | 基本不谈 | 必填 name + cron + prompt/skill；可选 environment / model / MCP / 自托管 worker | 列表显示 cron、是否暂停、**上次运行（带 task id 与 session 链接）、下次运行**；每次运行都是全新 session，运行间不携带状态（纯 Ralph 模型）；文档有明确的责任声明段 |
| Conductor / Orkes | 循环条件是 `DO_WHILE` 的 `loopCondition` | 工作流启动 | 服务端拥有 iteration 计数；timeline 上每轮一条记录；worker 被 kill 后那轮显示 `TIMED_OUT` 并在新 worker 上重跑，已提交的轮次不重复 |
| Factory 桌面版 | 未暴露 | 未暴露 | 结构最接近 KiroLex：多个 droid 各占侧边栏一条，各有独立 context / progress / history |

**没有任何一家把"验证等级"做成 UI。** 论文 future work 那句正是在说这件事：
harness 应该把 trigger、验证等级、架构、终止状态、memory 做成一等配置，
让一个 loop 在分类学里的位置是被声明的，而不是埋在脚本里。

KiroLex 的独特位置：
- **带外 exit code 校验 + 命令白名单**（`registeredVerifiers`），没有第二家这么做；
  OpenHands 与 Claude Code 都选了模型评委。代价是只适用于"有命令可跑"的任务
- **不需要把代码库搬上云**。Warp 文档明确：不指定 Environment，scheduled agent 就跑在裸沙箱里，
  拿不到你的代码仓库、预装工具和 setup 命令。KiroLex 的远程 SSH 执行器本身就是现成的 environment，
  而且也能纯本地跑；常驻桌面让定时触发不需要任何云端基础设施

## 10. 产品定位变更后的重解读（2026-08-11）

项目定位更新为**面向日常工作**（周报、SFDC 活动记录、oncall、调研报告），不是编码助手；
明确不引入 git commit / worktree / diff review / 跑测试等以代码仓库为前提的机制。
优先级 A 主线是复杂 Skill/Workflow 的可靠分步执行 + 产出物管理 + 人工审批闸门。

这对上面的结论有两处实质影响。

### 校验命令的语义要换，机制不用换

之前所有 L1/L2 的例子（`npm test`、`tsc --noEmit`、`eslint`）都以代码仓库为前提，与新定位冲突。
但 `loopVerify.ts` 的机制本身是"带外跑一条命令、只信 exit code"，与代码无关，仍然成立。
日常工作场景的等价物是**检查产出物与目标系统的状态**：

| 场景 | 确定性校验 | 层级 |
|---|---|---|
| 周报 | 产出文件存在、含必需章节标题、字数在范围内 | L2 规则 |
| 调研报告 | 所有引用 URL 可访问（批量 HEAD 请求） | L1 |
| SFDC 活动记录 | 查 API 确认记录已创建、字段非空 | L3 延迟真值 |
| oncall | ticket 状态已变更为预期值 | L3 |

共同点：日常工作的确定性校验是**查询产出物或目标系统的状态**，而不是跑测试。
这些多数落在 L2/L3 而非 L1，所以 §2 那个"UI 硬编码 level 1"的问题在新定位下更严重——
默认值应该是 L2 或 L3，而不是 L1。

**一个必须守住的边界**：如果校验改成"让 agent 调 MCP 工具去查"，那就退回成
agent 报告自己的工作 = L4 冒充 L1。带外的含义不变，只是实现从"跑 shell 命令"
变成"KiroLex 主进程自己去查"——可以是 shell 命令（`test -f`、`wc -w`、`curl`），
也可以是 main 进程直接调 API，但不能经过 agent。

### L5 从"例外"变成主线

论文把 L5（人工检查点）定性为"这是监督，不是自动校验"，语料里只有 1 个 loop 以它为主。
那个判断是对编码场景说的——代码有测试可跑，人工检查是退路。

但日常工作的产出物（周报、客户活动记录、对外报告）最终要人签字，
**人工审批闸门在新定位下是主线特性，不是降级选项**。
所以 §4b 那三种模式（执行前审阅 / 条件式执行后审阅 / LLM-as-judge 被拒才升级给人）
从"可选硬化手段"升级为核心设计参考，其中两条尤其贴合：

- **执行前审阅**：对有真实后果的动作（发邮件、写 SFDC 记录、提交工单）先审后执行。
  这正是"有真实副作用"的日常工作动作。
- **每个步骤独立持久化，所以审阅步骤失败时生成步骤不重跑**。
  对应到 KiroLex：一份写了 3 分钟的周报草稿，不该因为审批环节出问题而重新生成。

`LoopSpec.approvalRequiredFor`（当前设计里刻意未实现的字段）应该重新提上来，
但它需要的不是一个字符串列表，而是 §4b 的模式选择 + 持久化暂停能力
（暂停必须挺过关窗口——这又回到 §4 第 1、2 条：驱动要移到 main 进程）。

### 不适用的部分

- §4c 补偿（`failureWorkflow`）：日常工作场景的副作用（已发出的邮件、已建的 SFDC 记录）
  确实需要"撤销或通知"，但优先级低于审批闸门——把闸门放在动作**之前**，
  比事后补偿更适合单人使用的桌面工具。
- §4f 委派给专家 agent：与"不复用 KiroCrew 多通道/dashboard"的取向一致，暂不考虑。
  若要做，走挂 KiroCrew MCP 的 `spawn_sub_agents` 而非自建编排。

## 11. KiroLex 已知缺口（按优先级）

> **2026-08-12 更新**：下面第 1、2、3、4、5 条已修，第 7、8 条部分落地。
> 逐条状态见 §12，本节保留原始分析（含"为什么这是个问题"的推理）作为背景。

1. **容错一轮的代价是一整个 model turn，而它本不该花钱。**
   `iterate()` 的顺序是"发 prompt → 跑校验"。校验 `unrunnable` 被容错后，
   下一轮从头开始，**重新发一次 prompt**——一次 SSH 抖动的代价是一个完整的 model turn，
   而抖动跟模型输出毫无关系。
   Conductor 的对应做法（§4a）是重试只落在失败的那一步，LLM 不重新调用。
   修法：`unrunnable` 且未达容错上限时，**只重跑校验**，不重发 prompt，
   也不递增 `iteration`（当前实现会消耗一轮预算——那是为了防止无限重试，
   但改成只重跑校验后，用一个独立的重试计数就够，预算不该被抖动吃掉）。
   现有的 `TOLERATED_RETRY_FLOOR_SEC = 15` 是对这个问题的缓解，不是解决。

2. **`lastVerdict` 被无条件覆盖，容错轮会冲掉回灌内容。**
   `advance()` 里 `lastFingerprint` 做了 `measured ? fingerprint : run.lastFingerprint`
   的保护，但 `lastVerdict: verdict` 没有。于是：第 5 轮校验失败（输出"3 个测试失败：a,b,c"）→
   第 6 轮抖动被容错 → 第 7 轮 `nextPromptText()` 渲染的是"上一轮校验结果：无法执行 /
   （校验命令没有输出）"。容错本意是不丢进度，却丢掉了这个模块自称的核心价值。
   与 Conductor 那个 `${think.output.draft}` 的坑同形状：要显式引用**最后一次测到东西**的结果。
   修法：加 `lastMeasuredVerdict`，`nextPromptText()` 改读它。
   （若采纳第 1 条只重跑校验，这个问题的触发面变小但不消失——校验成功后仍会覆盖。）

3. **UI 把所有命令校验标成 L1**（见 §2、§10）。类型支持 1|2|3，弹窗应给三选，
   且新定位下默认值应是 L2/L3。

4. **`successStreak` 硬编码 1**，状态机与测试都完整支持连续通过判定，UI 无对应字段。

5. **`maxUnrunnableRounds` 仅为常量**，不可在弹窗里调整（只在说明文字里展示）。

6. **校验结果每轮追加一条独立消息**，跑 20 轮就是 20 条噪音。
   应改为内联折叠（参见 §9 OpenHands 行）。

7. **人工审批闸门缺失**（见 §10）。新定位下这是主线，优先级应高于下面一条。

8. **持久化与自动触发**（§4 第 1、2 条 + §5）。前提是把驱动移到 main 进程；
   也是审批闸门"暂停挺过关窗口"的前提。


---

## 12. 落地状态（2026-08-12）

§11 那份缺口清单写于 2026-08-11。此后的实现改动如下，逐条对齐。

### 已修

**#1 容错一轮不再花掉一个 model turn。**
`advance()` 现在对 `unrunnable` 返回 `retryVerifierOnly: true`，driver（`useAcp.ts`）据此
只调 `runVerifier()`、不走 `sendLoopBackground()`，也不递增 `iteration`。
这正是 §4a 里 Conductor 那条规则的形状：重试落在失败的那一步，LLM 不重新调用。

一个附带的语义变化，值得单独记一笔：**轮数上限不再对抖动生效**。
旧代码在最后一轮遇到抖动会报 `exhausted`——为一轮从没重发过的预算报"用尽"，
而且这个 run 至死不知道工作到底通过了没有。现在轮数上限只约束 model turn，
抖动只由 `maxUnrunnableRounds` 约束。因此 `TOLERATED_RETRY_FLOOR_SEC`（15s）
从"缓解"升级成了**唯一**防止永久性故障空转的东西——不能再当它是可选的。

**#2 `lastMeasuredVerdict`。** `LoopRun` 增加该字段，`nextPromptText()` 改读它。
`lastVerdict` 仍然如实记录"最近一次尝试发生了什么"（含无法执行），两者回答的是不同问题。
这修掉了"容错本意是不丢进度，却把回灌内容丢了"的自相矛盾。

**#3/#4/#5 弹窗字段。** 三项在 8-11 当天已随 UI 改动落地（等级三选、连续通过轮数、容错轮数），
§11 写下时清单已经过时。

### 新发现并修掉的一个缺陷（不在原清单里）

**校验器不存在会被当成"校验未通过"。**
`sh -lc` 对找不到的命令返回 127，`runVerifier` 据此判成 `ran: true` ——
于是**校验命令里的一个拼写错误会被读成"工作是坏的"**，循环会把整个轮数预算
花在让模型修一段从没被检查过的代码上。这与 `loopVerify.ts` 自己的契约
（`ran: false` = "missing binary, SSH failure, timeout"）直接冲突：文档和实现不一致。

修法是 `shellCouldNotFindCommand(exitCode, output)`：126/127 **且**首行是 shell 自己的
抱怨（command not found / No such file / Permission denied / cmd.exe 的说法）才判 `ran: false`。
同时看退出码和输出，因为 126/127 也可能来自一个跑得很好的校验器内部。

有一个**固有的**分类边界，不是疏漏：嵌套 shell 找不到自己的命令时，首行与外层 shell
失败时逐字节相同，无法区分。这种情况判为"跑不起来"——两种误判里较安全的那个，
因为它重试校验，而不是归罪于工作。原先那条断言 `ran: true` 的测试连同其理由一起被改写了。

### 部分落地

**#7 人工审批闸门 —— 已实现，但在 Skill Flow 里，不在 loop 里。**
新增 `src/main/flowRun.ts`（纯状态机）+ `flowDriver.ts`（效果）+ `flowStore.ts`（落盘）。
闸门是**持久化暂停**：`nextTask()` 是 JSON 记录的纯函数，所以关窗口再打开能重新推导出
同一个待批闸门；`flow:approve` 从**磁盘**重读，因此重启后给出的答复落在真实状态上。
`LoopSpec.approvalRequiredFor` 仍未实现——loop 与 flow 是两套机制，
日常工作的审批需求由 flow 承载，见 §10。

写操作用两阶段幂等账本（`tryStartWrite` → `commitWrite`），对应 §4 的 `TryStart` 模式，
关键失败窗口（副作用已落地、完成状态未写入）会被报成 `in-doubt` 而拒绝重发，
不会静默重复写入。

**#8 持久化 —— 计数器已经移到 main，driver 还没有。**
`src/main/loopStore.ts` 拥有轮数计数器：`beginRound()` 先扣费再 flush，然后才把这一轮交出去
（§4 的第 1、2 条）。这修掉了一个真实的 bug：计数器原先活在 renderer 的 `loopsRef` 里，
**刷新窗口就归零**，所以"最多 20 轮"在每次重启后都重新获得 20 轮——那根本不是预算。

**发送路径仍在 renderer**，因为它需要 streaming 状态、attach 记账和消息列表
（68 处 renderer 侧引用）。因此定时/事件触发仍未实现：它需要的是 driver 本身移到 main，
不只是计数器。§4 第 3 条（迭代边界幂等）对 loop 仍未做——flow 有账本，loop 没有。

### 仍未做

- **#6 校验结果每轮一条独立消息**（跑 20 轮就是 20 条噪音）。应改为内联折叠。
- **§5 版本化**：`LoopSpec` 与 `SkillFlow` 都无版本协商。`flow.yaml` 有 `version` 字段，
  但没有"运行中的 run 不跟随文件改动"这一保证——`flow:approve` 会重读文件，
  文件在暂停期间被改过就会用新定义继续。这是已知的、尚未关闭的口子。
- **§8 cost per accepted change** 的分子（token 计数）仍不可得。
