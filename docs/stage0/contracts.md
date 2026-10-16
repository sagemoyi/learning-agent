# 阶段 0 第 2 步：契约方案

> 2026-10-03 · 对应 PLAN"开发路线"阶段 0 第 2 步"定契约" · **状态：已确认（10-03，§10 五项全部采用）**
> **契约**是各个插件之间的约定：数据长什么样、存在哪、谁负责改、插件之间怎么通知和调用。约定好以后，各插件可以分头开发，接起来也不会对不上。
> 本文先列调研结论（§1），再给方案（§2–§8），最后是需要你确认的几个决定（§10）。精确的类型定义在第 3 步"搭骨架"时写进代码。

---

## 1. 调研结论：借鉴什么

| 来源 | 是什么 | 我们借鉴什么 |
|---|---|---|
| **DSH / cordis 本身**（读源码和文档） | 插件之间用"服务"直接调用，用"事件"广播通知。服务名和事件名都靠 TypeScript 的声明合并获得类型检查 | 照搬这套写法。DSH 已经占用了 `goals`、`jobs` 这类常见名字，所以我们的服务统一加 `learn` 前缀，事件统一用 `learning/` 开头 |
| DSH 存储（`storage-domain`） | 把数据**全部读进内存**的键值存储，写盘成功后才发"已变更"事件 | 不用它存学习数据（我们有全文检索、向量检索、大表）。但借鉴它的规矩：**先写盘，后通知** |
| DSH 工作区 | 工作区就是"一个注册过的文件夹 + 在这个文件夹里跑过的会话"。建会话时可以直接指定工作区，还可以由我们自己指定会话 ID | 课程 = 工作区，确认可行。会话头里**不能存自定义信息**，所以"哪个会话属于哪门课、哪个阶段、什么角色"要记在我们自己的库里 |
| DSH 会话接口 | 后端插件可以自己建会话、发消息（`sessionController`），能读取已结束会话的完整记录（`inspect`），也能不开会话、直接调一次模型（`ctx.llm.stream`） | 侧边会话结束后，读取记录写总结；判分、转写这类"一次性"调用不开会话 |
| DSH 后台任务（`ctx.jobs`） | 统一管理耗时任务：进度、输出、取消 | 资料导入、生成教材、联网调研都作为后台任务 |
| DSH 前端插槽（slots） | 外壳声明"位置"（插槽），各插件往里注册组件，互不 import | 我们的外壳声明自己的插槽：活动栏、页面、状态栏；各单元把页面注册进去 |
| **1EdTech CASE**（能力框架交换标准） | 教育界用来描述"能力点和它们之间关系"的国际标准，定义了 10 种关系 | 我们的关系类型和它对齐，方便以后导入导出。注意：CASE 的 `precedes` 只表示"先后顺序"，**不是硬性先修**，所以"先修"是我们自己的扩展 |
| **xAPI**（学习记录标准） | 每条学习记录 = 谁 + 做了什么 + 对什么 + 结果 + 场景 | 学习证据日志采用同样的结构（单用户，所以省掉"谁"）。不做完整兼容，但以后可以导出 |
| **W3C Web Annotation + Hypothesis** | 批注锚点的标准做法：记下被选中的原文，以及它前后各一小段文字，原文改动后还能"模糊找回" | 批注先锚定在段落块 ID 上；块内的划线再用"原文 + 前后文"定位 |
| **Obsidian 块引用** | 在段落末尾写 `^块ID`，就能精确引用这一段 | 教材的段落块 ID 用这个写法。课程文件夹用 Obsidian 打开也能正常显示和跳转 |
| **事件溯源**（软件设计模式） | 只追加记录"发生了什么"，当前状态由记录推算出来 | 学习证据只追加、不修改；掌握状态由规则推算，**规则改了可以全部重算**（`learner` 放在最后做，正好需要这一点） |
| **ULID**（ID 格式） | 按时间排序的唯一 ID。第三方测试显示：SQLite 用随机 ID 做主键，写入会慢约三分之一；按时间排序的 ID 没有这个问题 | 数据库对象的 ID 用"类型前缀 + ULID"，比如 `pb_01JABC…` 一看就知道是题目 |
| **Koishi**（同样基于 cordis 的框架） | 每个插件声明自己的数据表，框架负责建表和升级 | 每个单元管理自己的表和升级脚本，由 `core` 统一执行 |

---

## 2. 七条总规则

1. **单元之间只依赖"契约包"，不互相引用代码。** 契约包（`@learning-agent/contracts`）里只有类型、数据格式校验、服务和事件的声明，没有业务逻辑。DSH 的界面插件也是这么做的。
2. **每类数据只有一个真相来源。** 要么在课程文件里，要么在数据库里，不存两份（§4.1）。
3. **每张表、每个文件只有一个"主人"单元。** 别的单元要改，就调用主人提供的服务。
4. **学习证据只追加，不修改。** 判错了就追加一条"更正"，不删原记录。掌握状态是推算结果，可以随时重算。
5. **先写盘，后通知。** 数据写进数据库或文件以后，才发出事件。监听者出错不会影响已经写好的数据。
6. **课程文件只经 `core` 写入。** 每次写入都自动进变更日志并保存旧版本，所以随时可以回退。
7. **出错要说清楚。** 接口出错时，必须把具体原因传回前端。V3 验证时吃过"只有一句内部错误"的亏。

---

## 3. 目录结构

### 3.1 数据根目录（你的学习数据，和代码仓库分开）

默认放在 `文档/学习库`，可以在设置里修改。整个目录可以直接用 Obsidian 打开浏览。

```
学习库/
├─ .learning/               程序数据，不需要手动打开
│  ├─ learning.db           全局数据库（SQLite）
│  └─ cache/                可以重建的缓存
├─ library/                 资料库（全局，所有课程共用）
│  └─ src_01JA…-化工原理第3版/
│     ├─ original.pdf       原文件
│     ├─ source.md          资料卡：标题、作者、版次、权威级别、来源
│     └─ parsed/            解析结果（MinerU 的 Markdown、结构化数据、页面图片）
└─ courses/
   └─ 化工原理/              一门课 = 一个 DSH 工作区
      ├─ course.md          课程卡：标题、简介
      ├─ goal.md            目标说明（六要素 + 可选的考试档案）
      ├─ roadmap.md         课程路线（阶段标题 + 阶段目标）
      ├─ stages/
      │  └─ 01-流体流动/
      │     ├─ design.md    阶段设计书（含测试蓝图）
      │     ├─ textbook/    本阶段教材，一个小节一个文件
      │     │  ├─ 1.1-流体静力学.md
      │     │  └─ 1.2-….md
      │     ├─ lessons/     每小节的记录：小测结果、你的汇报、老师的小结
      │     │  └─ 1.1.md
      │     └─ review.md    阶段复盘
      ├─ notes/
      │  └─ side-chats.md   侧边会话总结（只追加）
      ├─ attachments/       作答附件（手写照片等）
      └─ report.md          结课报告
```

- **为什么一个小节一个文件：** 课时按小节推进，批注、阅读进度、生成也都按小节进行。一个阶段的教材仍然是一个整体（同一个文件夹）。
- **文件名用英文，标题用中文：** 程序认的是固定的英文文件名；你看到的标题（文件内容、阶段文件夹名）都是中文。
- **主界面的侧边会话**以数据根目录为工作目录。

### 3.2 教材文件长什么样

```markdown
---
lesson: ls_01JA…
title: 1.1 流体静力学
version: 2
---

## 1.1 流体静力学

静止流体内部任一点的压强，与该点所处的深度成正比……[《化工原理》第3版 p.14](cite:ck_01JAB…) ^b7k2qx

$$ p = p_0 + \rho g h $$

^m3x9ka
```

- **块 ID：** 写在段落末尾，形如 `^b7k2qx`（6 位，课程内唯一）。公式、表格这类块，ID 单独占一行写在块后面（Obsidian 的规则）。
- **出处：** 用链接写在句子后面，链接地址是 `cite:片段ID`。每个块至少要有一个出处；暂时找不到出处的写成 `[待核实](cite:unverified)`，界面上会醒目提示。
- **资料原文和待核实（10-15 起）：** 公式、原图、例题等资料原文以 Obsidian 引用框原样放入；待核实记在块索引里、不写进正文（旧文件里的 `[待核实](cite:unverified)` 照旧读出）。详见 §11"教材 D"。
- **块挂到哪些知识节点，记在数据库里**，不写进文件，避免干扰阅读。
- **你在外面（比如 Obsidian 里）改了文件：** 读取时会通过内容指纹发现，记为一次"你的修改"，不会悄悄丢失。

---

## 4. 数据对象

### 4.1 存在哪：文件还是数据库

| 数据 | 真相在 | 理由 |
|---|---|---|
| 目标说明、路线、设计书、教材正文、小节记录、复盘、侧边会话总结、报告 | 课程文件夹里的 Markdown | 你可以直接读；结构化字段写在文件头部（frontmatter） |
| 课程、阶段、课时、任务的**状态** | 数据库 | 变化频繁的状态，不适合写在文件里 |
| 知识节点与关系、资料片段索引、题库 | 数据库 | 要查询、要检索 |
| 学习证据（作答判分、帮助、信号） | 数据库，只追加 | 见 §4.6 |
| 掌握状态 | 数据库，推算结果 | 可以删掉重算 |
| 修改提案、变更日志（含旧版本全文） | 数据库 | 回退要用 |
| 资料原件和解析结果 | `library/` 文件夹 | 片段索引在数据库 |

### 4.2 ID 规则

| 对象 | 格式 | 例子 |
|---|---|---|
| 数据库里的对象 | 类型前缀 + ULID（同一毫秒里生成的递增，按编号排序就是生成的先后） | `cr_` 课程、`st_` 阶段、`ls_` 课时、`tk_` 任务、`kn_` 知识节点、`ke_` 关系、`src_` 资料、`ck_` 资料片段、`pb_` 题目、`ts_` 测试、`at_` 作答、`lg_` 证据日志、`an_` 批注、`pp_` 提案、`chg_` 变更、`df_` 侧边会话起草的修改建议 |
| 教材段落块 | `^` + 6 位小写字母数字，课程内唯一 | `^b7k2qx` |
| 资料片段的位置 | 页码 + 块序号 + 坐标框（来自 MinerU） | 第 22 页第 3 块 |
| DSH 会话 | UUID，由我们生成并在建会话时传给 DSH（S3 实测可行） | 先登记归属，再建会话，不会出现"孤儿会话" |

### 4.3 课程与进度

| 对象 | 主人 | 要点 |
|---|---|---|
| **Course** 课程 | `core` | 标题、文件夹、对应的 DSH 工作区、状态（进行中 / 已结课 / 归档） |
| **Goal** 目标说明 | `goal` | 存在 `goal.md`。头部是结构化字段：目的、场景、学成后能做什么、程度、验证方式、边界（不学什么、默认测试条件、时间投入），以及可选的最后期限、考试档案（范围、题型分值、考试条件、往年题、侧重）。状态：草稿 / 已确认 |
| **Stage** 阶段 | `curriculum` | 序号、标题、阶段目标、类型（普通 / 补课）、这一阶段的主老师会话、状态 |
| **Lesson** 课时（= 小节） | `curriculum` | 所属阶段、序号、标题、对应的教材文件、状态 |
| **Task** 任务 | `curriculum` | 类型（预测 / 阅读 / 小测 / 练习 / 汇报 / 阶段测试 / 复查 / 其他）、说明、状态（待做 / 完成 / 跳过）、发布者、结果链接 |

**阶段的状态流转：**

```
计划中 → 设计中 → 待学习（设计书已确认、教材已生成）→ 学习中 → 测试中 → 复盘中 → 已完成
                                                                    └→ 插入补课阶段
```

**课时的状态流转：** 未开始 → 进行中 → 已完成（小测、汇报、小结都做完）。

### 4.4 知识模型（全局）

| 对象 | 主人 | 要点 |
|---|---|---|
| **Node** 知识节点 | `knowledge` | 名称、种类（知识 / 技能 / 综合能力 / 完整任务）、说明、别名、创建依据（哪次变更） |
| **Edge** 关系 | `knowledge` | 起点、终点、类型、理由、出处 |
| **CourseNode** 课程与节点 | `knowledge` | 节点属于哪门课：本课核心 / 相关 / 考试范围内外 |
| **NodeLink** 来源层连线 | `knowledge` | 资料片段、题目、教材块 → 节点，关系是讲解 / 例题 / 考查 |

**关系类型（与 CASE 对齐）：**

