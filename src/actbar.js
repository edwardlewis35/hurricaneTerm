/* hurricaneTerm — actbar.js：标签栏下方的水平工具栏
 * 原创代码 (Apache-2.0)。形态参考 Tabby 的水平工具栏（图标 + 点按浮窗），未复制其代码。
 *
 * 取代 0.6.0 的「#dock-tabs 文字选项卡」。点击图标 → 开/合对应工具浮窗；再点同一个 → 收起。
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

  let root = null, panelObserver = null;
  const badges = {};      // paneId -> 未读数（仅在该窗格非活动时累加）
  const btns = {};        // paneId -> 元素
  let tipEl = null, tipTimer = null;

  /* ---------- 悬浮提示（比原生 title 更贴 Tabby 观感） ---------- */
  function showTip(el, text) {
    hideTip();
    if (T.s.tooltips === false) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const r = el.getBoundingClientRect();
      tipEl = document.createElement('div');
      tipEl.className = 'ab-tip';
      tipEl.textContent = text;
      document.body.appendChild(tipEl);
      const h = tipEl.offsetHeight;
      tipEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - tipEl.offsetWidth - 4)) + 'px';
      tipEl.style.top = Math.min(window.innerHeight - h - 4, r.bottom + 6) + 'px';
    }, 420);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.remove(); tipEl = null; }
  }

  /* ---------- 单个按钮 ---------- */
  function mkBtn(host, opt) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ab-btn' + (opt.cls ? ' ' + opt.cls : '');
    b.innerHTML = window.Icons ? window.Icons.svg(opt.icon) : opt.icon;
    const tip = opt.label + (opt.key ? '  ' + opt.key : '');
    b.title = opt.title || tip;
    b.setAttribute('aria-label', opt.label);
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
      if (panelObserver) panelObserver.disconnect();
      hideTip();
      root = el;
      el.textContent = '';
      const tools = document.createElement('div'); tools.className = 'ab-tools';
      const panes = document.createElement('div'); panes.className = 'ab-panes';
      const extras = document.createElement('div'); extras.className = 'ab-extras';
      el.append(tools, panes, extras);

      // —— 顶部：主页 ——
      mkBtn(tools, {
        icon: 'home', label: '主页', onClick: () => {
          if (T.ui) T.ui.closeDock();
          if (window.Home?.isOpen() && T.term.order.length) { Home.hide(); return; }
          if (T.term.order.length) T.term.openHome();
          else if (window.Home) Home.show();
        },
      });
      mkBtn(tools, {
        icon: 'server', label: '机器管理', key: 'Ctrl+M', cls: 'ab-profiles',
        onClick: () => {
          const P = window.Profiles;
          if (T.ui) T.ui.toggleProfiles();
          else if (P) P.openManager();
          else if (T.ui) T.ui.toast('机器管理模块未加载');
        },
      });

      // —— 中部：侧栏窗格 ——
      for (const p of PANES) {
        const b = mkBtn(panes, {
          icon: p.icon, label: p.label, key: p.key,
          onClick: () => this.toggle(p.id),
        });
        b.dataset.pane = p.id;
        b.setAttribute('aria-haspopup', 'dialog');
        b.setAttribute('aria-controls', p.id === 'filer' ? 'sftp-panel' : 'dock');
        btns[p.id] = b;
        // 传输/日志有数量徽标
        if (p.id === 'transfer' || p.id === 'output') addBadge(b, p.id);
      }

      // 查询、命令与外观入口集中在同一条工具栏，设置仍位于右上角。
      const split = mkBtn(extras, { icon: 'splitH', label: '分屏', cls: 'ab-split ht-split',
        onClick: button => window.TabBar?.toggleSplitMenu(button) });
      split.setAttribute('aria-haspopup', 'menu'); split.setAttribute('aria-expanded', 'false');
      split.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault(); event.stopPropagation();
        if (split.getAttribute('aria-expanded') !== 'true') window.TabBar?.toggleSplitMenu(split);
        document.querySelector('.ht-menu > .mi:not(.dis)')?.focus();
      });
      const ai = mkBtn(extras, { icon: 'sparkles', label: 'AI 助手',
        onClick: () => window.AiPanel?.toggle() });
      ai.dataset.aiToggle = ''; ai.setAttribute('aria-controls', 'ai-panel'); ai.setAttribute('aria-expanded', 'false');
      mkBtn(extras, { icon: 'search', label: '查找', key: 'Ctrl+F',
        onClick: () => { if (T.ui) { T.ui.closeDock(); T.ui.toggleSearch(); } } });
      mkBtn(extras, { icon: 'terminal', label: '命令面板', key: 'Ctrl+Shift+P',
        onClick: () => { if (T.ui) { T.ui.closeDock(); T.ui.togglePalette(); } } });
      mkBtn(extras, {
        icon: 'theme', label: '切换深浅色', onClick: () => {
          if (window.Settings) Settings.cycleLightDark();
          else if (T.ui) T.ui.cycleTheme();
        },
      });

      const sftp = document.getElementById('sftp-panel');
      if (sftp && typeof MutationObserver === 'function') {
        panelObserver = new MutationObserver(() => this.render());
        panelObserver.observe(sftp, { attributes: true, attributeFilter: ['hidden'] });
        const main = document.getElementById('main-area');
        if (main) panelObserver.observe(main, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
        const palette = document.getElementById('palette');
        if (palette) panelObserver.observe(palette, { attributes: true, attributeFilter: ['hidden'] });
      }
      this.render();
    },

    /* 点按开合：同 Tabby，再点当前窗格则收起整条侧栏 */
    toggle(paneId) {
      if (paneId === 'filer' && window.SftpPanel) {
        if (T.ui) {
          T.ui.closeDock();
          if (!SftpPanel.isOpen()) {
            if (!document.getElementById('search-float')?.hidden) T.ui.closeSearch();
            if (!document.getElementById('palette')?.hidden) T.ui.closePalette();
          }
        }
        SftpPanel.toggle(); this.render(); return;
      }
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

    // 保留旧调用点，设置状态由标题栏统一同步。
    syncSettings() {
      if (window.TitleBar) TitleBar.syncSettings();
    },

    render() {
      if (!root) return;
      const ai = root.querySelector('[data-ai-toggle]');
      if (ai) { const active = !!window.AiPanel?.isOpen(); ai.classList.toggle('on', active); ai.setAttribute('aria-expanded', String(active)); }
      const open = !!T.s.dockVisible;
      const cur = open ? T.s.dockPane : null;
      for (const p of PANES) {
        const b = btns[p.id];
        if (b) {
          const active = p.id === 'filer' ? !!(window.SftpPanel && SftpPanel.isOpen()) : p.id === cur;
          b.classList.toggle('on', active);
          b.setAttribute('aria-expanded', String(active));
        }
        if (p.id === cur) this.clearBadge(p.id);
      }
      const sb = root.querySelector('.ab-profiles');
      if (sb) {
        const active = !!window.Profiles?.isOpen(); sb.classList.toggle('on', active);
        sb.setAttribute('aria-expanded', String(active)); sb.setAttribute('aria-haspopup', 'dialog');
      }
      for (const [label, id] of [['查找', 'search-float'], ['命令面板', 'palette']]) {
        const button = root.querySelector('[aria-label="' + label + '"]');
        const active = !!document.getElementById(id) && !document.getElementById(id).hidden;
        if (button) { button.classList.toggle('on', active); button.setAttribute('aria-expanded', String(active)); button.setAttribute('aria-controls', id); }
      }
    },
  };

  window.ActBar = ActBar;
})();
