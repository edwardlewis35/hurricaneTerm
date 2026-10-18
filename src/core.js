/* WT — core: Tauri bridge, persisted state, bootstrap. Original code (Apache-2.0). */
window.WT = (function () {
  const core = window.__TAURI__.core;
  const ev = window.__TAURI__.event;

  // 与 package.json / tauri.conf.json / Cargo.toml 同步 bump
  const VERSION = '0.10.1';

  function cmpVer(a, b) {
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
    return 0;
  }

  const WT = {
    VERSION,
    invoke: (c, a) => core.invoke(c, a),
    listen: (e, cb) => ev.listen(e, cb),

    copyText(text, options = {}) {
      const value = String(text ?? '');
      const write = async () => {
        if (options.shouldWrite && !options.shouldWrite()) return false;
        const native = window.__TAURI__?.clipboardManager;
        if (native?.writeText) { await native.writeText(value); return true; }
        if (window.__TAURI_INTERNALS__) { await WT.invoke('plugin:clipboard-manager|write_text', { text: value }); return true; }
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
          await navigator.clipboard.writeText(value); return true;
        } catch (_) {
          // Browser previews can lack the asynchronous API. Keep the fallback
          // within this document and restore focus and DOM selection afterwards.
          const previous = document.activeElement, selection = window.getSelection();
          const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
          const field = document.createElement('textarea'); field.value = value; field.readOnly = true;
          field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
          document.body.append(field);
          try { field.focus(); field.select(); if (!document.execCommand?.('copy')) throw new Error('无法写入系统剪贴板'); }
          finally {
            field.remove();
            try { previous?.focus({ preventScroll: true }); selection?.removeAllRanges(); for (const range of ranges) selection?.addRange(range); } catch (_) {}
          }
          return true;
        }
      };
      const operation = (WT._clipboardQueue || Promise.resolve()).then(write);
      WT._clipboardQueue = operation.catch(() => {});
      return operation;
    },

    s: {
      theme: 'dige-black',
      fontSize: 13,
      fontFamily: '',
      backgroundOpacity: 100,
      terminalOpacity: 100,
      triggers: [],
      sessions: [],
      sync: false,
      mode: 'Remote',
      dockPane: 'explorer',
      dockVisible: false,          // 工具浮窗默认收起
      filerMode: '', remotePath: null,
      filerPath: null,
      statusBar: false,            // 默认让终端铺满窗口，可在外观设置中开启状态栏
      tooltips: true,
      homeOnStart: true,
      activityDot: true,
      builtinHighlight: true,      // 内置输出高亮
      copyOnSelect: true,          // 选中自动复制
      rightClickPaste: true,       // PuTTY 习惯：右键粘贴
      sessionLog: false,           // PuTTY 习惯：会话输出落盘
      ai: { endpoint: '', model: '', width: 380 },
      lastUpdateCheck: 0,
      updateInfo: null,
    },

    async init() {
      try {
        const raw = await WT.invoke('ui_state_load', { name: 'settings' });
        if (raw) {
          const saved = JSON.parse(raw);
          Object.assign(WT.s, saved);
          // The previous single slider controlled both backgrounds. Keep its
          // saved value for existing installations when adding the separate setting.
          if (!Object.prototype.hasOwnProperty.call(saved, 'terminalOpacity')) WT.s.terminalOpacity = WT.s.backgroundOpacity;
        }
      } catch (e) {}
      try {
        const ss = await WT.invoke('sessions_load');
        if (Array.isArray(ss)) WT.s.sessions = ss;
      } catch (e) {}
    },

    persistSettings() {
      const keys = ['theme', 'fontSize', 'fontFamily', 'backgroundOpacity', 'terminalOpacity', 'triggers', 'sync', 'mode', 'dockPane', 'dockVisible',
        'statusBar', 'tooltips', 'homeOnStart', 'activityDot', 'builtinHighlight',
        'copyOnSelect', 'rightClickPaste', 'sessionLog', 'lastUpdateCheck', 'updateInfo', 'sftp'];
      const o = {};
      for (const k of keys) o[k] = WT.s[k];
      // Explicit allowlist: never serialize API keys, conversations or attachments.
      if (WT.s.ai) o.ai = { endpoint: WT.s.ai.endpoint || '', model: WT.s.ai.model || '', width: WT.s.ai.width || 380,
        contextWindow: WT.s.ai.contextWindow || 32768, autoCompact: WT.s.ai.autoCompact !== false,
        confirmCommands: WT.s.ai.confirmCommands !== false, rememberKey: WT.s.ai.rememberKey !== false };
      if (WT.s.aiMemory) o.aiMemory = { enabled: WT.s.aiMemory.enabled === true, endpoint: WT.s.aiMemory.endpoint || '',
        model: WT.s.aiMemory.model || '', rememberKey: WT.s.aiMemory.rememberKey !== false, autoRecall: WT.s.aiMemory.autoRecall !== false,
        flushBeforeCompact: WT.s.aiMemory.flushBeforeCompact === true, includeGlobal: WT.s.aiMemory.includeGlobal !== false,
        maxResults: Math.max(1, Math.min(12, Number(WT.s.aiMemory.maxResults) || 6)),
        minScore: Number.isFinite(Number(WT.s.aiMemory.minScore)) ? Math.max(0, Math.min(1, Number(WT.s.aiMemory.minScore))) : .35 };
      WT.invoke('ui_state_save', { name: 'settings', value: JSON.stringify(o) }).catch(() => {});
      // 触发器变更同步到后端语义引擎（re/triggers.rs）
      WT.invoke('triggers_reload', { triggers: JSON.stringify(WT.s.triggers || []) }).catch(() => {});
    },

    persistSessions() {
      return WT.invoke('sessions_save', { sessions: WT.s.sessions }).catch(() => {});
    },

    // 把指定标签（或全部）的日志缓冲刷到磁盘
    flushLogs(only) {
      const tabs = only ? [only] : Object.values(WT.term.tabs);
      for (const t of tabs) {
        if (!t.logging || !t.logBuf) continue;
        const buf = t.logBuf;
        t.logBuf = '';
        WT.invoke('session_log_append', { id: t.id, data: buf }).catch(() => {});
      }
    },

    /* 内部更新检查：release 为草稿时公开 API 看不到附件，但 tags 是公开的，
     * 用最新 tag 与内置 VERSION 比较；发现新版本仅提示 + 在设置页给出 tag 地址。 */
    async checkUpdate(manual) {
      try {
        const r = await fetch('https://api.github.com/repos/edwardlewis35/hurricaneTerm/tags?per_page=1',
          { headers: { Accept: 'application/vnd.github+json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const list = await r.json();
        const latest = String((list[0] && list[0].name) || '').replace(/^v/, '');
        WT.s.updateInfo = { latest, current: WT.VERSION, checkedAt: Date.now() };
        WT.s.lastUpdateCheck = Date.now();
        WT.persistSettings();
        if (latest && cmpVer(latest, WT.VERSION) > 0) {
          WT.ui.toast('发现新版本 v' + latest + '（当前 v' + WT.VERSION + '），设置→关于可查看详情', 6000, 'ok');
          if (window.Settings && Settings.isOpen()) Settings.render();
          return latest;
        }
        if (manual) WT.ui.toast('已是最新（v' + WT.VERSION + '）', 2400, 'ok');
        return null;
      } catch (e) {
        if (manual) WT.ui.toast('检查更新失败：' + (e && e.message ? e.message : e), 3200, 'err');
        return null;
      }
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
    // Apply to every editor, including dynamically created WebKit controls and
    // xterm's hidden textarea, without changing macOS-wide user preferences.
    const exactInput = node => {
      if (!node?.matches?.('input,textarea,[contenteditable="true"]')) return;
      node.setAttribute('autocapitalize', 'none'); node.setAttribute('autocorrect', 'off'); node.setAttribute('spellcheck', 'false');
    };
    document.documentElement.setAttribute('autocapitalize', 'none');
    document.body.setAttribute('autocorrect', 'off');
    document.querySelectorAll('input,textarea,[contenteditable="true"]').forEach(exactInput);
    document.addEventListener('focusin', event => exactInput(event.target), true);
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
    if (window.SftpPanel) SftpPanel.mount($('#sftp-panel'));
    if (window.TransferQueue) TransferQueue.mount();
    if (window.AiPanel) AiPanel.mount($('#ai-panel'));
    if (!WT.term.order.length && WT.s.homeOnStart !== false && window.Home) Home.show();

    wireChrome();
    WT.ui.status();
    setInterval(() => WT.ui.clock(), 1000);
    WT.ui.clock();

    await WT.listen('pty-output', (e) => {
      const { id, data } = e.payload;
      const tab = WT.term.findByPty(id);
      if (!tab) { WT.term.queuePendingEvent('output', id, data); return; }
      if (tab._closing || tab.exited) return;
      WT.term.receiveOutput(tab, data);
      if (tab.logging) tab.logBuf = (tab.logBuf || '') + data;
      // 活动通知：后台标签有输出且开了 notify → 圆点
      if (tab.notify && WT.s.activityDot !== false && WT.term.active !== tab.id && !tab.activity) {
        tab.activity = true;
        WT.term.renderTabbar();
      }
    });
    await WT.listen('re-log', (e) => { try { WT.ui.log(e.payload.data); } catch (_) {} });
    await WT.listen('transfer-progress', (e) => {
      try {
        const [name, done, total, dir, last] = e.payload.data.split('\t');
        WT.ui.transferProgress(name, +done, +total, dir, last === '1');
      } catch (_) {}
    });
    await WT.listen('sftp-transfer-progress', (e) => {
      if (window.SftpPanel) SftpPanel.progress(e.payload.data);
    });
    await WT.listen('modem-transfer-progress', (e) => {
      try { window.ModemTransfer?.progress(e.payload.data ?? e.payload); }
      catch (error) { WT.ui.log('终端传输进度格式无效：' + String(error)); }
    });
    await WT.listen('connection-error', (e) => {
      const payload = e.payload || {};
      if (typeof payload.id !== 'string') return;
      let details = payload;
      if (!payload.error && typeof payload.data === 'string') {
        try { const parsed = JSON.parse(payload.data); details = parsed && typeof parsed === 'object' ? parsed : { error: payload.data }; }
        catch (_) { details = { error: payload.data }; }
      }
      details = { error: String(details.error || details.message || '连接异常，未返回具体原因').slice(0, 16384),
        stage: String(details.stage || '').slice(0, 64), protocol: String(details.protocol || '').slice(0, 16) };
      const tab = WT.term.findByPty(payload.id);
      if (!tab) { WT.term.queuePendingEvent('error', payload.id, details); return; }
      WT.term.handleConnectionError(tab, payload.id, details);
    });
    await WT.listen('pty-exit', (e) => {
      const tab = WT.term.findByPty(e.payload.id);
      if (!tab) { WT.term.queuePendingEvent('exit', e.payload.id); return; }
      if (!WT.term.handleExit(tab, e.payload.id)) return;
      WT.ui.log('会话退出或断开 ' + e.payload.id.slice(0, 8));
    });

    window.addEventListener('resize', () => {
      WT.ui.fitAll();
      WT.ui.status();
      if (window.TitleBar) TitleBar.refresh();
    });

    // 会话日志按秒刷盘（前端缓冲 → session_log_append）
    setInterval(() => WT.flushLogs(), 1000);

    // 每天至多一次的非阻塞更新检查
    if (Date.now() - (WT.s.lastUpdateCheck || 0) > 86400000) WT.checkUpdate(false);

    WT.ui.log('hurricaneTerm 启动完成 · 模式 ' + WT.s.mode + ' · 主题 ' + WT.s.theme);
    // Tabby 语义：启动不自动开终端，无标签时展示主页
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return WT;
})();
