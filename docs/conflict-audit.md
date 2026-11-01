# dsh-retry 冲突审计报告（本机插件 + 插件生态）

| 项 | 内容 |
|---|---|
| 审计对象 | `dsh-retry` 0.5.1（工作区 `dsh-retry\lib\*`；profile 安装副本 `C:\Users\Fs-1f\.dsh\profiles\desktop\node_modules\dsh-retry`，`lib\client.js` SHA256 前 12 位 `7DF822D39652`，工作区与 profile 一致） |
| 宿主环境 | DSH 桌面端 0.2.1-rc.5（Windows，pwsh 7.6，Electron） |
| 审计目标 | 插件间命名空间冲突（slot / 路由 / 模块 id / CSS）、功能重叠、以及 **`resources\app.asar` 补丁叠加**风险 |
| 审计方式 | 只读：本机 profile `node_modules` 全量 grep、dsh-retry 源码通读、插件注册表 `awesome-dsh-plugin.com/plugins.json` + GitHub 源码核对、本机 `resources\` 实况取证 |
| 约束 | 不重启 DSH、不修改 dsh-retry 的 lib/profile/git、不动 package.json；本报告之外未改动任何文件 |
| 判定标准 | 「已验证」= 本机命令输出或已读源码可直接支撑；「基于源码推断」= 由机制推导、未实测共存场景，已逐条标注 |

---

## 0. 结论摘要

1. **本机 11 个第三方插件与 dsh-retry 没有硬冲突（已验证）**：`settings.section` 的 id/order 无重复、无插件注册 `/dsh-retry/*` 路由、无模块 id 撞车、无其他插件写 `app.asar`。唯一需要留意的是 `dsh-cost-meter` 对 `sidebar.footer.action` 槽容器的全局 CSS 改写（当前 dsh-retry 不使用该槽，低风险）。
2. **生态层「会写 `app.asar`」的插件远不止个位数（已读源码验证）**：已读源码确认 **9 个**仓库会改 `resources\app.asar`（8 个改 `lib/main.js` 的托盘/应用菜单/关闭行为/IPC，1 个把 `app.asar` 换成解包树），另有 3 个据注册表描述亦为写入者（未读源码）；其中 **5 个**与 dsh-retry **修改同一段托盘/quit 代码**。
3. **最高风险是 asar 补丁叠加，而不是 slot/路由（基于源码推断，机制链路完整）**：dsh-retry 的重建源优先取 `resources\app.asar.dsh-retry.bak`（原始基线），且判定「是否已打过补丁」只看自己的 marker。后果是：(a) 别家补丁会被 dsh-retry 的重建**静默覆盖**；(b) 别家补丁会被误当作「原始基线」写进 `.bak`；(c) 双向安装时托盘可能出现两个/三个「重启」项，或别家锚点失配直接失败。
4. **当前本机已存在一个「重建窗口」（已验证的实况）**：`dsh-retry-build\app.asar.patched.meta.json` 里 `"plugin": "0.5.0"`，而当前插件已是 0.5.1；这本身不会触发重建（`reuseStaged` 只比较 source 的路径/大小/mtime，不比较插件版本），但每次 `ensureStaged` 都会把 `expectedSize/expectedMtimeMs` 刷新为**当前** live 的大小/mtime —— 这正是第三方补丁可能被静默覆盖的机制入口，见 §5.3。
5. **任务描述与当前代码不一致（已纠正）**：`lib\client.js` 当前**只注册 `settings.section`**（`dsh-retry\lib\client.js:224-225`，id `dsh-retry`、order 95），全文件不存在 `sidebar.footer.action` 注册；「侧栏底部重启按钮」只存在于设计稿 `dsh-retry\docs\research-implementation-paths.md:368-369`。

---

## 1. 审计范围与方法

### 1.1 本机已装插件（11 个第三方）

| 包 | 版本 | 与 dsh-retry 的关系（本节证据见 §3） |
|---|---|---|
| `dshmarket` | 1.73.7 | 自带 `/dsh-market/restart`（重启 Host 进程），功能重叠；只读探测 `app.asar` |
| `dsh-cost-meter` | 1.9.48 | 注册 `sidebar.footer.action` 4 项 + 全局 CSS 改写该槽容器；不写 asar |
| `@michengai/dsh-skills-manager` | 1.2.26 | `settings.section` id `skills-manager`；独占 `/api/michengai/dsh-skills-manager` 前缀 |
| `billion-context` | 0.1.211 | `settings.section` id `bili` order 100；`/bili/origin`、`/__bili` |
| `dsh-mnemon`（+4 个 source 子包） | 0.5.37 | 走 connection/RPC，不注册 HTTP 路由 |
| `@michengai/dsh-code-review` | 1.0.5 | 只注册工具，无 slot/路由 |
| `@michengai/dsh-archive-manager` | 1.1.22 | `settings.section` id `archive-manager`；另有设置页 nav 的 DOM 侵入 |
| `dsh-web-artifact-designer` | 1.0.0 | 无 slot/路由/asar |
| `dsh-office-tools` | 1.0.8 | 无 slot/路由/asar |
| `dsh-ppt` | 0.20.3 | `settings.section` id `dsh-ppt` order 58；依赖共享库 `@stardustlc/dsh-updates`（非插件） |
| `dsh-retry` | 0.5.1 | 本审计对象；`engines.dsh: >=0.2.0-rc.1 <0.3.0-0` 覆盖当前 0.2.1-rc.5 |

### 1.2 方法与证据来源

- 本机：`rg` 全量扫描 profile `node_modules`（排除 `.pnpm`），先 `rg -n -o` 定位行号再读指定行段，避免把 minified 单行 bundle 读进上下文。
- 生态：`plugins.json`（`https://awesome-dsh-plugin.com/plugins.json`）**文件被截断**（3,070,976 B，JSON 在 `plugins[2354]` 处 Unterminated，全量 7,406 条，仅能解析约 2,354 条），故生态结论以 **GitHub 检索 + 逐仓库读源码** 为主：`gh search code --repo awesome-dsh-plugin/awesome-dsh-plugin '<kw>'`、`gh api repos/<repo>/contents/<path>`。
- 关键交叉验证词：`asar`、`app.asar`、`sidebar.footer.action`、`settings.section`、`quitApplication`、`restartApplication`、`relaunch`。
- 判定标记：**[验]** = 已验证；**[推]** = 基于源码推断（机制成立，未实测共存）。

---

## 2. 冲突矩阵（总表）

> 列定义：对象（插件/机制）· 冲突面（共享资源）· 证据（`路径:行号` 或 URL）· 判定 · 风险等级 · 建议。

### 2.1 本机层（11 个已装插件）

| 对象 | 冲突面 | 证据 | 判定 | 风险 | 建议 |
|---|---|---|---|---|---|
| 全部本机插件 | `settings.section` id | `dsh-retry\lib\client.js:225`（`dsh-retry`/95）；`dsh-cost-meter\lib\client.js:9`（`cost-meter`/30、`cost-meter-usage`/31）；`billion-context\dist\agent\dsh-native-client.js:741-742`（`bili`/100）；`@michengai\dsh-archive-manager\lib\client.js:23`（`archive-manager`/45）；`@michengai\dsh-skills-manager\lib\client.js:60`（`skills-manager`/25）；`dsh-ppt\lib\client.js:1712`（`dsh-ppt`/58）；`dshmarket\client\client.js:18335`（`market`/40） | 无重复 id、无重复 order [验] | 低 | 无需改动；新增分区时保持 id 前缀 `dsh-retry` |
| `dsh-cost-meter` | `sidebar.footer.action` 槽容器布局（全局 CSS） | `dsh-cost-meter\lib\client.js:2`：`:has(>[data-slot="sidebar.footer.action"]>footer-stack){align-content:flex-start}`、`footer-stack{order:-1;height:6px;…}` 等 | 当前 dsh-retry 不注册该槽 → 现状无交集；若按设计稿上线 footer 按钮则同槽，按钮顺序/容器高度受 cost-meter 支配 [验] | 低（现状）/ 中（若上线 footer 入口） | footer 入口上线前在真实 UI 目测；dsh-retry 样式继续用 `.dsh-retry-*` 且不加 `!important` |
| `dsh-cost-meter` | footer 槽 id | 同上文件：`cost-meter`/0、`cost-meter-display-onboarding`/1、`cost-meter-codex-compat`/1、`cost-meter-peak-alert`/0 | id 不撞；order 0/1 早于 dsh-retry 设计稿的 90 [验] | 低 | 上线时把 order 设为 ≥ 90 并确认排序 |
| `dshmarket` | 重启语义（两套机制） | `dshmarket\lib\routes.js:6509`（`/dsh-market/restart`）；`dshmarket\lib\restart.js:653-688`（SIGTERM self + 起 helper 重建 Host） | 功能重叠：dshmarket 重启 **Host 进程**，dsh-retry watcher 走 `app.relaunch()`（整机）。互不写对方文件 [验] | 低 | 文档里说明两者区别；建议状态页显示「本插件重启=整机」 |
| `dshmarket` | 重启瞬间并发 | 同上 + `dsh-retry\lib\index.js:260-375`、`scripts\restart-helper.ps1:179,220` | dshmarket helper 在 500ms 后 SIGTERM 自身；dsh-retry staging 用 tmp+rename（`index.js:355` `realFs.renameSync`）原子替换，扫描/写入目录不同 [验] | 低 | 无需改动 |
| `dsh-mnemon` | HTTP 路由命名空间 | `dsh-mnemon\lib\index.js:18280`（`ctx.inject(["connection","webServer"], …)` → `registerRpc`/`registerSettingsRpc`/`registerViewRpc`） | 走 connection/RPC，无 `webServer.register` [验] | 低 | 无 |
| `@michengai/dsh-archive-manager` | 设置页 nav DOM | `@michengai\dsh-archive-manager\lib\client.js:23`（settings.section）+ 同文件 `document.querySelectorAll`/`[role="dialog"] nav`/`dsham-nav-icon-style` | DOM 级侵入但只改图标；与 settings.section 并存无 id 冲突 [验] | 低 | 无 |
| 全部本机插件 | 模块 id（`__ModuleLoader__.load({id})`） | 已注册：`@michengai/dsh-archive-manager`、`@michengai/dsh-code-review`、`@michengai/dsh-skills-manager`、`billion-context`、`dsh-mnemon`、`dsh-mnemon-source-*`、`dsh-ppt`（经 `__stardustUpdatesWrap`）、`dsh-retry`、`dshmarket`；`dsh-cost-meter` 走 `Symbol.for("@dsh-plugin/dsh-loader:load-wrap")` | 无重复；`dsh-retry` 前缀无别家引用 [验] | 低 | 无 |
| 全部本机插件 | 路由前缀 | `dsh-retry`：`index.js:531-532,539-540,562-563`（三条 `kind:'exact'`）；archive-manager：`lib\index.js:7-10`；skills-manager：`lib\index.js:308,706-708`；billion-context：`/bili/origin`、`/__bili`；dshmarket：`/dsh-market/*`（含 restart/uninstall/rollback/install/update） | 无任何插件使用 `/dsh-retry/*` 或 `/retry` 通用前缀 [验] | 低 | 保持 exact 路径；不要改成 `/restart` 这类通用前缀 |
| 全部本机插件 | `app.asar` 写入 | profile 内 `electron-asar`/`rebuildAsar`/`@electron/asar` 命中仅 dsh-retry 自身；`dshmarket` 的 `app.asar` 字符串均为只读定位（`dsh-install.js:18`、`:25-33`；`profile.js:1426` 等） | 本机只有 dsh-retry 写 asar [验] | 低 | 无需改动（生态层风险见 §2.2） |

### 2.2 生态层（会与 dsh-retry 争夺 `app.asar` 或重启入口）

| 对象 | 冲突面 | 证据 | 判定 | 风险 | 建议 |
|---|---|---|---|---|---|
| `hxh230802/dsh-tray-restart` | 托盘菜单 quit 项前插入 restart；应用菜单；等长补丁 | https://github.com/hxh230802/dsh-tray-restart/blob/HEAD/lib/main-patch.js（`MARKER='dsh-tray-restart:menu:v2'`、`TRAY_OLD` 以 `{ type: "separator" }`+`label: messages.quitApplication` 开头） | 与 dsh-retry 同区域同锚点；互装会失配或产生双项；不识别我方 marker [推，锚点比对已读源码] | 高 | 见 §6 P0/P1 |
| `maqian1632/dsh-tray-restart` | 托盘 quit 前插入 + 区域整体替换（保长度） | https://github.com/maqian1632/dsh-tray-restart/blob/HEAD/tray-patch.js（`TRAY_RESTART_MARKER`、校验 `quitWithoutConfirmation`/`app.relaunch()`/`restartApplication`） | 同锚点；双项；等长改写 [推] | 高 | 同上 |
| `QIRSHENG/dsh-tray-restart` | 托盘插入 + 等长改写 + **刷新 asar entry integrity** | https://github.com/QIRSHENG/dsh-tray-restart/blob/HEAD/lib/patcher.mjs（注释 byte-length-preserving；锚点为压缩形态 `{label:messages.quitApplication,click:this.options.quit}]));`；`FORCE_MARKER='quit-all.ps1'`） | 与 dsh-retry 同区；其对 integrity 的依赖与我方重打包存在交互 [推] | 高 | P1 实测兼容性 |
| `CZY1326/dsh-restart-button` | 托盘插入 + 等长 + 依赖 asar header integrity 定位条目 | https://github.com/CZY1326/dsh-restart-button/blob/HEAD/scripts/patch-asar.cjs（错误文案 `patch anchor not found; this build is not the one the patch was written for`、`patch anchor is not unique`） | 同锚点；互装后锚点可能失配/双项 [推] | 中高 | 同上 |
| `NebulaArcanum/dsh-desktop-restart-menu` | 托盘+应用菜单；**in place、trim/pad 回原始字节长度**，header 不动 | https://github.com/NebulaArcanum/dsh-desktop-restart-menu/blob/HEAD/apply.js（`BACKUP=backup/main.orig.mjs`、`MARK='dsh-restart-menu-patch'`、`TRAY_FROM` 同上格式） | 同锚点同区域；其 `restore.js` 会整段回退 main.js（可能连带抹掉我方补丁）[推] | 高 | P0 |
| `JiuRiWu/dsh-restart` | 改**多个** asar 条目（含 `main:restart-handler`），要求基准 hash 一致，需 DSH 关闭时外部脚本执行 | https://github.com/JiuRiWu/dsh-restart/blob/HEAD/shell-patch/patch-asar.mjs（日志 `pristineBuf.length -> buf.length`，"通过：基准一致"；配套 restore.ps1） | 与我方补丁互斥：其基准是「原始条目 hash」，我方已改 → 拒绝或跳过；其 restore.ps1 会覆盖 live [推] | 高 | 文档明确不可共存 |
| `YOGEMOW/dsh-desktop-menu` | `development` gate 11 字节等长替换 + **重写 header 内 main.js 的 SHA256 integrity**；`original-fs` 绕过 asar fs | https://github.com/YOGEMOW/dsh-desktop-menu/blob/HEAD/lib/desktop-menu.js（`GATE_OLD='development'`→`GATE_NEW='!(0  === 1)'`；`~/.dsh/dsh-desktop-menu/patch-record.json`） | 文本不同可共存；但同一 asar、我方重打包后其 integrity 探测可能取不到 hash 而跳过 [推] | 中 | P1 实测叠加顺序 |
| `Freewind72/dsh-close-to-quit` | 改 `closeButtonAction` 默认值（`"tray"`→`"quit"`）；附 rollback.ps1 | https://github.com/Freewind72/dsh-close-to-quit/blob/HEAD/shell-patch/build-patch.cjs | 文本不同可共存；其 rollback 恢复原始 asar 会抹掉我方补丁 [推] | 中 | 文档提示互斥回滚 |
| `LanJinGod/dsh-purge` | 把 `app.asar` 改为解包树加载：rename 成 `app.asar.rename-pending`，`robocopy app.asar.unpacked → resources\app` | https://github.com/LanJinGod/dsh-purge/blob/HEAD/lib/desktop.js（`ASAR_RENAME_WHEN_IDLE_PS1`） | dsh-retry 的 `paths.asar` 消失 → `ensureStaged` 返回 null（`index.js:261-265`）→ 重启接口返回 500 `nothing_to_install`（`index.js:478-479`）[推] | 高（若共存） | P0 状态页显式报错 |
| `YSDLNGF/dsh-acrylic-light`、`InkStain258/dsh-glass-skin` | 一次性 asar 透明化补丁（窗口材质）：据注册表描述「带备份地修改 app.asar」「DSH 更新后需重打」「补丁在仓库 Releases / 自带安装器」 | 注册表 YAML：`awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/YSDLNGF__dsh-acrylic-light.yml`、`data/plugins/InkStain258__dsh-glass-skin.yml`（描述已读，源码未读） | 同一 asar 的又一写入者；在 R 之后打补丁会改 live，在 R 之前打会被 R 重建吞掉 [推] | 中 | P2 纳入未知补丁标记清单 |
| `13520rygvv/dsh-restart-button` | 账号菜单 DOM 注入「重启」+ `settings.general.item` + RPC `/api/dsh-restart` | https://github.com/13520rygvv/dsh-restart-button/blob/HEAD/client.js（`injectAccountRestart()` 克隆 `[role="menuitem"]`，`data-dsh-restart-menu`）；市场页 https://awesome-dsh-plugin.com/p/13520rygvv/dsh-restart-button/ | 与 dsh-retry 的 account 菜单项（`patch.js:63-90`）**同时存在会出两个「重启」**；实现不同、文件不互覆盖 [推] | 中 | 文档/状态提示；不必改代码 |
| `SakuraYH1080/dsh-quick-restart` | 账号菜单项 + PowerShell 隐藏 helper 重启 | https://github.com/SakuraYH1080/dsh-quick-restart/blob/HEAD/client.js | 同上，双入口 [推] | 中 | 同上 |
| `wangbofan/dsh-restart-button` | Windows 标题栏第三个按钮 + `/restart-button/restart`（关整个 app） | https://github.com/wangbofan/dsh-restart-button/blob/HEAD/client.js | 位置不同、无文件冲突；仅功能重复 [推] | 低 | 无 |
| `geitaHer0/dsh-plugin-desktop-restart` | Windows 标题栏「重启」+ **依赖 app.asar 补丁** | 注册表描述（源码未读） | 属 asar 写入者，细节未知 [推] | 中 | P2 核实后再定 |
| `Choi-Peng/dsh-footer-order` | 强制 `sidebar.footer.action` 垂直堆叠并允许排序 | 注册表 YAML 描述（`gh search code` 唯一命中 `sidebar.footer.action` 的仓库） | 当前 dsh-retry 无 footer 项 → 无影响；若上线 footer 按钮则同槽 [验：描述；推：共存效果] | 低 / 中 | 上线前联测 |
| 主题类插件（注册表 `theme` 分类 294 条，抽样内） | 全局 CSS 变量与样式覆盖 | `plugins.json` 已解析部分 `category="theme"` 计数 294 | dsh-retry 客户端样式全部 `.dsh-retry-*` + `--dsw-alias-*` 带 fallback，且无 `!important`（`dsh-retry\lib\client.js:48-56`）→ 被主题插件影响的概率低 [验（我方代码）+ 推（主题行为）] | 低 | 无需改动 |
| 注册表 restart/tray 命名插件 | 重启入口泛滥：已解析 2,354 条中名称含 `restart`/`tray` 的有 **23 个** | `plugins.json` 名称过滤（foreee、MoonSand、wodongx123、GraptK、hulibuld、JiuRiWu、DWJZ、7AAAAAH、PPsz-qqq、PangXitong、13520rygvv、FuriousKinght、CZY1326、hadesybil-hub、androidly、miisaka19800、StarMoon-win、BaoBao1996121、DONGBIN007、maqian1632、QIRSHENG、zhqowo、TixAn9） | 入口重复是常态；本插件应靠「行为更安全」而非「唯一入口」定位 [验] | 中 | 市场文案/README 说明共存表现 |

### 2.3 dsh-retry 自身缺口（加固对象）

| 对象 | 冲突面 | 证据 | 判定 | 风险 | 建议 |
|---|---|---|---|---|---|
| `inspectPatchState` | 只认自家 marker，不识别第三方补丁 | `dsh-retry\lib\patch.js:104-108,217-249`；marker `patch.js:8-9` | 「别家补丁不可见」根因 [验] | 高 | P0 增加 `foreignPatches` 字段 |
| `choosePatchSource`/`ensureBackupFresh` | 「无我方 marker」= pristine | `dsh-retry\lib\index.js:202-206`、`:215-248` | 第三方补丁会被当作原始基线复制进 `.bak` [验] | 高 | P0 备份写 manifest + 拒绝污染源 |
| `ensureStaged` 的 `expected*` 刷新 | 每次运行把 live 当前 size/mtime 写成「期望」，helper 只比 size/mtime | `index.js:297-313`、`:307,365`；`scripts\restart-helper.ps1:80-105` | 只能防「构建后、安装前」的窗口；**挡不住上一轮运行之后**的第三方等长/异长补丁，会静默安装只含本插件补丁的 asar [推，链路已读码] | 高 | P0/P1 |
| 安装源 = `.bak` 原始基线 | 别家补丁不在重建结果里 | `index.js:202-206,272-299,333-355` | 重建 + 安装会吞掉第三方补丁 [推] | 高 | P0 检测到未知补丁时告警/拒绝自动安装 |
| `restart-helper.ps1` 的 `Test-SourceFresh` | 仅 size/mtime | `scripts\restart-helper.ps1:92-103`（阈值 1000ms） | 第三方等长补丁若保持 mtime 近似（或刷新后的 expected 已更新）→ 校验通过 [推] | 高 | P1 增加 SHA256（`ExpectedAsarSha256`） |
| `Restore-Backup` | 回退到 `.bak`，可能覆盖别家补丁 | `scripts\restart-helper.ps1:143,275` | 回退路径无第三方检查 [推] | 中 | P1 回退前记录并比对 |
| 账号菜单项 | 与第三方同位置入口重复 | `dsh-retry\lib\patch.js:63-90` | 双重启项 [推] | 中 | 文档/状态提示 |
| `.bak` 命名固定 | 与第三方备份可能不冲突但语义冲突 | `dsh-retry\lib\desktop.js:8-29` | 名称本身唯一，但「谁是原始」无标记 [验] | 中 | P0 增加 `.bak.meta.json` |
| DSH 升级后的旧备份 | `.bak` 版本 ≠ live 版本时拒绝重建 | `index.js:274-285` | 升级后需自动弃用旧备份，否则自愈静默失效 [验] | 中 | P1 自动轮换备份 |

---

## 3. 本机层详情

### 3.1 slot 注册全量（已验证）

`settings.section`：

| 插件 | id | order | 证据 |
|---|---|---|---|
| `@michengai/dsh-skills-manager` | `skills-manager` | 25 | `@michengai\dsh-skills-manager\lib\client.js:60` |
| `dsh-cost-meter` | `cost-meter` | 30 | `dsh-cost-meter\lib\client.js:9` |
| `dsh-cost-meter` | `cost-meter-usage` | 31 | 同上 |
| `dshmarket` | `market` | 40 | `dshmarket\client\client.js:18335` |
| `@michengai/dsh-archive-manager` | `archive-manager` | 45 | `@michengai\dsh-archive-manager\lib\client.js:23` |
| `dsh-ppt` | `dsh-ppt` | 58 | `dsh-ppt\lib\client.js:1712` |
| `dsh-retry` | `dsh-retry` | 95 | `dsh-retry\lib\client.js:225` |
| `billion-context` | `bili` | 100 | `billion-context\dist\agent\dsh-native-client.js:741-742` |

`sidebar.footer.action`：仅 `dsh-cost-meter`（4 项：`cost-meter`/0、`cost-meter-display-onboarding`/1、`cost-meter-codex-compat`/1、`cost-meter-peak-alert`/0，`lib\client.js:9`）。**dsh-retry 当前不注册该槽**（见 §0 第 5 条）。若按设计稿补上，id 建议继续用 `dsh-retry-restart`、order 取 90（与设计稿一致）会排在 cost-meter 之后，但容器样式仍由 cost-meter 的 `order:-1`/`height:6px` 决定，必须目测。

其他常见槽：`dshmarket` 注册 `plugins.tab`（id `dshmarket`/order -1）、`sidebar.panellist`；`dsh-cost-meter` 注册 `header`（order -5/5）、`conversation.composer.dock`（`cost-meter-corner`/9）、`conversation.input.dock`（`cost-meter-qstrip`/5）——均与本插件无关。

### 3.2 路由命名空间（已验证）

| 插件 | 路径（kind） | 证据 |
|---|---|---|
| `dsh-retry` | `/dsh-retry/status`、`/dsh-retry/prepare`、`/dsh-retry/restart`（均 `exact`） | `dsh-retry\lib\index.js:531-532,539-540,562-563`；same-origin 校验 `:424-428` |
| `@michengai/dsh-archive-manager` | `/api/michengai/dsh-archive-manager/{sidebar-entry,online-update,sidebar-favorite-star,open-in-explorer}` | `lib\index.js:7-10` |
| `@michengai/dsh-skills-manager` | prefix `/api/michengai/dsh-skills-manager` | `lib\index.js:308,706-708` |
| `billion-context` | `/bili/origin`、prefix `/__bili` | `dist\agent\dsh-native.js` |
| `dshmarket` | `/dsh-market/*`（含 legacy `/dsh-market/restart`、`/update`、`/uninstall`、`/rollback`、`/install`） | `dshmarket\lib\routes.js:4709,6509,6778,7051,7132` |
| `dsh-cost-meter` | 只读 host 端口：`ctx.get('webServer').port`（`lib\custom-balance.js:28`），未见注册路由 | `lib\custom-balance.js:28` |
| `dsh-mnemon` | connection/RPC，无 HTTP 路由 | `lib\index.js:18280` |

结论：`/dsh-retry/*` 与任何已装插件不冲突；生态里也未见占用该前缀（注册表 code search 未命中）。

### 3.3 模块 id 与 CSS 命名空间（已验证）

- `__ModuleLoader__.load({ id })` 直接注册的模块：`@michengai/dsh-archive-manager`、`@michengai/dsh-code-review`、`@michengai/dsh-skills-manager`、`billion-context`、`dsh-mnemon`、`dsh-mnemon-source-{documents,memory-spaces,runtime,skills}`、`dsh-ppt`（经 `__stardustUpdatesWrap`）、`dsh-retry`（`lib\client.js:10-11`）、`dshmarket`；`dsh-cost-meter` 用 `Symbol.for("@dsh-plugin/dsh-loader:load-wrap")` 包装。→ 无撞车。
- CSS：dsh-retry 全部类名为 `.dsh-retry-*`，样式表元素带 `data-plugin-css="@dsh-retry/client"`/`data-plugin="dsh-retry"`（`lib\client.js:48-56`），无 `!important`，含 `prefers-reduced-motion` 保护；全 profile `rg -l 'dsh-retry'` 只命中 dsh-retry 自身 → 无前缀撞名。
- 生态对照：`13520rygvv/dsh-restart-button` 用 `.dsrb-*`，`SakuraYH1080/dsh-quick-restart` 用 `dsh-quick-restart-style`，均无交集。

### 3.4 本机 live asar 实况（已验证）

```
D:\Program Files (x86)\dsh\resources\
  app.asar                    182,767,697 B   2026/11/01 23:45:09   ← 已含 dsh-retry 补丁
  app.asar.dsh-retry.bak      182,766,714 B   2026/10/29 22:02:52   ← 原始基线（Δ 983 B）
  app.asar.unpacked/          2026/10/29 22:02:52
  dsh-retry-build\
    app.asar.patched          182,767,697 B
    app.asar.patched.meta.json  430 B  {"plugin":"0.5.0","source":"…app.asar.dsh-retry.bak","sourceSize":182766714,"expectedSize":182767697,"desktopVersion":"0.2.1-rc.5","builtAt":"2026-11-01T15:45:09.035Z"}
    restart-guard.json          109 B  {"signature":"0.2.1-rc.5:182766714:1793282572000","attempts":1,…}
    install-armed.json          108 B  {"helperPid":21592,"mode":"install-only","mainPid":30968}
    restart-helper.log / restart.log
```

结论：本机当前 **没有第三方 asar 补丁叠加**；`app.asar` 与 `.bak` 的 983 B 差值可完全由 dsh-retry 的补丁解释（`main.js` 多出 restart 托盘项 + watcher；account client.js 多出菜单项与分支）。`.bak` 早于 `app.asar` 符合「先备份原始、再打补丁」的流程。

### 3.5 功能重叠：dshmarket 的 restart（已验证）

- `dshmarket\lib\routes.js:6509`：`/dsh-market/restart`（exact），依次校验 405 非 POST、403 self-restart 关闭、403 调试器、403 非同源 loopback、409 插件操作中、409 已排期，然后 `scheduleRestart(servingPort(request), handoff)` 返回 202。
- `dshmarket\lib\restart.js:653-688`：起 `node -e restartHelper`（detached + unref），500ms 后 `process.kill(process.pid,'SIGTERM')`；helper 轮询端口（`SETTLE_MS=8000`，`upBy=45000+8000`，`hardBy=240000`），失败进 recovery 页。
- **语义差异**：dshmarket 重启 = 换掉 Host 进程（Node 侧）；dsh-retry 重启 = watcher 文件触发 Electron `app.relaunch()`（整机，含 shell）。两者不共享文件、不互写 asar，但用户会看到两个「重启」概念。
- 并发：dshmarket helper 在 500ms 后 SIGTERM 自身；若此刻 dsh-retry 正在 `ensureStaged`/写 trigger，可能中断一次构建（staging 是 tmp+rename，损坏风险低；下次启动会重建）。

### 3.6 布局/DOM 级侵入（已验证）

- `dsh-cost-meter`：单行压缩样式（`lib\client.js:2`）用 `:has()` 选择宿主 `[data-slot="sidebar.footer.action"]` 容器，强制 `align-content:flex-start`、`order:-1`、`height:6px`、`min-height:0`。dsh-retry 当前不进入该槽，无实际影响；但**任何**进入该槽的按钮（包括未来 dsh-retry 的 footer 入口）都受它支配。
- `@michengai/dsh-archive-manager`：用 `MutationObserver` + `[role="dialog"] nav` 改设置页导航图标（注入 `dsham-nav-icon-style`），属 DOM 级但只影响图标；与 settings.section 并存稳定。

### 3.7 版本 / 引擎兼容（已验证）

- dsh-retry：`engines.dsh: >=0.2.0-rc.1 <0.3.0-0`（覆盖 0.2.1-rc.5）、`engines.node: >=22.19.0`；`dsh.client.platform: "web"`、`dsh.client` 入口 `exports: "./client"`、`dsh.bundle.patch: ./cordis.patch.yml`。宿主加载客户端时走 `window.__ModuleLoader__.load`，不额外依赖宿主内部模块路径（除 asar 里 `@deepseek-ai/dsh-client-ui-settings-account/lib/client.js` 作为补丁目标，见 §5）。
- 其余 10 个插件的 `engines.dsh`：cost-meter / skills-manager / code-review / archive-manager 为 `>=0.2.0-rc.1 <0.3.0-0`；dsh-mnemon 为 `>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0`；dsh-ppt 为 `>=0.2.1-rc.3`；dsh-office-tools 为 `^0.2.1-rc.3`（用本机 pnpm 自带 semver 实测 `semver.satisfies('0.2.1-rc.5', '^0.2.1-rc.3') === true`）；dshmarket / dsh-web-artifact-designer 无 `engines`；billion-context 只声明 node。
- 结论：11 个插件在引擎声明层均不排斥 0.2.1-rc.5，无需为兼容性调整。需要注意的风险不是版本门，而是 asar 补丁目标与宿主内部路径绑定（`patch.js:3-4`），DSH 升级若改动这两个条目路径会直接 `patch anchor not found`（`patch.js:96-102`），这是设计内的 fail loudly。

### 3.8 全局副作用（已验证）

- `style[data-plugin-css="@dsh-retry/client"]`：`ensureStyles` 先 `querySelector` 判重（`lib\client.js:48-56`），重复注入不会叠加；样式全部 `.dsh-retry-*`，无 `!important`，含 `prefers-reduced-motion`。
- `window` 上除宿主模块加载约定（`window.__ModuleLoader__.load`，`lib\client.js:10`）外无自定义挂载；`apply(ctx)` 只用 `ctx.slots`（`:223-227`），返回 `{ inject: ['slots'], apply, __internals: { describeFailure } }`（`:231`）；HTTP 侧在 `lib\index.js:529-566` 用 `ctx.webServer.register`（exact 路由）。
- asar 补丁的全局副作用：`lib/main.js` 顶层新增 `dshRetryTrigger` / `dshRetryPoll`（模块作用域，非 `window`）与 800ms `setInterval`（已 `unref`，`patch.js:44-61`）；account client.js 只新增一个菜单项与 `else if` 分支（`patch.js:63-90`）。不会与别家「全局变量」类冲突。
- 副作用面真正的风险仍是文件级：两个插件改同一段文本 → 锚点失配或重复项（§5）。

---

## 4. 生态层详情

### 4.1 检索方法与其局限

- `plugins.json` 全量 7,406 条，但抓取被截断（3.07 MB / 66,100 行，解析到第 2,354 条），因此**不能声称「全生态只有这些」**；本报告结论限定在「可解析的 2,354 条 + GitHub 代码检索命中的仓库」。
- GitHub 检索命中 `asar` 的 12 条仓库中，明确「不改 asar」的 1 条（`yanli-nyan/dsh-open-in-app-fix`）、仅读取解包的 2 条（`samsam560/dog-kjdh`、`sbVAN/dsh-skill-mimo`）；其余为真实写入者或存疑（`YSDLNGF/dsh-acrylic-light` 的注册表描述已确认需要一次性 asar 补丁、更新后重打，见 §2.2）。
- 名称含 `restart`/`tray` 的 23 个插件说明「重启入口」已是红海；本插件不应以「唯一入口」为卖点。

### 4.2 会写 `resources\app.asar` 的插件（前 9 行已读源码；后 2 行仅注册表描述）

| 仓库 | 改什么 | 机制 | 关键标记 |
|---|---|---|---|
| `hxh230802/dsh-tray-restart` | 托盘 quit 项前 restart 项 + 应用菜单 restart 项 | 等长改写（要求 main.js 字节长度不变） | `MARKER='dsh-tray-restart:menu:v2'`；锚点 `{ type: "separator" }`+`quitApplication` |
| `maqian1632/dsh-tray-restart` | 托盘 restart 项 | 区域整体替换、保文件长度 | `TRAY_RESTART_MARKER`；校验 tokens |
| `QIRSHENG/dsh-tray-restart` | 托盘 3 项（quit/quit-all/restart） | 等长 + **刷新 asar entry integrity** | 压缩锚点 `{label:messages.quitApplication,click:this.options.quit}]));`；`quit-all.ps1` |
| `CZY1326/dsh-restart-button` | 托盘 restart 项 | 等长；用 header integrity 探针定位条目 | `patch-asar.cjs` 的 anchor 错误文案 |
| `NebulaArcanum/dsh-desktop-restart-menu` | 应用菜单 + 托盘 | **in place**，trim/pad 回原始长度，header 不动 | `MARK='dsh-restart-menu-patch'`；`backup/main.orig.mjs` |
| `JiuRiWu/dsh-restart` | 多个条目（含 `main:restart-handler`、IPC） | 基准 hash 校验 + 外部脚本执行 | `patch-asar.mjs`；`restore.ps1` |
| `YOGEMOW/dsh-desktop-menu` | `development` gate 11 B → 恒真 | 等长 + **重写 header 内 main.js SHA256**；`original-fs` | `~/.dsh/dsh-desktop-menu/patch-record.json` |
| `Freewind72/dsh-close-to-quit` | `closeButtonAction: "tray"` → `"quit"` | 文本替换 + rollback.ps1 | `build-patch.cjs` |
| `LanJinGod/dsh-purge` | 把 asar 换成解包树 | rename `app.asar` → `app.asar.rename-pending` + `robocopy app.asar.unpacked → resources\app` | `ASAR_RENAME_WHEN_IDLE_PS1` |
| `geitaHer0/dsh-plugin-desktop-restart` | 标题栏按钮（依赖 asar 补丁） | 未读源码 | 注册表描述 |
| `YSDLNGF/dsh-acrylic-light`、`InkStain258/dsh-glass-skin` | 一次性透明化补丁（描述称带备份、每次更新重打） | 未读源码 | 注册表描述 |

**共同点**：几乎全部采用 **「等长改写 + 保字节长度 + 自己判重 marker」**。这带来两个后果：

1. 它们对 live asar 的修改**不改变文件大小**（`app.asar` 总字节不变，或仅 header integrity 重写），因此任何只比较 size 的校验都会漏检；
2. 它们各自只认自己的 marker，同样看不见 dsh-retry 的补丁——与 dsh-retry 的盲区互为镜像。

### 4.3 只加重启 UI / 进程级重启（不写 asar）

| 仓库 | 入口 | 机制 |
|---|---|---|
| `13520rygvv/dsh-restart-button` | 账号菜单（DOM 克隆）、设置页 `settings.general.item` | `injectAccountRestart()` 遍历 `[role="menu"]` 克隆 `[role="menuitem"]`（`data-dsh-restart-menu`）；RPC `/api/dsh-restart`（`ctx.connection.fetch.register`） |
| `SakuraYH1080/dsh-quick-restart` | 账号菜单 | 隐藏 PowerShell helper 等进程退出后 `Start-Process`；路由前缀 `/dsh-quick-restart/*` |
| `wangbofan/dsh-restart-button` | Windows 标题栏菜单按钮 | 追加第三个标题栏按钮（desktop preload shadow root）；`/restart-button/restart` 关整个 app |
| `dshmarket`（本机） | 设置/市场面板 | Host 进程级重启（见 §3.5） |

### 4.4 主题 / 全局 CSS 类

- 注册表 `theme` 分类 294 条（已解析部分）；这类插件普遍覆盖 `--dsw-alias-*` 等主题变量、`body` 背景与圆角。
- dsh-retry 的风险面很小：类名全部 `dsh-retry-` 前缀、颜色用主题变量并带 fallback、无 `!important`。若出现视觉异常，优先怀疑主题变量缺失而不是样式冲突。

### 4.5 footer 排序类

- `Choi-Peng/dsh-footer-order`（注册表唯一命中 `sidebar.footer.action` 的仓库）：把该槽强制为纵向堆叠并允许配置顺序。当前 dsh-retry 无 footer 项 → 无影响；若上线 footer 入口，需要与它、以及 `dsh-cost-meter` 的 footer CSS 三方联测。

---

## 5. asar 补丁叠加风险分析（核心）

### 5.1 三种机制模型

| 模型 | 代表 | 对 live asar 的影响 | 与 dsh-retry 的交互 |
|---|---|---|---|
| A. 重打包（read → 改条目 → 重建 asar，重算 offset/integrity） | **dsh-retry**（`lib\asar.js:159-201`；`verifyAsar` deep 仅对构建产物 `patch.js:206`） | 文件总大小变化（+983 B），header 全量重写 | 会把 live 上不在重建源里的补丁**整体丢弃** |
| B. 等长原地改写（保 main.js 字节长度、改 header integrity） | hxh、Nebula、QIRSHENG、maqian、CZY1326、YOGEMOW、Freewind72 | 总大小不变（或 header 微调），内容变 | 不破坏 dsh-retry 的锚点判定；但 dsh-retry 重建后会**吞掉**它们 |
| C. 换加载源（rename asar，改用解包树） | LanJinGod/dsh-purge | `app.asar` 消失 | dsh-retry 直接失去操作对象（`ensureStaged` 返回 null） |

dsh-retry 还叠加了一层「watcher 文件 → helper 换 asar」的安装方式：构建产物在 `resources\dsh-retry-build\app.asar.patched`，由 PowerShell helper 在 app 退出后 `Move-Item` 覆盖 `app.asar`（`scripts\restart-helper.ps1:246-262`）。

### 5.2 顺序矩阵

设 dsh-retry = R，第三方 asar 补丁 = X。按「谁后装」判定：

| 顺序 | 结果 | 依据 |
|---|---|---|
| R 先装，X 后装（X 为等长改写类） | X 的锚点基于「原始 main.js」。R 已在 quit 项前插入 restart 项，X 的锚点若是 `separator`+quit 紧邻则失配 → X 报错/需 restore（fail loudly）；若 X 锚点更宽松（只认 `label: messages.quitApplication` 单行）则命中的是 R 插入块之前的 quit 项，X 会在 R 的 restart 项前再插一个 → **托盘出现 2 个重启项** | hxh/Nebula 用 separator+quit 组合锚；QIRSHENG/maqian/CZY1326 用单行 quit 锚 [已读源码，推] |
| X 先装，R 后装 | R 的锚点（quit 项 + `this.options.quit()` + `}]));`）仍匹配 → R 把自己项插在 quit 前 → 双项；且 R 的 `ensureBackupFresh` 会把「含 X 补丁的 live」当 pristine 复制成 `.bak` | `patch.js:25-42`、`index.js:215-248` [验源码，推共存结果] |
| R 已装，X 想用基准 hash 校验（JiuRiWu） | X 的基准是原始条目 hash，R 已改 → 校验失败/拒绝，或 X 跳过 | `patch-asar.mjs` 的 pristine 基准校验 [推] |
| LanJinGod 后装 | `app.asar` 被 rename → R 的 `ensureStaged` 返回 null → 重启接口 500 `nothing_to_install`、状态为 `nothing_to_stage` | `index.js:261-265,478-479` [推] |
| 两者互装后恢复（restore/rollback 脚本） | 第三方 restore 把 main.js 整段回退到原始 → **抹掉 R 的补丁**；R 的 `Restore-Backup` 同样可能覆盖 X | 各自脚本 [推] |

### 5.3 为什么 dsh-retry 会「静默吞掉」第三方补丁（机制链路，[推]，代码已读）

关键调用链（启动 3 秒后的自愈走 `ensureInstalled`（`:521` → `:386`）；`/dsh-retry/restart` 与 `/dsh-retry/prepare` 直接调用 `ensureStaged`（`:456`、`:547`））：

```
ensureStaged(paths, log)                                  index.js:260
  liveState   = inspectPatchState(live)                   ← 只认自家 marker
  backupState = inspectPatchState(backup)
  source      = choosePatchSource({liveState, backupState})
                                                          :202-206
      · live 无可读 → backup
      · live 无自家 marker → 'live'        ← 此时 X 补丁会作为基线被保留
      · live 有自家 marker → 'backup'      ← 此时 X 补丁不在基线里
  if source === 'backup' && 版本不同 → 拒绝        :274-285
  if source === 'live' → ensureBackupFresh(...)     :286, :215-248
      把「无自家 marker」的 live 当作 pristine 复制成 .bak   ← X 补丁被固化进「原始基线」
  reuseStaged() 只比较 previous.source / sourceSize / sourceMtimeMs
                                                          :315-330（不比较插件版本、不比较 live）
  meta.expectedSize / expectedMtimeMs = 当前 live 的 size/mtime
                                                          :300-310；写回点 :365
  若不可重用 → buildPatchedAsar(source=backup) → 只含 R 补丁
                                                          patch.js:183-216
ensureInstalled(...)                                      :384-421
  isCurrent(live, staged) 比较 main/account 的 sha256      :42-55
      · live 含 X 补丁 → sha 不同 → 不 current
  launchHelper(..., expected: meta.expected)              :412-419
restart-helper.ps1                                        :80-105
  Test-SourceFresh：只比 live 的 size 与 mtime（±1000ms）
      而 expected 刚刚在 ensureStaged 里被刷新为「当前 live」  ← 关键
  → kill app → Copy-Item patched asar → Move-Item 覆盖 live
                                                          :246-262
```

结论（三条，按严重度）：

1. **重建源不对称**：live 一旦带上 R 的 marker，重建源就变成 `.bak`（通常是不含 X 的原始基线），重建结果只含 R 补丁。安装成功后 **X 补丁消失**，且日志里只有常规的 `staged patched asar` 记录，UI 无提示。
2. **新鲜度校验被自己刷新掉**：`expected*` 在每次 `ensureStaged` 末尾都会用当前 live 重新写入（`:307,365`），而 helper 只比 size/mtime。因此「上一轮运行之后」发生的第三方修改（尤其是等长改写，size 不变，mtime 变化但在刷新后已一致）不会触发 `Test-SourceFresh` 拒绝，R 会把只含自己补丁的 staged 归档覆盖上去。
3. **备份语义污染**：`ensureBackupFresh` 把「无自家 marker」等同于 pristine（`:217-226`），第三方补丁会被写进 `.bak`，从此这套 `.bak` 不再是纯净基线；`restore` 会恢复到「带 X 的基线」，而重建又只保留 R——两种路径会产出不同的 asar，但都没有清单说明差异。

### 5.4 时间窗与并发

`Test-SourceFresh` 真正能兜住的是「构建 → 等 app 退出 → 安装」这段窗口内的 live 变化（DSH 自动更新、用户重装等）。若窗口内 live 被改动（size 或 mtime 超出容差），helper 放弃安装并 `Start-App`，日志记 `refusing to install stale patch`；`MAX_AUTO_RESTARTS=2` + `restart-guard.json` 限制自动重试（`index.js:124`、`:400-421`）。这条保护对第三方补丁有效，但被 §5.3 第 2 条的「刷新」绕过，因为刷新发生在窗口之前。

### 5.5 DSH 升级后的叠加

DSH 更新会整体替换 `app.asar`：R 的补丁消失，X 的补丁也消失。此时：

- 若 X 是「每次更新后自动重打」类（描述里明确写了的：YOGEMOW、YSDLNGF、InkStain258、CZY1326 类），X 先重打、R 启动自愈再打：`live 无 R marker → source=live`，R 会在 X 的补丁之上再插自己的项 → **双项**，并且 `ensureBackupFresh` 把 X 的 asar 复制成 `.bak`（污染基线，见 §5.3 第 3 条）。
- 若 R 先重打、X 后重打：X 的锚点大概率仍匹配（R 的插入在 quit 前，单行锚不受影响）→ 双项。
- `.bak` 若还是旧版本，`ensureStaged` 会拒绝从它重建（`index.js:274-285`），直到 live 被替换成「无 marker 的可读 asar」触发备份刷新；期间状态可能是 `nothing_to_stage` 或错误日志，用户无感知——建议在状态页显示「备份版本与当前 DSH 不一致」。

### 5.6 版本/格式差异的影响

- dsh-retry 锚点使用**格式化源码**（制表符 + 换行，`patch.js:25-42,63-90`）。第三方插件有的用同样格式（hxh、Nebula），有的用**压缩格式**（QIRSHENG 的 `click:this.options.quit`）。这说明不同插件可能面向不同 DSH 构建形态；实际能否叠加取决于目标 `main.js` 的格式，**必须实测**，本报告不将其判为「必然冲突」。
- 所有第三方插件都要求「等长」，而 dsh-retry 重打包后会改变 header 与 offset；因此 X 在 R 之后运行时的「header integrity 探针」（CZY1326）仍可能工作（R 会重写 integrity，`asar.js:176,189`），但 YOGEMOW 依赖的 `entry.integrity.hash` 位置/结构是否兼容需要实测。

---

## 6. 加固建议（按优先级；仅建议，未改代码）

> 原则：让「未知补丁」从**不可见**变成**可见、可拒、可追溯**；不改动任何第三方插件，也不改变本插件对正常用户的默认体验。

### P0（建议 0.5.2 内完成）

**P0-1 检测未知补丁并在状态中暴露**

- 在 `inspectPatchState`（`dsh-retry\lib\patch.js:217-249`）中，对 `MAIN_ENTRY` 与 `ACCOUNT_ENTRY` 文本做「非本插件改动」判定：
  - 已知第三方标记清单（常量表）：`dsh-tray-restart:menu`、`dsh-restart-menu-patch`、`quit-all.ps1`、`dsh-desktop-menu`、`dsh-restart-button`、`dsh-close-to-quit`、`dsh-purge`、`dsh-acrylic`、`@local/dsh-restart-button` 等；
  - 通用启发式：`main.js` 中除本插件插入块外出现 `app.relaunch()`/`quitWithoutConfirmation` 的额外出现次数、`label: messages.restartApplication` 的出现次数 > 1；account client.js 中出现额外 `id === "…restart…"` 分支或 `data-dsh-…` 属性。
  
  返回新增字段 `foreignPatches: [{ entry, markers: [...] }]`，并在 `/dsh-retry/status`（`index.js:531-538`）中透出。
- 验收：本机现状返回 `foreignPatches: []`；对一份「hxh230802 风格」的打补丁 asar 副本（可在临时目录构造测试夹具）返回非空。

**P0-2 不一致时拒绝自动安装（可配置）**

- `choosePatchSource`/`ensureStaged`（`index.js:202-206,260-375`）在 `liveState.foreignPatches?.length && !liveState.mainPatched` 时：
  - 默认行为：不自动安装（状态 `foreign_patch_detected`），在 UI/状态端点告警「检测到其他插件的 asar 补丁，已暂停自动安装，避免覆盖」；
  - 显式用户动作（设置页按钮「仍然覆盖」）才继续。
- 理由：避免 §5.3 的静默覆盖；代价是少量用户需多点一次，但可逆。
- 验收：带第三方补丁的 live 上启动后，`app.asar` 不被替换，状态页显示原因；用户点「仍然覆盖」后可正常安装。

**P0-3 备份加显式清单（manifest）**

- `ensureBackupFresh`（`index.js:215-248`）写备份时同步写 `resources\app.asar.dsh-retry.bak.meta.json`：`{ sha256, size, desktopVersion, createdAt, source: "live", foreignPatches: [...] , pluginVersion }`；
- 重建前校验：`.bak.meta.json` 存在且 sha/size 与 `.bak` 一致、`foreignPatches` 与当前判定一致，否则视为「来源不明」并拒绝自动使用（或提示用户确认）。
- 验收：删除/篡改 `.bak.meta.json` 后，插件不会自动从 `.bak` 重建，状态页给出原因。

### P1（建议 0.6.0 前）

**P1-1 helper 新鲜度校验升级到 SHA256**

- `lib\helper.js:32-33` 增加 `-ExpectedAsarSha256`；`scripts\restart-helper.ps1:80-105` 在 size/mtime 之外比较 SHA256（PowerShell `Get-FileHash`）。这样 §5.3 第 2 条的「等长补丁 + expected 刷新」不再能悄悄通过。
- 验收：在 staging 完成后手工在 live 上做一次等长改动（同 size、不同内容），helper 必须拒绝安装并记日志。

**P1-2 安装失败/放弃原因可见**

- helper 现有日志只写文件（`restart-helper.log`）；在 `install-armed.json`/`stagedMeta` 里记录本次失败原因码（如 `live_changed`、`foreign_patch`、`sha_mismatch`），`/dsh-retry/status` 读取并显示最近一次结果，避免「点重启没反应」的观感。
- 验收：构造 live 变化场景后，状态端点返回 `lastInstall: { status: "skipped", reason: "live_changed" }`。

**P1-3 回退路径也做来源检查**

- `restart-helper.ps1` 的 `Restore-Backup`（`:143,275`）在覆盖 live 前记录并比对 `.bak.meta.json`；若 live 当前含第三方补丁而 `.bak` 不含（或反之），日志明确写出「回退将移除/保留其他插件补丁」。
- 验收：日志可解释回退会造成什么变化。

**P1-4 DSH 版本升级后的备份轮换**

- `index.js:274-285` 已有「版本不同拒绝用备份」的保护，但只返回 null 并记日志。建议在检测到 `desktopVersion` 变化时把旧 `.bak` 归档为 `.bak.<version>` 并重新从当前 pristine live 生成新备份（配合 P0-3 的 manifest），避免长期卡在「无法自愈」。
- 验收：模拟版本号变化（可改 package entry 副本测试）后，下一次启动自动生成新备份并成功安装。

### P2（体验/文档）

- **P2-1** 若上线 `sidebar.footer.action` 入口（设计稿 `research-implementation-paths.md:368-369`）：与 `dsh-cost-meter` 的 footer CSS、`Choi-Peng/dsh-footer-order` 三方联测；id 维持 `dsh-retry-restart`，order 90，样式不依赖容器顺序。
- **P2-2** README/市场描述里写明：与「会改 app.asar 的插件」共存时的已知表现（双托盘项、更新后需重打、检测到未知补丁会暂停自动安装）；这比承诺「无冲突」更可靠。
- **P2-3** 在状态页显示「重启范围：整机 relaunch（含 shell）」与 dshmarket 的「Host 进程重启」区别，减少用户困惑。
- **P2-4** 与 `13520rygvv/dsh-restart-button`、`SakuraYH1080/dsh-quick-restart` 的账号菜单入口并存时接受「双入口」，不做跨插件 DOM 去重（跨插件去重会引入更脆的耦合）。
- **P2-5** 若将来支持与其他 asar 补丁「协作」，需要维护一个「补丁基线链」格式（谁基于谁、按顺序重放），成本远高于 P0 的「检测 + 拒绝 + 告警」，不建议短期做。

---

## 7. 已验证 / 基于源码推断 边界

| 结论 | 状态 | 依据 |
|---|---|---|
| 本机 11 个插件与本插件无 slot/路由/模块 id/asar 写入冲突 | **已验证** | §3.1–3.4 的 `rg` 命中与文件行号 |
| dsh-cost-meter 会改写 `sidebar.footer.action` 容器布局 | **已验证** | `dsh-cost-meter\lib\client.js:2` 样式常量 |
| dsh-retry 当前只注册 `settings.section`，无 footer 入口 | **已验证** | `dsh-retry\lib\client.js:223-227`；全文件无 `sidebar.footer.action` |
| 本机 live asar 只有 dsh-retry 补丁（Δ 983 B） | **已验证** | `resources\app.asar` 与 `.bak` 的 size/时间；meta、guard、日志 |
| 生态至少 10 个仓库会写 `app.asar` 的 `lib/main.js` | **已验证（读源码）** | §4.2 表中仓库的源码文件 |
| 6 个仓库与 dsh-retry 改同一段托盘/quit 代码 | **已验证（源码锚点比对）** | hxh/Nebula 的 `TRAY_*` 常量；QIRSHENG/maqian/CZY 的 quit 单行锚 |
| 互装后「双项 / 锚点失配 / 静默覆盖」的实际结果 | **基于源码推断** | 机制链路见 §5.3；未在真机做共存安装（约束：不重启 DSH、不改环境） |
| `expected*` 刷新导致新鲜度校验被绕过 | **基于源码推断（高置信）** | `index.js:297-313,307,365` + `restart-helper.ps1:80-105` 完整读码；未实测 |
| dsh-retry 重建会吞掉第三方补丁 | **基于源码推断（高置信）** | `choosePatchSource`/`ensureStaged`/`helper` 链路；`reuseStaged` 不比较 live 内容是关键 |
| `plugins.json` 全量 7,406 条，仅解析 2,354 条 | **已验证** | 抓取文件大小与截断位置；local 解析 |
| 主题类 294 条、restart/tray 类 23 条 | **已验证（抽样内）** | 已解析部分的 `category`/名称过滤 |
| 主题插件对 dsh-retry 的具体视觉影响 | **未验证** | 我方样式隔离性已读码；未逐主题联测 |
| `YSDLNGF`/`InkStain258`/`geitaHer0` 的具体补丁策略 | **未读源码（推断自描述）** | 仅注册表描述 |
| dshmarket restart 与 dsh-retry 并发时的具体表现 | **基于源码推断** | 两侧实现均已读；未同时触发实测 |

---

## 8. 附录：证据索引

**本机文件**

- `dsh-retry\lib\client.js:10-11`（模块 id）、`:17-18`（RESTART/STATUS URL）、`:48-56`（样式注入与 `.dsh-retry-*`）、`:223-227`（唯一 slot 注册 `settings.section`）
- `dsh-retry\lib\patch.js:3-23`（entry/marker/features）、`:25-61`（托盘锚点与 watcher）、`:63-90`（account 菜单项与分支）、`:96-108`（replaceOnce/missingFeatures）、`:183-216`（buildPatchedAsar + verifyAsar deep）、`:217-249`（inspectPatchState）
- `dsh-retry\lib\index.js:42-55`（isCurrent）、`:124`（MAX_AUTO_RESTARTS）、`:202-206`（choosePatchSource）、`:215-248`（ensureBackupFresh）、`:260-375`（ensureStaged/reuse/meta 刷新）、`:384-421`（ensureInstalled）、`:424-428`（sameOrigin）、`:531-563`（三条 exact 路由）、`:519-521`（启动自愈）
- `dsh-retry\lib\asar.js:159-201`（rebuildAsar：保持 Stored 相对顺序、重算 offset/integrity）、`:235-257`（verifyAsar）
- `dsh-retry\lib\helper.js:10-40`（helperArgs：`-ExpectedAsarSize/-ExpectedAsarMtimeMs/-CreateBackup`）、`:47-69`（launchHelper/helperScript）
- `dsh-retry\scripts\restart-helper.ps1:8-12`（参数）、`:80-105`（Test-SourceFresh：size/mtime ±1000ms）、`:143`（Restore-Backup）、`:179,220`（两处新鲜度检查）、`:196`（taskkill）、`:226-240`（备份）、`:246-262`（Copy-Item + Move-Item 安装）、`:275`（失败回退）
- `dsh-retry\lib\desktop.js:8-29`（asar/staging/trigger/backup 路径）
- `D:\Program Files (x86)\dsh\resources\app.asar`（182,767,697 B）、`app.asar.dsh-retry.bak`（182,766,714 B）、`dsh-retry-build\app.asar.patched.meta.json`、`restart-guard.json`、`install-armed.json`

**本机 profile 证据**

- `dsh-cost-meter\lib\client.js:9`（两个 settings.section）、`:2`（footer 槽全局 CSS）
- `billion-context\dist\agent\dsh-native-client.js:741-742`
- `@michengai\dsh-archive-manager\lib\client.js:23`、`lib\index.js:7-10`
- `@michengai\dsh-skills-manager\lib\client.js:60`、`lib\index.js:308,706-708`
- `dsh-ppt\lib\client.js:1712`
- `dshmarket\client\client.js:18335`、`lib\routes.js:6509`、`lib\restart.js:653-688`、`lib\dsh-install.js:18,25-33`
- `dsh-mnemon\lib\index.js:18280`

**生态源码（`blob/HEAD` 链接）**

- https://github.com/hxh230802/dsh-tray-restart/blob/HEAD/lib/main-patch.js
- https://github.com/maqian1632/dsh-tray-restart/blob/HEAD/tray-patch.js
- https://github.com/QIRSHENG/dsh-tray-restart/blob/HEAD/lib/patcher.mjs
- https://github.com/CZY1326/dsh-restart-button/blob/HEAD/scripts/patch-asar.cjs
- https://github.com/NebulaArcanum/dsh-desktop-restart-menu/blob/HEAD/apply.js
- https://github.com/JiuRiWu/dsh-restart/blob/HEAD/shell-patch/patch-asar.mjs
- https://github.com/YOGEMOW/dsh-desktop-menu/blob/HEAD/lib/desktop-menu.js
- https://github.com/Freewind72/dsh-close-to-quit/blob/HEAD/shell-patch/build-patch.cjs
- https://github.com/LanJinGod/dsh-purge/blob/HEAD/lib/desktop.js
- https://github.com/13520rygvv/dsh-restart-button/blob/HEAD/client.js
- https://github.com/SakuraYH1080/dsh-quick-restart/blob/HEAD/client.js
- https://github.com/wangbofan/dsh-restart-button/blob/HEAD/client.js
- 注册表条目：https://awesome-dsh-plugin.com/p/13520rygvv/dsh-restart-button/ ；`https://awesome-dsh-plugin.com/plugins.json`（已截断，仅供抽样统计）