| 我们的关系 | CASE 对应 | 影响排课吗 |
|---|---|---|
| 组成 | `isPartOf` | 否 |
| **先修**（不会 A 就做不了 B） | 无，我们自己的扩展 | **是，唯一的硬约束** |
| 建议先学 | `precedes` | 否，可以协商 |
| 相关 | `isRelatedTo` | 否 |
| 节点合并（你确认后） | `replacedBy` | 旧节点不删，指向新节点，旧证据照样能查到 |

### 4.5 资料、教材与批注

| 对象 | 主人 | 要点 |
|---|---|---|
| **Source** 资料 | `library` | 标题、种类（教材 / 课件 / 论文 / 网页 / 真题 / 标准 / 其他）、权威级别（一级 / 二级 / 三级 / 只当线索）、来源（导入的文件或网址 + 抓取时间）、解析方式 |
| **Chunk** 资料片段 | `library` | 所属资料、位置、种类（标题 / 正文 / 公式 / 表格 / 图 / 例题 / 习题 / 答案）、章节路径、文本、向量 |
| **CourseSource** 课程与资料 | `library` | 这份资料在这门课里的角色：骨架教材 / 参考 / 考试档案 |
| **Block** 教材块索引 | `textbook` | 块 ID、所在文件、内容指纹、挂的节点、引用的片段、是否待核实、是否资料原文 |
| **Annotation** 批注 | `annotation` | 锚点（块 ID 或资料片段 ID，加上块内的原文和前后文）、类型（疑问 / 我的理解 / 重点 / 报错）、内容，以及后续去向（转成了哪个侧边会话或提案） |

### 4.6 题目与证据

| 对象 | 主人 | 要点 |
|---|---|---|
| **Problem** 题目 | `assess` | 题干（Markdown，可带图）、答案（数值 / 选择 / 表达式 / 开放题；数值题带单位和允许误差）、答案来源（原书 / 权威来源 / 计算工具验算 / Agent 解答未核对）、级别 1–4、出处（片段 ID 或网址 + 页码题号）、改编自哪道题、考查节点、题池（练习 / 测试预留）、状态（可用 / 待核查 / 已下架） |
| **Seen** 见过的题 | `assess` | 哪道题、怎么见过的（作业 / 练习 / 测试 / 教材例题）、时间。见过的题不再当新题 |
| **Test** 测试 | `assess` | 类型（摸底 / 小节小测 / 练习 / 阶段测试 / 复查 / 模拟考）、测试条件（开卷闭卷、计算器、公式表、限时）、题目列表、换题上限、状态 |
| **Attempt** 作答 | `assess` | 题目、所属测试、作答内容（文字、照片、转写结果及你确认的时间）。判分结果单独追加，所以申诉、复核都不改原记录 |
| **LogEntry** 学习证据日志 | 共用，由 `core` 保存 | 见下 |
| **NodeState** 掌握状态 | `learner` | 推算结果：未探测 / 还没答对 / 有帮助完成 / 已独立完成 / 已延迟验证 / 证据冲突，附加"待复查""有疑点"标记，一段文字说明"为什么是这个状态"，以及用的规则版本 |

**学习证据日志**是整个系统判断"你会不会"的唯一依据。每条记录的结构仿照 xAPI：**做了什么 + 对象 + 结果 + 场景**。

| 记录类型 | 谁写 | 例子 |
|---|---|---|
| `attempt.graded` 作答已判分 | `assess` | 题目、考查节点、对错或得分、判分方式（规则 / 模型 / 你确认）、把握程度、测试类型、测试条件 |
| `attempt.regraded` 判分更正 | `assess` | 申诉或复核后改判 |
| `help.given` 给了帮助 | `tutor`、`sidechat`、测试页 | 涉及节点、帮助程度（提示 / 讲解 / 完整解答 / 看答案）、关联的题目或课时 |
| `signal.question` 提问 | `sidechat`、`annotation` | 问到的节点，用来标"有疑点" |
| `signal.misconception` 疑似误解 | `sidechat`、`tutor` | 推测出的误解，会触发一道检查题 |
| `signal.self-report` 你说"这个我会" | `tutor` | 只触发快速验证，本身不提升状态 |
| `problem.seen` / `problem.reported` | `assess` | 见过的题、报错的题 |

所有记录都带：时间、课程、节点、场景（阶段 / 课时 / 测试 / 会话）。`learner` 只读这张日志和知识图来推算掌握状态。

**骨架阶段先用简单规则顶着**（`learner` 做深时再专门调研）：
- 答对，且同一课时或测试里这些节点没有帮助记录 → 已独立完成
- 答对，但有帮助记录 → 有帮助完成
- 独立完成后，隔 3 天以上又独立答对 → 已延迟验证
- 独立答对过，最近一次独立作答却答错 → 证据冲突（先错后对按最近一次算）
- 答过但没有答对过 → 还没答对
- 规则变了（规则版本号不同），启动时按新规则重算全部状态

### 4.7 会话与修改

| 对象 | 主人 | 要点 |
|---|---|---|
| **SessionLink** 会话归属 | `core` | DSH 会话 ID → 课程、角色（主老师 / 侧边会话 / 调研）、阶段、打开时所在的页面和选中内容、结束时间 |
| **SideChatSummary** 侧边会话总结 | `sidechat` | 正文追加到 `notes/side-chats.md`；结构化部分（节点、误解、给了什么帮助、生成了哪些提案）存数据库 |
| **Proposal** 修改提案 | `core` 存，`tutor` 处理 | 来源（你 / 侧边会话 / 批注报错 / 阶段复盘）、改什么、理由、状态（待处理 / 已接受 / 已拒绝 / 已应用 / 已撤回） |
| **Change** 变更 | `core` | 改了什么、谁改的（主老师 / 你 / 系统）、大改还是小改、修改前后的完整内容、对应的提案。回退也是一次新的变更 |

---

## 5. 插件之间：服务和事件

**分工原则：** 需要某个单元"去做一件事"，就调用它的服务，由它决定怎么做；某件事"已经发生了"，就发事件，谁关心谁来听。

### 5.1 服务（后端）

| 服务 | 单元 | 主要能力 |
|---|---|---|
| `learnCore` | `core` | 数据库（事务、各单元的升级脚本）；课程文件读写（自动进变更日志）；变更日志与回退；课程与工作区；会话归属；证据日志追加；给前端开接口的工具；变更推送 |
| `learnLibrary` | `library` | 导入资料（后台任务）；检索片段并附带出处；取片段原文；联网调研入库 |
| `learnKnowledge` | `knowledge` | 节点、关系的增删改（经变更日志）；课程局部图；来源层连线；合并建议 |
| `learnGoal` | `goal` | 读取、起草、修改、确认目标说明 |
| `learnAssess` | `assess` | 题库；按节点和题池选题（排除见过的）；组卷；提交作答；判分；换题、报错 |
| `learnCurriculum` | `curriculum` | 路线；阶段及其状态；课时；发布、完成任务；阶段设计书；复盘 |
| `learnTextbook` | `textbook` | 生成一个阶段或一个小节的教材（后台任务）；块索引；按块 ID 查内容 |
| `learnAnnotation` | `annotation` | 增删批注；转成侧边会话；转成提案 |
| `learnSidechat` | `sidechat` | 按页面上下文开一个侧边会话；结束时写总结 |
| `learnTutor` | `tutor` | 准备本阶段的主老师会话；评估和应用修改提案；写小节小结 |
| `learnLearner` | `learner` | 推算掌握状态；查询某个节点的状态和理由；全部重算 |
| `learnPlanner` | `planner` | 某门课的下一步（带稳定标识、没做完的测试、建议的复查、回来后的回顾和按节奏的估算）；开始建议的复查、今天先不做 |

### 5.2 事件（后端，全部以 `learning/` 开头）

| 事件 | 谁发 | 谁听 |
|---|---|---|
| `learning/logged` 新的证据日志 | `core`（各单元追加日志后） | `learner` 更新掌握状态；`tutor` 留意误解和报错 |
| `learning/node-state-changed` 掌握状态变了 | `learner` | `planner`；推送给前端，知识图变色 |
| `learning/course-created` | `core` | `planner` |
| `learning/doc-changed` 课程文件变了 | `core` | `textbook` 更新块索引；推送给前端 |
| `learning/goal-confirmed` | `goal` | `curriculum` 排路线；`knowledge` 搭初版知识图 |
| `learning/source-imported` | `library` | `knowledge` 挂来源；`assess` 从资料里抽题 |
| `learning/stage-changed` 阶段状态变了 | `curriculum` | `tutor` 开新阶段的会话；`planner`；前端 |
| `learning/task-published` / `learning/task-done` | `curriculum` | `tutor`、`planner`、前端 |
| `learning/textbook-ready` | `textbook` | `curriculum`、前端 |
| `learning/sidechat-summarized` | `sidechat` | `tutor`（处理里面的提案） |
| `learning/annotation-changed` 批注有变化 | `annotation` | 推送给前端 |
| `learning/proposal-created` / `learning/change-applied` | `core` | `tutor`、前端 |

还有两个"拼装"型事件，用 cordis 的 waterfall 模式，各单元往里面添自己的那一部分：

| 事件 | 用途 | 谁往里添 |
|---|---|---|
| `learning/course-brief` | 每一轮对话前，给主老师拼一份"课程现状简报" | `curriculum`：当前阶段、课时、任务；`learner`：薄弱节点；`planner`：下一步；`goal`：目标要点 |
| `learning/describe-selection` | 侧边会话打开时，把你选中的东西变成文字上下文 | `textbook`：这一段教材；`knowledge`：这个节点和它的状态；`assess`：这道题和你的作答…… |

这样 `tutor` 和 `sidechat` 都不需要认识其他单元，只管"收集"。

### 5.3 三条关键链路

```
做题：测试页提交 → assess 判分 → 写作答 + 追加 attempt.graded 日志
      → learning/logged → learner 推算 → learning/node-state-changed → 知识图变色、planner 调整下一步

侧边会话：你在教材某段打开 → describe-selection 拼上下文 → 会话（与主老师隔离）
      → 结束 → sidechat 读取记录写总结 → 追加 help.given / signal.* 日志 → learning/sidechat-summarized
      → 里面若有修改提案 → tutor 按 §7 流程处理

修改：提案（你 / 侧边会话 / 批注 / 复盘）→ tutor 评估 → 小改直接应用，大改等你确认
      → core 写入新版本 + 变更日志 → learning/change-applied → 前端刷新
```

---

## 6. 前后端之间

### 6.1 接口

- **路径：** `/api/learning/<单元>.<方法>`，例如 `/api/learning/assess.submitAttempt`。沿用 V3 验证过的精确路由和 RPC 信封。
- **校验：** 请求和返回都用契约包里的数据格式校验，前后端共用同一份定义。
- **错误：** `{ code: 'learning/<单元>/<原因>', message, details }`，必须带具体原因。

### 6.2 变更推送

- 一个推送通道 `/api/learning/feed`（服务端持续推送）。后端把 §5.2 里前端关心的事件推给页面，页面收到后重新查询。
- 后台任务（导入、生成教材）的进度也走这个通道。

### 6.3 前端插槽（由外壳声明，各单元注册）

| 插槽 | 放什么 | 例子 |
|---|---|---|
| `learning.activity` | 活动栏按钮（标明在主界面、课程界面还是都显示） | 知识模型、资料库、进度、教材…… |
| `learning.page` | 页面组件，按页面 ID 渲染进标签页 | `knowledge.graph`、`textbook.reader`、`assess.test`…… |
| `learning.panel` | 侧栏面板（点图标栏的图标显示，10-16 取代 `learning.sidebar`，见 §11"外壳改版"） | 课程教材的目录、测试、批注 |
| `learning.new-tab` | 新标签页顶部的区块 | 继续学习 |
| `learning.status` | 状态栏条目 | 阶段进度、今日任务、当前模型 |
| `learning.side-chat` | 右侧栏（只有一个） | `sidechat` 单元 |

外壳另外提供一个前端服务 `learnShell`：打开页面（可以分屏）、获取当前位置（主界面还是哪门课、哪个页面），以及发布和读取"当前选中内容"。

### 6.4 页面上下文（各页面和侧边会话、批注共用）

```
{ 页面, 课程?, 选中?: { 种类: 教材块 | 节点 | 阶段 | 课时 | 任务 | 题目 | 作答 | 资料片段 | 资料 | 一段文字, ID?, 原文?, 显示名 } }
```

---

## 7. 和 Agent 之间

### 7.1 预设（角色）

