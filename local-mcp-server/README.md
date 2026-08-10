# 本地文件 MCP 服务

让 ChatGPT 网页端通过 MCP 对一个**固定目录**执行文件 CRUD，并可读写 PNG/JPEG/WebP/GIF 图片。

## 工具

- `list_directory`：列出目录内容
- `read_file`：读取文本；读取图片时返回给 ChatGPT
- `write_text`：新建或覆盖文本
- `write_image`：保存 Base64 图片
- `create_directory`、`move_path`、`delete_path`、`get_file_info`

所有路径必须相对于 `WORKSPACE_ROOT`；符号链接、绝对路径和越界路径都会拒绝。

## 配置

```powershell
Copy-Item .env.example .env
notepad .env
npm start
```

`.env` 示例把工作区限定为 `C:\Users\YOUR_NAME\Documents\GPT-Workspace`，服务只监听 `127.0.0.1:8787`。

通常不需要手动复制多份服务。GPT Set 客户端会为每个实例分别注入 `INSTANCE_ID`、`WORKSPACE_ROOT`、`PORT`、`MCP_TOKEN` 和 `AUTH_MODE`，因此多个端口可以并发运行。实例配置保存在 `%APPDATA%\gpt-set-client\mcp-instances.json`。

## 健康检查

```powershell
npm run healthcheck -- http://127.0.0.1:8787 <MCP_TOKEN>
```

`/health` 需要与实例相同的鉴权，并返回 `service`、`version`、`instanceId` 和实际监听端口。它不会暴露工作区路径。

## 连接网页端

ChatGPT 网页端无法直接请求你的 `localhost`。用 Cloudflare Tunnel / ngrok 等 HTTPS Tunnel 将本机 `http://127.0.0.1:8787` 映射为公开 HTTPS 地址，然后在开发者模式的 MCP 插件中填写：

```text
https://<你的-tunnel-域名>/mcp
```

服务默认要求 `Authorization: Bearer <MCP_TOKEN>`。若连接器不支持静态 Bearer Token，使用 Tunnel 的访问控制或给该 MCP 服务补 OAuth；不要把无认证的写入服务公开暴露到互联网。

## 一键临时 Tunnel

```powershell
.\start-with-tunnel.ps1
```

Tunnel 命令会打印临时 `https://*.trycloudflare.com` 地址；在 URL 后添加 `/mcp`，填入 ChatGPT 的插件连接 URL。临时地址在 Tunnel 进程退出后失效。

> ChatGPT 的认证下拉框若提供“无身份验证”，静态 Token 不会自动随请求发送；不要在公网运行 `AUTH_MODE=none`。要保持 Bearer Token，需要使用能给请求附加 Authorization Header 的访问网关，或后续将本服务接入 OAuth。

网页插件选 **无身份验证** 时，可在服务器 URL 后附加 ?token=<MCP_TOKEN>，例如 https://example.trycloudflare.com/mcp?token=...。

