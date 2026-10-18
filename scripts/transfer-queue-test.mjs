// Real queue DOM and async protocol callbacks. No product state/render function is replaced.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = new URL('../src/', import.meta.url), errors = [], checks = [];
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM('<!doctype html><html><head></head><body><button id="launch">传输</button><main id="main-area"></main></body></html>', {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc,
});
const w = dom.window, d = w.document;
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name); };
const tick = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 0)); };
let terminalFocus = 0, modemOpen = 0, sftpOpen = 0, closeDock = 0, persisted = 0, events = [];
w.WT = { s: {}, term: { activeTab: () => ({ term: { focus() { terminalFocus++; } } }) }, ui: { closeDock() { closeDock++; } }, persistSettings() { persisted++; } };
w.ModemTransfer = { open() { modemOpen++; } }; w.SftpPanel = { open() { sftpOpen++; } };
for (const file of ['style.css', 'transfer-queue.css']) {
  const el = d.createElement('style'); el.dataset.file = file; el.textContent = readFileSync(new URL(file, src), 'utf8'); d.head.append(el);
}
for (const file of ['icons.js', 'transfer-queue.js']) w.eval(readFileSync(new URL(file, src), 'utf8'));
const Q = w.TransferQueue, q = selector => d.querySelector(selector);
const row = id => [...d.querySelectorAll('.tq-task')].find(el => el.dataset.task === id);
const visible = () => [...d.querySelectorAll('.tq-task')].filter(el => !el.hidden);
const button = (id, action) => row(id).querySelector(`[data-action="${action}"]`);
const task = (id, status = 'queued', extra = {}) => ({ id, sessionId: 'native-' + id, protocol: 'SFTP', name: id + '.txt',
  direction: 'up', machine: 'alice@host:22', source: '/source/' + id, target: '/target/' + id,
  done: 0, total: 1024, speed: 0, status, ...extra });
