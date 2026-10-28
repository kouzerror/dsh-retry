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
