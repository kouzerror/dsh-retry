# dsh-retry

为 DeepSeek Harness 桌面端增加一个 **重启 DeepSeek Harness** 按钮，出现在三处：

| 位置 | 来源 | 说明 |
| --- | --- | --- |
| 系统托盘（右下角小鲸鱼图标）右键菜单 | 核心补丁 | 与「打开 / 退出」同款原生菜单项 |
| 账户弹出菜单（左下角头像） | 核心补丁 | 与「设置 / 意见反馈 / 退出登录」同款原生菜单项 |
| 侧栏底部（设置按钮旁） | 插件客户端 | 不依赖核心补丁的引导入口，安装后立即可用 |

## 为什么需要核心补丁

DeepSeek Harness 桌面端的托盘菜单与账户菜单都硬编码在 `app.asar` 内（`lib/main.js` 的 `DesktopTray`、以及 `@deepseek-ai/dsh-client-ui-settings-account` 的 `AccountMenu`），没有向插件开放的 slot/IPC。因此本插件在首次触发重启时：

1. 读取安装目录的 `resources/app.asar`；
2. 就地打补丁（托盘菜单加一项、账户菜单加一项、`main.js` 加一个 800 ms 轮询的重启触发文件监听）；
3. 生成 `app.asar.patched` 到 `%TEMP%\dsh-retry-build\`；
4. 在 DSH 退出后由 helper 脚本备份原 `app.asar` 并替换；
5. 重新启动 `DeepSeek Harness.exe`。

补丁只是**追加**菜单项与监听逻辑，不改动其它文件；重建后的 asar 与原文件逐字节一致（除被修改的两个文件），详见 `lib/asar.js`。

打补丁后再次点击重启不需要重复打补丁：主进程会读取 `resources/dsh-retry.restart` 触发文件并原地 `app.relaunch()`。

## 安装

```powershell
# 在 DSH 插件管理器里安装本地目录
# Settings → Plugins → Install → file:C:\path\to\dsh-retry
# 或直接在 profile 目录：
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add file:C:\path\to\dsh-retry
```

安装后侧栏底部出现重启按钮；第一次点击会完成补丁替换并重启 DSH，之后托盘菜单与账户菜单里也会有「重启 DeepSeek Harness」。

## 卸载

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm remove dsh-retry
# 还原核心补丁（可选）
#   先退出 DSH，再把 resources\app.asar.dsh-retry.bak 改名回 app.asar
```

## 注意事项

- **DSH 桌面端升级会覆盖 `app.asar`**，插件检测到补丁缺失后会在下次点重启时自动重打（需一次重启生效）。
- 重启前建议确认没有正在跑的长任务：helper 会先结束主进程（`Stop-Process -Force`），再替换文件并拉起新进程。
- 仅在 Windows 桌面端工作（依赖 `DeepSeek Harness.exe` 的 `resources/app.asar` 布局）；Web 端安装后 `/dsh-retry/restart` 会返回 `409 not_desktop`。
- helper 日志：`%TEMP%\dsh-retry-build\restart-helper.log`；补丁路由：`GET /dsh-retry/status`、`POST /dsh-retry/restart`。

## 结构

```
lib/asar.js         最小 asar 读写器（读取/重建/校验，Electron 下用 original-fs 绕过 asar 虚拟层）
lib/patch.js        托盘菜单、账户菜单、重启监听三处补丁（锚点唯一性校验，幂等）
lib/index.js        host 插件：/dsh-retry/status、/dsh-retry/restart 路由
lib/client.js       客户端插件：侧栏底部重启按钮
scripts/restart-helper.ps1  退出后替换 asar 并重新启动
scripts/*.mjs       开发期验证脚本（identity/patched 校验等）
cordis.patch.yml    插件挂载行
```

## License

MIT
