# 开发约定：packages/

改 `packages/` 下的代码时，在[根目录的约定](../AGENTS.md)之外还要守这些规则。Claude 通过同目录的 [CLAUDE.md](CLAUDE.md) 读本文件。单元之间的服务、事件和数据归属见 [contracts.md](../docs/contracts.md)，界面的组件目录和截图方法见 `learning-ui-review` 技能。

## 单元与契约

- TypeScript + pnpm 工作区；DSH 锁定 `0.2.0-rc.2`。按本机这个版本的真实接口开发（`.tools/dsh/node_modules/@deepseek-ai/*/lib/types`），不凭印象。设计说明看 DSH 仓库（github.com/deepseek-ai/deepseek-harness）的 `docs/`（先读 `architecture.md`、`capability-seams.md`）和 `packages/client` 下各包的说明。
- 守[契约](../docs/contracts.md) §1 的总规则；服务、事件、接口和插槽的命名与写法见契约 §5–§7。`kit` 只放共用的辅助代码，不做业务数据的主人。
- 契约包会打进各单元，所以不用 `instanceof` 判断跨包的契约类。前端、后端分别做类型检查。

## 学习规则在代码里检查

这些规则要在执行操作的代码里检查，不能只写在提示词里：契约 §1 和 §4（证据日志）、§6 的交回主老师；[journey](../docs/journey.md#原则) 的原则（只有作答能证明掌握、帮助要记账、模型的知识不是出处）；各单元设计文档里的硬规则，例如练习题和测试预留题分开、讲义不写习题和测试安排、没有出处的段落标待核实、阶段设计先写验收和测试蓝图。

- 图片经用户消息输入模型，当前中转不支持工具结果里的图片；一次性调用带图片用 `kit` 的 `complete()` 的 `images`。手写判分前要学习者确认识别结果。

## 设置项

设置怎么存、默认值怎么跟上、密钥从哪读，见 [settings](../docs/settings/design.md)"设置存在哪、归谁"。写代码时：

- 学习者能改的选项写成单元 Config 的字段并加 `.volatile()`；单元要在 `package.json` 的 `peerDependencies` 里声明 `@deepseek-ai/schemastery`，否则 DSH 加载时找不到它。
- 密钥用 `kit` 的 `secret()` 按名称读取。
- 模型角色用 `roleModel()` 声明，自动列进"模型分工"；其他设置项由所属单元往 `learning.settings.services` 插槽登记一块，用 `SettingRow`、`Switch`、`SecretField`、`TestButton` 等共享控件。

## 前端

- 图标用 lucide-react 的线条图标（`strokeWidth` 1.75），不用 emoji。左边的图标栏只显示图标，悬停显示 2–4 字的名称（手机的底部导航栏把名称写在图标下）；设置这类工具入口放在图标栏底部（`placement: 'foot'`）。
- 页面不直接插 HTML（`dangerouslySetInnerHTML`、`innerHTML`）：Markdown 和外来文字交给 `learnShell.Markdown`，它在唯一的出口净化。
- 页面数据用 `kit` 的 `useLoad`，默认收到任何 `learning/` 推送就刷新；只有刷新会打断用户（比如作答中）时才缩小范围。依赖项写清这是哪一份数据（课程、节点……）：依赖项一变，旧数据立刻清空。一个组件里存着属于某门课的状态（草稿、总结）时，按课程加 `key`。
- 页面用 `kit/client` 的页面骨架（`Page`、`PageHeader`、`Section` 等），控件用共享设计控件，样式由 `shell.css` 统一维护。不直接显示浏览器默认控件，不用 `window.confirm/alert/prompt`。要新控件先补进共享库，底层保留语义 HTML、键盘操作和无障碍属性。
- 颜色和字号只用 `shell.css` 的 `--la-*` 变量（字号是 9 档 `--la-fs-*`），不在页面里写死。颜色分浅色、深色两套，新变量两套都要给。字重只用 400、500、600。
- 难撤销的操作（重新生成、删除等）用 `ConfirmButton` 原地二次确认；只有图标的按钮要给 `aria-label` 和 `title`。
- `useLocalState` 只存界面偏好，不存学习数据。
- 改完界面，在 1440、1024、760 宽度和 390 宽的手机（触屏模拟）、深浅两色下截图核对；窄屏样式用 `@container` 按所在栏的宽度写。

## 调用模型

- 能用程序做的不用模型（数值判分、单位换算、验算、掌握状态推导）；大任务拆小（讲义按块写、判分按维度判）；要求固定格式，程序校验，不合格重试；检索时给足资料，不靠模型的记忆。每个用到模型的环节配一小组标准样例，用 DeepSeek 跑通才算验收。
- 一次性调用（判分、总结、写讲义）都走 `kit` 的 `complete()`：它拒绝出错、截断和空的回复，不会把不完整的内容存下来。
- `deepseek-flash` 先思考再作答，思考也算在 `maxTokens` 里。输出额度要留足（判分、总结 4000，讲义 16000），太小会表现为"空回复"或"截断"。学习者在 设置 › 模型 › 高级设置 里设的最大输出会压低这个额度（`complete()` 取两者中较小的）。
- 模型在 JSON 里写 LaTeX 常常不双写反斜杠（`\rho` 会变成回车加 `ho`）。工具参数和 `parseJsonReply` 已统一修复；新写解析 JSON 的地方要用这两个入口。
- 新写一次性调用时，把所属角色的模型设置（`roleModel`）传给 `complete()`；它和 `selectSessionModel()` 每次调用时读当前设置。
- 写或改角色提示词、工具说明、简报和进度通知时，按 `learning-prompts-tools` 技能做。

## 组合包与 profile

- 不 fork DSH。学习工作台是组合包 `@learning-agent/app`：叠在 DSH 的基础组合包上，关掉 DSH 自带的界面和编程预设；单元和 Agent 预设写在 `packages/app/cordis.patch.yml`，改了要重启 DSH。新增单元要改这个文件、`packages/app/package.json` 和 `scripts/dev-profile.sh`，再运行 `sh scripts/dev-profile.sh`。
- 只有前端的包也要有一行和一个后端入口：DSH 加载每一行的后端入口后，才扫描前端模块。
- DSH 保存一项设置时，会把这一行的整份配置固定在学习者那一层。所以单元的插件行不带配置（默认值写在单元的 Config 里），设置也不放进预设这类带大段配置的行。
