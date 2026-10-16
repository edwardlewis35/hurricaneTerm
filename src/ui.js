/* hurricaneTerm — ui.js：工具浮窗、状态栏、命令面板、浮动搜索、Toast
 * 原创代码 (Apache-2.0)。
 *
 * 0.7.0 改版：删除 0.6.0 的老式菜单栏（#menubar，10 个下拉）与 emoji 工具栏（#toolbar）；
 *   所有入口迁到「左侧图标活动栏（actbar.js）+ 全页设置（settings.js）+ 命令面板 + 右键菜单」。
 *   <dialog> 弹窗（会话表单 / 触发器 / 关于）一并移除：表单归 profiles.js，其余归 settings.js。
 *   窗格内容结构：Explorer/Filer/Outline/Sender/Transfer/Output。
 */
(function () {
  const T = window.WT;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const svg = (n) => (window.Icons ? window.Icons.svg(n) : '');

  const PANES = [
    ['explorer', '会话'], ['filer', '文件浏览器'], ['sender', '发送'],
    ['transfer', '传输'], ['outline', '大纲'], ['output', '日志'],
  ];

  const UI = {
    lastQuery: '',
    logs: [],
    transfers: [],

    /* ---------- basic ---------- */
    log(msg) {
      this.logs.push({ t: new Date(), msg });
      if (this.logs.length > 300) this.logs.shift();
      this.renderOutput();
      if (window.ActBar) ActBar.bump('output');
    },

    // kind: '' | 'ok' | 'err'
    toast(msg, ms, kind) {
      const host = $('#toasts');
      if (!host) return;
      const el = document.createElement('div');
      el.className = 'toast' + (kind ? ' ' + kind : '');
      el.textContent = msg;
      host.appendChild(el);
      // 最多同时 4 条，超出丢最旧
      while (host.children.length > 4) host.firstElementChild.remove();
      setTimeout(() => { el.remove(); }, ms || 2400);
    },

    beep() {
      try {
        const ctx = this._ac || (this._ac = new (window.AudioContext || window.webkitAudioContext)());
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.type = 'sine';
        g.gain.setValueAtTime(0.08, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.2);
      } catch (e) {}
    },

    status() {
      window.AiPanel?.onSessionChange?.();
      const info = T.term.statusInfo();
      const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
      set('#st-mode', T.s.mode === 'Local' ? '本地模式' : '远程模式');
      const m = $('#st-mode'); if (m) m.classList.toggle('on', T.s.mode === 'Local');
      set('#st-sync', '同步输入：' + (T.s.sync ? '开' : '关'));
      const sy = $('#st-sync'); if (sy) sy.classList.toggle('on', !!T.s.sync);
      set('#st-size', `${info.cols} × ${info.rows}`);
      set('#st-theme', T.s.theme);
      set('#st-zoom', T.s.fontSize + ' px');
      set('#st-enc', 'UTF-8');
      set('#st-eol', 'LF');
      // 模式色带 + 同步输入描边（全局态一眼可见）
      document.body.classList.toggle('mode-remote', T.s.mode !== 'Local');
      document.body.classList.toggle('mode-local', T.s.mode === 'Local');
      document.body.classList.toggle('sync-on', !!T.s.sync);
    },
    clock() { const e = $('#st-clock'); if (e) e.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); },

    win() {
      const w = window.__TAURI__ && window.__TAURI__.window;
      return Promise.resolve(w && typeof w.getCurrentWindow === 'function' ? w.getCurrentWindow() : null);
    },

    /* ---------- 工具浮窗（水平工具栏驱动） ---------- */
    buildDock() {
      if (this._dockBuilt) return;
      this._dockBuilt = true;
      // 浮窗仅由显式点击或快捷键打开，旧版保存的 dockVisible 不再占用启动空间。
      T.s.dockVisible = false;
      this.applyDockVisibility();
      const close = $('#dock-close');
      if (close) { close.innerHTML = svg('x'); close.addEventListener('click', () => this.closeDock()); }
      document.addEventListener('pointerdown', (e) => {
        if (!T.s.dockVisible || e.target.closest('#dock, #actbar, .wt-select-menu, .ht-menu')) return;
        this.closeDock();
      }, true);
      document.addEventListener('keydown', (e) => {
        if (!T.s.dockVisible) return;
        // Portaled dropdown/menu handles its own Escape before the surrounding window.
        if (window.CommonControls && CommonControls.isOpen || window.TabBar && TabBar.menuOpen()) return;
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopImmediatePropagation(); this.closeDock(); return;
        }
        if (e.key !== 'Tab') return;
        const dock = $('#dock');
        const focusable = Array.from(dock.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'))
          .filter(el => !el.hidden && !el.closest('[hidden]') && el.getAttribute('aria-hidden') !== 'true');
        if (!focusable.length) { e.preventDefault(); dock.focus(); return; }
        const index = focusable.indexOf(document.activeElement);
        if (index < 0 || e.shiftKey && index === 0 || !e.shiftKey && index === focusable.length - 1) {
          e.preventDefault(); focusable[e.shiftKey ? focusable.length - 1 : 0].focus();
        }
      }, true);

      // 分屏分隔条拖拽
      const gut = $('#gutter');
      if (gut) {
        let gdrag = false, start = 0, startSize = 0;
        gut.addEventListener('mousedown', (e) => {
          gdrag = true; e.preventDefault();
          const g0 = $('#groups .group[data-g="0"]');
          const dir = $('#groups').dataset.dir;
          start = dir === 'v' ? e.clientY : e.clientX;
          startSize = dir === 'v' ? g0.offsetHeight : g0.offsetWidth;
          document.body.classList.add('dragging');
        });
        window.addEventListener('mousemove', (e) => {
          if (!gdrag) return;
          const g0 = $('#groups .group[data-g="0"]');
          const host = $('#groups');
          const dir = host.dataset.dir;
          const total = dir === 'v' ? host.offsetHeight : host.offsetWidth;
          const cur = startSize + ((dir === 'v' ? e.clientY : e.clientX) - start);
          const pct = Math.max(12, Math.min(88, (cur / Math.max(1, total)) * 100));
          g0.style.flex = `0 0 ${pct}%`;
          const state = T.term.workspaceState && T.term.workspaceState(); if (state) state.ratio = pct;
        });
        window.addEventListener('mouseup', () => {
          if (!gdrag) return;
          gdrag = false; document.body.classList.remove('dragging');
          this.fitAll();
        });
      }
    },

    applyDockVisibility() {
      const dock = $('#dock'), backdrop = $('#dock-backdrop');
      const vis = !!T.s.dockVisible;
      if (dock) dock.hidden = !vis;
      if (backdrop) backdrop.hidden = !vis;
      const label = PANES.find(p => p[0] === T.s.dockPane);
      const title = $('#dock-title');
      if (title) {
        title.textContent = label ? label[1] : '工具';
        if (T.s.dockPane === 'transfer') {
          const count = document.createElement('span'); count.className = 'dock-title-count';
          count.textContent = this.transfers.length + ' 项'; title.appendChild(count);
        }
      }
      if (window.ActBar) ActBar.render();
      if (window.TitleBar) TitleBar.refresh();
    },

    focusDock() {
      const dock = $('#dock');
      if (!dock || dock.hidden) return;
      // Re-rendered content must not steal focus from a text field inside the same dialog.
      if (!dock.contains(document.activeElement)) ($('#dock-close') || dock).focus();
    },

    setDockPane(id) {
      if (!PANES.some(p => p[0] === id)) return;
      const palette = $('#palette'), search = $('#search-float');
      if (palette && !palette.hidden) this.closePalette();
      if (search && !search.hidden) this.closeSearch();
      if (id === 'filer' && window.SftpPanel) { this.closeDock(); SftpPanel.open(); return; }
      if (!T.s.dockVisible) this._dockReturnFocus = document.activeElement;
      if (window.SftpPanel && SftpPanel.isOpen() && SftpPanel.close() === false) return;
      if (window.Settings && Settings.isOpen()) Settings.close();
      if (window.Profiles && Profiles.isOpen()) Profiles.close();
      T.s.dockPane = id;
      T.s.dockVisible = true;
      this.applyDockVisibility();
      this.renderDock();
      this.focusDock();
      T.persistSettings();
    },

    closeDock() {
      if (!T.s.dockVisible) return;
      T.s.dockVisible = false;
      this.applyDockVisibility();
      T.persistSettings();
      const previous = this._dockReturnFocus;
      this._dockReturnFocus = null;
      if (previous && previous.isConnected && typeof previous.focus === 'function') previous.focus();
    },

    toggleDock() {
      if (T.s.dockVisible) this.closeDock();
      else this.setDockPane(T.s.dockPane || 'explorer');
    },

    renderDock() {
      if (!T.s.dockVisible) return;
      const p = T.s.dockPane;
      if (p === 'explorer') this.renderExplorer();
      else if (p === 'filer') this.renderFiler();
      else if (p === 'outline') this.renderOutline();
      else if (p === 'sender') this.renderSender();
      else if (p === 'transfer') this.renderTransfer();
      else this.renderOutput();
    },

    fitActive(delay) {
      const go = () => { const t = T.term.activeTab(); if (t) { try { t.fit.fit(); } catch (e) {} } };
      delay ? setTimeout(go, delay) : go();
    },
    fitAll() { for (const t of Object.values(T.term.tabs)) { try { t.fit.fit(); } catch (e) {} } },

    /* ---------- 窗格：会话 ---------- */
    protoIcon(p) {
      return { ssh: 'lock', telnet: 'telnet', serial: 'serial', tcp: 'globe', local: 'terminal' }[(p || '').toLowerCase()] || 'terminal';
    },

    renderExplorer() {
      const body = $('#dock-body');
      if (!body) return;
      const groups = {};
      for (const s of (T.s.sessions || [])) (groups[s.folder || '（未分组）'] ||= []).push(s);
      let html = `<div class="pane-head"><span>会话</span>
        <span><button id="sess-add" title="机器管理 (Ctrl+M)">管理</button><button id="sess-refresh" title="刷新">⟳</button></span></div>`;
      for (const g of Object.keys(groups).sort()) {
        html += `<div class="grp">▸ ${g}</div>`;
        for (const s of groups[g]) {
          const sub = s.protocol === 'serial' ? (s.target || s.host || '串口')
            : s.protocol === 'tcp' ? (s.target || `${s.host}:${s.port}`)
              : (s.command || (s.host ? `${s.user || ''}@${s.host}` : '默认 shell'));
          html += `<div class="row sess" data-name="${encodeURIComponent(s.name)}">
            <span class="ico">${svg(this.protoIcon(s.protocol))}</span>
            <span class="col"><b>${escapeHtml(s.name)}</b><i>${escapeHtml(sub)}</i></span>
            <span class="x" data-del="${encodeURIComponent(s.name)}" title="删除">×</span></div>`;
        }
      }
      if (!(T.s.sessions || []).length) html += '<div class="empty">还没有机器。点「管理」新建，或在主页用快速连接直接连。</div>';
      html += '<div class="pane-foot">单击连接 · 右键另存/编辑</div>';
      body.innerHTML = html;
      body.querySelector('#sess-add').onclick = () => this.openProfiles();
      body.querySelector('#sess-refresh').onclick = () => this.renderExplorer();
      body.querySelectorAll('.sess').forEach((row) => {
        const name = decodeURIComponent(row.dataset.name);
        const s = (T.s.sessions || []).find((x) => x.name === name);
        row.onclick = (e) => { if (!e.target.dataset.del && s) T.term.create(s); };
        row.oncontextmenu = (e) => {
          e.preventDefault();
          this.sessionMenu(e.clientX, e.clientY, s);
        };
      });
      body.querySelectorAll('[data-del]').forEach((x) => {
        x.onclick = async (e) => {
          e.stopPropagation();
          const name = decodeURIComponent(x.dataset.del);
          T.s.sessions = (T.s.sessions || []).filter((s) => s.name !== name);
          await T.persistSessions();
          this.renderExplorer();
          if (window.Home) Home.render();
          this.toast('已删除机器：' + name);
        };
      });
    },

    // 会话行右键：连接 / 编辑 / 复制 / 删除
    sessionMenu(x, y, s) {
      if (!s || !window.TabBar || !window.TabBar.openMenu) return;
      TabBar.openMenu(x, y, (m, mi, msep) => {
        mi(m, { label: '连接', svg: 'plug', onClick: () => T.term.create(s) });
        mi(m, { label: '在新分屏中连接', svg: 'splitH', onClick: async () => { await T.term.splitActive('right'); T.term.create(s); } });
        msep(m);
        mi(m, { label: '编辑机器…', svg: 'server', onClick: () => this.editProfile(s) });
        mi(m, {
          label: '删除机器', svg: 'trash', danger: true, onClick: async () => {
            T.s.sessions = (T.s.sessions || []).filter((z) => z !== s);
            await T.persistSessions();
            this.renderExplorer();
            if (window.Home) Home.render();
            this.toast('已删除机器：' + s.name);
          },
        });
      });
    },

    toggleProfiles() {
      if (window.Profiles?.isOpen()) { Profiles.close(); if (window.ActBar) ActBar.render(); }
      else this.openProfiles();
    },

    openProfiles() {
      const palette = $('#palette'), search = $('#search-float');
      if (palette && !palette.hidden) this.closePalette();
      if (search && !search.hidden) this.closeSearch();
      if (window.SftpPanel && SftpPanel.isOpen() && SftpPanel.hide() === false) return;
      this.closeDock();
      if (window.Settings && Settings.isOpen()) Settings.close();
      if (window.Profiles) window.Profiles.openManager();
      else this.toast('机器管理模块未加载');
      if (window.ActBar) ActBar.render();
    },

    /* SSH 连接只准备文件管理路径。工具窗口由用户点击打开，不抢占新终端。 */
    onSshConnected(tab) {
      if (!tab || !tab.session || tab.session.protocol !== 'ssh') return;
      T.s.remotePath = '.';
      T.s.filerMode = 'both';
      this.toast('已连接 ' + (tab.session.host || '') + '，点击文件图标打开 SFTP');
    },

    /* ---------- 窗格：文件浏览器（SFTP 双栏） ---------- */
    async renderFiler() {
      const body = $('#dock-body');
      if (!body) return;
      const tab = T.term.activeTab();
      const connected = tab && tab.session && tab.session.protocol === 'ssh' && !tab.exited;
      body.innerHTML = `<div class="pane-head"><span>文件管理</span></div>
        <div class="sender"><b>${escapeHtml(connected ? tab.title : '本地文件')}</b>
        <p class="dim">独立双栏文件管理，支持书签、筛选、文件编辑与传输队列。</p>
        <button class="primary" id="open-sftp-panel">打开文件管理 (Ctrl+2)</button></div>`;
      body.querySelector('#open-sftp-panel').onclick = () => window.SftpPanel && SftpPanel.open();
    },

    /* ---------- 窗格：发送 ---------- */
    senderSet(text, direct) {
      if (!T.s.dockVisible || T.s.dockPane !== 'sender') this.setDockPane('sender');
      const ta = $('#dock-body textarea');
      if (ta) { ta.value = text.replace(/\r$/, ''); ta.focus(); }
      if (direct) T.term.broadcast(text, false);
    },

    renderSender() {
      const body = $('#dock-body');
      if (!body) return;
      body.innerHTML = `<div class="pane-head"><span>发送文本</span><span>Sender</span></div>
        <div class="sender">
          <textarea id="send-text" placeholder="输入要发送到终端的文本（Ctrl+Enter 发送）" spellcheck="false"></textarea>
          <div class="sender-btns">
            <button id="send-cur">发送到当前</button>
            <button id="send-all">发送到全部</button>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <button class="sw-toggle${T.s.sync ? ' on' : ''}" id="send-sync" role="switch" aria-checked="${!!T.s.sync}"></button>
              键盘同步输入</label>
          </div>
        </div>`;
      const ta = body.querySelector('#send-text');
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); T.term.broadcast(ta.value + '\r', false); }
      });
      body.querySelector('#send-cur').onclick = () => T.term.broadcast(ta.value + '\r', false);
      body.querySelector('#send-all').onclick = () => T.term.broadcast(ta.value + '\r', true);
      const sw = body.querySelector('#send-sync');
      sw.onclick = () => this.toggleSync();
    },

    /* ---------- 窗格：传输 ---------- */
    transferProgress(name, done, total, dir, last) {
      let t = this.transfers.find((x) => x.name === name && x.dir === dir);
      if (!t) { t = { name, dir, done: 0, total: 0, last: false }; this.transfers.push(t); }
      t.done = done; t.total = total; t.last = !!last;
      if (this.transfers.length > 40) this.transfers.shift();
      if (T.s.dockPane === 'transfer' && T.s.dockVisible) this.renderTransfer();
      if (window.ActBar) ActBar.bump('transfer');
    },
    renderTransfer() {
      const body = $('#dock-body');
      if (!body) return;
      this.applyDockVisibility();
      let html = '';
      if (!this.transfers.length) html += '<div class="empty">暂无传输记录。上传或下载文件后，可在这里查看进度。</div>';
      for (const t of this.transfers.slice(-20)) {
        const pct = t.total ? Math.min(100, Math.round(t.done * 100 / t.total)) : 0;
        html += `<div class="trow2"><span class="col"><b>${t.dir === 'up' ? '↑' : '↓'} ${escapeHtml(t.name)}</b>
          <i>${fmtSize(t.done)} / ${fmtSize(t.total)}${t.last ? ' · 完成' : ''}</i></span>
          <div class="pbar"><div style="width:${pct}%"></div></div></div>`;
      }
      body.innerHTML = html;
    },

    /* ---------- 窗格：大纲 ---------- */
    renderOutline() {
      if (T.s.dockPane !== 'outline') return;
      const body = $('#dock-body');
      if (!body) return;
      const t = T.term.activeTab();
      let html = `<div class="pane-head"><span>输入大纲</span><span>${t ? t.outline.length + ' 条' : '无会话'}</span></div>`;
      if (!t || !t.outline.length) {
        html += '<div class="empty">回车提交的命令会出现在这里，点击可跳到对应行。</div>';
      } else {
        for (const o of t.outline.slice(-80)) html += `<div class="row ol"><span class="ico">${svg('terminal')}</span><span class="col"><b>${escapeHtml(o.text || '(空命令)')}</b><i>#${o.n} · 行 ${o.y}</i></span></div>`;
      }
      body.innerHTML = html;
      body.querySelectorAll('.ol').forEach((row, i) => {
        row.onclick = () => { const o = t.outline.slice(-80)[i]; if (o) t.term.scrollToLine(o.y); };
      });
    },

    /* ---------- 窗格：日志 ---------- */
    renderOutput() {
      if (T.s.dockPane !== 'output') return;
      const body = $('#dock-body');
      if (!body) return;
      let html = `<div class="pane-head"><span>日志</span>
        <span><button id="log-clear" title="清空">清空</button></span></div><div class="list" style="flex:1;overflow:auto">`;
      for (const l of this.logs.slice(-200)) html += `<div class="logrow"><span class="ts">${l.t.toLocaleTimeString('zh-CN', { hour12: false })}</span><span>${escapeHtml(l.msg)}</span></div>`;
      html += '</div>';
      body.innerHTML = html;
      const list = body.querySelector('.list');
      if (list) list.scrollTop = 1e6;
      const c = body.querySelector('#log-clear');
      if (c) c.onclick = () => { this.logs = []; this.renderOutput(); };
    },

    /* ---------- 浮动搜索 ---------- */
    toggleSearch() { const bar = $('#search-float'); if (bar && !bar.hidden) this.closeSearch(); else this.openSearch(); },
    openSearch() {
      this.closeDock();
      const bar = $('#search-float');
      if (!bar) return;
      const palette = $('#palette'); if (palette && !palette.hidden) this.closePalette();
      if (window.Profiles?.isOpen()) Profiles.close();
      bar.hidden = false;
      const inp = $('#search-input');
      inp.value = this.lastQuery;
      this.updateSearchCount();
      inp.focus();
      inp.select();
    },
    closeSearch() {
      const bar = $('#search-float');
      if (bar) bar.hidden = true;
      const t = T.term.activeTab();
      if (t) t.term.focus();
    },
    doSearch(next) {
      const inp = $('#search-input');
      const q = inp ? inp.value : this.lastQuery;
      this.lastQuery = q;
      if (!q) return;
      const found = next ? T.term.searchNext(q) : T.term.searchPrev(q);
      this.updateSearchCount(found);
    },
    updateSearchCount(found) {
      const el = $('#search-count');
      if (!el) return;
      el.textContent = found == null ? '' : (found ? '已定位' : '无匹配');
      el.style.color = found ? '' : 'var(--danger)';
    },

    /* ---------- clipboard ---------- */
    async copy() {
      const t = T.term.activeTab();
      if (!t) return;
      const sel = t.term.getSelection();
      if (!sel) { this.toast('无选中文本', 1600, 'err'); return; }
      try { await navigator.clipboard.writeText(sel); this.toast('已复制 ' + sel.length + ' 字符', 1600, 'ok'); }
      catch (e) { this.toast('复制失败：' + e, 3000, 'err'); }
    },
    async paste() {
      try {
        const txt = await navigator.clipboard.readText();
        const t = T.term.activeTab();
        if (t && txt) {
          if (T.term.isLive && !T.term.isLive(t)) { if (t.exited) T.term.reconnect?.(t); return; }
          await T.invoke('write', { id: T.term.ptyId ? T.term.ptyId(t) : t.id, data: txt });
        }
      } catch (e) { this.toast('粘贴请用 Ctrl+Shift+V（WebKit 剪贴板限制）', 3000, 'err'); }
    },

    /* ---------- mode / sync / view ---------- */
    setMode(m) {
      T.s.mode = m; T.persistSettings(); this.status();
      this.toast('模式：' + (m === 'Local' ? '本地' : '远程'));
      if (T.s.dockVisible) this.renderDock();
    },
    toggleSync() {
      T.s.sync = !T.s.sync; T.persistSettings(); this.status();
      this.toast('同步输入：' + (T.s.sync ? '开' : '关'));
      if (T.s.dockPane === 'sender' && T.s.dockVisible) this.renderSender();
      if (window.Settings && window.Settings.isOpen()) Settings.render();
    },
    toggleStatusBar() {
      T.s.statusBar = T.s.statusBar === false;
      document.body.classList.toggle('no-status', T.s.statusBar === false);
      T.persistSettings();
      this.fitActive(40);
      if (window.Settings && window.Settings.isOpen()) Settings.render();
    },
    cycleTheme() {
      if (window.Settings) { Settings.cycleLightDark(); return; }
      const names = Object.keys(T.term.THEMES);
      const i = names.indexOf(T.s.theme);
      T.term.applyTheme(names[(i + 1) % names.length]);
      this.toast('主题：' + T.s.theme);
    },
    async toggleFullscreen() {
      try {
        const w = await this.win();
        if (!w) { this.toast('当前环境无窗口控制', 2000, 'err'); return; }
        const f = await w.isFullscreen();
        w.setFullscreen(!f);
      } catch (e) { this.toast('全屏不可用：' + e, 3000, 'err'); }
    },

    /* Tabby 入口：机器编辑统一走 profiles.js */
    editProfile(session) {
      this.closeDock();
      if (window.Profiles) { Profiles.edit(session || null); return; }
      this.toast('机器管理模块未加载', 2400, 'err');
    },
    openSettings(section) {
      this.closeDock();
      if (window.Settings) Settings.open(section);
      else this.toast('设置模块未加载', 2400, 'err');
    },

    /* ---------- 命令面板 ---------- */
    paletteEntries() {
      const A = [];
      const add = (group, label, keys, icon, run) => A.push({ group, label, keys, icon, run });
      const S = () => window.Settings;

      add('会话', '新建本地会话', 'Ctrl+T', 'plus', () => T.term.newLocal());
      add('会话', '打开主页', '', 'home', () => T.term.openHome());
      add('会话', '机器管理…', 'Ctrl+M', 'server', () => this.openProfiles());
      add('会话', '添加机器…', '', 'server', () => this.editProfile(null));
      add('会话', '把当前会话另存为机器…', '', 'copy', () => this.editProfile(T.term.activeTab() && T.term.activeTab().session));
      add('会话', '关闭当前会话', 'Ctrl+W', 'x', () => T.term.active && (T.term.closeTab ? T.term.closeTab(T.term.active) : T.term.close(T.term.active)));
      add('会话', '关闭其他会话', '', 'x', () => T.term.active && T.term.closeOthers(T.term.active));
      add('会话', '重命名当前标签', 'F2', 'output', () => window.TabBar && TabBar.renameActive());

      add('窗格', '切换工具窗口', 'Ctrl+B', 'folder', () => this.toggleDock());
      add('窗格', 'AI 助手', '', 'sparkles', () => setTimeout(() => window.AiPanel?.toggle(), 0));
      for (let i = 0; i < PANES.length; i++) {
        const [id, label] = PANES[i];
        add('窗格', '工具窗口：' + label, 'Ctrl+' + (i + 1), 'folder', () => this.setDockPane(id));
      }

      add('分屏', '左右分屏', 'Ctrl+Shift+E', 'splitH', () => T.term.splitActive('right'));
      add('分屏', '上下分屏', 'Ctrl+Shift+D', 'splitV', () => T.term.splitActive('down'));
      add('分屏', '取消分屏', 'Ctrl+Shift+W', 'x', () => T.term.unsplit());
      add('分屏', '聚焦下一个窗格', '', 'terminal', () => T.term.focusNextGroup());

      add('编辑', '复制选中', 'Ctrl+Shift+C', 'copy', () => this.copy());
      add('编辑', '粘贴', 'Ctrl+Shift+V', 'send', () => this.paste());
      add('编辑', '全选', '', 'output', () => { const t = T.term.activeTab(); if (t) t.term.selectAll(); });
      add('编辑', '查找…', 'Ctrl+F', 'search', () => this.openSearch());
      add('编辑', '查找下一个', 'F3', 'search', () => this.doSearch(true));
      add('编辑', '查找上一个', 'Shift+F3', 'search', () => this.doSearch(false));
      add('编辑', '滚动到顶部 / 底部', 'Ctrl+Home', 'up', () => { const t = T.term.activeTab(); if (t) t.term.scrollToTop(); });

      add('视图', '放大字号', 'Ctrl+=', 'zoomIn', () => T.term.zoom(1));
      add('视图', '缩小字号', 'Ctrl+-', 'zoomOut', () => T.term.zoom(-1));
      add('视图', '重置字号', '', 'zoomOut', () => T.term.zoomReset());
      add('视图', '全屏切换', 'F11', 'maximize', () => this.toggleFullscreen());
      add('视图', '深浅色一键切换', '', 'theme', () => this.cycleTheme());
      add('视图', '显示/隐藏状态栏', '', 'output', () => this.toggleStatusBar());
      for (const n of Object.keys(T.term.THEMES)) add('主题', '主题：' + n, '', 'palette', () => T.term.applyTheme(n));

      add('模式', '切到本地模式', '', 'terminal', () => this.setMode('Local'));
      add('模式', '切到远程模式', '', 'globe', () => this.setMode('Remote'));
      add('模式', '切换同步输入（群控）', '', 'transfer', () => this.toggleSync());

      for (const s of SECTIONS_OF_SETTINGS) add('设置', '设置：' + s.label, '', s.icon, () => S() && S().open(s.id));
      add('设置', '命令面板', 'Ctrl+Shift+P', 'search', () => {});

      return A;
    },

    togglePalette() { const pane = $('#palette'); if (pane && !pane.hidden) this.closePalette(); else this.openPalette(); },
    openPalette() {
      this.closeDock();
      const p = $('#palette');
      if (!p) return;
      const search = $('#search-float'); if (search && !search.hidden) this.closeSearch();
      if (window.Profiles?.isOpen()) Profiles.close();
      p.hidden = false;
      p.onclick = (e) => { if (e.target === p) this.closePalette(); };
      const inp = $('#palette-input');
      inp.value = '';
      this._pal = this.paletteEntries();
      this.filterPalette('');
      setTimeout(() => { if (!p.hidden) inp.focus(); }, 0);
    },
    closePalette() {
      const p = $('#palette');
      if (p) p.hidden = true;
      const t = T.term.activeTab();
      if (t) t.term.focus();
    },
    filterPalette(q) {
      const list = $('#palette-list');
      if (!list) return;
      list.textContent = '';
      const ql = (q || '').trim().toLowerCase();
      const items = this._pal.filter((e) => !ql || (e.label + ' ' + e.group).toLowerCase().includes(ql));
      this._palShown = items;
      let lastGroup = null;
      items.forEach((e, i) => {
        if (e.group !== lastGroup) {
          lastGroup = e.group;
          const g = document.createElement('div');
          g.className = 'pg';
          g.textContent = e.group;
          list.appendChild(g);
        }
        const row = document.createElement('div');
        row.className = 'pitem' + (i === 0 ? ' sel' : '');
        row.innerHTML = `<span class="pi">${svg(e.icon)}</span><span class="pl">${escapeHtml(e.label)}</span><span class="key">${escapeHtml(e.keys || '')}</span>`;
        row.onclick = () => { e.run(); this.closePalette(); };
        list.appendChild(row);
      });
      if (!items.length) list.innerHTML = '<div class="empty">没有匹配的命令</div>';
    },
    runPalette() {
      const sel = $('#palette-list .pitem.sel') || $('#palette-list .pitem');
      if (sel) {
        const items = $$('#palette-list .pitem');
        const i = items.indexOf(sel);
        if (this._palShown[i]) this._palShown[i].run();
      }
      this.closePalette();
    },
    paletteMove(d) {
      const items = $$('#palette-list .pitem');
      if (!items.length) return;
      let i = items.findIndex((x) => x.classList.contains('sel'));
      i = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + d));
      items.forEach((x) => x.classList.remove('sel'));
      items[i].classList.add('sel');
      items[i].scrollIntoView({ block: 'nearest' });
    },
  };

  // 设置页分区（与 settings.js 的 SECTIONS 对齐，用于命令面板直达）
  const SECTIONS_OF_SETTINGS = [
    { id: 'appearance', icon: 'palette', label: '外观' },
    { id: 'terminal', icon: 'terminal', label: '终端' },
    { id: 'profiles', icon: 'server', label: '机器与连接' },
    { id: 'triggers', icon: 'bell', label: '触发器' },
    { id: 'hotkeys', icon: 'keyboard', label: '快捷键' },
    { id: 'about', icon: 'info', label: '关于' },
  ];

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  window.UI = UI;
  window.WT.ui = UI;

  /* ---------- 全局快捷键 ---------- */
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const mod = e.ctrlKey || e.metaKey;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');

    if (mod && e.shiftKey && (k === 'P' || k === 'p')) { e.preventDefault(); UI.openPalette(); return; }
    if (mod && e.shiftKey && (k === 'E' || k === 'e')) { e.preventDefault(); T.term.splitActive('right'); return; }
    if (mod && e.shiftKey && (k === 'D' || k === 'd')) { e.preventDefault(); T.term.splitActive('down'); return; }
    if (mod && e.shiftKey && (k === 'W' || k === 'w')) { e.preventDefault(); T.term.unsplit(); return; }
    if (mod && e.shiftKey && (k === 'C' || k === 'c')) { e.preventDefault(); UI.copy(); return; }
    if (mod && e.shiftKey && (k === 'V' || k === 'v')) { e.preventDefault(); UI.paste(); return; }
    if (mod && !e.shiftKey && (k === 't' || k === 'T')) { e.preventDefault(); T.term.newLocal(); return; }
    if (mod && !e.shiftKey && (k === 'w' || k === 'W')) { e.preventDefault(); if (T.term.active) (T.term.closeTab ? T.term.closeTab(T.term.active) : T.term.close(T.term.active)); return; }
    if (mod && !e.shiftKey && (k === 'f' || k === 'F')) { e.preventDefault(); UI.openSearch(); return; }
    if (mod && !e.shiftKey && (k === 'b' || k === 'B')) { e.preventDefault(); UI.toggleDock(); return; }
    if (mod && !e.shiftKey && (k === 'm' || k === 'M')) { e.preventDefault(); UI.openProfiles(); return; }
    if (mod && !e.shiftKey && k === ',') { e.preventDefault(); UI.closeDock(); window.Settings ? Settings.toggle() : null; return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); T.term.zoom(1); return; }
    if (mod && k === '-') { e.preventDefault(); T.term.zoom(-1); return; }
    // Ctrl+1..6 → 侧栏窗格
    if (mod && !e.shiftKey && k >= '1' && k <= '6') {
      e.preventDefault();
      if (k === '2' && window.SftpPanel) { UI.closeDock(); SftpPanel.toggle(); return; }
      const p = PANES[+k - 1];
      if (p) UI.setDockPane(p[0]);
      return;
    }
    if (k === 'F11') { e.preventDefault(); UI.toggleFullscreen(); return; }
    if (k === 'F3') { e.preventDefault(); UI.doSearch(!e.shiftKey); return; }

    const pal = $('#palette');
    const sf = $('#search-float');
    if (pal && !pal.hidden) {
      if (k === 'Escape') { e.preventDefault(); UI.closePalette(); }
      else if (k === 'ArrowDown') { e.preventDefault(); UI.paletteMove(1); }
      else if (k === 'ArrowUp') { e.preventDefault(); UI.paletteMove(-1); }
      else if (k === 'Enter') { e.preventDefault(); UI.runPalette(); }
      return;
    }
    if (sf && !sf.hidden && !inField) {
      if (k === 'Escape') { e.preventDefault(); UI.closeSearch(); }
      return;
    }
    if (k === 'Escape') {
      // 依次收：右键菜单 → 设置页 → 主页
      if (window.TabBar && TabBar.menuOpen()) TabBar.closeMenu();
      else if (window.Settings && Settings.isOpen()) Settings.close();
      else if (!$('#home').hidden && T.term.order.length) Home.hide();
      return;
    }
    if (k === 'F2' && !mod) { e.preventDefault(); if (window.TabBar) TabBar.renameActive(); return; }
  });
})();
