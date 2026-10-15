// Real SFTP frontend, jsdom DOM, and an in-memory implementation of its native command bridge.
// The bridge validates paths and arguments, performs mutations, and leaves transfers pending
// until a test completes or cancels them. No frontend function or task state is replaced.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const results = [];
const fatal = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: !!condition, detail: condition ? '' : String(detail) });
}
function equal(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function settle(n = 8) { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); }
async function until(fn, message) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 2)); }
  throw new Error(message || 'timed out');
}
const tab = (id, host, user = 'alice') => ({
  id, title: host || 'Local', session: host ? { protocol: 'ssh', host, user, port: 22 } : null,
  term: { options: {}, focus() {} }, fit: { fit() {} }, exited: false,
});

function harness({ active = tab('ssh-a', 'alpha.example'), preferences = {} } = {}) {
  const errors = [], calls = [], toasts = [], confirmAnswers = [], transfers = new Map();
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(readFileSync(SRC + '/index.html', 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
  });
  const { window: w } = dom, d = w.document;
  const stores = new Map();
  const localHome = '/home/local', remoteHomes = { 'ssh-a': '/home/alice', 'ssh-b': '/srv/bob' };
  let revision = 1, persisted = 0, interceptor = null, nativeDrop, nativeTarget, hitPosition;
  function store(side, id) {
    const key = side === 'local' ? 'local' : id;
    if (!stores.has(key)) stores.set(key, new Map());
    return stores.get(key);
  }
  function home(side, id) { return side === 'local' ? localHome : remoteHomes[id] || '/home/alice'; }
  function normalize(side, id, value) {
    return posix.resolve(home(side, id), value == null || value === '~' ? '.' : String(value));
  }
  function put(side, id, path, { directory = false, content = '', binary = false, modified = 1700000000, permissions = 0o644 } = {}) {
    const map = store(side, id), p = normalize(side, id, path);
    map.set(p, { path: p, is_dir: directory, content, binary, modified, permissions, revision: `rev-${revision++}` });
    return p;
  }
  function entry(n) {
    return n && { name: posix.basename(n.path), path: n.path, is_dir: n.is_dir, size: n.is_dir ? 0 : Buffer.byteLength(n.content), modified: n.modified, permissions: n.permissions, revision: n.revision };
  }
  function need(side, id, path) {
    const n = store(side, id).get(normalize(side, id, path));
    if (!n) throw new Error(`No such file: ${path}`);
    return n;
  }
  function list(side, id, path) {
    const p = normalize(side, id, path), n = need(side, id, p);
    if (!n.is_dir) throw new Error(`Not a directory: ${p}`);
    return [...store(side, id).values()].filter(v => v.path !== p && posix.dirname(v.path) === p).map(entry);
  }
  function copyTree(fromMap, from, toMap, to, move = false, policy = 'overwrite') {
    const source = fromMap.get(from);
    if (!source) throw new Error(`No such file: ${from}`);
    const existing = toMap.get(to);
    if (existing && policy === 'skip') return 'skipped';
    if (existing && policy === 'rename') {
      const ext = posix.extname(to), base = to.slice(0, to.length - ext.length);
      let i = 1; while (toMap.has(`${base} (${i})${ext}`)) i++;
      to = `${base} (${i})${ext}`;
    }
    const sourceNodes = [...fromMap.values()].filter(n => n.path === from || n.path.startsWith(from + '/'));
    for (const n of sourceNodes) {
      const dest = to + n.path.slice(from.length);
      toMap.set(dest, { ...n, path: dest, revision: `rev-${revision++}` });
      if (move) fromMap.delete(n.path);
    }
    return 'completed';
  }
  for (const [side, id] of [['local', null], ['remote', 'ssh-a'], ['remote', 'ssh-b']]) {
    const h = home(side, id);
    for (const dir of ['/', '/home', '/srv', h, h + '/docs', h + '/empty', h + '/target']) put(side, id, dir, { directory: true, permissions: 0o755 });
    put(side, id, h + '/alpha.txt', { content: 'alpha original', modified: 1700000001 });
    put(side, id, h + '/beta.txt', { content: 'B'.repeat(60), modified: 1700000003 });
    put(side, id, h + '/zeta.log', { content: 'z'.repeat(180), modified: 1700000002 });
    put(side, id, h + '/.secret', { content: 'hidden' });
    put(side, id, h + '/binary.dat', { content: '\0\u0001', binary: true });
    put(side, id, h + '/docs/nested.txt', { content: 'nested' });
    put(side, id, h + '/<img src=x onerror=alert(1)>.txt', { content: 'untrusted filename' });
  }
  // Most existing scenarios deliberately keep hidden files off and use one worker;
  // the defaults scenario below removes both settings to exercise first launch.
  const T = w.WT = { s: { sftp: { layout: 'horizontal', concurrency: 1, showHidden: false, ...preferences }, theme: 'tabby-dark' }, persistSettings() { persisted++; } };
  w.UI = { toast(message, duration, kind) { toasts.push({ message, kind }); }, status() {} };
  w.Home = { hide() {}, show() {} };
  w.Settings = { isOpen: () => false };
  w.Profiles = { isOpen: () => false };
  w.confirm = message => { calls.push(['confirm', { message }]); return confirmAnswers.shift() ?? false; };
  w.Element.prototype.scrollIntoView = function () {};
  w.Element.prototype.setPointerCapture = function (id) { (this.testPointerCapture ||= new Set()).add(id); };
  w.Element.prototype.hasPointerCapture = function (id) { return !!this.testPointerCapture?.has(id); };
  w.Element.prototype.releasePointerCapture = function (id) { this.testPointerCapture?.delete(id); };
  w.navigator.clipboard = { writeText: async text => calls.push(['clipboard', { text }]) };
  w.__TAURI__ = { webview: { getCurrentWebview: () => ({ onDragDropEvent: async callback => { nativeDrop = callback; return () => {}; } }) } };
  d.elementFromPoint = (x, y) => { hitPosition = { x, y }; return nativeTarget; };
  // Menu rendering is the surrounding application's dependency. Menu handlers come from sftp.js.
  w.TabBar = {
    openMenu(x, y, build) {
      d.querySelector('.test-context-menu')?.remove();
      const menu = d.createElement('div'); menu.className = 'test-context-menu'; d.body.appendChild(menu);
      build(menu, (host, opts) => {
        const b = d.createElement('button'); b.textContent = opts.label; b.disabled = !!opts.disabled;
        b.onclick = () => { host.remove(); return opts.onClick(); }; host.appendChild(b);
      });
    },
  };
  w.addEventListener('error', e => errors.push(e.message));
  for (const name of ['style.css', 'sftp.css']) {
    const style = d.createElement('style'); style.dataset.file = name; style.textContent = readFileSync(SRC + '/' + name, 'utf8'); d.head.appendChild(style);
  }
  for (const name of ['icons.js', 'common-controls.js', 'term.js', 'sftp.js']) w.eval(readFileSync(SRC + '/' + name, 'utf8'));
  const P = w.SftpPanel, TM = T.term;
  let activeTab = active;
  TM.tabs = Object.fromEntries(active ? [[active.id, active]] : []); TM.order = active ? [active.id] : []; TM.activeTab = () => activeTab;
  T.invoke = async (command, args = {}) => {
    calls.push([command, { ...args }]);
    if (interceptor) { const result = interceptor(command, args); if (result) return await result; }
    if (command === 'sftp_transfer_start') {
      if (!args.transferId || typeof args.upload !== 'boolean' || !args.local || !args.remote) throw new Error('Missing transfer command arguments');
      if (transfers.has(args.transferId)) throw new Error('Duplicate transfer ID');
      return await new Promise((resolve, reject) => { transfers.set(args.transferId, { args: { ...args }, resolve, reject }); });
    }
    if (command === 'sftp_transfer_control') {
      const tr = transfers.get(args.transferId);
      if (!tr) throw new Error('Unknown transfer ID');
      if (args.action === 'cancel') { P.progress({ transferId: args.transferId, sessionId: tr.args.id, status: 'cancelled' }); tr.reject(new Error('cancelled')); transfers.delete(args.transferId); }
      else if (args.action === 'pause' || args.action === 'resume') P.progress({ transferId: args.transferId, sessionId: tr.args.id, status: args.action === 'pause' ? 'paused' : 'running' });
      else throw new Error('Unknown control action');
      return null;
    }
    const match = /^(fs|sftp)_(realpath|list|stat|rename|remove|mkdir|create_file|copy|read_file|write_file|chmod)$/.exec(command);
    if (!match) throw new Error('Unsupported bridge command: ' + command);
    const side = match[1] === 'fs' ? 'local' : 'remote', op = match[2], id = args.id, map = store(side, id);
    if (side === 'remote' && !TM.findByPty(id)?.session) throw new Error('Unknown SSH session');
    const path = normalize(side, id, args.path);
    if (op === 'realpath') { need(side, id, path); return path; }
    if (op === 'list') return list(side, id, path);
    if (op === 'stat') return entry(map.get(path)) || null;
    if (op === 'read_file') { const n = need(side, id, path); if (n.binary) throw new Error('Binary files cannot be edited'); return { kind: 'text', content: n.content, size: Buffer.byteLength(n.content), modified: n.modified, revision: n.revision }; }
    if (op === 'write_file') {
      const n = need(side, id, path);
      if (!args.force && (args.expectedRevision !== n.revision || args.expectedModified !== n.modified)) throw new Error('File changed: revision conflict');
      n.content = args.content; n.modified++; n.revision = `rev-${revision++}`; return null;
    }
    if (op === 'rename') { const from = normalize(side, id, args.from), to = normalize(side, id, args.to); if (map.has(to)) throw new Error('Target already exists'); copyTree(map, from, map, to, true); return null; }
    if (op === 'copy') { if (typeof args.moveItem !== 'boolean') throw new Error('copy requires moveItem'); const from = normalize(side, id, args.from), to = normalize(side, id, args.to); if (map.has(to)) throw new Error('Target already exists'); copyTree(map, from, map, to, args.moveItem); return null; }
    if (op === 'remove') { const n = need(side, id, path); if (n.is_dir && !args.recursive) throw new Error('Directory removal requires recursive'); for (const p of map.keys()) if (p === path || p.startsWith(path + '/')) map.delete(p); return null; }
    if (op === 'mkdir' || op === 'create_file') { if (map.has(path)) throw new Error('Target already exists'); put(side, id, path, { directory: op === 'mkdir' }); return null; }
    if (op === 'chmod') { need(side, id, path).permissions = args.mode; return null; }
  };
  P.mount(d.getElementById('sftp-panel')); TM.applyTheme('tabby-dark');
  const q = s => d.querySelector(s), qa = s => [...d.querySelectorAll(s)];
  const pane = side => q(`#sftp-panel [data-side="${side}"]`);
  const rows = side => [...pane(side).querySelectorAll('tr[data-path]')];
  const row = (side, name) => rows(side).find(r => r.dataset.path.endsWith('/' + name));
  async function go(side, path) { const input = pane(side).querySelector('.sftp-path'); input.value = path; input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle(); }
  async function action(side, name) { const el = (side ? pane(side) : q('#sftp-panel')).querySelector(`[data-action="${name}"]`); if (!el) throw new Error('Missing action: ' + name); el.click(); await settle(); }
  async function key(side, key, opts = {}) { pane(side).querySelector('.sftp-list').dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, ...opts })); await settle(); }
  function clickRow(side, name, opts = {}) { const r = row(side, name); if (!r) throw new Error('Missing row: ' + side + '/' + name); r.dispatchEvent(new w.MouseEvent('click', { bubbles: true, ...opts })); }
  async function menu(side, name, label) { const r = row(side, name); if (!r) throw new Error('Missing context row: ' + name); r.dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 })); const b = qa('.test-context-menu button').find(b => b.textContent === label); if (!b) throw new Error('Missing context command: ' + label); b.click(); await settle(); }
  async function dialog(label) { const b = qa('#sftp-panel .sftp-modal:last-child .sftp-modal-actions button').find(b => b.textContent === label); if (!b) throw new Error('Missing dialog button: ' + label); b.click(); await settle(); }
  async function finish(id) {
    const tr = transfers.get(id); if (!tr) throw new Error('Transfer not running: ' + id);
    const { args } = tr, sourceMap = store(args.upload ? 'local' : 'remote', args.id), targetMap = store(args.upload ? 'remote' : 'local', args.id);
    const status = copyTree(sourceMap, args.upload ? args.local : args.remote, targetMap, args.upload ? args.remote : args.local, false, args.policy);
    const n = sourceMap.get(args.upload ? args.local : args.remote), total = n.is_dir ? 0 : Buffer.byteLength(n.content);
    P.progress({ transferId: id, sessionId: args.id, done: total, total, status }); tr.resolve(null); transfers.delete(id); await settle();
  }
  function pointer(type, target, opts = {}) {
    const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...opts });
    Object.defineProperty(ev, 'pointerId', { value: opts.pointerId ?? 1 });
    Object.defineProperty(ev, 'isPrimary', { value: opts.isPrimary ?? true });
    target.dispatchEvent(ev);
    return ev;
  }
  async function drag(fromSide, name, target) {
    pointer('pointerdown', row(fromSide, name)); nativeTarget = target;
    pointer('pointermove', q('#sftp-panel'), { clientX: 80, clientY: 80 });
    pointer('pointerup', q('#sftp-panel'), { clientX: 80, clientY: 80 }); await settle();
  }
  return { w, d, T, TM, P, calls, errors, toasts, confirmAnswers, transfers, q, qa, pane, rows, row, put, store, list, need, go, action, key, clickRow, menu, dialog, finish,
    pointer, drag,
    setHitTarget(target) { nativeTarget = target; },
    get hitPosition() { return hitPosition; },
    setInterceptor(fn) { interceptor = fn; },
    async nativeDrop(paths, side) { nativeTarget = pane(side); await nativeDrop({ payload: { type: 'drop', paths, position: { x: 10, y: 10 } } }); await settle(); },
    async nativeEvent(payload, target) { nativeTarget = target; await nativeDrop({ payload }); await settle(); },
    async activate(next) { activeTab = next; if (next) { TM.tabs[next.id] = next; if (!TM.order.includes(next.id)) TM.order.push(next.id); } P.onSessionChange(); await settle(); },
    get persisted() { return persisted; },
    async close() { for (const tr of transfers.values()) tr.reject(new Error('cancelled during test cleanup')); transfers.clear(); await settle(); dom.window.close(); },
  };
}

