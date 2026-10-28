window.__ModuleLoader__.load({
  id: 'dsh-retry',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    var h = react.createElement;

    var STYLE_ID = 'dsh-retry-style';
    var CSS = [
      '.dsh-retry-footer-button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;',
      'width:32px;height:32px;border-radius:8px;color:var(--dsw-alias-label-primary);cursor:pointer;',
      'transition:background-color .12s var(--ds-ease-in-out, ease)}',
      '.dsh-retry-footer-button:hover{background:var(--dsw-alias-fill-secondary, rgba(128,128,128,.14))}',
      '.dsh-retry-footer-button:active{background:var(--dsw-alias-fill-tertiary, rgba(128,128,128,.2))}',
      '.dsh-retry-footer-button[disabled]{opacity:.45;cursor:default}',
      '.dsh-retry-footer-button svg{display:block}',
    ].join('');

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function restart() {
      return fetch('/dsh-retry/restart', { method: 'POST', headers: { 'content-type': 'application/json' } });
    }

    function FooterButton() {
      var state = react.useState(false);
      var busy = state[0];
      var setBusy = state[1];
      var onClick = function () {
        if (busy) return;
        setBusy(true);
        restart()
          .catch(function () {})
          .then(function () {
            setTimeout(function () {
              setBusy(false);
            }, 5000);
          });
      };
      return h(
        primitives.Tooltip,
        { portal: true, label: '重启 DeepSeek Harness', side: 'top', delayMs: 300 },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-retry-footer-button',
            'aria-label': '重启 DeepSeek Harness',
            disabled: busy,
            onClick: onClick,
          },
          h(primitives.IconRefreshOutlineMedium, { size: 16 }),
        ),
      );
    }

    function apply(ctx) {
      ensureStyle();
      if (!ctx.slots) return;
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-retry',
            order: 1,
          },
          FooterButton,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return exports;
  },
});
