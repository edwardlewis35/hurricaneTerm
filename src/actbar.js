/* hurricaneTerm — actbar.js：左侧图标活动栏
 * 原创代码 (Apache-2.0)。形态参考 Tabby 的 left toolbar（图标列 + 点按开合侧栏），未复制其代码。
 *
 * 取代 0.6.0 的「#dock-tabs 文字选项卡」。点击图标 → 开/合对应侧栏窗格；再点同一个 → 收起。
 * 导出：window.ActBar = { mount(el), setActive(paneId|null), render(), bump(paneId), syncSettings() }
 */
(function () {
  'use strict';

  const T = window.WT;

  // 侧栏窗格（顺序即活动栏顺序）；图标互不重复（0.7.3：会话≠机器管理）
  const PANES = [
    { id: 'explorer', icon: 'plug', label: '会话', key: 'Ctrl+1' },
    { id: 'filer', icon: 'folder', label: '文件浏览器 (SFTP)', key: 'Ctrl+2' },
    { id: 'sender', icon: 'send', label: '发送文本', key: 'Ctrl+3' },
    { id: 'transfer', icon: 'transfer', label: '传输', key: 'Ctrl+4' },
    { id: 'outline', icon: 'terminal', label: '输入大纲', key: 'Ctrl+5' },
    { id: 'output', icon: 'output', label: '日志', key: 'Ctrl+6' },
  ];

  let root = null;
  const badges = {};      // paneId -> 未读数（仅在该窗格非活动时累加）
  const btns = {};        // paneId -> 元素
  let tipEl = null, tipTimer = null;

  /* ---------- 悬浮提示（比原生 title 更贴 Tabby 观感） ---------- */
  function showTip(el, text) {
    hideTip();
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      tipEl = document.createElement('div');
      tipEl.className = 'ab-tip';
      tipEl.textContent = text;
      document.body.appendChild(tipEl);
      const h = tipEl.offsetHeight;
      tipEl.style.left = (r.right + 8) + 'px';
      tipEl.style.top = Math.max(4, r.top + r.height / 2 - h / 2) + 'px';
    }, 420);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }

  /* ---------- 单个按钮 ---------- */
  function mkBtn(host, opt) {
    const b = document.createElement('div');
    b.className = 'ab-btn' + (opt.cls ? ' ' + opt.cls : '');
    b.innerHTML = window.Icons ? window.Icons.svg(opt.icon) : opt.icon;
    if (opt.title) b.title = opt.title;
    const tip = opt.label + (opt.key ? '  ' + opt.key : '');
    b.addEventListener('mouseenter', () => showTip(b, tip));
    b.addEventListener('mouseleave', hideTip);
    b.addEventListener('click', (e) => { e.stopPropagation(); hideTip(); opt.onClick(b); });
    if (opt.onContext) {
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); hideTip(); opt.onContext(e.clientX, e.clientY); });
    }
    host.appendChild(b);
    return b;
  }

  function addBadge(b, paneId) {
    const s = document.createElement('span');
    s.className = 'badge';
    s.hidden = true;
    b.appendChild(s);
    badges[paneId] = s;
  }

  const ActBar = {
    PANES,

    mount(el) {
      if (!el) return;
      if (root === el) { this.render(); return; }
      root = el;
      el.textContent = '';

      // —— 顶部：主页 ——
      mkBtn(el, {
        icon: 'home', label: '主页', onClick: () => {
          if (T.term.order.length) T.term.openHome();
          else if (window.Home) Home.show();
        },
      });
      mkBtn(el, {
        icon: 'server', label: '机器管理', key: 'Ctrl+M', cls: 'ab-profiles',
        onClick: () => {
          const P = window.Profiles;
          if (P) P.openManager();
          else if (T.ui) T.ui.toast('机器管理模块未加载');
        },
      });
      const sep1 = document.createElement('div'); sep1.className = 'ab-sep'; el.appendChild(sep1);

      // —— 中部：侧栏窗格 ——
      for (const p of PANES) {
        const b = mkBtn(el, {
          icon: p.icon, label: p.label, key: p.key,
          onClick: () => this.toggle(p.id),
        });
        b.dataset.pane = p.id;
        btns[p.id] = b;
        // 传输/日志有数量徽标
        if (p.id === 'transfer' || p.id === 'output') addBadge(b, p.id);
      }

      // —— 弹性空隙 ——
      const sp = document.createElement('div');
      sp.className = 'spacer';
      sp.style.flex = '1';
      el.appendChild(sp);

      const sep2 = document.createElement('div'); sep2.className = 'ab-sep'; el.appendChild(sep2);

      // —— 底部：主题 / 设置 ——
      mkBtn(el, {
        icon: 'theme', label: '切换深浅色', onClick: () => {
          if (window.Settings) Settings.cycleLightDark();
          else if (T.ui) T.ui.cycleTheme();
        },
      });
      this.settingsBtn = mkBtn(el, {
        icon: 'gear', label: '设置', key: 'Ctrl+,', cls: 'ab-settings',
        onClick: (b) => {
          const S = window.Settings;
          if (!S) return;
          S.toggle();
          this.syncSettings();
        },
      });

      this.render();
    },

    /* 点按开合：同 Tabby，再点当前窗格则收起整条侧栏 */
    toggle(paneId) {
      const ui = T.ui;
      if (!ui) return;
      if (T.s.dockVisible && T.s.dockPane === paneId) ui.toggleDock();
      else ui.setDockPane(paneId);
      this.render();
    },

    setActive(paneId) {
      T.s.dockPane = paneId;
      this.render();
    },

    // 未读徽标 +1（仅当该窗格不是当前活动窗格时）
    bump(paneId) {
      if (T.s.dockVisible && T.s.dockPane === paneId) return;
      const el = badges[paneId];
      if (!el) return;
      const n = (parseInt(el.dataset.n || '0', 10) || 0) + 1;
      el.dataset.n = String(n);
      el.textContent = n > 99 ? '99+' : String(n);
      el.hidden = false;
    },

    clearBadge(paneId) {
      const el = badges[paneId];
      if (!el) return;
      el.dataset.n = '0';
      el.textContent = '';
      el.hidden = true;
    },

    // 设置页开合状态同步（标题栏与活动栏两处入口共用一个按钮态）
    syncSettings() {
      const S = window.Settings;
      const on = !!(S && S.isOpen());
      if (this.settingsBtn) this.settingsBtn.classList.toggle('on', on);
      const tb = document.querySelector('#tb-actions .tb-btn.on');
      if (tb) tb.classList.toggle('on', on);
    },

    render() {
      if (!root) return;
      const open = !!T.s.dockVisible;
      const cur = open ? T.s.dockPane : null;
      for (const p of PANES) {
        const b = btns[p.id];
        if (b) b.classList.toggle('on', p.id === cur);
        if (p.id === cur) this.clearBadge(p.id);
      }
      const sb = root.querySelector('.ab-profiles');
      if (sb) sb.classList.remove('on');
    },
  };

  window.ActBar = ActBar;
})();
