/* Session-independent, in-memory transfer activity. Protocol controllers own execution. */
(function () {
  'use strict';
  const T = window.WT;
  const records = new Map(), rows = new Map();
  const terminal = new Set(['completed', 'skipped', 'failed', 'cancelled']);
  const active = new Set(['queued', 'preparing', 'negotiating', 'running', 'paused', 'pausing', 'cancelling']);
  const labels = { queued: '等待中', preparing: '准备中', negotiating: '等待对端', running: '传输中', paused: '已暂停', pausing: '暂停中',
    cancelling: '取消中', completed: '已完成', skipped: '已跳过', failed: '失败', cancelled: '已取消' };
  const filterLabels = { all: '全部', active: '进行中', completed: '已完成', failed: '失败' };
  const actions = { pause: ['pause', '暂停'], resume: ['play', '继续'], cancel: ['x', '取消'], retry: ['refresh', '重试'] };
  const fields = ['id', 'sessionId', 'protocol', 'name', 'direction', 'machine', 'source', 'target', 'done', 'total', 'status', 'speed', 'error'];
  const MAX_FINISHED = 200;
  let root, list, empty, summary, message, clearButton, filter = 'all', previousFocus, sequence = 0;
  const text = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
  const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const element = (tag, className, value) => {
    const n = document.createElement(tag); if (className) n.className = className;
    if (value != null) n.textContent = value; return n;
  };
  function iconButton(icon, label) {
    const n = element('button', 'tq-icon'); n.type = 'button'; n.title = label; n.setAttribute('aria-label', label);
    if (window.Icons) n.innerHTML = window.Icons.svg(icon); else n.textContent = label;
    return n;
  }
  function bytes(value) {
    const n = number(value);
    if (n < 1024) return Math.round(n) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  }
  function matches(task, value = filter) {
    return value === 'all' || (value === 'active' && active.has(task.status)) ||
      (value === 'completed' && ['completed', 'skipped', 'cancelled'].includes(task.status)) ||
      (value === 'failed' && task.status === 'failed') || (value === 'finished' && terminal.has(task.status));
  }
  function available(record, action) {
    const task = record.task;
    if (typeof record.controls[action] !== 'function') return false;
    if (action === 'pause') return ['queued', 'preparing', 'running'].includes(task.status);
    if (action === 'resume') return task.status === 'paused';
    if (action === 'cancel') return active.has(task.status) && task.status !== 'cancelling';
    return ['failed', 'cancelled'].includes(task.status) && !record.task.retryDisabled;
  }
  function snapshot(record) {
    return Object.freeze(Object.fromEntries(fields.map(key => [key, record.task[key]])));
  }
  const settled = record => terminal.has(record.task.status) && !record.pending && !record.task.retryDisabled;
  function updateRow(record) {
    const task = record.task, row = rows.get(task.id);
    if (!row) return;
    const pct = task.total > 0 ? Math.min(100, task.done / task.total * 100) : task.status === 'completed' ? 100 : 0;
    row.dataset.status = task.status;
    row.hidden = !matches(task);
    row._name.textContent = task.name || '未命名文件';
    row._name.title = task.name || '';
    row._direction.textContent = task.direction === 'down' ? '下载' : '上传';
    row._direction.dataset.direction = task.direction;
    row._machine.textContent = task.machine || '当前连接';
    row._protocol.textContent = (task.protocol || '传输').toUpperCase();
    row._path.textContent = [task.source, task.target].filter(Boolean).join(' → ');
    row._path.title = row._path.textContent;
    row._bytes.textContent = bytes(task.done) + ' / ' + (task.total ? bytes(task.total) : '大小待确认');
    row._speed.textContent = task.status === 'running' && task.speed > 0 ? bytes(task.speed) + '/s' : '';
    row._state.textContent = labels[task.status] || task.status;
    row._progress.setAttribute('aria-valuenow', String(Math.round(pct)));
    row._progress.setAttribute('aria-label', (task.name || '文件') + '传输进度');
    row._bar.style.width = pct + '%';
    row._error.textContent = record.actionError || task.error;
    row._error.hidden = !row._error.textContent;
    for (const [action, button] of Object.entries(row._buttons)) {
      button.hidden = !available(record, action);
      button.disabled = !!record.pending;
    }
    row.setAttribute('aria-busy', String(!!record.pending));
  }
  function makeRow(record) {
    const row = element('article', 'tq-task'); row.dataset.task = record.task.id;
    const info = element('div', 'tq-task-info'), title = element('div', 'tq-task-title');
    row._direction = element('span', 'tq-direction'); row._name = element('strong', 'tq-name');
    title.append(row._direction, row._name); info.append(title);
    const details = element('div', 'tq-task-details');
    row._protocol = element('span', 'tq-protocol'); row._machine = element('span', 'tq-machine');
    details.append(row._protocol, row._machine); info.append(details);
    row._path = element('div', 'tq-path'); info.append(row._path);
    row._progress = element('div', 'tq-progress'); row._progress.setAttribute('role', 'progressbar');
    row._progress.setAttribute('aria-valuemin', '0'); row._progress.setAttribute('aria-valuemax', '100');
    row._bar = element('i'); row._progress.append(row._bar); info.append(row._progress);
    row._error = element('div', 'tq-error'); info.append(row._error);
    const meta = element('div', 'tq-task-meta'); row._bytes = element('span', 'tq-bytes');
    row._state = element('span', 'tq-state'); row._speed = element('span', 'tq-speed');
    const controls = element('div', 'tq-controls'); row._buttons = {};
    for (const [action, [icon, label]] of Object.entries(actions)) {
      const button = iconButton(icon, label); button.dataset.action = action;
      button.onclick = () => perform(record.task.id, action); controls.append(button); row._buttons[action] = button;
    }
    meta.append(row._bytes, row._state, row._speed, controls); row.append(info, meta);
    rows.set(record.task.id, row); list.append(row); updateRow(record);
  }
  function render() {
    if (!root) return;
    for (const [id, row] of rows) if (!records.has(id)) { row.remove(); rows.delete(id); }
    for (const record of records.values()) {
      if (!rows.has(record.task.id)) makeRow(record); else updateRow(record);
    }
    const all = [...records.values()], running = all.filter(record => active.has(record.task.status));
    const speed = running.reduce((sum, record) => sum + (record.task.status === 'running' ? record.task.speed : 0), 0);
    summary.textContent = running.length + ' 项进行中' + (speed ? ' · ' + bytes(speed) + '/s' : '') + ' · 共 ' + all.length + ' 项';
    for (const button of root.querySelectorAll('[data-filter]')) {
      const value = button.dataset.filter, count = all.filter(record => matches(record.task, value)).length;
      button.textContent = filterLabels[value] + ' ' + count; button.classList.toggle('on', filter === value);
      button.setAttribute('aria-pressed', String(filter === value));
    }
    const shown = all.filter(record => matches(record.task)); empty.hidden = shown.length > 0;
    empty.textContent = filter === 'all' ? '暂无传输任务。通过 SFTP 上传、下载，或新建 X/Y/ZMODEM 传输。' : '此分类暂无传输任务';
    clearButton.disabled = !all.some(settled);
  }
  function changed() {
    render();
    window.dispatchEvent(new CustomEvent('transfer-queue-change', { detail: {
      active: [...records.values()].filter(record => active.has(record.task.status)).length,
      total: records.size, open: Queue.isOpen(),
    } }));
  }
  function prune() {
    const finished = [...records.values()].filter(settled);
    for (const record of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) records.delete(record.task.id);
  }
  async function perform(id, action) {
    const record = records.get(id);
    if (!record || record.pending || !available(record, action)) return false;
    record.pending = action; record.actionError = ''; updateRow(record);
    try {
      await record.controls[action]();
      return true;
    } catch (error) {
      record.actionError = '操作未完成：' + text(error?.message || error || '未知错误');
      return false;
    } finally {
      record.pending = null; prune(); changed();
    }
  }
  const Queue = {
    mount(el) {
      if (root) return root;
      root = el || document.getElementById('transfer-queue-panel');
      if (!root) { root = element('section'); root.id = 'transfer-queue-panel'; (document.getElementById('main-area') || document.body).append(root); }
      root.classList.add('transfer-queue-panel'); root.hidden = true; root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', '传输队列'); root.setAttribute('aria-modal', 'false');
      const header = element('header', 'tq-header'); header.append(element('strong', '', '传输队列'));
      summary = element('span', 'tq-summary'); header.append(summary);
      const create = element('button', 'tq-create', '新建 X/Y/ZMODEM 传输'); create.type = 'button'; create.dataset.action = 'new-modem';
      create.onclick = () => {
        if (window.ModemTransfer?.open) window.ModemTransfer.open();
        else { message.textContent = 'X/Y/ZMODEM 传输模块未加载'; message.hidden = false; }
      };
      const sftp = element('button', '', 'SFTP'); sftp.type = 'button'; sftp.dataset.action = 'sftp';
      sftp.onclick = () => { if (window.SftpPanel?.open) { Queue.close(false); SftpPanel.open(); } };
      const close = iconButton('x', '关闭传输队列'); close.dataset.action = 'close'; close.onclick = () => Queue.close();
      header.append(create, sftp, close);
      const toolbar = element('div', 'tq-toolbar'), filters = element('div', 'tq-filters'); filters.setAttribute('aria-label', '筛选传输任务');
      for (const [value, label] of Object.entries(filterLabels)) {
        const button = element('button', '', label); button.type = 'button'; button.dataset.filter = value;
        button.onclick = () => { filter = value; render(); }; filters.append(button);
      }
      clearButton = element('button', 'tq-clear', '清除已结束'); clearButton.type = 'button';
      clearButton.dataset.action = 'clear'; clearButton.onclick = () => this.clear(); toolbar.append(filters, clearButton);
      message = element('div', 'tq-message'); message.setAttribute('role', 'status'); message.hidden = true;
      list = element('div', 'tq-list'); list.setAttribute('aria-label', '传输任务列表'); list.tabIndex = 0;
      empty = element('div', 'tq-empty'); root.replaceChildren(header, toolbar, message, list, empty);
      root.addEventListener('keydown', event => {
        // Keep terminal shortcuts and input away from this floating panel.
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); Queue.close(); }
      });
      render(); return root;
    },
    open() {
      this.mount();
      if (this.isOpen()) return;
      T?.ui?.closeDock?.();
      previousFocus = document.activeElement; root.hidden = false; message.hidden = true;
      render(); root.querySelector('[data-action="new-modem"]').focus(); changed();
    },
    close(restoreFocus = true) {
      if (!root || root.hidden) return;
      root.hidden = true;
      if (restoreFocus) {
        if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus();
        else T?.term?.activeTab?.()?.term?.focus?.();
      }
      changed();
    },
    toggle() { return this.isOpen() ? this.close() : this.open(); },
    isOpen: () => !!root && !root.hidden,
    upsert(task, options = {}) {
      if (!task || !text(task.id)) throw new Error('传输任务缺少 ID');
      const id = text(task.id), previous = records.get(id);
      const value = { ...(previous?.task || { id, protocol: '', name: '', direction: 'up', machine: '', source: '', target: '', done: 0, total: 0, status: 'queued', speed: 0, error: '' }) };
      for (const key of fields) if (Object.hasOwn(task, key)) value[key] = ['done', 'total', 'speed'].includes(key) ? number(task[key]) : text(task[key]);
      value.id = id; value.status = labels[value.status] ? value.status : 'queued';
      value.direction = value.direction === 'down' ? 'down' : 'up';
      value.retryDisabled = task.retryDisabled === true;
      const record = previous || { controls: {}, actionError: '', pending: null, sequence: ++sequence };
      record.task = value;
      if (Object.hasOwn(options, 'controls')) record.controls = { ...(options.controls || {}) };
      // A genuine protocol update replaces an earlier UI action error.
      if (previous && previous._status !== value.status) record.actionError = '';
      record._status = value.status; records.set(id, record); prune(); changed(); return snapshot(record);
    },
    remove(id) {
      const record = records.get(String(id));
      if (!record || !settled(record)) return false;
      records.delete(String(id)); changed(); return true;
    },
    clear(value = 'finished') {
      let count = 0;
      for (const [id, record] of records) if (settled(record) && matches(record.task, value)) { records.delete(id); count++; }
      changed(); return count;
    },
    notify: changed,
    perform,
    get tasks() { return Object.freeze([...records.values()].map(snapshot)); },
  };
  window.TransferQueue = Queue;
})();
