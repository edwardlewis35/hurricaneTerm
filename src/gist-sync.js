/* Original machine-profile synchronization. Tabby's profiles schema is data
 * interoperability; the referenced plugin's implementation is not bundled. */
(function () {
  'use strict';
  const T = window.WT;
  const DEFAULT_PROXY = 'http://192.168.8.246:7890';
  const DEFAULT_FILE = 'tabby-sync-settings';
  const SAFE = ['name', 'protocol', 'folder', 'host', 'port', 'user', 'command', 'args', 'target',
    'baudRate', 'dataBits', 'parity', 'stopBits', 'flowControl', 'proxyType', 'proxyHost', 'proxyPort',
    'proxyUser', 'proxyCommand', 'auth', 'identityFile', 'color', 'jumpHost'];
  const state = { config: { gistId: '', proxy: DEFAULT_PROXY, filename: DEFAULT_FILE }, token: '', secret: '',
    root: null, loaded: false, busy: false, preview: null, status: '', error: false };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  function withoutSecrets(value) {
    if (Array.isArray(value)) return value.map(withoutSecrets);
    if (!value || typeof value !== 'object') return value;
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (/password|token|passphrase|secret|privatekeycontent/i.test(k) || /^privatekey$/i.test(k)) continue;
      clean[k] = k === 'privateKeys' && Array.isArray(v) ? v.filter(path => typeof path === 'string' && !/-----BEGIN|[\r\n]/.test(path)) : withoutSecrets(v);
    }
    return clean;
  }
  const number = (value, fallback) => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : fallback;
  function normalizeId(value) {
    let id = String(value || '').trim();
    if (/^https:\/\//i.test(id)) {
      let url; try { url = new URL(id); } catch (_) { throw new Error('请输入有效的 Gist ID 或 gist.github.com 地址'); }
      if (url.hostname !== 'gist.github.com' || url.username || url.password) throw new Error('Gist 地址必须来自 gist.github.com');
      id = url.pathname.split('/').filter(Boolean).at(-1) || '';
    }
    if (!/^[a-f\d]{5,64}$/i.test(id)) throw new Error('请输入有效的 Gist ID（可直接粘贴 Gist 地址）');
    return id.toLowerCase();
  }
  function sanitize(session) {
    const result = {};
    for (const key of SAFE) if (session[key] !== undefined && (typeof session[key] !== 'object' || key === 'args')) result[key] = clone(session[key]);
    result.name = String(result.name || result.host || result.target || '未命名机器');
    result.protocol = String(result.protocol || 'local').toLowerCase();
    // A key field must be a filesystem path, never key material.
    if (typeof result.identityFile !== 'string' || /-----BEGIN|[\r\n]/.test(result.identityFile)) delete result.identityFile;
    result.args = Array.isArray(result.args) ? result.args.filter(v => typeof v === 'string') : [];
    return result;
  }
  function key(session) {
    return [session.protocol || 'local', session.folder || '', session.name || ''].join('\u0001');
  }
  function digest(value) {
    let n = 2166136261;
    for (const c of value) { n ^= c.charCodeAt(0); n = Math.imul(n, 16777619); }
    return (n >>> 0).toString(16).padStart(8, '0');
  }
  function fromProfile(profile, groups) {
    if (!profile || typeof profile !== 'object' || profile.isBuiltin || profile.isTemplate) return null;
    const type = String(profile.type || '').toLowerCase();
    if (!['ssh', 'telnet', 'serial', 'tcp', 'local'].includes(type)) return null;
    const o = profile.options && typeof profile.options === 'object' ? profile.options : {};
    const own = profile.hurricaneTerm && typeof profile.hurricaneTerm === 'object' ? profile.hurricaneTerm : {};
    const s = { ...own, protocol: type, name: profile.name || own.name, folder: groups?.get(profile.group) || profile.group || own.folder || '', color: profile.color || own.color || '' };
    if (type === 'ssh' || type === 'telnet' || type === 'tcp') {
      s.host = String(o.host || own.host || ''); s.port = number(o.port, type === 'ssh' ? 22 : type === 'telnet' ? 23 : 0);
      s.user = String(o.user || own.user || '');
      if (!s.host || (type === 'tcp' && !s.port)) return null;
    }
    if (type === 'ssh') {
      s.auth = ({ publicKey: 'publickey', keyboardInteractive: 'keyboard-interactive', agent: 'publickey' })[o.auth] || o.auth || own.auth || 'publickey';
      s.identityFile = Array.isArray(o.privateKeys) ? o.privateKeys.find(v => typeof v === 'string' && !/-----BEGIN|[\r\n]/.test(v)) || '' : own.identityFile || '';
      s.jumpHost = o.jumpHost || own.jumpHost || '';
      s.proxyCommand = o.proxyCommand || own.proxyCommand || '';
      if (o.socksProxyHost || o.httpProxyHost) {
        s.proxyType = o.socksProxyHost ? 'socks5' : 'http'; s.proxyHost = o.socksProxyHost || o.httpProxyHost;
        s.proxyPort = number(o.socksProxyPort || o.httpProxyPort, 0);
      }
    }
    if (type === 'local') { s.command = o.command || own.command || ''; s.args = o.args || own.args || []; }
    if (type === 'serial') {
      s.target = o.port || o.device || own.target || ''; if (!s.target) return null;
      s.baudRate = Number(o.baudrate ?? own.baudRate) || 115200; s.dataBits = Number(o.databits ?? own.dataBits) || 8;
      s.stopBits = Number(o.stopbits ?? own.stopBits) || 1; s.parity = o.parity || own.parity || 'none';
      s.flowControl = o.rtscts ? 'RTS/CTS' : o.xon || o.xoff ? 'Xon/Xoff' : own.flowControl || 'None';
    }
    return sanitize(s);
  }
  function toProfile(session, existing) {
    const s = sanitize(session), type = s.protocol;
    const profile = existing ? withoutSecrets(existing) : { id: 'hurricaneterm:' + digest(key(s)) };
    Object.assign(profile, { type, name: s.name, group: s.folder || '', color: s.color || '' });
    profile.options = profile.options && typeof profile.options === 'object' ? profile.options : {};
    const o = profile.options;
    if (['ssh', 'telnet', 'tcp'].includes(type)) Object.assign(o, { host: s.host || '', port: number(s.port, type === 'ssh' ? 22 : type === 'telnet' ? 23 : 0), user: s.user || '' });
    if (type === 'ssh') {
      Object.assign(o, { auth: ({ publickey: 'publicKey', 'keyboard-interactive': 'keyboardInteractive' })[s.auth] || s.auth || null,
        privateKeys: s.identityFile ? [s.identityFile] : [], jumpHost: s.jumpHost || null, proxyCommand: s.proxyCommand || null });
      o.socksProxyHost = s.proxyType === 'socks5' ? s.proxyHost || null : null;
      o.socksProxyPort = s.proxyType === 'socks5' ? number(s.proxyPort, 0) : null;
      o.httpProxyHost = s.proxyType === 'http' ? s.proxyHost || null : null;
      o.httpProxyPort = s.proxyType === 'http' ? number(s.proxyPort, 0) : null;
    }
    if (type === 'local') Object.assign(o, { command: s.command || '', args: s.args || [] });
    if (type === 'serial') Object.assign(o, { port: s.target || '', baudrate: Number(s.baudRate) || 115200,
      databits: Number(s.dataBits) || 8, stopbits: Number(s.stopBits) || 1, parity: s.parity || 'none',
      rtscts: s.flowControl === 'RTS/CTS', xon: /^xon\/xoff$/i.test(s.flowControl || ''), xoff: /^xon\/xoff$/i.test(s.flowControl || '') });
    profile.hurricaneTerm = s;
    // Strip credentials even from an existing matched cloud profile.
    for (const k of Object.keys(o)) if (/password|token|passphrase|privatekeycontent|secret/i.test(k)) delete o[k];
    return profile;
  }
  function importDocument(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('云端内容不是 Tabby 配置对象');
    if (!Array.isArray(document.profiles)) throw new Error('云端配置没有 profiles 机器列表；不会覆盖此文件');
    const groups = new Map((Array.isArray(document.profileGroups) ? document.profileGroups : []).filter(g => g && typeof g === 'object').map(g => [g.id, g.name]));
    const sessions = [], seen = new Set(), warnings = []; let skipped = 0;
    for (const p of document.profiles) {
      const s = fromProfile(p, groups);
      if (!s || seen.has(key(s))) { skipped++; continue; }
      if (s.protocol === 'serial' && (!Number.isInteger(s.stopBits) || ![1, 2].includes(s.stopBits))) {
        skipped++; warnings.push(`${s.name}：当前串口后端仅支持 1 或 2 停止位，未导入此机器。`); continue;
      }
      if (s.protocol === 'ssh' && p.options?.jumpHost) {
        const jump = document.profiles.find(other => other?.id === s.jumpHost && other?.type === 'ssh');
        if (!jump?.options?.host || jump === p || jump.options.jumpHost) {
          skipped++; warnings.push(`${s.name}：跳板机引用缺失、循环或多级跳转，未导入；请在机器管理中手工配置。`); continue;
        } else {
          const host = String(jump.options.host), port = number(jump.options.port, 22);
          s.jumpHost = `${jump.options.user ? jump.options.user + '@' : ''}${host.includes(':') ? '[' + host + ']' : host}:${port}`;
        }
      }
      seen.add(key(s)); sessions.push(s);
    }
    return { sessions, skipped, warnings };
  }
  function compare(local, remote) {
    const lm = new Map(local.map(s => [key(s), s])), rm = new Map(remote.map(s => [key(s), s]));
    return [...new Set([...lm.keys(), ...rm.keys()])].map(k => {
      const l = lm.get(k), r = rm.get(k);
      return { key: k, name: l?.name || r?.name, folder: l?.folder || r?.folder || '',
        state: !l ? 'remote' : !r ? 'local' : canonical(l) === canonical(r) ? 'same' : 'conflict', local: l, remote: r };
    });
  }
  function canonical(session) {
    const s = sanitize(session), protocol = s.protocol;
    const fields = { name: s.name, protocol, folder: s.folder || '', color: s.color || '' };
    if (['ssh', 'telnet', 'tcp'].includes(protocol)) Object.assign(fields, { host: s.host || '', user: s.user || '', port: number(s.port, protocol === 'ssh' ? 22 : protocol === 'telnet' ? 23 : 0) });
    if (protocol === 'ssh') for (const k of ['auth', 'identityFile', 'jumpHost', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyCommand']) fields[k] = k === 'auth' ? s[k] || 'publickey' : k === 'proxyPort' ? Number(s[k]) || 0 : s[k] || '';
    if (protocol === 'local') Object.assign(fields, { command: s.command || '', args: s.args || [] });
    if (protocol === 'serial') Object.assign(fields, { target: s.target || '', baudRate: Number(s.baudRate) || 115200, dataBits: Number(s.dataBits) || 8,
      stopBits: Number(s.stopBits) || 1, parity: String(s.parity || 'none').toLowerCase(), flowControl: String(s.flowControl || 'None').toLowerCase() });
    return JSON.stringify(fields);
  }
  function merge(local, remote, remoteWins = false, replace = false) {
    const rows = compare(local, remote);
    return rows.filter(r => !replace || r.remote).map(r => {
      const source = (remoteWins || replace) ? r.remote || r.local : r.local || r.remote;
      // Download never erases locally stored passwords or usage history.
      return r.local ? { ...r.local, ...sanitize(source) } : sanitize(source);
    });
  }
  function exportDocument(local, remote = { profiles: [] }) {
    const doc = clone(remote); importDocument(doc);
    const groups = new Map((Array.isArray(doc.profileGroups) ? doc.profileGroups : []).map(g => [g.id, g.name]));
    const indexes = new Map();
    doc.profiles.forEach((p, i) => { const s = fromProfile(p, groups); if (s) indexes.set(key(s), i); });
    for (const s of local) {
      const index = indexes.get(key(s));
      if (index === undefined) { indexes.set(key(s), doc.profiles.length); doc.profiles.push(toProfile(s)); }
      else {
        const group = doc.profiles[index].group;
        doc.profiles[index] = toProfile(s, doc.profiles[index]);
        if (groups.has(group) && groups.get(group) === s.folder) doc.profiles[index].group = group;
      }
    }
    for (const profile of doc.profiles) {
      if (profile?.type !== 'ssh' || !profile.hurricaneTerm?.jumpHost) continue;
      const address = profile.hurricaneTerm.jumpHost;
      const match = doc.profiles.find(other => {
        if (other?.type !== 'ssh' || !other.options?.host) return false;
        const o = other.options, host = String(o.host);
        return address === other.id || address === `${o.user ? o.user + '@' : ''}${host.includes(':') ? '[' + host + ']' : host}:${number(o.port, 22)}`;
      });
      profile.options.jumpHost = match?.id || null;
    }
    return doc;
  }
  function previewHTML() {
    const p = state.preview; if (!p) return '';
    const labels = { local: '仅本机', remote: '仅云端', same: '相同', conflict: '内容不同' };
    const rows = compare(p.local, p.remote);
    return `<section class="gs-preview" aria-label="同步预览"><h3>${p.mode === 'create' ? '新建私密 Gist 预览' : '机器配置差异预览'}</h3>
      <p>${p.local.length} 台本机 · ${p.remote.length} 台云端 · ${rows.filter(r => r.state === 'conflict').length} 项冲突${p.skipped ? ' · ' + p.skipped + ' 项不支持的配置保留在云端' : ''}</p>
      ${p.snapshot?.public ? '<p class="gs-warning">此 Gist 是公开的。机器地址等信息将公开；可改用新建私密 Gist。</p>' : ''}
      <div class="gs-table"><table><thead><tr><th>机器</th><th>分组</th><th>状态</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.folder || '未分组')}</td><td class="gs-${r.state}">${labels[r.state]}</td></tr>`).join('') || '<tr><td colspan="3">没有机器配置</td></tr>'}</tbody></table></div>
      <p class="gs-note">同步不包含本机 UI、密码、Token、私钥内容。私钥路径、跳板机与代理地址会同步。已有云端文件的其他配置保留；未知协议不导入。</p>
      ${(p.warnings || []).map(text => `<p class="gs-warning">${esc(text)}</p>`).join('')}
      ${p.mode !== 'download' && p.local.some(s => s.jumpHost) ? '<p class="gs-note">Tabby 的跳板机需引用另一台已保存机器。能匹配时转换为其 Profile ID；其余地址保留在 hurricaneTerm 扩展中，Tabby 需手工补选。原云端非机器配置原样保留。</p>' : ''}
      <div class="gs-actions">${p.mode === 'create' ? '<button class="primary" data-gs-action="confirm-create">确认创建并上传</button>' : p.mode === 'upload' ? '<button class="primary" data-gs-action="confirm-upload">确认合并上传（本机优先）</button>' : '<button class="primary" data-gs-action="merge-local">合并到本机（本机优先）</button><button data-gs-action="merge-remote">合并到本机（云端优先）</button><button data-gs-action="replace">以云端替换本机</button>'}<button data-gs-action="cancel">取消预览</button></div>
      ${p.mode === 'download' ? '<label class="gs-check"><input type="checkbox" data-gs-replace> 我已查看差异，允许删除仅在本机的机器（替换时必选）</label>' : ''}</section>`;
  }
  function view() {
    const c = state.config;
    return `<h2 class="st-h">GitHub Gist 同步</h2><p class="st-sub">在设备之间同步机器与连接。参考 Tabby Cloud Sync Settings 的文件与 profiles 格式。</p><div class="st-card gs-form">
      <label>Gist 仓库 / ID<input data-gs-field="gistId" value="${esc(c.gistId)}" placeholder="Gist ID 或 https://gist.github.com/…" autocomplete="off" spellcheck="false"></label>
      <label>Gist Key / GitHub Token<input data-gs-field="token" type="password" value="${esc(state.token)}" placeholder="具有 gist 权限的 Personal Access Token" autocomplete="off" spellcheck="false"></label>
      <label>配置加密密钥<input data-gs-field="secret" type="password" value="${esc(state.secret)}" placeholder="新建 / 上传至少 12 字符；读取已有 V2 需原密钥" autocomplete="off"></label>
      <label>同步文件名<input data-gs-field="filename" value="${esc(c.filename)}" placeholder="tabby-sync-settings" spellcheck="false"></label>
      <label>GitHub HTTP 代理<input data-gs-field="proxy" value="${esc(c.proxy)}" placeholder="留空直连，例如 http://192.168.8.246:7890" spellcheck="false"></label>
      <p class="gs-note">Token 与加密密钥仅保留在当前进程内存，重启后重新输入。仅保存 Gist ID、文件名与代理地址。上传使用 Tabby V2 加密；支持读取 V1、V2 和未加密的 Tabby JSON/YAML。</p>
      <div class="gs-actions"><button data-gs-action="save">保存连接信息</button><button data-gs-action="test">测试连接</button><button data-gs-action="download">读取云端 / 预览</button><button data-gs-action="upload">上传本机 / 预览</button><button data-gs-action="create">新建私密 Gist</button><button data-gs-action="forget">清除凭证</button></div></div>
      <p class="gs-status${state.error ? ' bad' : ''}" role="status" aria-live="polite">${esc(state.status)}</p>${previewHTML()}`;
  }
  function render() {
    if (!state.root?.isConnected) return;
    state.root.innerHTML = view(); bind(state.root);
  }
  function message(text, error = false) { state.status = text; state.error = error; render(); }
  function readFields() {
    for (const input of state.root?.querySelectorAll('[data-gs-field]') || []) {
      const field = input.dataset.gsField;
      if (field === 'token' || field === 'secret') state[field] = input.value;
      else state.config[field] = input.value.trim();
    }
  }
  function request(operation, extra = {}) {
    if (!state.token.trim()) throw new Error('请先填写具有 gist 权限的 GitHub Token');
    return T.invoke('gist_request', { request: { operation, token: state.token.trim(), encryptionSecret: state.secret,
      gistId: operation === 'create' || operation === 'test' && !state.config.gistId ? '' : normalizeId(state.config.gistId),
      filename: state.config.filename || DEFAULT_FILE, proxy: state.config.proxy, ...extra } });
  }
  async function persistConfig() {
    await T.invoke('ui_state_save', { name: 'gist-sync', value: JSON.stringify(state.config) });
  }
  async function applyLocal(p, remoteWins, replace, allowedReplace) {
    // Reject stale previews rather than silently overwriting changes made elsewhere.
    if (JSON.stringify(T.s.sessions || []) !== JSON.stringify(p.local)) throw new Error('本机机器配置已改变，请重新读取并预览');
    if (replace && !allowedReplace) throw new Error('替换前请勾选允许删除仅在本机的机器');
    const next = merge(p.local, p.remote, remoteWins, replace);
    await T.invoke('ui_state_save', { name: 'gist-machines-backup', value: JSON.stringify(p.local) });
    await T.invoke('sessions_save', { sessions: next });
    T.s.sessions = next;
    window.Home?.render?.(); window.UI?.renderDock?.();
    state.preview = null; message('已同步 ' + next.length + ' 台机器；同步前的本机机器已备份。');
  }
  async function action(name) {
    if (state.busy) return;
    readFields();
    const allowedReplace = !!state.root.querySelector('[data-gs-replace]')?.checked;
    if (name === 'cancel') { state.preview = null; return render(); }
    if (name === 'forget') { state.token = ''; state.secret = ''; state.preview = null; return message('已清除当前进程的 Gist 凭证。'); }
    state.busy = true; render();
    try {
      if (name === 'save') { if (state.config.gistId) state.config.gistId = normalizeId(state.config.gistId); await persistConfig(); message('连接信息已保存；Token 与加密密钥未写入磁盘。'); }
      else if (name === 'test') { const result = await request('test'); message('GitHub 连接成功' + (result.gistId ? ' · Gist ' + result.gistId : '') + '；未修改云端配置。'); }
      else if (name === 'create') {
        if (!state.token.trim()) throw new Error('请先填写 GitHub Token');
        if (state.secret.length < 12) throw new Error('创建前请设置至少 12 字符的配置加密密钥');
        state.preview = { mode: 'create', local: clone(T.s.sessions || []), remote: [], skipped: 0 };
        message('请检查机器列表，确认后才会创建私密 Gist。');
      } else if (name === 'download' || name === 'upload') {
        const snapshot = await request('read'); const imported = importDocument(snapshot.document);
        state.preview = { mode: name, snapshot, local: clone(T.s.sessions || []), remote: imported.sessions, skipped: imported.skipped, warnings: imported.warnings };
        message('云端已读取。请检查差异并选择合并方式。');
      } else if (['merge-local', 'merge-remote', 'replace'].includes(name)) {
        if (!state.preview || state.preview.mode !== 'download') throw new Error('请先读取云端并查看预览');
        await applyLocal(state.preview, name !== 'merge-local', name === 'replace', allowedReplace);
      } else if (name === 'confirm-upload' || name === 'confirm-create') {
        const p = state.preview;
        if (!p || p.mode !== (name === 'confirm-create' ? 'create' : 'upload')) throw new Error('请先生成上传预览');
        if (JSON.stringify(p.local) !== JSON.stringify(T.s.sessions || [])) throw new Error('本机机器配置已改变，请重新预览');
        if (state.secret.length < 12) throw new Error('上传需要至少 12 字符的配置加密密钥');
        const result = await request(name === 'confirm-create' ? 'create' : 'write', {
          document: exportDocument(p.local, p.snapshot?.document), expectedRevision: p.snapshot?.revision || '',
        });
        state.config.gistId = result.gistId; await persistConfig(); state.preview = null;
        message('机器配置已加密上传到 Gist ' + result.gistId + '。');
      }
    } catch (error) {
      // Never surface raw bridge/network errors: a provider may echo a token.
      let text = typeof error === 'string' ? error : error?.message || '同步失败，请检查连接信息';
      for (const secret of [state.token, state.secret]) if (secret) text = text.split(secret).join('[已隐藏]');
      message(text.slice(0, 500), true);
    } finally { state.busy = false; render(); }
  }
  function bind(root) {
    state.root = root;
    root.querySelectorAll('[data-gs-action]').forEach(button => {
      button.disabled = state.busy;
      button.onclick = () => action(button.dataset.gsAction);
    });
    root.querySelectorAll('[data-gs-field]').forEach(input => {
      input.disabled = state.busy;
      input.addEventListener('input', () => { readFields(); state.preview = null; root.querySelector('.gs-preview')?.remove(); });
    });
    root.querySelectorAll('[data-gs-replace]').forEach(input => { input.disabled = state.busy; });
    if (!state.loaded) {
      state.loaded = true;
      T.invoke('ui_state_load', { name: 'gist-sync' }).then(raw => {
        if (!raw) return;
        let config; try { config = JSON.parse(raw); } catch (_) { return; }
        // Only non-secret connection fields may enter persistence.
        for (const k of ['gistId', 'filename', 'proxy']) if (typeof config[k] === 'string') state.config[k] = config[k];
        render();
      }).catch(() => {});
    }
  }
  window.GistSync = { view, bind, normalizeId, sanitize, fromProfile, toProfile, importDocument, exportDocument, compare, merge };
})();
