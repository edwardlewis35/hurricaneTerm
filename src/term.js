/* hurricaneTerm — terminal manager: tabs, split groups, themes, search, triggers, zoom, sync input.
 * Original code (MIT). Layout/feature structure mirrors WindTerm. */
(function () {
  const T = window.WT;

  /* ---------- 主题 ----------
   * tabby-dark / tabby-light 的终端 16 色取自 Tabby 上游
   * tabby-terminal/src/colorSchemes.ts（"Tabby Default" / "Tabby Default Light"）；
   * 界面令牌取自 tabby-core/src/theme.vars.scss。其余 4 套为 WindTerm 自带主题。
   * --term-bg 让「活动标签 + 主区」与终端底色无缝衔接（Tabby 的连体观感）。
   */
  function chrome(c) {
    const v = {
      '--bg': c.bg, '--bg2': c.bg2, '--bg3': c.bg3, '--bg4': c.bg4,
      '--fg': c.fg, '--fg2': c.fg2, '--fg3': c.fg3,
      '--accent': c.accent, '--accent-bg': c.accentBg, '--accent-soft': c.accentSoft,
      '--border': c.border, '--border-solid': c.borderSolid,
      '--input-bg': c.inputBg, '--surface': c.surface, '--surface-hover': c.surfaceHover,
      '--danger': c.danger, '--warn': c.warn, '--ok': c.ok,
      '--term-bg': c.termBg,
      '--color-scheme': c.scheme || 'dark',
    };
    return v;
  }

  const CHROME_DARK = {
    bg: '#131d27', bg2: '#1d272d', bg3: '#0e151d', bg4: '#20333e',
    fg: '#cccccc', fg2: 'rgba(255,255,255,.5)', fg3: '#ced9e2',
    accent: '#3ecf8e', accentBg: 'rgba(62,207,142,.16)', accentSoft: 'rgba(62,207,142,.32)',
    border: 'rgba(255,255,255,.1)', borderSolid: '#24313c',
    inputBg: '#181e23', surface: 'rgba(255,255,255,.025)', surfaceHover: 'rgba(255,255,255,.05)',
    danger: '#d9534f', warn: '#f0ad4e', ok: '#5cb85c',
  };
  const CHROME_LIGHT = {
    scheme: 'light',
    bg: '#f2f3f5', bg2: '#ffffff', bg3: '#e6e8eb', bg4: '#dfe2e6',
    fg: '#2b2b2b', fg2: 'rgba(0,0,0,.5)', fg3: '#1f2328',
    accent: '#0e9f6e', accentBg: 'rgba(14,159,110,.14)', accentSoft: 'rgba(14,159,110,.3)',
    border: 'rgba(0,0,0,.1)', borderSolid: '#d6d9dd',
    inputBg: '#ffffff', surface: 'rgba(0,0,0,.03)', surfaceHover: 'rgba(0,0,0,.06)',
    danger: '#c82829', warn: '#b58900', ok: '#718c00',
  };

  // Tabby Default（终端）
  const TABBY_DARK_TERM = {
    background: '#171717', foreground: '#cacaca', cursor: '#bbbbbb', cursorAccent: '#171717',
    selectionBackground: 'rgba(62,207,142,.26)',
    black: '#000000', red: '#ff615a', green: '#b1e969', yellow: '#ebd99c', blue: '#5da9f6',
    magenta: '#e86aff', cyan: '#82fff7', white: '#dedacf',
    brightBlack: '#313131', brightRed: '#f58c80', brightGreen: '#ddf88f', brightYellow: '#eee5b2',
    brightBlue: '#a5c7ff', brightMagenta: '#ddaaff', brightCyan: '#b7fff9', brightWhite: '#ffffff',
  };
  // Tabby Default Light（终端）
  const TABBY_LIGHT_TERM = {
    background: '#ffffff', foreground: '#4d4d4c', cursor: '#4d4d4c', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(14,159,110,.18)',
    black: '#000000', red: '#c82829', green: '#718c00', yellow: '#eab700', blue: '#4271ae',
    magenta: '#8959a8', cyan: '#3e999f', white: '#ffffff',
    brightBlack: '#000000', brightRed: '#c82829', brightGreen: '#718c00', brightYellow: '#eab700',
    brightBlue: '#4271ae', brightMagenta: '#8959a8', brightCyan: '#3e999f', brightWhite: '#ffffff',
  };

  const THEMES = {
    'tabby-dark': {
      vars: chrome(Object.assign({}, CHROME_DARK, { termBg: TABBY_DARK_TERM.background })),
      term: TABBY_DARK_TERM,
    },
    'tabby-light': {
      vars: chrome(Object.assign({}, CHROME_LIGHT, { termBg: TABBY_LIGHT_TERM.background })),
      term: TABBY_LIGHT_TERM,
    },
    'default': {
      vars: chrome({
        bg: '#17191b', bg2: '#232629', bg3: '#121416', bg4: '#2c3034',
        fg: '#d5d8dc', fg2: 'rgba(255,255,255,.48)', fg3: '#e8eaed',
        accent: '#3daee9', accentBg: 'rgba(61,174,233,.18)',
        border: 'rgba(255,255,255,.09)', borderSolid: '#2b2e31',
        inputBg: '#1d2023', surface: 'rgba(255,255,255,.03)', surfaceHover: 'rgba(255,255,255,.06)',
        danger: '#e06c75', warn: '#e5c07b', ok: '#98c379', termBg: '#17191b',
      }),
      term: { background: '#17191b', foreground: '#d5d8dc', cursor: '#3daee9', cursorAccent: '#17191b', selectionBackground: '#2c5d7f', black: '#17191b', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d5d8dc', brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' },
    },
    'dige-black': {
      vars: chrome({
        bg: '#000000', bg2: '#0d0d0d', bg3: '#000000', bg4: '#1a1a1a',
        fg: '#c8c8c8', fg2: 'rgba(255,255,255,.42)', fg3: '#e4e4e4',
        accent: '#4fd75b', accentBg: 'rgba(79,215,91,.16)',
        border: 'rgba(255,255,255,.12)', borderSolid: '#222222',
        inputBg: '#0a0a0a', surface: 'rgba(255,255,255,.04)', surfaceHover: 'rgba(255,255,255,.08)',
        danger: '#ff6b6b', warn: '#e3d44a', ok: '#4fd75b', termBg: '#000000',
      }),
      term: { background: '#000000', foreground: '#c8c8c8', cursor: '#4fd75b', cursorAccent: '#000000', selectionBackground: '#1d4a23', black: '#000000', red: '#ff6b6b', green: '#4fd75b', yellow: '#e3d44a', blue: '#5aa9ff', magenta: '#d47fe8', cyan: '#4fd1c5', white: '#c8c8c8', brightBlack: '#555555', brightRed: '#ff8f8f', brightGreen: '#7dff88', brightYellow: '#fff07a', brightBlue: '#8cc2ff', brightMagenta: '#e8a9ff', brightCyan: '#8ce8e0', brightWhite: '#ffffff' },
    },
    'dige-white': {
      vars: chrome({
        scheme: 'light',
        bg: '#f7f7f5', bg2: '#ffffff', bg3: '#ececeb', bg4: '#e2e2e0',
        fg: '#2b2b2b', fg2: 'rgba(0,0,0,.5)', fg3: '#1c1c1c',
        accent: '#1f7fd0', accentBg: 'rgba(31,127,208,.13)',
        border: 'rgba(0,0,0,.11)', borderSolid: '#d4d4d2',
        inputBg: '#ffffff', surface: 'rgba(0,0,0,.03)', surfaceHover: 'rgba(0,0,0,.06)',
        danger: '#b3261e', warn: '#a57200', ok: '#2e7d32', termBg: '#f7f7f5',
      }),
      term: { background: '#f7f7f5', foreground: '#2b2b2b', cursor: '#1f7fd0', cursorAccent: '#f7f7f5', selectionBackground: '#cfe4f7', black: '#2b2b2b', red: '#b3261e', green: '#2e7d32', yellow: '#a57200', blue: '#1f7fd0', magenta: '#8e24aa', cyan: '#00838f', white: '#8a8a8a', brightBlack: '#6a6a6a', brightRed: '#d93025', brightGreen: '#43a047', brightYellow: '#c79a00', brightBlue: '#2196f3', brightMagenta: '#ab47bc', brightCyan: '#00acc1', brightWhite: '#2b2b2b' },
    },
    'dige-black-and-white': {
      vars: chrome({
        bg: '#0b0b0b', bg2: '#161616', bg3: '#050505', bg4: '#222222',
        fg: '#e8e8e8', fg2: 'rgba(255,255,255,.45)', fg3: '#ffffff',
        accent: '#ffffff', accentBg: 'rgba(255,255,255,.14)',
        border: 'rgba(255,255,255,.14)', borderSolid: '#303030',
        inputBg: '#101010', surface: 'rgba(255,255,255,.05)', surfaceHover: 'rgba(255,255,255,.09)',
        danger: '#e0e0e0', warn: '#efefef', ok: '#dcdcdc', termBg: '#0b0b0b',
      }),
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

    // 字体栈：设置页可选字体族，中文回退到系统 CJK 等宽
    fontStack() {
      const base = (T.s.fontFamily || '').trim();
      const fallback = '"Source Code Pro", "JetBrains Mono", "Noto Sans Mono CJK SC", ui-monospace, monospace';
      return base ? `${base}, ${fallback}` : fallback;
    },

    async create(session, opts) {
      const g = (opts && opts.group) != null ? opts.group : this.group;
      const wrap = document.createElement('div');
      wrap.className = 'term-wrap';
      this.hostEl(g).appendChild(wrap);

      const term = new Terminal({
        fontFamily: this.fontStack(),
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
            keyPath: session.identityFile || null,
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
        // Tabby 风格标签属性（tabbar.js 消费）
        color: (session && session.color) || null, pinned: false, notify: false, activity: false,
      };
      this.tabs[id] = tab;
      this.order.push(id);
      // 最近使用：回写 profile 并持久化（Home/＋下拉消费 lastUsed）
      if (session) { session.lastUsed = Date.now(); T.persistSessions(); }
      if (window.Home) Home.hide();

      let inputLine = '';   // 输入镜像（Tab 补全上下文；方向键编辑不追踪，v1 够用）
      term.onData((data) => {
        let submitted = null;
        for (const ch of data) {
          if (ch === '\r') { submitted = inputLine; inputLine = ''; }
          else if (ch === '\x7f') inputLine = inputLine.slice(0, -1);
          else if (ch === '\x03') inputLine = '';
          else if (ch >= ' ') inputLine += ch;
        }
        if (T.s.sync && T.s.mode === 'Remote') {
          for (const t of Object.values(this.tabs)) T.invoke('write', { id: t.id, data }).catch(() => {});
        } else {
          T.invoke('write', { id, data }).catch(() => {});
        }
        if (submitted !== null) {
          // WindTerm 大纲语义：记录真实提交的命令行，可点击回跳
          const text = submitted.trim().slice(0, 120);
          if (text) {
            tab.outline.push({ n: tab.outline.length + 1, text, y: term.buffer.active.baseY + term.buffer.active.cursorY });
            UI.renderOutline();
          }
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

      // 选中自动复制（设置页可关）
      term.onSelectionChange(() => {
        if (T.s.copyOnSelect === false) return;
        const sel = term.getSelection();
        if (!sel) return;
        try { navigator.clipboard && navigator.clipboard.writeText(sel).catch(() => {}); } catch (e) {}
      });

      // PuTTY 习惯：中键粘贴；右键粘贴（可关，关闭时右键留给上下文菜单）
      const pasteHere = async () => {
        try {
          const txt = await navigator.clipboard.readText();
          if (txt) T.invoke('write', { id, data: txt }).catch(() => {});
        } catch (e) {}
      };
      wrap.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); pasteHere(); }
      });
      wrap.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
      wrap.addEventListener('contextmenu', (e) => {
        if (T.s.rightClickPaste !== false) { e.preventDefault(); pasteHere(); }
      });

      // —— P2 Tab 补全 ——
      let pop = null;
      const popEl = document.createElement('div');
      popEl.className = 'complete-pop';
      popEl.style.display = 'none';
      wrap.appendChild(popEl);
      const closePop = () => { pop = null; popEl.style.display = 'none'; };
      const applyDiff = (res, it) => {
        const del = Math.max(0, inputLine.length - res.start);
        const text = '\x7f'.repeat(del) + it.value;
        T.invoke('write', { id, data: text });
        inputLine = inputLine.slice(0, res.start) + it.value;
      };
      const renderPop = () => {
        popEl.innerHTML = '';
        pop.items.forEach((it, i) => {
          const d = document.createElement('div');
          d.className = 'ci' + (i === pop.sel ? ' sel' : '');
          const b = document.createElement('b'); b.textContent = it.value;
          const em = document.createElement('i'); em.textContent = it.info;
          d.append(b, em);
          d.onmousedown = (e) => { e.preventDefault(); applyDiff(pop, it); closePop(); };
          popEl.appendChild(d);
        });
        popEl.style.display = 'block';
      };
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return pop === null;
        if (pop) {
          if (ev.key === 'Escape') { closePop(); return false; }
          if (ev.key === 'ArrowDown') { pop.sel = (pop.sel + 1) % pop.items.length; renderPop(); return false; }
          if (ev.key === 'ArrowUp') { pop.sel = (pop.sel + pop.items.length - 1) % pop.items.length; renderPop(); return false; }
          if (ev.key === 'Tab' || ev.key === 'Enter') { applyDiff(pop, pop.items[pop.sel]); closePop(); return ev.key !== 'Tab'; }
          return true;
        }
        if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey) {
          ev.preventDefault();
          T.invoke('complete_input', { line: inputLine, caret: inputLine.length }).then((res) => {
            // 无候选时把 Tab 交还给 shell（PuTTY/普通终端习惯：shell 自身补全），不能吞键
            if (!res.items.length) { T.invoke('write', { id, data: '\t' }).catch(() => {}); return; }
            if (res.items.length === 1) { applyDiff(res, res.items[0]); return; }
            pop = { items: res.items.slice(0, 12), start: res.start, sel: 0 };
            renderPop();
          }).catch(() => { T.invoke('write', { id, data: '\t' }).catch(() => {}); });
          return false;
        }
        return true;
      });

      this.orderWrites(id);
      this.activate(id);
      // MobaXterm 习惯：SSH 一连上就把文件窗格切到双栏并列出远端家目录（须在 activate 之后）
      if (proto === 'ssh' && window.UI && typeof UI.onSshConnected === 'function') UI.onSshConnected(tab);
      // PuTTY 习惯：会话输出落盘（设置页开关；仅对新会话生效）
      if (T.s.sessionLog) this.startLog(tab);
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
      if (t.activity) { t.activity = false; this.renderTabbar(); }
      if (window.Home) Home.hide();
      if (window.Settings && Settings.isOpen()) Settings.close();
      this.renderTabbar();
      this.markFocused();
      for (const x of Object.values(this.tabs)) x.wrap.style.display = x.id === id ? 'block' : 'none';
      requestAnimationFrame(() => { try { t.fit.fit(); } catch (e) {} t.term.focus(); UI.status(); UI.renderOutline(); });
    },

    // 聚焦窗格描边（Tabby 的 focused pane 提示）
    markFocused() {
      const t = this.activeTab();
      const groups = document.querySelectorAll('#groups .group');
      for (const g of groups) g.classList.toggle('focused', !!t && String(t.group) === g.dataset.g);
    },

    async startLog(tab) {
      try {
        tab.logPath = await T.invoke('session_log_start', { id: tab.id });
        tab.logging = true;
        tab.logBuf = '';
        UI.log('会话日志已开启：' + tab.logPath);
      } catch (e) { UI.log('会话日志开启失败：' + e); }
    },

    async close(id) {
      const t = this.tabs[id];
      if (!t) return;
      if (t.logging) {
        T.flushLogs(t);
        T.invoke('session_log_stop', { id }).catch(() => {});
        t.logging = false;
      }
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
      else if (window.Home) Home.show();
      UI.status();
    },

    renderTabbar() {
      // Tabby 风格：窗口级单标签条（src/tabbar.js）；旧分组内标签条已废弃
      if (window.TabBar) TabBar.render();
    },

    /* ---------- Tabby 风格标签 API（tabbar.js 消费；0.6.0） ---------- */
    // toIndex：tabbar.js 契约——先从 order 移除 id，再插入到剩余数组的 toIndex 处（可等于长度=尾部）
    moveTab(id, toIndex) {
      const from = this.order.indexOf(id);
      if (from < 0) return;
      let to = typeof toIndex === 'string' ? this.order.indexOf(toIndex) : toIndex;
      this.order.splice(from, 1);
      if (to < 0) to = 0;
      if (to > this.order.length) to = this.order.length;
      this.order.splice(to, 0, id);
      this.renderTabbar();
    },
    // 显示序（tabbar.js 把 pinned 前置）
    displayOrder() {
      const pinned = this.order.filter((x) => this.tabs[x] && this.tabs[x].pinned);
      const rest = this.order.filter((x) => this.tabs[x] && !this.tabs[x].pinned);
      return [...pinned, ...rest];
    },
    renameTab(id, title) {
      const t = this.tabs[id];
      if (!t || !title) return;
      t.title = String(title).slice(0, 28);
      this.renderTabbar();
    },
    setTabColor(id, color) {
      const t = this.tabs[id];
      if (!t) return;
      t.color = color || null;
      this.renderTabbar();
    },
    togglePin(id) {
      const t = this.tabs[id];
      if (!t) return;
      t.pinned = !t.pinned;
      this.renderTabbar();
    },
    toggleNotify(id) {
      const t = this.tabs[id];
      if (!t) return;
      t.notify = !t.notify;
      this.renderTabbar();
    },
    async duplicate(id) {
      const t = this.tabs[id];
      if (!t) return;
      await this.create(t.session ? t.session : null, { group: t.group });
    },
    async closeOthers(id) {
      for (const x of [...this.order]) if (x !== id) await this.close(x);
    },
    async closeRight(id) {
      const disp = this.displayOrder();
      const i = disp.indexOf(id);
      if (i < 0) return;
      for (const x of disp.slice(i + 1)) await this.close(x);
    },
    async closeLeft(id) {
      const disp = this.displayOrder();
      const i = disp.indexOf(id);
      if (i < 0) return;
      for (const x of disp.slice(0, i)) await this.close(x);
    },
    // Tabby 分屏：在当前标签的对面分组新建一个同 profile 面板
    async splitActive(dir) {
      const axis = (dir === 'right' || dir === 'left') ? 'h' : 'v';
      const cur = this.activeTab();
      if (!cur) return;
      const wasSplit = !!this.splitDir;
      if (!wasSplit) await this.split(axis);
      const gTarget = this.activeTab().group === 1 ? 0 : 1;
      await this.create(cur.session || null, { group: gTarget });
      UI.log('分屏：' + dir);
    },
    newLocal() { return this.create(null); },
    openHome() { if (window.Home) Home.show(); },
    closeHome() { if (window.Home) Home.hide(); },

    async split(dir) {
      this.splitDir = dir;
      const g1 = this.groupEl(1);
      g1.hidden = false;
      const gut = document.getElementById('gutter');
      if (gut) gut.hidden = false;
      document.getElementById('groups').dataset.dir = dir;
      // 换轴向时清掉上次拖拽留下的固定尺寸
      this.groupEl(0).style.flex = '';
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
      this.groupEl(0).style.flex = '';
      for (const id of this.order) {
        const t = this.tabs[id];
        if (t.group === 1) { t.group = 0; this.hostEl(0).appendChild(t.wrap); }
      }
      this.groupEl(1).hidden = true;
      const gut = document.getElementById('gutter');
      if (gut) gut.hidden = true;
      this.group = 0;
      this.renderTabbar();
      if (this.active) this.activate(this.active);
      else this.markFocused();
      if (!silent) UI.log('取消分屏');
    },

    // 在两个分屏组之间轮换焦点
    focusNextGroup() {
      if (!this.splitDir) { UI.toast('当前未分屏'); return; }
      const cur = this.group;
      const other = cur === 0 ? 1 : 0;
      const ids = this.order.filter((id) => this.tabs[id] && this.tabs[id].group === other);
      if (!ids.length) { UI.toast('另一个窗格没有会话'); return; }
      this.activate(ids[ids.length - 1]);
    },

    zoom(delta) {
      T.s.fontSize = Math.max(8, Math.min(28, T.s.fontSize + delta));
      this.applyFontSize(T.s.fontSize);
      T.persistSettings();
      UI.status();
      if (window.Settings && Settings.isOpen()) Settings.render();
    },
    zoomReset() { T.s.fontSize = 13; this.applyFontSize(13); T.persistSettings(); UI.status(); },

    applyFontSize(px) {
      const n = Math.max(8, Math.min(28, parseInt(px, 10) || 13));
      T.s.fontSize = n;
      for (const t of Object.values(this.tabs)) {
        t.term.options.fontSize = n;
        try { t.fit.fit(); } catch (e) {}
      }
      UI.status();
    },

    applyFontFamily(family) {
      T.s.fontFamily = family || '';
      const stack = this.fontStack();
      for (const t of Object.values(this.tabs)) {
        t.term.options.fontFamily = stack;
        try { t.fit.fit(); } catch (e) {}
      }
      T.persistSettings();
    },

    applyTheme(name) {
      if (!THEMES[name]) return;
      T.s.theme = name;
      const v = THEMES[name].vars;
      for (const k in v) document.documentElement.style.setProperty(k, v[k]);
      for (const t of Object.values(this.tabs)) {
        t.term.options.theme = THEMES[name].term;
        try { t.fit.fit(); } catch (e) {}
      }
      T.persistSettings();
      UI.status();
      if (window.Settings && Settings.isOpen()) Settings.render();
    },

    findByPty(id) { return this.tabs[id]; },

    searchNext(q) {
      const t = this.activeTab();
      if (!t) return false;
      try { return !!t.search.findNext(q || UI.lastQuery || ''); } catch (e) { return false; }
    },
    searchPrev(q) {
      const t = this.activeTab();
      if (!t) return false;
      try { return !!t.search.findPrevious(q || UI.lastQuery || ''); } catch (e) { return false; }
    },

    /* ---- triggers engine — 后端语义引擎（re/triggers.rs，WindTerm TriggerCenter 重写）优先，v0 本地回退 ---- */
    runTriggers(tab, data) {
      if (!T.s.triggers.length) return;
      T.invoke('triggers_feed', { data }).then((acts) => {
        for (const a of acts || []) {
          if (a.action === 'send') {
            T.invoke('write', { id: tab.id, data: a.text }).catch(() => {});
          } else if (a.action === 'bell') {
            UI.beep();
          } else if (a.action === 'highlight') {
            this.highlightHit(tab);
          } else if (a.action === 'run') {
            UI.log('触发器请求执行命令：' + a.program + ' ' + (a.args || []).join(' '));
          } else if (a.action === 'open') {
            UI.log('触发器请求打开链接：' + a.url);
          } else if (a.action === 'log') {
            UI.log(a.text);
          }
          UI.log(`触发器命中（后端 rule ${a.ruleId ?? ''}）`);
        }
      }).catch(() => this.runTriggersV0(tab, data));
    },

    highlightHit(tab) {
      try {
        const m = tab.term.registerMarker(0);
        const d = tab.term.registerDecoration({ marker: m, x: 1, width: Math.max(1, tab.term.cols - 2) });
        d.onRender((el) => el.classList.add('wt-hit'));
        setTimeout(() => { try { d.dispose(); } catch (e) {} }, 4000);
      } catch (e) {}
    },

    /* ---- WindTerm 风格内置高亮：关键字/地址着色（持久行装饰） ----
     * 借鉴 WindTerm 的「输出高亮」设计：error/warn/ok/地址 四类默认规则，
     * 命中即在所在行加持久着色装饰（不随滚动消失），可在设置页整体关闭。
     */
    HIGHLIGHT_RULES: [
      { kind: 'err', re: /\b(error|errors|failed|failure|fatal|panic|denied|refused|rejected)\b/i, cls: 'wt-hl-err' },
      { kind: 'warn', re: /\b(warn|warning|caution|timeout|timed out|deprecat)\b/i, cls: 'wt-hl-warn' },
      { kind: 'ok', re: /\b(ok|okay|success|succeeded|passed)\b/i, cls: 'wt-hl-ok' },
      { kind: 'addr', re: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|https?:\/\/[^\s'"]+/i, cls: 'wt-hl-addr' },
    ],

    highlightLine(tab, cls, offset) {
      try {
        const m = tab.term.registerMarker(offset || 0);
        const d = tab.term.registerDecoration({ marker: m, x: 1, width: Math.max(1, tab.term.cols - 2) });
        d.onRender((el) => el.classList.add(cls));
        tab._hls = tab._hls || [];
        tab._hls.push(d);
        return d;
      } catch (e) { return null; }
    },

    // 必须在 term.write 的回调里调用：xterm 解析是异步的，回调时光标才落在正确行。
    // 超宽行会换行成多个视觉行：按 ceil(len/cols) 逐行盖满，否则只盖一行会像一条游离色带。
    // 内置高亮为「闪烁提示」语义：6 秒后自动消退，避免滚屏时残留。
    runHighlights(tab, data) {
      if (T.s.builtinHighlight === false || !data) return;
      const cols = Math.max(1, tab.term.cols);
      const lines = data.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (!lines.length) return;
      const made = [];
      let cursorOffset = 0;                       // 0 = 光标所在行（write 回调时位于末行之后）
      for (let j = lines.length - 1; j >= 0; j--) {
        const line = lines[j];
        const rows = Math.min(40, Math.max(1, Math.ceil(line.length / cols)));
        const firstOff = cursorOffset - rows;
        cursorOffset = firstOff;
        const hit = this.HIGHLIGHT_RULES.find((r) => r.re.test(line));
        if (!hit) continue;
        for (let r = 0; r < rows; r++) {
          const d = this.highlightLine(tab, hit.cls, firstOff + r);
          if (d) made.push(d);
        }
      }
      if (made.length) {
        tab._hls = tab._hls || [];
        setTimeout(() => {
          for (const d of made) {
            const i = tab._hls.indexOf(d);
            if (i >= 0) tab._hls.splice(i, 1);
            try { d.dispose(); } catch (e) {}
          }
        }, 6000);
        // 上限保护：超出丢弃最旧的装饰，避免长会话内存增长
        while (tab._hls.length > 240) { const old = tab._hls.shift(); try { old.dispose(); } catch (e) {} }
      }
    },

    runTriggersV0(tab, data) {
      const rules = T.s.triggers.filter((r) => r.enabled !== false);
      if (!rules.length) return;
      for (const r of rules) {
        let re; try { re = new RegExp(r.pattern); } catch (e) { continue; }
        if (!re.test(data)) continue;
        if (r.action === 'highlight') this.highlightHit(tab);
        else if (r.action === 'bell') UI.beep();
        else if (r.action === 'send') T.invoke('write', { id: tab.id, data: (r.arg || '') + '\r' }).catch(() => {});
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