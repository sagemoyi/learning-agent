# 开发约定（所有接手的助手共用）

本项目由不同的 AI 助手轮流开发（Claude Code、Codex 等），用户会在额度用完时换人接续。本文件是共用的开发约定，**接手第一件事是读它**。Claude 通过 [CLAUDE.md](CLAUDE.md) 引用本文件。

这些约定继承自已确认的 PLAN、接口契约和开发讨论。约定有变化时直接改本文件，并在[决策记录](docs/decisions.md)里注明。

## 接手时先做这几件事

1. 依次读：本文件 → [docs/PLAN.md](docs/PLAN.md)（总览，尤其"当前进度"）→ 要动的单元的设计文档 `docs/<单元>/design.md` → [docs/decisions.md](docs/decisions.md) 最后几条 → [docs/stage0/contracts.md](docs/stage0/contracts.md) → [docs/stage0/compatibility.md](docs/stage0/compatibility.md) 最后几节 → [docs/throughts.md](docs/throughts.md) 最后几条（用户最近说了什么）。
2. `git status`、`git log --oneline -10`：看清哪些是已提交的、哪些是上一位留下的未提交改动。**不要覆盖或丢弃别人的未提交代码**；接手时先验收（按 `learning-handoff-review` 技能），再决定保留、修改还是提交。
3. 跑一遍 `pnpm typecheck`、`pnpm test`、`pnpm build`，确认起点是绿的。`tests/flow.test.ts` 是最小学习流程的回归测试，必须一直通过。
4. 查本机是否还有本项目的 DSH 进程占着端口（见下文"本地环境"），不要误杀别的进程。

## 交接时要留下什么

- **进度**写进改动所属单元的设计文档的"现状"（已验收、骨架、待用户试用、还没做），再更新 PLAN 的单元地图和"当前进度"（做到哪了、待用户试用、下一步、待检测点）。只写现在的状态，经过写进提交说明和 compatibility.md。
- **验证结果**写进 compatibility.md（实测了什么、结果、发现的限制）。验收脚本和数据放 `.scratch/`，文档里只写结论，不写本机私有信息（中转地址、token、个人路径以外的账户信息）。
- **用户原话**追加到 throughts.md。
- **在验证过的节点提交**：提交说明写清做了什么；提交前确认 `.env`、`materials/`、`.scratch/`、`.data/` 等没有混进去。用户说"提交"时一定提交；自己在阶段节点提交的，要在汇报里说明。
- 汇报用中文、写给用户看：说清做完了什么、验证到什么程度、还差什么、需要用户决定什么。

## 技能：按需读取的做法说明

本文件只放随时都要遵守的规则，具体做法放在 `.agents/skills/` 的技能里，做对应的事时再读。

- **怎么读：** Codex 直接读 `.agents/skills/`。Claude Code 读 `.claude/skills/` 里的同名入口，入口指向同一份正文（本机建符号链接要管理员权限，所以不用链接）。
- **怎么改：** 只改 `.agents/skills/` 里的正文；改了名称或说明，要同步改入口。`tests/skills.test.ts` 会检查两边是否一致、链接是否有效。

| 技能 | 什么时候用 |
|---|---|
| `learning-handoff-review` | 接手、验收一轮开发、提交前自查 |
| `learning-ui-review` | 做或改界面、验收界面、关闭审美复核点 |
| `learning-prompts-tools` | 改角色提示词、工具说明、简报和进度通知、一次性调用的提示 |
| `learning-docs` | 写、改、精简文档和注释 |
| `learning-simplify` | 找能删或能合并的代码，单元做深前清理骨架遗留 |
| `learning-perf` | 测量和优化性能 |
| `learning-record-gif` | 给用户录演示 GIF |

技能只收被采纳、以后还会遇到的结论：验收发现和用户反馈被采纳后，写进对应技能的规则或例子；一次性的问题不写。这些技能的思路参考了 DSH 仓库的开发技能（MIT），按本项目改写。

## 开发顺序与范围

