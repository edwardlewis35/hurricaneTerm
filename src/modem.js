/* X/Y/ZMODEM transfers use a captured native connection, never terminal text. */
(function () {
  'use strict';
  const T = window.WT, tasks = new Map(), activeSessions = new Set();
  const terminal = new Set(['completed', 'failed', 'cancelled', 'skipped']);
  let overlay, form, target, capability, openGeneration = 0, browserGeneration = 0, previousFocus;
  const uid = () => 'modem-' + (window.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2));
  const nativeId = tab => T.term.ptyId ? T.term.ptyId(tab) : tab?.id;
  const live = tab => !!(tab && T.term.isLive(tab));
  const identity = tab => JSON.stringify(tab?._connectionIdentity || tab?.session || { protocol: 'local' });
  const basename = path => String(path).replace(/\\/g, '/').split('/').pop();
  const fmt = bytes => window.TransferQueue?.formatSize?.(bytes) || (bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KiB');
  const valid = task => live(task.tab) && nativeId(task.tab) === task.sessionId && (task.tab._connectionGeneration || 0) === task.generation && identity(task.tab) === task.identity;
  const changed = '原连接已关闭、断开或重新连接，请为当前连接新建传输';
  function button(text, action, cls) {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = text;
    if (cls) el.className = cls;
    el.addEventListener('click', action); return el;
  }
  function field(tag, name, value) {
    const el = document.createElement(tag); el.name = name;
    if (value != null) el.value = value;
    el.setAttribute('autocapitalize', 'off'); el.setAttribute('autocorrect', 'off'); el.spellcheck = false; return el;
  }
  function label(text, input) { const el = document.createElement('label'); const name = document.createElement('span'); name.textContent = text; el.append(name, input); return el; }
  function select(name, values) {
    const el = field('select', name);
    for (const [value, text] of values) { const option = document.createElement('option'); option.value = value; option.textContent = text; el.append(option); }
    return el;
  }
  function note(text, cls = 'modem-hint') { const el = document.createElement('p'); el.className = cls; el.textContent = text; return el; }
  function announce(message, error = true) {
    if (form) { const el = form.querySelector('[data-feedback]'); el.textContent = String(message?.message || message || ''); el.classList.toggle('error', error); }
  }
  function sync(task) {
    T.term?.findByPty?.(task.sessionId)?.wrap?.classList.toggle('modem-busy', activeSessions.has(task.sessionId));
    window.TransferQueue?.upsert({ id: task.id, sessionId: task.sessionId, protocol: task.protocol.toUpperCase(),
      machine: task.machine, name: task.name, direction: task.direction === 'upload' ? 'up' : 'down',
      source: task.direction === 'upload' ? task.paths.join('\n') : task.machine,
      target: task.direction === 'download' ? task.destination : task.machine,
      status: task.status, done: task.done, total: task.total, speed: task.speed, error: task.error || '' },
    { controls: { ...(terminal.has(task.status) ? task.status === 'failed' || task.status === 'cancelled' ? { retry: () => retry(task) } : {} : { cancel: () => cancel(task) }) } });
  }
  async function cancel(task) {
    if (terminal.has(task.status) || task.cancelPending === task.nativeTransferId) return;
    const attempt = task.nativeTransferId, previousStatus = task.status;
    task.cancelled = true;
    if (!task.started) { task.status = 'cancelled'; sync(task); return; }
    task.cancelPending = attempt;
    task.status = 'cancelling'; sync(task);
    try { await T.invoke('modem_transfer_cancel', { transferId: attempt, sessionId: task.sessionId }); }
    catch (error) {
      // Completion or an explicitly retried attempt owns its result. A late
      // cancellation reply must never change either one.
      if (task.nativeTransferId !== attempt || terminal.has(task.status)) return;
      task.cancelled = false; task.status = previousStatus;
      task.error = String(error?.message || error); sync(task); throw error;
    } finally {
      if (task.cancelPending === attempt) task.cancelPending = null;
    }
  }
  function retry(task) {
    if (task.working || !terminal.has(task.status)) return;
    if (!valid(task)) throw new Error(changed);
    task.nativeTransferId = uid(); task.done = 0; task.speed = 0; task.error = ''; task.started = 0;
    task.cancelled = false; task.status = 'queued'; sync(task); pump();
  }
  function pump() {
    for (const task of tasks.values()) {
      if (task.status !== 'queued' || task.working || activeSessions.has(task.sessionId)) continue;
      if (!valid(task)) { task.status = 'failed'; task.error = changed; sync(task); continue; }
      task.working = true; task.started = Date.now(); task.status = 'preparing';
      activeSessions.add(task.sessionId); task.tab._resetInput?.(); sync(task);
      Promise.resolve().then(() => {
        if (task.cancelled) throw new Error('传输已取消');
        if (!valid(task)) throw new Error(changed);
        return T.invoke('modem_transfer_start', { request: {
          transferId: task.nativeTransferId, sessionId: task.sessionId, protocol: task.protocol, direction: task.direction,
          paths: task.paths, destination: task.destination, overwrite: task.overwrite,
          packetSize: task.packetSize, trimPadding: task.trimPadding,
        } });
      }).then(result => {
        if (!result || !['completed', 'skipped', 'cancelled'].includes(result.status)) throw new Error('后端未返回有效传输完成状态');
        // A cancel request can race an already committed file. Only the
        // native outcome decides whether this operation actually completed.
        task.status = result.status; task.cancelled = result.status === 'cancelled'; task.error = '';
        if (Number.isFinite(result?.done)) task.done = result.done;
        if (Number.isFinite(result?.total)) task.total = result.total;
        if (task.total && task.status === 'completed') task.done = task.total;
      }).catch(error => {
        const reason = String(error?.message || error);
        task.status = task.cancelled && /已取消|对端取消|\b(?:cancelled|canceled|cancellation)\b/i.test(reason) ? 'cancelled' : 'failed'; task.error = reason;
      }).finally(() => {
        activeSessions.delete(task.sessionId); task.working = false; task.tab?.wrap?.classList.remove('modem-busy'); sync(task); pump();
        const finished = Array.from(tasks.values()).filter(t => terminal.has(t.status) && !t.working);
        for (const old of finished.slice(0, Math.max(0, finished.length - 200))) tasks.delete(old.id);
      });
    }
  }
  function protocolAvailable(protocol) {
    if (!capability || capability.available === false) return false;
    if (Array.isArray(capability.protocols)) return capability.protocols.some(p => typeof p === 'string' ? p.toLowerCase() === protocol : p.protocol === protocol && p.available !== false);
    return capability.available !== false;
  }
  async function enqueue(options) {
    const tab = options.tab || target;
    if (!live(tab)) throw new Error('请先选中已连接的终端');
    const protocol = String(options.protocol || 'zmodem').toLowerCase(), direction = options.direction || 'upload';
    if (!['xmodem', 'ymodem', 'zmodem'].includes(protocol) || !['upload', 'download'].includes(direction)) throw new Error('传输协议或方向无效');
    const paths = Array.from(new Set((options.paths || []).map(String).filter(Boolean)));
    const destination = String(options.destination || '');
    if (direction === 'upload' && (!paths.length || paths.length > 128 || protocol === 'xmodem' && paths.length !== 1)) throw new Error(protocol === 'xmodem' ? 'XMODEM 每次只能发送一个文件' : '请选择 1–128 个本地文件');
    if (paths.some(path => /[\0\r\n]/.test(path)) || /[\0\r\n]/.test(destination)) throw new Error('路径不能包含换行或空字符');
    if (direction === 'download' && !destination.trim()) throw new Error(protocol === 'xmodem' ? '请指定接收文件的完整路径' : '请选择接收目录');
    if (window.OpsAgent?.isRunning() && window.OpsAgent.getTarget()?.sessionId === nativeId(tab)) throw new Error('请先停止当前机器的运维任务，再启动终端文件传输');
    const task = { id: uid(), nativeTransferId: uid(), tab, sessionId: nativeId(tab), generation: tab._connectionGeneration || 0,
      identity: identity(tab), machine: tab.title || '终端', protocol, direction, paths, destination,
      overwrite: ['rename', 'overwrite', 'skip'].includes(options.overwrite) ? options.overwrite : 'rename',
      packetSize: Number(options.packetSize) === 128 ? 128 : 1024, trimPadding: options.trimPadding === true,
      name: direction === 'upload' ? paths.length === 1 ? basename(paths[0]) : paths.length + ' 个文件' : protocol === 'xmodem' ? basename(destination) : '接收到 ' + destination,
      done: 0, total: 0, speed: 0, status: 'queued', started: 0, error: '', cancelled: false };
    tasks.set(task.id, task); sync(task); pump(); return task;
  }
  function syncForm() {
    if (!form) return;
    const direction = form.elements.direction.value, protocol = form.elements.protocol.value;
    form.querySelector('[data-upload]').hidden = direction !== 'upload';
    form.querySelector('[data-download]').hidden = direction !== 'download';
    form.querySelector('[data-packet]').hidden = protocol === 'zmodem';
    form.querySelector('[data-trim]').hidden = protocol !== 'xmodem' || direction !== 'download';
    form.querySelector('[data-dest-label]').textContent = protocol === 'xmodem' ? '接收文件完整路径' : '接收目录';
    form.elements.destination.placeholder = protocol === 'xmodem' ? '例如 ~/Downloads/firmware.bin' : '例如 ~/Downloads';
    form.querySelector('[data-start]').disabled = !protocolAvailable(protocol) || !live(target);
    const help = form.querySelector('[data-protocol-help]');
    help.textContent = protocol === 'xmodem' ? 'XMODEM 不传文件名和准确长度；接收默认保留末尾填充，二进制文件请勿随意去除 0x1A。'
      : protocol === 'ymodem' ? 'YMODEM 支持文件名、准确大小与批量文件。对端需启动 YMODEM 收发程序。'
      : 'ZMODEM 通过当前终端连接收发文件。对端需启动 rz（接收）或 sz（发送）。';
    if (capability && !protocolAvailable(protocol)) announce(capability.protocols?.find?.(p => p.protocol === protocol)?.reason || capability.reason || '当前连接或系统暂不支持所选协议');
  }
  async function loadFolder(path) {
    const localForm = form, localOverlay = overlay, revision = ++browserGeneration;
    if (!localForm) return;
    const browser = localForm.querySelector('[data-browser]'); browser.hidden = false;
    const list = browser.querySelector('[data-files]'); list.textContent = '正在读取…';
    try {
      const actual = await T.invoke('fs_realpath', { path: path || null });
      const entries = await T.invoke('fs_list', { path: actual });
      if (form !== localForm || overlay !== localOverlay || revision !== browserGeneration) return;
      browser.querySelector('[data-folder]').value = actual; list.textContent = '';
      const parent = button('.. 上一级', () => loadFolder(String(actual).replace(/[\\/]?[^\\/]+[\\/]?$/, '') || actual)); list.append(parent);
      for (const entry of entries.filter(e => !e.is_dir || !e.is_link).sort((a,b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))) {
        const row = document.createElement('div'); row.className = 'modem-file-row';
        if (entry.is_dir) row.append(button('▸ ' + entry.name, () => loadFolder(entry.path)));
        else {
          const checkbox = field('input', 'picked'); checkbox.type = 'checkbox'; checkbox.value = entry.path;
          const current = localForm.elements.paths.value.split(/\r?\n/); checkbox.checked = current.includes(entry.path);
          checkbox.disabled = localForm.elements.direction.value !== 'upload';
          checkbox.addEventListener('change', () => {
            const selected = new Set(localForm.elements.paths.value.split(/\r?\n/).filter(Boolean));
            if (checkbox.checked) selected.add(entry.path); else selected.delete(entry.path);
            localForm.elements.paths.value = Array.from(selected).join('\n');
          });
          const text = label(entry.name + ' · ' + fmt(entry.size || 0), checkbox); row.append(text);
        }
        list.append(row);
      }
      browser.querySelector('[data-use-folder]').hidden = localForm.elements.direction.value !== 'download';
    } catch (error) { if (form === localForm && revision === browserGeneration) list.textContent = String(error?.message || error); }
  }
  function close(restore = true) {
    ++openGeneration; ++browserGeneration; overlay?.remove(); overlay = null; form = null; target = null; capability = null;
    if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  async function open() {
    if (overlay) { form?.querySelector('select')?.focus(); return; }
    target = T.term.activeTab();
    if (!live(target)) { T.ui?.toast('请先选中已连接的终端', 3000, 'err'); return; }
    previousFocus = document.activeElement;
    const revision = ++openGeneration, sessionId = nativeId(target), generation = target._connectionGeneration || 0;
    overlay = document.createElement('div'); overlay.className = 'modem-overlay';
    form = document.createElement('form'); form.className = 'modem-dialog'; form.setAttribute('role', 'dialog'); form.setAttribute('aria-modal', 'true'); form.setAttribute('aria-labelledby', 'modem-title');
    const head = document.createElement('header'), title = document.createElement('h2'); title.id = 'modem-title'; title.textContent = '新建终端文件传输'; head.append(title, button('关闭', () => close()));
    const host = note('目标：' + (target.title || '终端') + ' · 任务绑定当前连接');
    const grid = document.createElement('div'); grid.className = 'modem-grid';
    const protocol = select('protocol', [['zmodem','ZMODEM'],['ymodem','YMODEM'],['xmodem','XMODEM']]);
    const direction = select('direction', [['upload','发送文件'],['download','接收文件']]);
    protocol.onchange = direction.onchange = () => { ++browserGeneration; form.querySelector('[data-browser]').hidden = true; syncForm(); };
    grid.append(label('协议', protocol), label('方向', direction));
    const upload = document.createElement('section'); upload.dataset.upload = '';
    const paths = field('textarea', 'paths', ''); paths.rows = 3; paths.placeholder = '本地文件完整路径，每行一个；或点击浏览选择';
    upload.append(label('发送文件', paths), button('浏览本地文件', () => loadFolder(null)));
    const download = document.createElement('section'); download.dataset.download = '';
    const destination = field('input','destination',''); const destLabel = label('', destination); destLabel.firstChild.dataset.destLabel = '';
    download.append(destLabel, button('浏览接收目录', () => loadFolder(null)));
    const browser = document.createElement('section'); browser.dataset.browser = ''; browser.className = 'modem-browser'; browser.hidden = true;
    const folder = field('input','folder',''); folder.dataset.folder = ''; folder.setAttribute('aria-label','本地浏览目录');
    const folderBar = document.createElement('div'); folderBar.className = 'modem-folder-bar';
    folder.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadFolder(folder.value); } });
    const use = button('使用此目录', () => { destination.value = folder.value; if (protocol.value === 'xmodem') destination.value += (/\\/.test(folder.value) ? '\\' : '/') + 'received.bin'; browser.hidden = true; }); use.dataset.useFolder = '';
    folderBar.append(folder, button('前往', () => loadFolder(folder.value)), use, button('收起', () => { ++browserGeneration; browser.hidden = true; }));
    const list = document.createElement('div'); list.dataset.files = ''; list.className = 'modem-files'; browser.append(folderBar,list);
    const packetLabel = label('数据块', select('packetSize', [['1024','1 KiB'],['128','128 B']])); packetLabel.dataset.packet = '';
    const policy = label('同名文件', select('overwrite', [['rename','保留两份'],['skip','跳过已有文件'],['overwrite','覆盖已有文件']]));
    const trim = field('input','trimPadding'); trim.type = 'checkbox'; const trimLabel = label('XMODEM 接收时去除末尾 0x1A（仅确定是文本时使用）',trim); trimLabel.dataset.trim = '';
    const help = note(''); help.dataset.protocolHelp = '';
    const feedback = note('正在检查传输能力…','modem-feedback'); feedback.dataset.feedback = ''; feedback.setAttribute('role','status');
    const actions = document.createElement('footer'); const start = button('加入传输队列', () => {} ,'primary'); start.type = 'submit'; start.dataset.start = ''; start.disabled = true;
    actions.append(button('取消', () => close()), start);
    form.append(head,host,grid,upload,download,browser,policy,packetLabel,trimLabel,help,note('请先在对端启动对应收发程序。传输期间，此终端暂停普通键盘输入；同一连接的任务依次执行。'),feedback,actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); start.disabled = true;
      try {
        if (!live(target) || nativeId(target) !== sessionId || (target._connectionGeneration || 0) !== generation) throw new Error(changed);
        if (!protocolAvailable(protocol.value)) throw new Error('传输能力未就绪，请检查所选协议');
        await enqueue({ tab: target, protocol: protocol.value, direction: direction.value, paths: paths.value.split(/\r?\n/).filter(p=>p.trim()), destination: destination.value,
          overwrite: form.elements.overwrite.value, packetSize: form.elements.packetSize.value, trimPadding: trim.checked });
        close(false); window.TransferQueue?.open();
      } catch(error) { announce(error); if (form) syncForm(); }
    });
    overlay.append(form); document.body.append(overlay); syncForm(); protocol.focus();
    overlay.addEventListener('pointerdown', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !window.CommonControls?.isOpen) { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(form.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')).filter(el=>!el.closest('[hidden]'));
      const index = focusable.indexOf(document.activeElement);
      if (event.shiftKey && index === 0 || !event.shiftKey && index === focusable.length-1) { event.preventDefault(); focusable[event.shiftKey ? focusable.length-1 : 0]?.focus(); }
    });
    try {
      const result = await T.invoke('modem_capabilities', { sessionId });
      if (revision !== openGeneration || !form) return;
      capability = result || { available: false, reason: '后端未返回有效传输能力' };
      announce(capability.reason || '传输能力已就绪', capability.available === false); syncForm();
    } catch (error) { if (revision === openGeneration && form) { capability = { available:false }; announce(error); syncForm(); } }
  }
  window.ModemTransfer = {
    open, close, isOpen: () => !!overlay, enqueue,
    isBusy: tab => activeSessions.has(typeof tab === 'string' ? tab : nativeId(tab)),
    get tasks() { return Array.from(tasks.values()); },
    onConnectionChange(tab) {
      for (const task of tasks.values()) if (task.tab === tab && !terminal.has(task.status) && !valid(task)) {
        task.error = changed;
        if (!task.working) { task.status = 'failed'; sync(task); }
        else cancel(task).catch(()=>{});
      }
      if (target === tab && form && !live(tab)) { announce(changed); form.querySelector('[data-start]').disabled = true; }
    },
    progress(value) {
      const p = typeof value === 'string' ? JSON.parse(value) : value;
      const task = Array.from(tasks.values()).find(t => t.nativeTransferId === p?.transferId && t.sessionId === p?.sessionId);
      if (!task || !task.working || task.cancelled || !valid(task)) return;
      task.done = Math.max(0, Number(p.done) || 0); task.total = Math.max(0, Number(p.total) || 0);
      if (['preparing','negotiating','running'].includes(p.status)) task.status = p.status;
      if (p.name) task.name = String(p.name);
      task.speed = task.started ? task.done / Math.max(.001, (Date.now()-task.started)/1000) : 0;
      if (p.error) task.error = String(p.error); sync(task);
    },
  };
})();
