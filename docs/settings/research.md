# 设置页与插件管理调研

> 2026-10-05 的调研记录，模型的高级设置（10-16）和其他基于 DSH 的产品（11-06）是后来补的。现在怎么运作、采用了哪些结论，以 [design.md](design.md) 为准；当时的代码核对、分批和验收草案、交接说明、给契约的补充建议已经删去，在 git 里能找到。

建议自己做"设置"页，直接调用 DSH 已有的设置、密钥、模型和插件服务，不在外壳里重建 DSH 自己的设置面板。设置页只管运行环境：模型、在线服务和密钥、外观、数据位置、插件；学习安排仍然和主老师商量。我们的单元要做成一个 DSH 组合包，否则在页面上保存的设置会被安装脚本覆盖。下面区分 DSH 现有能力、外部做法和本项目建议。

## DSH 已经提供什么

读了 0.2.0-rc.2 的代码和说明，再在 3182（合成数据）上只读调用了这些接口。结果记在[验证记录](../history/2026-10-compatibility.md#设置与插件接口只读探查10-05claude)。

| 能力 | 接口 | 3182 上看到的 |
|---|---|---|
| 设置表单 | `settings.describe / update / mutate`；浏览器端 `configForms` | 插件用 `.volatile()` 声明的字段才进表单。改动不重启插件，下一次读取就生效。写入带修订号，过期的写入被拒绝。密钥字段只报告"是否已设置"。现有 15 组，包括外观、语言、默认模型、DeepSeek、其他模型厂商 |
| 密钥 | `credentials.describe / set / unset` | 只写不读，只回答"是否已配置、来自哪里、能否修改"。查找顺序：启动环境 → `$DSH_HOME/.credentials.yaml` → 启动目录的 `.env` → `$DSH_HOME/.env`。DeepSeek、MinerU、Voyage、Exa 的密钥现在都"来自启动环境，不能在页面修改" |
| 模型 | `session.modelCatalog`、`session.selectModel`、默认模型 `agent-default-model`、`llm.listConfigurableProviders` | 默认是 `deepseek-official / deepseek-flash`；可用 `deepseek-flash` 和 `deepseek-v4-pro`，推理强度都有 off、low、high、max。另有 41 个可添加的厂商路由（含 Kimi、通义、智谱、MiniMax）和自定义的 OpenAI 兼容接口 |
| 插件清单 | `pluginInventory.list` | 198 个插件行，121 个运行中，77 个已停用；还列出两个老师预设各挂了哪些插件（主老师 8 个，侧边会话 2 个） |
| 插件管理 | `pluginManager.listBundles / setPluginEnabled / installBundle / removeBundle` 等 | 我们的 12 个单元和两个预设都能启停，13 个管理组件锁定。DSH 随附 4 个默认关闭的实验组合包（智能体团队、自动化任务、语音输入、自动授权审查），都是编程助手的功能 |
| 展示信息 | 包里 `locale/en.json`、`locale/zh.json` 的 `meta.title`、`meta.description`，`package.json` 的 `icon` | 我们的单元还没有这些文件，清单里显示英文包名和开发用的说明 |

前端调用这些服务的方式，和现在调用会话接口相同（`ctx.remote.<服务名>`）。

DSH 的设置面板、模型页和插件页（`ui-settings-general`、`ui-settings-models`、`ui-plugin-manager`）依赖 DSH 自己的布局、控件和样式变量；设置弹窗挂在页面根节点之外；内容里有命令行、沙箱、子智能体等编程功能。DSH 也给自己做页面的客户端留了路：每组设置都带"是否自动生成页面"的标记，插件可以声明自己有设置页。

**本项目建议：** 自己做设置页和插件页，用我们的页面骨架和共享控件，直接调用上面这些服务；不在外壳里提供 DSH 的设置插槽。这样页面风格一致，也只出现学习者用得上的选项。代价是"添加其他模型厂商"的页面要自己做，这一项放到后面。

## 外部做法

### 设置页

同一个分区里，立即生效和点"保存"不要混用。开关、单选适合立即生效：旁边显示"已保存"，失败时把选项恢复原状并说明原因。需要输入的文字（地址、密钥）适合显式保存，离开前提醒有未保存的修改。[设置页设计实践](https://www.boundev.ai/blog/settings-screen-ux-design-best-practices)

Obsidian 1.13 的设置可以搜索。插件改用"声明式"设置：插件只描述有哪些设置项，显示、搜索、保存和校验由 Obsidian 负责；有联动或副作用的设置项才由插件自己画界面。[Obsidian 1.13 更新说明](https://obsidian.md/changelog/2026-05-28-desktop-v1.13.0/)、[声明式设置迁移指南](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings) VS Code 的扩展在 `package.json` 里声明设置项，设置界面由此自动生成。[VS Code 贡献点](https://code.visualstudio.com/api/references/contribution-points)

**本项目建议：** 每个单元声明自己的设置项（DSH 的 Config 字段）。简单的选项由设置页按声明自动显示；需要联动的部分（测试连接、索引状态）由单元自己提供一块界面。选择类立即生效，密钥和地址显式保存。Ctrl K 能搜到各个设置分区。

### 模型：一个默认模型，几个可单独指定的角色

- Zed 让内联助手、提交说明、对话摘要等功能各自指定模型，没指定的用默认模型。[Zed 智能体设置](https://zed.dev/docs/ai/agent-settings)
- Open WebUI 把起标题、打标签、改写检索词这类后台小任务交给单独的"任务模型"，用来省时间和费用。[Open WebUI 任务模型](https://docs.openwebui.com/features/administration/task-models)
- Cherry Studio 有默认助手模型、话题命名模型、翻译模型三项。模型服务页填密钥和地址，"检查"按钮用一个模型实际发一次请求，模型列表从服务商拉取后挑选添加。[Cherry Studio 默认模型](https://docs.cherry-ai.com/pre-basic/settings/default-models)、[模型服务设置](https://docs.cherryai.com.cn/docs/en-us/pre-basic/providers/providers.md)
- Continue 按角色（对话、编辑、自动补全、向量、重排等）分配模型。[Continue 配置参考](https://docs.continue.dev/reference)

**本项目建议：**

- **默认模型就是 DSH 的默认模型**（`agent-default-model`），只存一份。
- **现有 5 个角色：** 主老师、侧边提问、写教材、判分、侧边会话总结。每个角色默认"跟随默认模型"，也可以单独指定。
- **只列当前可用的模型。** 以后加"看图识别手写"这类角色时，只列能看图的模型。
- **改了就生效，不用重启。** 主老师和侧边提问是会话，用 DSH 的 `selectModel` 切换当前会话的模型；写教材、判分、总结每次调用时读取当前设置。
- **推理强度先只跟着默认模型设置。** DeepSeek 的思考也计入输出额度，单独给某个角色开到最高，可能出现"截断"，要和该角色的输出额度一起调。
- **其他厂商用 DSH 现成的后端。** DSH 已经能接 41 个厂商路由和自定义接口，缺的是页面。DSH 自己的模型页这样保存：厂商配置写进 `llm-pi-ai` 的 `providers.<路由名>`（自定义接口另写协议、地址和模型列表），密钥按路由名存成 `<路由名大写>_API_KEY`；"获取可用模型"调用 `llm.discoverModels`，DSH 已知的厂商直接从目录回答，不发网络请求。DeepSeek 的接口地址按"页面填写的地址 → 启动环境的 `DEEPSEEK_BASE_URL` → 官方地址"的顺序取。

### 密钥

DSH 的密钥只写不读。界面只显示是否已配置、来自哪里、能否修改；保存后下一次请求就用新值。启动环境里的密钥优先级最高，不能在页面修改（见 `@deepseek-ai/dsh-credentials-local` 的说明）。桌面应用常用 Electron 的 `safeStorage` 交给系统钥匙串加密（Windows 上是 DPAPI），VS Code 保存密钥就基于它。[Electron safeStorage](https://www.electronjs.org/docs/api/safe-storage)

**本项目建议：**

- `library` 改为通过 DSH 的密钥服务按名称读取 MinerU、Voyage 的密钥，每次请求时读取。`.env` 照常可用，页面上显示"来自启动环境"。
- 页面只能填写或清除密钥，从不回显。每个服务有"测试连接"，用最小的请求核对密钥和网络；DeepSeek 要实际发一条很短的请求，会用掉少量额度。
- 密钥文件 `.dsh-home/.credentials.yaml` 在 Windows 上和 `.env` 一样是明文，只在本机。做桌面版时再换成系统钥匙串。
- 出错提示带"去设置"按钮，直接打开对应分区，不再让学习者"检查 .env"。

### 插件管理

- Obsidian 把插件分成核心插件和第三方插件。核心插件随软件提供，只能开关。第三方插件默认处于"受限模式"，学习者关掉受限模式后才能安装；每个插件有自己的设置页。[Obsidian 第三方插件](https://obsidian.md/help/community-plugins)
- JetBrains 随附的插件能停用、不能卸载，插件详情列出它依赖的其他插件。[JetBrains 插件管理](https://www.jetbrains.com/help/idea/2023.2/managing-plugins.html)
- DSH 的插件页分"官方"和"已安装"，能启停组合包和其中的每一行；插件把自己的配置页挂在插件详情里。安装前先读出包名、版本和说明，安装失败时恢复原状。

我们的 12 个单元都是学习流程的一环。停用 `core`，整个程序不能用；停用 `knowledge`，主老师的提示词仍要求搭知识图，却找不到工具。所以现在没有可以随便关掉的单元。

**本项目建议：** 分三步做。

1. **清单与设置**（和设置页一起做）：每个学习功能一张卡片，显示中文名称、一句话说明、图标、运行状态（运行中，或启动失败和原因）、哪些老师用到它的工具、它的设置入口。必需的单元标"必需"，不给开关。DSH 的基础组件折叠成一组，只读，用来诊断。
2. **可选功能的开关**：等出现可选插件时再做，例如联网补充的各个搜索源（[资料库设计](../library/design.md)本来就要求可插拔）。关掉一个可选插件时，依赖它的功能要退回基础流程，不能让主老师找不到工具。
3. **安装第三方插件**：从 npm 包名或本地文件夹安装、卸载，默认关闭；打开前说明插件代码以你的身份运行，能读写你的文件。等真有第三方插件时再做。

## 设计草案

### 设置页管什么

管运行环境：模型、在线服务和密钥、外观、数据位置和发往在线服务的内容、插件。

不管学习安排。目标、节奏、测试条件、给多少帮助，都和主老师商量，修改走[统一的修改流程](../journey.md)；也不提供"学习风格"选项（PLAN"明确不做"）。DSH 的命令行、沙箱、子智能体、权限预设这类编程功能的设置不显示。

### 页面结构

"设置"入口放在左侧栏底部、"外观"旁边，主界面和课程里都能打开，在当前界面开一个"设置"标签页（最初的界面设计只放在主界面）。Ctrl K 能搜到各分区，出错提示里的"去设置"直接打开对应分区。

| 分区 | 内容 | 怎么保存 |
|---|---|---|
| 模型 | 模型服务：DeepSeek 和已添加的厂商，各自的密钥状态、填写、测试连接、接口地址、可用模型；添加模型服务（从 DSH 已知的厂商里选，或填自定义的兼容接口，再获取可用模型挑选）。模型分工：默认模型，5 个角色各用哪个模型 | 选择立即生效；密钥、地址和新服务显式保存 |
| 资料服务 | 资料解析：云端 MinerU（要密钥，PDF 会上传）或本机 MinerU（要先启动本机服务）。语义检索：开关、Voyage 密钥、索引状态；更换向量模型要重建索引 | 同上 |
| 外观 | 跟随系统、浅色、深色 | 立即生效 |
| 数据与隐私 | 学习库位置；哪些内容会发给哪个在线服务（DeepSeek：对话和资料片段；MinerU：PDF 原件；Voyage：资料片段和检索问题） | 只读 |
| 插件 | 见上文"插件管理"第一步 | — |
| 关于 | 学习工作台和 DSH 的版本 | 只读 |

窄窗口（760 像素）下，分区列表变成页面顶部的一行。控件用共享库，要补两个：开关（`role="switch"`）和密钥输入框（只写，显示是否已配置）。

### 设置存在哪、归谁

- **每个单元声明自己的设置项。** 例如 `library` 的解析方式和语义检索开关，`tutor` 的主老师模型，`textbook` 的写教材模型。设置页按分区汇总，模型角色汇总成一张表。以后新增的插件声明了设置项，也会出现在页面上。默认值写在代码里。
- **设置由 DSH 写进 profile 的 `cordis.patch.yml`。** 改动不重启插件就生效，重启后仍在。
- **密钥放在 DSH 的密钥服务里，** 不写进配置文件。
- **默认模型直接用 DSH 的默认模型设置。**
- **`LEARNING_HOME` 仍用环境变量。** 学习库在启动时打开数据库，运行中不能换；开发用的 3180、3182 数据目录也靠它区分。设置页只显示位置。`LEARNING_PARSER`、`LEARNING_EMBEDDINGS` 改成设置项；自动测试通过测试工具传入同样的设置，仍然不调用付费服务。

### 先改成组合包

DSH 保存一项设置时，把这个插件行当时的整份配置写进 profile 的 `cordis.patch.yml`，只替换可编辑的那几个字段（读 `dsh-config-editor` 的代码确认）。这带来两个问题：

- **安装脚本会冲掉设置。** `dev-profile.sh` 每次都覆盖这个文件和 profile 的 `package.json`，学习者保存的设置、插件开关和组合包选择都会丢。
- **一行的其余配置会被固定。** 插件行本身带着配置时（比如老师预设的提示词），保存一次设置，这一行其余的配置也被固定在学习者那一层；以后我们更新这些配置，学习者那里不会跟着变。

**本项目建议：** 把十二个单元和两个老师预设移进一个组合包（新包，例如 `@learning-agent/app`，`package.json` 的 `dsh.bundle.patch` 指向现在这份配置）。profile 自己的 `cordis.patch.yml` 只留给学习者的设置。安装脚本只负责链接包、选中组合包，不再覆盖 profile 的文件。单元的插件行不带配置，默认值都在代码里；学习者能改的设置不放进老师预设这类带大段配置的行。DSH 也建议把产品功能放进组合包。

### 插件展示信息

每个单元加 `locale/en.json`、`locale/zh.json`（`meta.title`、`meta.description`）和 `package.json` 的 `icon`（SVG，用和侧栏一致的 Lucide 线条图标）。DSH 要求必须有英文文件，并且通过包的 `exports` 找这些文件。老师工具是包的子路径（如 `@learning-agent/library/tools`），给子路径也映射一组展示信息，老师预设的清单里就能显示"资料库 · 老师工具"，而不是模块名。

## 模型的高级设置（10-16）

你 10-16 提出：每个模型服务的高级设置里，能设上下文窗口、最大输出和支持的思考程度。读了 DSH 0.2.0-rc.2 的代码（`dsh-llm-deepseek`、`dsh-llm-pi-ai`、pi-ai 的请求组装和 DSH 自带的模型页）：

| | DeepSeek（`llm-deepseek`） | 其他厂商和自定义接口（`llm-pi-ai`） |
|---|---|---|
| 上下文窗口 | 每个模型的 `contextWindow`，写在 `models` 列表里，整份替换默认的两个模型；两个默认模型都是 100 万 | 每个模型的 `contextWindow`：自定义接口写在路由的 `models` 里，DSH 认识的厂商写在 `modelOverrides.<模型>`；没写时用厂商目录的值，自定义接口默认 262144 |
| 最大输出 | 每个模型的 `maxTokens`；没写用整个服务的 `maxTokens`（256000） | 同一处的 `maxTokens`，写了就同时是每次请求的默认上限；没写用目录的值，自定义接口默认 32768 |
| 思考程度 | 接口固定四档：不思考、低、高、最高；`thinking: disabled` 时只能不思考 | 每个模型的 `reasoningEfforts`：列出支持的档位（不思考、最低、低、中、高、很高、最高），每档写发给接口的值，只有"不思考"可以留空表示不发参数；`false` 表示不支持思考；不写沿用目录，手工添加的模型没有思考 |

- **这三项用在哪：** 上下文窗口决定会话什么时候压缩前面的内容，填大了请求会超长被拒；最大输出是请求的上限；思考档位决定"思考强度"下拉框里有哪些选项、请求里发什么。
- **DSH 自带的模型页**能按模型改上下文窗口和最大输出（可以写 256K、1M，K 是 1000，M 是 100 万），不能改思考档位。
- **写入规则：** DSH 写入时检查数值是正整数、思考档位至少有一档不是"不思考"。设置接口的路径不支持数组下标，改自定义接口的模型要整份重写 `models`。
- **一次性调用不受最大输出约束：** 写教材（16000）、判分（4000）这类调用自己传输出额度，DSH 的规则是请求里写了就以请求为准，所以学习者设的最大输出管不到它们。

**本项目建议：**

- 每张模型服务卡片加"高级设置"（默认收起），DeepSeek 的接口地址也挪进去。先选模型（只有一个时不显示），再改这个模型的三项，"保存"写入，"恢复默认"删掉对这个模型的修改。留空表示用默认值，输入框里灰字显示现在生效的值。
- 思考程度：其他厂商和自定义接口用一排复选框选档位，发给接口的值就用档位名（`low`、`high`……），"不思考"不发参数；一档都不选表示不支持思考。DeepSeek 的档位固定，只能选"支持思考"或"不支持思考"。
- 一次性调用的输出额度不超过这个模型设的最大输出；因此被截断时，提示说明是最大输出设小了、去哪里调。
- 档位名在页面上一律写中文（原来"思考强度"显示 DSH 给的英文 Low、High）。
- **不做：** 思考参数的写法（`thinkingFormat`：DeepSeek 式、通义式等）、思考的 token 预算、输入类型（文字、图片）。中转站的思考参数写法和 OpenAI 不同时，思考可能不生效，实际遇到再加。

## 其他基于 DSH 的产品（11-06）

你 11-06 问：Agentero 是不是 DSH 插件、市面上有没有和我们一样基于 DSH 打包成产品的项目，他们怎么选、我们能学什么。读了 2026-11-06 各项目 main 分支的源码、AGENTS.md、打包配置和发布工作流。

**Agentero（poco-ai/Agentero）不是 DSH 插件。** 它是 Tauri + Rust 的跨平台科研桌面应用，通过 ACP 把 DSH 当外部 Agent 调用（`dsh --profile acp`）；另开 `poco-ai/agentero-dsh-plugin` 发布 npm 组合包 `@poco-ai/agentero-dsh`（host、library、notes、pdf 四个插件，调用 Agentero CLI 读写同一份 Vault）。可参照的做法：

- 插件包发预构建的 `lib/`，不让用户从 `github:` 安装（pnpm 会拦 `prepare`，profile 里 `allowBuilds` 的键带 commit hash）；`engines.dsh` 写版本范围；推 `v*` 标签后校验 tag 与各包版本一致，先发子包再发根包，带 `-` 的版本发到 `next`。
- 发布：先原样复用 CI 校验 tag 对应的提交，再建 Draft Release，人工验收产物后发布；发布事件触发把附件同步到 AtomGit 国内镜像（挂在打 tag 后会因镜像滞后失败）。
- 仓库规范：Issue 表单（Bug、功能、RFC）和 PR 模板（前后截图、Demo、自查清单，图片传到 PR 评论而不进仓库）；`docs/bug_fix/` 只收会再犯的坑，每篇写原因、修复、验证；AGENTS.md 有一节 Windows 注意事项；dependency-cruiser 挡住分层违规。

**同类产品分四条路线：**

| 路线 | 代表 | 代价 |
|---|---|---|
| 装进官方 DSH 当插件 | DSH Tavern（flizzywine/dsh-tavern）、Jacky Creator | 用户要先装 DSH，DSH 升级就要跟着适配 |
| 用官方 npm 包自己组装、自带运行时 | 爪印 PawWork（Astro-Han/pawwork）、DS Bot（Fei2411/DS-Bot）、Dataelem 的 DSH Desktop、NekroNXT | 自己做安装包、更新、签名和升级验证 |
| DSH 源码作为子模块或 vendor 目录 | anywhere-labs/dsh-desktop、鲸屿 Whale Isle | 仓库大（鲸屿约 1.2 GB），上游同步是持续的工作 |
| 整个 fork 改名 | StaffDeck、papermachine | 基本放弃跟进上游和插件生态 |

我们属于第二条，最像的是 PawWork 和 DS Bot（都是 Electron 加锁定版本的 DSH、发 Windows 安装包）。第二条内部的分歧是改不改 DSH 的包：DS Bot 规定只用公开接口、绝不打补丁；PawWork、Dataelem、cocode 用 pnpm `patches/` 打小补丁（PawWork 有 3 个：默认工作目录改名、服务商兼容开关、MCP 的 OAuth）。

**值得参照的做法：**

- **国内下载：** PawWork 发布后把安装包镜像到 Cloudflare R2（`dl.pawwork.ai`），镜像前先校验 Release 完整，不完整就保留上一个好版本；鲸屿的下载表每行有 GitHub 和 CNB 两个链接；Tavern 走 jsDelivr，单个包要小于 20 MB。
- **插件坏了不拖死应用：** DSH 遇到解析不了的组合包、或一个按旧接口编的插件导入就抛错时，会整体回滚、每次启动都失败。PawWork 的 `dsh-profile-repair.ts` 从报错（`cannot resolve profile bundle "…"`、`failed to import loader entry … (…)`）认出是哪个包并从 profile 摘掉；Dataelem 提供安全模式（`--safe-mode`）暂时屏蔽第三方插件。
- **安装包冒烟跑完一轮对话：** DS Bot 的 `check-packed.mjs` 用假模型发消息、等到回复，再关窗口、重开、从托盘退出，并让打包后的 sharp、LibreOffice 各干一次活；PawWork 的 `dsh-packaged-closure.test.ts` 检查 DSH 声明成 peer 的内部包都进了打包闭包（electron-builder 只打 `dependencies` 能到达的包）。
- **DSH 升级前对比接口：** Tavern 的 `check-dsh-upgrade.mjs` 把用到的 DSH 包的版本、`exports` 和每个 `.d.ts` 的哈希存成审过的基线，换版本时出差异报告；必需检查被跳过、零个测试或进程崩溃都不算通过。
- **给自动开发的规矩：** DS Bot 有 issue 分诊技能，带 `maintainer` 标签的 issue 和 PR agent 不碰，没有证据不关 issue，安装问题有单独的 `install.yml` 表单；Tavern 让 agent 直接修原因明确的小问题，在 issue 里写清修复和验证再关闭；PawWork 要求 agent 和人守同一份公开贡献规则。
- **未签名安装包的说明：** DS Bot 写了 Edge"不常下载"、Win11"智能应用控制已阻止"（没有安全的绕过办法，改走别的安装方式）、杀毒软件拦截时用 `certutil -hashfile` 对照 `SHA256SUMS.txt`。
- **上手门槛：** DS Bot 首次启动可以用 DeepSeek 账号登录（手机号注册），不一定要 API Key。

**本项目建议：** 先补安装包冒烟（走完一轮对话加打包闭包测试）和未签名说明加 `SHA256SUMS.txt`；插件坏了自动停用、国内下载镜像各写提案；DSH 接口对比和 agent 规矩并进自动开发提案。不走 vendor 或 fork（违背"不 fork DSH"），也不做"启动器切到另一个 profile"（就是 11-06 决定不做的切换模式）。灰度更新要策略服务器，以现在的规模不需要。