| 预设 | 用途 | 工具（大类） |
|---|---|---|
| `teacher` 主老师 | 每个阶段一个会话 | 读课程现状、查资料库、联网搜索、发布任务、选题组卷、处理提案、写小结 |
| `side-chat` 侧边会话 | 答疑 | 只读：查资料库、看节点、看教材块；可以起草提案，但不能直接改任何东西 |
| `researcher` 调研 | 后台任务里用 | 联网搜索、抓取网页、入库 |

判分、手写转写、写侧边会话总结、逐块写教材这类"一次性"活，**不开会话**，直接调用模型（`ctx.llm.stream`），按 PLAN"模型策略"的"任务角色"选择模型。

### 7.2 工具

- **命名：** 小写加下划线，"动词_对象"，例如 `get_course_state`、`search_library`、`publish_task`、`propose_change`。
- **归属：** 每个工具属于一个单元，单独作为一个插件条目，这样每个预设可以只挑自己需要的工具（V4 验证过）。
- **每一轮都给主老师最新的课程现状：** 用 §5.2 的 `learning/course-brief` 拼好，在每轮开始前注入。具体用 DSH 的哪个注入点，在骨架阶段验证。

---

## 8. 代码怎么组织

```
learning-agent/
├─ packages/
│  ├─ contracts/      契约包：类型、数据格式、ID、服务/事件/插槽声明
│  ├─ core/           后端：数据库、文件、变更日志、会话归属、证据日志、接口与推送
│  ├─ shell/          前端：整页外壳、布局、插槽、learnShell
│  ├─ library/ knowledge/ goal/ assess/ curriculum/
│  ├─ textbook/ annotation/ sidechat/ tutor/ learner/ planner/
│  │      每个单元：src/host（后端）、src/client（前端页面）、src/tools（给 Agent 的工具）
├─ packages/app/      组合包：单元、Agent 预设、关掉 DSH 自带界面
├─ profile/           learning profile 的初始文件（学习者自己的一层）
├─ spikes/            验证代码，不进产品
└─ docs/
```

- **语言：** TypeScript（DSH 本身就是 TS，服务和事件的类型检查靠它）。
- **包管理：** pnpm 工作区（DSH 用的也是 pnpm，本机已有 11.22）。
- **契约包打进每个单元：** 跨单元不能用 `instanceof` 判断契约里的类，契约包里也不放共享的运行时状态（S7）。
- **类型检查分前端、后端两份配置**（`tsconfig.host.json` / `tsconfig.client.json`），DSH 的类型直接取自 `.tools/dsh` 里锁定的版本。
- **构建：** 后端代码编译成 JS；前端沿用 spike 的 esbuild 打包，输出 DSH 客户端模块格式。
- **数据表：** 每个单元的表都以单元名开头（如 `assess_problems`），升级脚本由单元自己提供，由 `core` 统一执行并记录版本。
- **相对 PLAN 的改动：** `store` 改名为 `core`，因为它除了存储，还负责接口、推送和会话归属。

---

## 9. 骨架阶段要先验证的点

**10-03 已全部实测通过**，细节和 4 个注意事项见 [compatibility.md](compatibility.md) 的 S1–S7。

1. 精确路由能否做持续推送（`/api/learning/feed`），浏览器端的认证能否通过。
2. 外壳声明自己的插槽后，其他单元能否把页面注册进去，并且显示在 dockview 的标签页里。
3. 后端插件能否创建工作区，并在指定工作区、用自己生成的 ID 建会话。
4. 每轮给主老师注入"课程现状简报"用哪个注入点。
5. 能否读取已结束的侧边会话的完整记录。
6. 不开会话、直接调一次模型，经过你的中转地址能否正常工作。
7. pnpm 工作区里的多个插件包，通过 `dsh plugin add link:` 装进 DSH 后，能否都正确引用契约包。

---

## 10. 需要你确认的决定

| # | 决定 | 我的建议 | 理由 |
|---|---|---|---|
| 1 | 学习证据只追加，掌握状态由规则推算、可重算 | 采用 | 符合"只有作答能证明掌握"；`learner` 最后才做深，规则会改，重算比迁移数据可靠 |
| 2 | 文件和数据库的分工（§4.1） | 采用 | 你能读的东西放文件，频繁变化和需要查询的放数据库，每样只存一份 |
| 3 | 数据放在 `文档/学习库`，和代码仓库分开；可以用 Obsidian 打开 | 采用 | 你的教材、照片、学习记录都不会进代码仓库；Obsidian 能直接浏览 |
| 4 | 教材一个小节一个文件，块 ID 用 Obsidian 的 `^ID` 写法，出处用 `cite:` 链接 | 采用 | 和课时一一对应；Obsidian 里也能正常显示 |
| 5 | TypeScript + pnpm 工作区，`store` 改名为 `core` | 采用 | 与 DSH 一致；类型检查是"契约"真正生效的方式 |

确认后（或按你的修改调整后），我会把结论写进 PLAN（§8、§9.2 和决策记录），然后开始第 3 步"搭薄骨架"：先验证 §9 的几个点，再写契约包，接着把 PLAN §10 里那条最小学习流程跑通。

---

## 11. 骨架阶段的补充（10-03 搭骨架，10-04 验收和协同修整）

搭薄骨架时，代码里对契约做了以下补充。除了标"待定"的一项，都是对上面方案的细化，没有改变已确认的 5 个决定。精确定义以代码为准（`packages/contracts/src/`）。

**服务接口：** §5.1 里各单元服务的骨架版接口写在 `services.ts`，每个服务只有跑通最小流程需要的方法，单元做深时再扩充。其中 `learnTutor.brief` 对外提供每轮的课程简报。

**数据对象：**

| 补充 | 用途 |
|---|---|
| `Stage.designConfirmedAt` | 学习者确认阶段设计书的时间。确认后，`textbook` 按课时顺序自动生成本阶段教材；第一个课时的教材就绪，阶段就变为"待学习"（10-04 起，原为全部生成完） |
| `Source.pageOffset` | PDF 页码与书上页码之差。出处显示书上的页码（《化工原理》第 3 版是 12） |
| 导入资料时可以给多个解析结果文件 | MinerU 按页码范围分批解析，导入时按页合并 |
| 掌握状态 `not-yet`（还没答对）| 答过但还没答对过的节点。原方案的状态里没有这一种，"未探测"又不等于不会。10-05 你确认保留为正式状态，显示为琥珀色的"还没答对"；§3.2 和 §4.6 已补上 |

**事件和推送：**
- 新事件 `learning/test-finished`：`assess` 交卷判分后发出；`curriculum` 据此完成对应的测试任务。
- 推送消息 `learning/textbook-progress`（10-04 前叫 `textbook/progress`）：教材生成进度（排队、编写到第几部分、完成、失败及原因），直接经推送通道发给页面，不是单元之间的事件。

**协同修整（10-04，第一次试用之后）：**
- 新事件 `learning/handoff`（"交回主老师"）：学习者在页面上做完的事、后台任务的结果，由负责的单元发出，内容是一句话。目前有：新建课程（`core`）、确认目标（`goal`）、导入或加入资料（`library`）、交卷（`assess`，带判分结果）、确认设计书和点"完成"任务（`curriculum`）、教材生成完成或失败（`textbook`）。主老师自己调用工具做的事不发。
- `tutor` 收到后，把同一时刻的几条合成一条【进度通知】送进主老师当前的会话（消息来源 `learning-handoff`，聊天里显示成通知，不算学习者说的话）：`planner` 的下一步轮到主老师时，通知会直接开始一轮对话；否则只作为主老师下一轮的背景信息。阶段的第一条通知会让主老师先介绍这个阶段。原来"阶段就绪时发开场通知"的做法并入这里。
- `learning/textbook-ready` 改为按课时发出（带 `lessonId`），新增 `learning/textbook-failed`（带失败原因）。两者都在推送通道上。
- 阶段就绪判断只接受第一课时的 `learning/textbook-ready`；首节失败而后续课时成功时，继续留在设计阶段，先处理首节失败（10-04 Codex 复核补齐实现，没有改变原约定）。
- `learnTextbook.status(lessonId)`：某课时教材的状态（未生成 / 生成中 / 已生成 / 失败，及进度、段数、待核实段数、连续失败次数），供进度页、教材页、`planner` 和简报使用。失败记录只保存在内存里。
- 教材分部分生成：一个课时的资料超过约 6000 字（含片段编号的开销）时，按小标题分成几部分，每次写一部分（两部分并行），最后单独生成"读完就答"。某部分被截断就对半拆开重写（最多两层）。
- `planner`：每个课时先看教材状态。生成中 → 等学习者；失败第一次 → 主老师重试（`regenerate_textbook`）；连续失败两次 → 交还学习者稍后重试。
- 外壳：活动栏按钮改为图标 + 文字（`ActivityItem.icon` 取代 `glyph`，图标用 lucide-react）；`learnShell.setBadge` 在按钮上显示数字（"测试"显示待作答数）；标签栏右侧有"刷新"按钮；当前页面对应的按钮高亮。
- `assess` 增加"测试"页（`assess.tests`）和活动栏入口。
- `tutor` 的配置项 `handoffDelayMs`（默认 1500 毫秒）：等多久把相关的几条交回合成一条，测试里设为 0。

**外壳（§6.3）：**
- 插槽：`learning.page`（页面）、`learning.side-chat`（右侧栏，只有一个）、`learning.course-section`（课程进度页上的区块，由 `curriculum` 的进度页声明，`goal`、`assess`、`planner` 往里放区块）。
- 原计划的 `learning.activity` 插槽改成了 `learnShell.registerActivity` 方法（活动栏按钮只是数据）。
- **10-04 前端重构补上：** `learning.sidebar`（左侧栏页面列表下方的区块，按 `order` 排；`curriculum` 放课程目录，`planner` 在主界面放课程列表）和 `learning.status`（状态栏条目；`curriculum` 放阶段进度，`assess` 放待作答测试数，`planner` 放下一步）。两者的属性都是 `{ scope }`，区块自己判断在哪个界面显示。（10-16 由 `learning.panel` 和 `learning.new-tab` 取代，见下文"外壳改版"）
- **10-04 `learnShell` 补充：** `activePage()` / `onActivePage()`（当前标签页的页面和参数，§6.3 的"获取当前位置"；课程目录据此高亮正在读的课时）、`showSideChat()`（打开侧边提问，用于"就这段提问""就这题提问"）。
- 深浅色跟随 DSH 的外观设置（`ctx.theme`，没有时跟随系统），外壳在 `<html>` 上设 `data-la-theme`；侧栏宽窄、侧边提问开关和宽度、每个界面打开的标签页记在浏览器本地（只是界面偏好，不是学习数据）。
- `learnShell` 还提供：进入/离开课程、选中内容的发布和读取、共用的推送连接、调用 `/api/learning/*` 的 `call`、共用的 Markdown 渲染（含公式、教材块模式、行内模式；出处标签点开就是资料原文）。
- `core` 给页面的接口：`core.courses`、`core.createCourse`、`core.changes`。

**Agent（§7）：**
- 每个单元的工具是一个单独的入口（`@learning-agent/<单元>/tools`）。主老师挂 7 个单元的工具；侧边会话挂资料库的工具包，但按 `learnSidechat.checkTool` 只能用其中的 `search_library`、`read_section`。
- 主老师的会话：开课时一个（目标、摸底、路线、第一阶段设计），之后每个阶段一个。阶段就绪后的第一条【进度通知】进入新的阶段会话，主老师先介绍这个阶段。
- 课程简报按"下一步 → 目标 → 资料 → 路线与任务 → 教材 → 测试 → 知识节点 → 掌握状态"的顺序拼，只在内容变化时注入。

**题目与教材（10-04 验收时补充）：**
- 摸底、小测、练习只用练习题池；阶段测试和模拟考只用测试预留题。指定的题目不在对应题池时直接报错。
- 写教材时，模型只拿到"教学部分"：设计书去掉测试、蓝图、习题相关小节；资料只有正文、公式、图表和例题，没有习题和答案；出处只认这次给出的片段，其余一律标"待核实"。
- "读完就答"下面的提问、紧挨着独立公式的一句引导语（如"按下式计算："）不陈述事实，不要求出处，也不标"待核实"。
- 阶段设计书的测试蓝图只写考哪些知识点、题型、条件和新题比例，不写具体题目；写给学习者看的文字不出现内部编号。

**资料库 A 做深补充（10-04）：**