- 以 2026 年 10 月的研究报告和当前 PLAN 为依据；9 月的旧计划和旧 P0 项目已作废，不复用它们的设计。
- 先定方向、拆成插件、搭通最小学习流程，再按 PLAN 的学习旅程顺序逐个单元做深。
- 每个单元做深前先专门调研最佳做法（研究、开源实现、库和服务），然后讨论设计、写验收标准、实现并测试、让用户试用、更新这个单元的设计文档和 PLAN。骨架联调不代表单元已经做深。
- 前端是我们自己的产品：自己设计外壳、信息架构和交互；DSH 提供运行时和客户端内核。视觉可以参考 DSH 的简约风格，功能不能被 DSH 界面限制。
- 不随意改已确认的方向。需要改时先和用户讨论。

## 插件与数据契约

- TypeScript + pnpm 工作区；DSH 锁定 `0.2.0-rc.2`。先读本机该版本的代码（`.tools/dsh/node_modules/@deepseek-ai/*/lib/types`），按真实接口开发，不凭印象。
- 单元不互相 import 业务代码，通过 `@learning-agent/contracts` 的服务、类型和事件协作。`kit` 只放共用辅助代码，不成为业务数据的主人。
- 服务名用 `learn*`，事件用 `learning/*`，接口用 `/api/learning/<单元>.<方法>` 精确路由。不要接管 `/api` 的 RPC interceptor，它属于 DSH 网关。
- 每类数据只有一个真相来源，每张表和每个文件只有一个主人单元；跨单元修改调用主人的服务。
- 课程 Markdown 只通过 `core` 写入并保留变更记录。先写盘，再发事件；错误要向界面说明具体原因。
- 学习证据只追加，不修改或删除；掌握状态由证据规则推算并可重算。阅读、聊天、批注不直接证明掌握，帮助要记账。
- 练习题和测试预留题分开：摸底、小测、练习只用练习题池，阶段测试和模拟考只用测试预留题；教材不得出现习题、小测题或测试安排。
- 契约包会打入各单元，不用 `instanceof` 判断跨包的契约类。前后端分别做类型检查。
- 会随部署变化、学习者可以改的选项，写成单元的 Config 字段并加 `.volatile()`（设置页修改后不重启就生效）；单元在 `package.json` 的 `peerDependencies` 里声明 `@deepseek-ai/schemastery`，否则 DSH 加载时找不到它。密钥不写进 Config，用 `kit` 的 `secret()` 按名称读取。
- 设置页（`settings` 单元）读写 DSH 的设置、密钥、模型和插件服务，不读别的单元的业务字段：模型角色（`roleModel()`）自动列进"模型分工"；其他设置项由所属单元往 `learning.settings.services` 插槽登记一块，用 `SettingRow`、`Switch`、`SecretField`、`TestButton` 等共享控件。选回默认值时保存为"未设置"，以后单元改了默认值，学习者自动跟上。
- 内容和题目必须有可追溯出处，模型知识不是出处；无有效出处的教材块标为待核实。阶段设计先写验收与测试蓝图，再写教学内容；蓝图只写考什么、怎么考，不写具体题目。
- 写给学习者看的文字（目标、路线、设计书、教材、小结）不出现内部编号（`kn_`、`ck_` 等）；出处写成 `[《书名》p.页码](cite:片段ID)`。
- 图片经用户消息输入模型；当前中转不支持工具结果中的图片。手写判分前需要学习者确认识别结果。
- **交回主老师：** 学习者在页面上做完一件事（确认、交卷、点"完成"、加资料、新建课程）或后台任务结束（生成教材、资料解析），由负责的单元发 `learning/handoff`（一句话，不写内部编号）。主老师自己调用工具做的事不发。是否唤醒主老师由 `tutor` 按 `planner` 的下一步决定，单元不要自己给老师会话发消息。
- **前端**（组件目录、提示放在哪、截图方法见 `learning-ui-review` 技能）：
  - 图标用 lucide-react 的线条图标（`strokeWidth` 1.75），不用 emoji；侧栏页面按钮是"图标 + 2–4 字标题"；设置这类工具入口放侧栏底部（`placement: 'foot'`）。
  - 页面数据用 `kit` 的 `useLoad`，默认收到任何 `learning/` 推送就刷新；只有刷新会打断用户（如作答中）时才缩小范围。
  - 页面用 `kit/client` 的页面骨架（`Page`、`PageHeader`、`Section` 等），控件用共享设计控件，样式由 `shell.css` 统一维护。不直接显示浏览器默认控件，不用 `window.confirm/alert/prompt`。新增控件先补进共享库，底层保留语义 HTML、键盘操作和无障碍属性。
  - 颜色和字号只用 `shell.css` 的 `--la-*` 变量（字号是 9 档 `--la-fs-*`），不在页面里写死。颜色浅色、深色各一套，新变量两套都要给。字重只用 400、500、600。
  - 字重、配色这类审美方向目前由 Claude 决定（10-05 用户授权）。
  - 难撤销的操作（重新生成、删除等）用 `ConfirmButton` 原地二次确认；只有图标的按钮要给 `aria-label` 和 `title`。
  - `useLocalState` 只存界面偏好，不存学习数据。
  - 改完界面要在 1440、1024、760 宽度和深浅两色下截图核对。GPT 接续设计或调整的部分，在 PLAN"当前进度"里保留用户/Claude 的审美复核点（10-04 用户要求）。

