Adds `kouzerror/dsh-retry` (ui): a native **Restart DeepSeek Harness** entry in two places the
existing restart plugins do not cover — the Windows **system tray menu** and the **account menu**
(avatar popup) — plus an official renderer slot (a settings page) that keeps
working after a desktop update, and a patch lifecycle that survives desktop updates.

- Official `settings.section` entry from the plugin's own client bundle
  (`dsh.client`, no app.asar dependency), so restart stays available even when an update wipes the patch.
- Patched `resources/app.asar` is prepared at startup and installed by a short-lived helper that
  restarts the app once (original kept as `app.asar.dsh-retry.bak`); a running Electron app keeps the
  archive locked, so nothing rewrites the asar while DSH is running. The patch is re-applied
  automatically after each desktop update, with a guard against restart loops.
- Byte-identical verification of every asar entry outside the patch (`npm run verify`).
- Every entry relaunches gracefully (`app.relaunch()`); tray path direct, the others via
  `POST /dsh-retry/restart`; status at `GET /dsh-retry/status`.
- Windows desktop only; Web hosts get `409 not_desktop`.
- Source-install friendly: no dependencies, no install scripts, `dsh.bundle.patch` → `cordis.patch.yml`.

Closest neighbours: maqian1632/dsh-tray-restart and QIRSHENG/dsh-tray-restart (tray only),
Joshua1ya/dsh-tray-restart (session header/tray, dev), luoshuizhiwei/dsh-desktop-restart (5 entry
points). Differences above are the account-menu entry, the official slot entries and the startup
self-healing patch install.

Checklist done: single `data/plugins/kouzerror__dsh-retry.yml`, `dsh.bundle` declared, repo >1 day,
`category: ui` valid, no superlatives, `dsh-plugin` topic set.
