/* WT — core: Tauri bridge, persisted state, bootstrap. Original code (MIT). */
window.WT = (function () {
  const core = window.__TAURI__.core;
  const ev = window.__TAURI__.event;

  const WT = {
    invoke: (c, a) => core.invoke(c, a),
    listen: (e, cb) => ev.listen(e, cb),

    s: {
      theme: 'default',
      fontSize: 13,
      triggers: [],
      sessions: [],
      sync: false,
      mode: 'Remote',
      dockPane: 'explorer',
      filerMode: '', remotePath: null,
      dockVisible: true,
      filerPath: null,
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
      const keys = ['theme', 'fontSize', 'triggers', 'sync', 'mode', 'dockPane', 'dockVisible'];
      const o = {};
      for (const k of keys) o[k] = WT.s[k];
      WT.invoke('ui_state_save', { name: 'settings', value: JSON.stringify(o) }).catch(() => {});
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

  async function boot() {
    await WT.init();

    WT.ui.buildMenu();
    WT.ui.buildToolbar();
    WT.ui.buildDock();
    WT.term.applyTheme(WT.s.theme);
    if (!WT.s.dockVisible) { document.getElementById('dock').hidden = true; document.getElementById('dock-resizer').hidden = true; }
    WT.ui.status();
    setInterval(() => WT.ui.clock(), 1000);
    WT.ui.clock();

    await WT.listen('pty-output', (e) => {
      const { id, data } = e.payload;
      const tab = WT.term.findByPty(id);
      if (!tab) return;
      tab.term.write(data);
      WT.term.runTriggers(tab, data);
    });
    await WT.listen('re-log', (ev) => { try { WT.ui.log(ev.payload.data); } catch (_) {} });
    await WT.listen('transfer-progress', (ev) => {
      try {
        const [name, done, total, dir, last] = ev.payload.data.split('\t');
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
      const t = WT.term.activeTab();
      if (t) { try { t.fit.fit(); } catch (e) {} }
      WT.ui.status();
    });

    // search bar wiring
    document.getElementById('search-input').addEventListener('input', (e) => { WT.ui.lastQuery = e.target.value; });
    document.getElementById('search-next').onclick = () => WT.ui.doSearch(true);
    document.getElementById('search-prev').onclick = () => WT.ui.doSearch(false);
    document.getElementById('search-close').onclick = () => WT.ui.closeSearch();

    // palette wiring
    document.getElementById('palette-input').addEventListener('input', (e) => WT.ui.filterPalette(e.target.value));

    // dialogs wiring
    document.getElementById('sf-save').onclick = () => WT.ui.saveSessionFromDialog();
    document.getElementById('sf-cancel').onclick = () => WT.ui.closeDlg('#dlg-session');
    document.getElementById('tr-add').onclick = () => WT.ui.addTrigger();
    document.getElementById('tr-close').onclick = () => WT.ui.closeDlg('#dlg-triggers');
    document.getElementById('ab-close').onclick = () => WT.ui.closeDlg('#dlg-about');

    WT.ui.log('hurricaneTerm 启动完成 · 模式 ' + WT.s.mode + ' · 主题 ' + WT.s.theme);
    await WT.term.create(null);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return WT;
})();