## 调用模型的注意事项

- 一次性调用（判分、总结、写教材）都走 `kit` 的 `complete()`：它会拒绝出错、截断、空回复，不会把不完整的内容存下来。
- `deepseek-flash` 会先思考再作答，**思考也算在 `maxTokens` 里**。输出额度要留足（判分、总结 4000，教材 16000），额度太小会表现为"空回复"或"截断"。
- 模型在 JSON 里写 LaTeX 常常不双写反斜杠（`\rho` 会变成回车加 `ho`）。工具参数和 `parseJsonReply` 已统一修复；新写解析 JSON 的地方要用这两个入口。
- 每个角色用哪个模型是所属单元的设置项（`kit/settings` 的 `roleModel`，写作 `厂商/模型`），没设置时用 DSH 的默认模型。`complete()` 和 `selectSessionModel()` 每次调用时读取当前设置；新写一次性调用时，把所属角色的设置传给 `complete()`。
- 写或改角色提示词、工具说明、简报和进度通知时，按 `learning-prompts-tools` 技能做。

## 文档维护

- `docs/throughts.md` 保留用户原文，只追加不改写，保留现有拼写。实质性的设计或开发要求若尚未收录，按日期追加。
- 文档按单元分开，和代码的结构一致：
  - `docs/PLAN.md` 是总览（设计原则、单元地图、技术底座、模型策略、开发路线、当前进度）；
  - `docs/<单元>/design.md` 是单元的设计文档（管什么、现状、怎么运作、关键决定、待定问题），一个单元一份：改了哪个单元，就更新哪份；
  - `docs/journey.md` 写跨单元的学习流程；
  - `docs/decisions.md` 是决策记录，新决定按日期追加在表格末尾并注明来源。后来的决定取代、修改或了结了某一行时，在那一行的决策末尾注明是哪天的哪条，旧行其他内容不改；
  - `docs/history/` 是冻结的旧记录，不再修改。

  讨论或验收后更新对应的文档。使用清楚、易读的中文。
- 契约有补充或临时偏离时，更新 contracts.md 的"骨架阶段的补充"一节，写明原因和待确认事项，不悄悄当成已确认决定。
- 各文档管什么、怎么写、怎么精简，见 `learning-docs` 技能。

## 本地环境与验证

- 密钥只保存在 `.env`；不打印密钥、中转地址或本地 DSH 认证 token，不写入文档或提交记录。
- `.env`、`materials/`、`.tools/`、`.dsh-home/`、`.data/`、`.scratch/` 和构建产物不进 Git。教材和个人照片不是测试夹具；测试夹具用自己编写的合成资料（如 `tests/fixtures/`）。
- 学习数据默认位于 `文档/学习库`；本地开发用 `.data/`。
- DSH 从没有 `.env` 的目录启动，先通过 `.tools/dsh-env.sh` 导出环境变量（启动命令见 README）。端口约定：
  - `3180`：日常开发，数据在 `.data/`；
  - `3182`：验收用，数据在 `.scratch/smoke-data/`（只有合成数据）。启动前 `export LEARNING_HOME=<该目录>`。
