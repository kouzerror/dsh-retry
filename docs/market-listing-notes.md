# dsh-retry → awesome-dsh-plugin 上架调研笔记

调研时间：2026-10-28 21:15–21:40 (+08)。只读调研，未做任何写入仓库操作。
条目草稿：`C:\Users\Fs-1f\AppData\Local\Temp\kouzerror__dsh-retry.yml`（983 B，已用 yaml 解析器校验）
目标仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin（default `main`，CC0-1.0）
插件仓库：https://github.com/kouzerror/dsh-retry（public，MIT，Windows 桌面端 host-only）

## 0. TL;DR

1. 收录不需要 npm：GitHub 仓库 + `package.json` 里有 `dsh.bundle` 即可，本机 npm 未登录**不是阻塞点**。
2. 提交 = 在 `data/plugins/` 加**一个** `kouzerror__dsh-retry.yml`，不提 npm 字段、不提 tarball 字段（写了反而破坏自动更新），README 不用碰。
3. 硬门槛只有 3 个：`dsh.bundle` ✅、仓库满 1 天 ⏳（2026-10-29T12:59:55Z 起满）、`dsh-plugin` topic ✅（10-28 13:20 已加）。
4. 本机 `github.com:443` 不通，`git clone` / `pnpm add github:` 全废 → PR 必须走 `gh api`（api.github.com 可用）纯 API 流程，下文命令全部实测语法有效。
5. 实际合并速度：抽样最近合并的加条目 PR 是 **20 分钟 ~ 5 小时**（远快于文档说的「最多一天」）；当前 open PR 只有 1 条。
6. 重启类插件极度饱和（data/plugins 里 `restart` 命中 260 个文件），但**重复不是拒绝理由**，PR 正文写清「账户菜单入口 + 退出时分离 helper 装补丁 + 升级后自动重打」三点差异即可。

## 1. 数据链（改了 yml 之后发生什么）

```
data/plugins/*.yml            ← 唯一人工输入（一插件一文件）
  └─ scripts/generate-readme.mjs → README.md / README.zh.md（生成物，禁改；合并后 sync-readme.yml 自动重生成）
  └─ scripts/build-site.mjs     → docs/plugins.json（站点数据源，合并即更新）
       └─ https://awesome-dsh-plugin.com/plugins.json ← dshmarket 每次打开市场时实时抓
       └─ scripts/publish-catalog.mjs → npm 包 dsh-plugin-catalog（镜像加速，中国大陆访问 Pages 慢）
docs/index.json               ← 另一套「插件市场索引」，只收有 npm 包的条目（无 npm 不进，不影响上架）
```

- dshmarket 安装优先级（`node_modules/dshmarket/lib/sources.js:506 installTargetFor`）：npm 包 → 作者 GitHub Release 预构建 tarball → 整仓 GitHub 源码（`github:owner/repo`）。
- 更新检测（`updates.js:834-847`）：`github:` 安装按仓库自身 version / commit 对比远端 HEAD；**tarball 安装只有在条目另有匹配 npm 包时才会查更新**，否则永远「无更新」。
- 失败降级：`scripts/probe-tarballs.mjs` 每日用 `Range: bytes=0-0` 探测所有 tarball，404/410 直接从站点数据里剔除该字段（静默降级为 git 安装），不会造成构建失败。

## 2. 条目格式与校验规则

### 文件与命名
- 路径必须恰好一层：`data/plugins/<owner>__<repo>.yml`（小写 owner/repo，`__` 双下划线）。monorepo 子包用 `owner__repo--packages-x.yml`。
- 本插件：`data/plugins/kouzerror__dsh-retry.yml`（当前不存在，`gh api` 404 已确认）。

### 字段白名单（scripts/lib/entries.mjs `ENTRY_KEYS`）
`url` `name` `category` `description` `icon` `tarball`（`file` 由读取器注入，自己别写）。**出现任何其他字段 → 校验失败**，典型坑：手写 `npm:`（npm 映射由 registry 自动采集，不接受手填）。

