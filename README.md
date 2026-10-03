# 学习工作台（learning-agent）

一个本地运行的个人学习工作台，基于 DeepSeek Harness（DSH，cordis 插件体系）开发。

- 总体计划：[docs/PLAN.md](docs/PLAN.md)
- 插件之间的契约：[docs/stage0/contracts.md](docs/stage0/contracts.md)
- 验证记录：[docs/stage0/compatibility.md](docs/stage0/compatibility.md)

## 目录

| 路径 | 内容 |
|---|---|
| `packages/contracts` | 契约包：ID、数据格式、服务/事件/插槽声明（不含业务逻辑，被打进每个单元的包里） |
| `packages/core` | `core` 单元（后端）：接口、变更推送；以后还有数据库、课程文件、变更日志、证据日志 |
| `packages/shell` | 外壳（前端）：接管整页、活动栏、标签页、`learning.*` 插槽、`ctx.learnShell` |
| `profile/` | DSH 的 `learning` profile：DSH 服务端 + 客户端内核，关掉 DSH 自带界面，挂上我们的单元和 Agent 预设 |
| `spikes/` | 验证代码，不是产品代码 |

每个单元的源码约定：`src/index.ts` 是后端入口，`src/client.tsx` 是前端入口；`package.json` 的 `exports` 指向 `lib/` 下的构建产物。

## 开发

需要：Node 24、pnpm 11，DSH 已装在 `.tools/dsh`（版本锁定 `0.2.0-rc.2`），`.env` 里有模型和搜索服务的 key。

```bash
pnpm install
pnpm typecheck          # 前端、后端各检查一遍
pnpm build              # 构建所有包到 lib/
sh scripts/dev-profile.sh   # 安装/刷新 learning profile，并把我们的包链接进去
```

启动（必须在没有 `.env` 的目录里启动 DSH，原因见验证记录 V0）：

```bash
. .tools/dsh-env.sh && cd .dsh-home/work && dsh learning --no-open --port 3180
```

改了前端代码：重新 `pnpm build` 后刷新页面。改了后端代码：重新构建并重启 DSH（结束占用 3180 端口的 node 进程）。
