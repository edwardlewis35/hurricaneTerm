/* hurricaneTerm — Home：Tabby 风格「主页 / 快速连接」启动页。
 * 原创代码 (Apache-2.0)。UI 形态参考 Tabby 的 start page + quick connect，
 * 未复制其任何代码；仅复用本工程 style.css 的 CSS 变量与既有 WT/UI 约定。
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
    { value: 'ssh',     label: 'SSH',  icon: 'lock',     placeholder: 'user@host[:port]，如 root@example.com:2222' },
    { value: 'telnet',  label: 'Telnet', icon: 'telnet', placeholder: 'host[:port]，如 192.168.1.1:23' },
    { value: 'serial',  label: '串口', icon: 'serial',   placeholder: '设备名，如 /dev/ttyUSB0 或 COM3' },
    { value: 'tcp',     label: 'TCP',  icon: 'globe',    placeholder: 'host:port，如 127.0.0.1:8080' },
    { value: '',        label: '本地', icon: 'terminal', placeholder: '本地 shell，无需输入' },
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

  // 解析 [[user@]host[:port]]；IPv6 需方括号；失败返回 null
  function parseAddr(raw) {
    let rest = (raw || '').trim();
    let user = '';
    const at = rest.indexOf('@');
    if (at !== -1) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
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
    return (user ? user + '@' : '') + host + (port ? ':' + port : '');
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

  /* ---------------- 样式（全部 .ht-home 前缀限定） ---------------- */

  const CSS = `
.ht-home { display: flex; flex-direction: column; align-items: center; height: 100%;
  overflow: auto; background: var(--bg); color: var(--fg); padding: clamp(40px, 9vh, 96px) 28px 32px; }
.ht-home-logo { text-align: center; margin-bottom: 26px; user-select: none; }
.ht-home-mascot { display: block; width: 72px; height: 72px; margin: 0 auto 10px; }
.ht-home-title { color: var(--fg3, var(--fg)); font-size: clamp(36px, 5vw, 52px); font-weight: 300;
  letter-spacing: -1.8px; line-height: 1.25; }
.ht-home-title b { color: inherit; font-weight: inherit; }
.ht-home-tagline { color: var(--fg2); font-size: 13px; margin-top: 9px; }
.ht-home-inner { width: 100%; max-width: 650px; }
.ht-home-actions { display: flex; justify-content: center; gap: 8px; margin: 0 0 38px; }
.ht-home-action { display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  padding: 8px 15px; border: 0; border-radius: var(--r-sm, 3px); background: transparent;
  color: var(--fg); font-weight: 400; }
.ht-home-action svg { width: 17px; height: 17px; color: var(--fg2); }
.ht-home-action:hover { background: var(--surface-hover); color: var(--fg3, var(--fg)); }
.ht-home-action:hover svg { color: var(--accent); }
.ht-home-action:active { background: var(--bg4, var(--bg2)); }
.ht-home-quickhead { margin: 0 0 9px; color: var(--fg2); font-size: 12px; font-weight: 400; }
.ht-home-quick { display: flex; align-items: stretch; gap: 0; }
.ht-home-quick select, .ht-home-quick input { background: var(--input-bg, var(--bg2)); color: var(--fg);
  border: 1px solid var(--border); border-radius: 0; padding: 7px 10px; font: inherit; min-height: 35px; }
.ht-home-quick select { width: 91px; flex: none; border-radius: var(--r-sm, 3px) 0 0 var(--r-sm, 3px); cursor: pointer; }
.ht-home-quick select option { background: var(--bg2); color: var(--fg); }
.ht-home-quick input { flex: 1; width: 0; min-width: 100px; border-left: 0; }
.ht-home-quick input::placeholder { color: var(--fg2); }
.ht-home-quick select:focus, .ht-home-quick input:focus { outline: none; border-color: var(--accent); }
.ht-home-quick input:disabled { opacity: .5; }
.ht-home-quick button { padding: 6px 15px; border-radius: 0 var(--r-sm, 3px) var(--r-sm, 3px) 0;
  border: 1px solid var(--border); border-left: 0; background: var(--surface); color: var(--accent); font-weight: 400; }
.ht-home-quick button:hover { background: var(--surface-hover); color: var(--accent); }
.ht-home-quick button:active { background: var(--bg4, var(--bg2)); }
.ht-home-quickfoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 29px; }
.ht-home-hint { font-size: 11px; color: var(--fg2); min-height: 16px; margin: 6px 0; }
.ht-home-hint.bad { color: var(--danger); }
.ht-home-save { flex: none; border: 0; background: transparent; color: var(--fg2); padding: 4px 0; font-size: 11px; }
.ht-home-save:hover { background: transparent; color: var(--accent); }
.ht-home-sec { margin-top: 24px; }
.ht-home-sechead { display: flex; justify-content: space-between; align-items: center; font-size: 12px;
  font-weight: 400; color: var(--fg2); padding: 0 10px 8px; border-bottom: 1px solid var(--border); margin: 0 0 3px; }
.ht-home-count { font-size: 11px; font-weight: 400; color: var(--fg2); }
.ht-home-row { display: flex; align-items: center; gap: 13px; width: 100%; padding: 9px 10px;
  background: transparent; color: var(--fg); border: 0; border-radius: var(--r-sm, 3px); text-align: left; cursor: pointer; }
.ht-home-row:hover { background: var(--surface-hover); color: var(--fg3, var(--fg)); }
.ht-home-row:active { background: var(--bg4, var(--bg2)); }
.ht-home-row:focus-visible, .ht-home-action:focus-visible, .ht-home-save:focus-visible {
  outline: 1px solid var(--accent); outline-offset: 2px; box-shadow: none; }
.ht-home-ico { width: 20px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--fg2); }
.ht-home-ico svg { width: 17px; height: 17px; }
.ht-home-row:hover .ht-home-ico { color: var(--accent); }
.ht-home-col { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ht-home-name { font-weight: 400; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ht-home-rsub { font-style: normal; font-size: 11px; color: var(--fg2); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.ht-home-proto { color: var(--fg2); font-size: 10px; flex: none; }
.ht-home-arrow { width: 14px; height: 14px; flex: none; color: var(--fg2); opacity: 0; }
.ht-home-arrow svg { width: 14px; height: 14px; }
.ht-home-row:hover .ht-home-arrow, .ht-home-row:focus-visible .ht-home-arrow { opacity: 1; }
.ht-home-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; border: 1px solid var(--border); }
.ht-home-empty { text-align: center; color: var(--fg2); padding: 38px 0 24px; font-size: 12px; line-height: 2; }
.ht-home-empty button { margin-top: 6px; background: transparent; color: var(--accent); border: 0; font-weight: 400; }
.ht-home-empty button:hover { background: var(--surface-hover); color: var(--accent); }
.ht-home-foot { margin-top: 28px; text-align: center; font-size: 10px; color: var(--fg2); user-select: none; }
@media (max-width: 560px) {
  .ht-home { padding: 34px 18px 24px; }
  .ht-home-actions { gap: 0; margin-bottom: 26px; flex-wrap: wrap; }
  .ht-home-action { padding: 8px 11px; font-size: 12px; }
  .ht-home-quick input { min-width: 60px; }
  .ht-home-quick button { padding: 6px 11px; }
  .ht-home-foot { line-height: 1.8; }
}
`;

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected || document.getElementById('ht-home-style')) { styleInjected = true; return; }
    const st = document.createElement('style');
    st.id = 'ht-home-style';
    st.textContent = CSS;
    document.head.appendChild(st);
    styleInjected = true;
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
      injectStyle();
      this.el.innerHTML = '';

      const frag = document.createDocumentFragment();

      // —— 1. logo 区 ——
      const logo = h('div', 'ht-home-logo');
      const mascot = h('img', 'ht-home-mascot');
      mascot.src = 'huricano-icon.png';
      mascot.alt = 'Huricano';
      mascot.width = mascot.height = 72;
      mascot.draggable = false;
      const title = h('h1', 'ht-home-title');
      title.style.margin = '0';
      title.append(document.createTextNode('hurricane'), h('b', null, 'Term'));
      logo.append(mascot, title, h('div', 'ht-home-tagline', '终端与远程连接'));
      frag.appendChild(logo);

      const inner = h('div', 'ht-home-inner');

      const actions = h('div', 'ht-home-actions');
      const action = (label, icon, run) => {
        const btn = h('button', 'ht-home-action');
        btn.type = 'button';
        btn.innerHTML = svg(icon);
        btn.appendChild(h('span', null, label));
        btn.onclick = run;
        actions.appendChild(btn);
      };
      action('新建本地终端', 'terminal', () => this.connect({ name: '本地终端', protocol: '' }));
      action('机器与连接', 'folder', () => this.openProfiles());
      action('设置', 'gear', () => {
        const S = window.Settings;
        if (S && typeof S.open === 'function') S.open();
        else toast('设置模块未加载');
      });
      inner.appendChild(actions);

      // —— 2. 快速连接条 ——
      inner.appendChild(h('h2', 'ht-home-quickhead', '快速连接'));
      const quick = h('div', 'ht-home-quick');
      const sel = h('select');
      sel.setAttribute('aria-label', '连接协议');
      for (const p of PROTOCOLS) sel.appendChild(new Option(p.label, p.value));
      sel.value = 'ssh';
      const input = h('input');
      input.setAttribute('aria-label', '连接地址或串口设备');
      input.placeholder = PROTO_BY_VALUE.ssh.placeholder;
      input.spellcheck = false;
      const btnConnect = h('button', 'primary', '连接');
      btnConnect.type = 'button';
      const btnSave = h('button', 'ht-home-save', '存为机器');
      btnSave.type = 'button';
      quick.append(sel, input, btnConnect);
      inner.appendChild(quick);

      const quickfoot = h('div', 'ht-home-quickfoot');
      this.hintEl = h('div', 'ht-home-hint');
      this.hintEl.setAttribute('aria-live', 'polite');
      quickfoot.append(this.hintEl, btnSave);
      inner.appendChild(quickfoot);
      this.protoEl = sel;
      this.inputEl = input;

      sel.onchange = () => this.applyProtocol();
      input.oninput = () => this.updateHint();
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); this.quickConnect(); } };
      btnConnect.onclick = () => this.quickConnect();
      btnSave.onclick = () => this.saveAsMachine();

      // —— 3. 机器列表（最近使用 + 分组）——
      this.listEl = h('div', 'ht-home-list');
      inner.appendChild(this.listEl);

      const foot = h('div', 'ht-home-foot', 'Enter 连接 · Esc 关闭主页 · 点击机器行直接连接');
      inner.appendChild(foot);

      frag.appendChild(inner);
      this.el.appendChild(frag);

      this.el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const t = T();
          if (t && t.term && t.term.order.length) this.hide(); // 无终端时不隐藏，避免空白
        }
      });

      this.mounted = true;
      this.render();
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

    applyProtocol() {
      const p = PROTO_BY_VALUE[this.protoEl.value] || PROTO_BY_VALUE[''];
      this.inputEl.placeholder = p.placeholder;
      this.inputEl.disabled = p.value === '';
      this.updateHint();
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
      const label = addrLabel(parsed.user, parsed.host, parsed.port);
      const s = { name: label, protocol: proto, host: parsed.host, port: parsed.port || 0 };
      if (parsed.user) s.user = parsed.user;
      return s;
    },

    updateHint() {
      if (!this.hintEl) return;
      const proto = this.protoEl.value;
      this.hintEl.classList.remove('bad');
      if (proto === '') { this.hintEl.textContent = '将打开一个新的本地 shell'; return; }
      const raw = this.inputEl.value.trim();
      if (!raw) { this.hintEl.textContent = ''; return; }
      const s = this.buildQuickSession(true);
      if (!s) { this.hintEl.textContent = '⚠ 无法解析，请检查格式'; this.hintEl.classList.add('bad'); return; }
      let hint = labelOf(proto) + ' · ' + s.name;
      if (proto !== 'serial' && !s.port) hint += ' · 使用默认端口';
      this.hintEl.textContent = hint;
    },

    // 非本地协议要求有输入；返回 false 表示已提示
    requireInput() {
      if (this.protoEl.value !== '' && !this.inputEl.value.trim()) { toast('请输入连接地址'); return false; }
      return true;
    },

    async quickConnect() {
      if (!this.requireInput()) return;
      const s = this.buildQuickSession(false);
      if (!s) return;
      await this.connect(s);
    },

    saveAsMachine() {
      if (!this.requireInput()) return;
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

    // —— 6. 连接动作 ——
    async connect(session) {
      const t = T();
      if (!t || !t.term || typeof t.term.create !== 'function') { toast('终端模块未加载'); return; }
      try { session.lastUsed = Date.now(); } catch (e) {}
      if (typeof t.persistSessions === 'function') t.persistSessions();
      let tab = null;
      try { tab = await t.term.create(session); }
      catch (e) { toast('连接失败：' + (e && e.message ? e.message : e)); return; }
      if (tab) {
        this.hide();
        if (t.ui && typeof t.ui.log === 'function') t.ui.log('主页连接：' + (session.name || ''));
      }
      // 失败时 term.create 已自行 log/toast，保持主页可见便于重试
    },

    /* ---------------- 渲染 ---------------- */

    render() {
      if (!this.mounted || !this.listEl) return;
      const t = T();
      const sessions = (t && t.s && Array.isArray(t.s.sessions)) ? t.s.sessions : [];
      this.listEl.innerHTML = '';

      // —— 5. 空态 ——
      if (!sessions.length) {
        const empty = h('div', 'ht-home-empty');
        empty.appendChild(h('div', null, '还没有添加机器'));
        const btn = h('button', null, '添加机器');
        btn.type = 'button';
        btn.onclick = () => this.openProfiles();
        empty.appendChild(btn);
        this.listEl.appendChild(empty);
        return;
      }

      // —— 4. 最近使用（lastUsed 降序前 8）——
      const recent = sessions.filter((s) => s && s.lastUsed)
        .slice().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
        .slice(0, 8);
      if (recent.length) this.listEl.appendChild(this.section('最近使用', recent));

      // —— 3. 按 folder 分组 ——
      const groups = {};
      for (const s of sessions) {
        const key = (s && s.folder) || UNGROUPED;
        if (!groups[key]) groups[key] = [];
        groups[key].push(s);
      }
      const keys = Object.keys(groups).sort((a, b) =>
        a === b ? 0 : a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b, 'zh'));
      for (const k of keys) this.listEl.appendChild(this.section(k, groups[k]));
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
      return r;
    },

    isOpen() { return !!(this.el && !this.el.hidden); },
  };

  window.Home = Home;
})();
