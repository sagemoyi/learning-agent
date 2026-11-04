# 单元之间的契约

> 单元之间要守的约定：数据放在哪、谁是主人、怎么调用、怎么通知。精确的类型、数据格式和服务声明在 `packages/contracts/src/`，以代码为准；单元自己的接口、表和工具写在它的设计文档里。2026-10 的契约方案和逐批补充冻结在 [history/2026-10-contracts.md](history/2026-10-contracts.md)。

## 1. 总规则

1. **单元之间只依赖契约包，不互相引用代码。** `@learning-agent/contracts` 里只有类型、数据格式校验、服务和事件的声明，没有业务逻辑，打进每个单元。
2. **每类数据只有一个真相来源**，要么在课程文件里，要么在数据库里，不存两份（§2.3）。
3. **每张表、每个文件只有一个主人单元。** 别的单元要改，调用主人的服务。
4. **学习证据只追加，不修改。** 判错了就追加一条更正，不删原记录；掌握状态是推算结果，随时可以重算。
5. **先写盘，后通知。** 数据写进数据库或文件之后才发事件；监听者出错不影响已经写好的数据。
6. **课程文件只经 `core` 写入。** 每次写入都进变更日志并保存旧版本，可以回退。
7. **出错要说清楚。** 接口出错时把具体原因传回页面，不只说"内部错误"。
8. **写给学习者看的文字不出现内部编号**（`kn_`、`ck_` 这类 ID）：目标、路线、设计书、讲义、小结、进度通知都一样；出处的写法见 §2.2。

## 2. 数据放在哪

### 2.1 数据根目录

默认在 `文档/学习库`，和代码仓库分开，可以在设置里改；整个目录可以直接用 Obsidian 打开。

```
学习库/
├─ .learning/               程序数据：learning.db（全局 SQLite 数据库）、cache/（可重建的缓存）、backups/（升级前的数据库副本）、running.json（谁打开着学习库）
├─ library/                 资料库，所有课程共用：每份资料一个文件夹（原件、资料卡、解析结果）
└─ courses/
   └─ 化工原理/              一门课 = 一个文件夹 = 一个 DSH 工作区
      ├─ course.md          课程卡
      ├─ goal.md            目标说明（含考试档案、资料清单）
      ├─ roadmap.md         课程路线
      ├─ stages/01-流体流动/
      │  ├─ design.md       阶段设计书（含测试蓝图）
      │  ├─ handout.md      本阶段讲义，阶段的课时共用（旧版按小节分的在 textbook/）
      │  ├─ lessons/        每个课时的记录：小测结果、学习者的汇报、老师的小结
      │  └─ review.md       阶段复盘
      ├─ notes/side-chats.md  侧边会话总结（只追加）
      ├─ attachments/       作答照片等（测试的在 attachments/tests/<测试>/，归 assess）
      └─ report.md          课程报告
```

- 一个阶段一份讲义：课时按小节推进、读其中一节；块索引记下每块所在的课时，批注和提问按它找课时。
- 文件名用英文（程序认固定的文件名），标题和文件内容用中文。
- 主界面的侧边会话以数据根目录为工作目录。

### 2.2 讲义文件

- frontmatter 写阶段、标题、版本和生成编号（`run`，重启后用来认出已经发布的版本）。
- 版式：`## 阶段标题`，`### 本章速览`（`#### 名词`、`#### 公式` 两张表），每个课时一个 `### 编号 标题`，`### 易混点`（表），`### 题型与方法`（每类一个 `####`）。块所在的课时按它上面的 `###` 编号认。
- **段落块 ID** 写在段落末尾，形如 `^b7k2qx`（6 位小写字母数字，课程内唯一）；公式、表格、引用框这类块，ID 隔一个空行单独一行（Obsidian 的写法）。
- **出处** 写成 `[《书名》p.页码](cite:片段ID)`；网页出处是普通链接 `[网页标题](https://…)`。
- **资料原文**（公式、例题、原书解答、图、表）由程序原样复制，写成 Obsidian 引用框 `> [!quote] 原文 · [《书名》p.页码](cite:片段ID)`，原书解答是折叠的 `[!quote]-`；图写成 `![图注](cite:片段ID)`，页面从原件裁图显示。
- **待核实** 记在块索引里，正文不写字样；较早文件里的 `[待核实](cite:unverified)` 照旧读出。
- 块挂到哪些知识节点、引用了哪些片段，记在数据库的块索引里，不写进文件。
- 学习者在外面（比如 Obsidian）改了文件，读取时按内容指纹发现，记成一次学习者的修改。

