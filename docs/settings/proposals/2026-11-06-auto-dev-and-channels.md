# 提案：服务器上的自动开发，和测试版、稳定版两个更新通道

## 问题

用户打算换一种开发方式（11-06，见 throughts.md）：在自己的 Ubuntu 服务器上部署 DSH，用 DSH 团队发布的 super-agent 改成贴合本项目的工作流，监听 GitHub issue，自动开发、回复；合并后自动发测试版；用户有空时让 Opus 审查，没问题再发稳定版；知微的使用者自己选择跟测试版还是稳定版。

现状：`desktop.yml` 只发一种版本（手动勾选 release 或推 `v*` 标签），已安装的知微用 electron-updater 从 GitHub Releases 的 `latest.yml` 更新，没有通道；开发靠用户在 Claude Code、Codex 里手动开会话。

## 方案

分三块：知微里的更新通道、GitHub 上的发布流水线、服务器上的自动开发。前两块不依赖服务器，可以先做。

### 调研结论

**super-agent**（[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)，MIT，标明是研究原型、不保证可用于生产）是一个 DSH 组合包，装在单独的 `superagent` profile 里：

- **结构：** 一个长期运行的路由会话只和人打交道、判断收不收；每个工单开一个独立的执行会话 `worker-<工单>`，在自己的 git worktree 里干活（`prepare` 命令建 worktree），做完在原来的 issue 里回复或开 PR。状态在一个 SQLite 文件里，有网页面板（默认端口 3082）。
- **怎么听 GitHub：** 轮询，不用 webhook，默认每分钟一次，所以服务器不用开公网端口。身份是一个专门的 GitHub 用户账号（不能用 GitHub App，因为它读这个账号的通知），要有仓库写权限，用只登录这个账号的 `gh` 包装命令。`@` 这个账号的新 issue 或评论会被收到；另有 `observeIssues`、`observePulls`、`observeComments`、`observeCi` 开关，默认关。
- **谁能派活：** `sources.github.allowed` 名单里的人点名它才是明确请求；名单外的人默认忽略。主动接活有 `off`、`observe`（默认，只记录"本来会接"）、`auto` 三档，文档建议先 `observe`，看过记录再开 `auto`。
- **安全：** 执行会话以操作者的系统用户、完全权限运行，命令拦截和 git 配置"不是安全边界"；提示注入、密钥泄漏没有解决。文档建议用只放代理凭据的专门系统账号。
- **要求：** Node 22.19+ 或 24、pnpm、git 2.32+、Python 3.8+、tmux、gh 2.48+；文档里装的是 DSH 0.2.1-rc.3，别的版本要满足它的 `engines.dsh`。用 `scripts/dsh-superagent start|status|restart` 在 tmux 里运行。
- **怎么定制：** 面板里的 Prompts（团队提示，含"交付要求"，决定什么时候自动合并，默认只在获批、改动少于 200 行时）、Policy（名单、规则）、Execution（模型、并发数、`prepare`、禁用命令）和 `skills/`。

