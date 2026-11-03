# 本地开发与验收

怎么在本机构建、启动 DSH、测试、验收和截图。安装和日常启动命令见 [README](../README.md)；必须遵守的规则在 [AGENTS.md](../AGENTS.md)"安全与本地环境"，这里只写做法。

## 构建与启动

- 云端这类内存小的机器跑 `pnpm typecheck` 前先设 `NODE_OPTIONS=--max-old-space-size=8192`。
- 开发时 `.tools/dsh-env.sh` 把 `LEARNING_HOME` 设成仓库里的 `.data/`（学习数据默认在 `文档/学习库`），并导出 `.env` 里的密钥。
- DSH 要从没有 `.env` 的目录启动：它会自动读取当前目录的 `.env`，却拒绝 `.env` 里的 `DEEPSEEK_BASE_URL`（只接受启动环境传入）。所以先 `. .tools/dsh-env.sh` 把变量导出到环境，再进 `.dsh-home/work` 启动，命令见 README。
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

## profile 和组合包

- `sh scripts/dev-profile.sh` 安装 `learning` profile，链接我们的包并选中组合包 `@learning-agent/app`。profile 的 `cordis.patch.yml` 和 `package.json` 属于学习者（设置页存的设置、选中的组合包），脚本只在缺失时从 `profile/` 复制，不要手工覆盖；`pnpm-workspace.yaml` 也是，它让 profile 用自己的锁文件。没改依赖而仓库的 `pnpm-lock.yaml` 变了，就重跑它再还原。
- 3180 和 3182 共用 profile 的 `cordis.patch.yml` 和 `.dsh-home/.credentials.yaml`。在 3182 上验收设置或密钥前，先把这两个文件备份到 `.scratch/`；验收完删掉加的模型服务和密钥，两个文件恢复原样，再在页面上只读核对一遍。
- 要添加模型服务时，用 `node scripts/fake-openai.ts [端口]` 起一个本机假接口（默认 `http://127.0.0.1:16590/v1`），不花钱，它会打印每次请求的参数。

## 在线服务和密钥

各服务的设置项和密钥名见 [library](library/design.md)"在线服务"和"数据与接口"，密钥的读取顺序见 [settings](settings/design.md)"设置存在哪、归谁"，本机 MinerU 怎么启动见 README。

## 测试

- **两层，测的东西不同：**
  - 单元测试放在 `packages/<单元>/test/`，测规则和纯函数的边界情况，不启动别的单元；
  - 跨单元测试放在 `tests/<单元>/<功能>.test.ts`，按功能命名、不按开发批次，从工具、页面接口或事件走到数据库和课程文件，不再逐个列边界情况。
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