### 2.3 文件还是数据库

| 数据 | 真相在 |
|---|---|
| 目标说明、路线、设计书、讲义正文、课时记录、复盘、侧边会话总结、课程报告 | 课程文件夹里的 Markdown（结构化字段写在 frontmatter） |
| 课程、阶段、课时、任务的状态 | 数据库 |
| 知识节点与关系、资料片段索引、题库、测试和作答 | 数据库 |
| 学习证据 | 数据库，只追加（§4） |
| 掌握状态 | 数据库，推算结果，可以删掉重算 |
| 修改提案、变更日志（含旧版本全文） | 数据库 |
| 资料原件和解析结果 | `library/` 文件夹；片段索引在数据库 |
| 界面偏好（标签、侧栏、图谱位置） | 浏览器本地，不是学习数据 |

### 2.4 ID

数据库对象的 ID 是"类型前缀 + ULID"（按时间排序，同一毫秒内递增）：`cr_` 课程、`st_` 阶段、`ls_` 课时、`tk_` 任务、`kn_` 知识节点、`ke_` 关系、`op_` 知识操作组、`kx_` 抽取任务、`src_` 资料、`ck_` 资料片段、`pb_` 题目、`ts_` 测试、`at_` 作答、`rp_` 题目报告、`ap_` 申诉、`lg_` 证据日志、`an_` 批注、`sm_` 侧边会话总结、`df_` 侧边会话起草的修改建议、`pp_` 提案、`chg_` 变更。DSH 会话 ID 是我们生成的 UUID：先在 `core` 登记归属，再建会话，不会有孤儿会话。

## 3. 数据的主人

| 对象 | 主人 | 要点 |
|---|---|---|
| 课程、会话归属、变更日志、提案的存储、证据日志的存储 | `core` | 会话归属记课程、角色、阶段、打开时的页面和选中内容；提案由 `tutor` 处理 |
| 目标说明 | `goal` | `goal.md`：六要素、事实及来源、考试档案、资料清单、版本 |
| 阶段、课时、任务、路线调整、阶段复盘、课程报告 | `curriculum` | 阶段的状态：计划中 → 设计中 → 待学习 → 学习中 → 测试中 → 复盘中 → 已完成，可以插补课阶段 |
| 知识节点、关系、课程成员、来源连线、操作组、合并、抽取任务 | `knowledge` | 关系类型见下 |
| 资料、片段、课程与资料、导入任务、网上资料、网站级别 | `library` | 权威级别由 `library` 按网站规则定，不采信调用方给的 |
| 讲义块索引、生成记录、检查结果、修订记录 | `textbook` | |
| 批注 | `annotation` | 锚点存原句、前后文和段落指纹，位置在读取时推算 |
| 题目和它的各版、见过的题、测试、作答、草稿、题目报告、申诉、作业标记 | `assess` | 练习题池和测试预留题分开 |
| 掌握状态、有效证据 | `learner` | 只读证据日志和知识图推算；规则版本变了就全部重算。别的单元要知道一次作答现在算不算、算独立还是有帮助，读 `effective`，不自己解释判分 |
| 侧边会话的总结、整理记录、起草的修改建议 | `sidechat` | |
| 老师收到的进度通知、课堂记录的进度 | `tutor` | |
| 复查的推迟记录 | `planner` | |

每个单元的表名以单元名开头（如 `assess_problems`），升级脚本由单元自己提供，由 `core` 统一执行并记录版本。

**知识关系的类型**（和 1EdTech CASE 对齐）：组成（`isPartOf`）、先修（不会 A 就做不了 B，我们自己的扩展，排课时唯一的硬约束）、建议先学（`precedes`，可以协商）、相关（`isRelatedTo`）、合并（`replacedBy`，旧节点停用并指向新节点，旧证据照样能查到）。

## 4. 学习证据日志

学习证据日志是判断"会不会"的唯一依据。每条记录仿照 xAPI：做了什么 + 对象 + 结果 + 场景，都带时间、课程、知识节点和场景（阶段、课时、测试、会话）。

