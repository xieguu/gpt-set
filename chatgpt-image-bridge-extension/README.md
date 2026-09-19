# ChatGPT Image Bridge 扩展

GPT Set 的图片桥接扩展会捕获 ChatGPT 网页中不小于 `512 × 512` 的生成图片，并发送到本机 MCP 图片收件箱。支持 `http:`、`https:` 和 `blob:` 图片地址，单张图片最大 10 MB。

## 安装

GPT Set 会为每个浏览器环境复制并加载一份独立扩展。手动使用 Chrome 时：

1. 打开 `chrome://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录。
4. 打开扩展弹窗，检查“当前端点”。
5. 确认 Token 与 `local-mcp-server/.env` 中的 `MCP_TOKEN` 一致。

默认端点为：

```text
http://127.0.0.1:8787/bridge/capture
```

扩展已允许访问 `127.0.0.1` 的任意端口，因此可以在弹窗中改成其他 MCP 实例，例如：

```text
http://127.0.0.1:8790/bridge/capture
```

## 多环境与托管配置

`managed-config.js` 保存默认配置：

```js
export default {
  endpoint: 'http://127.0.0.1:8787/bridge/capture',
  token: '',
  enabled: true,
  managed: false,
};
```

GPT Set 会在复制环境专属扩展后覆盖该文件，使每个浏览器环境连接不同端口。`managed=true` 时托管配置优先，弹窗只读，避免旧的手动配置继续把图片发往错误工作区；外部 Chrome 手动加载的扩展仍可保存 `chrome.storage.local` 配置。

## 捕获流程

1. 在 ChatGPT 助手消息中生成图片；用户消息内上传的图片不会被自动捕获。
2. 扩展把图片发送到 `.chatgpt-image-inbox/`。
3. MCP 调用 `list_captured_images` 查看图片。
4. MCP 调用 `save_captured_image` 将图片移动到目标路径。

扫描使用 debounce 和上传队列，最多并发上传 2 张图片。只有服务器确认上传成功后才会记录去重；网络异常、超时和 HTTP 408 / 429 / 5xx 最多重试 3 次。鉴权失败、其他 HTTP 4xx、格式不支持、空图片或超过大小限制时直接结束当前任务，不重复下载或上传。

后台上传在 20 秒后取消实际网络请求，早于内容脚本的 25 秒响应等待上限，避免仅停止等待却留下挂起的上传。单张图片上限为 10 MiB，服务端请求体额度另计 Base64 膨胀及 JSON 元数据。内存中的已发送集合最多保留 256 条，避免长时间运行后无限增长。