async function scenario(name, fn, options) {
  const h = harness(options);
  try { await fn(h); }
  catch (e) { fatal.push(name + ': ' + (e.stack || e)); }
  finally { check(name + ' 无未处理的 DOM/JS 错误', h.errors.length === 0, h.errors.join('; ')); await h.close(); }
}

await scenario('A 工作区/列表', async h => {
  await h.P.open();
  check('A1 独立面板真实挂载两栏、路径、队列和工具条', h.P.isOpen() && h.qa('#sftp-panel .sftp-pane').length === 2 && !!h.q('.sftp-queue') && h.qa('.sftp-head-actions button').length === 6);
  equal('A2 两栏真实 canonical 路径', [h.P.context.local.path, h.P.context.remote.path], ['/home/local', '/home/alice']);
  check('A3 文件名按文字转义，不能注入图片', !h.q('.sftp-file img') && h.pane('local').textContent.includes('<img src=x onerror=alert(1)>.txt'));
  check('A4 已保存的隐藏点文件设置继续生效', !h.row('local', '.secret') && !h.row('remote', '.secret'));
  check('A5 目录优先，普通文件按名称自然排序', h.rows('local').slice(0, 3).every(r => /\/(docs|empty|target)$/.test(r.dataset.path)));
  h.clickRow('local', 'alpha.txt'); h.clickRow('local', 'beta.txt', { ctrlKey: true });
  equal('A6 Ctrl 多选保留两个真实 path', [...h.P.context.local.selected].sort(), ['/home/local/alpha.txt', '/home/local/beta.txt']);
  h.clickRow('local', 'zeta.log', { shiftKey: true });
  check('A7 Shift 范围多选与 aria-selected 同步', h.P.context.local.selected.size >= 3 && h.qa('[data-side="local"] tr[aria-selected="true"]').length === h.P.context.local.selected.size);
  await h.key('local', 'a', { ctrlKey: true });
  equal('A8 全选只包含可见条目', h.P.context.local.selected.size, h.rows('local').length);
  h.pane('local').querySelector('[data-sort="size"]').click();
  equal('A9 大小升序真实数值排序', h.rows('local').filter(r => !h.P.context.local.entries.find(e => e.path === r.dataset.path).is_dir).map(r => h.P.context.local.entries.find(e => e.path === r.dataset.path).size), [2, 14, 18, 60, 180]);
  h.pane('local').querySelector('[data-sort="size"]').click();
  check('A10 再点列头倒序且目录仍优先', h.rows('local')[0].dataset.path.endsWith('/docs') && h.rows('local')[3].dataset.path.endsWith('/zeta.log'));
  await h.action('local', 'filter'); const filter = h.pane('local').querySelector('.sftp-filter input'); filter.value = 'BETA'; filter.dispatchEvent(new h.w.Event('input', { bubbles: true }));
  equal('A11 筛选忽略大小写并只渲染匹配文件', h.rows('local').map(r => r.dataset.path), ['/home/local/beta.txt']);
  await h.action('local', 'filter');
  check('A12 关闭筛选清空查询并恢复列表', !h.P.context.local.filter && h.rows('local').length > 1);
  await h.action(null, 'settings'); h.q('[data-pref="showHidden"]').checked = true; await h.dialog('保存');
  check('A13 设置保存显示隐藏文件并持久化', !!h.row('local', '.secret') && h.T.s.sftp.showHidden && h.persisted > 0);
  await h.action(null, 'layout');
  check('A14 切换上下布局真实写入 DOM 与设置', h.q('#sftp-panel').dataset.layout === 'vertical' && h.T.s.sftp.layout === 'vertical');
  await h.action(null, 'layout'); check('A15 远程单栏模式可切换', h.q('#sftp-panel').dataset.layout === 'single');
  await h.action(null, 'maximize'); check('A16 最大化切换 class', h.q('#sftp-panel').classList.contains('maximized'));
  await h.go('local', '/home/local/docs'); h.clickRow('local', 'nested.txt'); await h.go('local', '/home/local'); h.clickRow('local', 'alpha.txt', { shiftKey: true });
  equal('A16b 导航后第一次 Shift 点击不使用上一目录的 anchor', [...h.P.context.local.selected], ['/home/local/alpha.txt']);
  await h.action(null, 'close'); check('A17 面板关闭状态正确', !h.P.isOpen());
});

