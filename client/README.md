# GPT Set Client

Electron 多账号隔离浏览器和 MCP 多实例控制界面。

## 开发模式启动

```powershell
npm install
npm start
```

## 构建 Windows 便携版

需要 Windows x64、Node.js 20 或更高版本以及 npm：

```powershell
npm ci
npm run check
npm test
npm run dist:win
```

输出文件：

```text
dist\GPT-Set-0.1.0-portable.exe
dist\chatgpt-image-bridge-extension\
```

该 EXE 无需安装 Node.js 或 npm，复制到普通目录后双击即可运行。建议将 EXE 与 `chatgpt-image-bridge-extension` 目录一起复制，主界面的“打开图片桥接扩展”会直接打开 EXE 同级的该目录，不再指向系统临时缓存。它是“程序便携”，用户数据仍保存在 `%APPDATA%\gpt-set-client`。升级时先完全退出旧版，然后替换 EXE 和扩展目录；如需保留或迁移账号会话，请备份整个 `%APPDATA%\gpt-set-client` 目录。

同一台电脑只运行一个 GPT Set 主程序。浏览器环境和 MCP 实例的多开由主程序内部管理。

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
