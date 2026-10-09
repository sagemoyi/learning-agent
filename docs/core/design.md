# 核心（core）

> 代码：[`packages/core`](../../packages/core) · 接口：[契约](../stage0/contracts.md) §3、§4、§5.1、§6 · 验证：[验证记录](../stage0/compatibility.md) S1–S7

核心不管教学，只管所有单元共用的底层：数据库、课程文件的读写和变更日志、会话归属、学习证据日志、修改提案的存放，以及前端调用的接口和变更推送。

## 现状

- **已验收（骨架阶段，够现阶段用）：** 数据库和各单元的升级脚本、课程与工作区、课程文件读写（自动进变更日志）、会话归属、证据日志、提案存放、`/api/learning/*` 接口、推送通道。最小学习流程和 `tests/flow.test.ts` 都经过这里。
- **结构操作日志：** 变更可带课程与操作组，支持按组查询及单条读取；knowledge 的结构修改与撤销由它自己处理，core 只保存前后快照和提交后推送。
- **课程状态（curriculum C）：** `courses.setStatus` 改课程的状态并发 `learning/course-updated`：curriculum 写完课程报告时标为"已结课"，结课后加了阶段时改回进行中。
- **还没做：** core 的文件回退服务已有，通用页面入口未做；knowledge 页面已有它自己的整组撤销入口。提案只存不处理（处理归 [tutor](../tutor/design.md)）。

## 数据：文件 + 数据库

**每类数据只存一份：**
- **文件**（课程文件夹里的 Markdown，你可以直接读）：目标说明、课程路线、阶段设计书、教材正文、小节记录、阶段复盘、侧边会话总结、结课报告。
- **数据库**（全局一个 SQLite，用 Node 自带的 `node:sqlite`）：课程/阶段/课时/任务的状态、知识节点与关系、资料片段索引、题库、作答、学习证据日志、掌握状态、修改提案与变更日志。

每张表和每个文件只有一个主人单元；表名以单元名开头（如 `assess_problems`），升级脚本由单元自己提供，由 `core` 统一执行并记录版本。跨单元修改要调用主人的服务。

**学习证据只追加，不修改。** 判分、给过的帮助、提问、疑似误解都记进一本证据日志。掌握状态由规则从日志推算，规则改了可以全部重算（规则见 [learner](../learner/design.md)）。

**数据放在哪：** 数据根目录默认 `文档/学习库`，和代码仓库分开，可以直接用 Obsidian 打开。本地开发用 `.data/`，验收用 `.scratch/smoke-data/`（见 AGENTS.md）。

```
学习库/
├─ .learning/      数据库和缓存
├─ library/        资料库（全局）：原件 + 解析结果
└─ courses/<课程>/  一门课 = 一个 DSH 工作区
   ├─ goal.md  roadmap.md  report.md
   ├─ stages/<序号-标题>/  design.md  textbook/<小节>.md  lessons/  review.md
   ├─ notes/side-chats.md
   └─ attachments/
```

**课程与 DSH 工作区：** 一门课对应一个文件夹，也就是一个 DSH 工作区。DSH 的会话不能附带我们的信息，所以"会话属于哪门课、哪个阶段、什么角色"记在我们自己的库里。

**课程文件只经 `core` 写入：** 每次写入都记进变更日志，可以回退；先写盘成功，再发事件。

**核心数据对象**（字段要点见契约 §4）：Course、Goal、Stage、Lesson、Task；Node、Edge、CourseNode、NodeLink；Source、Chunk、CourseSource；Block、Annotation；Problem、Seen、Test、Attempt；学习证据日志 LogEntry → NodeState；SessionLink、SideChatSummary；Proposal、Change。

## 前端接口和推送

- **接口：** `/api/learning/<单元>.<方法>` 精确路由，挂在 DSH 已认证的通道上，沿用 DSH 的 RPC 信封。不拦截整个 `/api`，那属于 DSH 的网关。
- **推送：** 一条推送通道 `/api/learning/feed`，把前端关心的 `learning/*` 事件推给打开着的页面，页面收到后重新查询。后台任务（导入、生成教材）的进度也走这条通道。
- **错误：** 必须带具体原因，写成 `learning/<单元>/<原因>`。

## 关键决定

- **学习证据只追加、不修改；掌握状态由规则推算、可以重算**（10-03，契约决定 1，你确认）：符合"只有作答能证明掌握"；`learner` 最后才做深，规则会改，重算比迁移数据可靠。
- **文件与数据库分工：你要读的放 Markdown，状态和要查询的放数据库，每类只存一份**（10-03，契约决定 2，你确认）。
- **学习数据放在 `文档/学习库`，和代码仓库分开，可以用 Obsidian 打开**（10-03，契约决定 3，你确认）：你的教材、照片、学习记录都不会进代码仓库。
- **TypeScript + pnpm 工作区，各单元只依赖契约包；`store` 改名为 `core`**（10-03，契约决定 5，你确认）：它除了存储，还负责接口、推送和会话归属。
- **数据库用 Node 自带的 `node:sqlite`**（10-03，阶段 0 调研）：DSH 的存储也用它；中文全文检索实测可用。
- **服务名加 `learn` 前缀，事件以 `learning/` 开头，接口为 `/api/learning/<单元>.<方法>`**（10-03，契约）。
- **接口用精确路由，不拦截 `/api`，暂不用 DSH 的类型化接口生成**（10-03，阶段 0 验证 V3）。

完整的决定和来源见[决策记录](../decisions.md)。