- `LibraryImport` 及 `library_imports`、内容指纹映射、上传原件和结果包均由 `library` 持久化。任务状态区分排队、解析、索引、等待恢复、失败、取消和可用；DSH job ID 只用于当前运行，不能作为恢复身份。资料页作为无会话归属任务的 DSH 控制器，不需要老师挂载通用 jobs 工具。
- `learnLibrary` 增加导入任务列表、重试、取消、重解析与页码校正服务。完成后才发 `learning/source-imported` 和课程 handoff；任务变更发 `learning/import-changed`，元数据校正发 `learning/source-updated`，由 core 的 SSE 转发。
- 二进制上传、原 PDF 与阅读器资源也用精确 `/api/learning/library.<方法>`，直接使用 DSH 的认证 Fetch 路由；上传流有 200 MB 上限，原件支持 HTTP Range。普通操作仍使用 core 的 RPC endpoint，不接管 `/api`。
- 有 `Locator.pageSize` 时，`bbox` 是可见 PDF 页左上角起算的点坐标；MinerU 2.0 的归一化坐标在 library 内转换。页码一基，`pageOffset` 只改变书页标签，不改变原文定位；旧解析缺尺寸时降级为页定位。
- `Source.supersedes` 表示重解析的新快照；原 source、chunk ID 和原件继续可访问。相同指纹默认复用最新快照；主动重解析的本课切换快照，其他课程保留旧关联。`problemGroup` 连接跨页题干与答案，教材单元同时排除题目分组和习题章节。启发式分组仍需要原文核对，不宣称覆盖所有题号排版。
- 当前只实现本地 MinerU 4 的 PDF 流程，云解析、其他格式原文阅读、语义检索与语义核实属于后续批次，未作为默认能力。（10-04 更新：云解析与语义检索已实现，见下。）

**资料库 B 与在线服务（10-04）：**

- 解析服务按 `library` 的设置项 `parser` 选择（见下文"设置项"）：`cloud` 用 MinerU 云端（V1 接口，与本机相同），`local` 用本机。超过云端每份页数上限时，一次上传、按页段提交，结果按原页码合并成一份 `docvortex.middle`；`Source.parser.where` 记为 `cloud`。
- `learnLibrary.retrieve(query, { courseId, kinds, limit })` 返回 `Retrieval`：`hits`（`SearchHit` 新增可选 `relevance`，0–1）、`mode`（`hybrid` 或 `fulltext`）、`gap`（资料里没有能直接回答的内容）、`note`（退回全文或索引未建完的原因）。原 `search` 保留为同步的全文检索。
- `learnLibrary.indexState(sourceId)` 返回语义索引状态（`off`/`waiting`/`indexing`/`ready`/`failed`、已完成数、总数、模型）。索引进度变化发 `learning/source-updated`。
- 向量表 `library_vectors(chunk_id, model, vector)` 属于 `library`；`model` 形如 `voyage-4@1024`，不同模型的向量不混查。资料导入完成（`learning/source-imported`）和程序启动时自动补建缺少的向量。
- 新接口：`library.services`（解析位置 `parser`、云端解析是否有密钥 `parserReady`、语义检索开关 `semanticSearch`、语义模型 `embeddings`）、`library.reindex`；`library.search` 改为返回 `Retrieval`。
- 设置项 `semanticSearch` 打开且有 `VOYAGEAI_API_KEY` 时启用语义检索。自动测试固定使用本机解析并关闭语义检索，不会调用付费服务。

**云端分段恢复与前端控件（10-04 接续收尾）：**

- 云端每段结果由 `library` 保存到导入任务目录，只有覆盖全部原 PDF 页且合并验证通过才发布资料。失败段按更小范围补跑；达到自动重试上限后保留成功结果，手动重试仍只补缺页。页段保存与恢复是 library 内部实现，不增加其他单元的数据主人。
- 共享控件从 `@learning-agent/kit/client` 导出，样式由 `shell` 提供。仅复用界面能力，不持有业务数据；页面继续经服务和推送协作。底层语义 HTML 和隐藏文件输入保留，呈现使用统一设计。GPT 接续部分的审美复核记录在 PLAN，来源为用户要求。

**设置项与设置页（10-05，调研见 [docs/settings/research.md](../settings/research.md)）：**

- 学习者可以改的选项是各单元 Config 里加了 `.volatile()` 的字段，经 DSH 的设置服务读写（带版本号，旧版本的写入会被拒绝），保存在已安装 profile 的 `cordis.patch.yml`。单元每次使用时读取当前值，改了不用重启。目前有：`library` 的 `parser`（`cloud` / `local`）、`localParserUrl`、`semanticSearch`；`tutor` 的 `model`；`sidechat` 的 `model`、`summaryModel`、`restrictDuringTests`；`textbook` 的 `model`；`assess` 的 `model`。
- 角色模型字段写作 `厂商/模型`，带 `role: 'learning-model'` 和角色名（`kit/settings` 的 `roleModel`）；没设置时跟随 DSH 的默认模型。会话创建时按角色选模型；角色设置或默认模型变了，正在进行的主老师和侧边提问会话也换过去（`sessionController.selectModel`）。
- 密钥不进 Config：`MINERU_API_KEY`、`VOYAGEAI_API_KEY` 和各模型服务的密钥，每次使用时向 DSH 的密钥服务按名称读取，启动环境优先，其次是设置页保存的。
- 新单元 `settings`（设置页）。前端直接调用 DSH 的 `settings`、`credentials`、`llm`、`session`、`pluginInventory`、`pluginManager` 服务；后端只有两个接口：`settings.about`（学习库位置 `dataRoot`）和 `settings.testModel({ model? })`（用指定模型或默认模型发一次很短的请求，返回耗时 `ms`；截断和空回复也算连通）。
- `library.testService({ service: 'parser' | 'embeddings' })`：解析服务查用量（云端）或健康状态（本机），语义检索嵌入四个字，返回耗时 `ms`；没有 Voyage 密钥时报 `learning/library/no-key`。
- 新插槽 `learning.settings.services`：设置页"资料服务"里的区块，属性 `{ access: SettingsAccess }`（读写设置、查看和保存密钥）。`library` 在这里放解析方式、本机地址、密钥和语义检索开关。
- `ActivityItem.placement`：`'nav'`（默认，侧栏页面列表）或 `'foot'`（侧栏底部，和"外观"并排）。设置页用 `'foot'`。
- 模型服务：DeepSeek 用 DSH 的 `llm-deepseek`（密钥、接口地址）；其他厂商和兼容接口写进 DSH `llm-pi-ai` 的 `providers`，密钥名按 DSH 的约定（`minimax-cn` → `MINIMAX_CN_API_KEY`），和 DSH 自己的模型页一致。
- 插件清单只读：列出组合包 `@learning-agent/app` 的单元（图标、名称、说明、运行状态、哪些角色用它的工具），学习单元都是必需的，不能单独关掉；DSH 自己的组件折叠显示。


**资料库 C：联网找权威资料（10-07，调研见 [docs/library/research.md](../library/research.md)）：**

- `Source.origin` 为 `web` 时多一个 `format`：`html`（存成 Markdown 的网页，没有页码，片段都在"第 1 页"、按顺序编号，出处标签只有书名号里的标题）或 `pdf`（和上传的一样经 MinerU 解析，出处带页码）。网上 PDF 的 `LibraryImport.url` 记原网址，完成后的资料据此写成网页来源。网页资料的 `kind` 是 `web`；网上 PDF 按网站规则记为 `paper`、`standard` 或 `other`。
- 新数据：`WebCandidate`（一条搜索结果：网址、标题、摘要、网站、机构即注册域名、权威级别和理由、格式、搜索服务、发布日期、对应的问题）、`WebPending`（老师提出、等学习者确认的三级资料，带老师的理由）、`SiteRule`（学习者给某个网站设的级别，可以是 `blocked`；覆盖内置规则，子域名一起生效）。
- `learnLibrary.searchWeb(questions, { signal })` → `WebSearch`（`candidates` 一到三级、每个机构最多两条；`clues` 只当线索；`notes` 换过搜索服务等说明）。`learnLibrary.addWeb(courseId, items, by, signal)` → 每个网址一条 `WebAdded`（`added` / `importing` / `pending` / `rejected` / `failed`，附说明）。级别一律在 `library` 里按网站规则重新判断，不采信调用方给的。
- 工具 `search_web`、`add_web_sources` 属于 `@learning-agent/library/tools`，只有主老师挂；侧边会话不挂。主老师不挂 DSH 自带的 `web_search`、`web_fetch`。
- 新接口：`library.webSearch`、`library.addWeb`（学习者加入，三级不再等确认）、`library.webPending`、`library.confirmWeb`、`library.dismissWeb`、`library.siteRules`、`library.setSiteRule`（不给级别就删掉这条规则）、`library.detach`（资料移出本课，资料和已有出处都保留）。`library.services` 多一个 `webSearch`（有密钥的搜索服务，按使用顺序）；`library.document` 对网页资料多返回 `chunks`；`library.testService` 的 `service` 多了 `exa`、`bocha`、`tavily`（真实搜一次课程主题）。
- 新事件 `learning/web-changed`（`{ courseId }`）：待确认的网上资料有增减；经推送通道发给页面。学习者在页面上加入或确认网上资料后，`library` 发 `learning/handoff`；网上 PDF 解析完沿用导入完成的 handoff。
- 新表：`library_web`（网址 → 资料或导入任务，同一网址不重复抓）、`library_web_pending`、`library_site_rules`。
- 设置项 `searchProvider`（`exa` / `bocha` / `tavily`，默认 `exa`）：首选搜索服务，其余按 Exa → 博查 → Tavily 接替。密钥 `EXA_API_KEY`、`BOCHA_API_KEY`、`TAVILY_API_KEY` 按名称向 DSH 的密钥服务读取。
- 主老师的简报只列导入的资料，网上资料只写份数和待确认的份数。
- 页面接口的输入校验失败时（`learning/invalid-input`），`message` 是各条校验说明连起来的一句话，原始的校验结果在 `details.issues`。

**knowledge A：知识身份、关系与操作组（10-07，按已确认方向细化）：**

- `KnowledgeNode` 带 `domain`、`conditions`、`status`（活动 / 停用）、`version` 和 `legacy`。同名不决定身份，`NewNode.reuseId` 明确复用；老师只可复用本课活动身份，跨课复用由学习者选择。修改类型或所指能力须建立新身份，合并及 `replacedBy` 留给 C 批。
- `KnowledgeEdge` 带 `scope`（全局、课程或本课任务）、`conditions`、`status`（`draft` / `valid` / `disputed` / `legacy` / `inactive`）与 `version`。新关系默认本课草案；骨架关系迁移为全局遗留待复核。`requires` 的起点需要终点；相关关系按无序端点去重。有效关系须有理由、可引用的就绪片段；课程或任务关系的资料还须关联本课。硬先修与组成按全局、课程、单个任务的实际组合检查环。
- `CourseNode` 和 `NodeLink` 带活动状态与版本，课程成员还保留排序。退出课程不删除全局身份；停用、撤销与升级不改任何证据日志。来源目标经其主人服务检查，knowledge 不复制题目或教材正文，测试预留题的题干与答案不展示。
- `KnowledgeOperation`（`op_` + ULID）由 knowledge 持有：课程、操作者、理由、时间、组内变更及撤销关系。`add.requestId` 对同课同内容的重试去重，内容不同报冲突，旧调用可不传；老师工具与页面传入。批量修改与日志同事务，失败无半份结果。有实际变化时 `CourseGraph.operationId` 指向该组，没有变化时不记操作组、也不带 `operationId`；重试有 `replayed` 标记，不重复 handoff。老师（`actor: 'teacher'`）新建的节点不能与本课已有节点的名称或别名相同（`learning/knowledge/same-name`）。
- `Change` 的目标补课程成员 `course-node`、来源连线 `node-link`（复合键），并可带 `courseId` 与 `operationId`；前后内容保留完整 JSON。`learnCore.changes.list` 可按操作组过滤，`get` 读单条。结构的回退由 knowledge 执行，core 的 `revert` 仍只负责它自己的文件。
- `learnKnowledge` 增加候选查找、节点与关系修订、成员调整、停用来源、操作历史与影响、整组撤销、详情及有效先修查询。修订提交读取时的版本；撤销先核对组内所有对象仍是该组的结果，再追加逆向操作，创建对象以停用代替删除；恢复关系重新检查出处与环。
- 精确路由为 `/api/learning/knowledge.<方法>`：`graph`、`candidates`、`detail`、`history`、`operation`、`add`、`editNode`、`editEdge`、`setMembership`、`link`、`unlink`、`revert`。图与详情附当前 `usable` / `issue`；操作影响附名称和出处显示表。页面实际完成操作后发一句中文 `learning/handoff`，老师服务调用不发。
- 主老师工具为 `find_knowledge_nodes`、`get_knowledge_node`、`add_knowledge_nodes`、`revise_knowledge_node`、`revise_knowledge_edge`。查找、详情与添加结果最多 5000 字符，详细原文用 `read_section`，完整结构可在知识模型查看；简报最多列 40 个节点。
- 界面仍采用类型列表，新增详情、添加与操作历史页；任务限定关系创建、课程角色及考试范围调整的页面入口待补。B 图谱、C 合并与受控抽取尚未实现；这些没有作为已完成的跨单元接口。

