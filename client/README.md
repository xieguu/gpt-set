# GPT Set Client

环境隔离的多账号 GPT 浏览器客户端 MVP。

## 启动

```powershell
npm install
npm start
```

## 已实现

- 多环境创建、编辑、复制、归档、删除
- Electron persistent partition 隔离 Cookie、LocalStorage、IndexedDB、缓存和 Service Worker
- 每个环境单独打开窗口、单独配置代理
- 环境会话数据一键清除
- 无敏感会话数据的 JSON 导入/导出

环境配置保存在 Electron `userData/environments.json`；浏览器会话由 Chromium 的 persistent partition 管理。


代理字段留空时，环境会跟随 Windows 系统代理；填写时才使用环境专属代理。