await scenario('B 导航/书签/会话隔离', async h => {
  await h.P.open(); await h.go('remote', '/home/alice/docs');
  check('B1 Enter 路径导航读取真实子目录', h.P.context.remote.path === '/home/alice/docs' && !!h.row('remote', 'nested.txt'));
  await h.action('remote', 'back'); check('B2 后退恢复家目录', h.P.context.remote.path === '/home/alice');
  await h.action('remote', 'forward'); check('B3 前进恢复子目录', h.P.context.remote.path === '/home/alice/docs');
  await h.action('remote', 'up'); check('B4 上级目录解析正确', h.P.context.remote.path === '/home/alice');
  await h.go('remote', '/home/alice/docs'); await h.action('remote', 'bookmarks'); h.q('[aria-label="书签名称"]').value = 'Alpha docs'; await h.dialog('收藏当前目录');
  equal('B5 当前连接书签保存 canonical 路径与作用域', h.T.s.sftp.bookmarks.map(b => [b.name, b.path, b.scope, b.connection]), [['Alpha docs', '/home/alice/docs', 'connection', 'alice@alpha.example:22']]);
  await h.action('remote', 'home'); await h.action('remote', 'bookmarks'); h.q('[data-bookmark="0"]').click(); await settle();
  check('B6 书签点击实际导航', h.P.context.remote.path === '/home/alice/docs');
  await h.activate(tab('ssh-b', 'beta.example', 'bob'));
  equal('B7 另一个 SSH 会话独立家目录与上下文', [h.P.context.id, h.P.context.remote.path], ['ssh-b', '/srv/bob']);
  await h.action('remote', 'bookmarks'); check('B8 连接专属书签不泄漏给另一个会话', !h.q('[data-bookmark]')); await h.dialog('关闭');
  await h.go('remote', '/srv/bob/empty'); await h.activate(h.TM.tabs['ssh-a']);
  equal('B9 切回会话恢复其路径，记忆设置按连接隔离', [h.P.context.remote.path, h.T.s.sftp.paths['alice@alpha.example:22'].remote, h.T.s.sftp.paths['bob@beta.example:22'].remote], ['/home/alice/docs', '/home/alice/docs', '/srv/bob/empty']);
  await h.action(null, 'pathMode'); check('B10 路径模式由记忆切为跟随终端', h.T.s.sftp.pathMode === 'sync');
  h.P.syncCwd('ssh-a', '/home/alice/empty'); await settle(); check('B11 当前会话 cwd 同步目录', h.P.context.remote.path === '/home/alice/empty');
  h.P.syncCwd('ssh-b', '/srv/bob/docs'); await h.activate(h.TM.tabs['ssh-b']); check('B12 后台会话 cwd 更新不串当前会话', h.P.context.remote.path === '/srv/bob/docs');
  equal('B13 POSIX 与 Windows 根路径处理', [h.P.parent('/'), h.P.parent('/home/alice'), h.P.parent('C:\\'), h.P.join('C:\\Users', 'a.txt', 'local')], ['/', '/home', 'C:\\', 'C:\\Users\\a.txt']);
});

await scenario('C 文件操作真实命令', async h => {
  await h.P.open();
  h.clickRow('local', 'alpha.txt'); await h.key('local', 'c', { ctrlKey: true }); await h.go('local', '/home/local/target'); await h.key('local', 'v', { ctrlKey: true });
  check('C1 复制后目标内容真实创建且源保留', h.need('local', null, '/home/local/target/alpha.txt').content === 'alpha original' && !!h.store('local').get('/home/local/alpha.txt'));
  equal('C2 fs_copy 参数含源、目标与 moveItem=false', h.calls.find(([c]) => c === 'fs_copy')?.[1], { from: '/home/local/alpha.txt', to: '/home/local/target/alpha.txt', moveItem: false });
  await h.go('local', '/home/local'); h.clickRow('local', 'beta.txt'); await h.key('local', 'x', { ctrlKey: true }); await h.go('local', '/home/local/target'); await h.key('local', 'v', { ctrlKey: true });
  check('C3 剪切粘贴真实移动源文件', !h.store('local').has('/home/local/beta.txt') && h.store('local').has('/home/local/target/beta.txt'));
  equal('C4 剪切 fs_copy moveItem=true', h.calls.filter(([c]) => c === 'fs_copy').at(-1)?.[1], { from: '/home/local/beta.txt', to: '/home/local/target/beta.txt', moveItem: true });
  h.clickRow('local', 'alpha.txt'); await h.key('local', 'F2'); h.q('.sftp-modal input[type="text"]').value = '../escape'; await h.dialog('确定');
  check('C5 重命名拒绝路径分隔符且不调用后端', !!h.q('.sftp-modal-error:not([hidden])') && !h.calls.some(([c]) => c === 'fs_rename'));
  h.q('.sftp-modal input[type="text"]').value = 'renamed.txt'; await h.dialog('确定');
  equal('C6 重命名命令与真实目录更新', h.calls.find(([c]) => c === 'fs_rename')?.[1], { from: '/home/local/target/alpha.txt', to: '/home/local/target/renamed.txt' });
  check('C7 重命名后新文件存在', !!h.row('local', 'renamed.txt') && !h.row('local', 'alpha.txt'));
  await h.menu('local', 'renamed.txt', '新建文件夹'); h.q('.sftp-modal input[type="text"]').value = 'created'; await h.dialog('确定');
  equal('C8 新建目录命令含完整 path', h.calls.find(([c]) => c === 'fs_mkdir')?.[1], { path: '/home/local/target/created' });
  h.clickRow('local', 'renamed.txt'); h.clickRow('local', 'created', { ctrlKey: true }); await h.key('local', 'Delete'); await h.dialog('删除');
  equal('C9 多选删除分别传递 recursive 参数', h.calls.filter(([c]) => c === 'fs_remove').map(([, a]) => a).sort((a, b) => a.path.localeCompare(b.path)), [{ path: '/home/local/target/created', recursive: true }, { path: '/home/local/target/renamed.txt', recursive: false }]);
  check('C10 删除后目录真实不存在', !h.store('local').has('/home/local/target/created') && !h.store('local').has('/home/local/target/renamed.txt'));
  await h.menu('remote', 'alpha.txt', '权限'); h.q('[data-bit="64"]').checked = true; await h.dialog('保存');
  equal('C11 远端 chmod 使用当前 SSH id 与数值权限', h.calls.find(([c]) => c === 'sftp_chmod')?.[1], { id: 'ssh-a', path: '/home/alice/alpha.txt', mode: 0o744 });
  h.need('remote', 'ssh-a', '/home/alice/alpha.txt').permissions = 0o2775; await h.P.refresh('remote');
  await h.menu('remote', 'alpha.txt', '权限');
  check('C12 权限弹窗显示完整八进制模式', h.q('[data-mode]').textContent === '2775');
  h.q('[data-bit="8"]').checked = false; await h.dialog('保存');
  check('C13 修改 rwx 权限保留 setgid 等特殊位', h.calls.filter(([c]) => c === 'sftp_chmod').at(-1)[1].mode === 0o2765);
});