**knowledge B：图谱的读取接口（10-07，Claude）：**

- `knowledge.global`（`LearnKnowledge.global()`）返回所有课程的活动节点（带所属课程 `courseIds`）、关系和课程名。课程或任务限定的关系，只在两端都属于那门课时出现，和课程页一致。
- `knowledge.sources`（`sourceLayer(courseId?)`）把节点的出处按资料汇总：每份资料列出它讲解的节点和片段出处；教材段落按课程汇总成节点列表。只收可引用的资料，题目不放进来，测试预留题不会出现。
- `learner.evidence`（`LearnLearner.evidence(nodeId, limit?)`）把这个节点的证据日志写成 `EvidenceRecord`：时间、做了什么、结果、作答条件、所在测试，以及当前状态是否引用了它。只读，不写日志。
- 知识模型页在主界面和课程里都出现（侧栏入口的 `scope` 改为 `both`）；`knowledge.detail` 页面接受 `courseId` 参数，从主界面打开节点时带上节点所属的课程。
- 图谱的布局、筛选、着色方式记在浏览器本机（界面偏好），不进数据库。

**knowledge C：合并与按小节抽取（10-08，Claude）：**

- **合并：** `KnowledgeNode.replacedBy` 接线：合并后被合并的节点停用并指向保留的节点，旧编号仍能读详情。`learnKnowledge.identity(nodeId)` 返回它现在指向的节点（`current`）和合并进它的全部节点（`merged`，多次合并也算）。`mergeSuggestions(courseId?)`、`mergePlan(keepId, mergeId)`、`merge(...)`、`keepSeparate(...)`、`proposeMerge(...)` 由 knowledge 提供；合并要带比较时两边的版本，类型不同或会形成先修、组成循环时拒绝。"不是同一项"和老师的建议记在 knowledge 自己的表里，不进变更日志。
- **跨课程的操作组：** `KnowledgeOperation` 可带 `courseIds`（涉及的全部课程）和 `merge`（保留与被合并的节点）；这样的操作组出现在每门相关课程的变更记录里，`knowledge.operation`、`knowledge.revert` 在其中任何一门课里都能用。撤销合并时记为"不是同一项"。
- **事件：** `learning/identity-changed { nodeIds }`：合并或撤销合并提交后发出，learner 据此重算；`learning/extraction-changed`（抽取任务的状态）列入变更推送，页面据此刷新。
- **learner：** `NodeState` 增加 `courses`（`CourseState[]`，每门有作答的课程一份），规则版本 `skeleton-3`；`EvidenceRecord.node` 写出被合并节点的名称。learner 通过 `identity()` 读合并进来的记录，不改日志。
- **assess：** 主老师按节点组卷时，把 `identity().merged` 一起传给 `startTest`，旧节点的题仍能选到。
- **按小节抽取：** `KnowledgeExtraction`（`kx_` + ULID）由 knowledge 持有，记录课程、资料、小节、片段指纹、状态、结果和对应的操作组。`extract(courseId, sections, by, sourceId?)` 返回每节的结果（已开始、进行中、已抽过、找不到、太长）；`extractions(courseId, sourceId?)` 返回资料目录和每节最近的任务；`cancelExtraction(id)`。任务经 DSH jobs 运行（单元测试里直接运行），同时最多两个；重启后继续，已写入的操作组按 `extract:<任务编号>` 找回，不再调用模型。knowledge 增加设置项 `model`（"知识抽取"模型，`roleModel`）。
- **路由：** `/api/learning/knowledge.` 加 `mergeSuggestions`、`mergePlan`、`merge`、`keepSeparate`、`extractions`、`extract`、`cancelExtraction`。页面合并、撤销合并时给每门相关课程发一句 `learning/handoff`；抽取任务结束（成功或失败）由 knowledge 发 handoff，开始时不发。
- **老师工具：** 增加 `extract_knowledge_sections`、`suggest_knowledge_merge`。老师写的合并理由会原样给学习者看，带内部编号时拒绝（`learning/knowledge/internal-id`）。

**goal A：事实来源、按版本修订、测试条件（10-08，Claude）：**

- **目标说明的字段：** `GoalFrontmatter` 增加 `version`（每写一次加一；旧文件按已有写入次数补）和 `facts`（`GoalFact` → `FactSource { basis: official | learner | assumed, chunkId? }`，只存官方和学习者的，没有记录的事实算老师推测）。`canDo` 由字符串改为 `CanDo { key, text, evidence? }`，旧文件的纯文字条目按顺序编键 `c1`、`c2`……；新条目的键不复用任何版本用过的键。`boundaries.hoursPerWeek { min, max }`。
- **考试档案：** `ExamProfile.format` 由一段文字改为 `ExamItem { type, points?, note? }[]`；增加 `sections`（骨架教材的小节号）和 `grading`（成绩构成）。之前没有任何目标写入过考试档案（工具没有这个参数），所以不做迁移。
- **事实：** `GoalFact` 是 `conditions`、`hours`、`deadline`、`exam.date`、`exam.scope`、`exam.format`、`exam.grading`、`exam.conditions`。官方事实的片段必须属于本课的资料。
- **服务：** `learnGoal.saveDraft` 收 `GoalDraft`，返回 `GoalSaved { doc, warnings }`；增加 `view`（页面用：事实及来源、和学习者上次确认或修改时相比的差异与影响、版本记录、往年题名称）、`revise(courseId, version, patch, meta)`、`setFacts(courseId, version, edit)`（学习者的修改，状态不变，发 handoff）、`acknowledge`（学习者看过老师的修改）、`conditions(courseId, kind)`。老师的写入先经程序检查，不通过时报 `learning/goal/check`；版本不对报 `learning/goal/stale`。
- **状态规则：** 已确认的目标改了选择（目的、场景、能做、程度、验证方式、不学、考试侧重、正文）回到草稿，只改事实保持确认。
- **路由：** `/api/learning/goal.` 加 `view`、`setFacts`、`acknowledge`。
- **assess：** `start_test` 不写开闭卷时，条件取 `learnGoal.conditions`：阶段测试和模拟考用考试档案的条件（只有模拟考带考试时长），其他用默认条件。
- **老师工具：** `save_goal_draft` 增加 `exam`、`facts`，`canDo` 改为对象；增加 `revise_goal`。

**goal B、C：候选终点卡片、资料清单、考试档案接到各环节（10-08，Claude）：**

- **资料清单：** `GoalFrontmatter.sources`（`SourceNeed { key s1…, what, why, role, by: learner | teacher, sourceId?, missing? }`）。老师在 `save_goal_draft`、`revise_goal` 的 `sources` 里写完整列表，同名条目保留对应的资料和"没有"；新条目的键不复用。`learnGoal.setSource(courseId, version, key, { sourceId?, missing? })` 是学习者的回答（状态不变，发 handoff）；往年题对应上资料后自动记入 `exam.pastPaperSourceIds`，取消对应时移出。`GoalView` 增加 `sources`（带状态 have / wanted / teacher / missing）和 `courseSources`。路由加 `goal.setSource`。
- **候选终点卡片：** 老师工具 `offer_goal_options`（2–4 个候选终点，样题片段须属于本课资料，不写内部编号）。客户端插槽 `learning.chat-card`（keyed，按工具名，`ChatCardProps { args, reply?, send, fill }`），主老师页声明它并传给 `Chat`；`kit` 的对话组件只在工具调用成功后显示卡片。卡片不另存数据。
- **考试范围：** `CourseNode.exam` 和 `KnowledgeMembershipPatch.exam` 用 `ExamScope`：`in-scope`、`beyond`（范围外但有助理解）、`out-of-scope`。`learnKnowledge.markExamScope(courseId, { sections?, nodes? }, meta)` 返回 `ExamScopeResult { operationId?, counts, untagged }`；老师工具 `mark_exam_scope`。
- **阶段对应目标条目：** `Stage.supports`（目标"能做"的键）。`saveRoadmap` 的阶段和 `saveDesign` 的输入可带 `supports`，不存在的键报 `learning/curriculum/unknown-goal-item`；curriculum 因此注入 `learnGoal`。
- **倒计时：** `NextStep.countdown?: Countdown { label: 考试 | 期限, date, days, stagesDone, stagesTotal }`，取考试日期和期限中较早的。

**assess A：题库可信（10-08，Claude）：**

- **答案：** `Answer` 增加 `parts`（`AnswerPart { label, answer: SingleAnswer }[]`，至少两问，每问是数值、选择、表达式或开放题，各自判分）。`Grading` 增加可选的 `parts`（每问的判定、得分和理由）；多问的题全对才是"对"，有一问待复核整题待复核，其余为"部分对"，得分取平均。
- **题目：** `Problem` 增加 `ref`（教材题号，如 `1-25`）、`sourceKey`（`<资料 ID>#<题号>`，同一个键只能有一道未停用的题）、`figures`（附图片段 ID）、`size`（`check` 短题 / `standard` / `task` 完整任务题，默认 `standard`）、`calculation`（计算工具的过程、结果变量、逐行结果和时间）、`review`（暂停使用的原因）。入库检查：测试预留题的答案不能是 `unverified`；`calculated` 要有计算过程；改编题（tier 3）要有 `adaptedFrom`，数值改编题的答案必须是 `calculated`；同一出处（`sourceKey`，或不是改编题时的同一出处片段）只入库一次，重复时报 `learning/assess/duplicate`。组卷遇到停用或答案存疑的题报 `learning/assess/not-active`。
- **作答：** `Attempt.finals`（每个答案栏写的最终答案）。数值和选择题只按答案栏判，`text` 是解题过程。`TestView.problems` 增加 `inputs: AnswerInput { label, kind, options? }[]`（作答中不含答案和计算过程）；`submit` 的答案增加 `finals`。没有答案栏的旧作答，单问的题从 `text` 里读数。
- **服务：** `learnAssess.importExercises(courseId, ExerciseImport[])` 按题号从本课资料的习题小节取题干、附图和书后答案（返回 added / existing / updated / failed）；`calculate(script, results?)`；`checkAnswer(problemId, script, results, apply?)`（不一致时题目暂停使用，`apply` 改用算出的答案）；`homework`、`markHomework(courseId, refs, done, by?)`（学习者自己标记时发 handoff，老师记录时不发）；`bank(courseId, nodeIds)`（按节点的数量，不含测试预留题的题干）。`problems` 的过滤增加 `includeReview`。assess 服务注入 `learnLibrary`。
- **数据库：** assess 迁移 2：`assess_problems.source_key` 列和索引、`assess_homework (course_id, ref, at)`；同一出处片段、同一题干存了两份的题，保留有作答记录的那份（都没有时保留较早的），其余停用。
- **路由：** `/api/learning/assess.` 加 `bank`、`markHomework`。
- **老师工具：** 增加 `import_exercises`、`calculate`、`mark_homework`；`add_problems` 只加教材习题以外的题（tier 2–4），增加 `calculation`、`adaptedFrom`、`size`；`start_test` 的题目可以写教材题号。
- **客户端插槽：** `learning.figure`（single，`{ chunkId }`），由 library 注册，测试页声明并用它显示附图。

**assess B：测试按规则组（10-08，Claude）：**