| 类型 | 谁写 | 说明 |
|---|---|---|
| `attempt.graded` | `assess` | 对错或得分、判分方式、把握程度、测试种类和条件；时间是交卷时间（同一次交卷的题相同） |
| `attempt.regraded` | `assess` | 申诉或复核后的改判；原记录保留 |
| `problem.seen`、`problem.reported` | `assess` | 见过的题、学习者报告有问题的题 |
| `problem.reviewed` | `assess` | 老师核对题目的结论；`fixed`、`retired` 表示题有错，之前在这道题上的作答不再算证据 |
| `help.given` | `tutor`、`sidechat` | 帮助的程度和关联的题目或课时；时间是给出帮助的那条消息的时间 |
| `help.unrecorded`、`help.recorded` | `tutor`、`sidechat` | 一段对话多次整理失败、跳过了（时间范围、原因、模型），那段前后的作答帮助状态不确定；后来整理好了记 `help.recorded` |
| `signal.question` | `sidechat`、`annotation`、`tutor` | 问到的知识点，用来标"有疑点"；时间是学习者那句话的时间 |
| `signal.misconception` | `sidechat`、`tutor` | 有原话、有知识点的疑似误解，会安排一次检查 |
| `signal.self-report` | `tutor` | 学习者说"这个我会"，只触发验证，本身不提升状态 |

阅读、聊天、批注都不直接证明掌握。掌握状态有：未探测、还没答对、有帮助完成、已独立完成、已延迟验证、证据冲突；具体规则见 [learner](learner/design.md)。

## 5. 服务

需要某个单元"去做一件事"就调用它的服务，由它决定怎么做。服务在后端，经 cordis 注入；方法和参数见 `packages/contracts/src/services.ts`。

| 服务 | 单元 | 别的单元用它做什么 |
|---|---|---|
| `learnCore` | `core` | 数据库与升级、课程文件读写（带变更日志和回退）、课程、会话归属、证据日志的追加和查询、提案、页面接口和变更推送 |
| `learnLibrary` | `library` | 检索片段（附出处）、读片段和小节、资料目录、片段属于哪份资料、联网搜索和加入网上资料、读一个网页 |
| `learnKnowledge` | `knowledge` | 课程局部图、节点详情、有效先修、身份（合并后指向哪个节点，存下的编号读的时候经它解析）、增改节点和关系、讲义段落的连线、考试范围 |
| `learnGoal` | `goal` | 读目标说明、测试条件（按测试种类） |
| `learnAssess` | `assess` | 题库、组卷、测试和作答、判分、核对出的题目问题、"考我一下" |
| `learnCurriculum` | `curriculum` | 路线、阶段、课时、任务、设计书、复盘和带过来的知识点 |
| `learnTextbook` | `textbook` | 讲义的状态（按课时问，答它所在阶段的）、块索引、段落修改 |
| `learnLearner` | `learner` | 节点的掌握状态和理由、证据记录 |
| `learnAnnotation` | `annotation` | 批注、转侧边提问、报错提案 |
| `learnSidechat` | `sidechat` | 开侧边会话、判断会话能不能用某个工具（`checkTool`）、结束与总结、起草的修改建议 |
| `learnTutor` | `tutor` | 课程简报、写课时小结、处理修改提案 |
| `learnPlanner` | `planner` | 一门课的下一步（谁来做、没交的测试、建议的复查、回来后的回顾、按节奏的估算） |

依赖成环时，后来的一方在用到时用 `ctx.get` 取，不写进 `inject`。

## 6. 事件

某件事"已经发生了"就发事件，谁关心谁来听。事件名都以 `learning/` 开头，在数据写好后才发；`core` 把除两个拼装事件外的所有事件推给打开的页面（§7.2）。

