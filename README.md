# 知微 Microsight

**一个陪你真正学会一门课的 AI 老师，跑在你自己的电脑上。**

知微把一门课交给一位 AI 老师来带：先和你商量学来做什么、要做到什么程度，摸清你已经会什么，再一个阶段一个阶段地写讲义、布置任务、出题检验。讲义和题目都有出处，学到的东西沉淀在一张知识网里，随时能看到你真正会了什么、凭什么这么判断。

*Microsight is a local study workbench: an AI tutor that plans a course with you, writes cited lessons from your own textbooks, and judges mastery only by what you can do without help.*

## 它怎么判断你学会了

只看一件事：**撤掉帮助后，你能不能独立做出来；隔一段时间还会，换一道题也会。**

- 读完了、聊得顺、打卡天数多都不算学会，只有作答能证明掌握。
- 看了提示、问过老师后答对，记为"有帮助完成"，之后还要一次独立完成。
- 进度用文字说明，不显示"掌握 87%"这类看似精确的数字。

完整的原则和学习流程见 [学习的原则和流程](docs/journey.md)。

## 能做什么

| | |
|---|---|
| **定目标** | 老师先给几个候选终点让你挑，写成目标说明，再按它排课程路线 |
| **摸底** | 一次一题，沿先修关系往上探、往下查，十题以内找到你的知识边界 |
| **讲义** | 一章一份，配合原书读；每段都标出处，可以点开看原文 |
| **资料库** | 导入 PDF 教材（扫描版也行，公式转成 LaTeX），全文和语义检索；老师也会联网找权威资料，按来源分级 |
| **测试** | 小测、阶段测试、结课检验；题目有出处和题源等级，计算题带单位判分，可以拍照作答 |
| **批注和答疑** | 在讲义上划线批注；选中任何内容在侧栏提问，答疑窗口和主老师分开，不打乱课程 |
| **知识网** | 每个知识点的掌握状态、证据和出处；隔段时间提醒复查 |
| **调度** | 首页告诉你下一步做什么、哪些测试没交、能不能赶上期限 |

## 安装

支持 Windows 10、11（64 位）。到 [Releases](https://github.com/sagemoyi/learning-agent/releases/latest) 下载 `Microsight-Setup-<版本>.exe` 运行，不用另装 Node 或别的软件。

- 安装包还没有代码签名，Windows 会提示"Windows 已保护你的电脑"：点"更多信息"，再点"仍要运行"。
- 第一次打开会问学习库放在哪里，默认 `文档\学习库`。
- 知微会自己检查更新，新版本下载好后问你要不要重启；更新前会先把学习库备份到学习库旁边的 `知微备份` 文件夹。
- 卸载不会删除学习库和备份。

也可以从源码运行，步骤见[开发说明](docs/development.md#从源码运行)。

## 你需要准备

- **模型的 API 密钥**：默认用 DeepSeek，也可以在设置页接入其他厂商或兼容 OpenAI / Anthropic 接口的服务。
- **可选的在线服务**：MinerU（解析 PDF，在 mineru.net 的 API 管理页申请）、Voyage AI（语义检索）、Exa / 博查 / Tavily（联网搜索）。不填也能用，对应功能会关掉或改用本机方式。

密钥都在设置页填写，只存在你的电脑上。

## 数据和隐私

- 学习数据放在你电脑上的 `文档/学习库` 文件夹里，是普通的 Markdown 文件和一个数据库，可以用 Obsidian 打开，也可以备份和恢复。
- 只有你用到的在线服务会收到数据：云端解析把 PDF 上传到 MinerU，语义检索把资料片段发给 Voyage AI，联网搜索只发要找的主题，和老师的对话发给你选的模型服务。你的教材和学习记录不会发给搜索服务。设置页"数据与隐私"逐项写明。
- 不用注册账号，不收集使用统计，也没有我们自己的服务器。

## 支持范围

现在只支持本机单用户。

| 环境 | 状态 |
|---|---|
| Windows 11 | 日常使用的环境 |
| Linux | 自动测试的环境（GitHub 上的[门禁](.github/workflows/gate.yml)） |
| macOS | 没验过 |
| 手机、读屏软件 | 布局和属性检查过，没在真机上用过 |

## 参与开发

知微基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件体系，用 TypeScript 写成。

- 构建、启动、测试、代码结构：[开发说明](docs/development.md)
- 开发约定（Claude、Codex 等助手共用）：[AGENTS.md](AGENTS.md)
- 现在在做什么：[docs/now.md](docs/now.md)；单元之间的契约：[docs/contracts.md](docs/contracts.md)
- 文档分别管什么：[learning-docs 技能](.agents/skills/learning-docs/SKILL.md)

问题和建议请在 GitHub 上提 issue。

## 许可证

MIT，见 [LICENSE](LICENSE)。
