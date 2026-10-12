/* hurricaneTerm — terminal manager: tabs, split groups, themes, search, triggers, zoom, sync input.
 * Original code (MIT). Layout/feature structure mirrors WindTerm. */
(function () {
  const T = window.WT;

  const THEMES = {
    'default': {
      vars: { '--bg': '#17191b', '--bg2': '#232629', '--bg3': '#1d2023', '--fg': '#d5d8dc', '--fg2': '#98a2ad', '--accent': '#3daee9', '--border': '#2b2e31' },
      term: { background: '#17191b', foreground: '#d5d8dc', cursor: '#3daee9', cursorAccent: '#17191b', selectionBackground: '#2c5d7f', black: '#17191b', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d5d8dc', brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' },
    },
    'dige-black': {
      vars: { '--bg': '#000000', '--bg2': '#0d0d0d', '--bg3': '#050505', '--fg': '#c8c8c8', '--fg2': '#8a8a8a', '--accent': '#4fd75b', '--border': '#222222' },
      term: { background: '#000000', foreground: '#c8c8c8', cursor: '#4fd75b', cursorAccent: '#000000', selectionBackground: '#1d4a23', black: '#000000', red: '#ff6b6b', green: '#4fd75b', yellow: '#e3d44a', blue: '#5aa9ff', magenta: '#d47fe8', cyan: '#4fd1c5', white: '#c8c8c8', brightBlack: '#555555', brightRed: '#ff8f8f', brightGreen: '#7dff88', brightYellow: '#fff07a', brightBlue: '#8cc2ff', brightMagenta: '#e8a9ff', brightCyan: '#8ce8e0', brightWhite: '#ffffff' },
    },
    'dige-white': {
      vars: { '--bg': '#f7f7f5', '--bg2': '#ececeb', '--bg3': '#ffffff', '--fg': '#2b2b2b', '--fg2': '#6a6a6a', '--accent': '#1f7fd0', '--border': '#d4d4d2' },
      term: { background: '#f7f7f5', foreground: '#2b2b2b', cursor: '#1f7fd0', cursorAccent: '#f7f7f5', selectionBackground: '#cfe4f7', black: '#2b2b2b', red: '#b3261e', green: '#2e7d32', yellow: '#a57200', blue: '#1f7fd0', magenta: '#8e24aa', cyan: '#00838f', white: '#8a8a8a', brightBlack: '#6a6a6a', brightRed: '#d93025', brightGreen: '#43a047', brightYellow: '#c79a00', brightBlue: '#2196f3', brightMagenta: '#ab47bc', brightCyan: '#00acc1', brightWhite: '#2b2b2b' },
    },
    'dige-black-and-white': {
      vars: { '--bg': '#0b0b0b', '--bg2': '#161616', '--bg3': '#101010', '--fg': '#e8e8e8', '--fg2': '#a0a0a0', '--accent': '#ffffff', '--border': '#303030' },
      term: { background: '#0b0b0b', foreground: '#e8e8e8', cursor: '#ffffff', cursorAccent: '#0b0b0b', selectionBackground: '#3a3a3a', black: '#0b0b0b', red: '#bdbdbd', green: '#dcdcdc', yellow: '#efefef', blue: '#cfcfcf', magenta: '#e0e0e0', cyan: '#d0d0d0', white: '#e8e8e8', brightBlack: '#6f6f6f', brightRed: '#e0e0e0', brightGreen: '#f2f2f2', brightYellow: '#ffffff', brightBlue: '#e6e6e6', brightMagenta: '#f5f5f5', brightCyan: '#ededed', brightWhite: '#ffffff' },
    },
  };

  const Term = {
    THEMES,
    tabs: {},          // id -> tab
    order: [],         // ids in open order
    active: null,      // active id
    group: 0,          // active group (0|1)
    splitDir: null,    // null|'h'|'v'

    groupEl(g) { return document.querySelector(`#groups .group[data-g="${g}"]`); },
    tabbarEl(g) { return this.groupEl(g).querySelector('.tabbar'); },
    hostEl(g) { return this.groupEl(g).querySelector('.term-host'); },

    activeTab() { return this.active ? this.tabs[this.active] : null; },

    async create(session, opts) {
      const g = (opts && opts.group) != null ? opts.group : this.group;
      const wrap = document.createElement('div');
      wrap.className = 'term-wrap';
      this.hostEl(g).appendChild(wrap);

      const term = new Terminal({
        fontFamily: 'JetBrains Mono, "Noto Sans Mono CJK SC", monospace',
        fontSize: T.s.fontSize,
        theme: THEMES[T.s.theme].term,
        scrollback: 10000,
        allowProposedApi: true,
        macOptionIsMeta: false,
      });
      const fit = new FitAddon.FitAddon();
      const search = new SearchAddon.SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
      term.open(wrap);
      fit.fit();

      const proto = ((session && session.protocol) || '').toLowerCase();
      let id;
      try {
        if (proto === 'ssh' && session.host) {
          id = await T.invoke('connect_ssh', {
            rows: term.rows, cols: term.cols,
            host: session.host, port: session.port || null,
            user: session.user || null, password: session.password || null,
          });
        } else if (proto === 'telnet' && session.host) {
          id = await T.invoke('connect_telnet', { host: session.host, port: session.port || 23 });
        } else if (proto === 'serial') {
          // 串口：target=端口名（实证 session.target）；参数运行期不可改，重连生效
          id = await T.invoke('connect_serial', {
            target: session.target || session.host || '',
            baudRate: session.baudRate || null,
            dataBits: session.dataBits || null,
            parity: session.parity || null,
            stopBits: session.stopBits || null,
            flowControl: session.flowControl || null,
          });
        } else if (proto === 'tcp' && (session.host || session.target)) {
          // 裸 TCP：host:port 或 target 串；代理分流走 re/tcp 语义
          id = await T.invoke('connect_tcp', {
            host: session.host || '', port: session.port || null, target: session.target || null,
            proxyType: session.proxyType || null,
            proxyHost: session.proxyHost || null, proxyPort: session.proxyPort || null,
            proxyUser: session.proxyUser || null, proxyPassword: session.proxyPassword || null,
            proxyCommand: session.proxyCommand || null,
          });
        } else {
          id = await T.invoke('spawn', {
            rows: term.rows, cols: term.cols,
            command: session && session.command ? session.command : null,
            args: session ? session.args : null,
          });
        }
      } catch (e) {
        term.dispose(); wrap.remove();
        UI.log('连接失败: ' + (e && e.message ? e.message : String(e)));
        return null;
      }

      const tab = {
        id, title: (session && session.name) || (session && session.host ? session.host : `shell ${this.order.length + 1}`),
        term, fit, search, wrap, group: g, exited: false, outline: [], session: session || null,
      };
      this.tabs[id] = tab;
      this.order.push(id);

      term.onData((data) => {
        if (T.s.sync && T.s.mode === 'Remote') {
          for (const t of Object.values(this.tabs)) T.invoke('write', { id: t.id, data }).catch(() => {});
        } else {
          T.invoke('write', { id, data }).catch(() => {});
        }
        if (data.includes('\r')) {
          tab.outline.push({ n: tab.outline.length + 1, text: '(input)', y: term.buffer.active.baseY + term.buffer.active.cursorY });
          UI.renderOutline();
        }
      });
      term.onResize(({ rows, cols }) => {
        T.invoke('resize', { id, rows, cols }).catch(() => {});
        if (this.active === id) UI.status();
      });
      term.onTitleChange((t) => {
        if (t && t.trim()) { tab.title = t.trim().slice(0, 28); this.renderTabbar(); }
      });
      wrap.addEventListener('mousedown', () => this.activate(id));

      this.orderWrites(id);
      this.activate(id);
      this.renderTabbar();
      UI.log(`会话已创建 ${id.slice(0, 8)} ${session && session.name ? '· ' + session.name : ''}`);
      return tab;
    },

    orderWrites(id) { /* reserved for future output ordering */ },

    activate(id) {
      const t = this.tabs[id];
      if (!t) return;
      this.active = id;
      this.group = t.group;
      this.renderTabbar();
      for (const x of Object.values(this.tabs)) x.wrap.style.display = x.id === id ? 'block' : 'none';
      requestAnimationFrame(() => { try { t.fit.fit(); } catch (e) {} t.term.focus(); UI.status(); UI.renderOutline(); });
    },

    async close(id) {
      const t = this.tabs[id];
      if (!t) return;
      try { await T.invoke('kill', { id }); } catch (e) {}
      t.term.dispose();
      t.wrap.remove();
      delete this.tabs[id];
      this.order = this.order.filter((x) => x !== id);
      if (this.active === id) {
        const inGroup = this.order.filter((x) => this.tabs[x].group === t.group);
        this.active = inGroup.length ? inGroup[inGroup.length - 1] : (this.order.length ? this.order[this.order.length - 1] : null);
      }
      if (!this.order.some((x) => this.tabs[x].group === 1)) this.unsplit(true);
      this.renderTabbar();
      if (this.active) this.activate(this.active);
      UI.status();
    },

    renderTabbar() {
      for (const g of [0, 1]) {
        const bar = this.tabbarEl(g);
        bar.innerHTML = '';
        for (const id of this.order) {
          const t = this.tabs[id];
          if (t.group !== g) continue;
          const el = document.createElement('div');
          el.className = 'tab' + (id === this.active ? ' active' : '') + (t.exited ? ' exited' : '');
          const label = document.createElement('span');
          label.className = 'tab-label';
          label.textContent = t.title;
          const close = document.createElement('span');
          close.className = 'tab-close';
          close.textContent = '×';
          close.onclick = (e) => { e.stopPropagation(); this.close(id); };
          el.append(label, close);
          el.onclick = () => this.activate(id);
          bar.appendChild(el);
        }
        const plus = document.createElement('div');
        plus.className = 'tab-plus';
        plus.textContent = '＋';
        plus.title = '新建本地会话';
        plus.onclick = () => this.create(null, { group: g });
        bar.appendChild(plus);
      }
    },

    async split(dir) {
      this.splitDir = dir;
      const g1 = this.groupEl(1);
      g1.hidden = false;
      document.getElementById('groups').dataset.dir = dir;
      const cur = this.activeTab();
      if (cur && cur.group === 0 && !this.order.some((id) => this.tabs[id].group === 1)) {
        cur.group = 1;
        this.hostEl(1).appendChild(cur.wrap);
        this.group = 1;
      }
      this.active = (this.order.find((id) => this.tabs[id].group === 1)) || this.active;
      this.renderTabbar();
      if (this.active) this.activate(this.active);
      UI.log(`分屏：${dir === 'h' ? '左右' : '上下'}`);
    },

    unsplit(silent) {
      this.splitDir = null;
      document.getElementById('groups').dataset.dir = '';
      for (const id of this.order) {
        const t = this.tabs[id];
        if (t.group === 1) { t.group = 0; this.hostEl(0).appendChild(t.wrap); }
      }
      this.groupEl(1).hidden = true;
      this.group = 0;
      this.renderTabbar();
      if (this.active) this.activate(this.active);
      if (!silent) UI.log('取消分屏');
    },

    zoom(delta) {
      T.s.fontSize = Math.max(8, Math.min(28, T.s.fontSize + delta));
      for (const t of Object.values(this.tabs)) { t.term.options.fontSize = T.s.fontSize; try { t.fit.fit(); } catch (e) {} }
      T.persistSettings();
      UI.status();
    },
    zoomReset() { T.s.fontSize = 13; this.zoom(0); },

    applyTheme(name) {
      if (!THEMES[name]) return;
      T.s.theme = name;
      const v = THEMES[name].vars;
      for (const k in v) document.documentElement.style.setProperty(k, v[k]);
      for (const t of Object.values(this.tabs)) t.term.options.theme = THEMES[name].term;
      T.persistSettings();
      UI.status();
    },

    findByPty(id) { return this.tabs[id]; },

    searchNext(q) { const t = this.activeTab(); if (t) t.search.findNext(q || UI.lastQuery || ''); },
    searchPrev(q) { const t = this.activeTab(); if (t) t.search.findPrevious(q || UI.lastQuery || ''); },

    /* ---- triggers engine (WindTerm TriggerCenter analogue) ---- */
    runTriggers(tab, data) {
      const rules = T.s.triggers.filter((r) => r.enabled !== false);
      if (!rules.length) return;
      for (const r of rules) {
        let re;
        try { re = new RegExp(r.pattern); } catch (e) { continue; }
        if (!re.test(data)) continue;
        if (r.action === 'highlight') {
          try {
            const m = tab.term.registerMarker(0);
            const d = tab.term.registerDecoration({ marker: m, x: 1, width: Math.max(1, tab.term.cols - 2) });
            d.onRender((el) => el.classList.add('wt-hit'));
            setTimeout(() => { try { d.dispose(); } catch (e) {} }, 4000);
          } catch (e) {}
        } else if (r.action === 'bell') {
          UI.beep();
        } else if (r.action === 'send') {
          T.invoke('write', { id: tab.id, data: (r.arg || '') + '\r' }).catch(() => {});
        }
        UI.log(`触发器「${r.name || r.pattern}」命中`);
      }
    },

    broadcast(text, toAll) {
      const targets = toAll ? Object.values(this.tabs) : [this.activeTab()].filter(Boolean);
      for (const t of targets) T.invoke('write', { id: t.id, data: text }).catch(() => {});
      UI.log(`发送${toAll ? '（全部 ' + targets.length + ' 个）' : ''}：${text.length} 字节`);
    },

    statusInfo() {
      const t = this.activeTab();
      if (!t) return { cols: 0, rows: 0 };
      return { cols: t.term.cols, rows: t.term.rows };
    },
  };

  T.term = Term;
})();