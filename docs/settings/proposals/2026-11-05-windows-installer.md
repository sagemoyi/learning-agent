# 提案：知微（Microsight）的 Windows 安装包

## 问题

学习工作台现在只能按开发者的方式用：装 Node 24 和 pnpm，跑 `setup-dsh.sh`、`pnpm build`、`dev-profile.sh`，profile 用 `link:` 链到仓库源码，再从命令行启动 DSH（见 README"开发"）。改代码、重建、重启都会打断学习，别人也装不上。用户要求公开发布一个成熟的产品（11-04、11-05，见 throughts.md）：

- 产品名：知微，英文 Microsight；图标：白底黑色的学士帽简笔画。
- 公开发布，仓库已经公开；只发 GitHub Releases，带自动更新，签名尽量免费；暂不做 macOS。

DSH 的三条分发路径（官方组合包、社区 dspack 整合包、Windows 安装包）的对比见 11-04 的调研文档（[学习工作台发布路径调研](https://claude.ai/artifact/LnKskmvsmPMDALB7H7sKEG)）。结论：组合包装进官方桌面端会替换它的整个界面（工作台关掉了 DSH 的全部界面，桌面端只有一个受管的 `desktop` profile），dspack 要依赖闭源、禁止商用、要求 WSL2 的第三方启动器，所以做我们自己的安装包。

## 方案

### 结构

新增 `apps/desktop`（Electron 主进程，不是 DSH 插件，所以不放在 `packages/`）。安装包里带三样东西，学习者的电脑上什么都不用另装：

1. 便携 Node 24（`node.exe`），和门禁、开发用的大版本一致。
2. 锁定版本的 DSH：按 `scripts/dsh/package-lock.json` 装好的 `node_modules`。
3. 预装好的 `learning` profile：构建时在临时 `DSH_HOME` 里用 `dsh plugin add` 装进打包好的工作台（第 2 步的 tgz），pnpm 用 `node-linker=hoisted` 生成扁平目录，不含符号链接。

Electron 不在自己的进程里跑 DSH，而是用带的 `node.exe` 起一个子进程运行 `dsh learning --no-open --port <空闲端口>`，从输出里读出带 token 的地址，在自己的窗口里打开。这样运行时和开发、门禁完全相同，也不用验证 Electron 自带的 Node 能不能用 `node:sqlite`。

构建顺序：`pnpm build`、`pnpm dist`、`node scripts/desktop/stage.mjs`（在目标平台上把 Node、DSH 和 profile 放进 `apps/desktop/.stage`），再在 `apps/desktop` 里 `npm run package`。`.github/workflows/desktop.yml` 在 Windows 上走完这几步，静默安装后用 `scripts/desktop/smoke.mjs` 启动，等窗口显示出工作台，安装包留作运行产物。

### 运行时的行为

- **目录：** `DSH_HOME` 放在用户的应用数据目录（`%LOCALAPPDATA%\Microsight`）；学习库默认 `文档\学习库`，首次启动可以改，记在应用设置里，启动时作为 `LEARNING_HOME` 传给子进程。不读任何 `.env`。
- **profile 归谁：** 首次启动把预装的 profile 复制到 `DSH_HOME`。之后升级只替换我们的包和 `package.json` 里的组合包列表；`cordis.patch.yml`（设置页存的设置）和 `.credentials.yaml`（密钥）属于学习者，不覆盖，和 `dev-profile.sh` 的规则一致。
- **首次启动向导：** 选学习库位置；说明模型和 MinerU 要用学习者自己的密钥、MinerU 云端会上传教材，然后打开设置页填写。
- **单实例：** 再次打开只把已有窗口调到前面。关窗口即退出：先请 DSH 正常结束，超时再结束子进程，不留后台 Node 进程。
- **升级前备份：** 版本号变了就在启动 DSH 前跑一次备份（`core` 的 `backup`，DSH 停着时才能做），备份放在学习库旁边，保留最近几份。
- **应用设置**（学习库位置、日志）在 `%APPDATA%\Microsight`：Electron 遇到非 ASCII 的产品名会直接用 `%APPDATA%` 本身，所以主进程显式命名。
- **卸载：** 不碰学习库，也不碰备份。
- **隐私：** DSH 的匿名统计（`product-analytics`）组合包里已经关掉；安装包另外确认 DSH 的遥测都关着，写进隐私说明。

### 发布和更新

只走 GitHub Releases：NSIS 安装包 `.exe`，先不签名，首版发布后申请 SignPath Foundation 的免费开源签名。SignPath 要求项目已经发布、在 CI 里从源码自动构建、每次签名人工批准、主页上有"Code signing policy"和隐私说明。

- **发布：** `apps/desktop/package.json` 的版本号就是知微的版本。改版本号合进 main，在 Actions 页面手动运行 `desktop` 并勾选 release（或推送 tag `v<版本>`），工作流在 Windows 上构建、静默安装、冒烟测试通过后，把安装包、`.blockmap` 和 `latest.yml` 发成 release。
- **更新：** 外壳用 electron-updater 读最新 release 的 `latest.yml`，启动时和之后每 6 小时查一次，后台下载（能按块只下变了的部分），下好后问"现在重启"还是"稍后"，稍后就在下次关闭时安装。新版本第一次启动时照常先备份学习库。更新日志在应用设置目录的 `logs\update.log`。

### 分步

每步验收通过再做下一步，各自一次提交。

1. **升级 DSH** 到当时的 latest，按 development.md"DSH 的依赖"的做法，跑全部检查和 `pnpm e2e`。
2. **工作台打成一个可安装的包：** 一个构建脚本把 14 个单元和组合包打成同一版本的 tgz，声明 `engines.dsh`；在全新的 `DSH_HOME` 里 `dsh plugin add` 后能直接启动，`pnpm smoke` 在这个装法上通过。开发时的 `link:` 装法不变。
3. **Electron 外壳和 NSIS 安装包：** 上面的运行时行为，产品名、图标、开始菜单快捷方式。
4. **发布和自动更新：** 上面的发布流程和 electron-updater；README 的"安装"一节写下载和 SmartScreen 怎么放行；发 v0.1.0。
5. **签名：** 仓库加隐私说明和签名政策页，申请 SignPath。

## 放弃的方案

- **装进官方 DSH 桌面端或 CLI 的组合包**：桌面端只有一个 profile，装进去会替换学习者原来的 DSH；CLI 要求会装 Node 和敲命令。设置页"关键决定"里已有"暂不做成别的 DSH 用户能安装的插件"，这个方案不改变它。
- **dspack 整合包**：依赖闭源、禁止商用、要求 WSL2 的 DSHL 启动器，学习库和本机 MinerU 都在 Windows 一侧。
- **DSH 跑在 Electron 自己的 Node 里**（官方桌面端的做法）：要处理 Electron 的 Node 和 `node:sqlite`、原生模块的兼容，运行时也和开发、门禁不同；外置 `node.exe` 只多几十 MB。
- **Tauri**：照样要带一个 Node 跑 DSH，省不下体积，社区也没有 DSH 的先例。
- **买 OV 证书、Azure Artifact Signing**：前者每年要钱，后者个人用不了。
- **Microsoft Store（MSIX）**：Store 能免费签名和更新，但注册开发者要税号，你没有（11-05 决定先只发 GitHub release）。

## 验收标准

1. 在没有装 Node 的全新 Windows 11 上，装 `.exe` 后从开始菜单打开"知微"，窗口里显示工作台，不弹命令行窗口。
2. 首次启动能选学习库位置，默认 `文档\学习库`；在设置页填的密钥和设置重启后还在。
3. 再次打开只激活已有窗口；关掉窗口后没有残留的 Node 进程。
4. 从一个版本升级到下一个版本：启动前生成了备份，学习库、设置和密钥都没变。
5. 卸载后学习库和备份都在。
6. 打 tag 后 CI 产出安装包、通过冒烟测试并发成 release。
7. 装着旧版本的知微能自动下载新 release，重启后是新版本，学习库先备份过。
8. 开发流程不变：`setup-dsh.sh`、`dev-profile.sh`、`pnpm e2e` 照常；`tests/flow.test.ts` 通过。

## 风险

- **DSH 还是预发布版**，大约一周一版，插件按精确的 DSH 版本检查。安装包锁定版本反而隔离了这个风险，但要定期升级、重跑 `pnpm e2e`。
- **路径长度和符号链接：** pnpm 的目录又深又多符号链接，NSIS 对两者都不友好。第 2、3 步用 `hoisted` 验证过能装能用；安装太慢时再把 DSH 的依赖用 esbuild 打成少量文件。
- **体积：** 现在 DSH 的 `node_modules` 约 518 MB（Linux），里面有用不到的包（如 LibreOffice WASM）。第 3 步量出的 NSIS 安装包 276 MB，在 GitHub 的 Windows 机器上静默安装要 3 分半（解出上万个小文件），装好后约 10 秒显示工作台；裁剪 DSH 的依赖或打成少量文件能同时缩短两者。
- **DSH 子进程可能被留下：** 正常退出会先停 DSH；外壳被任务管理器强行结束时子进程还在，下次启动换一个端口照样能用，但多一个后台 Node。以后用 Windows 作业对象或启动时清理处理。
- **不签名的 `.exe`** 会被 SmartScreen 提示"未知发布者"，README 要写明怎么放行，直到拿到 SignPath 签名。