| 字段 | 规则 |
|---|---|
| `url` | 必填，必须是 `https://github.com/<owner>/<repo>[/tree/<branch>/<sub>]` |
| `name` | 必填，链接文本；含 `/` 时小写后必须等于 url 的 `owner/repo`；含 `#` 时取 `#` 前部分比较 |
| `category` | 必填，23 选 1：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`；主题/皮肤归 `theme`（默认 `ui`） |
| `description.en` | 必填，**单行**（不能有换行）；含 `: ` 时必须引号包裹 |
| `description.zh` | 可选；语言只允许 `en`/`zh`，多出别的 locale → 报错 |
| `icon` | 可选，GitHub 托管的 png/jpg/jpeg/webp，约 96px 见方；不给则回退作者头像 |
| `tarball` | 可选，必须 https，host ∈ `github.com`/`objects.githubusercontent.com`/`release-assets.githubusercontent.com`，`github.com` 路径必须含 `/releases/`，结尾 `.tgz`/`.tar.gz` |

### 排序
无需手工排序：生成器按 `CAT_IDS` 的分类顺序 + 类内 `url` 字母序输出，yml 里写不写顺序都不影响。

### CI 校验（.github/workflows）
- `pr-check.yml`（fork-safe，用调用方 token 最小权限）：`npm ci` → Stale-fork guard → data/plugins 下只允许 `.yml` → 新增文件必须一层且命名符合 → 改了 README 却没改 data/plugins 则失败 → `READMEs match data/plugins`（**PR 没动 README 时该步跳过**）→ `npx awesome-lint` → `node --test`（added-dates / capabilities / discussion-adoption / entry-path）→ `node scripts/build-site.mjs`。
- `pr-gate.yml`「Submission gate」：`workflow_run` 在 PR check 完成后于 base 仓库上下文跑 `scripts/check-submission.mjs`，把结果作为 check run 回贴。4 条硬检查：
  1. 每 PR ≤ **3** 个条目（`MAX_ENTRIES_PER_PR`）；
  2. 仓库任意位置 `package.json` 必须声明 `dsh.bundle`（只有 `dsh.client` → `declares only dsh.client — that alone is not installable`）；
  3. 仓库创建满 **1 天**（`MIN_AGE_DAYS=1`，只对新条目生效）；
  4. 不是 DSH 本体 / 不是 vendored `@deepseek-ai/dsh-base`。
- `regate.yml`：cron `19 */6 * * *` 重跑 open PR 的 gate；`aged` 类失败（原文含 `days old` / `commit(s)`）需距上次 gate ≥24h 才重跑，**不需要 push 空提交**。

## 3. 条目草稿（终稿，逐字）

```yaml
url: https://github.com/kouzerror/dsh-retry
name: kouzerror/dsh-retry
category: ui
description:
  en: 'Adds a native Restart DeepSeek Harness item to the Windows system tray menu and the account menu of the DSH desktop app: the plugin prepares a patched resources/app.asar at startup, a detached helper backs up the original and swaps it in after a normal exit, the patch is re-applied after each desktop update, and either item relaunches the app gracefully on the next launch. Windows desktop only; other hosts report 409 not_desktop.'
  zh: '给 DSH 桌面端的 Windows 系统托盘菜单和账户菜单各加一项原生「重启 DeepSeek Harness」：插件启动时准备好补丁版 resources/app.asar，由一个分离的 helper 在正常退出后备份原文件并替换，桌面端每次更新覆盖后自动重打补丁，下次启动即可看到两个入口，点击走 app.relaunch() 优雅重启。仅支持 Windows 桌面端，其它宿主返回 409 not_desktop。'
```

校验结果：yaml 解析通过；顶层 keys = url/name/category/description；无未知字段；`category: ui` ∈ 23 项；`en` 433 字符单行；`zh` 211 字符单行。文件已生成在 `%TEMP%\kouzerror__dsh-retry.yml`（提交前会去 BOM）。

### 源的选择（三选一，推荐 A）
- **A（推荐）不写 `tarball`**：市场按 `github:kouzerror/dsh-retry` 源码安装；仓库无 `prepare`/`prepack`、无 dependencies，安装不需要 `allowBuilds` 授权；发新版后 market 能按仓库 version/commit 正常提示更新。
- B 写 pinned tarball `https://github.com/kouzerror/dsh-retry/releases/download/v0.2.0/dsh-retry-0.2.0.tgz`：安装更快，但**每次发版都会 404**（资产名带版本），且 tarball 安装永远拿不到更新提示 → 需要每次发版再提 PR 改 yml，不推荐。
- C 写版本无关资产名 `.../releases/latest/download/dsh-retry.tgz`：不用每次改 yml，但作者得把最新资产固定叫这个名，且仍失去更新提示（同 B 的 updates 逻辑）→ 也不如 A。
- npm 发布（D）：**本机不可用**，`npm whoami` → `ENEEDAUTH`；且非必需。若将来发布：`package.json.repository` 必须指回 `kouzerror/dsh-retry` 才会被自动映射，届时 yml 不用改。

