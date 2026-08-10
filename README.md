# GPT Set

GPT Set 是一个 Windows Electron 客户端，用独立 Chromium partition 管理多个 ChatGPT 登录会话，并通过可多开的本地 MCP 实例让网页对话读写指定本地目录和图片。

## 主要功能

### 浏览器环境

- 每个账号使用独立 Cookie、LocalStorage、IndexedDB、缓存和 Service Worker。
- 环境可单独设置系统代理或自定义 HTTP/HTTPS/SOCKS 代理。
- 支持创建、编辑、复制、归档、导入和导出环境元数据。
- 更新或回退程序不会删除 `%APPDATA%\gpt-set-client\Partitions` 中的登录会话。
- `environments.json` 使用原子写入、BOM 兼容和 `.bak` 自动恢复。

### MCP 多实例

- 一个界面同时管理多个 MCP 实例。
- 每个实例拥有独立的工作目录、端口、Token、进程和 Cloudflare Quick Tunnel。
- 端口可手动选择，也可自动查找空闲端口。
- 支持单独启动、停止、重启、删除、轮换 Token，以及全部启动/停止。
- 启动后通过带鉴权的 `/health` 校验服务身份，避免把“端口已占用”误判为启动成功。
- 服务和 Tunnel 日志直接显示在实例卡片中。

### 文本和图片

- MCP 可在限定工作目录内列出、读取、创建、修改、移动和删除文件。
- 支持 PNG、JPEG、WebP、GIF 的读取、Base64 写入和 HTTPS URL 下载。
- 图片桥接扩展支持不同 MCP 端口，并为每个浏览器环境生成独立配置。
- 图片捕获带队列、并发限制、失败重试和有界去重。

## 项目结构

```text
client/                          Electron 客户端与 MCP 进程管理器
local-mcp-server/                Streamable HTTP 本地文件 MCP
chatgpt-image-bridge-extension/  ChatGPT 图片捕获扩展
设计说明.md                       架构设计文档
```

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本
- npm
- 可选：`cloudflared`，仅公网 MCP 地址需要

`cloudflared.exe` 可通过 `CLOUDFLARED_PATH` 指定，或放在 `D:\cloudflared\cloudflared.exe`、`local-mcp-server\cloudflared.exe`、系统 `PATH` 中。

## 安装与启动

```powershell
git clone https://github.com/xieguu/gpt-set.git
cd gpt-set\client
npm install
npm start
```

客户端首次启动会：

1. 从原有 `local-mcp-server\.env` 迁移默认工作区、端口和 Token；
2. 在 `%APPDATA%\gpt-set-client\mcp-instances.json` 创建多实例配置；
3. 自动启动标记为“随应用启动”的 MCP 实例；
4. 保留已有浏览器账号和 partition。

## 使用 MCP 多实例

1. 打开主界面的 **MCP 地址**。
2. 点击 **新增实例**。
3. 填写实例名称并选择允许访问的本地文件夹。
4. 输入 `1024–65535` 范围内的端口，或点击 **自动端口**。
5. 保存后点击 **启动**。
6. 如需连接 ChatGPT 网页端，点击 **启动 Tunnel**，再复制实例卡片中的公网地址。

本地地址可以同时存在：

```text
http://127.0.0.1:8787/mcp
http://127.0.0.1:8788/mcp
```

Quick Tunnel 公网地址示例：

```text
https://example.trycloudflare.com/mcp?token=<自动生成的实例Token>
```

Quick Tunnel 地址会在进程重启后改变；需要固定域名时应改用 Cloudflare Named Tunnel。

## 绑定浏览器环境

在“新建环境”或“编辑环境”窗口中选择 **MCP 实例**。GPT Set 会为该浏览器 partition 生成独立的图片桥接扩展目录，并写入对应的本地端口和 Token。

Electron 环境会自动加载扩展，不需要手动进入 `chrome://extensions`。只有在外部 Chrome 中使用扩展时，才需要手动加载 `chatgpt-image-bridge-extension` 并在扩展弹窗中设置端点。

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `list_directory` | 列出目录 |
| `read_file` | 读取文本或图片 |
| `write_text` | 创建或覆盖 UTF-8 文本 |
| `write_image` | 写入 Base64 图片 |
| `save_image_from_url` | 从公开 HTTPS URL 保存图片 |
| `create_directory` | 创建目录 |
| `move_path` | 移动或重命名 |
| `delete_path` | 确认后删除文件或目录 |
| `get_file_info` | 获取文件元数据 |
| `list_captured_images` | 查看扩展捕获的图片 |
| `save_captured_image` | 将捕获图片移动到目标目录 |

## 本地数据

```text
%APPDATA%\gpt-set-client\environments.json       浏览器环境元数据
%APPDATA%\gpt-set-client\environments.json.bak   环境配置备份
%APPDATA%\gpt-set-client\mcp-instances.json      MCP 实例配置
%APPDATA%\gpt-set-client\Partitions\             登录会话数据
%APPDATA%\gpt-set-client\extensions\             环境专属扩展副本
```

导出的环境配置不包含 Cookie 和登录会话。不要把 `mcp-instances.json`、`.env`、公网 Token 或 `%APPDATA%` 会话目录提交到 Git。

## 开发验证

```powershell
npm run check --prefix client
npm test --prefix client
npm test --prefix local-mcp-server

# 可选：检查手动启动的 MCP
npm run healthcheck --prefix local-mcp-server -- http://127.0.0.1:8787 local-token
```

## 安全边界

- MCP 仅监听 `127.0.0.1`，公网访问必须通过显式 Tunnel。
- 每个实例默认使用独立高熵 Bearer Token。
- 所有文件路径都限制在实例工作目录中，并拒绝绝对路径、`..` 越界和符号链接。
- 删除操作必须显式传入 `confirm=true`。
- 公网地址中的查询 Token 可能进入剪贴板历史；泄露后应立即使用 **轮换 Token**。

## License

[MIT](LICENSE)
