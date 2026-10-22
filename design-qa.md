# UI 尺寸与主界面精简验收

结果：**passed**

2026-10-22，按用户最新反馈“收回一档”“去掉主界面 logo 和茶话间文字，只剩随机文案”“不要显示聊天内容已隐藏提示”，在 v0.64.0 雾蓝风格上收紧尺寸。以最新反馈为本轮验收依据，沿用配色与功能结构。

## 实现与尺寸

| 元素 | v0.64.0 | 本轮 |
|---|---|---|
| 主导航按钮 / 图标 | 44px / 30–32px | 40px / 28px |
| 会话列表宽度 | 240–300px | 240–280px |
| 搜索与聊天顶部栏 | 96px | 84px |
| 会话行高 / 头像 / 昵称 | 74px / 42px / 15px | 66px / 38px / 14px |
| 消息正文 / 气泡内边距 | 16px / 10×14px | 15px / 9×12px |
| 输入正文 / 工具图标 | 15px / 28px | 14px / 26px |
| 设置标题 / 导航图标 | 22px / 24px | 20px / 22px |

通讯录、文件柜、发送按钮和文件卡同步收紧。沿用已送达状态位置、输入快捷键提示、全部工具入口及浅深两套主题。没有采用全局缩放，也没有修改用户的缩放偏好。

进入主界面未选择会话、再次点击会话隐藏内容时，内容区域均只显示随机文案与署名；删除 logo、“茶话间”标题及额外提示。随机选择机制、翻译和重新打开会话保持可用。

## 视觉证据

- 实际截图：`/workspace/design/teahouse-implementation-compact/`，查看入口 `review.html`。
- 上版截图：`/workspace/design/teahouse-implementation-refined/`；上版验收报告存档于本轮 `verification/previous-design-qa.md`。
- `26-welcome-light.png`、`27-welcome-dark.png`、`28-hidden-conversation.png`：初始与隐藏状态仅有文案及署名。
- `01-chat-light.png`、`02-chat-dark.png`：1080×768 聊天实际界面，列表、顶部栏、消息、工具及输入区域比例协调。
- `23-chat-125.png`、`25-compose-english-125.png`、`18-settings-125.png`：真实 125% 缩放及英文长草稿。

排版、布局、颜色、图标、文案已核对。主内容区移除品牌图像后不再有该处图标与文字颜色不匹配的问题；雾蓝配色、已有头像与本地图标资源继续使用。未发现本轮范围内未关闭的 P0/P1/P2。

## 验证

使用本地构建的实际 Vue 组件，Electron **22.3.27 / Chromium 108 / Node 16.17.1**、Xvfb 和隔离会话 fixture。

- 初始与隐藏状态的内容节点仅为 `quote`、`quote-author`；无图片、SVG、标题或提示，点击会话正常恢复聊天。
- 私聊 8 个、群聊 7 个输入工具保留；实际检查表情、PK、历史、消息菜单、群成员、通讯录、两种文件柜、输入与拖动输入区。
- Ctrl+Enter 偏好即时更新帮助；Enter 换行、Ctrl+Enter 仅发送一次。
- 主窗口 1080×768、最小窗口 960×640；最小窗口真实 125% 缩放下浅深主题均无头部、工具栏、输入区横向溢出。
- 设置七个分区在 640×480 与真实 125% 缩放下无主体横向溢出，长页可滚动。
- `verification.json` 与 `details-verification.json`：renderer console error / pageerror 均为 **0**。
- `npm test`：**138 个文件、1014 项通过**；`npm run test:db`、`npm run typecheck`、`npm run build`（含五入口 bundle 检查）、`npm run smoke` 均以 **0** 退出。日志保存在证据目录 `verification/`。
- 没有新增依赖、远程资源或超出 Chromium 108 的 CSS 特性。

本轮为隔离 UI 与交互检查，未执行跨机器消息或文件传输，未在 Windows 7、macOS 真机复测字体和原生窗口边缘。UI 截图基于修改后的 0.64.0 本地构建；发布版本为 0.64.1，界面代码与已验收版本一致。
