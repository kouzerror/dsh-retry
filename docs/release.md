# 发布流程（Release SOP）

发版只有一条主路径：**改 `package.json` 版本 → 提交并推送 `main` → 推一个与版本一致的 tag → GitHub Actions 自动测试、打包并创建 Release**。

- 工作流：[`.github/workflows/release.yml`](../.github/workflows/release.yml)（`push` tag `v*` 触发）
- 产物：`dsh-retry-<version>.tgz`（`npm pack` 生成），挂在同名 tag 的 GitHub Release 上
- 版本号唯一来源：`package.json` 的 `version`。tag 是它的 `v` 前缀镜像，不存在第二个版本文件。

## 0. 前置条件

- Node >= 22.19.0（`package.json` 的 `engines.node`；CI 用 Node 22）。
- 仓库零运行时依赖，跑测试**不需要** `npm install` / `pnpm install`。
- 手工兜底需要 `gh` 已登录（`gh auth status`），且对 `kouzerror/dsh-retry` 有写权限。
- `main` 干净，最近一次 CI 绿。

## 1. 改版本号

手改 `package.json` 的 `version`（例如 `0.5.1` → `0.6.0`）。同时检查 README 里写死的版本示例（安装章节的 tgz 文件名、升级说明等），一并改掉，避免用户照着旧文件名安装。

```powershell
node -p "require('./package.json').version"
```

不要用本地 `npm version` 一步到位（它会自行 commit + 打 tag，容易和下面的流程重复打 tag）。

## 2. 本地先跑一遍 CI 会跑的命令

```powershell
node scripts/check-syntax.mjs   # 与 workflow 的 Syntax check 步骤一致
npm test                        # 跑 package.json scripts.test 列出的全部用例，无需安装依赖
npm pack                        # 产物：dsh-retry-<version>.tgz
```

`npm pack` 只是为了提前发现打包问题；产物用完删掉即可（`.gitignore` 已忽略 `*.tgz`），不要提交。

## 3. 提交并推送 `main`

```powershell
git add package.json README.md
git status --short          # 确认没有 *.tgz 被 add
git commit -m "release: 0.6.0"
git push origin main
```

## 4. 打 tag 并推送（这一步才触发 Release）

```powershell
git tag -a v0.6.0 -m "dsh-retry 0.6.0"
git push origin v0.6.0
```

**tag 名必须是 `v` + `package.json` 的 `version`，且完全相等。** `release.yml` 的第一个校验步骤会读 `package.json` 对比 `${GITHUB_REF_NAME#v}`，不一致直接 fail，不会产生任何 Release。注意只推 tag 不推 `main` 也会触发（`on.push.tags` 与分支无关），但 tag 应指向已推送的提交。

## 5. 工作流做了什么

| 步骤 | 内容 |
| --- | --- |
| Checkout | `actions/checkout@v4`，`fetch-depth: 0`（`--generate-notes` 需要完整历史和旧 tag） |
| Set up Node 22 | `actions/setup-node@v4`，`node-version: '22'` |
| Verify tag matches package.json version | tag 与 `version` 不一致 → `::error::` + `exit 1` |
| Syntax check | `node scripts/check-syntax.mjs` |
| Unit tests | `npm test`（即 `node --test test/*.test.js` 的显式列表） |
| Pack tarball | `npm pack` → `dsh-retry-<version>.tgz` |
| Publish GitHub Release | 先 `gh release view`；不存在则 `gh release create "$GITHUB_REF_NAME" ... --title "dsh-retry ${GITHUB_REF_NAME#v}" --generate-notes`，已存在则 `gh release upload "$GITHUB_REF_NAME" ... --clobber` |

- 权限：workflow 顶层 `permissions: contents: write`；发布步骤注入 `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`。
- Release 正文由 `--generate-notes` 按「上一个 tag → 本 tag」的提交自动生成。
- 查看运行：`gh run list --workflow release.yml --limit 3`，或 `gh run watch <run-id>`。

