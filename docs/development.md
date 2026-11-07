# 本地开发与验收

怎么从源码运行、在本机构建、启动 DSH、测试、验收和截图，以及代码怎么分。必须遵守的规则在 [AGENTS.md](../AGENTS.md)"安全与本地环境"，这里只写做法。

## 从源码运行

需要：Node 24、pnpm 11（确切版本见 `package.json`），`.env` 里有模型和搜索服务的 key（只跑测试不需要）。DSH 版本锁定 `0.2.2-rc.1`，它的全部依赖由 `scripts/dsh/package-lock.json` 锁定，由 `scripts/setup-dsh.sh` 装到 `.tools/dsh`。

学习数据默认放在 `文档/学习库`，开发时在仓库的 `.data/`（不进 git，见下文"三个端口"）。

```bash
pnpm install --frozen-lockfile
sh scripts/setup-dsh.sh     # 新克隆先运行：装 DSH 到 .tools/dsh，生成 .tools/dsh-env.sh（已有的都不覆盖；装的和锁文件不一致时报告并停下）
pnpm typecheck          # 前端、后端各检查一遍
pnpm test               # 自动测试（vitest），含最小学习流程
pnpm build              # 构建所有包到 lib/
pnpm smoke              # 构建后：真实 DSH + 合成数据 + 假模型的冒烟测试，不需要 key，要本机有 Chrome
pnpm e2e                # 同上，再加整条学习流程和高风险页面场景，几分钟
sh scripts/dev-profile.sh   # 安装 learning profile（已有的不覆盖），链接我们的包并选中组合包
```

启动（必须在没有 `.env` 的目录里启动 DSH，原因见下文"构建与启动"）：

```bash
. .tools/dsh-env.sh && cd .dsh-home/work && dsh learning --no-open --port 3180
```

