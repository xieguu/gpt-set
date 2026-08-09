# GPT Set

GPT Set 是一个 Windows 本地工具集：使用独立 Chromium 环境管理多个 GPT 登录会话，并通过 MCP 把 ChatGPT 网页对话连接到一个可配置的本地工作目录。

## 功能

- 多个独立浏览器环境：Cookie、LocalStorage、IndexedDB、缓存及代理设置彼此隔离。
- 本地文件 MCP：在**选定工作目录**内列出、读取、创建、修改、移动、删除文本与图片。
- 图片桥接：Chrome 扩展捕获 ChatGPT 网页生成图片，MCP 再将其移动至指定目录。
- 应用内 MCP 工作区选择器：启动 GPT Set 后可通过界面修改本地文件根目录。

## 项目结构

```text
client/                         Electron 环境管理客户端
local-mcp-server/               本地文件 MCP（Streamable HTTP）
chatgpt-image-bridge-extension/ Chrome 图片桥接扩展
环境隔离多账号GPT浏览器客户端设计.md  设计文档
```

## 快速开始

### 1. 启动 Electron 客户端

```powershell
cd client
npm install
npm start
```

首次启动会尝试拉起本地 MCP 服务。主界面的“本地 MCP 工作区”区域可选择允许读写的固定文件夹。

### 2. 配置 MCP 服务

```powershell
cd ..\local-mcp-server
Copy-Item .env.example .env
notepad .env
npm install
npm start
```

默认工作目录：`C:\Users\<用户名>\Documents\GPT-Workspace`。

### 3. 连接 ChatGPT 网页插件

网页端无法访问 `127.0.0.1`。在另一个 PowerShell 窗口运行：

```powershell
.\start-with-tunnel.ps1
```

复制输出的 `https://*.trycloudflare.com`，在 ChatGPT 开发者模式的自定义 MCP 插件中填入：

```text
https://<tunnel-domain>/mcp?token=<MCP_TOKEN>
```

认证选择“无身份验证”。Tunnel 进程不能关闭。

### 4. 安装图片桥接扩展

1. 打开 `chrome://extensions` 并启用开发者模式。
2. 选择“加载已解压的扩展程序”。
3. 在 GPT Set 主界面点击“打开图片桥接扩展”，选择启动时自动写入的扩展目录。
4. 在扩展弹窗中确认端点和 `.env` 内的 `MCP_TOKEN`。

图片先写到 `.chatgpt-image-inbox`，然后让 ChatGPT 调用 `list_captured_images` 和 `save_captured_image` 保存到工作区目标路径。

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `list_directory` / `read_file` | 浏览文本、图片和目录 |
| `write_text` / `write_image` | 写入文本或 Base64 图片 |
| `save_image_from_url` | 下载公开 HTTPS 图片到工作区 |
| `create_directory` / `move_path` / `delete_path` | 文件系统 CRUD |
| `list_captured_images` / `save_captured_image` | 处理浏览器扩展捕获的图片 |

## 安全边界

服务只操作 `WORKSPACE_ROOT` 及其子目录，拒绝绝对路径、`..` 越界和符号链接。删除操作要求 `confirm=true`。不要把无 Token 的 MCP 服务公开暴露到互联网。

## 开发与验证

```powershell
# MCP 服务语法检查
node --check local-mcp-server\src\server.js

# Electron 主进程语法检查
node --check client\src\main.js
```

## 许可证

MIT，详见 [LICENSE](LICENSE)。