- 后台任务停止后 DSH 的 Node 进程可能还在。重启前查端口归属，只结束命令行含 `dsh … bin.js learning` 的进程。
- 改了后端代码要重新 `pnpm build` 并重启 DSH；只改前端则重新构建后刷新页面。
- 学习工作台是组合包 `@learning-agent/app`：单元和 Agent 预设写在 `packages/app/cordis.patch.yml`，改了要重启 DSH。新增单元要改这个文件、`packages/app/package.json` 和 `scripts/dev-profile.sh`，再运行 `sh scripts/dev-profile.sh`。
- 已安装 profile 的 `cordis.patch.yml` 和 `package.json` 属于学习者：设置页保存的设置、组合包选择都在里面。`dev-profile.sh` 只在缺失时用 `profile/` 里的初始文件创建它们，不要手工覆盖。DSH 保存一项设置时会把这一行的整份配置固定在学习者那一层，所以单元的插件行不带配置（默认值写在单元的 Config 里），设置也不放进预设这类带大段配置的行。
- 用户已授权：真实模型联调**只用合成测试数据**。用真实教材做联调前要先问用户。
- 用 shell 的 heredoc 或单行脚本写含反斜杠的代码（正则、LaTeX）时，反斜杠可能被吞掉；写完要核对，或者改用直接写文件的工具。
- 按改动运行类型检查、相关测试和构建；骨架验收还要检查真实 DSH 插件加载、页面和最小学习流程。明确区分已验收能力和骨架占位功能。
- 跨单元测试用 `tests/harness.ts`（真实单元 + 假的 DSH 传输、会话、智能体和模型）。合成教材夹具放在 `tests/fixtures/`，用 `node tests/fixtures/build-middle.mjs <目录>` 从可读的 `source.md` 生成结构化结果。
- 资料解析和语义检索用在线服务（10-04 用户决定）：默认 PDF 上传到 MinerU 云端解析，用 Voyage AI 建语义索引和重排。解析方式（`parser`；`local` 为本机 MinerU，`pnpm mineru:start`，只监听 `127.0.0.1:16580`）和语义检索开关（`semanticSearch`）是 `library` 的设置项。`MINERU_API_KEY`、`VOYAGEAI_API_KEY` 每次使用时向 DSH 的密钥服务按名称读取：启动环境（`dsh-env.sh` 导出的 `.env`）优先，其次是设置页保存在 `.dsh-home/.credentials.yaml` 的密钥。合成 PDF 和验收脚本放 `.scratch/`。
- 自动测试不调用付费服务：`tests/harness.ts` 给 `library` 传本机解析、关闭语义检索，解析和检索的单元测试用假的服务地址。检索基准按需运行：`RETRIEVAL_BENCH=1 pnpm vitest run tests/retrieval-bench.test.ts`（需要 `VOYAGEAI_API_KEY`，只用合成资料）。
- 在线服务只发送合成数据做验收；把真实教材发往 MinerU 或 Voyage（包括在 3180 上重启后自动建索引）前先问用户。
- 3180 和 3182 用同一个 DSH profile（`.dsh-home/profiles/learning`）和密钥文件（`.dsh-home/.credentials.yaml`）：在 3182 上验收设置或密钥的写入，同样会改日常使用的设置。验收完要还原（删掉加的模型服务和密钥，profile 的 `cordis.patch.yml` 恢复原样）；添加模型服务用 `scripts/fake-openai.ts` 起一个本机假接口，不花钱。
- 3182 的验收目录 `.scratch/smoke-data/` 各助手共用，里面只能有合成数据。接手时如果 3182 上有别人留下的本项目 DSH 进程，先确认数据目录，不确定就重启。
- 内置浏览器面板隐藏时（`document.hidden` 为真），PDF.js 等依赖动画帧的渲染不会进行；这类视觉验收改用下一条的 headless Chrome 截图，仍做不了就如实写明"待用户试用"。
- 界面截图和演示 GIF 用项目自带的工具：
  - `scripts/browser.ts`：playwright-core 调用本机 Chrome，默认在浏览器里拦下写接口，只读验收；
  - `scripts/gif.ts`：把截图拼成 GIF。

  在后台启动 3182 时把输出写进 `.scratch/dsh-3182.log`，`scripts/browser.ts` 会从中读出带 token 的地址（不打印）。用法见 `learning-ui-review` 和 `learning-record-gif` 技能。
- 本机建符号链接需要管理员权限（git 的 `core.symlinks` 为 false），仓库里不用符号链接。Git Bash 会把以 `/` 开头的参数改写成 Windows 路径；需要原样传递时加 `MSYS_NO_PATHCONV=1`。