- **测试种类：** `TestKind` 增加 `pretest`（阶段前测）；种类的中文名统一放在契约的 `TEST_KIND_LABEL`。
- **测试：** `Test` 增加可选的 `scope`（摸底和前测：`ProbeNode { id, title, requires, also }[]`、是否逐题出、最多几题）和 `plan`（阶段测试：核心知识点、前面阶段的知识点、开考时是新题的题目、完整任务题、没有新题的核心知识点、本阶段对应的目标条目）。知识点在开考时按知识图记下（标题、先修关系、合并进来的旧节点），assess 据此出题和给结果，不依赖 knowledge（knowledge 依赖 assess）。换题上限：摸底和前测 0，小测、练习、复查 1，阶段测试和模拟考 2。
- **作答与判分：** `Attempt.gaveUp`（点了"不会"）；`Grading.method` 增加 `teacher`（老师复核），"不会"记为 `learner`、判错。作答中的 `TestView.attempts` 不带判分。
- **报告和申诉：** 新的数据对象 `ProblemReport`（`rp_`：原因五选一、说明、换上的题、老师核对的结果 keep / fixed / retired 和说明）和 `Appeal`（`ap_`：作答、理由、老师复核的结论、是否改判、说明）；`REPORT_REASON_LABEL` 放中文名。
- **视图：** `TestView` 增加 `reports`、`appeals`，判分后摸底和前测带 `diagnosis`（每个知识点：known / boundary / not-yet / inferred / unprobed），阶段测试带 `stageReport`（每个核心知识点：pass / fail / mixed / pending / insufficient 和题号，完整任务题、前面阶段的题、目标条目）。
- **服务：** `startTest` 增加 `scope`（不给题目时逐题出）和 `blueprint`（阶段测试不给题目时按规则组卷）；新增 `answer`（逐题出的测试答当前一题）、`finish`（提前结束）、`report`、`reviewProblem`、`appeal`（每道题一次）、`regrade`（改判追加 `attempt.regraded`，原记录保留；结论不变只回复申诉）、`queue`（待老师处理的报告、申诉和待复核）、`coverage`（核心知识点在完整任务题之外的新题数，有没有完整任务题）。`SubmittedAnswer.gaveUp`。
- **课程：** `Stage.nodeIds`（本阶段的核心知识点），`saveDesign` 增加 `nodeIds`；发布阶段测试的任务后阶段变为 `testing`，阶段测试判分后变为 `reviewing`。
- **数据库：** assess 迁移 3：`assess_reports`、`assess_appeals`（`resolved` 列标出老师处理过的；"这题我做过"不用处理）。
- **路由：** `/api/learning/assess.` 加 `answer`、`finish`、`report`、`appeal`。
- **老师工具：** 新增 `review_problem`、`regrade`；`start_test` 增加 `pretest`，摸底和前测按 `nodes` 逐题出，阶段测试不给题目时按核心知识点组卷；`add_problems` 增加 `parts`（分几问的数值题，每问的答案由同一段计算过程算出）；`save_stage_design` 增加 `nodes`；`get_test_result` 给出按知识点的结果、报告和申诉。

**assess C：拍照作答、往年题和模拟考（10-09，Claude）：**

- **题目：** `Problem` 增加可选的 `type`（题型，如"计算题"，模拟考按它组卷）、`points`（试卷上的分值）、`paper`（往年题的试卷名）。
- **测试：** `Test` 增加 `mock`（`MockPaper`：考试范围内的知识点，每种题型的题数、总分和选中的题）、`openedAt`（限时测试点"开始"的时刻，题目从这时显示、计时从这时算）、`overtime`（超时几分钟交卷）。`TestView` 增加 `mockReport`（每种题型的得分、待复核和缺的题数，总分，答错的知识点，用时）、`drafts`（进行中测试保存的作答）、`deadline`（开始后的截止时刻）。
- **作答：** `Transcription.edited` 的含义定为"和第一次识别不同"（解题过程或任何一个答案栏）；新增 `Recognition`（一次识别：解题过程、各答案栏、没把握的地方）。进行中的作答是 `AnswerDraft`（答案栏、过程、"不会"、照片、两次识别和差异、学习者核对的识别结果），页面用 `DraftInput` 保存。
- **服务：** `LearnAssess` 增加 `saveDraft`、`addPhoto`、`removePhoto`、`transcribe`（识别两次，比较差异）、`begin`、`withdraw`（撤回没人作答的测试）、`mockCoverage`。`StartTestInput` 增加 `mock`（题型和考试范围的知识点）；`ExerciseImport` 增加 `type` 和 `answerText`（按书后答案的写法读，选择题按字母对应选项）。`submit` 对页面没带上的题用保存的作答；有照片而识别结果没确认的题不能交卷，限时测试到时间后这道题判"待复核"。
- **数据库：** assess 迁移 4：`assess_drafts`（测试、题目、作答），交卷或撤回后删除。
- **路由：** `/api/learning/assess.` 加 `draft`、`removePhoto`、`transcribe`、`begin`；照片走两个精确路由：`assess.upload`（POST，流式，8 MB 以内）和 `assess.photo`（GET）。DSH 的流式请求体只用于 POST，GET 要用缓冲模式，所以分成两个（和 library 的上传、原文一样）。
- **文件：** 照片存在课程文件夹的 `attachments/tests/<测试>/`，由 assess 管理。
- **其他单元：** `ExamItem` 增加 `count`（题数），goal 的考试档案工具可以写；`LearnLibrary` 增加 `chunks(sourceId)`（按顺序读一份资料的全部片段，往年试卷整份读）；kit 的 `complete()` 增加 `images`（放在用户消息里，模型目录明确说不能看图时报错），新增共享控件 `PickButton`。
- **老师工具：** 新增 `withdraw_test`；`start_test` 增加 `mock` 和 `sections`、`minutes`；`import_exercises` 增加 `source`、`type`，题号可以写"三-2"；`add_problems` 增加 `type`。

**curriculum A：复盘决定下一步、调整路线（10-09，Claude）：**

- **阶段：** `Stage` 增加 `remedialOf`（补课阶段跟在哪个阶段的复盘后面）和 `review`（`StageReview`：阶段测试、每个核心知识点的结果"过了 / 没过 / 待验证"、完整任务题的结果、老师的建议和理由、补课阶段的标题目标和知识点、保存时间、你的选择和时间）。新增 `ReviewChoice`（`next`、`remedial`）、`ReviewResult`。
- **路线调整：** 新增 `RoadmapRevision`（还没开始的阶段的新草稿、它替换的阶段、理由、时间），一门课最多一份，存在 curriculum 迁移 2 的 `curriculum_revisions` 表。
- **服务：** `saveRoadmap` 的参数是 `StageDraft[]`，只写计划中的普通阶段（前面固定的阶段保持原样），返回 `RoadmapResult`（`stages`，以及路线开始后存为待确认时的 `revision`）；`ChangeMeta.reason` 是调整的理由。新增 `revision`、`decideRevision`（你确认或放弃）、`saveReview`、`decideReview`、`carried`（以前复盘带过来的风险和待验证知识点）。
- **复盘事实：** `StageReviewFacts`、`ReviewNodeFacts`、`CarriedNode` 是 curriculum 工具插件读 assess、learner、knowledge 后算出来的，给老师的简报和 `save_stage_review` 用。curriculum 的服务本身不注入这几个单元（knowledge 注入了 curriculum）。
- **文件：** `stages/<阶段>/review.md`：frontmatter 写阶段、测试、状态（saved / decided）和你的选择；正文是程序写的结果表、老师的复盘、你的决定。
- **路由：** `/api/learning/curriculum.` 加 `review`（读复盘正文）、`decideReview`、`decideRevision`；`overview` 返回 `revision`。
- **事件：** 新增 `learning/roadmap-revised`（路线调整提交、确认或放弃，推给页面刷新）；你决定复盘、确认或放弃路线调整时发 `learning/handoff`。
- **老师工具：** 新增 `save_stage_review`；`save_roadmap` 加 `reason`，只写计划中的阶段。
- **其他单元：** assess 组阶段测试时，前面阶段的知识点按 `carried` 排在前面，补课阶段不出前面阶段的题；planner 加"阶段 N 的复盘""决定阶段 N 之后怎么走""看看路线调整"三步，补课阶段不做前测。

**curriculum B：补课单元（10-09，Claude）：**

- `ReviewNodeFacts` 增加 `prerequisites`（它直接要求的知识点和掌握状态）。
- 不新增服务和路由：补课阶段的设计简报、补课课时的写法、重测的备题提示都在各单元内部按 `Stage.kind`、`Stage.remedialOf` 和上一阶段的 `review` 判断。

**curriculum C：结课（10-09，Claude）：**

- **测试：** `TestKind` 增加 `final`（结课检验）。`Test.final` 是 `FinalPlan`：每条"能做"的键、文字、知识点和选上的题，以前复盘带过来的知识点，测不到的条目，发布时的阶段（`stageIds`）。`StartTestInput.final` 是组卷的输入；`TestView.finalReport` 是 `FinalReport`（每条的结果和题号、带过来的知识点的对错、测不到的条目）。新增 `currentFinal`：最新一份没撤回、包括当前所有阶段的结课检验，planner、curriculum 和 assess 都按它判断。
- **课程报告：** 新增 `ReportItem`、`CourseReportFacts`，由 curriculum 工具插件读 goal、assess、learner 算出，给简报和 `save_course_report` 用。`LearnCurriculum` 增加 `saveReport`、`report`。文件 `report.md`：frontmatter 写课程、结课检验、每条的键、文字、结果和还缺的知识点、写作时间；正文是程序写的表和老师的报告。
- **core：** `courses.setStatus`；新事件 `learning/course-updated`（也推给页面）。
- **路由：** `/api/learning/curriculum.report`（报告的条目、课程是否已结课、正文）。
- **老师工具：** 新增 `save_course_report`；`start_test` 的 `kind` 加 `final`。
- **其他单元：** goal 的测试条件对结课检验也按考试档案；planner 加"发布结课检验""做结课检验""写课程报告""已结课"；assess 的简报在所有阶段完成后提示结课检验备题不够的条目。
- **规则修改：** `carried` 在完整任务题没过、你选往前走时，把待验证的知识点也记为风险。

**textbook A：生成与恢复（10-09，Claude）：**

- **core：** `files.write` 增加第五个参数 `WriteOptions`（`ifHash`：文件当前的内容指纹不是它就不写，抛 `learning/core/conflict`；`null` 表示只在文件不存在时写）。
- **生成记录：** textbook 迁移 2 的 `textbook_runs` 表，一个课时一行：排队、进行中、成功、失败，失败原因，连续失败次数，已写完的模型回复（按输入的指纹存，发布后清空），没讲到的知识点。`LessonTextbookStatus` 从这张表读，排队也算 `running`；新增 `uncovered`（出处落在本课资料里、没有段落挂上的知识点标题）。
- **教材文件：** frontmatter 增加 `run`（这次生成的编号，重启后用来认出已经发布的版本）。
- **块与知识点：** 只在本课的候选知识点里挂：阶段的核心知识点，加上出处落在本课资料或本文件所引片段里的知识点。段落引用了某个知识点的出处片段，或点名了它（标题或别名，课程内没有重名，至少两个字），就挂上。
- **公式：** 独立公式的块索引沿用紧跟其后的解释段的出处和待核实标记。（10-15 起公式多以原文框放入，不再补"上式没有找到出处"。）
- 不新增服务、路由和事件。

**textbook B：逐句核对（10-09，Claude）：** 10-15 起被下文"教材 D"取代；仍然成立的只有 `sourceGroup`、`checkModel`、`purpose: 'learning-textbook-check'`，`webCheck` 改为写教材时联网补讲（设置页"教材 › 联网补充讲解"）。

- **library：** `LearnLibrary.sourceGroup(sourceId)`：不独立的资料返回同一个组（网上资料 `site:<注册域名>`；上传资料 `work:<去掉版次和标点的书名>`）。
- **textbook 的设置：** `checkModel`（模型角色"核对教材"）、`webCheck`（核对时联网补充出处，默认开，设置页"资料服务"里的"教材核对"）。
- **核对结果：** textbook 迁移 3 的 `textbook_checks` 表，一个段落一行：段落的内容指纹，每句的文字、判断（supported / partial / contradicted / missing / unchecked）、是否关键事实、是否照录例题、证据（片段和摘录）、支持它的来源组、原因。生成记录增加 `checked`、`notes` 和发布前暂存的 `pending`。
- **状态：** `LessonTextbookStatus.check`：`state`（checked / unchecked）、`single`（关键事实只有一个来源的段落数）、`stale`（核对后改过的段落数）、`notes`。
- **教材文件：** 核对会给段落补出处链接、加或去掉 `[待核实](cite:unverified)`，公式后面的说明可能改成"上式出自……"或补"上式没有在所引原文里找到依据"；格式本身不变。
- **模型调用：** 核对用 `purpose: 'learning-textbook-check'`，回复是 JSON（`parseJsonReply`）。
- **联网：** 核对时以主老师身份（`addWeb(…, 'teacher')`）加入二级以上的网页，加入的资料出现在本课资料库里。

**textbook C：详略与局部修订（10-10，Claude）：**