await scenario('D 编辑与并发保存', async h => {
  await h.P.open(); await h.menu('remote', 'alpha.txt', '查看 / 编辑');
  const input = h.q('.sftp-editor textarea'); check('D1 查看/编辑读取真实文本内容', input.value === 'alpha original');
  const initial = { ...h.need('remote', 'ssh-a', '/home/alice/alpha.txt') }; input.value = 'edited'; h.q('[data-save]').click(); await settle();
  equal('D2 保存调用携带修改时间与 revision', h.calls.find(([c]) => c === 'sftp_write_file')?.[1], { id: 'ssh-a', path: '/home/alice/alpha.txt', content: 'edited', expectedModified: initial.modified, expectedRevision: initial.revision, force: false });
  check('D3 保存更新后端内容并写入真实编辑记录', h.need('remote', 'ssh-a', '/home/alice/alpha.txt').content === 'edited' && h.T.s.sftp.history[0].direction === 'edit');
  h.put('remote', 'ssh-a', '/home/alice/alpha.txt', { content: 'external newer', modified: 1800000000 }); input.value = 'second edit'; h.confirmAnswers.push(false); h.q('[data-save]').click(); await settle();
  check('D4 保存冲突拒绝覆盖时保留外部内容并显示错误', h.need('remote', 'ssh-a', '/home/alice/alpha.txt').content === 'external newer' && !h.q('.sftp-modal-error').hidden);
  h.confirmAnswers.push(true); h.q('[data-save]').click(); await settle();
  check('D5 明确确认覆盖后才 force=true 保存', h.calls.filter(([c]) => c === 'sftp_write_file').at(-1)?.[1].force === true && h.need('remote', 'ssh-a', '/home/alice/alpha.txt').content === 'second edit');
  input.value = 'unsaved'; h.confirmAnswers.push(false); h.q('[data-close]').click(); await settle(); check('D6 放弃修改提示拒绝后保持编辑器', !!h.q('.sftp-editor'));
  h.confirmAnswers.push(true); h.q('[data-close]').click(); await settle(); check('D7 确认放弃后关闭编辑器', !h.q('.sftp-editor'));
  await h.menu('remote', 'binary.dat', '查看 / 编辑');
  check('D8 二进制读失败仅提示错误，不打开可编辑内容', !h.q('.sftp-editor') && h.toasts.some(t => /Binary files/.test(t.message)) && !h.calls.some(([c, a]) => c === 'sftp_write_file' && a.path.endsWith('/binary.dat')));
  await h.menu('remote', 'alpha.txt', '查看 / 编辑'); await h.activate(tab('ssh-b', 'beta.example', 'bob'));
  check('D9 切换终端期间打开的文件仍保留原会话内容', h.q('.sftp-editor textarea')?.value === 'second edit');
  h.q('[data-close]').click(); await settle();
  check('D10 关闭旧会话编辑器后文件面板跟随已激活的新会话', h.P.context.id === 'ssh-b' && h.pane('remote').querySelector('.sftp-path').value === '/srv/bob');
});

await scenario('E 传输队列/任务ID/控制', async h => {
  await h.P.open(); await h.go('remote', '/home/alice/target');
  h.clickRow('local', 'alpha.txt'); h.clickRow('local', 'beta.txt', { ctrlKey: true }); await h.menu('local', 'alpha.txt', '上传到远程');
  await until(() => h.transfers.size === 1, 'upload not started');
  const [first, queued] = h.P.tasks;
  equal('E1 队列并发 1 时首项 running 次项 queued', [first.status, queued.status], ['running', 'queued']);
  h.P.progress({ transferId: first.id, sessionId: 'ssh-a', done: 0, total: 0, status: 'preparing' });
  check('E1b 大目录准备阶段仍显示暂停/取消与进行中计数', !!h.q(`[data-task="${first.id}"] [data-action="pause"]`) && !!h.q(`[data-task="${first.id}"] [data-action="cancel"]`) && h.q('.sftp-queue-head b').textContent.includes('2 项进行中'));
  h.P.progress({ transferId: first.id, sessionId: 'ssh-a', done: 0, total: 14, status: 'running' });
  check('E2 每个传输有不同 UUID 且当前 SSH sessionId', first.id !== queued.id && !!first.id && first.sessionId === 'ssh-a');
  equal('E3 上传真实参数包含任务ID与目标路径', h.calls.find(([c]) => c === 'sftp_transfer_start')?.[1], { id: 'ssh-a', transferId: first.id, local: '/home/local/alpha.txt', remote: '/home/alice/target/alpha.txt', upload: true, policy: 'skip' });
  await h.P.enqueue(h.P.context, 'local', [h.P.context.local.entries.find(e => e.name === 'alpha.txt')], h.P.context, 'remote');
  equal('E4 进行中的相同源目标只排队一次', h.P.tasks.length, 2);
  h.P.progress({ transferId: first.id, sessionId: 'wrong-session', done: 9, total: 14, status: 'failed' }); equal('E5 不同会话的相同任务ID不能改进度', [first.done, first.status], [0, 'running']);
  h.P.progress({ transferId: first.id, sessionId: 'ssh-a', done: 7, total: 14, status: 'running' });
  check('E6 进度定位真实任务且 DOM 显示 50%', first.done === 7 && h.q(`[data-task="${first.id}"] .sftp-progress i`).style.width === '50%');
  check('E6b 运行任务的字节和速度位于同一个右侧统计区域', h.q(`[data-task="${first.id}"] .sftp-queue-meta .sftp-queue-bytes`).textContent === '7 B / 14 B' && h.q(`[data-task="${first.id}"] .sftp-queue-meta .sftp-queue-speed`).textContent.includes('/s'));
  await h.P.control(first, 'pause'); equal('E7 运行任务暂停经后端回报为 paused', first.status, 'paused');
  await h.P.control(first, 'resume'); equal('E8 恢复命令作用在相同 transferId', h.calls.filter(([c]) => c === 'sftp_transfer_control').map(([, a]) => [a.transferId, a.action]), [[first.id, 'pause'], [first.id, 'resume']]);
  await h.P.control(queued, 'pause'); equal('E9 等待项可暂停且不调用后端', queued.status, 'paused');
  await h.finish(first.id); equal('E10 完成真正复制文件并记录字节', [first.status, h.need('remote', 'ssh-a', '/home/alice/target/alpha.txt').content, h.T.s.sftp.history[0].done], ['completed', 'alpha original', 14]);
  check('E10b 完成状态仍保留在右侧统计且不渲染无效操作按钮', h.q(`[data-task="${first.id}"] .sftp-queue-meta .completed`).textContent === '完成' && !h.q(`[data-task="${first.id}"] .sftp-queue-buttons button`));
  equal('E11 首项完成后暂停项不自动启动', h.transfers.size, 0);
  await h.P.control(queued, 'resume'); await until(() => h.transfers.has(queued.id), 'resume did not start queued task');
  await h.P.control(queued, 'cancel'); await settle();
  check('E12 运行任务取消作用在准确ID且不复制目标', queued.status === 'cancelled' && !h.store('remote', 'ssh-a').has('/home/alice/target/beta.txt') && h.calls.some(([c, a]) => c === 'sftp_transfer_control' && a.transferId === queued.id && a.action === 'cancel'));
  await h.P.enqueue(h.P.context, 'local', [h.P.context.local.entries.find(e => e.name === 'zeta.log'), h.P.context.local.entries.find(e => e.name === 'binary.dat')], h.P.context, 'remote');
  await until(() => h.transfers.size === 1); const tail = h.P.tasks.at(-1); await h.P.control(tail, 'cancel');
  check('E13 排队项取消不创建后端传输并保存历史', tail.status === 'cancelled' && !h.calls.some(([c, a]) => c === 'sftp_transfer_start' && a.transferId === tail.id) && h.T.s.sftp.history.some(r => r.status === 'cancelled' && r.name === tail.name));
  await h.P.control(h.P.tasks.at(-2), 'cancel'); await settle();
  await h.action(null, 'history'); check('E14 真实历史弹层展示传输记录', h.q('[data-log]').textContent.includes('alpha.txt') && h.q('[data-log]').textContent.includes('已取消'));
  h.q('[aria-label="筛选传输记录"]').value = 'completed'; h.q('[aria-label="筛选传输记录"]').dispatchEvent(new h.w.Event('change')); check('E15 历史成功筛选移除取消记录', !h.q('[data-log]').textContent.includes('已取消')); await h.dialog('关闭');
});

