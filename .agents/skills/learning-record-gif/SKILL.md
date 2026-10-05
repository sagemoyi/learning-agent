---
name: learning-record-gif
description: 需要给用户演示界面操作时使用：把新功能、修好的问题或需要用户试用的流程，录成三到六个画面的 GIF。用 scripts/browser.ts 在只有合成数据的 3182 上逐步截图，再用 scripts/gif.ts 拼成 GIF；画面里不能出现密钥、token 和真实学习数据。
---

# 录制演示 GIF

做一段简短、真实的界面演示。截图和拼接都在本地进行，不改任何远端状态。思路参考 DSH 的 `record-browser-gif`（MIT），按本项目改写：DSH 是把视频转成 GIF，我们用"分镜截图加纯 JS 编码"，不需要 ffmpeg。

## 什么时候录

- 汇报新功能或界面改动，想让用户不打开页面也能看懂的时候。
- 用户试用前，先演示一遍操作路径。

它不替代截图核对（learning-ui-review），也不是每次改动都要录。

## 要真实

- **演示当前代码**：先 `pnpm build`，确认 3182 跑的是这次的构建（改了后端要重启）。记下提交号，或者注明"未提交的改动"。
- **只用一次运行**：一个 GIF 的所有画面来自同一次运行。不拼接不同运行的画面，不补画缺失的状态。
- **用合成数据（3182）**：
  - 数据里没有的状态，可以用 `patch()`/`fake()` 显示，但说明里要写"部分画面来自浏览器里的模拟响应"；
  - 要演示真实模型的行为时，在 3182 的合成课程上真实走一遍（`openApp` 传 `allowWrites: true`），并在说明里写明。
- **画面里不能有**：密钥、带 token 的地址、`.env` 的内容、真实学习数据、无关的窗口。

## 录制

1. **准备**：3182 已经启动，输出写进了 `.scratch/dsh-3182.log`（`scripts/browser.ts` 从这里找地址）。想好一个三到六个状态的故事：起点 → 操作 → 结果。
2. **写场景脚本**：放在 `.scratch/`，用固定视口。推荐 1280×800，文字清楚，文件也不大。每个状态先等到能证明它出现的元素（文字、角色、类名），再截图；固定等待只用来等动画停下，不用来判断是否就绪。
3. **命名截图**：按顺序命名为 `00-…`、`01-…`，放在同一个目录里。

```ts
// .scratch/demo-search.ts，运行：node .scratch/demo-search.ts
import { openApp } from '../scripts/browser.ts'

const app = await openApp({ width: 1280, height: 800, run: 'demo-search' })
try {
  await app.nav('资料库')
  await app.shot('00-library')
  await app.page.getByRole('textbox', { name: '检索资料' }).fill('怎样判断层流还是湍流')
  await app.page.keyboard.press('Enter')
  await app.page.locator('.la-hit-head').first().waitFor()
  await app.shot('01-results')
} finally {
  console.log(JSON.stringify(await app.close()))
}
```

4. **拼成 GIF**：

```bash
node scripts/gif.ts .scratch/ui/demo-search --out .scratch/ui/demo-search.gif --durations 1.5,3
```

`--durations` 默认每帧 1.5 秒、最后一帧 3 秒；可以只给一个值（所有帧相同），也可以每帧给一个。以下情况会拒绝：少于两帧、各帧尺寸不同、要覆盖已有文件（确认后加 `--force`）。

## 检查成品

- 看编码器输出的 JSON：帧数、尺寸、总时长、字节数。一般应在几百 KB 以内，太大就减少帧数或换更小的视口。
- 用 Read 打开 GIF 和关键帧，确认文字清楚、状态正确、最后一帧停留够久、没有敏感内容。
- `git status` 确认截图和 GIF 只在 `.scratch/` 里。

## 交给用户

Claude 用 SendUserFile 发送 GIF；Codex 在汇报里给出路径。旁边写一句说明：

- 演示的是什么；
- 来自哪次构建；
- 哪些画面是模拟响应；
- 有没有真实模型参与。

GIF 不提交进仓库。