## 4. PR 命令序列（API-only，本机 github.com:443 不通）

前置事实：`gh` 已登录 `kouzerror`（scopes: gist, read:org, repo, workflow）；`api.github.com` 可用；`kouzerror/awesome-dsh-plugin` fork **尚不存在**；repo 对该列表历史 PR 数 0。

时间窗口：`dsh-retry` 创建于 `2026-10-28T12:59:55Z` → 满 1 天是 `2026-10-29T12:59:55Z`（+08 为 **10-29 21:00**）。在此之前提交，gate 会红并给「no need to resubmit」提示，且 regate 的 24h 冷却会让它更晚才绿 → **等 21:05 之后提交最优**。

全部步骤可自动化（gh api），无需本地 clone：

```powershell
# 0) 前置确认（只读）
gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/kouzerror__dsh-retry.yml   # 期望 404（无重复条目）
gh api repos/kouzerror/dsh-retry --jq '{created:.created_at,topics:.topics,ver:.default_branch}'

# 1) fork（幂等，已 fork 会报 already exists 可忽略）
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false
# 等 fork 就绪（几秒），取 fork 的 main SHA
$sha = gh api repos/kouzerror/awesome-dsh-plugin/git/ref/heads/main --jq .object.sha

# 2) 建分支
gh api -X POST repos/kouzerror/awesome-dsh-plugin/git/refs -f ref=refs/heads/add-dsh-retry -f sha=$sha --jq .ref

# 3) 写入条目（内容来自 %TEMP%\kouzerror__dsh-retry.yml，去 BOM 后 base64）
$raw = (Get-Content "$env:TEMP\kouzerror__dsh-retry.yml" -Raw -Encoding UTF8).TrimStart([char]0xFEFF)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw))
gh api -X PUT "repos/kouzerror/awesome-dsh-plugin/contents/data/plugins/kouzerror__dsh-retry.yml" `
  -f message="Add kouzerror/dsh-retry entry" -f branch=add-dsh-retry -f content=$b64 --jq .commit.sha

# 4) 开 PR（标题沿用现有惯例：Add <owner/repo> (<category>)）
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin `
  --base main --head "kouzerror:add-dsh-retry" `
  --title "Add kouzerror/dsh-retry (ui)" `
  --body-file "$env:TEMP\dsh-retry-pr-body.md"

# 5) 盯 CI（提交后 1-3 分钟出结果）
gh pr checks <PR#> --repo awesome-dsh-plugin/awesome-dsh-plugin --watch
gh pr view <PR#> --repo awesome-dsh-plugin/awesome-dsh-plugin
```

自动化程度：第 0–5 步全部可脚本化；唯一需要人判断的是 PR 正文措辞与「等满 1 天」的时间点。分支名 `add-dsh-retry` 已在 fork 侧，不影响上游。
**不要做的事**：不要手改 README（本地也 clone 不了）、不要加 `npm:` 字段、不要在一个 PR 里带别的条目、不要为 gate 失败推空提交。

### PR 正文草稿（$env:TEMP\dsh-retry-pr-body.md）

```markdown
Adds `kouzerror/dsh-retry` (ui): a native **Restart DeepSeek Harness** entry in two places the
existing restart plugins do not cover — the Windows **system tray menu** and the **account menu**
(avatar popup) — plus a patch lifecycle that survives desktop updates.

- Patched `resources/app.asar` is prepared at startup and installed by a detached helper **after a
  normal exit** (original kept as `app.asar.dsh-retry.bak`), so nothing rewrites the asar while
  DSH is running; the patch is re-applied automatically after each desktop update.
- Byte-identical verification of every asar entry outside the patch (`npm run verify`).
- Either entry relaunches gracefully (`app.relaunch()`); tray path direct, account-menu path via
  `POST /dsh-retry/restart`; status at `GET /dsh-retry/status`.
- Windows desktop only; Web hosts get `409 not_desktop`.
- Source-install friendly: no dependencies, no install scripts, `dsh.bundle.patch` → `cordis.patch.yml`.

Closest neighbours: maqian1632/dsh-tray-restart and QIRSHENG/dsh-tray-restart (tray only),
Joshua1ya/dsh-tray-restart (session header/tray, dev), luoshuizhiwei/dsh-desktop-restart (5 entry
points). Differences above are the account-menu entry and the exit-time helper install.

Checklist done: single `data/plugins/kouzerror__dsh-retry.yml`, `dsh.bundle` declared, repo >1 day,
`category: ui` valid, no superlatives, `dsh-plugin` topic set.
```