备份学习库：先停掉 DSH，构建后运行下面第一行；恢复只恢复到新文件夹，之后把 `LEARNING_HOME` 指向它再启动。密钥不在备份里，恢复后到设置页重填。备份带什么、恢复时怎么校验，见 [core](core/design.md#备份和恢复)。

```bash
. .tools/dsh-env.sh && pnpm backup <目标目录>
. .tools/dsh-env.sh && pnpm restore <备份目录> <新学习库目录>
```

## 构建与启动

- 云端这类内存小的机器跑 `pnpm typecheck` 前先设 `NODE_OPTIONS=--max-old-space-size=8192`。
- pnpm 独立版自带 Node 22，可能警告 `Unsupported engine`；脚本用 PATH 上的 Node，`node -v` 是 24 就可以。
- 开发时 `.tools/dsh-env.sh` 把 `LEARNING_HOME` 设成仓库里的 `.data/`（学习数据默认在 `文档/学习库`），并导出 `.env` 里的密钥。
- DSH 要从没有 `.env` 的目录启动：它会自动读取当前目录的 `.env`，却拒绝 `.env` 里的 `DEEPSEEK_BASE_URL`（只接受启动环境传入）。所以先 `. .tools/dsh-env.sh` 把变量导出到环境，再进 `.dsh-home/work` 启动，命令见上文"从源码运行"。
- 改了前端：`pnpm build` 后刷新页面。改了后端：`pnpm build` 后重启 DSH。改了 `packages/app/cordis.patch.yml` 也要重启。
- 后台任务停止后 DSH 的 Node 进程可能还在：重启前按端口找到它，核对命令行含 `dsh … bin.js learning` 再结束。
- 仓库里不用符号链接（本机要管理员权限）。Git Bash 会把以 `/` 开头的参数改写成 Windows 路径，需要原样传递时加 `MSYS_NO_PATHCONV=1`。

## 三个端口

| 端口 | 用途 | 数据目录 |
|---|---|---|
| 3180 | 日常开发，用户试用 | `.data/` |
| 3182 | 验收，只有合成数据 | `.scratch/smoke-data/` |
| 3184 | 规模测量（几千个知识节点这类） | `.scratch/perf-data/` |

- 3182、3184 启动前 `export LEARNING_HOME=<该目录>`。
- 在后台启动 3182 时，把输出写进 `.scratch/dsh-3182.log`，截图工具从这里读出带 token 的地址（不打印）：

  ```bash
  . .tools/dsh-env.sh && export LEARNING_HOME="$PWD/.scratch/smoke-data" && cd .dsh-home/work && dsh learning --no-open --port 3182 > ../../.scratch/dsh-3182.log 2>&1
  ```
- `.scratch/smoke-data/` 各助手共用。接手时 3182 上已有本项目的 DSH 进程，先确认它的数据目录，不确定就重启。
- 3184 不往 3182 的共享数据里灌数据，测完停掉；截图工具用 `openApp({ port: 3184 })`。

## 在服务器上运行

部署到 Linux 服务器、经 Cloudflare 隧道远程访问（方案见[远程访问提案](settings/proposals/2026-11-07-remote-server.md)）。服务器要有 Node 24 和 pnpm 11，下面以 `/opt/node-v24…/bin` 为例。

1. 单独的系统用户，数据只有它能读：`sudo useradd --system --create-home --home-dir /data/microsight --shell /usr/sbin/nologin microsight`。之后的命令用 `sudo -u microsight -H bash -c '…'`，PATH 里加上 Node。
2. 以它的身份 `git clone` 到 `/data/microsight/app`，按"从源码运行"装依赖、`setup-dsh.sh`、`pnpm build`；把 `.tools/dsh-env.sh` 的 `DSH_HOME` 改成 `/data/microsight/dsh-home`、`LEARNING_HOME` 改成 `/data/microsight/学习库`，建好这两个目录，再跑 `dev-profile.sh`。
3. `/etc/systemd/system/microsight.service`：`User=microsight`，`Environment=` 设 PATH（含 Node）、`HOME=/data/microsight`、`LANG=C.UTF-8`，`Restart=on-failure`，启动命令：

   ```bash
   /bin/bash -c 'cd /data/microsight/app && . .tools/dsh-env.sh && cd "$DSH_HOME/work" && exec dsh learning --no-open --host 127.0.0.1 --port 3190 --public-url https://<子域名> --trusted-host <子域名>'
   ```

   `systemctl enable --now microsight` 后只在 `127.0.0.1:3190` 监听，不带 token 的请求返回 401。带 token 的地址在 `journalctl -u microsight` 的 `dsh web:` 行，每次重启都换。
4. cloudflared 的 ingress 在兜底规则前加 `hostname: <子域名>` → `http://127.0.0.1:3190`，`ingress validate` 后重启隧道；DNS 加一条指向隧道的 CNAME；再给这个子域名配 Cloudflare Access。
5. 更新：以 microsight 身份 `git pull`、`pnpm install --frozen-lockfile`、`pnpm build`，再 `systemctl restart microsight`。

## profile 和组合包

- `sh scripts/dev-profile.sh` 安装 `learning` profile，链接我们的包并选中组合包 `@learning-agent/app`。profile 的 `cordis.patch.yml` 和 `package.json` 属于学习者（设置页存的设置、选中的组合包），脚本只在缺失时从 `profile/` 复制，不要手工覆盖；`pnpm-workspace.yaml` 也是，它让 profile 用自己的锁文件。没改依赖而仓库的 `pnpm-lock.yaml` 变了，就重跑它再还原。
- 3180 和 3182 共用 profile 的 `cordis.patch.yml` 和 `.dsh-home/.credentials.yaml`。在 3182 上验收设置或密钥前，先把这两个文件备份到 `.scratch/`；验收完删掉加的模型服务和密钥，两个文件恢复原样，再在页面上只读核对一遍。
- 要添加模型服务时，用 `node scripts/fake-openai.ts [端口]` 起一个本机假接口（默认 `http://127.0.0.1:16590/v1`），不花钱，它会打印每次请求的参数。它会答什么写在文件开头。

## DSH 的依赖

- `scripts/dsh/` 的两个文件决定 `.tools/dsh` 里的每个包，`scripts/dsh/check.mjs` 按锁文件核对（`--list` 列出清单）。不一致时 `setup-dsh.sh` 停下：停掉 DSH、删掉 `.tools/dsh` 再运行。
- 升级或修公告单独一次提交：改 `scripts/dsh/package.json`（修传递依赖写 `overrides`，升级 DSH 时再看能不能删；工作区里同一个包写进 `pnpm-workspace.yaml`），在临时目录 `npm install --package-lock-only` 后拿回锁文件，重装，在 `.tools/dsh` 跑 `npm audit --omit=dev`，再跑全部检查和 `pnpm e2e`。cordis、schemastery 的新版可能和我们的类型对不上，不跟着升。

## 在线服务和密钥

各服务的设置项和密钥名见 [library](library/design.md)"在线服务"和"数据与接口"，密钥的读取顺序见 [settings](settings/design.md)"设置存在哪、归谁"，本机 MinerU 怎么启动见下文"本机解析 PDF"。

## 测试

- **三层，测的东西不同：**
  - 单元测试放在 `packages/<单元>/test/`，测规则和纯函数的边界情况，不启动别的单元；
  - 跨单元测试放在 `tests/<单元>/<功能>.test.ts`，按功能命名、不按开发批次，从工具、页面接口或事件走到数据库和课程文件，不再逐个列边界情况；
  - 浏览器测试放在 `scripts/e2e/scenarios.ts`，只测前两层走不到又坏不起的：DSH 的插件加载和智能体循环、页面状态、断线和重启。
- `pnpm dist` 把构建好的单元和组合包打成 `dist/` 里的 tgz（不带依赖和 source map，组合包声明 `engines.dsh`），`LEARNING_E2E_PACKED=1 pnpm smoke` 在全新 profile 里装这些 tgz 再测，验证安装包里的装法。
- `pnpm smoke`、`pnpm e2e` 构建后运行：临时目录、随机端口、假模型和能掐断连接的代理，不碰 3180、3182，不读 `.env`；`node scripts/e2e/run.ts <场景>…` 只跑几个。老师的回合用假模型的 `【工具】` 消息编排，工具走真实的智能体循环。失败截图在 `.scratch/ui/e2e/`，DSH 输出在 `.scratch/e2e-dsh.log`。
- [门禁](../.github/workflows/gate.yml)在每次推送和 PR 上跑安装、类型检查、测试、构建和 `pnpm e2e`，不放密钥。
- `tests/` 顶层只放整个仓库的检查：最小学习流程（`flow.test.ts`）、文档、技能、包依赖、GIF 脚本。
- 只把昂贵或不确定的部分换成假的（模型、网络、时钟、DSH），其余用真的。跨单元测试用 `tests/harness.ts`（假的只有 DSH 的传输、会话、智能体和模型），它给 `library` 传本机解析、关闭语义检索；跨单元测试不调用 `searchWeb`。解析、检索和联网搜索的单元测试用假的服务地址。
- 同一进程里的测试文件共用已加载的单元（`isolate: false`）：测试改了假时钟、`process.env` 或 spy，在 `afterEach` 里还原。重试间隔这类等待用假时钟跳过，不真等。
- 功能改了，同一次提交改它的测试；功能删了，测试一起删。生产代码里没人调用的函数不因为有测试而留着。测试共用一份准备、接着用前面的状态时，留在同一个文件里。
- 加迁移时不重新生成 `tests/fixtures/backup-*`（旧程序写的备份，测试从它升级）；隔段时间用 `FIXTURE_BACKUP=tests/fixtures/backup-<日期>` 跑恢复演练加一份。
- `pnpm coverage` 列出测试从没跑到的代码：先查有没有生产调用者，没有就删，有就是缺测试。不设覆盖率门槛。
- 合成教材夹具放在 `tests/fixtures/`，用 `node tests/fixtures/build-middle.mjs <目录>` 从可读的 `source.md` 生成结构化结果。合成 PDF 和验收脚本放在 `.scratch/`。
- 检索基准按需运行，要 `VOYAGEAI_API_KEY`，只用合成资料：`RETRIEVAL_BENCH=1 pnpm vitest run tests/library/retrieval-bench.test.ts`。

## 截图和演示

- `scripts/browser.ts` 用 playwright-core 调本机 Chrome 截图，默认在浏览器里拦下写接口，只做只读验收；`scripts/gif.ts` 把截图拼成 GIF。用法见 `learning-ui-review` 和 `learning-record-gif` 技能。
- 内置浏览器面板隐藏时（`document.hidden` 为真），PDF.js 这类依赖动画帧的渲染不会进行。这类视觉验收改用 `scripts/browser.ts` 的 headless Chrome；还是做不了，就如实写"待用户试用"。

## 本机解析 PDF

PDF 默认用 MinerU 云端解析。要在本机解析（设置 › 资料服务 › 解析方式选本机），先准备好 `.tools/mineru` 里的 MinerU 4.0.10 和下载好的模型，再在仓库根目录的 PowerShell 运行：

```powershell
pnpm mineru:start
```

脚本只监听本机 `16580`，已有服务时复用，启动时隐藏后台窗口；日志和解析器的临时文件在 `.scratch/mineru-runtime`。

## 代码结构

| 路径 | 内容 |
|---|---|
| `packages/core` | [核心](core/design.md)：数据库和升级、课程文件读写、版本与变更日志、会话归属、学习证据日志、前端接口与变更推送、备份和恢复 |
| `packages/shell` | [外壳](shell/design.md)：整页布局、图标栏和侧栏、标签页和历史、右侧栏、状态栏、深浅色、插槽、共享界面控件 |
| `packages/library` | [资料库](library/design.md)：解析、切块、检索、出处定位、联网找权威资料 |
| `packages/knowledge` | [知识模型](knowledge/design.md)：节点、关系、出处；全局图与课程局部图 |
| `packages/goal` | [目标](goal/design.md)：目标协商、调研、目标说明和考试档案 |
| `packages/assess` | [题库与测试](assess/design.md)：题源分级、题池、摸底、组卷、判分 |
| `packages/curriculum` | [课程设计](curriculum/design.md)：路线、阶段设计书、课时与任务、复盘、结课 |
| `packages/textbook` | [讲义](textbook/design.md)：一章一份配合原书读的笔记，段落块与出处 |
| `packages/annotation` | [批注](annotation/design.md)：批注锚定、分类，转成信号或提案 |
| `packages/sidechat` | [侧边会话](sidechat/design.md)：带页面上下文的隔离会话、总结、提案 |
| `packages/tutor` | [主老师](tutor/design.md)：老师的会话和简报、交回主老师、课时小结、处理提案 |
| `packages/learner` | [掌握分析](learner/design.md)：作答、帮助、信号 → 证据 → 掌握状态 |
| `packages/planner` | [调度](planner/design.md)：下一步、没交的测试、建议的复查、回来后怎么接上、能不能赶上期限 |
| `packages/settings` | [设置](settings/design.md)：模型、在线服务和密钥、外观、数据位置、插件清单 |
| `packages/contracts` | 契约包：ID、数据格式、服务/事件/插槽声明（不含业务逻辑，被打进每个单元的包里） |
| `packages/kit` | 共用辅助代码：一次性模型调用、设置读取、前端加载与操作状态、共享界面控件和聊天组件；不持有业务数据 |
| `packages/app` | 组合包 `@learning-agent/app`：在 DSH 服务端和客户端内核之上关掉 DSH 自带界面，挂上我们的单元和 Agent 预设 |
| `profile/` | `learning` profile 的初始文件（见上文"profile 和组合包"） |
| `tests/` | 跨单元的自动测试：`flow.test.ts` 用合成资料跑通整条最小学习流程 |
| `scripts/` | 构建、装 DSH（`dsh/` 是它的锁文件）、安装 profile、启动本机 MinerU；界面截图（`browser.ts`）、演示 GIF（`gif.ts`）、假模型服务（`fake-openai.ts`）和真实 DSH 上的浏览器测试（`e2e/`） |
| `.agents/skills/` | 开发技能（`.claude/skills/` 是 Claude Code 读取的入口） |

每个单元的源码约定：`src/index.ts` 是后端入口，`src/client.tsx` 是前端入口；`package.json` 的 `exports` 指向 `lib/` 下的构建产物。
