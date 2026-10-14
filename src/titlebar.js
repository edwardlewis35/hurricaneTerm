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
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls || 'tb-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
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
      if (lights && mac && win()) {
        document.body.classList.add('no-native-lights');
        lights.setAttribute('role', 'group');
        lights.setAttribute('aria-label', '窗口控制');
        const controls = {
          close: { title: '关闭窗口', shape: '<path d="M4 4l4 4M8 4L4 8"/>' },
          minimize: { title: '最小化窗口', shape: '<path d="M3 6h6"/>' },
          maximize: { title: '放大或还原窗口', shape: '<path class="ml-expand" d="M3 3h4L3 7zm6 6H5l4-4z"/>' },
        };
        lights.querySelectorAll('.ml').forEach((m) => {
          const a = m.dataset.act;
          const control = controls[a];
          if (!control) return;
          // 使用真正的按钮：键盘 Tab/Enter/Space 与鼠标都能操作。
          // group hover / focus-within 的三个 glyph 同时出现，由独立 CSS 控制。
          const b = document.createElement('button');
          b.type = 'button';
          b.className = m.className;
          b.dataset.act = a;
          b.title = control.title;
          b.setAttribute('aria-label', control.title);
          b.innerHTML = '<svg class="ml-glyph" viewBox="0 0 12 12" aria-hidden="true" focusable="false">' + control.shape + '</svg>';
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            if (a === 'close') this.close();
            else if (a === 'minimize') this.minimize();
            else this.toggleMaximize();
          });
          m.replaceWith(b);
        });
      }

      this.buildActions(actionsEl);
      this.buildWinCtl(winctlEl);

      // 双击空白标题栏 → 最大化/还原（Tabby/系统惯例）
      const bar = document.getElementById('titlebar');
      if (bar) {
        bar.addEventListener('dblclick', (e) => {
          if (e.target.closest('.ht-tab, .ht-actions, .ht-brand, .tb-btn, .wc, .ml, button, input')) return;
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
      this.settingsBtn = btn(host, 'gear', '设置', (b) => {
        const S = window.Settings;
        if (!S) return;
        if (ui()) ui().closeDock();
        if (window.Profiles && Profiles.isOpen()) { Profiles.close(); S.open(); return; }
        S.toggle();
      }, 'tb-btn tb-settings');
      this.settingsBtn.setAttribute('aria-pressed', 'false');
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
      if (mac) { host.hidden = true; return; }
      if (!mac) {
        mk('wc-min', 'minimize', '最小化', () => this.minimize());
        mk('wc-max', 'maximize', '最大化', () => this.toggleMaximize());
      }
      mk('wc-close', 'x', '关闭', () => this.close());
    },

    syncSettings() {
      const on = !!(window.Settings && window.Settings.isOpen());
      if (this.settingsBtn) {
        this.settingsBtn.classList.toggle('on', on);
        this.settingsBtn.setAttribute('aria-pressed', String(on));
      }
    },

    refresh() {
      syncMaxState();
      if (window.TabBar) TabBar.revealActive();
      this.syncSettings();
      if (this.sidebarBtn) {
        this.sidebarBtn.classList.toggle('on', !!T.s.dockVisible);
        this.sidebarBtn.setAttribute('aria-expanded', String(!!T.s.dockVisible));
      }
    },

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