## 6. Release 已存在时

人工先发过 Release、或对同一个 run 点 **Re-run jobs**，都会命中「已存在」分支，走 `gh release upload --clobber`：同名 asset 被覆盖，构建不会失败。所以重跑是幂等的，不需要先删 Release。

只在需要改标题/正文时才手工介入：

```powershell
gh release edit v0.6.0 --title "dsh-retry 0.6.0" --notes-file CHANGELOG.md
```

## 7. 手工兜底（Actions 不可用，或需要本地发版）

在仓库根目录、`main` 与 tag 都已就绪的前提下：

```powershell
node scripts/check-syntax.mjs
npm test

$version = node -p "require('./package.json').version"
$tag = "v$version"
$tgz = "dsh-retry-$version.tgz"
npm pack                        # 或 pnpm pack，产物同为 dsh-retry-<version>.tgz

# Release 不存在时
gh release create $tag $tgz --title "dsh-retry $version" --generate-notes

# Release 已存在时（覆盖同名 asset）
gh release upload $tag $tgz --clobber
```

两个 Windows 注意事项：

- PowerShell 不会替原生命令展开通配符，所以这里用显式文件名 `$tgz`，不要写 `dsh-retry-*.tgz`（那是 Linux shell 的写法）。
- 若 `pnpm` 不在 PATH（DSH 自带的 pnpm 不在系统 PATH 里），直接用 `npm pack` 即可，两者产物名一致；本仓库无运行时依赖，不涉及 lockfile 差异。

清理本地产物：

```powershell
Remove-Item dsh-retry-$version.tgz
```

## 8. 规则与红线

- **tag 必须等于 `v` + `package.json.version`**。不一致时 workflow 直接失败；手工发版时 `gh release create` 前也要自己核对。
- **`*.tgz` 不进 git**（`.gitignore` 已有 `*.tgz`）。不要 `git add -f` 打包产物；Release asset 是唯一分发渠道。
- **每次发版都递增 `version`**。tag 已存在时 `git push` 会因为「everything up-to-date」不产生 push 事件，也就不会触发 workflow；要重发同一版本只能删远端 tag 重推，或走手工兜底。
- 工作流不跑 `npm install`：零运行时依赖是前提。将来如果引入依赖，需要补 `npm ci` 并提交 lock 文件，否则 CI 与本地行为会分叉。
- 打包文件名来自 `package.json` 的 `name` + `version`：`dsh-retry-<version>.tgz`。改包名会让 `release.yml` 里的 `dsh-retry-*.tgz` 通配符和标题前缀失配，必须同步改 workflow。
- action 用主版本号引用（`checkout@v4` / `setup-node@v4`），升级大版本时顺带确认 `fetch-depth` 与 Node 版本仍符合预期。

## 9. 这份配置怎么验证

GitHub Actions 无法在本地执行，YAML 的 action 解析只能由 GitHub 在 `push tag` 后完成。本地可做、也做过的是：

```powershell
# 与 workflow 同样的脚本与测试（真实输出见发版 PR/提交说明）
node scripts/check-syntax.mjs
npm test

# 形状检查：缩进、触发行、action 版本、权限、GH_TOKEN
Get-Content .github\workflows\release.yml
node -e "const s=require('node:fs').readFileSync('.github/workflows/release.yml','utf8'); console.log(s.length, s.split('\n').length, /actions\/checkout@v4/.test(s), /actions\/setup-node@v4/.test(s), /contents: write/.test(s), /secrets.GITHUB_TOKEN/.test(s))"
```

推送 tag 后的端到端确认：

```powershell
gh run list --workflow release.yml --limit 1   # 最近一次 run 结论 success
gh release view v0.6.0                          # 存在且 assets 含 dsh-retry-0.6.0.tgz
gh release download v0.6.0 --pattern "*.tgz" --dir $env:TEMP   # 能下载
```

如果第一次真实发版失败，优先看 run 里失败步骤的日志：`gh run view <run-id> --log-failed`。