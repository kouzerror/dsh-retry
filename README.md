# dsh-retry

为 DeepSeek Harness 桌面端增加一个 **重启 DeepSeek Harness** 按钮，出现在两处：

| 位置 | 说明 |
| --- | --- |
| 系统托盘（右下角小鲸鱼图标）右键菜单 | 与「打开 / 退出」同款原生菜单项 |
| 账户弹出菜单（左下角头像） | 与「设置 / 意见反馈 / 退出登录」同款原生菜单项 |

> 早期版本还在侧栏底部放过一个引导按钮，0.2.0 起已移除——插件改为在启动时自动准备补丁，并在 DSH 正常退出时静默安装。

## 为什么需要核心补丁

DeepSeek Harness 桌面端的托盘菜单与账户菜单都硬编码在 `app.asar` 内（`lib/main.js` 的 `DesktopTray`、以及 `@deepseek-ai/dsh-client-ui-settings-account` 的 `AccountMenu`），没有向插件开放的 slot/IPC。因此本插件需要修改安装目录的 `resources/app.asar`：

1. 读取 `resources/app.asar`，在内存中给 `lib/main.js`（托盘菜单 + 重启触发文件监听）和账户菜单 bundle（菜单项 + 中英文案 + 点击处理）打补丁；
2. 生成 `app.asar.patched` 到 `%TEMP%\dsh-retry-build\`（重建后的 asar 与原文件除被修改的两个文件外逐字节一致）；
3. 插件启动后自动准备补丁，并挂一个“退出后安装”的 helper；
4. DSH **正常退出时**由 helper 备份原 `app.asar`（`app.asar.dsh-retry.bak`）并替换成补丁版；
5. 下次启动 DSH 即可在托盘与账户菜单看到「重启 DeepSeek Harness」。

之后点击任一入口：托盘项直接 `app.relaunch()`；账户菜单项请求 `POST /dsh-retry/restart`，由主进程读取 `resources/dsh-retry.restart` 触发文件后原地 `app.relaunch()`。两者都是优雅重启，不再需要 helper。

## 安装

```powershell
# 在 DSH 插件管理器里安装本地目录
# Settings → Plugins → Install → file:C:\path\to\dsh-retry
# 或直接在 profile 目录：
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add file:C:\path\to\dsh-retry
```

安装后无需找按钮：**正常退出一次 DSH（托盘 → 退出 DeepSeek Harness），再重新打开**，补丁即会在退出时安装好，随后托盘菜单与账户菜单里就能看到「重启 DeepSeek Harness」。若之前已经装过旧版本，升级后同样退出一次即可生效（旧补丁会按需重新生成）。

## 卸载

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm remove dsh-retry
# 还原核心补丁（可选）
#   先退出 DSH，再把 resources\app.asar.dsh-retry.bak 改名回 app.asar
```

## 注意事项

- **DSH 桌面端升级会覆盖 `app.asar`**：升级后首次启动插件会重新准备补丁，退出一次 DSH 后自动装回。
- 安装补丁发生在 DSH 退出过程中，安装前会先备份原文件；未修改任何其它文件。
- 仅在 Windows 桌面端工作（依赖 `DeepSeek Harness.exe` 的 `resources/app.asar` 布局）；Web 端安装后 `/dsh-retry/restart` 会返回 `409 not_desktop`。
- helper 日志：`%TEMP%\dsh-retry-build\restart-helper.log`；补丁路由：`GET /dsh-retry/status`、`POST /dsh-retry/restart`。

## 版本与同步

本仓库每次插件更新都会同步提交并推送，同时打 tag 与 GitHub Release（`dsh-retry-<version>.tgz`）。当前版本见 `package.json` 与 [Releases](https://github.com/kouzerror/dsh-retry/releases)。

## 结构

```
lib/asar.js         最小 asar 读写器（读取/重建/校验，Electron 下用 original-fs 绕过 asar 虚拟层）
lib/patch.js        托盘菜单、账户菜单、重启监听三处补丁（锚点唯一性校验，幂等）
lib/index.js        host 插件：补丁路由 + 启动时挂"退出后安装"helper
scripts/restart-helper.ps1  退出后替换 asar（可选重启）- 基于 WMI 脱离进程
scripts/*.mjs       开发期验证脚本（identity/patched 校验等）
cordis.patch.yml    插件挂载行
```

## License

MIT