| 事件 | 谁发 | 后端谁听 |
|---|---|---|
| `learning/logged` | `core`（追加证据日志后） | `learner` |
| `learning/node-state-changed` | `learner` | 只推给页面 |
| `learning/course-created`、`learning/course-updated` | `core` | 只推给页面 |
| `learning/doc-changed` | `core`（课程文件变了，或发现在外面被改过） | `textbook`（更新块索引） |
| `learning/goal-confirmed` | `goal` | 只推给页面 |
| `learning/source-imported` | `library` | `library`（补建语义索引） |
| `learning/source-updated`、`learning/import-changed`、`learning/web-changed` | `library` | 只推给页面 |
| `learning/identity-changed` | `knowledge`（合并或撤销合并后） | `learner`（重算） |
| `learning/extraction-changed` | `knowledge` | 只推给页面 |
| `learning/stage-changed` | `curriculum` | `textbook`（确认设计书后生成讲义） |
| `learning/roadmap-revised`、`learning/task-done` | `curriculum` | 只推给页面 |
| `learning/task-published` | `curriculum` | `curriculum` |
| `learning/test-finished` | `assess`（交卷判分后） | `curriculum`（完成测试任务、推进阶段） |
| `learning/textbook-ready`、`learning/textbook-failed` | `textbook`（按课时） | `curriculum` 听 `ready`：第一课时就绪，阶段变为待学习 |
| `learning/handoff` | 负责的单元 | `tutor`（合成进度通知送进老师的会话） |
| `learning/sidechat-summarized`、`learning/sidechat-changed` | `sidechat` | 只推给页面 |
| `learning/annotation-changed` | `annotation` | 只推给页面 |
| `learning/proposal-created`、`learning/change-applied` | `core` | 只推给页面 |
| `learning/proposal-decided` | `core`（`tutor` 处理提案后） | `annotation`（批注上显示结果） |
| `learning/planner-changed` | `planner` | 只推给页面 |

**交回主老师**（`learning/handoff`）：学习者在页面上做完一件事，或后台任务结束时，由负责的单元发一句话（不写内部编号），例如确认、交卷、点"完成"、加资料、新建课程，生成讲义、解析资料结束；主老师自己调用工具做的事不发。要不要唤醒老师由 `tutor` 按 `planner` 的下一步决定，单元不自己给老师的会话发消息。

**两个拼装事件**用 cordis 的 waterfall：每个监听者先 `await next()`，再追加自己的部分。

| 事件 | 谁收集 | 谁往里添 |
|---|---|---|
| `learning/course-brief` | `tutor`：每轮对话前给主老师的课程简报，内容变了才注入 | `planner`（下一步）、`tutor`（课堂）、`goal`、`library`、`curriculum`、`textbook`、`assess`、`knowledge`、`learner` |
| `learning/describe-selection` | `sidechat`：把页面上的选中内容写成侧边会话的上下文 | 选中内容的主人：`textbook`、`knowledge`、`assess`、`curriculum`、`library`、`annotation` |

## 7. 前端和后端之间

### 7.1 接口

- 路径是 `/api/learning/<单元>.<方法>`（如 `/api/learning/assess.submit`），经 `core` 的接口工具注册，沿用 DSH 的 RPC 信封；不接管 `/api` 的 RPC interceptor，暂不用 DSH 的类型化接口生成。
- 上传和读原件这类二进制接口直接注册在 DSH 的认证路由上：`library.upload`、`library.original`、`library.pdfAsset`，`assess.upload`、`assess.photo`。DSH 的流式请求体只用于 POST，所以上传和读取分成两个接口。
- 请求用契约包的数据格式校验。出错返回 `{ code: 'learning/<单元>/<原因>', message, details }`；校验失败是 `learning/invalid-input`，`message` 把各条说明连成一句话，原始结果在 `details.issues`。

### 7.2 变更推送

推送通道是 `/api/learning/feed`（服务端持续推送）：§6 的事件，加上讲义生成进度 `learning/textbook-progress`。页面收到后重新查询；`kit` 的 `useLoad` 默认收到任何 `learning/` 推送就刷新，页面不在前台时不刷新，回到前台再刷新一次。

### 7.3 插槽

外壳和几个页面声明插槽，各单元往里注册，互不 import。

| 插槽 | 谁声明 | 放什么 |
|---|---|---|
| `learning.page` | `shell` | 页面，按页面 ID 渲染进标签（如 `knowledge.graph`、`textbook.reader`） |
| `learning.panel` | `shell` | 侧栏面板，按面板 ID（`curriculum.outline`、`assess.list`、`annotation.list`、`library.course`、`knowledge.local`） |
| `learning.new-tab` | `shell` | 新标签页顶部的区块（继续学习） |
| `learning.status` | `shell` | 状态栏条目 |
| `learning.side-chat` | `shell` | 右侧栏的提问视图（`sidechat`） |
| `learning.figure` | `shell` | 资料里的一张图，由 `library` 画；页面用 `learnShell.Figure` |
| `learning.course-section` | `curriculum` 的课程进度页 | 进度页上的区块（目标、阶段、任务、测试……） |
| `learning.chat-card` | 主老师页 | 工具调用成功后显示的卡片，按工具名（如 `offer_goal_options`） |
| `learning.reader-notes` | 讲义阅读器 | 段落旁的批注菜单和段落下的批注（`annotation`） |
| `learning.source-notes` | 资料阅读器 | 识别文字旁的批注（`annotation`） |
| `learning.settings.services` | 设置页 | "资料服务"里各单元的设置区块 |

