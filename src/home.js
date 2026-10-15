/* hurricaneTerm — Home：Tabby 风格「主页 / 快速连接」启动页。
 * 原创代码 (Apache-2.0)。界面参考 Tabby 的连接选择与配置表单，
 * 未复制其代码；使用本工程的主题变量、quick-connect.css 和既有 WT/UI 约定。
 *
 * 依赖（均为运行期惰性取用，未加载时防御降级）：
 *   window.WT   — core.js：T.s.sessions / T.persistSessions() / T.term.create()
 *   window.UI   — ui.js：toast()
 *   window.Profiles — profiles.js（并行开发）：openManager() / edit(session)
 *
 * 导出：window.Home = { mount(containerEl), show(), hide(), render() }
 * 约定：当 T.term.order 为空时由父层调用 Home.show()。
 */
(function () {
  'use strict';

  /* ---------------- 常量与工具 ---------------- */

  const UNGROUPED = '未分组';

  const PROTOCOLS = [
    { value: 'ssh', label: 'SSH', icon: 'lock', placeholder: 'user@host[:port] 或 example.com', description: '通过 SSH 安全连接远程机器。', defaultPort: 22 },
    { value: 'telnet', label: 'Telnet', icon: 'telnet', placeholder: 'host[:port] 或 192.168.1.1', description: '连接路由器、交换机等 Telnet 控制台。', defaultPort: 23 },
    { value: 'serial', label: '串口', icon: 'serial', placeholder: '/dev/ttyUSB0 或 COM3', description: '连接本机串口设备。串口参数可在机器编辑器中设置。' },
    { value: 'tcp', label: 'TCP', icon: 'globe', placeholder: 'host:port，如 127.0.0.1:8080', description: '连接原始 TCP 服务或调试端口，必须指定端口。' },
    { value: '', label: '本地', icon: 'terminal', placeholder: '使用系统默认 shell', description: '打开本机终端，使用系统默认 shell。' },
  ];
  const PROTO_BY_VALUE = {};
  for (const p of PROTOCOLS) PROTO_BY_VALUE[p.value] = p;

  const GLYPHS = {
    terminal: '<path d="m4 5 3 3-3 3m5 0h3"/><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/>',
    lock: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2m-3 3v1"/>',
    telnet: '<path d="m5 3-4 5 4 5m6-10 4 5-4 5M9 3 7 13"/>',
    serial: '<rect x="2" y="4" width="12" height="8" rx="2"/><path d="M5 7h.01M8 7h.01M11 7h.01M6.5 9h.01M9.5 9h.01M4 2v2m8-2v2M4 12v2m8-2v2"/>',
    globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a12 12 0 0 1 0 12 12 12 0 0 1 0-12"/>',
    folder: '<path d="M1.5 4h4l1.5 2h7.5v7h-13z"/>',
    gear: '<path d="m6.5 2-.4 1.4-1.3.8-1.4-.3L2 6.3l1 1.1v1.2l-1 1.1 1.4 2.4 1.4-.3 1.3.8.4 1.4h3l.4-1.4 1.3-.8 1.4.3L14 9.7l-1-1.1V7.4l1-1.1-1.4-2.4-1.4.3-1.3-.8L9.5 2z"/><circle cx="8" cy="8" r="2"/>',
    arrowRight: '<path d="M3 8h10m-4-4 4 4-4 4"/>',
  };
  function svg(name) {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (GLYPHS[name] || GLYPHS.terminal) + '</svg>';
  }

  function iconOf(protocol) {
    const p = PROTO_BY_VALUE[(protocol || '').toLowerCase()];
    return p ? p.icon : 'terminal';
  }
  function svgOf(protocol) {
    return svg(iconOf(protocol));
  }
  function labelOf(protocol) {
    const p = PROTO_BY_VALUE[(protocol || '').toLowerCase()];
    return p ? p.label : '本地';
  }

  const T = () => window.WT;
  function toast(msg) {
    const u = window.UI || (window.WT && window.WT.ui);
    if (u && typeof u.toast === 'function') u.toast(msg);
    else console.warn('[home]', msg);
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 仅接受安全颜色串（#hex / rgb() / rgba()），防 CSS 注入
  function safeColor(c) {
    if (typeof c !== 'string') return '';
    return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/.test(c.trim()) ? c.trim() : '';
  }

  function parsePort(s) {
    const n = parseInt(s, 10);
    return String(n) === s.trim() && n > 0 && n <= 65535 ? n : null;
  }

  // 解析 [[user@]host[:port]]；带端口的 IPv6 使用方括号；失败返回 null
  function parseAddr(raw) {
    let rest = (raw || '').trim();
    let user = '';
    const at = rest.indexOf('@');
    if (at !== -1) {
      user = rest.slice(0, at); rest = rest.slice(at + 1);
      if (!user || /[\s@]/.test(user) || rest.includes('@')) return null;
    }
    if (!rest || /\s/.test(rest)) return null;
    let host = rest, port = null;
    if (rest[0] === '[') {
      const c = rest.indexOf(']');
      if (c === -1) return null;
      host = rest.slice(1, c);
      const tail = rest.slice(c + 1);
      if (tail.length) {
        if (tail[0] !== ':') return null;
        port = parsePort(tail.slice(1));
        if (port == null) return null;
      }
    } else {
      const colons = (rest.match(/:/g) || []).length;
      if (colons > 1) { host = rest; }            // 无括号 IPv6：整体视为 host
      else if (colons === 1) {
        const ci = rest.lastIndexOf(':');
        const p = parsePort(rest.slice(ci + 1));
        if (p != null) { host = rest.slice(0, ci); port = p; }
        else if (rest.slice(ci + 1) !== '') return null; // host:abc 视为非法
        else host = rest.slice(0, ci);                    // host: 视为 host
      }
    }
    if (!host) return null;
    return { user, host, port };
  }

  function addrLabel(user, host, port) {
    return (user ? user + '@' : '') + (host.includes(':') ? '[' + host + ']' : host) + (port ? ':' + port : '');
  }

  // session → 副行文案
  function subOf(s) {
    const proto = (s.protocol || '').toLowerCase();
    if (proto === 'serial') return s.target || s.host || '串口';
    if (proto === 'tcp') return s.target || (s.host ? addrLabel('', s.host, s.port) : 'TCP');
    if (proto === 'ssh' || proto === 'telnet') {
      return s.host ? addrLabel(s.user, s.host, s.port) : labelOf(proto);
    }
    const cmd = s.command ? s.command + (s.args && s.args.length ? ' ' + s.args.join(' ') : '') : '';
    return cmd || '默认 shell';
  }

  /* ---------------- Home 模块 ---------------- */

  const Home = {
    el: null,
    listEl: null,
    hintEl: null,
    inputEl: null,
    protoEl: null,
    mounted: false,

    mount(containerEl) {
      if (!containerEl) return;
      if (this.mounted && this.el === containerEl) { this.render(); return; }
      this.el = containerEl;
      this.el.classList.add('ht-home');
      this.el.replaceChildren();
      this.drafts = Object.create(null);
      this.activeProtocol = 'ssh';
      this.view = 'saved';
      this._sessionKeys = new WeakMap();
      this._nextKey = 0;
      const inner = h('div', 'ht-home-inner');
      const header = h('header', 'ht-home-header');
      const brand = h('div', 'ht-home-brand');
      const mascot = h('img', 'ht-home-mascot');
      mascot.src = 'huricano-icon.png'; mascot.alt = 'Huricano';
      mascot.width = mascot.height = 40; mascot.draggable = false;
      const heading = h('div', 'ht-home-heading');
      heading.append(h('h1', 'ht-home-title', '新建连接'), h('p', 'ht-home-tagline', '选择连接类型，或打开已保存的机器'));
      brand.append(mascot, heading); header.append(brand);
      const actions = h('div', 'ht-home-actions');
      const action = (label, icon, run) => {
        const btn = h('button', 'ht-home-action'); btn.type = 'button';
        btn.innerHTML = svg(icon); btn.append(h('span', null, label)); btn.onclick = run;
        actions.append(btn);
      };
      action('本地终端', 'terminal', () => this.connect({ name: '本地终端', protocol: '' }));
      action('机器与连接', 'folder', () => this.openProfiles());
      action('设置', 'gear', () => {
        if (typeof window.Settings?.open === 'function') Settings.open();
        else toast('设置模块未加载');
      });
      header.append(actions); inner.append(header);
      const columns = h('div', 'ht-home-columns');
      const card = h('section', 'ht-home-connect-card');
      card.setAttribute('aria-label', '快速连接');
      card.append(h('h2', 'ht-home-card-title', '快速连接'));
      const form = h('form', 'ht-home-quick');
      form.noValidate = true;
      // This select is the existing protocol data interface. Accessible protocol
      // tabs replace its visual presentation without adding a second combobox.
      const sel = h('select'); sel.setAttribute('aria-label', '连接协议');
      sel.setAttribute('data-native-select', ''); sel.hidden = true; sel.tabIndex = -1;
      for (const p of PROTOCOLS) sel.append(new Option(p.label, p.value));
      sel.value = 'ssh'; this.protoEl = sel;
      form.append(sel);
      const protocols = h('div', 'ht-home-protocols');
      protocols.setAttribute('role', 'tablist'); protocols.setAttribute('aria-label', '连接类型');
      this.protocolButtons = [];
      for (const p of PROTOCOLS) {
        const btn = h('button', 'ht-home-protocol'); btn.type = 'button';
        btn.dataset.protocol = p.value; btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-controls', 'ht-home-connection-fields');
        btn.id = 'ht-home-protocol-' + (p.value || 'local');
        btn.innerHTML = svg(p.icon); btn.append(h('span', null, p.label));
        btn.onclick = () => this.selectProtocol(p.value);
        btn.onkeydown = e => {
          const index = this.protocolButtons.indexOf(btn);
          const next = e.key === 'ArrowRight' ? (index + 1) % PROTOCOLS.length
            : e.key === 'ArrowLeft' ? (index + PROTOCOLS.length - 1) % PROTOCOLS.length
            : e.key === 'Home' ? 0 : e.key === 'End' ? PROTOCOLS.length - 1 : null;
          if (next !== null) { e.preventDefault(); this.selectProtocol(PROTOCOLS[next].value); this.protocolButtons[next].focus(); }
        };
        this.protocolButtons.push(btn); protocols.append(btn);
      }
      form.append(protocols);
      this.descriptionEl = h('p', 'ht-home-description'); form.append(this.descriptionEl);
      const fields = h('div', 'ht-home-fields'); fields.id = 'ht-home-connection-fields';
      fields.setAttribute('role', 'tabpanel'); this.fieldsEl = fields;
      const field = (label, id, placeholder, className = '') => {
        const box = h('div', 'ht-home-field ' + className);
        const lbl = h('label', null, label); lbl.htmlFor = id;
        const input = h('input'); input.id = id; input.placeholder = placeholder;
        input.spellcheck = false; input.autocomplete = 'off'; input.setAttribute('aria-describedby', 'ht-home-hint');
        box.append(lbl, input); return { box, input, label: lbl };
      };
      const addr = field('连接地址', 'ht-home-address', PROTO_BY_VALUE.ssh.placeholder);
      addr.input.setAttribute('aria-label', '连接地址或串口设备'); this.inputEl = addr.input; this.addressLabelEl = addr.label;
      fields.append(addr.box);
      const extra = h('div', 'ht-home-extra-fields');
      const user = field('用户名（可选）', 'ht-home-user', '自动使用地址中的用户名');
      this.userEl = user.input; this.userFieldEl = user.box;
      const port = field('端口（可选）', 'ht-home-port', '22');
      port.input.inputMode = 'numeric'; this.portEl = port.input; this.portFieldEl = port.box; this.portLabelEl = port.label;
      extra.append(user.box, port.box); fields.append(extra); form.append(fields);
      this.hintEl = h('div', 'ht-home-hint'); this.hintEl.id = 'ht-home-hint';
      this.hintEl.setAttribute('aria-live', 'polite'); form.append(this.hintEl);
      const controls = h('div', 'ht-home-connect-controls');
      const save = h('button', 'ht-home-save', '存为机器'); save.type = 'button'; save.onclick = () => this.saveAsMachine();
      const connect = h('button', 'ht-home-connect primary'); connect.type = 'submit';
      connect.innerHTML = svg('arrowRight'); connect.append(h('span', null, '连接'));
      this.connectEl = connect; controls.append(save, connect); form.append(controls);
      form.onsubmit = e => { e.preventDefault(); this.quickConnect(); };
      sel.onchange = () => this.applyProtocol();
      for (const input of [this.inputEl, this.userEl, this.portEl]) {
        input.oninput = () => this.updateHint();
        input.onkeydown = e => {
          if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.quickConnect(); }
        };
      }
      card.append(form);
      const saved = h('section', 'ht-home-saved-card');
      saved.setAttribute('aria-label', '已保存的连接');
      const savedHead = h('div', 'ht-home-saved-head');
      savedHead.append(h('h2', 'ht-home-card-title', '机器与连接'));
      this.countEl = h('span', 'ht-home-count'); savedHead.append(this.countEl); saved.append(savedHead);
      const search = h('div', 'ht-home-search');
      const searchIcon = h('span'); searchIcon.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>';
      this.searchEl = h('input'); this.searchEl.type = 'search'; this.searchEl.placeholder = '搜索名称、地址或分组';
      this.searchEl.setAttribute('aria-label', '搜索已保存的连接'); this.searchEl.spellcheck = false;
      this.searchEl.oninput = () => this.render();
      this.searchEl.onkeydown = e => {
        const rows = Array.from(this.listEl.querySelectorAll('.ht-home-row:not(:disabled)'));
        if (e.key === 'ArrowDown' && rows.length) { e.preventDefault(); rows[0].focus(); }
        else if (e.key === 'Enter' && !e.isComposing && rows.length) { e.preventDefault(); rows[0].click(); }
      };
      search.append(searchIcon, this.searchEl); saved.append(search);
      const filters = h('div', 'ht-home-list-filters'); filters.setAttribute('role', 'tablist'); filters.setAttribute('aria-label', '连接列表');
      this.filterButtons = [];
      for (const [view, label] of [['saved', '已保存'], ['recent', '最近使用']]) {
        const button = h('button', 'ht-home-list-filter', label); button.type = 'button'; button.dataset.view = view;
        button.id = 'ht-home-list-filter-' + view;
        button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'ht-home-saved-list');
        button.onclick = () => { this.view = view; this.render(); };
        button.onkeydown = e => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const other = this.filterButtons.find(b => b !== button); other.click(); other.focus(); }
        };
        this.filterButtons.push(button); filters.append(button);
      }
      saved.append(filters);
      this.listEl = h('div', 'ht-home-list'); this.listEl.id = 'ht-home-saved-list';
      this.listEl.setAttribute('role', 'tabpanel'); saved.append(this.listEl);
      columns.append(card, saved); inner.append(columns);
      inner.append(h('div', 'ht-home-foot', 'Enter 连接 · ↑↓ 选择机器 · Esc 返回终端'));
      this.el.append(inner);
      this.el.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          const t = T();
          if (t?.term?.order.length) { e.preventDefault(); this.hide(); t.term.activeTab?.()?.term?.focus(); }
        }
      });
      this.mounted = true;
      this.applyProtocol(); this.render();
    },

    show() {
      if (!this.el) return;
      if (window.SftpPanel?.isOpen() && !SftpPanel.hide()) return;
      if (window.Profiles && Profiles.isOpen()) Profiles.close();
      const S = window.Settings;
      if (S && typeof S.isOpen === 'function' && S.isOpen() && typeof S.close === 'function') S.close();
      this.el.hidden = false;            // 全局 [hidden]{display:none!important} 会压死 inline display，必须先清属性
      this.el.style.display = 'flex';
      this.render();
      if (this.inputEl && !this.inputEl.disabled) { try { this.inputEl.focus(); } catch (e) {} }
    },

    hide() {
      if (this.el) { this.el.style.display = 'none'; this.el.hidden = true; }
    },

    selectProtocol(value) {
      if (this._connecting) return;
      this.protoEl.value = value;
      this.protoEl.dispatchEvent(new Event('change', { bubbles: true }));
    },

    applyProtocol() {
      const p = PROTO_BY_VALUE[this.protoEl.value] || PROTO_BY_VALUE[''];
      if (this.activeProtocol !== p.value) {
        this.drafts[this.activeProtocol] = { address: this.inputEl.value, user: this.userEl.value, port: this.portEl.value };
        const draft = this.drafts[p.value] || { address: '', user: '', port: '' };
        this.inputEl.value = draft.address; this.userEl.value = draft.user; this.portEl.value = draft.port;
        this.activeProtocol = p.value;
      }
      this.inputEl.placeholder = p.placeholder;
      this.descriptionEl.textContent = p.description;
      this.addressLabelEl.textContent = p.value === 'serial' ? '串口设备' : p.value === '' ? '本地终端' : '连接地址';
      this.userFieldEl.hidden = p.value !== 'ssh';
      this.portFieldEl.hidden = p.value === 'serial' || p.value === '';
      this.portEl.placeholder = p.defaultPort ? String(p.defaultPort) + '（默认）' : '必填，或在地址中指定';
      this.portLabelEl.textContent = p.value === 'tcp' ? '端口（或在地址中提供）' : '端口（可选）';
      this.fieldsEl.setAttribute('aria-labelledby', 'ht-home-protocol-' + (p.value || 'local'));
      for (const btn of this.protocolButtons) {
        const selected = btn.dataset.protocol === p.value;
        btn.classList.toggle('on', selected); btn.setAttribute('aria-selected', String(selected)); btn.tabIndex = selected ? 0 : -1;
      }
      this.setBusy(!!this._connecting); this.updateHint();
    },

    setBusy(busy) {
      if (!this.el) return;
      this.el.setAttribute('aria-busy', String(busy));
      for (const button of this.el.querySelectorAll('.ht-home-protocol, .ht-home-connect, .ht-home-save, .ht-home-row, .ht-home-action')) button.disabled = busy;
      const proto = this.protoEl.value;
      this.inputEl.disabled = busy || proto === '';
      this.userEl.disabled = busy || proto !== 'ssh';
      this.portEl.disabled = busy || proto === 'serial' || proto === '';
      this.connectEl.querySelector('span').textContent = busy ? '连接中…' : '连接';
    },

    // 从快速连接条构造 session；silent=true 时不弹 toast（供 hint 用）
    buildQuickSession(silent) {
      const proto = this.protoEl ? this.protoEl.value : 'ssh';
      const raw = this.inputEl ? this.inputEl.value.trim() : '';
      if (proto === '') return { name: '本地终端', protocol: '' };
      if (proto === 'serial') {
        if (!raw) { if (!silent) toast('请输入串口设备名，如 /dev/ttyUSB0'); return null; }
        return { name: raw, protocol: 'serial', target: raw };
      }
      const parsed = parseAddr(raw);
      if (!parsed) {
        if (!silent && raw) toast('无法解析地址：' + raw);
        return null;
      }
      const portText = this.portEl ? this.portEl.value.trim() : '';
      const explicitPort = portText ? parsePort(portText) : null;
      if (portText && explicitPort == null) {
        if (!silent) toast('端口必须是 1–65535 之间的整数');
        return null;
      }
      const explicitUser = proto === 'ssh' && this.userEl ? this.userEl.value.trim() : '';
      if (explicitUser && /[\s@]/.test(explicitUser)) {
        if (!silent) toast('用户名不能包含空格或 @');
        return null;
      }
      const user = explicitUser || parsed.user;
      const port = explicitPort || parsed.port || 0;
      if (proto === 'tcp' && !port) {
        if (!silent) toast('TCP 连接必须指定端口，请填写端口或使用 host:port');
        return null;
      }
      const label = addrLabel(user, parsed.host, port);
      const s = { name: label, protocol: proto, host: parsed.host, port };
      if (user) s.user = user;
      return s;
    },

    updateHint() {
      if (!this.hintEl) return;
      this.hintEl.classList.remove('bad');
      for (const input of [this.inputEl, this.userEl, this.portEl]) input.removeAttribute('aria-invalid');
      const proto = this.protoEl.value;
      if (proto === '') { this.hintEl.textContent = '将打开系统默认 shell'; return; }
      const raw = this.inputEl.value.trim();
      if (!raw) {
        this.hintEl.textContent = proto === 'serial' ? '输入设备路径；更多串口参数可用“存为机器”设置。'
          : proto === 'tcp' ? 'TCP 必须指定端口，可使用 host:port，或分别填写地址和端口。'
          : '支持 user@host:port；IPv6 可使用 [地址]:端口。';
        return;
      }
      const s = this.buildQuickSession(true);
      if (!s) {
        const tcpAddress = proto === 'tcp' ? parseAddr(raw) : null;
        const tcpMissingPort = !!tcpAddress && !tcpAddress.port && !this.portEl.value.trim();
        this.hintEl.textContent = tcpMissingPort ? 'TCP 连接必须指定端口：在地址后加 :端口，或填写下方端口。'
          : '请检查地址和用户名格式，端口应为 1–65535 的整数。';
        this.hintEl.classList.add('bad');
        const input = tcpMissingPort || (this.portEl.value.trim() && parsePort(this.portEl.value.trim()) == null) ? this.portEl
          : proto === 'ssh' && /[\s@]/.test(this.userEl.value.trim()) ? this.userEl : this.inputEl;
        input.setAttribute('aria-invalid', 'true'); return;
      }
      const defaultPort = PROTO_BY_VALUE[proto]?.defaultPort;
      let hint = '将连接 ' + s.name;
      if (proto !== 'serial' && !s.port && defaultPort) hint += ' · 默认端口 ' + defaultPort;
      if ((proto === 'ssh' && this.userEl.value.trim()) || (this.portEl.value.trim() && proto !== 'serial')) hint += ' · 独立字段优先';
      this.hintEl.textContent = hint;
    },

    // 非本地协议要求有输入；返回 false 表示已提示
    requireInput() {
      if (this.protoEl.value !== '' && !this.inputEl.value.trim()) {
        this.hintEl.textContent = this.protoEl.value === 'serial' ? '请输入串口设备名。' : '请输入连接地址。';
        this.hintEl.classList.add('bad'); this.inputEl.setAttribute('aria-invalid', 'true'); this.inputEl.focus();
        toast(this.protoEl.value === 'serial' ? '请输入串口设备名' : '请输入连接地址'); return false;
      }
      return true;
    },

    async quickConnect() {
      if (this._connecting || !this.requireInput()) return;
      const s = this.buildQuickSession(false);
      if (!s) return;
      await this.connect(s);
    },

    saveAsMachine() {
      if (this._connecting || !this.requireInput()) return;
      const s = this.buildQuickSession(false);
      if (!s) return;
      const P = window.Profiles;
      if (P && typeof P.edit === 'function') {
        try { P.edit(s); toast('已预填到机器编辑器'); }
        catch (e) { toast('打开机器编辑器失败：' + (e && e.message ? e.message : e)); }
      } else {
        toast('机器管理模块未加载（profiles.js）');
      }
    },

    openProfiles() {
      const P = window.Profiles;
      if (P && typeof P.openManager === 'function') {
        try { P.openManager(); }
        catch (e) { toast('打开机器管理失败：' + (e && e.message ? e.message : e)); }
      } else toast('机器管理模块未加载（profiles.js）');
    },

    // Only one creation may be in flight from this page. Keep drafts and controls
    // when creation fails, so retries cannot spawn a duplicate background session.
    async connect(session) {
      if (this._connecting) return null;
      const t = T();
      if (!t?.term || typeof t.term.create !== 'function') { toast('终端模块未加载'); return null; }
      this._connecting = true; this.setBusy(true);
      this.hintEl.classList.remove('bad'); this.hintEl.textContent = '正在连接 ' + (session.name || '本地终端') + '…';
      try {
        const tab = await t.term.create(session);
        if (tab) {
          // Production term.create writes lastUsed. Also support deferred bridge
          // providers that return a tab without updating saved connection metadata.
          if (!session.lastUsed) { session.lastUsed = Date.now(); t.persistSessions?.(); }
          this.updateHint(); this.hide(); t.ui?.log?.('主页连接：' + (session.name || ''));
        } else {
          this.hintEl.textContent = '连接未建立，请检查连接信息后重试。'; this.hintEl.classList.add('bad');
        }
        return tab;
      } catch (e) {
        const message = '连接失败：' + (e?.message || e);
        toast(message); this.hintEl.textContent = message; this.hintEl.classList.add('bad');
        return null;
      } finally {
        this._connecting = false; this.setBusy(false);
      }
    },

    /* ---------------- 渲染 ---------------- */

    render() {
      if (!this.mounted || !this.listEl) return;
      const focusedKey = document.activeElement?.closest('.ht-home-row')?.dataset.sessionKey;
      const t = T();
      const all = (t?.s && Array.isArray(t.s.sessions) ? t.s.sessions : []).filter(s => s && typeof s === 'object');
      const q = (this.searchEl?.value || '').trim().toLocaleLowerCase();
      const matches = all.filter(s => !q || [s.name, s.folder, subOf(s), labelOf(s.protocol)].join(' ').toLocaleLowerCase().includes(q));
      const items = this.view === 'recent' ? matches.filter(s => s.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 8) : matches;
      this.listEl.setAttribute('aria-labelledby', 'ht-home-list-filter-' + this.view);
      this.countEl.textContent = q ? items.length + ' / ' + all.length : String(items.length);
      for (const button of this.filterButtons) {
        const selected = button.dataset.view === this.view;
        button.classList.toggle('on', selected); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      }
      this.listEl.replaceChildren();
      if (!items.length) {
        const empty = h('div', 'ht-home-empty');
        empty.innerHTML = svg(q ? 'globe' : 'folder');
        empty.append(h('div', null, q ? '没有匹配的连接' : this.view === 'recent' ? '暂无最近使用的连接' : '还没有添加机器'));
        empty.append(h('p', null, q ? '试试机器名称、地址或分组。' : '使用快速连接，或保存常用的连接配置。'));
        const btn = h('button', null, q ? '清除搜索' : '添加机器'); btn.type = 'button';
        btn.onclick = () => { if (q) { this.searchEl.value = ''; this.render(); this.searchEl.focus(); } else this.openProfiles(); };
        empty.append(btn); this.listEl.append(empty);
      } else if (this.view === 'recent') {
        this.listEl.append(this.section('最近使用', items));
      } else {
        const groups = new Map();
        for (const s of items) { const key = s.folder || UNGROUPED; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); }
        const keys = Array.from(groups.keys()).sort((a, b) => a === b ? 0 : a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b, 'zh'));
        for (const key of keys) this.listEl.append(this.section(key, groups.get(key)));
      }
      this.setBusy(!!this._connecting);
      if (focusedKey) this.listEl.querySelector('[data-session-key="' + focusedKey + '"]')?.focus();
    },

    section(title, items) {
      const sec = h('div', 'ht-home-sec');
      const head = h('h2', 'ht-home-sechead', title);
      head.appendChild(h('span', 'ht-home-count', String(items.length)));
      sec.appendChild(head);
      for (const s of items) sec.appendChild(this.row(s));
      return sec;
    },

    row(s) {
      const r = h('button', 'ht-home-row');
      r.type = 'button';
      if (!this._sessionKeys.has(s)) this._sessionKeys.set(s, String(++this._nextKey));
      r.dataset.sessionKey = this._sessionKeys.get(s);
      const ico = h('span', 'ht-home-ico');
      ico.innerHTML = svgOf(s.protocol);
      r.appendChild(ico);
      const col = h('span', 'ht-home-col');
      col.appendChild(h('b', 'ht-home-name', s.name || '(未命名)'));
      col.appendChild(h('i', 'ht-home-rsub', subOf(s)));
      r.appendChild(col);
      const c = safeColor(s.color);
      if (c) {
        const dot = h('span', 'ht-home-dot');
        dot.style.background = c;
        r.appendChild(dot);
      }
      r.appendChild(h('span', 'ht-home-proto', labelOf(s.protocol)));
      const arrow = h('span', 'ht-home-arrow');
      arrow.innerHTML = svg('arrowRight');
      r.appendChild(arrow);
      r.title = '连接：' + (s.name || '') + '（' + subOf(s) + '）';
      r.setAttribute('aria-label', r.title);
      r.onclick = () => this.connect(s);
      r.onkeydown = e => {
        const rows = Array.from(this.listEl.querySelectorAll('.ht-home-row:not(:disabled)'));
        const index = rows.indexOf(r);
        const next = e.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1)
          : e.key === 'ArrowUp' ? index - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
        if (next !== null) { e.preventDefault(); if (next < 0) this.searchEl.focus(); else rows[next]?.focus(); }
        else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); r.click(); }
        else if (e.key === 'Backspace' && !this._connecting && typeof window.Profiles?.edit === 'function') { e.preventDefault(); Profiles.edit(s); }
      };
      return r;
    },

    isOpen() { return !!(this.el && !this.el.hidden); },
  };

  window.Home = Home;
})();
