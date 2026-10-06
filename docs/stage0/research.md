# 阶段 0 调研报告

> 2026-10-03 · 对应 PLAN"开发路线"阶段 0 第 1 步（技术验证）之前的调研
> 方法：阅读 DSH 源码（浅克隆 master，commit `5badb15`，2026-10-03）、各服务官方文档，并在本机做了几项小测试
> 结论先行，细节在后。凡是"实测"的都标了出来，其余是读文档/源码得出的，还要在动手验证时确认。

---

## 一、结论速览

| 问题 | 结论 | 把握 |
|---|---|---|
| DSH 用哪个版本 | 锁定 npm `0.2.0-rc.2`（当前 latest，今天发布） | 高 |
| 前端怎么做 | **跑在 DSH 的客户端内核上，整页布局由我们接管**：DSH 允许一个插件独占根节点（`root` 插槽），它的所有界面插件都可以不装 | 中高（需实测） |
| 我们的插件怎么给前端提供接口 | 首选 DSH 的类型化 RPC（`@Remote`）；它依赖构建期生成，树外插件能否生成**是最大的未知数**；备选：在 DSH 的认证通道上挂自己的 HTTP 路由 | 中（需实测） |
| 主老师、侧边会话怎么实现 | 用 DSH 的 **Agent 预设（preset）**：每种角色一个 YAML，定义它的工具、人设、模型 | 高 |
| 模型 | `deepseek-flash`：**能看图**，100 万 token 上下文；`deepseek-v4-pro`：纯文本，100 万上下文。其他厂商可通过 DSH 的 pi-ai 适配器接入 | 高 |
| 资料解析 | MinerU 4.0，本地用 uv 装；你的电脑（RTX 4060 8GB + 32GB 内存）能跑标准档；云 API 每天 2000 页优先额度，单文件 ≤600 页 | 中高（需实测教材） |
| 数据库 | 用 Node 自带的 `node:sqlite`（DSH 也用它）。**实测**：中文全文检索可用，能加载扩展（向量检索用） | 高 |
| 搜索 | DSH 已内置 Exa、Perplexity、DeepSeek 原生搜索三个提供者；我们补博查、Tavily、Brave 等 | 高 |
| 停靠布局库 | dockview（零依赖、稳定）。不用 DSH 内部的 `ui-dockkit`（它自己声明 API 不稳定） | 高 |
| 知识图谱渲染 | sigma.js v3 + graphology（WebGL，十万级节点仍流畅） | 高 |
| 开发环境 | 你的环境基本齐全，不需要 Docker | 高（实测） |

---

## 二、DSH：当后端怎么用

### 2.1 版本

- npm：`latest` = `0.2.0-rc.2`，另有 `alpha` = `0.2.1-alpha.1`。
- 要求：Node `^22.19.0 || >=24`；pnpm 11（仓库锁定 11.7.0）。协议 MIT。
- 仍是开发预览版，迭代很快 → **锁定版本**，升级前先跑我们的兼容测试。

### 2.2 DSH 的四种"成品组合"

| 组合（bundle） | 用途 | 对我们 |
|---|---|---|
| `web-app` | 浏览器应用：HTTP 服务、认证、会话接口 + 全套界面 | **用它的服务端和客户端内核，去掉界面** |
| `headless` | 一次性命令行任务，没有服务器 | 不适用（之前 PLAN 写"以 headless 方式运行"不准确，已更正） |
| `sdk-app` | 通过标准输入输出走 JSON-RPC | 备选（如果要用独立前端 + 自己的中间服务） |
| `acp-app` | 自动化协议 | 不需要 |

### 2.3 前端：DSH 允许整页接管

读源码发现 DSH 前端分两层：

- **内核层**（不是界面）：启动加载、插件模块加载、与后端的连接和认证、会话数据流（含断线重连、流式输出）、热重载。
- **界面层**：几十个 `dsh-client-ui-*` 插件。

关键一句（`ui-renderer` 说明）：渲染器只调用一次 `renderSlot('root')`，**谁占了 root，谁就拥有整个页面的布局**。DSH 自己的三栏布局（`ui-layout`）也只是 root 的一个占用者。

所以推荐方案：