图标栏的按钮不是插槽，用 `learnShell.registerActivity` 登记：按钮打开一个页面，或显示一个侧栏面板（`panel`）；`placement: 'foot'` 放在图标栏底部。

### 7.4 外壳的前端服务 `learnShell`

登记图标栏按钮和角标；打开页面（默认在当前标签，可以新标签、右侧分屏或右侧栏，见 `OpenOptions`）；页面钩子 `usePage()`（是否在前台、在标签还是右侧栏、改标签标题）；当前页面、当前界面（主界面或哪门课）、进出课程；发布和读取选中内容；共用的推送连接；调用 `/api/learning/*` 的 `call`；共用的 Markdown 渲染（公式、讲义块、引用框、出处标签）和 `Figure`。

### 7.5 页面上下文

页面、批注和侧边会话共用 `Selection`：`{ page, courseId?, selected?: { kind, id?, quote?, label } }`，`kind` 是讲义块、节点、阶段、课时、任务、题目、作答、资料片段、资料或一段文字；`quote` 是选中的原文和前后文。

## 8. 和 Agent 之间

- **两个预设：** `teacher`（主老师，默认预设）和 `side-chat`（侧边会话），写在 `packages/app/cordis.patch.yml`。主老师开课时一个会话（目标、摸底、路线、第一阶段设计），之后每个阶段一个；侧边会话和主老师隔离。
- **工具** 名称是"动词_对象"（如 `search_library`、`publish_task`）。每个单元的工具是一个插件条目 `@learning-agent/<单元>/tools`，预设只挂自己需要的：主老师挂 library、knowledge、goal、assess、curriculum、textbook、tutor 的工具；侧边会话挂 library 和 sidechat 的工具，每次调用先经 `learnSidechat.checkTool`（只能用 `search_library`、`read_section`、`draft_proposal`；课程有进行中的测试时都不能用）。两个预设都不挂 DSH 的 shell、文件写入、`web_search` 这类工具。
- **注入会话的消息** 带来源，聊天里不显示成学习者的话：`learning-course-brief`（课程简报）、`learning-handoff`（进度通知）、`learning-next-step`（一轮中途的下一步更新）、`learning-side-chat-context`、`learning-side-chat-policy`。
- **一次性调用**（判分、写讲义、整理记录）不开会话，走 `kit` 的 `complete()`，按角色设置选模型（[packages/AGENTS.md](../packages/AGENTS.md)"调用模型"）。

## 9. 为什么这样定

- **服务和事件照搬 cordis：** 名字靠 TypeScript 声明合并检查类型；DSH 已经占用了 `goals`、`jobs` 这类名字，所以服务加 `learn` 前缀、事件用 `learning/` 开头。
- **先写盘后通知** 学自 DSH 的存储，但不用它存学习数据（它把数据全部读进内存，我们要全文检索、向量检索和大表）。
- **课程 = DSH 工作区。** DSH 的会话头里不能存自定义信息，所以会话属于哪门课、哪个阶段、什么角色，记在 `core` 自己的表里。
- **关系类型和 CASE 对齐**，方便以后导入导出；CASE 的 `precedes` 只表示先后，不是硬性先修，所以"先修"是我们的扩展。
- **证据日志仿照 xAPI，掌握状态用事件溯源：** 只追加记录，状态由规则推算，规则改了可以全部重算。
- **批注锚点学 W3C Web Annotation 和 Hypothesis：** 记原句和前后文，原文改动后还能找回；**块 ID 学 Obsidian 的块引用**，课程文件夹在 Obsidian 里也能正常显示和跳转。
- **ID 用 ULID：** SQLite 用随机 ID 做主键写入会慢约三分之一，按时间排序的没有这个问题。
- **每个单元管自己的表和升级脚本**，学 Koishi，由 `core` 统一执行。
