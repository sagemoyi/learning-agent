# 开发约定（所有接手的助手共用）

本项目由不同的 AI 助手轮流开发（Claude Code、Codex 等），用户额度用完时换人接续。本文件只放每次会话都要遵守的规则，细节链接到它们的家；改 `packages/` 下的代码另守 [packages/AGENTS.md](packages/AGENTS.md)。Claude 通过 [CLAUDE.md](CLAUDE.md) 读本文件。约定改了就直接改这里，原因写进提交说明。

## 按需读

- **每次：** 本文件、[now.md](docs/now.md)（现在在做什么、等用户什么、下一步）、[throughts.md](docs/throughts.md) 最后几条（用户最近说了什么）、`git status` 和 `git log --oneline -10`。
- **接手别人留下的提交或未提交改动：** 按 `learning-handoff-review` 先验收，再决定保留、修改还是提交；不覆盖、不丢弃别人的未提交代码。起点先跑 `pnpm typecheck`、`pnpm test`、`pnpm build`（新克隆先运行 `sh scripts/setup-dsh.sh`）。
- **改某个单元前：** 读 `docs/<单元>/design.md`；有进行中的提案，再读 `docs/<单元>/proposals/`。
- **改 `packages/` 下的代码前：** 读 [packages/AGENTS.md](packages/AGENTS.md)（插件、契约、前端、调用模型）。
- **改单元之间的服务、事件、数据归属或接口前：** 读 [contracts.md](docs/contracts.md)。
- **设计新功能前：** 读 [journey.md](docs/journey.md) 的原则和这个单元 `research.md` 里相关的节，再按"开发顺序"调研。
- **写测试，启动或重启 DSH、验收、截图、测性能前：** 读 [development.md](docs/development.md)。
- `docs/history/` 是冻结的旧记录：不默认读，也不作为现状的依据；要查以前的验证或决定时再搜。

## 文档：一件事一个家

各文档管什么、怎么写、怎么删减，见 `learning-docs` 技能。随时要守的：

- **只写现在。** 设计文档、契约、技能和注释描述当前的代码，变更经过留在提交说明和 git 里。设计文档不按批次分节，不留已验收的验收标准，不写"已完成、待试用"这类进度。
- **新功能先写提案**：`docs/<单元>/proposals/<日期>-<主题>.md`，写问题、方案、放弃的方案、验收标准、风险。验收后把现状并进设计文档、理由并进"关键决定"，再删掉提案。各单元的提案目录就是待办。
- **文档和代码同一次提交更新：**
  - 改了代码，就改它所属单元的设计文档；
  - 进度变了，才改 [now.md](docs/now.md)；
  - 要用户试用的写进 [trial.md](docs/trial.md)；
  - 用户的原话追加到 throughts.md；
  - 验证结果写进提交说明，发现的限制写进设计文档的"已知限制与以后再做"。
- 字数上限、链接和锚点、代码注释里的文档引用、调研记录的写法和跨文档的重复句子由 `tests/docs.test.ts` 检查；超了先把内容挪到它的家，再精简，确实需要时才调高上限。改名、改结构、改事实前，先搜一遍所有引用和其他写法。

## 交接

- 在验证过的节点提交，提交说明写清做了什么、怎么验证的。用户说"提交"时一定提交；自己在阶段节点提交的，要在汇报里说明。不推送，除非用户要求。
- 提交前确认 `.env`、`materials/`、`.scratch/`、`.data/` 等没有混进去。
- 按改动跑类型检查、相关测试和构建；`tests/flow.test.ts`（最小学习流程）必须一直通过。改了后端或页面状态，还要跑 `pnpm e2e`（真实 DSH）。分清已验收的能力和占位功能。
- 汇报用中文、写给用户看：做完了什么、验证到什么程度、还差什么、需要用户决定什么。

## 技能：按需读取的做法说明

