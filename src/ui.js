/* WT — UI shell: menubar, toolbar, dock panes, statusbar, command palette, dialogs.
 * Structure mirrors WindTerm's main window (Explorer/Filer/Outline/Sender/Transfer/Output
 * panes, Local/Remote mode indicator, theme list, trigger center). Original code (MIT). */
(function () {
  const T = window.WT;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const UI = {
    lastQuery: '',
    logs: [],
    _toastTimer: null,

    /* ---------- basic ---------- */
    log(msg) {
      this.logs.push({ t: new Date(), msg });
      if (this.logs.length > 300) this.logs.shift();
      this.renderOutput();
    },
    toast(msg, ms) {
      const el = $('#toast');
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { el.hidden = true; }, ms || 2200);
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
      const info = T.term.statusInfo();
      $('#st-mode').textContent = T.s.mode === 'Local' ? '本地模式' : '远程模式';
      $('#st-mode').classList.toggle('on', T.s.mode === 'Local');
      $('#st-sync').textContent = '同步输入：' + (T.s.sync ? '开' : '关');
      $('#st-sync').classList.toggle('on', !!T.s.sync);
      $('#st-size').textContent = `${info.cols} × ${info.rows}`;
      $('#st-theme').textContent = '主题：' + T.s.theme;
      $('#st-zoom').textContent = T.s.fontSize + ' px';
      $('#st-enc').textContent = 'UTF-8';
      $('#st-eol').textContent = 'LF';
    },
    clock() { $('#st-clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); },

    /* ---------- menubar ---------- */
    buildMenu() {
      const menus = [
        ['会话 Session', [
          ['新建会话', 'Ctrl+T', () => T.term.create(null)],
          ['保存会话…', '', () => this.openSessionDialog()],
          ['打开配置目录…', '', () => this.toast('配置目录：~/.config/cn.rea.wtp0')],
          ['关闭会话', 'Ctrl+W', () => T.term.active && T.term.close(T.term.active)],
          ['—', ''],
          ['退出', '', () => T.invoke('plugin:window|close').catch(() => window.close())],
        ]],
        ['编辑 Edit', [
          ['复制', 'Ctrl+Shift+C', () => this.copy()],
          ['粘贴', 'Ctrl+Shift+V', () => this.paste()],
          ['全选', '', () => T.term.activeTab() && T.term.activeTab().term.selectAll()],
          ['查找…', 'Ctrl+F', () => this.openSearch()],
        ]],
        ['查找 Search', [
          ['查找下一个', 'F3', () => T.term.searchNext(this.lastQuery)],
          ['查找上一个', 'Shift+F3', () => T.term.searchPrev(this.lastQuery)],
          ['关闭查找栏', 'Esc', () => this.closeSearch()],
        ]],
        ['选择 Selection', [
          ['全选', '', () => T.term.activeTab() && T.term.activeTab().term.selectAll()],
          ['复制选中', '', () => this.copy()],
          ['清空选择', '', () => T.term.activeTab() && T.term.activeTab().term.clearSelection()],
        ]],
        ['跳转 Goto', [
          ['滚动到顶部', 'Ctrl+Home', () => T.term.activeTab() && T.term.activeTab().term.scrollToTop()],
          ['滚动到底部', 'Ctrl+End', () => T.term.activeTab() && T.term.activeTab().term.scrollToBottom()],
          ['聚焦终端', '', () => T.term.activeTab() && T.term.activeTab().term.focus()],
        ]],
        ['视图 View', [
          ['放大', 'Ctrl+=', () => T.term.zoom(1)],
          ['缩小', 'Ctrl+-', () => T.term.zoom(-1)],
          ['重置缩放', '', () => T.term.zoomReset()],
          ['—', ''],
          ['主题 ▸', Object.keys(T.term.THEMES).map((n) => [n, n === T.s.theme ? '●' : '', () => T.term.applyTheme(n)])],
          ['—', ''],
          ['显示/隐藏 Dock', 'Ctrl+B', () => this.toggleDock()],
          ['全屏', 'F11', () => this.toggleFullscreen()],
        ]],
        ['模式 Mode', [
          ['本地模式', T.s.mode === 'Local' ? '●' : '', () => this.setMode('Local')],
          ['远程模式', T.s.mode === 'Remote' ? '●' : '', () => this.setMode('Remote')],
          ['—', ''],
          ['同步输入', T.s.sync ? '●' : '', () => this.toggleSync()],
        ]],
        ['工具 Tool', [
          ['命令面板…', 'Ctrl+Shift+P', () => this.openPalette()],
          ['触发器…', '', () => this.openTriggers()],
          ['发送文本（Sender）', '', () => this.setDockPane('sender')],
          ['文件浏览器（Filer）', '', () => this.setDockPane('filer')],
        ]],
        ['窗口 Window', [
          ['左右分屏', '', () => T.term.split('h')],
          ['上下分屏', '', () => T.term.split('v')],
          ['取消分屏', '', () => T.term.unsplit()],
          ['—', ''],
          ['最小化', '', () => this.win().then((w) => w.minimize())],
          ['最大化/还原', '', () => this.win().then((w) => w.toggleMaximize())],
        ]],
        ['帮助 Help', [
          ['关于 hurricaneTerm', '', () => this.openDlg('#dlg-about')],
          ['分析报告 REPORT.md', '', () => this.toast('workspace-rea/windterm-analysis/REPORT.md')],
          ['许可说明', '', () => this.toast('原创代码 Apache-2.0；不含 WindTerm 专有文件')],
        ]],
      ];

      const bar = $('#menubar');
      bar.innerHTML = '';
      for (const [label, items] of menus) {
        const b = document.createElement('div');
        b.className = 'menu';
        b.textContent = label;
        const dd = document.createElement('div');
        dd.className = 'dropdown';
        for (const it of items) {
          if (it[0] === '—') { dd.appendChild(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
          if (Array.isArray(it[1])) {
            const sub = document.createElement('div');
            sub.className = 'submenu';
            const head = document.createElement('div');
            head.className = 'item sub';
            head.textContent = it[0];
            const body = document.createElement('div');
            body.className = 'subbody';
            for (const [sl, mark, run] of it[1]) {
              const si = document.createElement('div');
              si.className = 'item';
              si.innerHTML = `<span>${sl}</span><span class="key">${mark || ''}</span>`;
              si.onclick = (e) => { e.stopPropagation(); run(); this.closeMenus(); };
              body.appendChild(si);
            }
            sub.append(head, body);
            dd.appendChild(sub);
            continue;
          }
          const el = document.createElement('div');
          el.className = 'item';
          el.innerHTML = `<span>${it[0]}</span><span class="key">${it[1] || ''}</span>`;
          el.onclick = (e) => { e.stopPropagation(); it[2](); this.closeMenus(); };
          dd.appendChild(el);
        }
        b.appendChild(dd);
        b.onclick = (e) => {
          e.stopPropagation();
          const open = b.classList.contains('open');
          this.closeMenus();
          if (!open) b.classList.add('open');
        };
        bar.appendChild(b);
      }
      document.addEventListener('click', () => this.closeMenus());
    },
    closeMenus() { $$('#menubar .menu').forEach((m) => m.classList.remove('open')); },

    /* ---------- toolbar ---------- */
    buildToolbar() {
      const btns = [
        ['＋', '新建会话 (Ctrl+T)', () => T.term.create(null)],
        ['💾', '保存会话', () => this.openSessionDialog()],
        ['⧉', '复制', () => this.copy()],
        ['⇩', '粘贴', () => this.paste()],
        ['▥', '左右分屏', () => T.term.split('h')],
        ['▤', '上下分屏', () => T.term.split('v')],
        ['🔍', '查找 (Ctrl+F)', () => this.openSearch()],
        ['🎨', '切换主题', () => this.cycleTheme()],
        ['⚡', '触发器', () => this.openTriggers()],
        ['⌘', '命令面板 (Ctrl+Shift+P)', () => this.openPalette()],
      ];
      const bar = $('#toolbar');
      bar.innerHTML = '';
      for (const [txt, title, run] of btns) {
        const b = document.createElement('button');
        b.textContent = txt; b.title = title; b.onclick = run;
        bar.appendChild(b);
      }
      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      const title = document.createElement('div');
      title.className = 'app-title';
      title.textContent = 'hurricaneTerm · Tauri 重构';
      bar.append(spacer, title);
    },
    cycleTheme() {
      const names = Object.keys(T.term.THEMES);
      const i = names.indexOf(T.s.theme);
      T.term.applyTheme(names[(i + 1) % names.length]);
      this.toast('主题：' + T.s.theme);
    },
    win() { return Promise.resolve(window.__TAURI__.window.getCurrentWindow()); },

    /* ---------- dock ---------- */
    buildDock() {
      const panes = [
        ['explorer', '资源管理器'],
        ['filer', '文件浏览器'],
        ['outline', '大纲'],
        ['sender', '发送'],
        ['transfer', '传输'],
        ['output', '输出'],
      ];
      const tabs = $('#dock-tabs');
      tabs.innerHTML = '';
      for (const [id, label] of panes) {
        const b = document.createElement('div');
        b.className = 'dock-tab' + (id === T.s.dockPane ? ' active' : '');
        b.textContent = label;
        b.dataset.id = id;
        b.onclick = () => this.setDockPane(id);
        tabs.appendChild(b);
      }
      this.renderDock();
      // resizer
      const rz = $('#dock-resizer');
      let dragging = false;
      rz.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.classList.add('dragging'); });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const w = Math.max(180, Math.min(560, e.clientX - 8));
        document.documentElement.style.setProperty('--dock-w', w + 'px');
      });
      window.addEventListener('mouseup', () => { dragging = false; document.body.classList.remove('dragging'); const t = T.term.activeTab(); if (t) { try { t.fit.fit(); } catch (e) {} } });
    },
    setDockPane(id) {
      T.s.dockPane = id;
      T.s.dockVisible = true;
      this.renderDock();
      T.persistSettings();
    },
    toggleDock() {
      T.s.dockVisible = !T.s.dockVisible;
      document.getElementById('dock').hidden = !T.s.dockVisible;
      $('#dock-resizer').hidden = !T.s.dockVisible;
      T.persistSettings();
      const t = T.term.activeTab(); if (t) setTimeout(() => { try { t.fit.fit(); } catch (e) {} }, 30);
    },
    renderDock() {
      $$('#dock-tabs .dock-tab').forEach((b) => b.classList.toggle('active', b.dataset.id === T.s.dockPane));
      if (T.s.dockPane === 'explorer') this.renderExplorer();
      else if (T.s.dockPane === 'filer') this.renderFiler();
      else if (T.s.dockPane === 'outline') this.renderOutline();
      else if (T.s.dockPane === 'sender') this.renderSender();
      else if (T.s.dockPane === 'transfer') this.renderTransfer();
      else this.renderOutput();
    },

    /* ---------- panes ---------- */
    renderExplorer() {
      const body = $('#dock-body');
      const groups = {};
      for (const s of T.s.sessions) (groups[s.folder || '（未分组）'] ||= []).push(s);
      let html = `<div class="pane-head"><span>会话</span>
        <span><button id="sess-add">＋ 保存当前</button><button id="sess-refresh">⟳</button></span></div>`;
      for (const g of Object.keys(groups).sort()) {
        html += `<div class="grp">▸ ${g}</div>`;
        for (let i = 0; i < groups[g].length; i++) {
          const s = groups[g][i];
          const sub = s.command || (s.host ? `${s.user || ''}@${s.host}` : '默认 shell');
          html += `<div class="row sess" data-name="${encodeURIComponent(s.name)}"><span class="ico">▣</span>
            <span class="col"><b>${escapeHtml(s.name)}</b><i>${escapeHtml(sub)}</i></span>
            <span class="x" data-del="${encodeURIComponent(s.name)}">×</span></div>`;
        }
      }
      if (!T.s.sessions.length) html += '<div class="empty">尚无保存的会话。点「＋ 保存当前」把当前 shell 存成会话；SSH 字段（host/port/user）已预留，P1 接线。</div>';
      html += `<div class="pane-foot">双击行打开 · SSH 支持属 P1</div>`;
      body.innerHTML = html;
      body.querySelector('#sess-add').onclick = () => this.openSessionDialog();
      body.querySelector('#sess-refresh').onclick = () => this.renderExplorer();
      body.querySelectorAll('.sess').forEach((row) => {
        row.onclick = (e) => {
          if (e.target.dataset.del) return;
          const name = decodeURIComponent(row.dataset.name);
          const s = T.s.sessions.find((x) => x.name === name);
          if (s) T.term.create(s);
        };
        row.ondblclick = row.onclick;
      });
      body.querySelectorAll('[data-del]').forEach((x) => {
        x.onclick = async (e) => {
          e.stopPropagation();
          const name = decodeURIComponent(x.dataset.del);
          T.s.sessions = T.s.sessions.filter((s) => s.name !== name);
          await T.persistSessions();
          this.renderExplorer();
          this.toast('已删除会话：' + name);
        };
      });
    },

    async renderFiler() {
      const body = $('#dock-body');
      const path = T.s.filerPath || null;
      body.innerHTML = `<div class="pane-head"><span id="filer-path">${escapeHtml(path || '~')}</span>
        <span><button id="f-up">↑</button><button id="f-home">🏠</button><button id="f-refresh">⟳</button><button id="f-cd">在终端 cd</button></span></div>
        <div id="f-list" class="list"></div>`;
      let entries = [];
      try {
        entries = await T.invoke('fs_list', { path });
      } catch (e) {
        body.querySelector('#f-list').innerHTML = `<div class="empty">读取失败：${escapeHtml(String(e))}</div>`;
        return;
      }
      const list = body.querySelector('#f-list');
      for (const e of entries) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = `<span class="ico">${e.is_dir ? '📁' : '📄'}</span>
          <span class="col"><b>${escapeHtml(e.name)}</b><i>${e.is_dir ? '目录' : fmtSize(e.size)} · ${e.modified ? new Date(e.modified * 1000).toLocaleDateString('zh-CN') : ''}</i></span>`;
        row.ondblclick = () => { if (e.is_dir) { T.s.filerPath = e.path; this.renderFiler(); } };
        row.onclick = () => { this._filerSel = e.path; $$('#f-list .row').forEach((r) => r.classList.remove('sel')); row.classList.add('sel'); };
        list.appendChild(row);
      }
      if (!entries.length) list.innerHTML = '<div class="empty">空目录</div>';
      const curPath = T.s.filerPath || '';
      body.querySelector('#f-up').onclick = () => { if (curPath) { T.s.filerPath = curPath.replace(/\/+[^/]+\/?$/, '') || '/'; this.renderFiler(); } };
      body.querySelector('#f-home').onclick = () => { T.s.filerPath = null; this.renderFiler(); };
      body.querySelector('#f-refresh').onclick = () => this.renderFiler();
      body.querySelector('#f-cd').onclick = () => {
        const p = this._filerSel || T.s.filerPath;
        if (!p) { this.toast('先选一个目录/文件'); return; }
        const dir = this._filerSel && !this._filerSel.endsWith('/') && T.s.filerPath && !this._isDirSel ? T.s.filerPath : p;
        this.senderSet(`cd '${dir}'\r`, true);
      };
    },
    senderSet(text, direct) {
      const ta = $('#dock-body textarea');
      if (ta) { ta.value = text.replace(/\r$/, ''); ta.focus(); }
      else this.toast('切到「发送」窗格后可见待发文本');
      if (direct) { T.term.broadcast(text, false); }
    },

    renderOutline() {
      if (T.s.dockPane !== 'outline') return;
      const body = $('#dock-body');
      const t = T.term.activeTab();
      let html = `<div class="pane-head"><span>输入大纲</span><span>${t ? t.outline.length + ' 条' : '无会话'}</span></div>`;
      if (!t || !t.outline.length) {
        html += '<div class="empty">回车提交的命令会出现在这里（点击跳转）。完整输出结构大纲属 P2。</div>';
      } else {
        for (const o of t.outline.slice(-80)) html += `<div class="row"><span class="ico">¶</span><span class="col"><b>#${o.n}</b><i>行 ${o.y}</i></span></div>`;
      }
      body.innerHTML = html;
      body.querySelectorAll('.row').forEach((row, i) => {
        row.onclick = () => { const o = t.outline.slice(-80)[i]; if (o) t.term.scrollToLine(o.y); };
      });
    },

    renderSender() {
      const body = $('#dock-body');
      body.innerHTML = `<div class="pane-head"><span>发送文本</span><span>WindTerm SenderPane / 同步输入</span></div>
        <div class="sender">
          <textarea id="send-text" placeholder="输入要发送到终端的文本（Ctrl+Enter 发送）"></textarea>
          <div class="sender-btns">
            <button id="send-cur">发送到当前</button>
            <button id="send-all">发送到全部</button>
            <label><input type="checkbox" id="send-sync" ${T.s.sync ? 'checked' : ''}> 键盘同步输入</label>
          </div>
        </div>`;
      const ta = body.querySelector('#send-text');
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); T.term.broadcast(ta.value + '\r', false); } });
      body.querySelector('#send-cur').onclick = () => T.term.broadcast(ta.value + '\r', false);
      body.querySelector('#send-all').onclick = () => T.term.broadcast(ta.value + '\r', true);
      body.querySelector('#send-sync').onchange = (e) => { T.s.sync = e.target.checked; T.persistSettings(); this.status(); };
    },

    renderTransfer() {
      $('#dock-body').innerHTML = `<div class="pane-head"><span>传输</span><span>P1</span></div>
        <div class="empty">传输队列（SFTP / ZMODEM）在 P1 实现。<br>
        骨架已就位：后端 <code>TransferTask</code> ⇄ 前端此窗格。<br>
        本轮支持：Filer 本地浏览 + 在终端 cd。</div>`;
    },

    renderOutput() {
      if (T.s.dockPane !== 'output') return;
      const body = $('#dock-body');
      let html = `<div class="pane-head"><span>输出</span><span>${this.logs.length} 条</span></div><div class="list">`;
      for (const l of this.logs.slice(-200)) html += `<div class="logrow"><span class="ts">${l.t.toLocaleTimeString('zh-CN', { hour12: false })}</span><span>${escapeHtml(l.msg)}</span></div>`;
      html += '</div>';
      body.innerHTML = html;
      body.querySelector('.list').scrollTop = 1e6;
    },

    /* ---------- search ---------- */
    openSearch() {
      $('#searchbar').hidden = false;
      const inp = $('#search-input');
      inp.value = this.lastQuery; inp.focus();
    },
    closeSearch() { $('#searchbar').hidden = true; const t = T.term.activeTab(); if (t) t.term.focus(); },
    doSearch(next) {
      const q = $('#search-input').value;
      this.lastQuery = q;
      if (next) T.term.searchNext(q); else T.term.searchPrev(q);
    },

    /* ---------- clipboard ---------- */
    async copy() {
      const t = T.term.activeTab();
      if (!t) return;
      const sel = t.term.getSelection();
      if (!sel) { this.toast('无选中文本'); return; }
      try { await navigator.clipboard.writeText(sel); this.toast('已复制 ' + sel.length + ' 字符'); }
      catch (e) { this.toast('复制失败：' + e); }
    },
    async paste() {
      try {
        const txt = await navigator.clipboard.readText();
        const t = T.term.activeTab();
        if (t && txt) T.invoke('write', { id: t.id, data: txt });
      } catch (e) { this.toast('粘贴需要手动 Ctrl+Shift+V（WebKit 剪贴板限制）'); }
    },

    /* ---------- mode / sync ---------- */
    setMode(m) { T.s.mode = m; T.persistSettings(); this.status(); this.toast('模式：' + (m === 'Local' ? '本地' : '远程')); },
    toggleSync() { T.s.sync = !T.s.sync; T.persistSettings(); this.status(); this.toast('同步输入：' + (T.s.sync ? '开' : '关')); if (T.s.dockPane === 'sender') this.renderSender(); },
    async toggleFullscreen() {
      try { const w = await this.win(); const f = await w.isFullscreen(); w.setFullscreen(!f); } catch (e) { this.toast('全屏不可用：' + e); }
    },

    /* ---------- dialogs ---------- */
    openDlg(sel) { const d = $(sel); if (d.showModal) d.showModal(); else d.hidden = false; },
    closeDlg(sel) { const d = $(sel); if (d.close) d.close(); else d.hidden = true; },

    openSessionDialog() {
      const d = $('#dlg-session');
      d.querySelectorAll('input').forEach((i) => { if (i.id === 'sf-command') i.value = ''; else i.value = ''; });
      this.openDlg('#dlg-session');
    },
    async saveSessionFromDialog() {
      const v = (id) => ($('#' + id).value || '').trim();
      const name = v('sf-name') || 'session-' + (T.s.sessions.length + 1);
      const s = { name, folder: v('sf-folder'), command: v('sf-command'), args: v('sf-args') ? v('sf-args').split(/\s+/) : [], host: v('sf-host'), port: parseInt(v('sf-port') || '0', 10) || 0, user: v('sf-user'), protocol: v('sf-proto'), password: v('sf-password') };
      T.s.sessions = T.s.sessions.filter((x) => x.name !== name).concat([s]);
      await T.persistSessions();
      this.closeDlg('#dlg-session');
      this.setDockPane('explorer');
      this.toast('已保存会话：' + name + '（SSH 字段 P1 生效）');
    },

    openTriggers() { this.renderTriggers(); this.openDlg('#dlg-triggers'); },
    renderTriggers() {
      const box = $('#trigger-list');
      box.innerHTML = T.s.triggers.length ? '' : '<div class="empty">还没有触发器。WindTerm 的 TriggerCenter 用正则匹配输出 → 动作；这里是同构的 v0。</div>';
      T.s.triggers.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'trow';
        row.innerHTML = `<label><input type="checkbox" ${r.enabled !== false ? 'checked' : ''}></label>
          <b>${escapeHtml(r.name || r.pattern)}</b>
          <code>/${escapeHtml(r.pattern)}/</code>
          <span class="act">${r.action}${r.arg ? ' → ' + escapeHtml(r.arg) : ''}</span>
          <span class="x">×</span>`;
        row.querySelector('input').onchange = (e) => { r.enabled = e.target.checked; T.persistSettings(); };
        row.querySelector('.x').onclick = () => { T.s.triggers.splice(i, 1); T.persistSettings(); this.renderTriggers(); };
        box.appendChild(row);
      });
    },
    addTrigger() {
      const name = $('#tr-name').value.trim();
      const pattern = $('#tr-pattern').value.trim();
      const action = $('#tr-action').value;
      const arg = $('#tr-arg').value;
      if (!pattern) { this.toast('正则不能为空'); return; }
      try { new RegExp(pattern); } catch (e) { this.toast('正则无效：' + e); return; }
      T.s.triggers.push({ name, pattern, action, arg, enabled: true });
      T.persistSettings();
      $('#tr-name').value = ''; $('#tr-pattern').value = ''; $('#tr-arg').value = '';
      this.renderTriggers();
    },

    /* ---------- command palette ---------- */
    paletteEntries() {
      const A = [];
      const add = (label, keys, run) => A.push({ label, keys, run });
      add('新建会话', 'Ctrl+T', () => T.term.create(null));
      add('关闭当前会话', 'Ctrl+W', () => T.term.active && T.term.close(T.term.active));
      add('保存会话…', '', () => this.openSessionDialog());
      add('左右分屏', '', () => T.term.split('h'));
      add('上下分屏', '', () => T.term.split('v'));
      add('取消分屏', '', () => T.term.unsplit());
      add('查找…', 'Ctrl+F', () => this.openSearch());
      add('放大字号', 'Ctrl+=', () => T.term.zoom(1));
      add('缩小字号', 'Ctrl+-', () => T.term.zoom(-1));
      add('重置字号', '', () => T.term.zoomReset());
      add('切换显示 Dock', 'Ctrl+B', () => this.toggleDock());
      add('全屏切换', 'F11', () => this.toggleFullscreen());
      add('切换本地/远程模式', '', () => this.setMode(T.s.mode === 'Local' ? 'Remote' : 'Local'));
      add('切换同步输入', '', () => this.toggleSync());
      add('触发器…', '', () => this.openTriggers());
      add('复制', 'Ctrl+Shift+C', () => this.copy());
      add('粘贴', 'Ctrl+Shift+V', () => this.paste());
      for (const n of Object.keys(T.term.THEMES)) add('主题：' + n, '', () => T.term.applyTheme(n));
      for (const [id, label] of [['explorer', '资源管理器'], ['filer', '文件浏览器'], ['outline', '大纲'], ['sender', '发送'], ['transfer', '传输'], ['output', '输出']])
        add('窗格：' + label, '', () => this.setDockPane(id));
      return A;
    },
    openPalette() {
      const p = $('#palette');
      p.hidden = false;
      p.onclick = (e) => { if (e.target === p) this.closePalette(); };  // 点遮罩关闭
      const inp = $('#palette-input');
      inp.value = ''; inp.focus();
      this._pal = this.paletteEntries();
      this.filterPalette('');
    },
    closePalette() { $('#palette').hidden = true; const t = T.term.activeTab(); if (t) t.term.focus(); },
    filterPalette(q) {
      const list = $('#palette-list');
      list.innerHTML = '';
      const items = this._pal.filter((e) => !q || e.label.toLowerCase().includes(q.toLowerCase()));
      this._palShown = items;
      items.forEach((e, i) => {
        const row = document.createElement('div');
        row.className = 'pitem' + (i === 0 ? ' sel' : '');
        row.innerHTML = `<span>${escapeHtml(e.label)}</span><span class="key">${e.keys || ''}</span>`;
        row.onclick = () => { e.run(); this.closePalette(); };
        list.appendChild(row);
      });
    },
    runPalette() {
      const sel = $('#palette-list .sel') || $('#palette-list .pitem');
      if (sel) { const i = Array.from($('#palette-list').children).indexOf(sel); this._palShown[i] && this._palShown[i].run(); }
      this.closePalette();
    },
    paletteMove(d) {
      const items = $$('#palette-list .pitem');
      if (!items.length) return;
      let i = items.findIndex((x) => x.classList.contains('sel'));
      i = Math.max(0, Math.min(items.length - 1, i + d));
      items.forEach((x) => x.classList.remove('sel'));
      items[i].classList.add('sel');
      items[i].scrollIntoView({ block: 'nearest' });
    },
  };

  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; }

  window.UI = UI;
  window.WT.ui = UI;

  /* ---------- keyboard shortcuts ---------- */
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey && (k === 'P' || k === 'p')) { e.preventDefault(); UI.openPalette(); return; }
    if (ctrl && !e.shiftKey && (k === 't' || k === 'T')) { e.preventDefault(); T.term.create(null); return; }
    if (ctrl && !e.shiftKey && (k === 'w' || k === 'W')) { e.preventDefault(); if (T.term.active) T.term.close(T.term.active); return; }
    if (ctrl && !e.shiftKey && (k === 'f' || k === 'F')) { e.preventDefault(); UI.openSearch(); return; }
    if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); T.term.zoom(1); return; }
    if (ctrl && k === '-') { e.preventDefault(); T.term.zoom(-1); return; }
    if (ctrl && (k === 'b' || k === 'B')) { e.preventDefault(); UI.toggleDock(); return; }
    if (ctrl && e.shiftKey && (k === 'C' || k === 'c')) { e.preventDefault(); UI.copy(); return; }
    if (ctrl && e.shiftKey && (k === 'V' || k === 'v')) { e.preventDefault(); UI.paste(); return; }
    if (k === 'F11') { e.preventDefault(); UI.toggleFullscreen(); return; }
    if (k === 'F3') { e.preventDefault(); UI.doSearch(!e.shiftKey); return; }
    if (!$('#palette').hidden) {
      if (k === 'Escape') { e.preventDefault(); UI.closePalette(); }
      else if (k === 'ArrowDown') { e.preventDefault(); UI.paletteMove(1); }
      else if (k === 'ArrowUp') { e.preventDefault(); UI.paletteMove(-1); }
      else if (k === 'Enter') { e.preventDefault(); UI.runPalette(); }
    } else if (!$('#searchbar').hidden && k === 'Enter') { e.preventDefault(); UI.doSearch(!e.shiftKey); }
    else if (!$('#searchbar').hidden && k === 'Escape') { e.preventDefault(); UI.closeSearch(); }
    else if (k === 'Escape' && !$('#dlg-triggers').hidden) UI.closeDlg('#dlg-triggers');
  });
})();