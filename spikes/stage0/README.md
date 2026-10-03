# 阶段 0 验证原型（spike）

这里是阶段 0 的 V2–V5 验证代码，用来确认 DSH 能按我们的设计用起来。**它不是产品代码**：正式开发时按 PLAN 的插件划分重写，这里只保留"怎么接 DSH"的可运行范例。

## 内容

| 路径 | 作用 |
|---|---|
| `learning-spike/lib/index.js` | 后端插件：自有接口 `learning/hello`（V3）、自定义搜索提供者 `learning-exa`（V5） |
| `learning-spike/lib/tool.js` | 只挂在主老师预设里的工具 `learning_progress`（V4） |
| `learning-spike/src/client.jsx` | 前端插件：占用 `root` 接管整页，dockview 布局，按预设建会话、发消息、看流式回复（V2、V4） |
| `learning-spike/lib/client.js` | 由 `build-client.mjs` 生成的前端包（DSH 客户端模块格式） |
| `profile/` | `learning` profile：DSH `web-app` + 关掉 DSH 的全部界面插件 + 两个 Agent 预设 |
| `build-client.mjs` | 用 esbuild 打包前端，并包成 `window.__ModuleLoader__.load({ id, factory })` 格式 |

## 运行

```bash
# 1. 打包前端（首次先 npm install）
cd spikes/stage0 && npm install && npm run build

# 2. 安装 profile 和插件（DSH 已装在 .tools/dsh，数据目录 .dsh-home）
cd ../.. && . .tools/dsh-env.sh
mkdir -p .dsh-home/profiles/learning && cp spikes/stage0/profile/* .dsh-home/profiles/learning/
cd .dsh-home/work && dsh plugin --profile learning add "link:$(cd ../../spikes/stage0/learning-spike && pwd -W)"

# 3. 启动（必须在没有 .env 的目录里启动，见 docs/stage0/compatibility.md V0）
dsh learning --no-open --port 3180
```

改了后端代码要重启 DSH；改了前端代码重新 `npm run build` 后刷新页面。

## 踩过的坑（都已在代码里处理）

- `/api` 通道只允许一个拦截器，已被 DSH 的 API 网关占用。抢占它会让 DSH 的全部接口 404。正确做法是在 `/api/learning/<名字>` 注册精确路由（`connection.fetch.register`），沿用 DSH 的 RPC 信封格式。
- `ui-settings` 不能关：它提供 `configForms` 服务，语言、主题等内核插件依赖它。
- `directory-picker` 依赖 `ui-workspace`，我们关掉了界面，所以把它也关掉。
- 前端里的 `window.__learningSpike` 只是调试用的句柄，正式代码不要保留。
