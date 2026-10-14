/* hurricaneTerm — profiles.js
 * Tabby 风格的「机器管理 / Profile 编辑器」。
 * 原创代码 (Apache-2.0)；交互形态参考 Tabby 的 Profiles & settings 页（左列表右表单），未复制其代码。
 *
 * 依赖：window.WT（core.js：T.s.sessions / T.persistSessions）；toast 走 window.UI.toast（typeof 防御）。
 * 导出：window.Profiles = { openManager(), edit(sessionOrNull), byName(name) }
 * 说明：DOM 全部由本文件动态创建，类名前缀 .ht-pm，自带 <style>；不依赖 index.html 预置节点。
 *       [hidden]{display:none!important} 兼容规则由父层 style.css 提供，此处不重复。
 *       lastUsed 不在表单内：保存走 Object.assign 合并，未编辑字段（含 lastUsed，由
 *       home.js/term.js 维护）原样保留。
 */
(function () {
  'use strict';

  const wt = () => window.WT;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { try { if (window.UI && typeof window.UI.toast === 'function') window.UI.toast(m); } catch (_) {} };

  const ICON_NAMES = { local: 'terminal', ssh: 'lock', telnet: 'telnet', serial: 'serial', tcp: 'globe' };
  const iconSvg = (p) => (window.Icons ? window.Icons.svg(ICON_NAMES[(p || 'local').toLowerCase()] || 'terminal') : '');
  const PROTO_OPTS = [['local', '本地'], ['ssh', 'SSH'], ['telnet', 'Telnet'], ['serial', '串口'], ['tcp', 'TCP']];
  // 与 tabbar.js 的标签色板保持同一组，profile 颜色 = 标签颜色
  const COLORS = ['#d9534f', '#f0ad4e', '#ffd500', '#5cb85c', '#5bc0de', '#0275d8', '#4fadff', '#ff5b77', '#613d7c'];
  const AUTH_OPTS = [['publickey', 'publickey（密钥）'], ['password', 'password（密码）'], ['keyboard-interactive', 'keyboard-interactive'], ['none', 'none（不认证）']];
  const PROXY_OPTS = [['', '无'], ['Socks5', 'Socks5'], ['Http', 'Http'], ['ProxyCommand', 'ProxyCommand']];
  const BAUD_OPTS = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'];
  const PARITY_OPTS = [['None', '无 (None)'], ['Odd', '奇 (Odd)'], ['Even', '偶 (Even)'], ['Mark', '标 (Mark)'], ['Space', '空 (Space)']];
  const FLOW_OPTS = [['None', '无'], ['Xon/Xoff', 'Xon/Xoff'], ['RTS/CTS', 'RTS/CTS']];

  const S = { overlay: null, listEl: null, formEl: null, query: '', draft: null, editing: null, selName: null, bubbleTimer: null };

  /* ---------- 小工具 ---------- */
  const sessions = () => { const T = wt(); return (T && T.s && Array.isArray(T.s.sessions)) ? T.s.sessions : []; };

  function subOf(s) {
    if (s.protocol === 'serial') return s.target || '串口';
    if (s.protocol === 'local') return s.command || '默认 shell';
    if (s.protocol === 'tcp') return s.target || (s.host ? `${s.host}${s.port ? ':' + s.port : ''}` : '');
    if (s.host) return `${s.user ? s.user + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}`;
    return s.command || '';
  }
  function uniqueName(base) {
    const list = sessions(); let n = list.length + 1, name = `${base}-${n}`;
    while (list.some((x) => x.name === name)) name = `${base}-${++n}`;
    return name;
  }
  function copyNameOf(n) {
    const list = sessions(); let c = n + '-副本', i = 2;
    while (list.some((x) => x.name === c)) c = `${n}-副本${i++}`;
    return c;
  }

  /* ---------- 样式（全部 .ht-pm 前缀） ---------- */
  const CSS = `
.ht-pm-overlay { position: absolute; inset: 0; z-index: 300; background: var(--bg); display: flex; }
.ht-pm { width: 100%; height: 100%; display: flex; background: var(--bg); overflow: hidden; }
.ht-pm-left { width: 280px; min-width: 220px; display: flex; flex-direction: column; background: var(--bg); border-right: 1px solid var(--border); position: relative; }
.ht-pm-head { display: flex; justify-content: space-between; align-items: center; padding: 27px 18px 18px; font-size: 20px; font-weight: 300; color: var(--fg3); }
.ht-pm-head .ht-pm-x { width: 28px; height: 28px; padding: 0; }
.ht-pm-tools { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border); }
.ht-pm-btns { display: flex; gap: 6px; }
.ht-pm-btns button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 5px 6px; font-size: 12px; white-space: nowrap; }
.ht-pm-btns svg { width: 13px; height: 13px; }
.ht-pm-list { flex: 1; overflow: auto; min-height: 0; padding: 4px 0; }
.ht-pm-grp { padding: 7px 12px 3px; font-size: 11px; color: var(--accent); }
.ht-pm-row { display: flex; align-items: center; gap: 10px; padding: 9px 16px; cursor: pointer; }
.ht-pm-row:hover { background: var(--surface-hover); }
.ht-pm-row.sel { background: var(--accent-bg); box-shadow: inset 2px 0 var(--accent); }
.ht-pm-ico { width: 17px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--fg2); }
.ht-pm-ico svg { width: 14px; height: 14px; }
.ht-pm-row:hover .ht-pm-ico, .ht-pm-row.sel .ht-pm-ico { color: var(--accent); }
.ht-pm-col { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ht-pm-col b { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ht-pm-col i { font-style: normal; font-size: 11px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ht-pm-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ht-pm-empty { padding: 16px; color: var(--fg2); font-size: 12px; line-height: 1.7; }
.ht-pm-bubble { position: absolute; left: 12px; right: 12px; top: 92px; background: var(--bg2); border: 1px solid var(--accent); border-radius: 6px; padding: 8px 10px; display: flex; gap: 8px; align-items: center; justify-content: space-between; box-shadow: var(--shadow); z-index: 5; font-size: 12px; }
.ht-pm-bubble-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ht-pm-bubble-ok { background: var(--danger); border-color: var(--danger); color: var(--on-danger); padding: 2px 10px; font-size: 12px; }
.ht-pm-bubble-ok:hover { background: var(--danger); color: var(--on-danger); filter: brightness(1.1); }
.ht-pm-right { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.ht-pm-formhead { padding: 28px 36px 12px; font-size: 28px; font-weight: 300; color: var(--fg3); }
.ht-pm-form { flex: 1; overflow: auto; min-height: 0; padding: 12px 36px 24px; }
.ht-pm-sect { font-size: 15px; font-weight: 500; color: var(--fg3); border-bottom: 1px solid var(--border); padding-bottom: 10px; margin: 24px 0 14px; }
.ht-pm-sect:first-child { margin-top: 0; }
.ht-pm-field { display: grid; grid-template-columns: 110px minmax(0,1fr); gap: 16px; align-items: center; margin: 12px 0; max-width: 880px; }
.ht-pm-field > span { font-size: 12px; color: var(--fg2); text-align: right; }
.ht-pm-field input, .ht-pm-field select { background: var(--input-bg); border: 1px solid var(--border-solid); border-radius: 4px; color: var(--fg); padding: 5px 8px; font: inherit; width: 100%; min-width: 0; }
.ht-pm-field input:focus, .ht-pm-field select:focus { outline: none; border-color: var(--accent); }
.ht-pm-hint { font-size: 11px; color: var(--fg2); margin: -2px 0 6px 122px; }
.ht-pm-swrow { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
.ht-pm-sw { width: 20px; height: 20px; border-radius: 50%; border: 2px solid transparent; padding: 0; cursor: pointer; }
.ht-pm-sw:hover { border-color: var(--fg2); }
.ht-pm-sw.on { border-color: var(--fg); }
.ht-pm-swc { font-size: 11px; padding: 2px 8px; color: var(--fg2); }
.ht-pm-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 20px; border-top: 1px solid var(--border); }
.ht-pm-guide { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 100%; color: var(--fg2); text-align: center; line-height: 1.8; font-size: 13px; }
.ht-pm-guide-ico svg { width: 42px; height: 42px; opacity: .5; }
@media (max-width: 900px) {
  .ht-pm-left { width: 230px; }
  .ht-pm-formhead { padding: 24px 20px 10px; }
  .ht-pm-form { padding: 12px 20px; }
  .ht-pm-field { grid-template-columns: minmax(0,1fr); gap: 4px; }
  .ht-pm-field > span { text-align: left; }
  .ht-pm-hint { margin-left: 0; }
}
`;

  /* ---------- 外壳（懒创建，一次性） ---------- */
  function ensureShell() {
    if (S.overlay) return;
    const st = document.createElement('style');
    st.id = 'ht-pm-style'; st.textContent = CSS;
    document.head.appendChild(st);

    const ov = document.createElement('div');
    ov.className = 'ht-pm-overlay';
    ov.hidden = true;
    ov.tabIndex = -1;
    ov.innerHTML = `
      <section class="ht-pm" aria-label="机器管理">
        <div class="ht-pm-left">
          <div class="ht-pm-head"><span class="ht-pm-count">机器管理</span><button class="ht-pm-x icon" title="关闭（Esc）" aria-label="关闭机器管理">${window.Icons.svg('x')}</button></div>
          <div class="ht-pm-tools">
            <input class="ht-pm-q" type="text" placeholder="搜索机器…" aria-label="搜索机器">
            <div class="ht-pm-btns">
              <button data-act="add">${window.Icons.svg('plus')} 添加</button>
              <button data-act="dup" title="复制选中的机器">${window.Icons.svg('copy')} 复制</button>
              <button data-act="del" title="删除选中的机器">${window.Icons.svg('trash')} 删除</button>
            </div>
          </div>
          <div class="ht-pm-list"></div>
          <div class="ht-pm-bubble" hidden><span class="ht-pm-bubble-t"></span><button class="ht-pm-bubble-ok">确认删除</button></div>
        </div>
        <div class="ht-pm-right">
          <div class="ht-pm-formhead"><span class="ht-pm-title">连接配置</span></div>
          <div class="ht-pm-form"></div>
          <div class="ht-pm-actions" hidden>
            <button class="ht-pm-cancel">取消</button>
            <button class="ht-pm-save primary">保存</button>
          </div>
        </div>
      </section>`;
    (document.getElementById('main-area') || document.body).appendChild(ov);
    S.overlay = ov;
    S.listEl = ov.querySelector('.ht-pm-list');
    S.formEl = ov.querySelector('.ht-pm-form');

    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      const b = ov.querySelector('.ht-pm-bubble');
      if (!b.hidden) { hideBubble(); return; }
      close();
    });
    ov.querySelector('.ht-pm-x').onclick = close;
    ov.querySelector('.ht-pm-q').addEventListener('input', (e) => { S.query = e.target.value; renderList(); });
    ov.querySelector('[data-act="add"]').onclick = () => edit(null);
    ov.querySelector('[data-act="dup"]').onclick = duplicateSelected;
    ov.querySelector('[data-act="del"]').onclick = askDelete;
    ov.querySelector('.ht-pm-bubble-ok').onclick = confirmDelete;
    ov.querySelector('.ht-pm-cancel').onclick = cancelEdit;
    ov.querySelector('.ht-pm-save').onclick = save;
  }

  function close() {
    if (!S.overlay || S.overlay.hidden) return;
    hideBubble();
    S.overlay.hidden = true;
    S.draft = null; S.editing = null; S.selName = null;
    // 返回原页面时同步保存、改名、复制和删除后的机器列表。
    const H = window.Home;
    const settings = window.Settings;
    const T = wt();
    if (H) H.render();
    const homeOpen = !!(H && H.isOpen());
    const settingsOpen = !!(settings && settings.isOpen());
    if (settingsOpen) settings.render();
    if (T && T.s.dockVisible && window.UI) window.UI.renderDock();
    // 直接从终端进入管理器时，退出后恢复键盘输入。
    if (!homeOpen && !settingsOpen && T && T.term) {
      const tab = T.term.activeTab();
      if (tab) { try { tab.fit.fit(); } catch (e) {} tab.term.focus(); }
    }
  }

  /* ---------- 左列表 ---------- */
  function renderList() {
    const q = S.query.trim().toLowerCase();
    const rows = sessions().filter((s) => !q || `${s.name || ''} ${s.folder || ''} ${subOf(s)}`.toLowerCase().includes(q));
    const groups = {};
    for (const s of rows) (groups[s.folder || '（未分组）'] ||= []).push(s);
    let html = '';
    for (const g of Object.keys(groups).sort()) {
      html += `<div class="ht-pm-grp">▸ ${esc(g)}</div>`;
      for (const s of groups[g]) {
        html += `<div class="ht-pm-row${s.name === S.selName ? ' sel' : ''}" data-name="${encodeURIComponent(s.name || '')}">
          <span class="ht-pm-ico">${iconSvg(s.protocol)}</span>
          <span class="ht-pm-col"><b>${esc(s.name)}</b><i>${esc(subOf(s))}</i></span>
          ${s.color ? `<span class="ht-pm-dot" style="background:${esc(s.color)}"></span>` : ''}</div>`;
      }
    }
    if (!html) html = `<div class="ht-pm-empty">${q ? '没有匹配的机器。' : '还没有机器。点「＋ 添加机器」新建第一台。'}</div>`;
    S.listEl.innerHTML = html;
    S.overlay.querySelector('.ht-pm-count').textContent = `机器管理 · ${sessions().length} 台`;
    S.listEl.querySelectorAll('.ht-pm-row').forEach((r) => {
      r.onclick = () => selectByName(decodeURIComponent(r.dataset.name));
    });
  }

  function selectByName(name) {
    const s = sessions().find((x) => x.name === name);
    if (!s) return;
    S.editing = s; S.draft = { ...s }; S.selName = name;
    renderList(); renderForm();
  }

  /* ---------- 删除（确认气泡，二次点击才删） ---------- */
  function askDelete() {
    if (!S.selName) { toast('先选中要删除的机器'); return; }
    const b = S.overlay.querySelector('.ht-pm-bubble');
    b.querySelector('.ht-pm-bubble-t').textContent = `删除「${S.selName}」？`;
    b.hidden = false;
    clearTimeout(S.bubbleTimer);
    S.bubbleTimer = setTimeout(hideBubble, 5000);
  }
  function hideBubble() {
    if (!S.overlay) return;
    clearTimeout(S.bubbleTimer);
    S.overlay.querySelector('.ht-pm-bubble').hidden = true;
  }
  async function confirmDelete() {
    const T = wt(); const name = S.selName;
    if (!T || !name) return;
    T.s.sessions = sessions().filter((s) => s.name !== name);
    await T.persistSessions();
    hideBubble();
    if (S.selName === name) { S.draft = null; S.editing = null; S.selName = null; }
    renderList(); renderForm();
    toast('已删除：' + name);
  }

  /* ---------- 复制 ---------- */
  async function duplicateSelected() {
    const T = wt();
    if (!T) return;
    const src = sessions().find((x) => x.name === S.selName);
    if (!src) { toast('先选中要复制的机器'); return; }
    let c;
    try { c = JSON.parse(JSON.stringify(src)); } catch (_) { c = { ...src }; }
    c.name = copyNameOf(src.name || 'machine');
    T.s.sessions = sessions().concat([c]);
    await T.persistSessions();
    selectByName(c.name);
    toast('已复制为：' + c.name);
  }

  /* ---------- 右表单 ---------- */
  const sect = (t) => `<div class="ht-pm-sect">${t}</div>`;
  const hint = (t) => `<div class="ht-pm-hint">${t}</div>`;
  function fld(label, key, val, ph, type) {
    return `<div class="ht-pm-field"><span>${label}</span><input aria-label="${esc(label)}" data-k="${key}" type="${type || 'text'}" value="${esc(val == null || val === 0 ? '' : val)}" placeholder="${esc(ph || '')}" autocomplete="off"></div>`;
  }
  function sel(label, key, opts, val) {
    const cur = String(val == null ? '' : val);
    return `<div class="ht-pm-field"><span>${label}</span><select aria-label="${esc(label)}" data-k="${key}">${opts.map((o) => {
      const [v, t] = Array.isArray(o) ? o : [o, o];
      return `<option value="${esc(v)}"${String(v) === cur ? ' selected' : ''}>${esc(t)}</option>`;
    }).join('')}</select></div>`;
  }
  function proxyFields(d) {
    const addr = d.proxyHost ? d.proxyHost + (d.proxyPort ? ':' + d.proxyPort : '') : '';
    return sel('代理类型', 'proxyType', PROXY_OPTS, d.proxyType || '')
      + fld('代理地址', 'proxyAddr', addr, 'host:port')
      + fld('代理用户', 'proxyUser', d.proxyUser, '')
      + fld('代理密码', 'proxyPassword', d.proxyPassword, '', 'password')
      + fld('ProxyCommand', 'proxyCommand', d.proxyCommand, 'ssh -W %h:%p gateway');
  }

  function renderForm() {
    const d = S.draft;
    const actions = S.overlay.querySelector('.ht-pm-actions');
    const title = S.overlay.querySelector('.ht-pm-title');
    if (!d) {
      title.textContent = '连接配置';
      actions.hidden = true;
      S.formEl.innerHTML = `<div class="ht-pm-guide"><div class="ht-pm-guide-ico">${window.Icons.svg('server')}</div>
        <p>选择一台机器，编辑连接配置；<br>也可以新建 SSH、串口或本地连接。</p>
        <button class="ht-pm-guide-add primary">＋ 添加机器</button></div>`;
      S.formEl.querySelector('.ht-pm-guide-add').onclick = () => edit(null);
      return;
    }
    actions.hidden = false;
    const p = d.protocol || 'ssh';
    const pname = (PROTO_OPTS.find((o) => o[0] === p) || [p, p])[1];
    title.textContent = (S.selName ? '编辑机器' : '新建机器') + ' · ' + pname;

    let h = sect('基本信息');
    h += fld('名称', 'name', d.name, '例如 web-01（留空自动生成 machine-N）');
    h += sel('协议', 'protocol', PROTO_OPTS, p);
    h += fld('分组', 'folder', d.folder, '例如 生产环境 / 家里');
    h += `<div class="ht-pm-field"><span>颜色</span><div class="ht-pm-swrow">`
      + COLORS.map((c) => `<button type="button" class="ht-pm-sw${(d.color || '') === c ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')
      + `<button type="button" class="ht-pm-swc" data-color="" title="清除颜色">清除</button></div>`
      + `<input type="hidden" data-k="color" value="${esc(d.color || '')}"></div>`;

    if (p === 'ssh') {
      h += sect('连接');
      h += fld('主机', 'host', d.host, '192.168.1.10 或 example.com');
      h += fld('端口', 'port', d.port, '22');
      h += fld('用户名', 'user', d.user, 'root');
      h += sect('认证');
      h += sel('认证方式', 'auth', AUTH_OPTS, d.auth || 'publickey');
      h += fld('密码', 'password', d.password, '（password / keyboard-interactive 时使用）', 'password');
      h += fld('私钥路径', 'identityFile', d.identityFile, '~/.ssh/id_ed25519');
      h += hint('留空默认 ~/.ssh/id_ed25519');
      h += fld('跳板机', 'jumpHost', d.jumpHost, 'user@bastion.example:22');
      h += sect('代理');
      h += proxyFields(d);
    } else if (p === 'telnet') {
      h += sect('连接');
      h += fld('主机', 'host', d.host, '192.168.1.10');
      h += fld('端口', 'port', d.port, '23');
    } else if (p === 'tcp') {
      h += sect('连接');
      h += fld('主机', 'host', d.host, '127.0.0.1');
      h += fld('端口', 'port', d.port, '例如 5000');
      h += sect('代理');
      h += proxyFields(d);
    } else if (p === 'serial') {
      h += sect('串口');
      h += fld('设备', 'target', d.target, '/dev/ttyUSB0 或 COM3');
      h += sel('波特率', 'baudRate', BAUD_OPTS, d.baudRate || 115200);
      h += sel('数据位', 'dataBits', ['5', '6', '7', '8'], d.dataBits || 8);
      h += sel('校验', 'parity', PARITY_OPTS, d.parity || 'None');
      h += sel('停止位', 'stopBits', ['1', '2'], d.stopBits || 1);
      h += sel('流控', 'flowControl', FLOW_OPTS, d.flowControl || 'None');
    } else { // local
      h += sect('本地');
      h += fld('命令', 'command', d.command, '/bin/bash');
      h += fld('参数', 'args', Array.isArray(d.args) ? d.args.join(' ') : d.args, '以空格分隔，如 -l -i');
    }
    S.formEl.innerHTML = h;

    // 协议切换：把当前表单值先合并回草稿，再按新协议重渲染
    const psel = S.formEl.querySelector('[data-k="protocol"]');
    psel.onchange = () => {
      Object.assign(S.draft, collect());
      S.draft.protocol = psel.value;
      if (!S.draft.port) S.draft.port = psel.value === 'ssh' ? 22 : psel.value === 'telnet' ? 23 : 0;
      renderForm();
    };
    // 颜色色块
    S.formEl.querySelectorAll('.ht-pm-sw,.ht-pm-swc').forEach((b) => {
      b.onclick = () => {
        const c = b.dataset.color;
        S.formEl.querySelector('[data-k="color"]').value = c;
        S.formEl.querySelectorAll('.ht-pm-sw').forEach((x) => x.classList.toggle('on', x.dataset.color === c));
      };
    });
    // Enter 即保存
    S.formEl.onkeydown = (e) => {
      if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); save(); }
    };
  }

  /* ---------- 收集 / 校验 / 保存 ---------- */
  function collect() {
    const o = {};
    S.formEl.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      let v = typeof el.value === 'string' ? el.value.trim() : el.value;
      if (k === 'args') o.args = v ? v.split(/\s+/) : [];
      else if (k === 'proxyAddr') {
        const i = v.lastIndexOf(':');
        if (i > 0) { o.proxyHost = v.slice(0, i); o.proxyPort = parseInt(v.slice(i + 1), 10) || 0; }
        else { o.proxyHost = v; o.proxyPort = 0; }
      } else if (['port', 'baudRate', 'dataBits', 'stopBits'].includes(k)) o[k] = parseInt(v, 10) || 0;
      else o[k] = v;
    });
    return o;
  }

  async function save() {
    const T = wt();
    if (!T || !T.s || !Array.isArray(T.s.sessions)) { toast('内核未就绪'); return; }
    const data = collect();
    if (!data.name) data.name = uniqueName('machine');
    const p = data.protocol;
    if ((p === 'ssh' || p === 'telnet' || p === 'tcp') && !data.host) { toast('请填写主机地址'); return; }
    if (p === 'serial' && !data.target) { toast('请填写串口设备（如 /dev/ttyUSB0）'); return; }
    if (!data.port) data.port = p === 'ssh' ? 22 : p === 'telnet' ? 23 : 0;

    const list = T.s.sessions;
    const cur = S.editing && list.includes(S.editing) ? S.editing : null; // 编辑目标（在列表中）
    const dup = list.find((x) => x.name === data.name && x !== cur);      // 同名覆盖
    let target;
    if (cur && dup) { Object.assign(dup, data); T.s.sessions = list.filter((x) => x !== cur); target = dup; }
    else if (cur) { Object.assign(cur, data); target = cur; }
    else if (dup) { Object.assign(dup, data); target = dup; }
    else { target = Object.assign({}, S.draft, data); T.s.sessions = list.concat([target]); }

    await T.persistSessions();
    S.editing = target; S.draft = { ...target }; S.selName = target.name;
    renderList(); renderForm();
    toast('已保存');
  }

  function cancelEdit() {
    if (S.selName) selectByName(S.selName); // 编辑既有机器：丢弃草稿改动重选
    else { S.draft = null; S.editing = null; renderForm(); }
  }

  /* ---------- 公开 API ---------- */
  function openManager() {
    ensureShell();
    S.overlay.hidden = false;
    renderList(); renderForm();
    S.overlay.focus();
  }

  function edit(sessionOrNull) {
    ensureShell();
    S.overlay.hidden = false;
    if (sessionOrNull && typeof sessionOrNull === 'object') {
      S.editing = sessionOrNull;
      S.draft = { ...sessionOrNull };
      S.selName = sessionOrNull.name || null;
    } else {
      S.editing = null;
      S.draft = { name: '', protocol: 'ssh', port: 22, folder: '' };
      S.selName = null;
    }
    renderList(); renderForm();
    S.overlay.focus();
    const nameEl = S.formEl.querySelector('[data-k="name"]');
    if (nameEl) setTimeout(() => nameEl.focus(), 0);
  }

  function byName(name) {
    const s = sessions().find((x) => x.name === name);
    return s ? { ...s } : null; // 返回副本，避免调用方误改状态
  }

  const api = { openManager, edit, byName, close, isOpen: () => !!(S.overlay && !S.overlay.hidden) };
  window.Profiles = api;
  if (window.WT) window.WT.Profiles = api; // tabbar.js 亦按 T.Profiles 查找
})();
