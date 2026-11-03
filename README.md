# 学习工作台（learning-agent）

一个本地运行的个人学习工作台，基于 DeepSeek Harness（DSH，cordis 插件体系）开发，一门课就是一个项目。Agent 当老师：和你确认目标，摸清你的知识边界，一个阶段一个阶段地写讲义、发布学习任务，用有出处的题目测试你；你随时可以在侧栏提问、在讲义上批注。学到的东西沉淀在一张知识网里：你真正会了什么、凭什么这么判断、这些知识从哪里来。判断"学会"只看撤掉帮助后能不能独立做出来，隔一段时间、换一道题还会不会。

- 现在在做什么、在等你什么：[docs/now.md](docs/now.md)；要你试用的：[docs/trial.md](docs/trial.md)
- 学习的原则和流程：[docs/journey.md](docs/journey.md)；每个单元怎么运作、为什么这样做：下表各单元的设计文档
- 单元之间的契约：[docs/contracts.md](docs/contracts.md)
- 开发约定（所有接手的助手共用）：[AGENTS.md](AGENTS.md)；本机构建、启动、测试和验收：[docs/development.md](docs/development.md)；开发技能：[.agents/skills/](.agents/skills)
- 各文档分别管什么：[learning-docs 技能](.agents/skills/learning-docs/SKILL.md)

## 目录

| 路径 | 内容 |
|---|---|
| `packages/core` | [核心](docs/core/design.md)：数据库和升级、课程文件读写、版本与变更日志、会话归属、学习证据日志、前端接口与变更推送、备份和恢复 |
| `packages/shell` | [外壳](docs/shell/design.md)：整页布局、图标栏和侧栏、标签页和历史、右侧栏、状态栏、深浅色、插槽、共享界面控件 |
| `packages/library` | [资料库](docs/library/design.md)：解析、切块、检索、出处定位、联网找权威资料 |
| `packages/knowledge` | [知识模型](docs/knowledge/design.md)：节点、关系、出处；全局图与课程局部图 |
| `packages/goal` | [目标](docs/goal/design.md)：目标协商、调研、目标说明和考试档案 |
| `packages/assess` | [题库与测试](docs/assess/design.md)：题源分级、题池、摸底、组卷、判分 |
| `packages/curriculum` | [课程设计](docs/curriculum/design.md)：路线、阶段设计书、课时与任务、复盘、结课 |
| `packages/textbook` | [讲义](docs/textbook/design.md)：一章一份配合原书读的笔记，段落块与出处 |
| `packages/annotation` | [批注](docs/annotation/design.md)：批注锚定、分类，转成信号或提案 |
| `packages/sidechat` | [侧边会话](docs/sidechat/design.md)：带页面上下文的隔离会话、总结、提案 |
| `packages/tutor` | [主老师](docs/tutor/design.md)：老师的会话和简报、交回主老师、课时小结、处理提案 |
| `packages/learner` | [掌握分析](docs/learner/design.md)：作答、帮助、信号 → 证据 → 掌握状态 |
| `packages/planner` | [调度](docs/planner/design.md)：下一步、没交的测试、建议的复查、回来后怎么接上、能不能赶上期限 |
| `packages/settings` | [设置](docs/settings/design.md)：模型、在线服务和密钥、外观、数据位置、插件清单 |
| `packages/contracts` | 契约包：ID、数据格式、服务/事件/插槽声明（不含业务逻辑，被打进每个单元的包里） |
| `packages/kit` | 共用辅助代码：一次性模型调用、设置读取、前端加载与操作状态、共享界面控件和聊天组件；不持有业务数据 |
| `packages/app` | 组合包 `@learning-agent/app`：在 DSH 服务端和客户端内核之上关掉 DSH 自带界面，挂上我们的单元和 Agent 预设 |
| `profile/` | `learning` profile 的初始文件（见 [development.md](docs/development.md)"profile 和组合包"） |
| `tests/` | 跨单元的自动测试：`flow.test.ts` 用合成资料跑通整条最小学习流程 |
| `scripts/` | 构建、装 DSH、安装 profile、启动本机 MinerU；界面截图（`browser.ts`）、演示 GIF（`gif.ts`）和验收用的假模型服务（`fake-openai.ts`） |
| `.agents/skills/` | 开发技能（`.claude/skills/` 是 Claude Code 读取的入口） |

每个单元的源码约定：`src/index.ts` 是后端入口，`src/client.tsx` 是前端入口；`package.json` 的 `exports` 指向 `lib/` 下的构建产物。

## 开发

需要：Node 24、pnpm 11，`.env` 里有模型和搜索服务的 key。DSH 版本锁定 `0.2.0-rc.2`，由 `scripts/setup-dsh.sh` 装到 `.tools/dsh`。

学习数据默认放在 `文档/学习库`，开发时在仓库的 `.data/`（不进 git，见 [development.md](docs/development.md)）。

```bash
pnpm install
sh scripts/setup-dsh.sh     # 新克隆先运行：装 DSH 到 .tools/dsh，生成 .tools/dsh-env.sh（已有的都不覆盖）
pnpm typecheck          # 前端、后端各检查一遍
pnpm test               # 自动测试（vitest），含最小学习流程
pnpm build              # 构建所有包到 lib/
sh scripts/dev-profile.sh   # 安装 learning profile（已有的不覆盖），链接我们的包并选中组合包
```

启动（必须在没有 `.env` 的目录里启动 DSH，原因见 [development.md](docs/development.md)）：

```bash
. .tools/dsh-env.sh && cd .dsh-home/work && dsh learning --no-open --port 3180
```

验收用的端口和数据目录、改了代码后怎么重新构建和重启，见 [development.md](docs/development.md)。

备份学习库：先停掉 DSH，构建后运行下面第一行；恢复只恢复到新文件夹，之后把 `LEARNING_HOME` 指向它再启动。密钥不在备份里，恢复后到设置页重填。备份带什么、恢复时怎么校验，见 [core](docs/core/design.md#备份和恢复)。

```bash
. .tools/dsh-env.sh && pnpm backup <目标目录>
. .tools/dsh-env.sh && pnpm restore <备份目录> <新学习库目录>
```

## 设置和在线服务

侧栏左下角的齿轮打开设置页（见 [settings](docs/settings/design.md)）。在线服务的密钥可以在设置页填，也可以写进 `.env`；各服务的密钥名、做什么、会发出去什么，见 [library](docs/library/design.md)"在线服务"和"数据与接口"。MinerU 的密钥在 mineru.net 的 API 管理页申请。

PDF 默认用 MinerU 云端解析。要在本机解析（设置 › 资料服务 › 解析方式选本机），先准备好 `.tools/mineru` 里的 MinerU 4.0.10 和下载好的模型，再在仓库根目录的 PowerShell 运行：

```powershell
pnpm mineru:start
```

脚本只监听本机 `16580`，已有服务时复用，启动时隐藏后台窗口；日志和解析器的临时文件在 `.scratch/mineru-runtime`。

## 许可证

MIT（和 DSH 及它的插件相同），见 [LICENSE](LICENSE)。问题和建议请在 GitHub 上提 issue。