await scenario('F 冲突策略/下载', async h => {
  await h.P.open();
  await h.menu('local', 'alpha.txt', '上传到远程'); await until(() => !!h.q('.sftp-modal'));
  check('F1 同名目标展示完整目标、大小与四种策略', h.q('.sftp-modal').textContent.includes('/home/alice/alpha.txt') && h.qa('.sftp-modal-actions button').length === 4);
  await h.dialog('跳过'); await until(() => h.transfers.size === 1); const skip = h.P.tasks.at(-1); await h.finish(skip.id); equal('F2 跳过保留远端原内容并显示 skipped', [skip.status, h.need('remote', 'ssh-a', '/home/alice/alpha.txt').content], ['skipped', 'alpha original']);
  h.put('local', null, '/home/local/alpha.txt', { content: 'fresh upload' }); await h.P.refresh(); await h.menu('local', 'alpha.txt', '上传到远程'); await h.dialog('覆盖'); await until(() => h.transfers.size === 1); const overwrite = h.P.tasks.at(-1); await h.finish(overwrite.id);
  equal('F3 覆盖通过策略参数并更新目标', [h.calls.filter(([c]) => c === 'sftp_transfer_start').at(-1)[1].policy, h.need('remote', 'ssh-a', '/home/alice/alpha.txt').content], ['overwrite', 'fresh upload']);
  await h.menu('local', 'alpha.txt', '上传到远程'); await h.dialog('保留两份'); await until(() => h.transfers.size === 1); const renamed = h.P.tasks.at(-1); await h.finish(renamed.id);
  check('F4 保留两份传递 rename 且保存另一个目标文件', h.calls.filter(([c]) => c === 'sftp_transfer_start').at(-1)[1].policy === 'rename' && h.store('remote', 'ssh-a').has('/home/alice/alpha (1).txt'));
  await h.go('local', '/home/local/target'); await h.menu('remote', 'beta.txt', '下载到本地'); await until(() => h.transfers.size === 1); const download = h.P.tasks.at(-1); await h.finish(download.id);
  equal('F5 下载真实命令方向与目标内容', [h.calls.filter(([c]) => c === 'sftp_transfer_start').at(-1)[1].upload, h.need('local', null, '/home/local/target/beta.txt').content.length], [false, 60]);
  await h.menu('remote', 'beta.txt', '下载到本地'); await h.dialog('取消传输');
  check('F6 冲突取消不启动后端并保留目标', h.P.tasks.at(-1).status === 'cancelled' && h.transfers.size === 0 && h.need('local', null, '/home/local/target/beta.txt').content.length === 60);
});

await scenario('G 并发冲突不互相取消', async h => {
  await h.P.open(); h.clickRow('local', 'alpha.txt'); h.clickRow('local', 'beta.txt', { ctrlKey: true }); await h.menu('local', 'alpha.txt', '上传到远程');
  await until(() => !!h.q('.sftp-modal')); const [first, second] = h.P.tasks;
  check('G1 两项并发同名冲突只显示一个弹层，首项不被第二项取消', h.qa('.sftp-modal').length === 1 && first.status !== 'cancelled' && second.status !== 'cancelled');
  await h.dialog('覆盖'); await until(() => h.transfers.has(first.id));
  check('G2 首项确认后第二项独立显示冲突', h.q('.sftp-modal')?.textContent.includes('beta.txt') && first.status === 'running' && second.status !== 'cancelled');
  await h.dialog('跳过'); await until(() => h.transfers.has(second.id));
  await h.finish(first.id); await h.finish(second.id);
  equal('G3 并发冲突策略保持每个任务独立', [first.status, second.status], ['completed', 'skipped']);
}, { preferences: { concurrency: 2 } });

await scenario('G 弹层不取消待确认传输', async h => {
  await h.P.open(); await h.menu('local', 'alpha.txt', '上传到远程'); await until(() => !!h.q('.sftp-modal')); const first = h.P.tasks[0];
  await h.action(null, 'settings');
  // A settings dialog should not silently cancel an awaiting transfer conflict.
  check('G4 打开设置不会无提示取消待确认的冲突传输', first.status !== 'cancelled', `task ${first.id}: ${first.status}`);
});

await scenario('G 启动前暂停/取消', async h => {
  await h.P.open(); await h.menu('local', 'alpha.txt', '上传到远程'); await until(() => !!h.q('.sftp-modal')); const first = h.P.tasks[0];
  await h.P.control(first, 'pause'); await h.dialog('覆盖'); await settle();
  check('G5 冲突确认期间暂停不会启动后端也不发不存在任务的control', first.status === 'paused' && h.transfers.size === 0 && !h.calls.some(([c]) => c === 'sftp_transfer_control'));
  await h.P.control(first, 'resume'); await until(() => h.transfers.has(first.id)); await h.finish(first.id);
  await h.menu('local', 'beta.txt', '上传到远程'); await until(() => !!h.q('.sftp-modal')); const cancelled = h.P.tasks.at(-1);
  await h.P.control(cancelled, 'cancel');
  if (h.q('.sftp-modal')) await h.dialog('覆盖');
  await settle();
  check('G6 冲突确认前取消后不被复活，且没有不存在registry的control', cancelled.status === 'cancelled' && !h.calls.some(([c, a]) => c === 'sftp_transfer_start' && a.transferId === cancelled.id) && !h.calls.some(([c, a]) => c === 'sftp_transfer_control' && a.transferId === cancelled.id));
});

await scenario('H 离线防护', async h => {
  await h.P.open();
  check('H1 无 SSH 仍可列本地、远端显示连接提示', !!h.row('local', 'alpha.txt') && h.pane('remote').textContent.includes('连接 SSH 会话'));
  check('H2 无 SSH 时远端导航按钮禁用', ['up', 'refresh', 'home'].every(a => h.pane('remote').querySelector(`[data-action="${a}"]`).disabled));
  h.clickRow('local', 'alpha.txt'); const r = h.row('local', 'alpha.txt'); r.dispatchEvent(new h.w.MouseEvent('contextmenu', { bubbles: true }));
  check('H3 无 SSH 上传菜单禁用', h.qa('.test-context-menu button').find(b => b.textContent === '上传到远程')?.disabled);
  let rejected = false; try { await h.P.enqueue(h.P.context, 'local', [h.P.context.local.entries.find(e => e.name === 'alpha.txt')], h.P.context, 'remote'); } catch (e) { rejected = /SSH/.test(String(e)); }
  check('H4 无 SSH API 传输失败且不产生远端原生命令', rejected && !h.calls.some(([c]) => c.startsWith('sftp_')));
}, { active: tab('local-a', null) });

await scenario('I 异步目录 stale 防护', async h => {
  await h.P.open(); let release;
  h.setInterceptor((command, args) => command === 'sftp_list' && args.path === '/home/alice/docs' ? new Promise(resolve => { release = () => resolve(h.list('remote', 'ssh-a', args.path)); }) : null);
  const slow = h.go('remote', '/home/alice/docs'); await until(() => !!release); await h.go('remote', '/home/alice/empty'); release(); await slow; await settle();
  equal('I1 慢目录不能覆盖更晚的导航路径和条目', [h.P.context.remote.path, h.P.context.remote.entries.length], ['/home/alice/empty', 0]);
  h.setInterceptor(null); let releaseOld;
  h.setInterceptor((command, args) => command === 'sftp_list' && args.id === 'ssh-a' && args.path === '/home/alice/docs' ? new Promise(resolve => { releaseOld = () => resolve(h.list('remote', 'ssh-a', args.path)); }) : null);
  const oldSession = h.go('remote', '/home/alice/docs'); await until(() => !!releaseOld); await h.activate(tab('ssh-b', 'beta.example', 'bob')); releaseOld(); await oldSession; await settle();
  equal('I2 后台旧会话慢响应不能覆盖当前会话 DOM', [h.P.context.id, h.pane('remote').querySelector('.sftp-path').value], ['ssh-b', '/srv/bob']);
});

await scenario('I 首次主目录解析 stale 防护', async h => {
  let releaseHome, held = false;
  h.setInterceptor((command, args) => {
    if (command === 'sftp_realpath' && args.path === '.' && !held) { held = true; return new Promise(resolve => { releaseHome = () => resolve('/home/alice'); }); }
    return null;
  });
  const firstOpen = h.P.open(); await until(() => !!releaseHome); await h.go('remote', '/home/alice/empty'); releaseHome(); await firstOpen; await settle();
  equal('I3 首次 home realpath 慢响应不能覆盖后续导航', [h.P.context.remote.path, h.P.context.remote.entries.length], ['/home/alice/empty', 0]);
}, { preferences: { paths: { 'alice@alpha.example:22': { remote: '/home/alice/docs' } } } });

