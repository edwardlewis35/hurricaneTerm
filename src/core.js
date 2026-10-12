/* WT — core: Tauri bridge, persisted state, bootstrap. Original code (Apache-2.0). */
window.WT = (function () {
  const core = window.__TAURI__.core;
  const ev = window.__TAURI__.event;

  const WT = {
    invoke: (c, a) => core.invoke(c, a),
    listen: (e, cb) => ev.listen(e, cb),

    s: {
      theme: 'tabby-dark',
      fontSize: 13,
      fontFamily: '',
      triggers: [],
      sessions: [],
      sync: false,
      mode: 'Remote',
      dockPane: 'explorer',
      dockVisible: false,          // Tabby 默认收起侧栏
      filerMode: '', remotePath: null,
      filerPath: null,
      statusBar: true,             // 底部状态栏（Tabby 原版无，可关）
      tooltips: true,
      homeOnStart: true,
      activityDot: true,
      builtinHighlight: true,      // WindTerm 风格内置输出高亮
    },

    async init() {
      try {
        const raw = await WT.invoke('ui_state_load', { name: 'settings' });
        if (raw) Object.assign(WT.s, JSON.parse(raw));
      } catch (e) {}
      try {
        const ss = await WT.invoke('sessions_load');
        if (Array.isArray(ss)) WT.s.sessions = ss;
      } catch (e) {}
    },

    persistSettings() {
      const keys = ['theme', 'fontSize', 'fontFamily', 'triggers', 'sync', 'mode', 'dockPane', 'dockVisible',
        'statusBar', 'tooltips', 'homeOnStart', 'activityDot', 'builtinHighlight'];
      const o = {};
      for (const k of keys) o[k] = WT.s[k];
      WT.invoke('ui_state_save', { name: 'settings', value: JSON.stringify(o) }).catch(() => {});
      // 触发器变更同步到后端语义引擎（re/triggers.rs）
      WT.invoke('triggers_reload', { triggers: JSON.stringify(WT.s.triggers || []) }).catch(() => {});
    },

    persistSessions() {
      return WT.invoke('sessions_save', { sessions: WT.s.sessions }).catch(() => {});
    },
  };

  /* ---------- bootstrap ---------- */
  window.addEventListener('error', (e) => {
    const msg = `${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`;
    try { WT.ui && WT.ui.log('JS 错误：' + msg); } catch (_) {}
    WT.invoke('ui_state_save', { name: 'jserror', value: JSON.stringify({ msg, t: Date.now() }) }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    const msg = 'Promise 拒绝：' + (e.reason && e.reason.message ? e.reason.message : String(e.reason));
    try { WT.ui && WT.ui.log(msg); } catch (_) {}
    WT.invoke('ui_state_save', { name: 'jserror', value: JSON.stringify({ msg, t: Date.now() }) }).catch(() => {});
  });

  const $ = (s) => document.querySelector(s);

  /* 浮动搜索卡 / 命令面板 / 状态栏 chip 的接线 */
  function wireChrome() {
    const ic = (n) => (window.Icons ? window.Icons.svg(n) : '');
    const sp = $('#search-prev'), sn = $('#search-next'), sc = $('#search-close');
    if (sp) sp.innerHTML = ic('up');
    if (sn) sn.innerHTML = ic('down');
    if (sc) sc.innerHTML = ic('x');

    const si = $('#search-input');
    if (si) {
      si.addEventListener('input', (e) => { WT.ui.lastQuery = e.target.value; });
      si.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); WT.ui.doSearch(!e.shiftKey); }
        else if (e.key === 'Escape') { e.preventDefault(); WT.ui.closeSearch(); }
      });
    }
    if (sn) sn.onclick = () => WT.ui.doSearch(true);
    if (sp) sp.onclick = () => WT.ui.doSearch(false);
    if (sc) sc.onclick = () => WT.ui.closeSearch();

    const pi = $('#palette-input');
    if (pi) pi.addEventListener('input', (e) => WT.ui.filterPalette(e.target.value));

    // 状态栏 chip：点按就地操作（取代原菜单栏）
    const chip = (id, fn, title) => {
      const e = $(id);
      if (!e) return;
      e.onclick = (ev) => { ev.stopPropagation(); fn(e, ev); };
      if (title) e.title = title;
    };
    chip('#st-mode', (el, ev) => {
      if (!window.TabBar) { WT.ui.setMode(WT.s.mode === 'Local' ? 'Remote' : 'Local'); return; }
      TabBar.openMenu(ev.clientX, ev.clientY - 8, (m, mi) => {
        mi(m, { label: '远程模式', svg: 'globe', checked: WT.s.mode === 'Remote', onClick: () => WT.ui.setMode('Remote') });
        mi(m, { label: '本地模式', svg: 'terminal', checked: WT.s.mode === 'Local', onClick: () => WT.ui.setMode('Local') });
      });
    });
    chip('#st-sync', () => WT.ui.toggleSync(), '同步输入：所有会话同时接收键盘输入');
    chip('#st-zoom', () => WT.ui.zoomReset ? WT.ui.zoomReset() : WT.term.zoomReset(), '点击重置字号');
    chip('#st-theme', () => WT.ui.cycleTheme(), '点击切换深浅色');
  }

  async function boot() {
    await WT.init();
    // 启动时把已保存的触发器载入后端引擎（re/triggers.rs）
    WT.invoke('triggers_reload', { triggers: JSON.stringify(WT.s.triggers || []) }).catch(() => {});

    document.body.classList.toggle('no-status', WT.s.statusBar === false);

    WT.ui.buildDock();                 // 侧栏内容 + 宽度拖拽 + 分屏分隔条
    WT.term.applyTheme(WT.s.theme);
    if (WT.s.fontFamily) WT.term.applyFontFamily(WT.s.fontFamily);

    // Tabby 形态：无边框标题栏 → 标签栏 → 图标活动栏 → 全页设置 → 主页
    if (window.TitleBar) TitleBar.mount($('#tb-actions'), $('#tb-winctl'));
    if (window.TabBar) TabBar.mount($('#tabbar'));
    if (window.ActBar) ActBar.mount($('#actbar'));
    if (window.Settings) Settings.mount($('#settings'));
    if (window.Home) Home.mount($('#home'));
    if (!WT.term.order.length && WT.s.homeOnStart !== false && window.Home) Home.show();

    wireChrome();
    WT.ui.status();
    setInterval(() => WT.ui.clock(), 1000);
    WT.ui.clock();

    await WT.listen('pty-output', (e) => {
      const { id, data } = e.payload;
      const tab = WT.term.findByPty(id);
      if (!tab) return;
      // 高亮要在 write 回调里跑（xterm 异步解析），触发器不依赖光标位置可先跑
      tab.term.write(data, () => WT.term.runHighlights(tab, data));
      // 活动通知：后台标签有输出且开了 notify → 圆点
      if (tab.notify && WT.s.activityDot !== false && WT.term.active !== tab.id && !tab.activity) {
        tab.activity = true;
        WT.term.renderTabbar();
      }
      WT.term.runTriggers(tab, data);
    });
    await WT.listen('re-log', (e) => { try { WT.ui.log(e.payload.data); } catch (_) {} });
    await WT.listen('transfer-progress', (e) => {
      try {
        const [name, done, total, dir, last] = e.payload.data.split('\t');
        WT.ui.transferProgress(name, +done, +total, dir, last === '1');
      } catch (_) {}
    });
    await WT.listen('pty-exit', (e) => {
      const tab = WT.term.findByPty(e.payload.id);
      if (!tab || tab.exited) return;
      tab.exited = true;
      tab.term.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n');
      WT.term.renderTabbar();
      WT.ui.log('会话退出 ' + e.payload.id.slice(0, 8));
    });

    window.addEventListener('resize', () => {
      WT.ui.fitAll();
      WT.ui.status();
      if (window.TitleBar) TitleBar.refresh();
    });

    WT.ui.log('hurricaneTerm 启动完成 · 模式 ' + WT.s.mode + ' · 主题 ' + WT.s.theme);
    // Tabby 语义：启动不自动开终端，无标签时展示主页
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return WT;
})();
