# GPT Set Client

Electron 多账号隔离浏览器和 MCP 多实例控制界面。

## 启动

```powershell
npm install
npm start
```

## 验证

```powershell
npm run check
npm test
```

## 数据与会话

- 环境元数据：`%APPDATA%\gpt-set-client\environments.json`
- MCP 多实例：`%APPDATA%\gpt-set-client\mcp-instances.json`
- 登录会话：`%APPDATA%\gpt-set-client\Partitions`

环境配置使用原子写入和 `.bak` 恢复。MCP 实例可分别选择工作目录和端口，并支持并发运行。删除或重新安装源码不会主动清理 Chromium partition。
