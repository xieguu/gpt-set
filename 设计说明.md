# 环境隔离多账号 GPT 浏览器客户端设计

## 1. 目标

构建 Windows 优先的桌面浏览器客户端，为多个 GPT 账号提供彼此隔离、可持久化的独立浏览器环境。每个环境可保存自己的登录状态、Cookie、LocalStorage、扩展配置、代理和启动参数；环境之间默认不共享任何身份数据。

## 2. 范围与边界

### 功能范围

- 创建、编辑、复制、删除、归档浏览器环境。
- 每个环境独立保存 GPT 登录会话，并通过内置浏览器打开目标站点。
- 同时运行多个环境窗口。
- 环境级代理、UA、窗口尺寸、语言、时区和启动页配置。
- 登录状态检测、会话失效提示、手动重新登录。
- 本地加密保存敏感元数据；一键清除某个环境的站点数据。
- 导入/导出环境配置（默认不导出 Cookie）。

### 非目标

- 不自动填写账号密码、验证码或 MFA。
- 不绕过站点的认证、风控、设备验证或使用限制。
- 不跨环境复制或同步会话 Cookie。

## 3. 推荐技术路线

采用 Electron + Chromium 的 `partition` 隔离会话方案：

- 桌面端：Electron + TypeScript + React/Vite。
- 主进程：负责环境生命周期、窗口创建、配置校验、安全存储。
- 渲染进程：环境列表、配置表单、状态展示。
- 存储：SQLite 保存非敏感环境配置；Electron `safeStorage` 加密令牌类元数据。
- 会话：Electron `session.fromPartition('persist:gpt-env-{uuid}')`。

`persist:` 分区会由 Chromium 持久化至应用用户数据目录，因此 Cookie、Cache、IndexedDB、LocalStorage 和 Service Worker 数据都天然按环境隔离。

## 4. 总体架构

```text
┌─────────────────────────── Renderer (React) ───────────────────────────┐
│ 环境列表 / 创建编辑 / 状态页 / 清理与导入导出                           │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ IPC（白名单 API）
┌───────────────────────────────▼────────────────────────────────────────┐
│ Electron Main                                                           │
│ EnvironmentService  WindowFactory  SessionPolicy  SecureStore          │
└───────────────┬──────────────────────┬─────────────────────────────────┘
                │                      │
       ┌────────▼────────┐    ┌────────▼────────────┐
       │ SQLite config    │    │ Chromium partitions  │
       │ environments.db  │    │ persist:gpt-env-*    │
       └─────────────────┘    └─────────────────────┘
```

## 5. 数据模型

```ts
export interface BrowserEnvironment {
  id: string;                 // UUID，永不复用
  name: string;               // 用户可见名称，例如“工作账号”
  provider: 'chatgpt' | 'custom';
  baseUrl: string;            // 默认 https://chatgpt.com/
  partition: string;          // persist:gpt-env-{id}
  proxy?: string;             // 例如 http://127.0.0.1:7890
  locale?: string;            // zh-CN
  timezone?: string;          // Asia/Shanghai
  userAgent?: string;         // 可选；默认 Chromium UA
  windowBounds?: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  archived: boolean;
}
```

数据库中不保存账号密码、Cookie 或访问令牌。会话数据由对应 Chromium partition 保存；如确实需要保存少量敏感设置，必须使用 `safeStorage.encryptString()` 加密后落盘。

## 6. 目录布局

```text
%APPDATA%/gpt-set/
├── environments.db                 # 环境配置，SQLite
├── secrets.dat                     # 仅保存 safeStorage 密文（可选）
├── partitions/                     # Electron userData 内 Chromium session 数据
│   ├── persist:gpt-env-<uuid>/
│   └── persist:gpt-env-<uuid>/
├── exports/                        # 用户导出的无会话配置
└── logs/                           # 不记录 URL query、Cookie、Authorization
```

实际 Chromium partition 路径由 Electron 管理；应用不应自行复制、合并或解析其中的 Cookie 数据库。

## 7. 核心流程

### 创建环境

1. 前端提交名称、站点 URL、可选代理等配置。
2. 主进程校验 URL 仅允许 `https:`，生成 UUID 与 `persist:gpt-env-{uuid}`。
3. 写入 SQLite。
4. 创建 BrowserWindow；`webPreferences.partition` 绑定新分区。
5. 用户在该窗口中手动完成登录。

### 打开既有环境

