# ChatGPT Image Bridge 扩展

1. 打开 Chrome：`chrome://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录。
4. 打开扩展弹窗，确认本地端点为 `http://127.0.0.1:8787/bridge/capture`，Token 与 `local-mcp-server/.env` 的 `MCP_TOKEN` 一致。
5. 在 ChatGPT 网页版生成图片。扩展会把大图捕获到 `GPT-Workspace/.chatgpt-image-inbox/`。
6. 让 MCP 调用 `list_captured_images`，再调用 `save_captured_image` 移动到目标路径。

此扩展仅运行在 `https://chatgpt.com/*`，并只提交分辨率至少 512×512、大小不超过 10 MB 的图片到本机端点。