- **服务：** `LearnTextbook.reviseBlocks(lessonId, { blockIds, instruction }, meta)` 改一节里的 1 到 8 段，返回 `RevisionResult`（改写、多出、删去的段数，仍待核实的原因，说明）。错误码：`learning/textbook/too-many`（段数不对）、`no-block`（本节没有这个段落）、`busy`（正在生成）、`missing`（还没有教材）；改的期间文件被别处改过仍是 `learning/core/conflict`。`LearnTextbook.revisions(courseId, blockId)` 返回一个段落的去向 `BlockRevision[]`：变成了哪些段落（保留时自己排第一，删掉时为空）、变更记录 ID、原因。
- **修订记录：** textbook 迁移 4 的 `textbook_revisions` 表：局部修订改过的段落、重新生成时没保留下来的段落，各记一行。
- **接口：** `textbook.checks`（`{ lessonId }`）：阅读页用的每段核对结果，按块 ID：`state`（ok / single / unsupported / stale）、每句的结论文字、语气、原因、摘录（`chunkId` 只用来打开原文）、最近一次修订的原因。
- **工具：** 主老师的 `revise_textbook`（`lessonId`、`blocks`、`instruction`）。
- **依赖：** textbook 注入 `learnLearner`，读掌握状态定详略。
- **块索引：** "读完就答"下的提问不挂知识点。
- **前端：** `MarkdownProps` 增加 `blockClass`（给某块加类名，`is-marked` 显示淡色竖线）和 `afterBlock`（在某块后面插入内容）；`kit` 的 `Tag` 增加 `onClick`、`pressed`，传了 `onClick` 就是一个开关按钮（`aria-pressed`）。
- 不新增事件。

**tutor A/B：接课与课堂记录（10-10，Claude）：**

- **服务：** `LearnTutor.writeLessonSummary(lessonId, { summary, learnerReport, sessionId? }, meta)`：`learnerReport` 改为必填；本课时没有小测、小测没交卷、判分没定时拒绝（`learning/tutor/no-quiz`、`quiz-open`、`quiz-unsettled`），汇报为空是 `no-report`；带 `sessionId` 时，课时要属于那个会话的课程（`other-course`），汇报每行要能在那个会话里学习者说过的话中逐字找到（`report-not-learner`）。课时记录的正文改为：小测逐题结果、本课时记下的帮助、写小结时的掌握状态、汇报、小结，不写内部编号。
- **证据日志：** `signal.self-report` 增加可选的 `text`（学习者原话）。主老师的课堂记录写 `help.given`（`via: teacher`，`at` 取老师那条回复的时间，`context` 带会话、阶段、当前课时，针对某道题或没交卷测试考的知识点时带题和测试）、`signal.self-report`、`signal.question`、`signal.misconception`（`at` 取学习者那句话的时间）。
- **表：** tutor 迁移 1 的 `tutor_notices`（收到的进度通知和送达情况），迁移 2 的 `tutor_ledger`（每个老师会话整理到哪条事件）。
- **会话消息来源：** 简报（`learning-course-brief`）的来源增加 `step`（写简报时的下一步）；新增 `learning-next-step`（一轮中途的【下一步更新】）。tutor 注册 DSH 会话投影 `learningBrief`。
- **简报：** tutor 自己加一节"课堂"（`unit: 'tutor'`，排在"下一步"后面）：没交卷的测试和规则、学习者说会了还没验证的知识点。
- **设置：** tutor 增加模型角色"课堂记录"（`ledgerModel`）。
- **kit：** 新增 `sessionLines()`（按顺序读一个会话的消息：学习者、助手、系统加的上下文）和 `messageText()`；sidechat 改用它们。对话页只把来源为学习者本人的消息显示成学习者的话。
- **依赖：** tutor 注入 `learnKnowledge`、`learnTextbook`、`learnLearner`、`llm`、`sessionProjections`。
- 不新增事件。
**批注与侧边会话做深的接口补充（10-10，annotation + sidechat A 批）：**

| 补充 | 说明 |
|---|---|
| `Annotation` 增加 `courseId`、`updatedAt`、`location`、`hiddenAt` | `location`（`AnnotationLocation`）是由锚点和当前正文推算出的位置状态：`anchored`（已找到）/ `needs-confirmation`（多处匹配或原句被改过，等学习者确认）/ `original-only`（段落或原句已经没有，只留批注和原句）。可以重算，不是证据 |
| 块锚点增加 `hash` | 创建批注时 `Block.hash`，由服务端写入，不信任页面传来的值。资料片段锚点增加可选的 `courseId` |
| 新服务 `learnAnnotation`（`annotation`） | `create`（带 `requestId` 时幂等）、`get`、`list`（先按当前正文核对位置）、`edit`、`setResolved`、`setHidden`、`confirmLocation`、`sideChatSelection`、`linkSideChat`、`submitError`。批注只是信号：只有"疑问"且所在段落有知识点时追加一条 `signal.question`（`ref` 为 `annotation:<批注 ID>`，每条批注最多一次），编辑、隐藏、处理不改日志。"报错"位置确定时自动生成 `source: 'annotation'` 的提案，目标是该段所在的课时文件；位置不确定或是资料片段时拒绝，不猜目标 |
| 新事件 `learning/annotation-changed` | `annotation` 在用户新建、编辑、处理、隐藏、确认位置、转会话或提交提案后发出（带 `courseId`、`annotationId`），经 core 推送给页面。重算位置时不发，避免页面循环刷新 |
| 批注转侧边会话 | 选区是 `page: 'annotation'`、`selected.kind: 'text'`、`selected.id` 为批注 ID；`annotation` 用 `learning/describe-selection` 补上批注内容、原句和位置状态。同一批注的会话还开着时再次提问回到它，关闭后才开新的 |
| 批注的页面接口 | 页面调用 `annotation.create / list / edit / resolve / hide / confirm / submitError / ask`，对应服务的同名方法；`ask` 返回 `{ sessionId, reused, question }`，会话是新开的（`reused` 为假）时由页面把 `question` 作为第一条消息发出。另有两个只给页面用、不在 `learnAnnotation` 里的接口：`annotation.places`（课程里每条批注在哪读：课时或资料片段）、`annotation.candidates`（位置不确定的批注在拆段后可能属于哪几段，供学习者选一段确认） |
| 教材选区带真实范围 | `MarkdownProps.onBlock(blockId, text, quote?)` 增加第三个参数：学习者在段落里选中的文字，写成 Markdown 源码（公式整条取 `$…$`，引用标签不计入）并带前后各约 24 字，没有选区时不传。教材阅读器据此设置 `Selection.selected.quote`（`kind: 'block'`），没有选区时不带 `quote` |
| 新插槽 `learning.reader-notes` | `single`，owner 是 `ReaderNotesProps`：`part: 'actions'`（"就这段提问"旁的批注菜单）和 `part: 'notes'`（段落下的批注和写批注的框），均带 `courseId`、`blockId`。教材阅读器是宿主，`annotation` 的页面填充；没有 `annotation` 时为空 |
| `learnSidechat.checkTool(sessionId, tool)` | 判断这个会话现在能不能用某个工具：不是侧边会话一律放行；侧边会话只能用 `search_library`、`read_section`，且课程有进行中的测试（`learnAssess.tests` 里 `status` 为 `open`）时一个也不能用。工具在执行开头调用，抛出的原因返回给模型。测试期间的限制由 `sidechat` 的配置项 `restrictDuringTests`（默认开）控制 |
| `learnSidechat.close` 可重复调用 | 同一会话只有一份总结、一条笔记、一组日志，上一次停在哪一步就从哪一步接着做；已存总结但会话还没关的，补上关闭和 `learning/sidechat-summarized` |
| 侧边会话写日志带发生时间 | `help.given` 的 `at` 取给出帮助的助手消息的时间，`signal.question`、`signal.misconception` 取学习者消息的时间，不再是关闭会话的时间。`signal.misconception` 只在原话能在学习者消息里找到、并且有自己的节点时记录 |

待确认：测试期间"离开测试再讨论，这次作答记为有帮助"需要 `assess` 提供对应动作，目前没有；作答的真实提交时间（判分前）归 `assess`，`learner` 据此判断帮助是否早于作答，侧边会话不改这两处。


**修改提案和批注页面的补充（10-10，Claude，tutor C 与 annotation 复核）：**

| 改动 | 说明 |
|---|---|
| `Proposal.decisionNote` | 处理提案时写给学习者看的说明（为什么不改、改了什么），可选 |
| `learnCore.proposals.decide(…, note?)` | 多一个可选参数 `note`；处理后在提交后发 `learning/proposal-decided`（新事件，进页面推送） |
| `learnTutor.decideProposal(courseId, proposalId, decision, note?)` | `applied` 只在提案之后对它的目标确实有改动时成立，改动记在提案上；`rejected` 必须有 `note`；只处理本课程、未处理的提案。主老师的工具 `decide_proposal` 调用它 |
| `annotation.list` 的返回 | 每条批注额外带页面用的 `proposal`（报错提案的状态和说明）和 `chatOpen`（疑问的侧边会话是否还开着）；这是页面视图，不进 `Annotation` 的数据 |
| 新批注的原句 | `create` 要求原句逐字（空白不计）在段落或资料片段里；只是相近的文字拒绝（`learning/annotation/quote-missing`） |


**掌握分析做深的补充（10-10，Claude，learner A、B、C）：**

| 改动 | 说明 |
|---|---|
| `learnCore.log.query` 的 `after`、`learnCore.log.count()` | `after` 是日志 ID（不含），按 ID 顺序一页一页读完整个日志，单次最多 10 万条；`count()` 是日志条数，日志只增不减，读的一方据此知道有没有漏掉记录 |
| 新日志类型 `problem.reviewed` | `assess.reviewProblem` 在老师核对题目后追加（`outcome`：`keep` / `fixed` / `retired`，带 `note`）。`fixed`、`retired` 表示题目有错，之前在这道题上的作答不再算证据；`keep` 不影响。题库去重时停用重复题不写这条 |
| `attempt.graded` 的 `at` 是交卷时间 | 一次交卷的所有题用同一个时间（答案定下来的时刻），判分完成得晚也不变；`Attempt.submittedAt` 相同。帮助是否早于作答按这个时间比（了结上面"作答的真实提交时间"那条待确认） |
| `NodeState`、`CourseState` 增加 `lastIndependentAt`、`next`、`checkFrom` | 最近一次独立答对的时间；还差什么（写给学习者的一句话）；下一次检查从什么时候起有意义（已独立完成：可以做延迟验证；已延迟验证：该复查了）。`needsReview` 在读取时按当时的时间和 `lastIndependentAt` 算，不靠写日志更新 |
| `NodeState.evidence` 的含义 | 只列支撑当前结论的记录（例如冲突时是那次独立答对和那次做错），不再是全部作答和帮助 |
| `EvidenceRecord.note`、`learnLearner.evidence(nodeId, limit?, courseId?)` | 作答记录说明算独立还是有帮助（哪种帮助）、判分改过没有、为什么不计；改判折进它更正的那次作答，不单独列。给了 `courseId` 时，`counted` 按这门课的状态标 |
| `Test.check`、`StartTestInput.check`、`learnAssess.dropCheck(testId)` | "考我一下"出的测试记着是哪个知识点（`check.nodeId`）；还没作答时学习者可以撤回：题目记一条 `problem.seen`，测试按撤回结束、任务关闭。老师发布的测试不能这样撤回 |
| 页面接口 `assess.check`、`assess.dropCheck` | `check({ courseId, nodeId })` 出题或返回这个知识点还开着的那份（练习题池、学习者没见过、尽量只考这个点、不出完整任务题；种类 `review`，按目标的复查条件），同时发布学习者自己的任务；没有可用的题时报 `learning/assess/no-fresh-problem`。`assess` 在用到时用 `ctx.get` 取 `learnKnowledge`、`learnCurriculum`、`learnGoal`，不写进 `inject` |

**调度做深的补充（10-11，Claude，planner A、B、C）：**

