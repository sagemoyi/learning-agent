# 学习工作台（learning-agent）

一个本地运行的个人学习工作台，基于 DeepSeek Harness（DSH，cordis 插件体系）开发。

- 总体计划：[docs/PLAN.md](docs/PLAN.md)
- 接续开发的约定（所有接手的助手共用）：[AGENTS.md](AGENTS.md)
- 插件之间的契约：[docs/stage0/contracts.md](docs/stage0/contracts.md)
- 验证记录：[docs/stage0/compatibility.md](docs/stage0/compatibility.md)

## 目录

| 路径 | 内容 |
|---|---|
| `packages/contracts` | 契约包：ID、数据格式、服务/事件/插槽声明（不含业务逻辑，被打进每个单元的包里） |
| `packages/core` | `core` 单元（后端）：数据库、课程文件、变更与证据日志、会话归属、接口和变更推送 |
| `packages/shell` | 外壳（前端）：接管整页、活动栏、标签页、`learning.*` 插槽、`ctx.learnShell` |
| `packages/library` ～ `packages/planner` | 各功能单元的薄骨架：资料、知识、目标、测评、课程设计、教材、掌握分析、老师与侧边会话、下一步调度 |
| `packages/kit` | 共用辅助代码、前端加载与操作状态、老师和侧边会话共用的聊天组件 |
| `profile/` | DSH 的 `learning` profile：DSH 服务端 + 客户端内核，关掉 DSH 自带界面，挂上我们的单元和 Agent 预设 |
| `tests/` | 跨单元的自动测试：`flow.test.ts` 用合成资料跑通整条最小学习流程 |
| `spikes/` | 验证代码，不是产品代码 |

每个单元的源码约定：`src/index.ts` 是后端入口，`src/client.tsx` 是前端入口；`package.json` 的 `exports` 指向 `lib/` 下的构建产物。

当前状态：阶段 0 薄骨架和协同修整已验收；资料库已实现 PDF 自动导入、云端失败页段补跑、原文出处定位与混合检索，共享控件已完成并通过合成页面验收。其他单元继续按旅程顺序做深。进度、审美复核点与已知布局限制见 [PLAN §10](docs/PLAN.md)，联调记录见 [验证记录](docs/stage0/compatibility.md)。

## 开发

需要：Node 24、pnpm 11，DSH 已装在 `.tools/dsh`（版本锁定 `0.2.0-rc.2`），`.env` 里有模型和搜索服务的 key。

学习数据默认放在 `文档/学习库`；开发时 `.tools/dsh-env.sh` 把 `LEARNING_HOME` 设成仓库里的 `.data/`（不进 git）。

```bash
pnpm install
pnpm typecheck          # 前端、后端各检查一遍
pnpm test               # 自动测试（vitest），含最小学习流程
pnpm build              # 构建所有包到 lib/
sh scripts/dev-profile.sh   # 安装/刷新 learning profile，并把我们的包链接进去
```

启动（必须在没有 `.env` 的目录里启动 DSH，原因见验证记录 V0）：

```bash
. .tools/dsh-env.sh && cd .dsh-home/work && dsh learning --no-open --port 3180
```

验收时用只有合成数据的独立目录和端口，不碰日常数据：

```bash
. .tools/dsh-env.sh && export LEARNING_HOME="$PWD/.scratch/smoke-data" && cd .dsh-home/work && dsh learning --no-open --port 3182
```

改了前端代码：重新 `pnpm build` 后刷新页面。改了后端代码：重新构建并重启 DSH（结束占用端口的那个 `dsh … learning` 进程）。

## PDF 导入和原文阅读

默认用 MinerU 云端解析：在 `.env` 写入 `MINERU_API_KEY`（在 mineru.net 的 API 管理页申请）。PDF 会上传到 MinerU；超过 200 页的书自动分段提交、按原页码合并，几百页的教材几分钟完成。

要改用本机解析，启动 DSH 前设 `LEARNING_PARSER=local`。本机 MinerU 沿用已验证的 4.0.10，位于 `.tools/mineru`，模型须已下载（参见验证记录 V6），整本教材约 40 分钟。在仓库根目录的 PowerShell 先运行：

```powershell
pnpm mineru:start
```

脚本只监听本机 `16580`；已有服务时复用，启动时隐藏后台窗口。日志与解析器临时产物在 `.scratch/mineru-runtime`，学习工作台自己的原件、结果与任务则保存在当前学习数据目录。默认连接地址是 `http://127.0.0.1:16580`，可用 `LEARNING_MINERU_URL` 指向另一个本机端口。

打开“资料库”，选择或拖入不超过 200 MB 的 PDF，填写标题、页码偏移和课程角色，再点“上传并解析”。上传完成即可关闭页面；解析进度、失败原因、重试和取消都在“导入任务”里。服务未启动时原件保留，启动服务后点重试。程序重启会恢复未结束任务；解析器丢失任务时自动重新提交原件。

完成后点“阅读原文”，或从教材、聊天、检索结果点击出处。阅读器支持翻页、缩放、旋转和章节跳转，有完整几何信息时高亮引用区域；旧解析缺少页面尺寸时定位到页并保留识别文本。可在“校正书上页码”输入当前 PDF 页对应的书页，再换另一页核对固定偏移。

云端某个页段失败时，已完成部分会保存，程序按更小的页段自动补跑。多次失败会显示具体 PDF 页段；稍后点“重试”只补缺的页。资料只有完整解析并验证后才发布给老师。

同一 PDF 会复用已有资料；“重新解析”生成新快照，原出处和原件仍可打开。本课主动重解析后改为使用新版本，其他课程保留原来的版本。高级导入入口继续保留；原件为 PDF 的高级导入资料也可以直接重新解析。解析完成不等于识别文字已经人工核对，公式可对照原 PDF 查看。

## 语义检索

在 `.env` 写入 `VOYAGEAI_API_KEY` 后，资料导入完成会在后台建语义索引（资料卡显示进度），检索框和老师的查资料工具都按"关键词 + 语义 + 重排"检索，可以直接用问题检索；资料里没有相关内容时会明确说明。检索时问题和资料片段会发送到 Voyage AI。没有密钥或设了 `LEARNING_EMBEDDINGS=off` 时只按关键词检索。