await scenario('K 拖放与失败重试', async h => {
  await h.P.open(); await h.go('remote', '/home/alice/target');
  await h.drag('local', 'alpha.txt', h.pane('local'));
  const same = new h.w.Event('drop', { bubbles: true, cancelable: true }); h.pane('local').dispatchEvent(same); await settle();
  check('K1 同栏内部拖放不尝试复制自己，preventDefault同步生效', same.defaultPrevented && !h.calls.some(([c]) => c === 'fs_copy'));
  await h.drag('local', 'alpha.txt', h.pane('remote')); await until(() => h.transfers.size === 1); const dropped = h.P.tasks.at(-1); await h.finish(dropped.id);
  check('K2 Pointer跨栏拖放排队并真实上传，无需HTML5原生dragstart', h.store('remote', 'ssh-a').has('/home/alice/target/alpha.txt'));
  h.put('local', null, '/tmp/external.txt', { content: 'native drop' }); await h.nativeDrop(['/tmp/external.txt'], 'remote'); await until(() => h.transfers.size === 1); const native = h.P.tasks.at(-1); await h.finish(native.id);
  check('K3 原生文件拖入通过 fs_stat 校验并真实上传', h.calls.some(([c, a]) => c === 'fs_stat' && a.path === '/tmp/external.txt') && h.need('remote', 'ssh-a', '/home/alice/target/external.txt').content === 'native drop');
  let fail = true;
  h.setInterceptor((command) => command === 'sftp_transfer_start' && fail ? (fail = false, Promise.reject(new Error('simulated network failure'))) : null);
  await h.menu('local', 'beta.txt', '上传到远程'); await until(() => h.P.tasks.at(-1).status === 'failed'); const retry = h.P.tasks.at(-1), oldId = retry.id;
  check('K4 原生失败显示任务错误并保存失败记录', h.q(`[data-task="${oldId}"] .sftp-status.failed`)?.title.includes('simulated network failure') && h.T.s.sftp.history[0].status === 'failed');
  h.q(`[data-task="${oldId}"] [data-action="retry"]`).click();
  check('K7 重试清空原传输开始时间与速度', retry.started === 0 && retry.speed === 0);
  h.q(`[data-task="${retry.id}"] [data-action="pause"]`).click(); await settle();
  check('K8 重试启动前暂停不向未注册的新任务发送原生控制', retry.status === 'paused' && !h.calls.some(([c, a]) => c === 'sftp_transfer_control' && a.transferId === retry.id));
  h.q(`[data-task="${retry.id}"] [data-action="resume"]`).click(); await until(() => h.transfers.has(retry.id));
  check('K5 重试创建新transferId并再次调用真实命令', retry.id !== oldId && h.calls.filter(([c]) => c === 'sftp_transfer_start').some(([, a]) => a.transferId === oldId) && h.calls.some(([c, a]) => c === 'sftp_transfer_start' && a.transferId === retry.id));
  await h.finish(retry.id); check('K6 重试后成功传输并清除错误', retry.status === 'completed' && !retry.error && h.need('remote', 'ssh-a', '/home/alice/target/beta.txt').content.length === 60);
});

await scenario('L Pointer拖放完整路径', async h => {
  await h.P.open();
  const panel = h.q('#sftp-panel');
  h.pointer('pointerdown', h.row('local', 'alpha.txt'));
  h.pointer('pointermove', panel, { clientX: 12, clientY: 12 });
  check('L1 未超过拖动阈值时不捕获指针、不创建悬浮层', !panel.hasPointerCapture(1) && !h.q('.sftp-drag-ghost'));
  h.pointer('pointerup', panel, { clientX: 12, clientY: 12 }); h.clickRow('local', 'alpha.txt');
  check('L2 普通点击仍能选择文件且不会开始传输', h.P.context.local.selected.has('/home/local/alpha.txt') && h.P.tasks.length === 0);
  h.clickRow('local', 'beta.txt'); h.clickRow('local', 'zeta.log', { ctrlKey: true });
  h.pointer('pointerdown', h.row('local', 'beta.txt')); h.setHitTarget(h.row('remote', 'docs'));
  const move = h.pointer('pointermove', panel, { clientX: 90, clientY: 90 });
  check('L3 跨平台Pointer拖动实际捕获、保留多选并显示目标目录', move.defaultPrevented && panel.hasPointerCapture(1) && h.q('.sftp-drag-ghost').textContent.includes('2 项 · 上传到 /home/alice/docs') && h.row('remote', 'docs').classList.contains('drop-directory'));
  check('L4 透明浮层不拦截命中测试，源行禁用HTML5拖动', h.w.getComputedStyle(h.q('.sftp-drag-ghost')).pointerEvents === 'none' && h.row('local', 'beta.txt').draggable === false);
  h.setHitTarget(h.pane('local')); h.pointer('pointermove', panel, { clientX: 60, clientY: 60 });
  check('L5 移入同栏后清除旧目标高亮且提示另一栏', !h.q('.drop-target,.drop-directory') && h.q('.sftp-drag-ghost').textContent.includes('拖到另一栏'));
  h.setHitTarget(h.row('remote', 'docs')); h.pointer('pointermove', panel, { clientX: 90, clientY: 90 });
  h.put('local', null, '/tmp/unrelated.txt', { content: 'must not upload' });
  await h.nativeEvent({ type: 'drop', paths: ['/tmp/unrelated.txt'], position: { x: 90, y: 90 } }, h.row('remote', 'docs'));
  const domDrop = new h.w.Event('drop', { bubbles: true, cancelable: true }); h.pane('remote').dispatchEvent(domDrop);
  check('L6 Native/DOM事件竞争不会重复或注入Pointer拖动传输', domDrop.defaultPrevented && h.P.tasks.length === 0 && !h.calls.some(([c, a]) => c === 'fs_stat' && a.path === '/tmp/unrelated.txt'));
  h.pointer('pointerup', panel, { clientX: 90, clientY: 90 }); await until(() => h.transfers.size === 1);
  check('L7 释放时传输两项到悬停文件夹，所有悬浮层和捕获已释放', h.P.tasks.length === 2 && h.P.tasks.every(t => t.target.startsWith('/home/alice/docs/')) && !h.q('.sftp-drag-ghost,.drop-target,.drop-directory') && !panel.hasPointerCapture(1));
  for (const task of h.P.tasks) { await until(() => h.transfers.has(task.id)); await h.finish(task.id); }
  check('L8 多选Pointer拖动真实上传两项，未上传竞争事件文件', h.need('remote', 'ssh-a', '/home/alice/docs/beta.txt').content.length === 60 && h.need('remote', 'ssh-a', '/home/alice/docs/zeta.log').content.length === 180 && !h.store('remote', 'ssh-a').has('/home/alice/docs/unrelated.txt'));
  await h.drag('remote', 'alpha.txt', h.row('local', 'target')); await until(() => h.transfers.size === 1); const download = h.P.tasks.at(-1); await h.finish(download.id);
  check('L9 远程拖到本地文件夹真实下载', download.direction === 'down' && h.need('local', null, '/home/local/target/alpha.txt').content === 'alpha original');
});

await scenario('M 拖放取消与遮挡', async h => {
  await h.P.open();
  const panel = h.q('#sftp-panel'), start = () => {
    h.pointer('pointerdown', h.row('local', 'beta.txt')); h.setHitTarget(h.row('remote', 'target'));
    h.pointer('pointermove', panel, { clientX: 90, clientY: 90 });
  };
  start(); h.pointer('pointercancel', panel); h.pointer('pointerup', panel, { clientX: 90, clientY: 90 });
  check('M1 Pointer取消清理并且不传输', !h.q('.sftp-drag-ghost,.drop-target') && h.P.tasks.length === 0);
  start(); panel.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('M2 Escape只取消当前拖动，文件面板保持开启', h.P.isOpen() && !h.q('.sftp-drag-ghost') && h.P.tasks.length === 0);
  start(); await h.activate(tab('ssh-b', 'beta.example', 'bob')); h.pointer('pointerup', panel, { clientX: 90, clientY: 90 });
  check('M3 切换会话取消旧拖动且不向新会话发送文件', h.P.context.id === 'ssh-b' && h.P.tasks.length === 0 && !h.q('.sftp-drag-ghost'));
  start(); h.P.hide(); h.pointer('pointerup', panel, { clientX: 90, clientY: 90 });
  check('M4 隐藏工作区释放指针和浮层，不遗留传输', !panel.hasPointerCapture(1) && !h.q('.sftp-drag-ghost') && h.P.tasks.length === 0);
  await h.P.open(); start(); await h.go('local', '/home/local/docs'); h.pointer('pointermove', panel, { clientX: 91, clientY: 91 }); h.pointer('pointerup', panel, { clientX: 91, clientY: 91 });
  check('M5 源目录导航使拖动失效，不能发送旧列表文件', !h.q('.sftp-drag-ghost') && h.P.tasks.length === 0);
  await h.action(null, 'settings'); h.put('local', null, '/tmp/modal.txt', { content: 'blocked' });
  await h.nativeEvent({ type: 'drop', paths: ['/tmp/modal.txt'], position: { x: 90, y: 90 } }, h.pane('remote'));
  check('M6 模态弹层阻止底下文件窗接收原生拖动', h.P.tasks.length === 0 && !h.calls.some(([c, a]) => c === 'fs_stat' && a.path === '/tmp/modal.txt'));
  await h.dialog('取消');
  const outside = h.d.createElement('section'); outside.className = 'sftp-pane'; outside.dataset.side = 'remote'; h.d.body.appendChild(outside);
  await h.nativeEvent({ type: 'over', position: { x: 90, y: 90 } }, outside);
  check('M7 面板外同名元素不会成为传输目标', !h.q('.drop-target'));
});