```
浏览器
 └─ DSH 客户端内核（启动、连接认证、会话流、热重载）   ← 复用
     └─ root ← 我们的外壳插件（主界面/课程界面、活动栏、dockview 布局…）
          └─ 我们的各页面插件（知识图、资料库、教材、测试、侧边会话…）
DSH 的 dsh-client-ui-* 界面插件                         ← 全部不装
```

好处：
- 前端也是插件化，和你"一切皆插件"的想法一致。
- 认证、流式输出、断线重连这些麻烦事不用自己写。
- 布局 100% 由我们决定，不被 DSH 的设计拖累。

约束：
- React 版本跟随 DSH（目前 18），因为 React 是 DSH 前端的共享模块。
- 我们的前端插件要按 DSH 客户端插件的规范打包（`package.json` 里的 `dsh.client` 字段 + 构建好的 bundle）。

视觉：DSH 的设计变量（`--dsw-*` 颜色、字体等）由 `ui-theme` 提供，可以直接沿用，保持简约风格。它的 Markdown + 公式渲染器（`ui-primitives`）也是共享模块，可以先复用。

备选方案（如果实测发现内核方案处处受限）：独立的 Vite + React 应用，直接调用 DSH 的 `/api`（HTTP）和 `/api/remote.mux`（WebSocket）。

### 2.4 我们的后端插件怎么给前端提供接口

- **DSH 原生做法**：后端服务继承 `TypertRemoteService`，方法上标 `@Remote`；构建时生成前端可调用的类型和校验代码，前端通过 `ctx.remote.<命名空间>.<方法>` 调用，支持流式。
- **风险**：这个生成步骤目前跑在 DSH 自己仓库的构建流程里（以 DSH 的整体 TypeScript 工程为输入）。**树外插件能不能生成，文档没写，必须实测。**
- **备选**：DSH 有一个"已认证的请求通道"（`connection.fetch`），DSH 自己的 `/api/file` 就挂在上面。我们可以在同一通道上挂自己的 HTTP 接口，认证照样由 DSH 负责。

### 2.5 主老师、侧边会话、判分员：用 Agent 预设

- `agent-preset`：用普通的 Cordis YAML 定义"一个 Agent 带哪些子插件"（工具、人设、模型等），可以定义多个，会话创建时选一个。
- `persona`：给某个预设单独的人设（系统提示），甚至可以只用它自己的提示。
- 工具可以按 Agent 收窄可见范围。
- 会话的创建、发消息（含图片附件）、读取历史和实时流，都有现成接口（`session-controller`）。

→ 计划：`teacher`（主老师）、`side-chat`（侧边会话）、`grader`（判分）、`researcher`（调研）等各一个预设。每阶段一个主老师会话 = 用 teacher 预设新建一个会话。

### 2.6 模型

DSH 的 DeepSeek 适配器默认目录：

| 模型 | 输入 | 上下文 |
|---|---|---|
| `deepseek-flash` | 文本 + **图片** | 100 万 token |
| `deepseek-v4-pro` | 仅文本 | 100 万 token |

对我们的影响：
- **拍照手写**：识别要用 `deepseek-flash`（pro 不能看图）。正好印证"按角色配模型"：识别用 flash，复杂推理可以交给 pro。
- **100 万上下文**：一整章甚至整本教材都能直接放进上下文。资料库可以做成"检索定位 + 长上下文通读"的组合，引用更准。
- 其他厂商：DSH 的 `llm-pi-ai` 适配器支持多家服务、OpenAI 兼容网关和自建服务，你在设置里加就行。

### 2.7 搜索

DSH 已有：`web_search` / `web_fetch` 两个工具，后端提供者可替换（`ctx.web`）。现成提供者：

| 提供者 | 特点 |
|---|---|
| Exa | 语义搜索，返回可引用的来源片段 |
| Perplexity | 返回生成的回答 + 来源 |
| DeepSeek 原生搜索 | 用 DeepSeek 账号/API key 即可；但每次搜索要耗一整轮模型调用（延迟和 token） |

我们要补的提供者：博查、Tavily、Brave（秘塔需确认是否有官方开放 API）。学术检索（OpenAlex、Semantic Scholar）做成资料库自己的检索器，不走网页搜索工具。

### 2.8 存储

DSH 自带的存储是"键值文档"型，适合小状态，不适合我们的全文检索、向量、证据查询。但它用的是 Node 自带的 `node:sqlite`，我们也用它。**本机实测（Node 24.18）**：