**magpie**（[yetone/magpie](https://github.com/yetone/magpie)）公开能看到的：没有机器人在 issue 里回复，也看不到机器人开的 PR，issue 和修复由维护者处理（可能在内部用代理，公开页面看不出）；PR 只有协作者能开。值得学的是规范和节奏：`AGENTS.md` 指向子系统设计、代码规范、`contributors.md`（社区 PR 什么情况直接关）和 `LESSONS.md`（合并后发现做错的事和本该拦住它的规则）；GitHub Actions 自动发布，一个半小时能发十个补丁版，发布说明中英双语、致谢报告人，应用自己更新。它只有一个通道，没有测试版。

### 一、知微里的更新通道

- **两个通道：** 稳定版（默认）和测试版。测试版的版本号是 `x.y.z-beta.N`，GitHub release 标为预发布，带 `beta.yml`；稳定版带 `latest.yml`。electron-builder 打开 `generateUpdatesFilesForAllChannels`，稳定版也生成 `beta.yml`，这样跟测试版的人也会收到更新的稳定版。
- **主进程：** 通道存在应用设置（`%APPDATA%\Microsight\settings.json`）里，启动和切换时设 `autoUpdater.channel`（`beta` 时 electron-updater 会允许预发布）。不降级：从测试版切回稳定版时停在当前版本，等稳定版的版本号追上再更新，因为新版本可能已经迁移了学习库。
- **在哪里选：** 工作台设置页加"关于和更新"一节：当前版本、通道单选、"立即检查更新"。设置页在 DSH 页面里，窗口要加一个 preload，只给本机工作台的地址暴露 `getUpdateInfo`、`setUpdateChannel`、`checkForUpdates` 三个调用；在浏览器里开发时没有这个对象，这一节不显示。切到测试版时提示"测试版是自动开发、还没审查的版本，可能有问题；升级前会备份学习库"。

### 二、GitHub 上的发布流水线

- **版本号：** `apps/desktop/package.json` 的版本是下一个稳定版。测试版由 CI 在构建时改成 `<版本>-beta.<运行序号>`，不提交回仓库。
- **自动发测试版：** main 上的 `gate` 通过后（`workflow_run`），`desktop.yml` 构建、静默安装、冒烟测试，然后发预发布 release；同时只跑一个，新的排队时取消旧的。
- **审查后发稳定版：** 手动运行 `desktop.yml`，选"发布稳定版"并填要转正的测试版标签：从那个测试版的提交重新构建，版本去掉后缀，发正式 release，再由 CI 提交一次把 `package.json` 的版本加一。稳定版和审查过的代码是同一个提交。
- **Opus 审查：** 新增技能 `learning-release-review`：对比上一个稳定版和候选测试版之间的改动，按 `learning-handoff-review` 和代码审查找问题；有问题就开 issue 交给代理修，修完出新测试版，只复审增量；没有问题就转正。
- **发布说明：** 按提交和关联的 issue 自动生成中文说明，测试版注明"未审查"。

### 三、服务器上的自动开发

- **账号：** 新建一个 GitHub 用户账号作为代理（例如 `microsight-bot`），加为协作者；服务器上新建只放它凭据的系统用户，DSH 和 super-agent 都在这个用户下运行。
- **安装：** 按 super-agent 的部署文档装，DSH 版本先和它的 `engines.dsh` 对齐，再试能不能用我们锁的 0.2.2-rc.1；代理 profile 和开发知微用的 DSH 分开。模型用用户自己的 DeepSeek 密钥。
- **谁能派活：** `allowed` 只放 `sagemoyi`；主动接活先用 `observe`，`observeIssues` 打开，看一两周"本来会接"的记录再决定别人的 issue 要不要接。公开仓库谁都能开 issue，名单外的人始终不能直接派活。
- **贴合本项目：** `prepare` 从服务器上的克隆建 worktree，跑 `pnpm install --frozen-lockfile` 和 `sh scripts/setup-dsh.sh`；执行会话的团队提示要求先读 `AGENTS.md`，按它的顺序做（调研、提案、实现、测试），交付前跑 `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm e2e`（服务器装 Chrome），回复用中文写给用户看。服务器上没有真实教材，也不放 `.env` 里的知微密钥，测试不调用付费服务。
- **交付要求（什么时候自动合并）：** 门禁通过、改动少于 200 行、不碰受保护的路径时自动合并进 main，进而自动发测试版；碰了 `.github/`、`apps/desktop/`、`scripts/desktop/`、`scripts/dsh/`、`AGENTS.md`、`.agents/skills/`、依赖和锁文件，或者是新功能的提案，就停下等用户。main 打开分支保护，必须过 `gate`。
- **教训：** 学 magpie 的 `LESSONS.md`，但按本项目的规则放：审查发现代理做错、以后还会遇到的，写成技能里的规则或校准例子。

### 分步

1. 知微里的通道和设置页"关于和更新"（主进程、preload、设置页）；`desktop.yml` 支持测试版和转正，发一对测试 release 验证跨通道更新。
2. main 门禁通过后自动发测试版；`learning-release-review` 技能。
3. 服务器：代理账号和系统用户，装 DSH 和 super-agent，`observe` 模式，只接用户点名的 issue。
4. 按本项目改团队提示、`prepare` 和交付要求；跑几个真实 issue，再决定开不开自动合并和主动接活。

## 放弃的方案

- **GitHub App 或 Actions 里跑代理：** super-agent 要读账号通知，不支持 App；Actions 里跑没有长期会话，也拿不到审查和 CI 的后续事件。
- **用 webhook：** 要公网入口和签名校验，super-agent 本身是轮询，没必要。
- **测试版发到另一个仓库或另一个更新地址：** electron-updater 的通道在同一个 GitHub 仓库里就能分开，多一个仓库只多维护成本。magpie 用单独的 releases 仓库是为了签名和公证。
- **测试版每次提交都把版本号提交回 main：** 每次发版都多一个机器人提交，还会和代理的分支冲突；版本号在 CI 里算。
- **允许降级回稳定版：** 学习库可能已经被新版本迁移，旧版本打不开；等稳定版追上更安全。

## 验收标准

- 设置页能看到版本和通道；切到测试版后，在测试 release 上从 `a-beta.1` 更新到 `a-beta.2`；再发稳定版 `a`，测试版用户和稳定版用户都更新到它；切回稳定版时不降级。
- 浏览器里开发时不显示"关于和更新"，也不报错。
- main 上门禁通过后自动出现预发布 release，稳定版用户收不到它。
- 转正流程发出的稳定版和被审查的测试版是同一个提交，之后 `package.json` 的版本自动加一。
- 服务器上，用户在 issue 里 `@` 代理，代理在 issue 里中文回复并开 PR，PR 过门禁；名单外的人 `@` 它不会开工；`observe` 模式只记录不接活。
- `tests/flow.test.ts` 一直通过。

## 风险

- **super-agent 是研究原型：** 文档说发布版和内部版不同、可能有缺陷；它锁的 DSH 版本和我们的可能不一致。先在 `observe` 和只接用户点名的范围里跑。
- **安全：** 执行会话完全权限，公开 issue 里可能有提示注入。靠专门的系统用户、只放代理凭据、名单外不派活、受保护路径人工合并来限制；服务器上不放其他密钥。
- **测试版质量：** 自动合并的改动没经过审查就发给跟测试版的人。默认稳定版，切换时明确提示，升级前备份学习库。
- **下载量：** 安装包两百多 MB，测试版频繁时下载多；靠差分更新（blockmap）和安装包精简缓解，必要时把测试版改成每天最多一次。
- **和安装包精简并行：** 精简改的是打包，第一步要改 `apps/desktop` 和 `desktop.yml`，等精简合并后再开始。