await scenario('N 原生文件拖动坐标/去重/路径快照', async h => {
  await h.P.open(); h.put('local', null, '/tmp/external.txt', { content: 'native content' });
  Object.defineProperty(h.w, 'devicePixelRatio', { value: 2, configurable: true });
  await h.nativeEvent({ type: 'enter', paths: ['/tmp/external.txt'], position: { x: 40, y: 60 } }, h.row('remote', 'target'));
  equal('N1 原生物理坐标按DPR转成DOM坐标', h.hitPosition, { x: 20, y: 30 });
  check('N2 原生文件悬停在目录行显示目录目标', h.row('remote', 'target').classList.contains('drop-directory'));
  await h.nativeEvent({ type: 'over', position: { x: 40, y: 60 } }, h.pane('local'));
  check('N3 原生光标移栏仅保留当前栏高亮', h.pane('local').classList.contains('drop-target') && !h.pane('remote').classList.contains('drop-target') && !h.q('.drop-directory'));
  await h.nativeEvent({ type: 'leave' }, null); check('N4 原生取消清除所有目标', !h.q('.drop-target,.drop-directory'));
  await h.nativeEvent({ type: 'drop', paths: ['/tmp/external.txt', '/tmp/external.txt'], position: { x: 40, y: 60 } }, h.row('remote', 'target'));
  await until(() => h.transfers.size === 1); const tr = h.P.tasks.at(-1); await h.finish(tr.id);
  check('N5 同次原生拖入去重并发送至目录行而非当前目录', h.P.tasks.length === 1 && h.calls.filter(([c, a]) => c === 'fs_stat' && a.path === '/tmp/external.txt').length === 1 && h.need('remote', 'ssh-a', '/home/alice/target/external.txt').content === 'native content');
  let release;
  h.put('local', null, '/tmp/delayed.txt', { content: 'captured target' });
  h.setInterceptor((command, args) => command === 'fs_stat' && args.path === '/tmp/delayed.txt' ? new Promise(resolve => { release = () => resolve({ name: 'delayed.txt', path: args.path, is_dir: false, size: 15 }); }) : null);
  const pending = h.nativeEvent({ type: 'drop', paths: ['/tmp/delayed.txt'], position: { x: 40, y: 60 } }, h.row('remote', 'target'));
  await until(() => release); await h.go('remote', '/home/alice/docs'); await h.activate(tab('ssh-b', 'beta.example', 'bob')); release(); await pending;
  await until(() => h.transfers.size === 1); const captured = h.P.tasks.at(-1); await h.finish(captured.id);
  check('N6 stat慢响应期间导航/切换会话仍保持drop时的目录和SSH会话', captured.sessionId === 'ssh-a' && captured.target === '/home/alice/target/delayed.txt' && h.store('remote', 'ssh-a').has(captured.target) && !h.store('remote', 'ssh-b').has('/srv/bob/delayed.txt'));
  let releaseClosed;
  h.setInterceptor((command, args) => command === 'fs_stat' && args.path === '/tmp/closed.txt' ? new Promise(resolve => { releaseClosed = () => resolve({ name: 'closed.txt', path: args.path, is_dir: false, size: 5 }); }) : null);
  const closing = h.nativeDrop(['/tmp/closed.txt'], 'remote'); await until(() => releaseClosed); h.P.hide(); await h.P.open(); releaseClosed(); await closing;
  check('N7 stat等待期间关闭再打开面板也取消旧原生拖动', h.P.tasks.length === 2);
});

await scenario('O 首次使用的文件传输默认值', async h => {
  await h.P.open();
  check('O1 首次打开本地和远程目录默认显示隐藏文件', !!h.row('local', '.secret') && !!h.row('remote', '.secret'));
  await h.action(null, 'settings');
  check('O2 设置面板默认显示隐藏文件且并发为4', h.q('[data-pref="showHidden"]').checked && h.q('[data-pref="concurrency"]').value === '4');
  await h.dialog('取消');
  await h.go('remote', '/home/alice/target');
  const entries = h.P.context.local.entries.filter(e => !e.is_dir).slice(0, 5);
  await h.P.enqueue(h.P.context, 'local', entries, h.P.context, 'remote');
  await until(() => h.transfers.size === 4, 'default four workers did not start');
  equal('O3 五个真实上传任务默认四项运行、一项等待', [h.P.tasks.filter(t => t.status === 'running').length, h.P.tasks.filter(t => t.status === 'queued').length], [4, 1]);
  const waiting = h.P.tasks.find(t => t.status === 'queued');
  await h.finish(h.P.tasks[0].id);
  await until(() => h.transfers.has(waiting.id), 'queued fifth transfer did not start');
  check('O4 完成一项即补充第五项但保持四个活动传输', h.transfers.size === 4 && waiting.status === 'running');
}, { preferences: { showHidden: undefined, concurrency: undefined } });

await scenario('P 已有文件传输偏好不被默认值覆盖', async h => {
  await h.P.open();
  check('P1 显式关闭隐藏文件的已有设置保留', !h.row('local', '.secret') && !h.row('remote', '.secret'));
  await h.action(null, 'settings');
  check('P2 已保存并发3及隐藏文件关闭完整回显', h.q('[data-pref="concurrency"]').value === '3' && !h.q('[data-pref="showHidden"]').checked);
  await h.dialog('保存');
  h.P.close(); await h.P.open();
  check('P3 保存并重新打开仍保留显式false和并发3', h.T.s.sftp.showHidden === false && h.T.s.sftp.concurrency === 3 && !h.row('local', '.secret') && h.persisted > 0);
  await h.go('remote', '/home/alice/target');
  await h.P.enqueue(h.P.context, 'local', h.P.context.local.entries.filter(e => !e.is_dir).slice(0, 5), h.P.context, 'remote');
  await until(() => h.transfers.size === 3, 'saved concurrency three did not start');
  equal('P4 已保存并发3实际限制为三项运行和两项等待', [h.P.tasks.filter(t => t.status === 'running').length, h.P.tasks.filter(t => t.status === 'queued').length], [3, 2]);
}, { preferences: { showHidden: false, concurrency: 3 } });

await scenario('R 队列统计的响应式布局规则', async h => {
  await h.P.open();
  const rules = [...h.q('style[data-file="sftp.css"]').sheet.cssRules];
  const rule = selector => rules.find(r => r.selectorText === selector)?.style;
  check('R1 队列文件名可收缩且右侧统计只占实际内容宽度', rule('.sftp-queue-row').getPropertyValue('grid-template-columns') === 'minmax(0, 1fr) auto');
  check('R2 字节、状态及操作统一靠右并使用等宽数字', rule('.sftp-queue-meta').getPropertyValue('justify-self') === 'end' && rule('.sftp-queue-meta').getPropertyValue('justify-content') === 'flex-end' && rule('.sftp-queue-meta').getPropertyValue('text-align') === 'right' && rule('.sftp-queue-meta').getPropertyValue('font-variant-numeric') === 'tabular-nums');
  check('R3 已完成任务隐藏空按钮容器，状态可贴近右边缘', rule('.sftp-queue-buttons:empty').getPropertyValue('display') === 'none');
  const narrow = rules.find(r => r.conditionText === '(max-width: 600px)' && r.cssText.startsWith('@container'));
  const narrowRules = [...(narrow?.cssRules || [])];
  check('R4 队列按自身宽度自适应，小窗口和手动缩小面板均换行', rule('.sftp-queue').getPropertyValue('container-type') === 'inline-size' && narrowRules.find(r => r.selectorText === '.sftp-queue-row')?.style.getPropertyValue('grid-template-columns') === 'minmax(0, 1fr)' && narrowRules.find(r => r.selectorText === '.sftp-queue-meta')?.style.getPropertyValue('flex-wrap') === 'wrap');
  const allRules = rules.flatMap(r => [r, ...r.cssRules || []]);
  check('R5 窄屏保留速度和完成状态，不再整列隐藏', !allRules.some(r => r.selectorText === '.sftp-queue-speed' && r.style?.display === 'none'));
});

