/* hurricaneTerm — terminal manager: tabs, split groups, themes, search, triggers, zoom, sync input.
 * Original code (see LICENSE). */
(function () {
  const T = window.WT;

  /* ---------- 主题 ----------
   * tabby-dark / tabby-light 的终端 16 色取自 Tabby 上游
   * tabby-terminal/src/colorSchemes.ts（"Tabby Default" / "Tabby Default Light"）；
   * 界面令牌取自 tabby-core/src/theme.vars.scss。其余 4 套为内置深浅色主题。
   * --term-bg 让「活动标签 + 主区」与终端底色无缝衔接（Tabby 的连体观感）。
   */
  function chrome(c) {
    const light = c.scheme === 'light';
    const alpha = (hex, opacity) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
    };
    const v = {
      '--bg': c.bg, '--bg2': c.bg2, '--bg3': c.bg3, '--bg4': c.bg4,
      '--fg': c.fg, '--fg2': c.fg2, '--fg3': c.fg3,
      '--accent': c.accent, '--accent-bg': c.accentBg, '--accent-soft': c.accentSoft || alpha(c.accent, .3),
      '--border': c.border, '--border-solid': c.borderSolid,
      '--input-bg': c.inputBg, '--surface': c.surface, '--surface-hover': c.surfaceHover,
      '--danger': c.danger, '--warn': c.warn, '--ok': c.ok,
      // 每一套主题都生成完整控件令牌，切换时不会继承上一套主题的残留值。
      '--placeholder': c.fg2,
      '--surface-active': light ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.08)',
      '--scrollbar-thumb': light ? 'rgba(0,0,0,.2)' : 'rgba(255,255,255,.18)',
      '--scrollbar-thumb-hover': light ? 'rgba(0,0,0,.32)' : 'rgba(255,255,255,.3)',
      '--danger-bg': alpha(c.danger, light ? .12 : .22),
      '--on-danger': light ? '#ffffff' : c.bg3,
      '--overlay-bg': light ? 'rgba(0,0,0,.3)' : 'rgba(0,0,0,.55)',
      '--shadow': light ? '0 4px 18px rgba(0,0,0,.14), 0 1px 3px rgba(0,0,0,.08)' : '0 4px 18px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.2)',
      '--dialog-shadow': light ? '0 18px 60px rgba(0,0,0,.2)' : '0 18px 60px rgba(0,0,0,.6)',
      '--term-bg': c.termBg,
      '--color-scheme': c.scheme || 'dark',
    };
    return v;
  }

  const CHROME_DARK = {
    bg: '#131d27', bg2: '#1d272d', bg3: '#0e151d', bg4: '#20333e',
    fg: '#cccccc', fg2: 'rgba(255,255,255,.5)', fg3: '#ced9e2',
    accent: '#4fadff', accentBg: 'rgba(0,89,165,.349)', accentSoft: 'rgba(79,173,255,.3)',
    border: 'rgba(255,255,255,.1)', borderSolid: '#24313c',
    inputBg: '#181e23', surface: 'rgba(255,255,255,.025)', surfaceHover: 'rgba(255,255,255,.05)',
    danger: '#d9534f', warn: '#f0ad4e', ok: '#5cb85c',
  };
  const CHROME_LIGHT = {
    scheme: 'light',
    bg: '#f2f3f5', bg2: '#ffffff', bg3: '#e6e8eb', bg4: '#dfe2e6',
    fg: '#2b2b2b', fg2: 'rgba(0,0,0,.5)', fg3: '#1f2328',
    accent: '#4fadff', accentBg: 'rgba(0,89,165,.349)', accentSoft: 'rgba(79,173,255,.3)',
    border: 'rgba(0,0,0,.1)', borderSolid: '#d6d9dd',
    inputBg: '#ffffff', surface: 'rgba(0,0,0,.03)', surfaceHover: 'rgba(0,0,0,.06)',
    danger: '#c82829', warn: '#b58900', ok: '#718c00',
  };

  // Tabby Default（终端）
  const TABBY_DARK_TERM = {
    background: '#171717', foreground: '#cacaca', cursor: '#bbbbbb', cursorAccent: '#171717',
    selectionBackground: '#0059a559',
    black: '#000000', red: '#ff615a', green: '#b1e969', yellow: '#ebd99c', blue: '#5da9f6',
    magenta: '#e86aff', cyan: '#82fff7', white: '#dedacf',
    brightBlack: '#313131', brightRed: '#f58c80', brightGreen: '#ddf88f', brightYellow: '#eee5b2',
    brightBlue: '#a5c7ff', brightMagenta: '#ddaaff', brightCyan: '#b7fff9', brightWhite: '#ffffff',
  };
  // Tabby Default Light（终端）
  const TABBY_LIGHT_TERM = {
    background: '#ffffff', foreground: '#4d4d4c', cursor: '#4d4d4c', cursorAccent: '#ffffff',
    selectionBackground: '#0059a559',
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
    splitDir: null,    // 当前工作区的 null|'h'|'v'，兼容状态栏/分隔条调用
    workspaces: {},    // workspaceId -> { splitDir, ratio, activeId }；一个标签可含两个 PTY

    workspaceId(tab) { return tab && (tab.workspaceId || tab.id); },
    workspaceTabs(id) {
      const key = typeof id === 'object' ? this.workspaceId(id) : this.workspaceId(this.tabs[id]) || id;
      return this.order.map(x => this.tabs[x]).filter(t => t && !t._closing && this.workspaceId(t) === key);
    },
    workspaceTab(id) { return this.workspaceTabs(id)[0] || null; },
    activeTabId() { return this.workspaceTab(this.active)?.id || this.active; },
    workspaceState(tab = this.activeTab()) {
      const id = this.workspaceId(tab);
      return id ? (this.workspaces[id] ||= { splitDir: null, ratio: null, activeId: tab.id }) : null;
    },
    activateTab(id, focus = true) {
      const t = this.tabs[id]; if (!t) return;
      const state = this.workspaceState(t);
      this.activate(this.workspaceTabs(id).some(x => x.id === state.activeId) ? state.activeId : id, focus);
    },
    // 只绘制活动标签的窗格。每个标签独立保存方向、比例和上一次聚焦的终端。
    renderWorkspace() {
      const active = this.activeTab(), key = this.workspaceId(active), state = this.workspaceState(active);
      const peers = active ? this.workspaceTabs(active) : [];
      this.splitDir = peers.length > 1 ? (state.splitDir || 'h') : null;
      const host = document.getElementById('groups');
      host.dataset.dir = this.splitDir || '';
      host.dataset.workspace = key || '';
      this.groupEl(0).style.flex = this.splitDir && state.ratio ? `0 0 ${state.ratio}%` : '';
      this.groupEl(1).hidden = !this.splitDir;
      const gutter = document.getElementById('gutter'); if (gutter) gutter.hidden = !this.splitDir;
      for (const t of Object.values(this.tabs)) t.wrap.style.display = this.workspaceId(t) === key ? 'block' : 'none';
      this.renderPaneControls();
      this.markFocused();
    },
    renderPaneControls() {
      const peers = this.active ? this.workspaceTabs(this.active) : [];
      for (const g of [0, 1]) {
        const group = this.groupEl(g);
        let head = group.querySelector('.pane-controls');
        if (!head) {
          head = document.createElement('header'); head.className = 'pane-controls';
          const title = document.createElement('span'); title.className = 'pane-title';
          const close = document.createElement('button'); close.type = 'button'; close.className = 'pane-close';
          close.innerHTML = window.Icons ? Icons.svg('x') : '×';
          close.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
          close.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); const id = close.dataset.id; if (id) this.close(id); });
          head.append(title, close); group.prepend(head);
        }
        const t = peers.find(x => x.group === g);
        head.hidden = !this.splitDir || !t;
        if (t) {
          head.querySelector('.pane-title').textContent = t.title;
          const close = head.querySelector('.pane-close'); close.dataset.id = t.id;
          close.title = '关闭此分屏'; close.setAttribute('aria-label', '关闭分屏：' + t.title);
        }
      }
    },

    groupEl(g) { return document.querySelector(`#groups .group[data-g="${g}"]`); },
    tabbarEl(g) { return this.groupEl(g).querySelector('.tabbar'); },
    hostEl(g) { return this.groupEl(g).querySelector('.term-host'); },

    activeTab() { return this.active ? this.tabs[this.active] : null; },
    // UI IDs and workspace membership stay stable across reconnects. Explicit
    // null means disconnected; old/test tabs without the property use their ID.
    ptyId(tab) { return tab ? (tab.ptyId === undefined ? tab.id : tab.ptyId) : null; },
    isLive(tab) { return !!(tab && !tab._closing && !tab.exited && !tab._reconnecting && this.tabs[tab.id] === tab && this.ptyId(tab)); },
    canReconnect(tab) { return !!(tab?.session && ['ssh', 'telnet', 'tcp', 'serial'].includes(String(tab.session.protocol || '').toLowerCase())); },
    writeTo(tab, data) {
      if (!this.isLive(tab) || !data) return Promise.resolve(false);
      return T.invoke('write', { id: this.ptyId(tab), data }).then(() => true).catch(() => false);
    },
    beginConnection() { this._pendingConnections = (this._pendingConnections || 0) + 1; },
    endConnection() {
      this._pendingConnections = Math.max(0, (this._pendingConnections || 0) - 1);
      if (!this._pendingConnections) this._earlyPtyEvents?.clear();
    },
    queuePendingEvent(type, id, data) {
      // A very fast peer can emit data/exit before its connect IPC returns the
      // ID. Bound this short handoff buffer, and never reuse old UI-ID lookup.
      if (!this._pendingConnections || !id) return;
      const events = (this._earlyPtyEvents ||= new Map());
      if (!events.has(id) && events.size >= 32) return;
      const entry = events.get(id) || { parts: [], length: 0, exited: false, omitted: false };
      events.set(id, entry);
      if (type === 'exit') { entry.exited = true; return; }
      if (type === 'error') { entry.error ||= data; return; }
      if (!entry.exited && data) {
        let length = Math.min(String(data).length, 65536 - entry.length);
        if (length < String(data).length && /[\uD800-\uDBFF]/.test(String(data).charAt(length - 1))) length--;
        if (length > 0) { const part = String(data).slice(0, length); entry.parts.push(part); entry.length += part.length; }
        if (length < String(data).length) entry.omitted = true;
      }
    },
    consumePendingEvents(tab, nativeId) {
      const entry = this._earlyPtyEvents?.get(nativeId);
      this._earlyPtyEvents?.delete(nativeId);
      if (!entry || tab._closing || this.tabs[tab.id] !== tab || this.ptyId(tab) !== nativeId) return;
      for (const data of entry.parts) {
        this.receiveOutput(tab, data);
        if (tab.logging) tab.logBuf = (tab.logBuf || '') + data;
      }
      if (entry.omitted) this.receiveOutput(tab, '\r\n\x1b[2m[连接建立前的初始输出过多，部分内容已省略]\x1b[0m\r\n');
      if (entry.error) this.handleConnectionError(tab, nativeId, entry.error);
      if (entry.exited) this.handleExit(tab, nativeId);
    },
    connectionErrorText(session, error) {
      let text = typeof error === 'string' ? error : String(error?.error || error?.message || error || '未返回具体原因');
      const seen = new Set(); let cause = error?.cause;
      while (cause && !seen.has(cause) && seen.size < 4) { seen.add(cause); text += '\n原因：' + String(cause.message || cause); cause = cause.cause; }
      text = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[^\[\]])/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
      for (const key of ['password', 'proxyPassword', 'passphrase', 'keyPassphrase', 'privateKey', 'token']) {
        const secret = session?.[key]; if (typeof secret === 'string' && secret) text = text.split(secret).join('[已隐藏]');
      }
      text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[私钥已隐藏]')
        .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[凭据已隐藏]@')
        .replace(/\b(Authorization\s*[:=]\s*)(?:Basic|Bearer)\s+\S+/gi, '$1[已隐藏]')
        .replace(/\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1=[已隐藏]');
      if (text.length > 8192) { let end = 8192; if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--; text = text.slice(0, end) + '\n[错误详情过长，已截断]'; }
      return text.trim() || '未返回具体原因';
    },
    handleConnectionError(tab, nativeId, details) {
      if (!tab || tab._closing || tab.exited || this.tabs[tab.id] !== tab || this.ptyId(tab) !== nativeId) return false;
      const message = this.connectionErrorText(tab.session, details);
      tab.connectionError = { nativeId, message, stage: details?.stage || '' };
      this.receiveOutput(tab, '\r\n[连接失败]\r\n' + message.replace(/\r?\n/g, '\r\n') + '\r\n', { triggers: false });
      UI.log('连接失败 · ' + tab.title + '：' + message);
      this.handleExit(tab, nativeId);
      UI.showConnectionError?.(tab.session, message, { tab, stage: details?.stage });
      return true;
    },
    handleExit(tab, nativeId) {
      if (!tab || tab._closing || tab.exited || this.tabs[tab.id] !== tab || this.ptyId(tab) !== nativeId) return false;
      T.flushLogs(tab);
      tab.exited = true; tab.ptyId = null;
      window.OpsAgent?.checkTarget?.();
      tab._connectionGeneration = (tab._connectionGeneration || 0) + 1;
      tab._resetInput?.();
      const text = this.canReconnect(tab) ? '[远程会话已退出或断开，按任意键重新连接]' : '[本地进程已退出，可新建标签重新打开]';
      this.receiveOutput(tab, '\r\n\x1b[0m\x1b[2m' + text + '\x1b[0m\r\n');
      this.renderTabbar();
      window.SftpPanel?.onConnectionChange?.(tab);
      UI.status();
      // The backend's exit signal does not carry a cause. Do not call it a
      // timeout, and release the old entry without ever translating its ID.
      T.invoke('kill', { id: nativeId }).catch(() => {});
      return true;
    },
    reconnect(tab = this.activeTab()) {
      if (!tab || tab._closing || this.tabs[tab.id] !== tab || !tab.exited || !this.canReconnect(tab)) return Promise.resolve(null);
      if (tab._reconnectPromise) return tab._reconnectPromise;
      const attempt = {};
      tab._reconnectAttempt = attempt; tab._reconnecting = true;
      tab._resetInput?.();
      this.receiveOutput(tab, '\r\n\x1b[2m[正在重新连接…]\x1b[0m\r\n');
      this.renderTabbar();
      const promise = (async () => {
        let nativeId;
        this.beginConnection();
        try {
          nativeId = await this.connectSession(tab.session, tab.term);
          if (typeof nativeId !== 'string' || !nativeId) throw new Error('连接未返回有效会话');
          if (tab._closing || this.tabs[tab.id] !== tab || tab._reconnectAttempt !== attempt) {
            await T.invoke('kill', { id: nativeId }).catch(() => {});
            return null;
          }
          tab.ptyId = nativeId; tab.exited = false; tab._reconnecting = false;
          tab._connectionGeneration = (tab._connectionGeneration || 0) + 1;
          tab.cwd = null;
          tab.connectionError = null;
          this.receiveOutput(tab, '\x1b[2m[连接请求已发送]\x1b[0m\r\n');
          this.consumePendingEvents(tab, nativeId);
          if (!this.isLive(tab)) return null;
          if (tab.session) { tab.session.lastUsed = Date.now(); T.persistSessions(); }
          if (String(tab.session?.protocol).toLowerCase() === 'ssh') window.UI?.onSshConnected?.(tab);
          window.SftpPanel?.onConnectionChange?.(tab);
          this.renderPaneControls(); this.renderTabbar(); UI.status();
          if (this.active === tab.id) tab.term.focus();
          return tab;
        } catch (error) {
          if (!tab._closing && this.tabs[tab.id] === tab && tab._reconnectAttempt === attempt) {
            tab.exited = true; tab.ptyId = null;
            const message = this.connectionErrorText(tab.session, error);
            tab.connectionError = { message };
            this.receiveOutput(tab, '\r\n[重新连接失败]\r\n' + message.replace(/\r?\n/g, '\r\n') + '\r\n[按任意键重试]\r\n', { triggers: false });
            UI.log('重新连接失败 · ' + tab.title + '：' + message);
            UI.showConnectionError?.(tab.session, message, { tab });
            window.SftpPanel?.onConnectionChange?.(tab);
            this.renderTabbar(); UI.status();
          }
          return null;
        } finally {
          this.endConnection();
          if (tab._reconnectAttempt === attempt) {
            tab._reconnecting = false; tab._reconnectPromise = null; tab._reconnectAttempt = null;
          }
        }
      })();
      tab._reconnectPromise = promise;
      return promise;
    },

    // 字体栈：设置页可选字体族，中文回退到系统 CJK 等宽
    fontStack() {
      const base = (T.s.fontFamily || '').trim();
      const fallback = '"Source Code Pro", "JetBrains Mono", "Noto Sans Mono CJK SC", ui-monospace, monospace';
      return base ? `${base}, ${fallback}` : fallback;
    },

    // The same protocol contract is used for the initial connection and retry.
    async connectSession(session, term) {
      const proto = String(session?.protocol || '').toLowerCase();
      if ((proto === 'ssh' || proto === 'telnet') && !session.host) throw new Error('远程连接缺少主机地址');
      if (proto === 'tcp' && !session.host && !session.target) throw new Error('TCP 连接缺少目标地址');
      if (proto === 'ssh' && session.host) {
        return T.invoke('connect_ssh', {
          rows: term.rows, cols: term.cols,
          host: session.host, port: session.port || null,
          user: session.user || null, password: session.password || null,
          keyPath: session.identityFile || null,
          jumpHost: session.jumpHost || null,
          proxyType: session.proxyType || null, proxyHost: session.proxyHost || null,
          proxyPort: session.proxyPort || null, proxyUser: session.proxyUser || null,
          proxyPassword: session.proxyPassword || null, proxyCommand: session.proxyCommand || null,
        });
      } else if (proto === 'telnet' && session.host) {
        return T.invoke('connect_telnet', { host: session.host, port: session.port || 23 });
      } else if (proto === 'serial') {
        // 串口：target=端口名（session.target 键）；参数运行期不可改，重连生效
        return T.invoke('connect_serial', {
          target: session.target || session.host || '',
          baudRate: session.baudRate || null,
          dataBits: session.dataBits || null,
          parity: session.parity || null,
          stopBits: session.stopBits || null,
          flowControl: session.flowControl || null,
        });
      } else if (proto === 'tcp' && (session.host || session.target)) {
        // 裸 TCP：host:port 或 target 串；代理分流走 re/tcp 语义
        return T.invoke('connect_tcp', {
          host: session.host || '', port: session.port || null, target: session.target || null,
          proxyType: session.proxyType || null,
          proxyHost: session.proxyHost || null, proxyPort: session.proxyPort || null,
          proxyUser: session.proxyUser || null, proxyPassword: session.proxyPassword || null,
          proxyCommand: session.proxyCommand || null,
        });
      } else {
        return T.invoke('spawn', {
          rows: term.rows, cols: term.cols,
          command: session && session.command ? session.command : null,
          args: session ? session.args : null,
        });
      }
    },

    async create(session, opts) {
      const workspaceId = opts && opts.workspaceId;
      // 新建/复制标签不会继承当前分屏槽位；只有 splitActive 显式加入已有标签。
      const g = workspaceId && opts.group != null ? opts.group : 0;
      const wrap = document.createElement('div');
      wrap.className = 'term-wrap'; wrap.style.display = 'none';
      this.hostEl(g).appendChild(wrap);

      const term = new Terminal({
        fontFamily: this.fontStack(),
        fontSize: T.s.fontSize,
        theme: window.Appearance ? Appearance.terminalTheme(THEMES[T.s.theme].term) : THEMES[T.s.theme].term,
        allowTransparency: true,
        scrollback: 10000,
        allowProposedApi: true,
        macOptionIsMeta: false,
        cursorBlink: true,
      });
      if (window.Appearance) Appearance.syncTerminal({ wrap, term }, THEMES[T.s.theme].term);
      const fit = new FitAddon.FitAddon();
      const search = new SearchAddon.SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
      term.open(wrap);
      fit.fit();

      const proto = ((session && session.protocol) || '').toLowerCase();
      let id;
      this.beginConnection();
      try {
        id = await this.connectSession(session, term);
      } catch (e) {
        this.endConnection();
        term.dispose(); wrap.remove();
        const message = this.connectionErrorText(session, e);
        UI.log('连接失败：' + message);
        UI.showConnectionError?.(session, message);
        return null;
      }

      // 身份验证期间原标签可能被关闭。迟到的连接必须立即释放，不能复活标签。
      if (workspaceId && !this.workspaceTabs(workspaceId).length) {
        this.endConnection();
        term.dispose(); wrap.remove();
        T.invoke('kill', { id }).catch(() => {});
        return null;
      }
      const tab = {
        id, ptyId: id, workspaceId: workspaceId || id, title: (session && session.name) || (session && session.host ? session.host : `shell ${this.order.length + 1}`),
        term, fit, search, wrap, group: g, exited: false, outline: [], session: session || null,
        _inputSubscriptions: [], _connectionGeneration: 0,
        // Tabby 风格标签属性（tabbar.js 消费）
        color: (session && session.color) || null, pinned: false, notify: false, activity: false,
      };
      this.tabs[id] = tab;
      this.workspaceState(tab);
      if (workspaceId && opts.moveExistingTo != null) {
        const source = this.tabs[opts.sourceId];
        if (source) { source.group = opts.moveExistingTo; this.hostEl(source.group).appendChild(source.wrap); }
      }
      // Connecting may await authentication while the user changes opacity/theme.
      // Apply the latest appearance when the session finally becomes a tab.
      if (window.Appearance) Appearance.syncTerminal(tab, THEMES[T.s.theme].term);
      if (term.parser && term.parser.registerOscHandler) tab._inputSubscriptions.push(term.parser.registerOscHandler(7, data => {
        if (!this.isLive(tab)) return false;
        try {
          const url = new URL(data);
          const path = decodeURIComponent(url.pathname);
          if (url.protocol === 'file:' && path.startsWith('/') && !/[\0\r\n]/.test(path)) {
            tab.cwd = path;
            if (window.SftpPanel) SftpPanel.syncCwd(id, path);
          }
        } catch (_) {}
        return false;
      }));
      this.order.push(id);
      // 最近使用：回写 profile 并持久化（Home/＋下拉消费 lastUsed）
      if (session) { session.lastUsed = Date.now(); T.persistSessions(); }
      if (window.Home) Home.hide();

      let inputLine = '';   // 输入镜像（Tab 补全上下文；方向键编辑不追踪，v1 够用）
      const subscribe = subscription => { if (subscription?.dispose) tab._inputSubscriptions.push(subscription); };
      subscribe(term.onData((data) => {
        if (tab._closing || this.tabs[tab.id] !== tab) return;
        if (tab.exited || tab._reconnecting) { if (!tab._reconnecting) this.reconnect(tab); return; }
        if (!this.isLive(tab)) return;
        let submitted = null;
        for (const ch of data) {
          if (ch === '\r') { submitted = inputLine; inputLine = ''; }
          else if (ch === '\x7f') inputLine = inputLine.slice(0, -1);
          else if (ch === '\x03') inputLine = '';
          else if (ch >= ' ') inputLine += ch;
        }
        if (T.s.sync && T.s.mode === 'Remote') {
          for (const t of Object.values(this.tabs)) this.writeTo(t, data);
        } else {
          this.writeTo(tab, data);
        }
        if (submitted !== null) {
          // 大纲语义：记录真实提交的命令行，可点击回跳
          const text = submitted.trim().slice(0, 120);
          if (text) {
            tab.outline.push({ n: tab.outline.length + 1, text, y: term.buffer.active.baseY + term.buffer.active.cursorY });
            UI.renderOutline();
          }
        }
      }));
      subscribe(term.onResize(({ rows, cols }) => {
        if (this.isLive(tab)) T.invoke('resize', { id: this.ptyId(tab), rows, cols }).catch(() => {});
        if (this.active === id) UI.status();
      }));
      subscribe(term.onTitleChange((t) => {
        if (tab._closing || tab.exited) return;
        if (t && t.trim()) { if (!tab.customTitle) tab.title = t.trim().slice(0, 28); this.renderPaneControls(); this.renderTabbar(); }
      }));
      wrap.addEventListener('mousedown', () => this.activate(id));

      // Coalesce drag updates; preserve ordering with explicit copy operations.
      let selectionTimer = null, selectionVersion = 0, copyFailureShown = false;
      const clearSelectionCopy = () => { clearTimeout(selectionTimer); selectionTimer = null; selectionVersion++; };
      const copySelection = () => {
        clearTimeout(selectionTimer); selectionTimer = null;
        const value = term.getSelection(), version = selectionVersion;
        const valid = () => !tab._closing && this.tabs[tab.id] === tab && T.s.copyOnSelect !== false && selectionVersion === version && term.getSelection() === value;
        if (!value || !valid()) return;
        const copying = T.copyText ? T.copyText(value, { shouldWrite: valid }) : navigator.clipboard?.writeText(value);
        Promise.resolve(copying).then(done => { if (done !== false) copyFailureShown = false; }).catch(() => {
          if (valid() && !copyFailureShown) { copyFailureShown = true; UI.toast?.('自动复制失败，可用 Ctrl+Shift+C 重试', 3500, 'err'); }
        });
      };
      subscribe(term.onSelectionChange(() => {
        clearSelectionCopy();
        if (T.s.copyOnSelect === false || !term.getSelection() || tab._closing) return;
        selectionTimer = setTimeout(copySelection, 60);
      }));
      const finishSelectionCopy = () => { if (selectionTimer !== null) copySelection(); };
      document.addEventListener('mouseup', finishSelectionCopy, true);
      subscribe({ dispose() { clearSelectionCopy(); document.removeEventListener('mouseup', finishSelectionCopy, true); } });

      // PuTTY 习惯：中键粘贴；右键粘贴（可关，关闭时右键留给上下文菜单）
      const pasteHere = async () => {
        try {
          const txt = await navigator.clipboard.readText();
          if (tab.exited) { this.reconnect(tab); return; }
          if (txt) this.writeTo(tab, txt);
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
      tab._resetInput = () => { inputLine = ''; closePop(); };
      const applyDiff = (res, it) => {
        if (!this.isLive(tab) || (res.generation != null && res.generation !== tab._connectionGeneration)) return;
        const del = Math.max(0, inputLine.length - res.start);
        const text = '\x7f'.repeat(del) + it.value;
        this.writeTo(tab, text);
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
        if (tab._closing || this.tabs[tab.id] !== tab) return false;
        const key = ev.code || ev.key;
        // Consume the triggering physical key through keyup, including a keypress
        // or auto-repeat delivered after a very fast reconnect has completed.
        if (tab._reconnectKey === key) {
          if (ev.type === 'keyup') { tab._reconnectKey = null; return false; }
          if (ev.type === 'keypress' || ev.repeat) { ev.preventDefault(); return false; }
        }
        if (tab.exited || tab._reconnecting) {
          if (ev.type !== 'keydown') return false;
          const lower = String(ev.key || '').toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
          const shortcut = ['F11', 'F3'].includes(ev.key) || (mod && (
            (!ev.shiftKey && ['t', 'w', 'f', 'b', 'm', ',', '1', '2', '3', '4', '5', '6'].includes(lower)) ||
            (ev.shiftKey && ['p', 'e', 'd', 'w', 'c', 'v'].includes(lower)) || ['=', '+', '-'].includes(lower)));
          // App shortcuts still bubble to UI, especially Ctrl/Cmd+W close.
          if (shortcut || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(ev.key) || ev.isComposing) return false;
          ev.preventDefault(); ev.stopPropagation();
          if (!ev.repeat && !tab._reconnecting) { tab._reconnectKey = key; this.reconnect(tab); }
          return false;
        }
        if (ev.type === 'keyup' && tab._reconnectKey) tab._reconnectKey = null;
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
          const generation = tab._connectionGeneration || 0, nativeId = this.ptyId(tab);
          T.invoke('complete_input', { line: inputLine, caret: inputLine.length }).then((res) => {
            if (!this.isLive(tab) || this.ptyId(tab) !== nativeId || (tab._connectionGeneration || 0) !== generation) return;
            // 无候选时把 Tab 交还给 shell（PuTTY/普通终端习惯：shell 自身补全），不能吞键
            if (!res.items.length) { this.writeTo(tab, '\t'); return; }
            if (res.items.length === 1) { applyDiff(res, res.items[0]); return; }
            pop = { items: res.items.slice(0, 12), start: res.start, sel: 0, generation: tab._connectionGeneration };
            renderPop();
          }).catch(() => { if (this.isLive(tab) && this.ptyId(tab) === nativeId && (tab._connectionGeneration || 0) === generation) this.writeTo(tab, '\t'); });
          return false;
        }
        return true;
      });

      this.orderWrites(id);
      this.activate(id);
      this.consumePendingEvents(tab, id);
      this.endConnection();
      // SSH 连接后准备 SFTP 路径；由工具栏点击打开，不遮住新终端。
      if (proto === 'ssh' && this.isLive(tab) && window.UI && typeof UI.onSshConnected === 'function') UI.onSshConnected(tab);
      // PuTTY 习惯：会话输出落盘（设置页开关；仅对新会话生效）
      if (T.s.sessionLog) this.startLog(tab);
      this.renderTabbar();
      UI.log(`会话已创建 ${id.slice(0, 8)} ${session && session.name ? '· ' + session.name : ''}`);
      return tab;
    },

    orderWrites(id) { /* reserved for future output ordering */ },

    activate(id, focusTerminal = true) {
      const t = this.tabs[id];
      if (!t) return;
      if (window.UI?.closeDock) UI.closeDock();
      this.active = id;
      this.group = t.group;
      if (t.activity) { t.activity = false; this.renderTabbar(); }
      if (window.Home) Home.hide();
      if (window.Profiles && Profiles.isOpen()) Profiles.close();
      if (window.Settings && Settings.isOpen()) Settings.close();
      this.renderTabbar();
      this.markFocused();
      if (window.SftpPanel) SftpPanel.onSessionChange();
      this.workspaceState(t).activeId = id;
      this.renderWorkspace();
      requestAnimationFrame(() => {
        if (t._closing || this.tabs[id] !== t || this.active !== id) return;
        // 分屏和换轴后，两侧终端都需要按各自窗格重新计算行列。
        for (const x of Object.values(this.tabs)) {
          if (x.wrap.style.display !== 'none') { try { x.fit.fit(); } catch (e) {} }
        }
        if (focusTerminal) t.term.focus();
        UI.status(); UI.renderOutline();
      });
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
        if (tab._closing || this.tabs[tab.id] !== tab) {
          await T.invoke('session_log_stop', { id: tab.id });
          return;
        }
        tab.logging = true;
        tab.logBuf = '';
        UI.log('会话日志已开启：' + tab.logPath);
      } catch (e) { UI.log('会话日志开启失败：' + e); }
    },

    async close(id) {
      const t = this.tabs[id];
      if (!t || t._closing) return;
      const nativeId = this.ptyId(t);
      t._closing = true;
      t._reconnectAttempt = null; t._reconnectPromise = null; t._reconnecting = false;
      t.ptyId = null; t.exited = true;
      window.OpsAgent?.checkTarget?.();
      t._resetInput?.(); t._reconnectKey = null;
      for (const subscription of t._inputSubscriptions || []) subscription?.dispose?.();
      t._inputSubscriptions = [];
      if (t.logging) {
        T.flushLogs(t);
        T.invoke('session_log_stop', { id }).catch(() => {});
        t.logging = false;
      }
      // Close the view immediately. Native cleanup must not keep a disposed
      // terminal accepting output, nor leave the UI waiting on a child process.
      clearTimeout(t._outputTimer);
      t._outputParts = [];
      this.clearHighlights(t);
      delete this.tabs[id];
      t.term.dispose();
      t.wrap.remove();
      this.order = this.order.filter((x) => x !== id);
      const remaining = this.workspaceTabs(t);
      if (remaining.length === 1) {
        const survivor = remaining[0];
        // 关闭父 pane 后仍保留标签名、固定状态和颜色。
        if (t.customTitle && !survivor.customTitle) { survivor.title = t.title; survivor.customTitle = true; }
        survivor.pinned ||= !!t.pinned; survivor.color ||= t.color;
        survivor.group = 0; this.hostEl(0).appendChild(survivor.wrap);
        const state = this.workspaceState(survivor); state.splitDir = null; state.ratio = null; state.activeId = survivor.id;
      } else if (!remaining.length) delete this.workspaces[this.workspaceId(t)];
      if (this.active === id) {
        this.active = remaining[0]?.id || this.order[this.order.length - 1] || null;
      }
      this.renderWorkspace();
      this.renderTabbar();
      if (this.active) this.activate(this.active);
      else if (window.Home) Home.show();
      UI.status();
      if (window.SftpPanel) SftpPanel.onSessionChange();
      try { if (nativeId) await T.invoke('kill', { id: nativeId }); }
      catch (e) { UI.log('会话清理失败：' + String(e)); }
    },

    // One xterm write at a time, coalescing short IPC bursts. Preserve order and
    // all output; callbacks from a closed tab can never re-enter its renderer.
    receiveOutput(tab, data, options = {}) {
      if (tab._closing || this.tabs[tab.id] !== tab || !data) return;
      (tab._outputParts ||= []).push(options.triggers === false ? { data, triggers: false } : data);
      if (!tab._outputWriting && !tab._outputTimer)
        tab._outputTimer = setTimeout(() => this.flushOutput(tab), 16);
    },
    flushOutput(tab) {
      tab._outputTimer = null;
      if (tab._closing || this.tabs[tab.id] !== tab || tab._outputWriting) return;
      const parts = tab._outputParts || [];
      let index = tab._outputIndex || 0, length = 0;
      const batch = [], triggerParts = []; let hasTriggerData = false;
      const append = (value, triggers) => {
        batch.push(value);
        if (triggers) { hasTriggerData = true; triggerParts.push(value); }
        else triggerParts.push('\n'); // Keep genuine output on either side separate.
      };
      while (index < parts.length && length < 65536) {
        const entry = parts[index], part = typeof entry === 'string' ? entry : entry.data, triggers = typeof entry === 'string' || entry.triggers !== false, room = 65536 - length;
        if (part.length <= room) { index++; append(part, triggers); length += part.length; }
        else {
          let take = room;
          // A UTF-16 emoji must not be cut between its surrogate code units.
          const lead = part.charCodeAt(take - 1), trail = part.charCodeAt(take);
          if (lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff) take--;
          if (take) { append(part.slice(0, take), triggers); parts[index] = triggers ? part.slice(take) : { data: part.slice(take), triggers: false }; length += take; }
          break;
        }
      }
      if (index === parts.length) { tab._outputParts = []; tab._outputIndex = 0; }
      else if (index > 256) { tab._outputParts = parts.slice(index); tab._outputIndex = 0; }
      else tab._outputIndex = index;
      if (!batch.length) return;
      const data = batch.join('');
      tab._outputWriting = true;
      tab.term.write(data, () => {
        tab._outputWriting = false;
        if (tab._closing || this.tabs[tab.id] !== tab) return;
        this.runHighlights(tab);
        if ((tab._outputParts || []).length > (tab._outputIndex || 0))
          tab._outputTimer = setTimeout(() => this.flushOutput(tab), 0);
      });
      if (hasTriggerData) this.runTriggers(tab, triggerParts.join(''));
    },

    renderTabbar() {
      // Tabby 风格：窗口级单标签条（src/tabbar.js）；旧分组内标签条已废弃
      if (window.TabBar) TabBar.render();
    },

    /* ---------- Tabby 风格标签 API（tabbar.js 消费；0.6.0） ---------- */
    // toIndex：tabbar.js 契约——先从 order 移除 id，再插入到剩余数组的 toIndex 处（可等于长度=尾部）
    moveTab(id, toIndex) {
      const workspace = this.workspaceTab(id); if (!workspace) return;
      const ids = this.displayOrder().filter(x => x !== workspace.id);
      let index = typeof toIndex === 'string' ? ids.indexOf(toIndex) : toIndex;
      index = Math.max(0, Math.min(ids.length, Number.isFinite(index) ? index : 0));
      ids.splice(index, 0, workspace.id);
      this.order = ids.flatMap(x => this.workspaceTabs(x).map(t => t.id));
      this.renderTabbar();
    },
    displayOrder() {
      const seen = new Set(), ids = [];
      for (const id of this.order) {
        const t = this.tabs[id]; if (!t) continue;
        const workspace = this.workspaceId(t); if (seen.has(workspace)) continue;
        seen.add(workspace); ids.push(id);
      }
      return ids.filter(x => this.tabs[x].pinned).concat(ids.filter(x => !this.tabs[x].pinned));
    },
    renameTab(id, title) {
      const t = this.workspaceTab(id); if (!t || !title) return;
      t.title = String(title).slice(0, 28); t.customTitle = true;
      this.renderPaneControls(); this.renderTabbar();
    },
    setTabColor(id, color) {
      const t = this.workspaceTab(id); if (!t) return;
      t.color = color || null; this.renderTabbar();
    },
    togglePin(id) {
      const t = this.workspaceTab(id); if (!t) return;
      t.pinned = !t.pinned; this.renderTabbar();
    },
    toggleNotify(id) {
      const t = this.workspaceTab(id); if (!t) return;
      t.notify = !t.notify; this.renderTabbar();
    },
    async duplicate(id) {
      const t = this.tabs[id]; if (!t) return;
      return this.create(t.session || null);
    },
    async closeTab(id) {
      // Start all pane cleanup together; an SSH/native cleanup cannot delay removal of a sibling view.
      return Promise.allSettled(this.workspaceTabs(id).map(t => this.close(t.id)));
    },
    async closeOthers(id) {
      const key = this.workspaceId(this.tabs[id]);
      return Promise.allSettled(this.displayOrder().filter(x => this.workspaceId(this.tabs[x]) !== key).map(x => this.closeTab(x)));
    },
    async closeRight(id) {
      const disp = this.displayOrder(), representative = this.workspaceTab(id);
      const index = representative ? disp.indexOf(representative.id) : -1;
      if (index >= 0) return Promise.allSettled(disp.slice(index + 1).map(x => this.closeTab(x)));
    },
    async closeLeft(id) {
      const disp = this.displayOrder(), representative = this.workspaceTab(id);
      const index = representative ? disp.indexOf(representative.id) : -1;
      if (index >= 0) return Promise.allSettled(disp.slice(0, index).map(x => this.closeTab(x)));
    },
    async splitActive(dir) {
      const cur = this.activeTab(); if (!cur) return;
      const state = this.workspaceState(cur), workspaceId = this.workspaceId(cur);
      if (state.connecting) return;
      if (this.workspaceTabs(cur).length > 1) {
        this.split((dir === 'right' || dir === 'left') ? 'h' : 'v');
        this.focusNextGroup(); return;
      }
      state.connecting = true;
      state.splitDir = (dir === 'right' || dir === 'left') ? 'h' : 'v'; state.ratio = null;
      const existingGroup = (dir === 'left' || dir === 'up') ? 1 : 0;
      try {
        const created = await this.create(cur.session || null, { group: existingGroup === 1 ? 0 : 1, workspaceId, sourceId: cur.id, moveExistingTo: existingGroup });
        if (!created && this.tabs[cur.id]) {
          cur.group = 0; this.hostEl(0).appendChild(cur.wrap); state.splitDir = null;
          if (this.workspaceId(this.activeTab()) === workspaceId) this.renderWorkspace();
        }
        if (created) UI.log('标签内分屏：' + dir);
        return created;
      } finally { state.connecting = false; }
    },
    newLocal() { return this.create(null); },
    openHome() { if (window.Home) Home.show(); },
    closeHome() { if (window.Home) Home.hide(); },
    async split(dir) {
      const state = this.workspaceState(); if (!state) return;
      state.splitDir = dir; state.ratio = null; this.renderWorkspace();
      if (this.active) this.activate(this.active);
    },
    unsplit(silent) {
      const active = this.activeTab(); if (!active) return;
      const peers = this.workspaceTabs(active), state = this.workspaceState(active);
      delete this.workspaces[this.workspaceId(active)];
      // Keep every live session: detach the other pane as an independent top-level tab.
      for (const t of peers) {
        t.workspaceId = t.id; t.group = 0; this.hostEl(0).appendChild(t.wrap);
        this.workspaces[t.id] = { splitDir: null, ratio: null, activeId: t.id };
      }
      state.splitDir = null; state.ratio = null;
      this.renderWorkspace(); this.renderTabbar();
      if (this.active) this.activate(this.active);
      if (!silent) UI.log('已将分屏恢复为独立标签');
    },
    focusNextGroup() {
      if (!this.splitDir) { UI.toast('当前未分屏'); return; }
      const other = this.workspaceTabs(this.active).find(t => t.id !== this.active);
      if (other) this.activate(other.id);
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
      // 原生弹出的 select 菜单使用浏览器/系统控件；显式写入以同步 WebView。
      document.documentElement.style.colorScheme = v['--color-scheme'];
      for (const t of Object.values(this.tabs)) {
        if (t._closing) continue;
        if (window.Appearance) Appearance.syncTerminal(t, THEMES[name].term);
        else t.term.options.theme = THEMES[name].term;
        try { t.fit.fit(); } catch (e) {}
      }
      if (window.Appearance) Appearance.apply();
      T.persistSettings();
      UI.status();
      if (window.Settings && Settings.isOpen()) Settings.render();
    },

    findByPty(id) {
      if (!id) return null;
      // A stable UI ID equal to the *old* PTY must not accept late events.
      return Object.values(this.tabs).find(tab => !tab._closing && this.ptyId(tab) === id) || null;
    },

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

    /* ---- triggers engine — 后端语义引擎（re/triggers.rs）优先，v0 本地回退 ---- */
    runTriggers(tab, data) {
      if (!this.isLive(tab) || !T.s.triggers.length) return;
      const nativeId = this.ptyId(tab), generation = tab._connectionGeneration || 0;
      const current = () => this.isLive(tab) && this.ptyId(tab) === nativeId && (tab._connectionGeneration || 0) === generation;
      T.invoke('triggers_feed', { data }).then((acts) => {
        if (!current()) return;
        for (const a of acts || []) {
          if (a.action === 'send') {
            this.writeTo(tab, a.text);
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
      }).catch(() => { if (current()) this.runTriggersV0(tab, data); });
    },

    highlightHit(tab) {
      if (tab._closing) return;
      try {
        const m = tab.term.registerMarker(0);
        if (!m) return;
        const d = tab.term.registerDecoration({ marker: m, x: 1, width: Math.max(1, tab.term.cols - 2), foregroundColor: THEMES[T.s.theme]?.vars['--warn'] || '#e3d44a' });
        if (!d) { m.dispose(); return; }
        d.onRender((el) => el.classList.add('wt-hit'));
        const entry = { d, m };
        (tab._hitHighlights ||= new Set()).add(entry);
        entry.timer = setTimeout(() => { d.dispose(); m.dispose(); tab._hitHighlights.delete(entry); }, 4000);
      } catch (e) {}
    },

    /* Highlight parsed terminal cells, not estimated raw output lines. */
    HIGHLIGHT_RULES: [
      { kind: 'err', re: /\b(error|errors|failed|failure|fatal|panic|denied|refused|rejected)\b/i, cls: 'wt-hl-err' },
      { kind: 'warn', re: /\b(warn|warning|caution|timeout|timed out|deprecat)\b/i, cls: 'wt-hl-warn' },
      { kind: 'ok', re: /\b(ok|okay|success|succeeded|passed)\b/i, cls: 'wt-hl-ok' },
      { kind: 'addr', re: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|https?:\/\/[^\s'"]+/i, cls: 'wt-hl-addr' },
    ],

    highlightLine(tab, cls, offset, x, width) {
      try {
        const m = tab.term.registerMarker(offset);
        if (!m) return null;
        const tone = { 'wt-hl-err': '--danger', 'wt-hl-warn': '--warn', 'wt-hl-ok': '--ok', 'wt-hl-addr': null }[cls];
        const color = tone ? THEMES[T.s.theme]?.vars[tone] : '#5aa9ff';
        const d = tab.term.registerDecoration({ marker: m, x, width, foregroundColor: color || '#e3d44a' });
        if (!d) { m.dispose(); return null; }
        d.onRender((el) => el.classList.add(cls));
        return d;
      } catch (e) { return null; }
    },
    disposeHighlight(entry) {
      for (const d of entry.decorations) { d.dispose(); d.marker.dispose(); }
      entry.anchor.dispose();
    },
    clearHighlights(tab) {
      clearTimeout(tab._highlightTimer);
      for (const entry of tab._highlightEntries || []) this.disposeHighlight(entry);
      for (const entry of tab._hitHighlights || []) { clearTimeout(entry.timer); entry.d.dispose(); entry.m.dispose(); }
      tab._hitHighlights?.clear();
      tab._highlightEntries = []; tab._hls = []; tab._highlightTimer = null;
    },
    expireHighlights(tab) {
      clearTimeout(tab._highlightTimer);
      const now = Date.now();
      tab._highlightEntries = (tab._highlightEntries || []).filter((entry) => {
        if (entry.anchor.isDisposed) { this.disposeHighlight(entry); return false; }
        if (entry.expires <= now && entry.decorations.length) {
          for (const d of entry.decorations) { d.dispose(); d.marker.dispose(); }
          entry.decorations = [];
        }
        return true; // retain visible row identity so faded text cannot relight
      });
      tab._hls = tab._highlightEntries.flatMap(e => e.decorations);
      const pending = tab._highlightEntries.filter(e => e.decorations.length);
      tab._highlightTimer = pending.length && !tab._closing
        ? setTimeout(() => this.expireHighlights(tab), Math.max(1, Math.min(...pending.map(e => e.expires)) - now)) : null;
    },
    runHighlights(tab) {
      if (tab._closing || T.s.builtinHighlight === false) { this.clearHighlights(tab); return; }
      const term = tab.term, buffer = term.buffer.active;
      if (buffer.type === 'alternate') { this.clearHighlights(tab); return; }
      if (!buffer.getLine) return;
      this.expireHighlights(tab);
      const cursor = buffer.baseY + buffer.cursorY;
      // Bound work to the bottom viewport; use isWrapped and actual cell widths
      // for ANSI, CJK, emoji and words split over multiple visual rows.
      const last = Math.min(buffer.length - 1, buffer.baseY + (term.rows || 24) - 1);
      let first = Math.max(buffer.baseY, last - 119);
      while (first > 0 && last - first < 119 && buffer.getLine(first)?.isWrapped) first--;
      tab._highlightEntries = tab._highlightEntries.filter(entry => {
        if (entry.anchor.line >= first && entry.anchor.line <= last) return true;
        this.disposeHighlight(entry); return false;
      });
      for (let row = first; row <= last;) {
        const start = row, lines = []; let text = '';
        do {
          const line = buffer.getLine(row); if (!line) break;
          const wrappedNext = row < last && buffer.getLine(row + 1)?.isWrapped;
          const value = line.translateToString(!wrappedNext, 0, term.cols);
          lines.push({ row, line, value }); text += value; row++;
        } while (row <= last && buffer.getLine(row)?.isWrapped);
        if (row === start) break;
        const old = tab._highlightEntries.find(e => e.anchor.line === start);
        if (old?.text === text) continue;
        if (old) { this.disposeHighlight(old); tab._highlightEntries.splice(tab._highlightEntries.indexOf(old), 1); }
        const rule = this.HIGHLIGHT_RULES.find(r => r.re.test(text));
        if (!rule) continue;
        const match = rule.re.exec(text), anchor = term.registerMarker(start - cursor);
        if (!anchor) continue;
        const decorations = []; let offset = 0;
        for (const item of lines) {
          const left = Math.max(0, match.index - offset), right = Math.min(item.value.length, match.index + match[0].length - offset);
          offset += item.value.length;
          if (right <= left) continue;
          let chars = 0, x = -1, end = 0;
          const reuse = buffer.getNullCell?.();
          for (let col = 0; col < term.cols; col++) {
            const cell = item.line.getCell(col, reuse); if (!cell) break;
            const width = cell.getWidth(); if (!width) continue;
            const next = chars + (cell.getChars() || ' ').length;
            if (next > left && chars < right) { if (x < 0) x = col; end = col + width; }
            chars = next; if (chars >= right) break;
          }
          if (x >= 0) { const d = this.highlightLine(tab, rule.cls, item.row - cursor, x, end - x); if (d) decorations.push(d); }
        }
        if (decorations.length) tab._highlightEntries.push({ anchor, text, decorations, expires: Date.now() + 6000 });
        else anchor.dispose();
      }
      while (tab._highlightEntries.reduce((n, e) => n + e.decorations.length, 0) > 240)
        this.disposeHighlight(tab._highlightEntries.shift());
      this.expireHighlights(tab);
    },

    runTriggersV0(tab, data) {
      if (!this.isLive(tab)) return;
      const rules = T.s.triggers.filter((r) => r.enabled !== false);
      if (!rules.length) return;
      for (const r of rules) {
        let re; try { re = new RegExp(r.pattern); } catch (e) { continue; }
        if (!re.test(data)) continue;
        if (r.action === 'highlight') this.highlightHit(tab);
        else if (r.action === 'bell') UI.beep();
        else if (r.action === 'send') this.writeTo(tab, (r.arg || '') + '\r');
        UI.log(`触发器「${r.name || r.pattern}」命中`);
      }
    },

    broadcast(text, toAll) {
      const targets = (toAll ? Object.values(this.tabs) : [this.activeTab()].filter(Boolean)).filter(t => this.isLive(t));
      for (const t of targets) this.writeTo(t, text);
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
