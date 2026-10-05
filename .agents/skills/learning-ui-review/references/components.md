# 共享界面组件目录

页面和控件从 `@learning-agent/kit/client` 引入（源码 [`ui.tsx`](../../../../packages/kit/src/client/ui.tsx)、[`chat.tsx`](../../../../packages/kit/src/client/chat.tsx)），样式在 [`shell.css`](../../../../packages/shell/src/shell.css)。这里只写"什么时候用哪个"，参数以源码为准。

## 页面骨架

| 组件 | 什么时候用 |
|---|---|
| `Page` | 每个页面的外框。`width` 取 `reading`（读长文，如教材）、`default`、`wide`（放网格）或 `full`（占满）。聊天、整页阅读器这类占满标签页的页面不用它。 |
| `PageHeader` | 页首：`eyebrow` 小标题行、`title`、`description`、`meta`（标签）、`actions`（右侧操作）。 |
| `Section` | 页内分块：标题、图标、计数、操作、说明；`card` 时带卡片底。 |
| `Callout` | 提示块。`tone` 取 neutral、accent、ok、warn、bad，可带标题和操作按钮。 |
| `ErrorText` | 一行错误，配合 `useAction` 或 `useLoad` 的 `error`。 |
| `EmptyState` | 空状态；放在区块里时用 `compact`。 |
| `Skeleton` | 加载中的占位。 |
| `Tag` / `Dot` | 小标签和状态点，`tone` 同上；底色是 `--la-fill`。 |
| `Menu` | 一组操作或选项的下拉菜单，支持分组标题、分隔线和勾选项。 |
| `Kbd` | 快捷键提示。 |

## 控件

| 组件 | 什么时候用 |
|---|---|
| `Button` | `variant` 取默认、`primary`（一个区域通常只有一个主操作）、`quiet` 或 `danger`；`size` 取 `md` 或 `sm`；`loading` 表示执行中。只有图标时自动变成方形，必须给 `aria-label` 和 `title`。 |
| `ConfirmButton` | 难撤销的操作：点一次，在原处问一句，再点才执行；Esc 取消。 |
| `Field` | 表单项：标签、提示、`grow`。 |
| `TextField` / `TextArea` | 单行输入（可带图标、`onEnter`）/ 多行输入（随内容长高）。 |
| `NumberField` | 数字步进。 |
| `Select` | 下拉选择。自绘列表，靠近窗口底部时向上展开。 |
| `Segmented` | 两到四个互斥选项，方向键切换。宽度随选项，不会被撑满。 |
| `Checkbox` | 勾选；`card` 是选项卡片（选择题）。 |
| `Switch` | 立即生效的开关（设置项）；需要再点"保存"的勾选用 `Checkbox`。 |
| `SettingRow` | 设置页的一行：左边标题和说明，右边控件；窄时上下排。只放文字的值加 `la-setting-value`，与标题对齐。一组设置行放进 `la-settings-card`。 |
| `SecretField` | 只能写入的密钥：显示是否已填写、来自启动环境还是本机保存，可以替换和清除，从不显示内容。 |
| `TestButton` | "测试连接"一类检查：结果显示在按钮旁；`run` 返回毫秒数时显示"连接正常（1.2 秒）"。 |
| `Disclosure` | 可展开的补充说明，不用来做确认。 |
| `FileDrop` | 选择或拖入文件（底层是隐藏的 file input）。 |
| `Progress` | 进度条。 |
| `Composer` / `Chat` | 聊天输入框 / 主老师和侧边提问共用的聊天。 |

## 数据和状态

- `useLoad`：读页面数据。默认收到任何 `learning/` 推送就刷新；只有刷新会打断用户（如作答中）时，才用 `refreshOn` 缩小范围。
- `useAction`：执行一个操作，给触发它的按钮提供 `busy` 和 `error`。
- `useScope`、`useSelection`：当前在主界面还是某门课；页面上选中的内容。
- `useLocalState`：只存界面偏好（宽窄、开关），不存学习数据。
- `useSecrets(access, names)`：设置页里几个密钥的状态，设置页每次保存设置或密钥后重新读取。
- `describeError`、`shortTime`、`friendlyTime`：错误文案和时间显示。

## 外壳接口

- 页面注册到 `learning.page` 插槽（按页面 ID），用 `ctx.slots.inject(...)` 包住 `ctx.slots.register(...)`。
- 侧栏的页面入口用 `learnShell.registerActivity({ id, title, icon, scope, page, order })`，标题两到四个字；`setBadge` 显示待办数量。设置这类工具入口加 `placement: 'foot'`，放在侧栏底部的"外观"旁边（侧栏收窄时只剩图标）。
- 设置页"资料服务"里的区块注册到 `learning.settings.services`，用 `owner.access` 读写所属单元的设置和密钥。
- 左侧栏页面列表下方的区块注册到 `learning.sidebar`。
- 状态栏条目注册到 `learning.status`，只写几个字，点了能去对应页面。
- 课程进度页的区块注册到 `learning.course-section`。
- `openPage(page, params, { title, split })` 打开或聚焦标签页，`split` 表示在旁边分屏。
- `showSideChat()` 打开侧边提问，`select()` 设置选中内容，`learnShell.Markdown` 渲染 Markdown 和公式。

## 样式变量

| 用途 | 变量 |
|---|---|
| 底色 | `--la-bg*` |
| 文字 | `--la-text` ～ `--la-text-4` |
| 分隔线 | `--la-line*` |
| 强调色 | `--la-accent*` |
| 状态色 | `--la-ok*`、`--la-warn*`、`--la-bad*` |
| 小标签和图标底块 | `--la-fill` |
| 悬停、按下 | `--la-hover`、`--la-press` |
| 阴影 | `--la-shadow-*` |
| 焦点环 | `--la-ring` |
| 尺寸 | `--la-radius`、`--la-control`、`--la-control-sm` |
| 字号 | `--la-fs-2xs`（11）、`--la-fs-xs`（12）、`--la-fs-sm`（13）、`--la-fs-md`（14）、`--la-fs-lg`（15）、`--la-fs-xl`（16）、`--la-fs-2xl`（18）、`--la-fs-title`（24）、`--la-fs-display`（30），各档的用途写在变量旁边 |

颜色的深色版本在 `:root[data-la-theme='dark']` 里重新定义；字号不分深浅色。