await scenario('S 重连后的原生ID与旧请求隔离', async h => {
  await h.P.open();
  const c = h.P.context, machine = c.tab;
  const cloneRemote = id => { for (const [path, value] of h.store('remote', 'ssh-a')) h.store('remote', id).set(path, { ...value }); };
  cloneRemote('ssh-a-generation-2');
  h.put('remote', 'ssh-a-generation-2', '/home/alice/new-generation.txt', { content: 'new connection' });
  let release;
  h.setInterceptor((command, args) => command === 'sftp_list' && args.id === 'ssh-a'
    ? new Promise(resolve => { release = () => resolve([{ name: 'stale-generation.txt', path: '/home/alice/stale-generation.txt', is_dir: false }]); }) : null);
  const stale = h.P.refresh(); await until(() => !!release);
  machine.exited = true; machine.ptyId = null; h.P.onConnectionChange(machine);
  check('S1 退出时稳定窗格ID和文件上下文不变，清除旧远端文件', h.P.context === c && c.id === 'ssh-a' && c.remote.entries.length === 0);
  check('S2 退出时路径与所有远程导航禁用', h.pane('remote').querySelector('.sftp-path').disabled && [...h.pane('remote').querySelectorAll('.sftp-nav button')].every(b => b.disabled));
  machine.exited = false; machine.ptyId = 'ssh-a-generation-2'; h.P.onConnectionChange(machine); await settle();
  check('S3 原标签重连后SFTP使用新的后端ID读取', !!h.row('remote', 'new-generation.txt') && h.calls.some(([command, args]) => command === 'sftp_list' && args.id === 'ssh-a-generation-2'));
  release(); await stale;
  check('S4 迟到旧连接目录结果不会覆盖新连接', !!h.row('remote', 'new-generation.txt') && !h.row('remote', 'stale-generation.txt'));
  h.setInterceptor(null);
  await h.go('remote', '/home/alice/target');
  const localEntry = c.local.entries.find(e => e.name === 'alpha.txt');
  await h.P.enqueue(c, 'local', [localEntry], c, 'remote'); await until(() => h.transfers.size === 1);
  const task = h.P.tasks.at(-1), oldTransferId = task.id;
  check('S5 重连后的队列使用新原生会话ID', task.sessionId === 'ssh-a-generation-2' && h.transfers.get(task.id).args.id === 'ssh-a-generation-2');
  h.P.progress({ transferId: task.id, sessionId: 'ssh-a-generation-2', done: 3, total: 20, status: 'running' });
  check('S6 新原生会话进度正确关联稳定窗格的任务', task.done === 3);
  machine.exited = true; machine.ptyId = null; h.P.onConnectionChange(machine); await until(() => !task.working);
  check('S7 断线任务失败并释放worker，可显式重试', task.status === 'failed' && task.connectionLost && !task.working);
  h.P.progress({ transferId: oldTransferId, sessionId: 'ssh-a-generation-2', done: 20, total: 20, status: 'completed' });
  check('S8 旧连接迟到进度不能把失败任务改为完成', task.status === 'failed' && task.done === 3);
  cloneRemote('ssh-a-generation-3'); machine.exited = false; machine.ptyId = 'ssh-a-generation-3'; h.P.onConnectionChange(machine); await settle();
  check('S9 重连不自动向新连接重放旧文件传输', !h.calls.some(([command, args]) => command === 'sftp_transfer_start' && args.id === 'ssh-a-generation-3'));
  h.q(`[data-task="${oldTransferId}"] [data-action="retry"]`).click(); await until(() => h.transfers.size === 1);
  check('S10 用户确认重试才为新连接创建新的transferId', task.id !== oldTransferId && task.sessionId === 'ssh-a-generation-3' && h.transfers.get(task.id).args.id === 'ssh-a-generation-3');
  await h.finish(task.id);
  check('S11 重试成功并只写到新连接文件树', task.status === 'completed' && h.store('remote', 'ssh-a-generation-3').has('/home/alice/target/alpha.txt') && !h.store('remote', 'ssh-a-generation-2').has('/home/alice/target/alpha.txt'), JSON.stringify({status:task.status,target:task.target,error:task.error,newHas:h.store('remote', 'ssh-a-generation-3').has('/home/alice/target/alpha.txt'),oldHas:h.store('remote', 'ssh-a-generation-2').has('/home/alice/target/alpha.txt')}));
});

await scenario('T 断线不丢失编辑器未保存内容', async h => {
  await h.P.open(); await h.menu('remote', 'alpha.txt', '查看 / 编辑');
  const input = h.q('.sftp-editor textarea'), c = h.P.context;
  input.value = 'unsaved across reconnect';
  c.tab.exited = true; c.tab.ptyId = null; h.P.onConnectionChange(c.tab); await settle();
  check('T1 断线保持编辑器原DOM和未保存文本', h.q('.sftp-editor textarea') === input && input.value === 'unsaved across reconnect');
  check('T2 编辑器打开时底层远程路径和导航仍禁用', h.pane('remote').querySelector('.sftp-path').disabled && [...h.pane('remote').querySelectorAll('.sftp-nav button')].every(b => b.disabled));
  h.q('[data-save]').click(); await settle();
  check('T3 断线状态保存不发送任何远端写入', !h.calls.some(([command]) => command === 'sftp_write_file') && input.value === 'unsaved across reconnect');
});

await scenario('J 主主题继承', async h => {
  await h.P.open(); await h.action(null, 'settings'); const select = h.q('[data-pref="layout"]');
  const rule = (file, selector) => [...h.q(`style[data-file="${file}"]`).sheet.cssRules].find(r => r.selectorText === selector)?.style;
  equal('J1 SFTP 外壳、列表、弹层全部引用主主题令牌', [rule('sftp.css', '#sftp-panel').getPropertyValue('background'), rule('sftp.css', '.sftp-pane').getPropertyValue('background'), rule('sftp.css', '.sftp-modal-box').getPropertyValue('background')], ['var(--bg2)', 'var(--bg)', 'var(--bg2)']);
  equal('J2 SFTP 下拉框/option 继承公共主题控件规则', [rule('style.css', 'input, select, textarea').getPropertyValue('background'), rule('style.css', 'option, optgroup').getPropertyValue('background')], ['var(--input-bg)', 'var(--input-bg)']);
  const trigger = select.parentElement.querySelector('.wt-select-trigger');
  check('J5 SFTP动态对话框真正升级为现代下拉按钮', !!trigger && trigger.getAttribute('role') === 'combobox' && select.classList.contains('wt-select-native'));
  trigger.click(); await settle(); const dropdown = h.q('.wt-select-menu');
  check('J6 现代下拉真实打开，选项映射原始业务select', !!dropdown && dropdown.getAttribute('role') === 'listbox' && dropdown.querySelectorAll('[role="option"]').length === 4 && trigger.getAttribute('aria-expanded') === 'true');
  for (const [name, theme] of Object.entries(h.TM.THEMES)) {
    h.TM.applyTheme(name);
    check(`J3 ${name} 正确更新所有 SFTP 依赖令牌`, ['--bg', '--bg2', '--input-bg', '--fg', '--accent', '--color-scheme'].every(k => h.d.documentElement.style.getPropertyValue(k) === theme.vars[k]));
    check(`J4 ${name} 已打开现代下拉框保持选择与 DOM`, h.q('[data-pref="layout"]') === select && select.value === 'horizontal' && h.q('.wt-select-menu') === dropdown && h.d.documentElement.style.colorScheme === theme.vars['--color-scheme']);
  }
  dropdown.querySelector('[data-index="2"]').click(); await settle(); await h.dialog('保存');
  check('J7 通过现代下拉真实选择后保存SFTP布局', h.T.s.sftp.layout === 'vertical' && h.q('#sftp-panel').dataset.layout === 'vertical' && !h.q('.wt-select-menu'));
});

console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n'));
if (fatal.length) console.log('\nERRORS:\n' + fatal.join('\n'));
console.log(`\n合计 ${results.filter(r => r.pass).length}/${results.length} PASS，场景错误 ${fatal.length} 个`);
process.exitCode = results.every(r => r.pass) && !fatal.length ? 0 : 1;