具体做法放在 `.agents/skills/` 的技能里，做对应的事时再读。Codex 直接读 `.agents/skills/`，Claude Code 读 `.claude/skills/` 里的同名入口（本机建符号链接要管理员权限，所以入口是普通文件）。只改 `.agents/skills/` 里的正文；改了名称或说明，要同步改入口，`tests/skills.test.ts` 会检查。

| 技能 | 什么时候用 |
|---|---|
| `learning-handoff-review` | 接手、验收一轮开发、提交前自查 |
| `learning-ui-review` | 做或改界面、验收界面、关闭审美复核点 |
| `learning-prompts-tools` | 改角色提示词、工具说明、简报和进度通知、一次性调用的提示 |
| `learning-docs` | 写、改、精简文档和注释 |
| `learning-simplify` | 找能删或能合并的代码，单元做深前清理骨架遗留 |
| `learning-perf` | 测量和优化性能 |
| `learning-record-gif` | 给用户录演示 GIF |

技能只收被采纳、以后还会遇到的结论：写成技能的规则或校准例子，一次性的问题不写。思路参考 DSH 仓库的开发技能（MIT），按本项目改写。

## 开发顺序与范围

- 以 2026 年 10 月的[研究报告](docs/learning_agent_research_report.docx)、[journey.md](docs/journey.md) 的原则和各单元的设计文档为依据；9 月的旧计划和旧 P0 项目已作废，不复用它们的设计。
- 做一个功能：先调研最佳做法（研究、开源实现、库和服务），写提案和验收标准，实现并测试，再让用户试用。骨架联调不代表单元已经做深。用户试用后提的修改，改哪些、先改哪个由用户定。
- 设计上的取舍按调研的推荐项决定，写进设计文档的"关键决定"；改变已确认方向的事先和用户商量。
- 前端是我们自己的产品：自己设计外壳、信息架构和交互，DSH 只提供运行时和客户端内核。视觉可以参考 DSH 的简约风格，功能不受 DSH 界面限制。
- 字重、配色这类审美方向由 Claude 决定（10-05 用户授权）。GPT、Codex 等设计或调整的界面，在 [now.md](docs/now.md) 里留审美复核点（10-04 用户要求）。

## 安全与本地环境

做法见 [development.md](docs/development.md)。

- 密钥只存在 `.env`。不打印密钥、中转地址或本地 DSH 认证 token，也不写进文档或提交记录。
- `.env`、`materials/`、`.tools/`、`.dsh-home/`、`.data/`、`.scratch/` 和构建产物不进 Git。教材和个人照片不是测试夹具；夹具用自己编写的合成资料（`tests/fixtures/`）。
- 真实模型联调只用合成数据（用户已授权）。把真实教材发给模型、MinerU 或 Voyage 前先问用户，包括重启 3180（启动后会自动给真实教材建索引）。联网搜索验收只搜课程主题，加入的网上资料只放进 3182 的合成课程。
- 自动测试不调用付费服务（`.env` 导出到环境时会用真实密钥），做法见 [development.md](docs/development.md)"测试"。
- 端口分开用：3180 日常开发，3182 验收（只放合成数据，各助手共用），3184 规模测量（测完停掉）；数据目录见 [development.md](docs/development.md)"三个端口"。只结束命令行含 `dsh … bin.js learning` 的进程。
- 3180 和 3182 共用一份 DSH profile 和密钥文件：在 3182 上验收设置或密钥前先备份，验收完还原（做法见 development.md"profile 和组合包"）。
- 没有改依赖时 `pnpm-lock.yaml` 不该变；变了先用 `git checkout pnpm-lock.yaml` 还原再提交，原因见 [development.md](docs/development.md)"profile 和组合包"。
- 用 shell 的 heredoc 或单行脚本写含反斜杠的代码（正则、LaTeX）时，反斜杠可能被吞掉：写完核对，或者改用直接写文件的工具。