- SQLite 3.53.1
- FTS5 trigram 分词对中文可用（"摩擦系数"命中正确的句子）
- `loadExtension` 可用 → 可以加载 sqlite-vec 做向量检索
- 注意：trigram 要求查询词至少 3 个字，"传热"这种两个字的词要走 LIKE 或另做分词——资料库单元调研时解决

---

## 三、资料解析：MinerU 4.0

| 项 | 内容 |
|---|---|
| 安装 | `uv venv` 建独立环境 → `uv pip install -U "mineru>=4.0,<5"`；Python 3.10–3.14；Windows 原生支持 |
| 档位 | flash（只用 CPU，最快）/ basic / standard（默认高质量，8GB 内存 + CPU 或 GPU）/ advanced（难文档，16GB+ 内存、8GB+ 显存） |
| 你的电脑 | RTX 4060 8GB + 32GB 内存 → standard 稳；advanced 刚好卡在显存线上，要实测 |
| 本地服务 | `mineru server start`；命令行 `mineru parse 文件 --tier standard` |
| 云 API | 精准解析 API 需 token；每账号每天 2000 页优先额度；单文件 ≤200MB、≤600 页（整本教材可能要拆分） |
| 输出 | Markdown + 结构化 JSON（每块带 `page_idx` 页码、`bbox` 位置、类型：正文/公式/表格/图片） |
| 格式 | PDF、图片、Word、PPT、EPUB 等 |
| 协议 | MinerU 开源协议（基于 Apache 2.0 附加条件），个人使用没问题 |

→ 页码 + 位置正好满足"点引用跳到原文那一页那一块"。

---

## 四、搜索服务价格（第三方整理，以官网为准）

| 服务 | 免费额度 | 付费 |
|---|---|---|
| Tavily | 每月 1000 credits；新账号另送约 $20 | 约 $0.008 / credit |
| Exa | 新账号 $20；每月再送 $10 | 带正文搜索约 $7 / 千次 |
| Brave | 已取消免费档；每月 $5 额度（约 1000 次） | $5 / 千次 |
| 博查 | 注册送免费资源包 | 见官网 |
| DeepSeek 原生搜索 | 用现有 DeepSeek key | 按模型 token 计费 |

搜索基准测试准备用的 10 个问题（化工原理，中英混合，覆盖概念/公式/题源）：

1. 范宁公式 摩擦系数 层流 推导
2. 离心泵 汽蚀余量 NPSH 定义 计算
3. 实际流体 机械能衡算 伯努利方程 应用条件
4. Dittus-Boelter 关联式 对流传热系数 适用范围
5. 逆流 并流 换热器 对数平均温差
6. 精馏 McCabe-Thiele 图解法 最小回流比
7. 吸收塔 传质单元数 NTU 计算方法
8. 化工原理 期末考试 真题 流体流动
9. Moody diagram relative roughness friction factor
10. 干燥速率曲线 恒速干燥 降速干燥 临界含水量

评价指标：前 5 条结果里权威来源有几条、相关性、中文覆盖、延迟、单次成本。

---

## 五、前端零件

| 用途 | 选择 | 理由 |
|---|---|---|
| 停靠布局（标签页、分屏、拖拽） | dockview | 零依赖、维护活跃、VSCode 式体验；DSH 的 `ui-dockkit` 自称内部引擎、API 随时会变 |
| 知识图谱 | sigma.js v3 + graphology | WebGL 渲染，十万级节点仍流畅；graphology 自带图算法（局部图、筛选） |
| 原文 PDF 视图 | pdf.js | 标准方案；配合 MinerU 的页码和位置做高亮 |
| Markdown + 公式 | 先复用 DSH `ui-primitives` 的渲染器（已支持 TeX） | 共享模块，风格一致 |
| 设计变量 | DSH `ui-theme` 的 `--dsw-*` | 保持 DSH 的简约风格 |

---

## 六、你的开发环境（实测）

| 项 | 情况 | 是否满足 |
|---|---|---|
| Node | 24.18.0 | ✓ |
| pnpm | 11.22.0（DSH 锁 11.7.0，用 corepack 切换） | ✓ |
| Python / uv | 3.12.10 / 0.11.15 | ✓（MinerU 用） |
| Git | 2.55 | ✓；注意：拉 DSH 源码要开 `core.longpaths`，否则 Windows 路径过长会检出失败（本次遇到过） |
| Docker | 没有 | 不需要了 |
| GPU | RTX 4060 Laptop 8GB | ✓（MinerU 标准档） |
| 内存 / CPU | 32GB / i7-14650HX | ✓ |
| 磁盘 | C 盘 114GB、D 盘 120GB 可用 | ✓ |

