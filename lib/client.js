/* Renderer half of dsh-retry.
 *
 * The tray and account-menu entries need the app.asar patch: the desktop shell
 * hardcodes both menus and exposes no plugin seat for them. This bundle is the
 * part that survives a desktop update — it registers one official renderer
 * slot (a "Restart & updates" settings section) that calls the host half's
 * restart route. Profile plugins are not inside app.asar, so this entry stays
 * available even when an update wipes the patch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-retry',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const STYLE_ID = '@dsh-retry/client';
    const RESTART_URL = '/dsh-retry/restart';
    const STATUS_URL = '/dsh-retry/status';
    const UPDATE_URL = '/dsh-retry/update';

    const CSS = `
.dsh-retry-page{display:flex;flex-direction:column;gap:12px;max-width:680px;font:inherit;color:var(--dsw-alias-label-primary,inherit)}
.dsh-retry-card{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-retry-row{display:flex;align-items:center;gap:16px;padding:14px 16px}
.dsh-retry-row-main{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.dsh-retry-title{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.dsh-retry-text{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-retry-note{margin:0;padding:0 16px 14px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-retry-note.is-error{color:var(--dsw-alias-state-error-primary,#c0392b)}
.dsh-retry-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:12px 16px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}
.dsh-retry-kv{display:flex;flex-direction:column;margin:0;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.dsh-retry-kv-row{display:grid;grid-template-columns:112px 1fr;gap:12px;padding:9px 16px;font-size:12px;line-height:1.6}
.dsh-retry-kv-row+.dsh-retry-kv-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.1))}
.dsh-retry-kv dt{color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}
.dsh-retry-kv dd{margin:0;min-width:0;word-break:break-word;font-variant-numeric:tabular-nums}
.dsh-retry-kv dd.is-muted{color:var(--dsw-alias-label-secondary,inherit)}
.dsh-retry-kv dd.is-ok{color:var(--dsw-alias-state-success-primary,inherit)}
.dsh-retry-kv dd.is-warn{color:var(--dsw-alias-state-warn-primary,inherit)}
.dsh-retry-primary{flex:none;height:32px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary,#1f2328);color:var(--dsw-alias-label-primary-inverted,#fff);font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer}
.dsh-retry-primary:hover{opacity:.88}
.dsh-retry-primary:disabled{opacity:.6;cursor:default}
.dsh-retry-ghost{flex:none;height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer}
.dsh-retry-ghost:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.dsh-retry-ghost:disabled{opacity:.6;cursor:default}
.dsh-retry-primary:focus-visible,.dsh-retry-ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dsh-retry-log{margin:0;padding:12px 16px;max-height:168px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06));font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,inherit)}
@media (max-width:560px){.dsh-retry-row{flex-wrap:wrap}.dsh-retry-primary,.dsh-retry-ghost{width:100%}.dsh-retry-actions{justify-content:stretch}.dsh-retry-kv-row{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.dsh-retry-primary{transition:none}}
`;

    function ensureStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin-css', STYLE_ID);
      tag.setAttribute('data-plugin', 'dsh-retry');
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function isEnglish() {
      const lang = (document?.documentElement?.lang) || (typeof navigator === 'undefined' ? '' : navigator.language) || '';
      return /^en(?:[-_]|$)/i.test(lang);
    }

    const t = (zh, en) => (isEnglish() ? en : zh);

    function describeFailure(reason) {
      switch (reason) {
        case 'restart_in_progress':
          return t('重启已在进行中，请稍候。', 'A restart is already in progress.');
        case 'resources_not_writable':
          return t('没有写入安装目录的权限，请手动重启 DSH 或用管理员权限运行。', 'No write access to the install directory. Restart DSH manually or run it as administrator.');
        case 'nothing_to_install':
          return t('补丁暂存失败，请查看 dsh-retry-build 目录下的 restart.log。', 'Staging the patch failed. Check restart.log in dsh-retry-build.');
        case 'cross_origin_request':
          return t('请求被拒绝（跨源）。', 'Request rejected (cross-origin).');
        case 'foreign_patch_detected':
          return t(
            '检测到 app.asar 被其它插件修改过，为免覆盖它们已暂停自动安装。确认要覆盖可选“仍然覆盖并重启”。',
            'app.asar was modified by another plugin, so the automatic install is paused to avoid overwriting it. Choose “Overwrite and restart” to proceed anyway.',
          );
        case 'update_in_progress':
          return t('正在更新，请稍候。', 'An update is already running.');
        case 'update_pending':
          return t(
            '更新已安装，请退出并重新打开 DSH 生效。',
            'The update is installed; quit and reopen DSH to finish.',
          );
        case 'update_failed':
          return t('更新失败，请查看 restart.log。', 'Update failed; check restart.log.');
        case 'not_desktop':
          return t('仅 Windows 桌面端支持。', 'Windows desktop only.');
        default:
          return t(`重启失败（${reason}）。`, `Restart failed (${reason}).`);
      }
    }

    async function postRestart({ force = false } = {}) {
      const response = await fetch(force ? `${RESTART_URL}?force=1` : RESTART_URL, { method: 'POST' });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    }

    /** Shared restart state for the settings page. */
    function useRestart() {
      const [busy, setBusy] = React.useState(false);
      const [detail, setDetail] = React.useState('');
      const [failure, setFailure] = React.useState('');
      const restart = async ({ force = false } = {}) => {
        if (busy) return;
        setBusy(true);
        setFailure('');
        setDetail(t('正在重启 DeepSeek Harness…', 'Restarting DeepSeek Harness…'));
        try {
          const { status, body } = await postRestart({ force });
          // 200/202 mean the helper is already replacing the process; the page
          // disappears before any further state matters.
          if (status === 200 || status === 202) return;
          setBusy(false);
          const reason = body?.error ?? `http_${status}`;
          setFailure(reason);
          setDetail(describeFailure(reason));
        } catch {
          setBusy(false);
          setFailure('fetch_failed');
          setDetail(t('无法连接到 DSH 宿主进程，请手动重启。', 'Cannot reach the DSH host process. Restart manually.'));
        }
      };
      return { busy, detail, failure, restart };
    }

    /** Pure mapping from a POST /dsh-retry/update answer to card state. */
    function nextUpdateState(info, { status = 0, body = null } = {}) {
      const installed = body?.installed;
      if (status === 200 && body?.ok === true && installed?.to) {
        return {
          info: info === null ? null : { ...info, updateAvailable: false },
          installedVersion: String(installed.to),
          error: '',
        };
      }
      if (status === 200 && body?.ok === true) {
        // The host answered that there is nothing left to install.
        return { info: info === null ? null : { ...info, updateAvailable: false }, installedVersion: '', error: '' };
      }
      const reason = body?.error ?? `http_${status}`;
      const detail = typeof body?.detail === 'string' && body.detail !== '' ? ` ${body.detail.slice(0, 240)}` : '';
      return { info, installedVersion: '', error: describeFailure(reason) + detail };
    }

    /** Status row of the update card for one check/install sample. */
    function updateStatus({ info, error, errorPhase, installedVersion }) {
      if (error !== '') {
        const prefix = errorPhase === 'install' ? t('安装失败：', 'Update failed: ') : t('检查失败：', 'Check failed: ');
        return { text: prefix + error, tone: 'warn' };
      }
      if (installedVersion !== '') {
        return {
          text: t(`已安装 v${installedVersion}，重启 DSH 生效`, `Installed v${installedVersion}; restart DSH to finish.`),
          tone: 'warn',
        };
      }
      if (info === null) return { text: t('尚未检查', 'Not checked yet'), tone: 'muted' };
      const latest = info.latest?.version ?? '—';
      if (info.updateAvailable === true) {
        return { text: t(`发现新版本 v${latest}`, `New version v${latest} is available`), tone: 'warn' };
      }
      return { text: t('已是最新', 'Up to date'), tone: 'ok' };
    }

    /** Check-side failures: known host reasons get user-facing text, anything
     * else (network or GitHub errors) is shown verbatim. */
    function describeUpdateError(reason) {
      if (reason === 'not_desktop' || reason === 'update_in_progress' || reason === 'update_failed') {
        return describeFailure(reason);
      }
      return String(reason);
    }

    /** Check/install state for the update card. Checking stays explicit so
     * opening the settings page never calls the GitHub API on its own. */
    function useUpdate() {
      const [info, setInfo] = React.useState(null);
      const [checking, setChecking] = React.useState(false);
      const [installing, setInstalling] = React.useState(false);
      const [error, setError] = React.useState('');
      const [errorPhase, setErrorPhase] = React.useState('');
      const [installedVersion, setInstalledVersion] = React.useState('');

      const check = async () => {
        if (checking || installing) return;
        setChecking(true);
        setError('');
        setErrorPhase('');
        try {
          const response = await fetch(UPDATE_URL);
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          if (!response.ok || body?.ok === false) throw new Error(describeUpdateError(body?.error ?? `http_${response.status}`));
          setInfo(body);
        } catch (failure) {
          setInfo(null);
          setError(String(failure?.message ?? failure));
          setErrorPhase('check');
        } finally {
          setChecking(false);
        }
      };

      const install = async () => {
        if (installing || checking || info?.updateAvailable !== true) return;
        setInstalling(true);
        setError('');
        setErrorPhase('');
        try {
          const response = await fetch(UPDATE_URL, { method: 'POST' });
          let body = null;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          const next = nextUpdateState(info, { status: response.status, body });
          setInfo(next.info);
          setInstalledVersion(next.installedVersion);
          if (next.error !== '') {
            setError(next.error);
            setErrorPhase('install');
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure));
          setErrorPhase('install');
        } finally {
          setInstalling(false);
        }
      };

      return { info, checking, installing, error, errorPhase, installedVersion, check, install };
    }

    const RESTART_LABEL = () => t('重启 DeepSeek Harness', 'Restart DeepSeek Harness');

    function StatusRows({ rows }) {
      const visible = rows.filter((row) => row[1] !== undefined && row[1] !== null && row[1] !== '');
      return h(
        'dl',
        { className: 'dsh-retry-kv' },
        ...visible.map(([key, value, tone, extra]) => {
          const className = [tone ? `is-${tone}` : '', extra ?? ''].filter(Boolean).join(' ');
          return h('div', { className: 'dsh-retry-kv-row', key: `row-${key}` }, h('dt', null, key), h('dd', { className: className === '' ? undefined : className }, value));
        }),
      );
    }

    function RestartPage() {
      const { busy, detail, restart } = useRestart();
      const updateRestart = useRestart();
      const update = useUpdate();
      const [status, setStatus] = React.useState(null);
      const [statusError, setStatusError] = React.useState('');
      const [loading, setLoading] = React.useState(true);

      const refresh = async () => {
        setLoading(true);
        try {
          const response = await fetch(STATUS_URL);
          if (!response.ok) throw new Error(`http_${response.status}`);
          setStatus(await response.json());
          setStatusError('');
        } catch (error) {
          setStatusError(String(error?.message ?? error));
        } finally {
          setLoading(false);
        }
      };

      React.useEffect(() => {
        void refresh();
      }, []);

      const patched = status?.patched === true;
      const guard = status?.autoRestart?.guard ?? null;
      const helperLog = Array.isArray(status?.helper?.log) ? status.helper.log.slice(-5).join('\n') : '';
      const missing = status?.missing ? [...(status.missing.main ?? []), ...(status.missing.account ?? [])] : [];
      const foreign = status?.foreignPatch?.detected === true;
      const updateInfo = update.info;
      const updateState = updateStatus({
        info: updateInfo,
        error: update.error,
        errorPhase: update.errorPhase,
        installedVersion: update.installedVersion,
      });
      const updateRestartBlocked = updateRestart.failure === 'update_pending';
      const currentVersion = status?.update?.currentVersion ?? status?.plugin?.version ?? '—';
      const latestVersion = updateInfo?.latest?.version ?? '—';

      return h(
        'div',
        { className: 'dsh-retry-page' },
        h(
          'div',
          { className: 'dsh-retry-card' },
          h(
            'div',
            { className: 'dsh-retry-row' },
            h(
              'div',
              { className: 'dsh-retry-row-main' },
              h('h3', { className: 'dsh-retry-title' }, RESTART_LABEL()),
              h(
                'p',
                { className: 'dsh-retry-text' },
                t(
                  '重启会退出桌面应用与宿主进程，然后重新打开。托盘菜单和账户菜单里的重启项需要 app.asar 补丁；这里的按钮走官方插件入口，DSH 更新后依然可用。',
                  'Restarting quits the desktop app and the host process, then relaunches. The tray and account-menu entries need the app.asar patch; this button uses the official plugin entry and keeps working after a DSH update.',
                ),
              ),
            ),
            h('button', { type: 'button', className: 'dsh-retry-primary', disabled: busy, onClick: () => restart() }, busy ? t('重启中…', 'Restarting…') : t('重启', 'Restart')),
            foreign
              ? h('button', { type: 'button', className: 'dsh-retry-ghost', disabled: busy, onClick: () => restart({ force: true }) }, t('仍然覆盖并重启', 'Overwrite and restart'))
              : null,
          ),
          foreign
            ? h(
                'p',
                { className: 'dsh-retry-note is-error' },
                t(
                  '检测到 app.asar 内有其它插件写入的补丁：已暂停自动安装，以免把它们覆盖掉。',
                  'Another plugin patched app.asar: the automatic install is paused so its changes are not overwritten.',
                ),
              )
            : null,
          detail === '' ? null : h('p', { className: 'dsh-retry-note' }, detail),
        ),
        h(
          'div',
          { className: 'dsh-retry-card' },
          h(
            'div',
            { className: 'dsh-retry-row' },
            h(
              'div',
              { className: 'dsh-retry-row-main' },
              h('h3', { className: 'dsh-retry-title' }, t('补丁状态', 'Patch status')),
              h(
                'p',
                { className: 'dsh-retry-text' },
                t(
                  'DSH 更新覆盖 app.asar 后，插件会在启动约 3 秒后自动重启一次并重装补丁；自动重启对同一次更新最多 2 次。',
                  'After a DSH update overwrites app.asar, the plugin restarts once about 3 seconds after launch and reinstalls the patch, at most twice for the same update.',
                ),
              ),
            ),
            h('button', { type: 'button', className: 'dsh-retry-ghost', disabled: loading, onClick: refresh }, loading ? t('读取中…', 'Loading…') : t('刷新', 'Refresh')),
          ),
          statusError === ''
            ? null
            : h('p', { className: 'dsh-retry-note is-error' }, t('读取状态失败：', 'Reading the status failed: ') + statusError),
          status === null
            ? h('p', { className: 'dsh-retry-note' }, loading ? t('正在读取…', 'Loading…') : t('暂无状态', 'No status'))
            : h(StatusRows, {
                rows: [
                  [t('插件版本', 'Plugin version'), status.plugin?.version],
                  [t('桌面端版本', 'Desktop version'), status.desktopVersion],
                  [t('补丁已装入', 'Patch installed'), patched ? t('是', 'yes') : t('否', 'no'), patched ? 'ok' : 'warn'],
                  [t('缺失补丁', 'Missing anchors'), missing.length === 0 ? t('无', 'none') : missing.join(', '), missing.length === 0 ? 'ok' : 'warn'],
                  [
                    t('其它插件补丁', 'Foreign patch'),
                    foreign ? t('检测到（已暂停覆盖）', 'detected (install paused)') : t('无', 'none'),
                    foreign ? 'warn' : 'ok',
                  ],
                  [t('自动重启次数', 'Auto restarts'), `${guard?.attempts ?? 0} / ${status.autoRestart?.limit ?? 0}`],
                  [t('暂存补丁', 'Staged patch'), status.staged?.meta?.desktopVersion ? `${status.staged.meta.desktopVersion} · ${status.staged.meta.builtAt ?? ''}` : t('无', 'none')],
                ],
              }),
          helperLog === '' ? null : h('pre', { className: 'dsh-retry-log' }, helperLog),
        ),
        h(
          'div',
          { className: 'dsh-retry-card' },
          h(
            'div',
            { className: 'dsh-retry-row' },
            h(
              'div',
              { className: 'dsh-retry-row-main' },
              h('h3', { className: 'dsh-retry-title' }, t('插件更新', 'Plugin update')),
              h(
                'p',
                { className: 'dsh-retry-text' },
                t(
                  '从 GitHub Releases 检查并安装 dsh-retry 的新版本（会校验 sha256）。',
                  'Check for and install new dsh-retry releases from GitHub Releases (sha256 verified).',
                ),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-retry-ghost dsh-retry-update-check',
                disabled: update.checking || update.installing,
                onClick: () => update.check(),
              },
              update.checking ? t('检查中…', 'Checking…') : t('检查更新', 'Check for updates'),
            ),
          ),
          h(StatusRows, {
            rows: [
              [t('当前版本', 'Current version'), currentVersion],
              [t('最新版本', 'Latest version'), latestVersion],
              [t('状态', 'Status'), updateState.text, updateState.tone, 'dsh-retry-update-state'],
            ],
          }),
          updateInfo?.updateAvailable === true || update.installedVersion !== ''
            ? h(
                'div',
                { className: 'dsh-retry-actions' },
                updateInfo?.updateAvailable === true
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-retry-primary dsh-retry-update-install',
                        disabled: update.installing,
                        onClick: () => update.install(),
                      },
                      update.installing ? t('更新中…', 'Updating…') : t('安装更新', 'Install update'),
                    )
                  : null,
                update.installedVersion !== '' && !updateRestartBlocked
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-retry-ghost dsh-retry-update-restart',
                        disabled: updateRestart.busy,
                        onClick: () => updateRestart.restart(),
                      },
                      t('重启 DSH 以完成更新', 'Restart DSH to finish the update'),
                    )
                  : null,
              )
            : null,
          updateRestart.detail === '' ? null : h('p', { className: 'dsh-retry-note' }, updateRestart.detail),
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'dsh-retry', order: 95, label: () => t('重启与更新', 'Restart & updates') }, RestartPage),
      );
    }

    ensureStyles();

    return { inject: ['slots'], apply, __internals: { describeFailure, nextUpdateState, updateStatus, UPDATE_URL } };
  },
});
