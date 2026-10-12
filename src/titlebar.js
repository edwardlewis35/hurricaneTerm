/* hurricaneTerm — titlebar.js：无边框窗口的自绘标题栏
 * 原创代码 (Apache-2.0)。形态参考 Tabby（标签内嵌标题栏 + 自绘窗口控制），未复制其代码。
 *
 * 导出：window.TitleBar = { mount(actionsEl, winctlEl), refresh(), platform() }
 * 依赖：window.Icons；Tauri window API（缺失时自动降级为「浏览器模式」，隐藏窗口控制）
 */
(function () {
  'use strict';

  const T = window.WT;
  let mac = false, tauriWin = null, maximized = false, mounted = false;

  function platform() {
    const ua = navigator.userAgent || '';
    if (/Mac|iPhone|iPad/i.test(ua)) return 'mac';
    if (/Windows/i.test(ua)) return 'win';
    return 'linux';
  }

  function win() {
    if (tauriWin) return tauriWin;
    const w = window.__TAURI__ && window.__TAURI__.window;
    if (!w || typeof w.getCurrentWindow !== 'function') return null;
    try { tauriWin = w.getCurrentWindow(); } catch (e) { tauriWin = null; }
    return tauriWin;
  }

  function btn(host, icon, title, onClick, cls) {
    const b = document.createElement('div');
    b.className = cls || 'tb-btn';
    b.title = title;
    b.innerHTML = window.Icons ? window.Icons.svg(icon) : icon;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
    host.appendChild(b);
    return b;
  }

  async function syncMaxState() {
    const w = win();
    if (!w) return;
    try { maximized = await w.isMaximized(); } catch (e) { return; }
    const el = document.querySelector('#tb-winctl .wc-max');
    if (el) {
      el.innerHTML = window.Icons ? window.Icons.svg(maximized ? 'restore' : 'maximize') : '';
      el.title = maximized ? '还原' : '最大化';
    }
  }

  const TitleBar = {
    platform,

    mount(actionsEl, winctlEl) {
      if (mounted) { this.refresh(); return; }
      mounted = true;
      mac = platform() === 'mac';
      document.body.classList.toggle('is-mac', mac);

      // Tauri 的 decorations:false 会连原生红绿灯一起去掉，此时必须自绘
      const lights = document.getElementById('mac-lights');
      if (lights && mac) {
        document.body.classList.add('no-native-lights');
        lights.querySelectorAll('.ml').forEach((m) => {
          m.addEventListener('click', (e) => {
            e.stopPropagation();
            const a = m.dataset.act;
            if (a === 'close') this.close();
            else if (a === 'minimize') this.minimize();
            else this.toggleMaximize();
          });
        });
      }

      this.buildActions(actionsEl);
      this.buildWinCtl(winctlEl);

      // 双击空白标题栏 → 最大化/还原（Tabby/系统惯例）
      const bar = document.getElementById('titlebar');
      if (bar) {
        bar.addEventListener('dblclick', (e) => {
          if (e.target.closest('#tabbar .ht-tab, .tb-btn, .wc, .ml')) return;
          this.toggleMaximize();
        });
        // 手动拖窗：data-tauri-drag-region 只认事件目标自身，标签条子元素会把它挡住，
        // 所以改为在标题栏上统一拦截「非交互区」的按下事件
        bar.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          if (e.target.closest('.ht-tab, .ht-actions, #tb-winctl, #mac-lights, .tb-btn, .wc, .ml, .ht-plus, .ht-caret, button, input, select')) return;
          const w = win();
          if (w && typeof w.startDragging === 'function') {
            e.preventDefault();
            w.startDragging().catch(() => {});
          }
        });
      }
      this.refresh();
    },

    buildActions(host) {
      if (!host) return;
      host.textContent = '';
      const ui = () => (window.UI || (T && T.ui));
      btn(host, 'search', '查找 (Ctrl+F)', () => ui() && ui().openSearch());
      btn(host, 'splitH', '左右分屏', () => T && T.term.split('h'));
      btn(host, 'splitV', '上下分屏', () => T && T.term.split('v'));
      btn(host, 'terminal', '命令面板 (Ctrl+Shift+P)', () => ui() && ui().openPalette());
      this.settingsBtn = btn(host, 'gear', '设置', (b) => {
        const S = window.Settings;
        if (!S) return;
        S.toggle();
        b.classList.toggle('on', S.isOpen());
      });
    },

    buildWinCtl(host) {
      if (!host) return;
      host.textContent = '';
      // 非 Tauri 环境（浏览器/jsdom）没有窗口可控制，整块隐藏
      if (!win()) { host.hidden = true; return; }
      host.hidden = false;

      const mk = (cls, icon, title, fn) => {
        const b = document.createElement('div');
        b.className = 'wc ' + cls;
        b.title = title;
        b.innerHTML = window.Icons ? window.Icons.svg(icon) : '';
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        host.appendChild(b);
        return b;
      };
      // macOS 已有左侧红绿灯时不重复放右侧按钮
      if (!mac) {
        mk('wc-min', 'minimize', '最小化', () => this.minimize());
        mk('wc-max', 'maximize', '最大化', () => this.toggleMaximize());
      }
      mk('wc-close', 'x', '关闭', () => this.close());
    },

    refresh() { syncMaxState(); },

    async minimize() { const w = win(); if (w) { try { await w.minimize(); } catch (e) {} } },
    async toggleMaximize() {
      const w = win();
      if (!w) return;
      try { await w.toggleMaximize(); } catch (e) { return; }
      syncMaxState();
    },
    async close() {
      const w = win();
      if (w) { try { await w.close(); return; } catch (e) {} }
      window.close();
    },
  };

  window.TitleBar = TitleBar;
})();
