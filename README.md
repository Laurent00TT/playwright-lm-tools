# Playwright Browser Tools for Copilot

通过 VS Code **原生 Language Model Tool API**(`languageModelTools` 贡献点 + `vscode.lm.registerTool`)向 GitHub Copilot **Agent 模式**注册一组浏览器操控工具,内部用 `playwright-core` 以 **channel 方式**驱动本机 Edge/Chrome —— 不下载浏览器、不使用 MCP。

## 工具列表

| 工具 | 说明 |
| --- | --- |
| `pw_navigate` | 打开 URL(首次调用自动启动浏览器),返回页面标题 + 无障碍树快照 |
| `pw_snapshot` | 抓取当前页面无障碍树快照,交互元素带 `[ref=eN]` 标注 |
| `pw_click` | 按快照中的 ref 点击元素,返回新快照 |
| `pw_type` | 按 ref 向输入框输入文本,可选 `submit`(回车)/`slowly`(逐字符) |
| `pw_screenshot` | 截图存临时目录,支持 `fullPage`;新版 VS Code 下同时内联图片 |
| `pw_wait` | 等待固定秒数(≤30)或等待指定文本出现 |
| `pw_close` | 关闭浏览器,释放资源 |

浏览器实例在扩展内**单例共享、惰性启动**;`pw_navigate` 之外的工具在浏览器未启动时会返回提示文本而不是报错崩掉。所有错误都转成文本返回给模型,ref 失效/超时会附带"重新抓快照"的建议。

## 前置条件

- VS Code ≥ 1.106,已安装 **GitHub Copilot** 与 **Copilot Chat**
- Node.js ≥ 18(开发/编译用)
- 本机装有 **Microsoft Edge** 或 **Google Chrome**(Windows 11 自带 Edge;macOS 上若没装 Edge,请把 `pwTools.channel` 设为 `chrome`)

## 快速开始(F5 调试)

```bash
npm install
```

1. 用 VS Code 打开本目录;
2. 按 **F5**(或运行与调试 → "Run Extension")——会先执行 `npm: compile` 任务,再启动扩展开发宿主窗口;
3. 在开发宿主窗口打开 Copilot Chat,切到 **Agent 模式**;
4. 点输入框上方的 **工具(扳手)图标**,确认 `Browser: Navigate` 等 7 个工具已勾选;
5. 输入类似提示词:

   > 用浏览器打开 https://news.ycombinator.com,告诉我头条是什么,然后点进第一条链接。

   首次调用工具时 Copilot 会弹出确认框(Allow),之后模型就会自动串联 `pw_navigate → pw_snapshot → pw_click …`。

也可以在普通 Chat 里用 `#pwNavigate` 等引用名手动触发单个工具。

调试输出:查看输出面板的 **Playwright LM Tools** 频道,每次工具调用的入参和错误都会记录在那里。

## 配置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `pwTools.channel` | `msedge` | playwright channel,`msedge` 或 `chrome`;首选失败自动回退另一个 |
| `pwTools.headless` | `false` | 无头模式;默认有头方便观察 agent 操作 |
| `pwTools.snapshotMaxChars` | `24000` | 返回给模型的快照最大字符数,0 为不限 |

## 打包 VSIX

```bash
npm run package
```

生成 `playwright-lm-tools-0.1.0.vsix`(`playwright-core` 会作为运行时依赖一并打包,体积约 3 MB)。安装:

```bash
code --install-extension playwright-lm-tools-0.1.0.vsix
```

或 VS Code 扩展面板右上角 `…` → **Install from VSIX…**。

## 工作原理

- **注册**:`package.json` 的 `contributes.languageModelTools` 声明工具名、`modelDescription`(给模型看的说明)和 JSON Schema 入参;激活时 `vscode.lm.registerTool()` 挂上实现。Copilot Agent 模式会自动把这些工具放进工具清单。
- **ref 机制**:快照用 playwright-core 1.62+ 的公开 API `page.ariaSnapshot({ mode: 'ai' })`(playwright-mcp 所用内部 `_snapshotForAI()` 的转正形态,含 iframe,输出 `[ref=eN]`),旧版本自动降级到 `_snapshotForAI()` / `ariaSnapshot({ ref: true })`;点击/输入用 `aria-ref=eN` 选择器把 ref 解析回元素。页面变化后旧 ref 会失效,需重新抓快照。依赖锁定在 `~1.62.0`——这条 API 链在 1.5x → 1.62 间变过两次,不锁版本会静默漂移。
- **快照回传**:`pw_navigate` / `pw_click` / `pw_type` / `pw_wait` 执行后自动附带新快照,模型无需追加一次 `pw_snapshot` 调用。

## 故障排查

- **启动浏览器失败**:确认 Edge/Chrome 已安装;错误文本会列出两个 channel 各自的失败原因。公司环境若有策略限制,试试 `pwTools.headless: true`。
- **工具没出现在 Agent 工具清单**:确认扩展已激活(输出面板有 "Playwright LM Tools" 频道),Copilot Chat 版本较旧时需更新。
- **模型反复拿到 stale ref**:页面有自动刷新/懒加载,让模型先 `pw_wait` 再 `pw_snapshot`。