1. 读取环境配置。
2. 通过 partition 获取 session。
3. 在创建窗口前设置该 session 的代理与网络策略。
4. 创建窗口并加载该环境 `baseUrl`。
5. 登录状态由页面加载结果或用户确认显示；不抓取密码或 Token。

### 清除环境会话

1. 关闭该环境全部窗口。
2. 对对应 session 调用 `clearStorageData()` 与 `clearCache()`。
3. 保留环境配置，用户下次打开时重新登录。

### 删除环境

1. 二次确认，关闭窗口。
2. 清除 session 数据与缓存。
3. 删除 SQLite 配置行。
4. 删除相关导出与日志引用；不影响其他 partition。

## 8. Electron 实现骨架

```ts
import { app, BrowserWindow, session } from 'electron';

async function openEnvironment(env: BrowserEnvironment) {
  const ses = session.fromPartition(env.partition);

  if (env.proxy) {
    await ses.setProxy({ proxyRules: env.proxy });
  } else {
    await ses.setProxy({ mode: 'direct' });
  }

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    // 默认拒绝敏感权限；按需仅允许 notifications。
    callback(permission === 'notifications');
  });

  const win = new BrowserWindow({
    width: env.windowBounds?.width ?? 1280,
    height: env.windowBounds?.height ?? 900,
    webPreferences: {
      partition: env.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: PRELOAD_PATH,
    },
  });

  await win.loadURL(env.baseUrl);
  return win;
}

async function wipeEnvironment(env: BrowserEnvironment) {
  const ses = session.fromPartition(env.partition);
  await ses.clearStorageData({
    storages: [
      'cookies', 'filesystem', 'indexdb', 'localstorage',
      'serviceworkers', 'cache_storage', 'websql',
    ],
  });
  await ses.clearCache();
}
```

## 9. 安全设计

- 所有窗口使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- IPC 采用 `contextBridge` 暴露固定方法；禁止把 `ipcRenderer` 整体暴露给页面。
- `setWindowOpenHandler` 默认拒绝弹窗或改为系统浏览器打开可信链接。
- 使用导航白名单：初始仅允许配置的 GPT 域名及认证流程所需的可信域名。
- 代理只允许明确的 URL 格式，配置页禁止任意 PAC 脚本。
- 禁止在日志、崩溃报告、导出文件中写入 Cookie、Authorization、完整回调 URL 或密码。
- 导出默认只包含环境配置；如支持“含会话备份”，必须显式高风险确认并使用本机加密，不建议实现。
- 使用 OS 用户目录权限；应用锁定可选用系统凭据或本地 PIN 的派生密钥。

## 10. UI 设计

主界面使用卡片/表格列出环境：名称、站点、最后打开时间、代理、会话状态、操作按钮。

操作：

- **新建环境**：填写名称、站点、代理和显示偏好。
- **打开**：在独立窗口中载入保存的 partition。
- **复制配置**：只复制非敏感设置，生成全新 partition。
- **清除登录状态**：只清当前环境的站点数据。
- **导出配置**：输出 JSON，不含会话数据。
- **归档/删除**：停止使用或彻底移除环境。

## 11. 验收标准

1. 创建两个环境后，在 A 登录、B 不登录；重启应用后 A 仍保持自己的会话，B 不获得 A 的会话。
2. 清除 A 会话不会影响 B 的 Cookie、LocalStorage 或缓存。
3. 设置 A 代理不影响 B 的网络请求。
4. 复制环境配置后，新环境不携带源环境的登录状态。
5. 导出 JSON 中不出现 Cookie、Token、密码、Authorization 或完整认证回调参数。
6. 关闭应用后所有窗口退出，数据库可完整恢复环境列表。

## 12. 迭代计划

- **MVP**：环境 CRUD、独立 partition、打开窗口、清除会话、SQLite。
- **v1**：环境级代理、导入导出、归档、窗口状态恢复、日志脱敏。
- **v2**：应用锁、健康检查、企业策略、受控扩展安装、自动化测试。

## 13. 测试建议

- 单元测试：环境 ID、partition 生成、URL/代理校验、导出脱敏。
- 集成测试：Playwright 驱动两个环境，验证 Cookie 和 LocalStorage 不互通。
- 回归测试：并发打开/关闭、崩溃恢复、清除存储后重新登录。
- 安全测试：恶意导航、未授权 IPC、外部链接、新窗口、日志敏感信息扫描。