w.addEventListener('transfer-queue-change', event => events.push(event.detail));
try {
  const host = Q.mount(); check('Q01 Queue creates one independent floating dialog', host.id === 'transfer-queue-panel' && host.parentElement.id === 'main-area' && host.hidden && host.getAttribute('role') === 'dialog');
  check('Q02 Repeated mounting does not duplicate header/listeners', Q.mount() === host && d.querySelectorAll('#transfer-queue-panel').length === 1);
  q('#launch').focus(); Q.open();
  check('Q03 Open focuses new transfer control and closes legacy dock', Q.isOpen() && d.activeElement.dataset.action === 'new-modem' && closeDock === 1);
  check('Q04 Empty queue gives both supported transfer entry paths', !q('.tq-empty').hidden && q('.tq-empty').textContent.includes('SFTP') && q('.tq-empty').textContent.includes('MODEM'));
  q('[data-action="new-modem"]').click(); check('Q05 New transfer invokes actual modem controller entry', modemOpen === 1);
  Q.toggle(); check('Q06 A second toggle closes and returns focus', !Q.isOpen() && d.activeElement.id === 'launch');
  Q.toggle(); check('Q07 Toggle reopens retained queue', Q.isOpen());
  Q.upsert(task('a', 'running', { done: 512, total: 1024, speed: 2048 }), { controls: { cancel: async () => Q.upsert({ id: 'a', status: 'cancelled' }) } });
  check('Q08 Exact byte progress and live rate appear', row('a').querySelector('.tq-bytes').textContent === '512 B / 1.0 KB' && row('a').querySelector('.tq-speed').textContent === '2.0 KB/s');
  check('Q09 Progressbar reflects actual 50 percent', row('a').querySelector('.tq-progress').getAttribute('aria-valuenow') === '50' && row('a').querySelector('.tq-progress i').style.width === '50%');
  check('Q10 Source/destination, machine, protocol and direction are visible', row('a').textContent.includes('alice@host:22') && row('a').textContent.includes('SFTP') && row('a').textContent.includes('上传') && row('a').querySelector('.tq-path').textContent === '/source/a → /target/a');
  button('a', 'cancel').focus(); const cancelNode = d.activeElement, rowNode = row('a');
  Q.upsert({ id: 'a', done: 768, speed: 3072 });
  check('Q11 Progress preserves row, button DOM and keyboard focus', row('a') === rowNode && button('a', 'cancel') === cancelNode && d.activeElement === cancelNode);
  Q.close(); Q.upsert({ id: 'a', done: 900 }); Q.open();
  check('Q12 Progress continues when queue is closed', row('a').querySelector('.tq-bytes').textContent === '900 B / 1.0 KB');
  Q.upsert(task('b', 'completed', { done: 1024 })); Q.upsert(task('c', 'failed', { error: 'Permission denied' }));
  Q.upsert(task('d', 'cancelled')); Q.upsert(task('e', 'paused')); Q.upsert(task('f', 'skipped'));
  q('[data-filter="active"]').click(); check('Q13 Active filter includes running and paused', visible().map(el => el.dataset.task).join(',') === 'a,e');
  q('[data-filter="completed"]').click(); check('Q14 Completed filter includes completed/cancelled/skipped only', visible().map(el => el.dataset.task).join(',') === 'b,d,f');
  q('[data-filter="failed"]').click(); check('Q15 Failure filter and actual remote error appear', visible().length === 1 && visible()[0].dataset.task === 'c' && row('c').querySelector('.tq-error').textContent === 'Permission denied');
  Q.upsert({ id: 'a', status: 'failed', error: 'Connection lost' });
  check('Q16 Disconnect moves the same row into failure filter', visible().length === 2 && row('a') === rowNode && row('a').textContent.includes('Connection lost'));
  q('[data-filter="all"]').click();
  const untrusted = '<img src=x onerror="alert(1)"> & <script>bad()</script>';
  Q.upsert(task('unsafe" data-x="a', 'failed', { name: untrusted, machine: untrusted, source: untrusted, target: untrusted, error: untrusted, protocol: untrusted }));
  check('Q17 Every externally supplied label/path/error is text, never markup', !q('.tq-task img') && !q('.tq-task script') && row('unsafe" data-x="a').textContent.includes(untrusted) && !q('.tq-task[data-x]'));
  Q.upsert(task('pauseable', 'running'), { controls: {
    pause: async () => Q.upsert({ id: 'pauseable', status: 'paused' }),
    resume: async () => Q.upsert({ id: 'pauseable', status: 'running' }),
    cancel: async () => Q.upsert({ id: 'pauseable', status: 'cancelled' }),
    retry: async () => Q.upsert({ id: 'pauseable', status: 'queued', done: 0, error: '' }),
  } });
  button('pauseable', 'pause').click(); await tick();
  check('Q18 Pause calls protocol callback and enables continue', row('pauseable').dataset.status === 'paused' && !button('pauseable', 'resume').hidden && button('pauseable', 'pause').hidden);
  button('pauseable', 'resume').click(); await tick();
  check('Q19 Continue uses original task and returns to running', row('pauseable').dataset.status === 'running' && !button('pauseable', 'pause').hidden);
  button('pauseable', 'cancel').click(); await tick();
  check('Q20 Cancel transitions only from controller result', row('pauseable').dataset.status === 'cancelled' && !button('pauseable', 'retry').hidden);
  button('pauseable', 'retry').click(); await tick();
  check('Q21 Retry reuses activity identity and clears old progress', Q.tasks.filter(value => value.id === 'pauseable').length === 1 && row('pauseable').dataset.status === 'queued' && Q.tasks.find(value => value.id === 'pauseable').done === 0);
  let release, attempts = 0;
  Q.upsert(task('lock', 'running'), { controls: { cancel: () => { attempts++; return new Promise(resolve => { release = resolve; }); } } });
  button('lock', 'cancel').click(); button('lock', 'cancel').click(); const ignored = await Q.perform('lock', 'cancel');
  check('Q22 Async action locks duplicate click and programmatic dispatch', attempts === 1 && ignored === false && button('lock', 'cancel').disabled && row('lock').getAttribute('aria-busy') === 'true');
  Q.upsert({ id: 'lock', done: 12 }); check('Q23 Progress during pending action retains action lock', button('lock', 'cancel').disabled && row('lock').querySelector('.tq-bytes').textContent.startsWith('12 B'));
  release(); await tick(); check('Q24 Resolving callback unlocks without fabricating cancellation', !button('lock', 'cancel').disabled && row('lock').dataset.status === 'running');
  Q.upsert(task('control-failure', 'paused'), { controls: { resume: async () => { throw Error('native control denied <svg onload=bad()>'); } } });
  button('control-failure', 'resume').click(); await tick();
  check('Q25 Rejected controls preserve protocol state, unlock and report detailed error safely', row('control-failure').dataset.status === 'paused' && !button('control-failure', 'resume').disabled && row('control-failure').querySelector('.tq-error').textContent.includes('native control denied <svg') && !row('control-failure').querySelector('.tq-error svg'));
  let retries = 0;
  Q.upsert(task('retry-failure', 'failed'), { controls: { retry: async () => { retries++; throw Error('SSH connection unavailable'); } } });
  button('retry-failure', 'retry').click(); await tick(); button('retry-failure', 'retry').click(); await tick();
  check('Q26 Failed retry can be retried again without silent queued state', retries === 2 && row('retry-failure').dataset.status === 'failed' && row('retry-failure').textContent.includes('SSH connection unavailable'));
  Q.upsert(task('modem', 'queued', { protocol: 'ZMODEM', direction: 'down' }), { controls: { cancel: async () => Q.upsert({ id: 'modem', status: 'cancelled' }), retry: async () => {} } });
  check('Q27 Modem without pause support exposes cancel only', button('modem', 'pause').hidden && button('modem', 'resume').hidden && !button('modem', 'cancel').hidden && row('modem').textContent.includes('ZMODEM') && row('modem').textContent.includes('下载'));
  Q.upsert({ id: 'modem', done: Infinity, total: -1, speed: NaN });
  check('Q28 Nonfinite/negative metrics cannot produce invalid styles', Q.tasks.find(value => value.id === 'modem').done === 0 && row('modem').querySelector('.tq-progress i').style.width === '0%');
  Q.upsert({ id: 'modem', status: 'completed', total: 0, done: 512 });
  check('Q29 Completed unknown-size transfer shows full progress', row('modem').querySelector('.tq-progress i').style.width === '100%');
  check('Q30 Removing active task is rejected', Q.remove('lock') === false && !!row('lock'));
  check('Q31 Removing completed task removes activity only', Q.remove('modem') === true && !row('modem'));
  Q.clear('failed'); check('Q32 Clear failed preserves live and other finished records', !Q.tasks.some(value => value.status === 'failed') && !!row('lock') && !!row('b'));
  Q.clear(); check('Q33 Clear finished retains paused/running/queued tasks', Q.tasks.every(value => ['running', 'paused', 'queued'].includes(value.status)) && !row('b'));
  for (let n = 0; n < 205; n++) Q.upsert(task('finished-' + n, 'completed'));
  check('Q34 Finished history is bounded while active tasks remain', Q.tasks.filter(value => value.status === 'completed').length === 200 && !!row('lock') && !row('finished-0') && !!row('finished-204'));
  const snapshots = Q.tasks, originalName = snapshots[0].name;
  let readOnly = false; try { snapshots[0].name = 'mutated'; } catch { readOnly = true; }
  check('Q35 Public activity snapshots cannot mutate controller/queue state', readOnly && Q.tasks[0].name === originalName);
  check('Q36 Transfer paths and replay callbacks are never persisted to settings', persisted === 0 && JSON.stringify(w.WT.s) === '{}');
  check('Q37 Event counts follow current activity and queue visibility', events.at(-1).total === Q.tasks.length && events.at(-1).open && events.at(-1).active === Q.tasks.filter(value => ['running', 'paused', 'queued'].includes(value.status)).length);
  q('[data-action="sftp"]').click(); check('Q38 SFTP entry opens browser and closes queue without focus reset', sftpOpen === 1 && !Q.isOpen());
  Q.open(); const ev = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); q('[data-action="new-modem"]').dispatchEvent(ev);
  check('Q39 Escape closes queue and consumes terminal shortcut', !Q.isOpen() && ev.defaultPrevented);
  q('#launch').remove(); Q.open(); Q.close(); check('Q40 Detached previous control falls back to active terminal focus', terminalFocus > 0);
  const css = [...q('style[data-file="transfer-queue.css"]').sheet.cssRules].find(rule => rule.selectorText === '#transfer-queue-panel');
  check('Q41 Queue shell uses current theme tokens', css.style.getPropertyValue('background') === 'var(--bg2)' && css.style.getPropertyValue('color') === 'var(--fg)');
  Q.upsert(task('finishing', 'failed', { retryDisabled: true }), { controls: { retry: async () => {} } });
  check('Q42 In-flight worker cleanup hides retry and prevents clearing unfinished registry state', button('finishing', 'retry').hidden && Q.remove('finishing') === false && Q.clear('failed') === 0);
  Q.upsert({ id: 'finishing', retryDisabled: false });
  check('Q43 Registry cleanup enables explicit retry and clearing', !button('finishing', 'retry').hidden && Q.remove('finishing'));
  check('Q44 No unhandled DOM errors', errors.length === 0);
} finally { dom.window.close(); }
console.log(`\n合计 ${checks.length}/${checks.length} PASS，场景错误 ${errors.length} 个`);