| 改动 | 说明 |
|---|---|
| `NextStep.key`，`actor` 增加 `none` | `key` 是"做什么:对哪个对象"（例如 `quiz.publish:<课时>`、`test.do:<测试>`），同一个动作改了文字不变，换了对象就变；消费方（tutor 的简报更新、页面）按它判断下一步变了没有，不再比标题。`actor: none` 表示现在谁都不用做：教材在生成、已结课、已归档、目标文件读不出来（`goal.unreadable`，不再当成"还没有目标"） |
| `NextStep.unfinished?: UnfinishedTest[]` | 课程里除这一步本身以外没交的测试（`testId`、种类、任务标题、发布时间、`running` 表示正在计时），计时中的在前。正在计时的测试本身成为下一步（`test.timed:<测试>`） |
| `NextStep.review?: ReviewSuggestion`；`learnPlanner.check(courseId, nodeId)`、`learnPlanner.defer(courseId)`；页面接口 `planner.check`、`planner.defer` | 现在建议的复查（课程、知识点、用途 `delayed` / `review` / `unaided`、原因、从什么时候起、今天已开始几道、每天几道）。`check` 开始建议的这一道（再核对一次仍在建议里，否则 `learning/planner/not-suggested`；这个知识点已有没交的就返回那份）；`defer` 让这门课到明天 0 点前不建议，存在 planner 自己的表 `planner_deferred`，发 `learning/planner-changed`（进推送） |
| `NextStep.back?`、`Countdown.pace?: Pace` | `back`：隔了设定的天数（默认 7）以上再学时，上次学习的时间和做了什么。`pace`：按已学完阶段的用时估剩下的要多久（`verdict`：`unknown` / `ok` / `tight` / `late`，`text` 写依据和结论）；日期过了不给 |
| planner 的 Config | `dailyChecks`（每天建议的复查题数，全部课程合计，默认 3，0 为不建议）、`returnAfter`（隔多少天算回来，默认 7），都是 `.volatile()`；`dailyChecks` 在设置页"资料服务 · 复查提醒"里改。planner 的 `inject` 增加 `learnLearner` |
| 首页接口 `planner.home` | 每行增加 `activeAt`（最近一次学习的时间），读不出下一步时带 `error`（原因）而不是只给 `null` |
| `learnAssess.check(courseId, nodeId, by?)`、`learnAssess.checkable(courseId, nodeIds)`；老师工具 `start_check` | 页面接口 `assess.check` 的服务版本：出"考我一下"或返回这个知识点还开着的那份，`by` 记谁要求的（任务的 `createdBy`）；等待目标条件之后的查重和出题之间不再等待，两次同时请求只出一份；测试已建但任务没发的，再请求时补发任务。`checkable` 只读，给出现在能出新题的知识点。`start_check` 给老师在学习者同意时出题 |
| `learnAssess.dropCheck` 交回主老师 | 学习者点"不做了"时发一次 `learning/handoff`；老师撤回（`withdraw`）仍不交回 |
| `CourseState.checkFrom` 的含义（learner `rules-2`） | 新的一道题独立答对从什么时候起算数：已独立完成是最近接触后 3 天，已延迟验证是最近独立答对后 14 天，有帮助完成是最近一次帮助后 24 小时；都不早于最近一次帮助后 24 小时。还没答对、证据冲突没有这个时间 |
| `learnCore.log.query({ newest })` | 新的在前，配合 `limit` 取最近的几条 |

**批注与侧边会话 B、C 的补充（10-11，Claude）：**

| 改动 | 说明 |
|---|---|
| sidechat 的整理记录（数据库迁移 2：`sidechat_stretches`） | 每轮回答完（DSH 的 `agent/status` 变成空闲）整理上次之后的新消息，每段存一行（会话、起止消息序号、问题 / 结论 / 帮助 / 误解及各自的消息序号、是否因多次失败跳过）；同一事务里追加 `help.given`（回复的时间）、`signal.question`（一次会话里每个知识点一条）、`signal.misconception`（有原话和知识点的）。整理模型是 `summaryModel`（侧边会话总结），用途名 `learning-sidechat-summary`。`learnSidechat.close` 只补整理截点之前还没整理的消息，不再另外总结 |
| `SideChatSummary.upTo` | 总结覆盖到的最后一条消息的序号（截点）；之前的总结没有这一项 |
| `learning/sidechat/still-answering` | 侧边会话的回答还在生成时，`close` 拒绝 |
| 笔记的去重标记 | `notes/side-chats.md` 每节以 `<!-- side-chat:<会话 ID> -->` 结尾（Obsidian 阅读视图里不显示）；也认得旧笔记的 `- 会话：<ID>` |
| `SideChatDraft`（`df_`）、`learnSidechat.draft / drafts / submitDraft / dropDraft / summary`；数据库迁移 3：`sidechat_drafts` | 侧边会话起草的修改建议，目标由程序从打开时的选中内容（教材段落、批注所在段落、阶段设计书、知识点）、课程路线或目标说明认定；题目和资料原文拒绝。`submitDraft` 建 `source: 'side-chat'` 的提案并交回主老师，只建一次；`summary(sessionId)` 读已结束会话的总结（批注用） |
| 新工具 `draft_proposal`（`@learning-agent/sidechat/tools`，挂在侧边会话预设上） | 参数 `target`（`selection` / `roadmap` / `goal`）、`change`、`reason`；开头经 `checkTool`：侧边会话可以用，测试进行中不能用 |
| 新事件 `learning/sidechat-changed` | 起草、提交、放弃修改建议后发出（带 `courseId`、`sessionId`），进页面推送 |
| 页面接口 `sidechat.drafts / submitDraft / dropDraft` | `drafts` 不含放弃的，交过的带 `proposal`（状态和老师的说明） |
| `learnAnnotation.sideChatQuestion(annotationId)` | 转侧边提问的第一条消息：疑问照原文；"我的理解"写成"我的理解：……请帮我看看对不对，还缺什么"；其他类型拒绝（`learning/annotation/not-askable`）。`annotation.ask` 的 `question` 就是它 |
| `annotation.list` 的 `followUp` | 侧边会话结束后：那次的结论、误解，以及这次会话记的每个误解知识点后来的情况（`settled`：误解之后有独立答对）。页面视图，不进 `Annotation` 的数据 |
| 新插槽 `learning.source-notes`（`SourceNotesProps { part, courseId, chunkId }`） | 资料阅读器（`library.sources` 页）在片段的识别文字旁留的位置，`annotation` 画批注菜单和批注；识别文字所在元素带 `data-chunk` |
| `MarkdownProps.onQuote` | 普通模式下，学习者在这段文字里松开鼠标或按键时回调选中的内容（同 `onBlock` 的 `quote`），没选中时为 `undefined` |
| 页面接口 `library.pageChunks({ sourceId, page })` | 一页上解析出的片段（带坐标），阅读器按坐标让学习者点选 |
| `CourseState.doubt`、`NodeState.doubt`（learner `rules-3`） | 独立答对过的知识点，上次独立答对之后记下的最近一条可能误解（正文和时间）；这时 `checkFrom` 提前到误解之后、最近一次帮助后 24 小时（不晚于原来的检查时间） |
| `ReviewSuggestion.purpose` 增加 `doubt` | 检查可能的误解，排在其他复查前面 |
| 外壳 | "提问"开关和右侧栏在主界面也有；`learnShell.showSideChat()` 在任何界面都打开右侧栏 |

了结：上面"待确认"里测试期间"离开测试再讨论"不另做 assess 的动作，侧边会话请学习者先交卷（不会的点"不会"），交卷之后的讲解按时间不影响这次作答。

**教材 D：讲解与原文（10-15，Claude）：**

| 改动 | 说明 |
|---|---|
| 教材文件里的资料原文 | 程序原样复制的资料片段写成 Obsidian 引用框：`> [!quote] 原文 · [《书名》p.页码](cite:片段ID)`，下面每行是片段原文（例题题目为"原题"，原书解答为折叠的 `[!quote]-` "原书解答"，图为"原图"，表为"原表"）；块 ID 隔一个空行单独一行。图写成 `![图注](cite:片段ID)`，教材页从原件裁图显示。模型自己写的 `> [!quote]` 框按普通段落处理 |
| 网页出处 | 联网补找到的网页不加入资料库，教材里写成普通链接 `[网页标题](https://…)`；只认这次给写作模型的网址 |
| 不再在正文里写 `[待核实](cite:unverified)` | 新生成的教材由核对结果标"待核实"（块索引的 `unverified`），正文不插字样；10-15 前的文件里已有的标记照旧读出。无效的片段引用和网址直接去掉，记在生成结果的说明里 |
| `Block.original` | 这个块是程序复制的资料原文：不核对，局部修订不能改（`learning/textbook/original`） |
| `LessonTextbookStatus` | 去掉 `check.single`（不再要求两个来源）；新增 `missing`（本节习题要用、资料里没讲到的内容）、生成中的 `progress`（步骤 `plan` / `write` / `check` / `publish`、开始时间、各要点是否写完）和 `draft`（写好的要点） |
| 核对结果（textbook 迁移 5 清空旧表） | `textbook_checks` 每段一行改为：内容指纹、`verdict`（ok / unsupported / contradicted / unchecked）、原因、内容出自哪些片段 |
| 页面接口 | `textbook.checks`（`{ lessonId }`）改为只给页边要标的段落：`flagged` / `unchecked` / `stale`；新增 `textbook.blockInfo`（`{ courseId, blockId }`）：一段的种类（原文 / 讲解 / 读完就答）、核对状态、原因、引用的原文（带文字）、引用的网页和摘录、最近一次修订原因 |
| 模型调用 | 列要点 `purpose: 'learning-textbook-plan'`（JSON），写要点和"读完就答"仍是 `learning-textbook`，核对仍是 `learning-textbook-check`（JSON，按段） |
| `learnLibrary.readWeb(url, signal?)` → `WebReading` | 读一个网页的正文、不存进资料库；屏蔽的网站和只当线索的网站拒绝，PDF 不读 |
| `kit` 的 `complete()` | 中转断线这类失败（DSH 的 `TRANSPORT`、`TIMEOUT`、`SERVER`、`RATE_LIMIT`、`EMPTY_RESPONSE`）隔 2 秒、6 秒各重试一次 |
| `MarkdownProps.onSelect`、`figure`；`TextPick` | 教材模式下选中文字时回调块 ID、引文和选区在屏幕上的位置（取代点击段落的 `onBlock`）；`figure` 画 `![…](cite:…)` 的图，外壳默认用 `learning.figure` |
| `learning.figure` 由外壳声明 | 任何页面用 `learnShell.Figure({ chunkId })` 或 Markdown 里的图显示原书插图（测试页不再声明这个插槽） |
| 外壳 Markdown | `> [!type]` 引用框（`-` 为折叠）；出处标签悬停约 0.35 秒显示原文（经 `library.chunk`） |
| 主老师工具 | `read_lesson_textbook` 末尾列出待核实的段落；`revise_textbook` 不能改原文块 |
| 生成说明 | 列要点失败、退回按小标题分要点时，`check.notes` 写明原因 |

**外壳改版：标签页导航和侧栏（10-16，Claude）：**

| 改动 | 说明 |
|---|---|
| `ActivityItem.panel` | 图标栏的图标显示这个 `learning.panel` 面板（再点收起），不打开 `page`；可以指别的单元的面板（课程教材 → `curriculum.outline`）。`title` 是悬停提示、侧栏标题和位置路径的一段 |
| `learning.panel`（取代 `learning.sidebar`） | 按面板 ID 注册：`curriculum.outline`（阶段 → 课时目录）、`assess.list`（测试）、`annotation.list`（批注）；属性 `{ scope }` |
| `learning.new-tab` | 新标签页顶部的区块，按 `order` 排；planner 放"继续学习"。属性 `{ scope }` |
| `openPage(page, params, OpenOptions)` | 默认在当前标签打开并进这个标签的历史，正是当前页面时不动；当前标签固定时另开标签。`OpenOptions`：`title`、`newTab`、`split`（右侧分屏）、`side`（右侧栏，出处原文）。Ctrl/⌘+点击任何控件、中键点击带 `data-la-opens` 的控件（kit `Button` 的 `opens`）都在新标签打开 |
| `learnShell.usePage()` → `PageFrame` | 页面组件用的钩子：`visible`（在前台）、`where`（`tab` 或 `side`）、`setTitle`（把标签改成具体内容的名字）。kit 的 `useLoad` 据此在页面不在前台时不随推送刷新，回到前台再刷新一次 |
| 页面里换内容 | 教材换课时、资料阅读器跳章节都经 `openPage`，进标签的历史；出处统一用 `side: true` |
| 外壳的界面偏好（浏览器本地） | 每个界面的标签和历史（`shell:tabs:*`，旧的 `shell:layout:*` 不再读取）、滚动位置、开着的侧栏、最近打开、右侧栏的视图和宽度 |
| kit `ContextMenu` | 在指针处弹出的菜单（标签的右键菜单） |
| assess 测试页 | 离开页面（换页或关标签）时立即保存还没保存的作答 |