## 5. 审核周期与常见拒绝原因

- 官方说法：贡献者 PR「通常一天内」被处理；市场 README 说列表更新会实时反映。
- 实测（抽样最近 merged）：20 分钟 ~ 5 小时，全部当天合并；open PR 队列当前只有 1 条 → 很快。
- CI 绿 ≠ 一定合并。维护者会读源码核对描述，常见拒绝/打回原因：
  1. 仓库不足 1 天（gate 自动红，无需操作，会自动变绿）；
  2. `description` 夸大/与实际功能不符（审核会逐条对照，描述里的数字、API 名都会被核）；
  3. 只有 `dsh.client` 没有 `dsh.bundle`；纯 meta-package（聚合别人的包）不收；
  4. 分类明显不符（首选类不对会被要求改，但不至于直接拒）；
  5. 一个 PR 里塞多个条目/动了别人的条目（gate 会列出被改的既有条目，#1348 就是两次蒙混被抓）；
  6. 源码可疑（混淆、外传凭据、异常安装期行为）；
  7. 依赖指向原作者以外的镜像。
- 打回信号：`held: author` 标签（暂停合并队列，不自动摘除）。处理方式：往**同一分支**推修复 + 在 PR 里发**一条**说明性评论；`held` 自己不会消失，需要重评审。
- 与已有条目重复**不是**拒绝理由（先到先得只是平局依据，更好的分叉可以收录）；但要在 PR 正文说明差异，否则可能被要求合并/解释。

## 6. 上架后版本更新机制

- **条目不需要随发版更新**（本方案不填 `tarball` 时）：市场按 `github:kouzerror/dsh-retry` 安装，用户端 `updates.js` 比对仓库 version/commit → 你打新 tag/Release 后，用户市场里就会出现「可更新」，**无需再提 PR**。
- 站点数据刷新：`build-site.yml` 在 `push main` 时部署（合并后几分钟内），每日 `23 2 * * *` UTC 全量 probe（tarball/star/README/截图/能力扫描），另有 `workflow_run(Sync READMEs)` 触发。
- 想改描述/分类/图标/删除条目：PR 只改自己那一行 yml，README 依然别动。
- 想加快安装（免 `allowBuilds` 授权）：以后发布 npm 包（`repository` 指回本仓库即自动映射），条目本身不用改。
- `docs/index.json`（另一套索引）只收 npm 包，无 npm 的插件不会进它，属正常。

## 7. 风险与注意

- **竞品密集**：重启类 50+ 条，最接近的是 maqian1632（托盘单入口）与 QIRSHENG（托盘三入口），都是 `ui`；我们多出「账户菜单入口」和「退出时 helper 安装 + 升级后自动重打」，PR 正文必须写明，否则可能被当成重复。
- 条目文件编码：必须 **UTF-8 无 BOM**（PowerShell `Set-Content -Encoding UTF8` 会写 BOM，提交前 `TrimStart([char]0xFEFF)`）。
- `description` 里有中文引号「」没问题；YAML 单引号标量内的 `:`、`/`、`(` 都安全；只要没有 ASCII 单引号 `'` 就不用转义。
- 本机无法 clone/无法下载 release 资产（curl 返回 000），所有 GitHub 操作只能走 `gh api`。
- 提交前确认 `kouzerror/dsh-retry` 的 `package.json` 仍在根目录且 `dsh.bundle` 未被重构掉；gate 会扫 `package.json` 及 packages/plugins/extensions/bundle/npm 子目录（有限深度）。

## 8. 状态快照（2026-10-28 13:25Z）

- `kouzerror/dsh-retry`：created 2026-10-28T12:59:55Z，pushed 13:20:26Z，version **0.3.0**（未打 tag，Release 最新是 v0.2.0），topics 已含 `dsh-plugin`，description 已填，MIT，0 star，无 dependencies / 无 install 脚本。
- `kouzerror/awesome-dsh-plugin` fork：不存在。
- `data/plugins/kouzerror__dsh-retry.yml`：不存在。
- 本机：npm 未登录（ENEEDAUTH，不阻塞）；gh 已登录 kouzerror；github.com:443 不通、api.github.com 可用。
- 建议：**10-29 21:05 之后**按 §4 执行；v0.3.0 打 tag 与否不影响上架（不填 tarball）。
