# Chrome 剪藏路由器

这是一个本地优先的 Chrome 剪藏分发插件：在当前网页点开弹窗，先生成预览、确认内容，再把同一条网页素材同步到 Eagle、Bear 和 Obsidian。

它适合这样的工作流：看到一篇文章、一个设计案例、一条 X/Twitter 视频或一个产品页面时，不想分别手动保存三次，而是用一个入口采集标题、链接、正文、选中文本、截图和页面图片，然后按不同工具的规则分别写入。

## 它做什么

- **Eagle**：把网页截图、页面首图、HTML 快照、URL 书签或 X/Twitter 视频作为素材候选，确认后写入 Eagle，并自动补充中文标题、描述、标签和文件夹。
- **Bear**：生成阅读笔记预览，确认后写入 Bear；截图会作为真实附件处理，而不是把 base64 字符串塞进正文。
- **Obsidian**：按类似 Obsidian Web Clipper 的 typed properties 生成 Markdown，字段包括 `title`、`source`、`author`、`published`、`created`、`description`、`tags`，并且同样走确认后写入。
- **本地服务**：Chrome 插件只负责采集和展示，本地 Node 服务负责队列、模型摘要、适配器写入和结果记录。

## 项目结构

```text
extension/   Chrome Manifest V3 插件
server/      本地 Node 路由服务，监听 127.0.0.1:18791
docs/        同步规则和实现说明
```

## 快速开始

1. 安装本地服务：

   双击 `install.command`。

   安装脚本会创建用户级 LaunchAgent：
   `~/Library/LaunchAgents/com.link-router.local.plist`，启动本地服务，并自动生成内部 router token。日志会写到 `~/Library/Logs/LinkRouter`。

   如果弹窗提示无法连接本地服务，可以检查：

   ```bash
   curl http://127.0.0.1:18791/health
   ```

2. 加载 Chrome 插件：

   - 打开 `chrome://extensions`
   - 开启 Developer mode
   - 选择 Load unpacked
   - 选择项目里的 `extension/` 文件夹

3. 打开插件设置页，配置模型和 Bear 写入目标：

   - Base URL
   - Model
   - API Key
   - Bear note link / ID

   Router Token 是本地内部 token，正常情况下会自动配置，不需要手动填写。

## API

```text
POST http://127.0.0.1:18791/api/clip
GET  http://127.0.0.1:18791/api/tasks/:id
GET  http://127.0.0.1:18791/api/eagle/folders
POST http://127.0.0.1:18791/api/tasks/:id/confirm-eagle
POST http://127.0.0.1:18791/api/tasks/:id/confirm-bear
POST http://127.0.0.1:18791/api/tasks/:id/confirm-obsidian
GET  http://127.0.0.1:18791/health
```

弹窗是一个折叠式确认台：展开某个目标后会自动生成预览，用户确认后才真正写入。每个目标的预览字段不同：Eagle 展示标题、描述、链接、标签和真实 Eagle 文件夹下拉选择；Bear 展示标题、截图、描述和链接；Obsidian 按 typed properties 加正文的方式生成 Markdown。

Eagle 支持当前可见截图、页面首图、URL 书签和 HTML 快照模式。Bear 会压缩截图，并通过 AppleScript 打开较长的 x-callback-url，避免 macOS 参数长度限制。Obsidian 会尽量写入页面上可见的正文和图片 Markdown。

任务记录会追加到本地 JSONL 文件：

```text
~/.local/share/link-router/tasks/YYYY-MM-DD.jsonl
```

## 隐私说明

这个项目默认只监听 `127.0.0.1`。真实的 router token、模型 API Key、Bear note ID 等本地配置写在 `server/.env`，不会提交到 Git。公开仓库只包含 `.env.example`。
