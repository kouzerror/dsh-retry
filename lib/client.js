/* Renderer half of dsh-retry.
 *
 * The tray and account-menu entries need the app.asar patch: the desktop shell
 * hardcodes both menus and exposes no plugin seat for them. This bundle is the
 * part that survives a desktop update — it registers two official renderer
 * slots (a sidebar footer action and a settings page) and calls the host half's
 * restart route. Profile plugins are not inside app.asar, so these two entries
 * stay available even when an update wipes the patch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-retry',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const STYLE_ID = '@dsh-retry/client';
    const RESTART_URL = '/dsh-retry/restart';
    const STATUS_URL = '/dsh-retry/status';

    const CSS = `
.dsh-retry-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;min-width:32px;padding:0 8px;margin:2px 0 2px 4px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:1;cursor:pointer;flex:none}
.dsh-retry-action:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.dsh-retry-action:disabled{opacity:.6;cursor:default}
.dsh-retry-action:focus-visible{outline:2px solid var(--dsw-alias-state-focus-ring,#4d6bfe);outline-offset:1px}
.dsh-retry-action-label{white-space:nowrap}
.dsh-retry-glyph{flex:none;width:16px;height:16px}
.dsh-retry-glyph.is-spinning{animation:dsh-retry-spin 1s linear infinite}
@keyframes dsh-retry-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-retry-glyph.is-spinning{animation:none}}
.dsh-retry-page{display:flex;flex-direction:column;gap:16px;max-width:760px;font:inherit;color:var(--dsw-alias-label-primary,inherit)}
.dsh-retry-card{display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent)}
.dsh-retry-title{margin:0;font-size:15px;font-weight:600}
.dsh-retry-text{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-retry-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit)}
.dsh-retry-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:0;font-size:12px}
.dsh-retry-kv dt{color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.dsh-retry-kv dd{margin:0;word-break:break-word;font-variant-numeric:tabular-nums}
.dsh-retry-actions{display:flex;flex-wrap:wrap;gap:8px}
.dsh-retry-primary{height:32px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dsh-retry-primary:disabled{opacity:.6;cursor:default}
.dsh-retry-ghost{height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer}
.dsh-retry-log{margin:0;padding:10px;max-height:170px;overflow:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,inherit)}
.dsh-retry-status-error{color:var(--dsw-alias-state-error-primary,#c0392b)}
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
        default:
          return t(`重启失败（${reason}）。`, `Restart failed (${reason}).`);
      }
    }

    async function postRestart() {
      const response = await fetch(RESTART_URL, { method: 'POST' });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    }

    /** Shared restart state for the footer action and the settings page. */
    function useRestart() {
      const [busy, setBusy] = React.useState(false);
      const [detail, setDetail] = React.useState('');
      const restart = async () => {
        if (busy) return;
        setBusy(true);
        setDetail(t('正在重启 DeepSeek Harness…', 'Restarting DeepSeek Harness…'));
        try {
          const { status, body } = await postRestart();
          // 200/202 mean the helper is already replacing the process; the page
          // disappears before any further state matters.
          if (status === 200 || status === 202) return;
          setBusy(false);
          setDetail(describeFailure(body?.error ?? `http_${status}`));
        } catch {
          setBusy(false);
          setDetail(t('无法连接到 DSH 宿主进程，请手动重启。', 'Cannot reach the DSH host process. Restart manually.'));
        }
      };
      return { busy, detail, restart };
    }

    function Glyph({ spinning = false }) {
      return h(
        'svg',
        {
          className: `dsh-retry-glyph${spinning ? ' is-spinning' : ''}`,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M13.3 6.5a5.5 5.5 0 1 0 .3 3.3' }),
        h('path', { d: 'M13.7 2.7v3.9h-3.9' }),
      );
    }

    const RESTART_LABEL = () => t('重启 DeepSeek Harness', 'Restart DeepSeek Harness');

    function RestartButton({ wide = false }) {
      const { busy, detail, restart } = useRestart();
      const label = RESTART_LABEL();
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-retry-action${wide ? ' is-wide' : ''}`,
          title: detail || label,
          'aria-label': label,
          disabled: busy,
          onClick: restart,
        },
        h(Glyph, { spinning: busy }),
        wide ? h('span', { className: 'dsh-retry-action-label' }, busy ? t('重启中…', 'Restarting…') : t('重启', 'Restart')) : null,
      );
    }

    function KeyValues({ rows }) {
      const visible = rows.filter((row) => row[1] !== undefined && row[1] !== null && row[1] !== '');
      return h('dl', { className: 'dsh-retry-kv' }, ...visible.flatMap(([key, value]) => [h('dt', { key: `k-${key}` }, key), h('dd', { key: `v-${key}` }, value)]));
    }

    function RestartPage() {
      const { busy, detail, restart } = useRestart();
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

      return h(
        'div',
        { className: 'dsh-retry-page' },
        h(
          'div',
          { className: 'dsh-retry-card' },
          h('h2', { className: 'dsh-retry-title' }, RESTART_LABEL()),
          h(
            'p',
            { className: 'dsh-retry-text' },
            t(
              '重启会退出桌面应用与宿主进程，然后重新打开。托盘菜单和账户菜单里的重启项需要 app.asar 补丁；这里的按钮走官方插件入口，DSH 更新后依然可用。',
              'Restarting quits the desktop app and the host process, then relaunches. The tray and account-menu entries need the app.asar patch; this button uses the official plugin entry and keeps working after a DSH update.',
            ),
          ),
          h(
            'div',
            { className: 'dsh-retry-actions' },
            h('button', { type: 'button', className: 'dsh-retry-primary', disabled: busy, onClick: restart }, busy ? t('重启中…', 'Restarting…') : t('重启 DeepSeek Harness', 'Restart DeepSeek Harness')),
            h('button', { type: 'button', className: 'dsh-retry-ghost', disabled: loading, onClick: refresh }, t('重新检查状态', 'Refresh status')),
          ),
          detail === '' ? null : h('p', { className: 'dsh-retry-note' }, detail),
        ),
        h(
          'div',
          { className: 'dsh-retry-card' },
          h('h3', { className: 'dsh-retry-title' }, t('补丁状态', 'Patch status')),
          statusError === ''
            ? null
            : h('p', { className: 'dsh-retry-note dsh-retry-status-error' }, t('读取状态失败：', 'Reading the status failed: ') + statusError),
          status === null
            ? h('p', { className: 'dsh-retry-note' }, loading ? t('正在读取…', 'Loading…') : t('暂无状态', 'No status'))
            : h(KeyValues, {
                rows: [
                  [t('插件版本', 'Plugin version'), status.plugin?.version],
                  [t('桌面端版本', 'Desktop version'), status.desktopVersion],
                  [t('补丁已装入', 'Patch installed'), patched ? t('是', 'yes') : t('否', 'no')],
                  [t('缺失补丁', 'Missing anchors'), missing.length === 0 ? t('无', 'none') : missing.join(', ')],
                  [t('自动重启次数', 'Auto restarts'), `${guard?.attempts ?? 0} / ${status.autoRestart?.limit ?? 0}`],
                  [t('暂存补丁', 'Staged patch'), status.staged?.meta?.desktopVersion ? `${status.staged.meta.desktopVersion} · ${status.staged.meta.builtAt ?? ''}` : t('无', 'none')],
                ],
              }),
          h(
            'p',
            { className: 'dsh-retry-note' },
            t(
              'DSH 更新覆盖 app.asar 后，插件会在启动约 3 秒后自动重启一次并重装补丁；自动重启对同一次更新最多 2 次。',
              'After a DSH update overwrites app.asar, the plugin restarts once about 3 seconds after launch and reinstalls the patch, at most twice for the same update.',
            ),
          ),
          helperLog === '' ? null : h('pre', { className: 'dsh-retry-log' }, helperLog),
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-retry-restart', order: 90, label: () => t('重启', 'Restart') }, RestartButton),
      );
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: 'dsh-retry', order: 95, label: () => t('重启与更新', 'Restart & updates') }, RestartPage),
      );
    }

    ensureStyles();

    return { inject: ['slots'], apply, __internals: { describeFailure } };
  },
});