---

## 七、风险清单

| 风险 | 影响 | 应对 |
|---|---|---|
| 树外插件无法生成 typert 接口 | 前端调后端要另想办法 | 备选：认证通道上的自定义 HTTP 路由 |
| DSH 迭代快（rc 版） | 升级可能破坏我们的插件 | 锁版本；只依赖少量接口；升级前跑兼容测试 |
| 客户端插件打包规范不熟 | 前端插件起步慢 | 阶段 0 先做一个"hello root"插件跑通 |
| 扫描教材公式识别质量 | 教材出处和抽题都受影响 | 用你的真实教材实测 standard / advanced / 云 API 三种 |
| trigram 不支持两字词 | 中文检索漏召回 | 资料库单元调研分词方案；向量检索兜底 |
| 搜索服务的中文质量差异大 | 找权威资料效果不稳 | 基准测试定默认排序；多家并用 |

---

## 八、下一步：动手验证（需要你准备的东西）

### 需要你准备

1. **DeepSeek API key**：请你自己写进项目根目录的 `.env` 文件（`DEEPSEEK_API_KEY=...`），不要贴在聊天里。
2. **化工原理教材电子版**：放到 `D:\TestFiles\vibecoding\learning-agent\materials\`（这个目录不会进 git）。先给一章也行。
3. **3–5 张手写解答照片**：随便一道化工原理计算题的手写过程。
4. 可选（越多，搜索基准越完整）：Tavily / Exa / 博查 / Brave 的 key，MinerU 云 API token，同样写进 `.env`。

### 我来做的验证项

| 编号 | 验证内容 | 通过标准 |
|---|---|---|
| V1 | 安装 DSH `0.2.0-rc.2`，建我们自己的 profile；去掉所有 DSH 界面插件后服务端仍正常 | 能启动、能认证连接 |
| V2 | "hello root" 前端插件：占用 root、用 dockview 布局、显示一个会话的实时输出 | 整页由我们渲染，能和老师对话 |
| V3 | "hello" 后端插件：一个 `@Remote` 方法被前端调用 | 能调用；不能则验证备选 HTTP 路由 |
| V4 | 两个 Agent 预设（teacher、side-chat），程序化建会话，只开放我们的工具 | 两个会话互相隔离，工具受限 |
| V5 | 注册一个自定义搜索提供者 | 老师的 `web_search` 走我们的提供者 |
| V6 | MinerU 本地解析教材一章（standard，必要时 advanced）+ 云 API 对比 | 公式、表格、页码定位质量记录在案 |
| V7 | `node:sqlite` + sqlite-vec 在 Windows 上加载 | 能建向量表、能查询 |
| V8 | 搜索基准：10 个问题 × 可用服务 | 得出默认排序 |
| V9 | `deepseek-flash` 识别手写照片 | 记录公式和数字的识别准确率 |
| V10 | 汇总成 `docs/stage0/compatibility.md`（能做 / 不能做 / 需要绕开） | — |

另外建议在动手前把本项目初始化为 git 仓库，方便回退。

---

## 参考来源

- DSH 源码与文档：github.com/deepseek-ai/deepseek-harness（commit `5badb15`）——`docs/architecture.md`、`docs/api-gateway.md`、`docs/cookbook/adding-a-remote-api.md`、`docs/development.md`、`packages/bundle/*`、`packages/client/{web,ui-renderer,ui-layout,ui-slots,ui-dockkit,ui-primitives,ui-theme}`、`packages/api/session-controller`、`packages/preset/*`、`packages/llm/{llm-deepseek,llm-pi-ai}`、`packages/web/*`、`packages/storage/*`
- npm：`@deepseek-ai/dsh` dist-tags
- MinerU：github.com/opendatalab/MinerU；mineru.net/apiManage
- 搜索价格：Tavily 帮助中心与 costbench、Exa 官方定价页、implicator.ai（Brave 取消免费档）；博查开放平台介绍
- dockview.dev；sigma.js 文档与第三方对比文章
