import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const errors = [], results = [], calls = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: 'dangerously', url: 'http://tauri.localhost/', virtualConsole: vc });
const w = dom.window, d = w.document;
const local = [{ name: 'Lab', folder: 'Work', protocol: 'ssh', host: 'local.example', port: 2222, user: 'alice', password: 'local-password', lastUsed: 7 },
  { name: 'Local only', protocol: 'local', command: '/bin/zsh' }];
let remote = { version: 7, appearance: { theme: 'cloud-theme' }, profiles: [
  { id: 'ssh:lab', type: 'ssh', name: 'Lab', group: 'Work', options: { host: 'remote.example', port: 22, user: 'bob', auth: 'publicKey', password: 'remote-password', privateKeys: ['~/.ssh/id_ed25519'] } },
  { id: 'ssh:cloud', type: 'ssh', name: 'Cloud only', options: { host: 'cloud.example' } },
  { id: 'extension:other', type: 'custom-plugin', name: 'Keep', options: { custom: true } },
] };
let bridge = async (command, args) => {
  calls.push([command, args]);
  if (command === 'gist_request') {
    const req = args.request;
    if (req.operation === 'read') return { gistId: 'abcdef123456', revision: 'revision-1', public: false, document: structuredClone(remote) };
    return { gistId: 'abcdef123456', revision: 'revision-2' };
  }
  return null;
};
w.WT = { s: { sessions: structuredClone(local) }, invoke: (...args) => bridge(...args) };
let homeRenders = 0;
w.Home = { render() { homeRenders++; } }; w.UI = { renderDock() {} };
w.eval(readFileSync(new URL('../src/gist-sync.js', import.meta.url), 'utf8'));
const G = w.GistSync;
const check = (name, condition) => { results.push([!!condition, name]); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const q = selector => d.querySelector(selector);
const root = q('#root'); root.innerHTML = G.view(); G.bind(root);
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); };
const field = (name, value) => { const el = q('[data-gs-field="' + name + '"]'); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const click = async name => { q('[data-gs-action="' + name + '"]').click(); await settle(); };
await settle();

check('G01 Config view has Gist ID, masked token, encryption key, filename and editable proxy', root.querySelectorAll('[data-gs-field]').length === 5 && q('[data-gs-field="token"]').type === 'password' && q('[data-gs-field="secret"]').type === 'password');
check('G02 Default proxy follows user choice and default filename matches referenced plugin', q('[data-gs-field="proxy"]').value === 'http://192.168.8.246:7890' && q('[data-gs-field="filename"]').value === 'tabby-sync-settings');
check('G03 Mount only reads local connection metadata, with no GitHub calls', calls.every(([c]) => c === 'ui_state_load'));
check('G04 Gist URL and hexadecimal ID normalize identically', G.normalizeId('https://gist.github.com/example/ABCDEF123456') === 'abcdef123456' && G.normalizeId('ABCDEF123456') === 'abcdef123456');
for (const bad of ['https://github.com/a/b', '../user', 'https://evil.example/abcdef', 'https://user:token@gist.github.com/abcdef']) {
  let rejected = false; try { G.normalizeId(bad); } catch (_) { rejected = true; } check('G05 Invalid/foreign Gist target is rejected: ' + bad.replace('token', 'redacted'), rejected);
}
const stripped = G.sanitize({ ...local[0], token: 'secret', proxyPassword: 'secret', privateKey: '-----BEGIN KEY', identityFile: '-----BEGIN PRIVATE KEY-----\nabc', jumpHost: { password: 'nested-secret' }, args: [{ password: 'nested' }, '-l'] });
check('G06 Safe export strips passwords, tokens, inline private keys and nested credential objects', !JSON.stringify(stripped).includes('secret') && !('password' in stripped) && !('identityFile' in stripped) && !('jumpHost' in stripped) && same(stripped.args, ['-l']));
const imported = G.importDocument(remote);
check('G07 Tabby profiles become machines; unsupported plugin profiles are counted', imported.sessions.length === 2 && imported.skipped === 1 && imported.sessions[0].host === 'remote.example');
check('G08 Tabby authentication and key paths map to native SSH fields', imported.sessions[0].auth === 'publickey' && imported.sessions[0].identityFile === '~/.ssh/id_ed25519' && !('password' in imported.sessions[0]));
const grouped = G.importDocument({ profileGroups: [{ id: 'g1', name: 'Production' }], profiles: [{ type: 'ssh', name: 'IPv6', group: 'g1', options: { host: '2001:db8::1', port: 2222 } }] });
check('G09 Tabby group IDs resolve to machine group names', grouped.sessions[0].folder === 'Production');
const jumpDoc = { profiles: [{ id: 'jump-id', type: 'ssh', name: 'Gateway', options: { host: '2001:db8::2', port: 22, user: 'root' } }, { id: 'target', type: 'ssh', name: 'Server', options: { host: 'server', jumpHost: 'jump-id' } }] };
const jumped = G.importDocument(jumpDoc).sessions;
check('G10 Referenced Tabby jump host resolves to a usable SSH address with IPv6 brackets', jumped[1].jumpHost === 'root@[2001:db8::2]:22');
const jumpExport = G.exportDocument(jumped, jumpDoc);
check('G11 Export maps the native jump address back to Tabby profile ID', jumpExport.profiles[1].options.jumpHost === 'jump-id');
const exported = G.exportDocument(local, remote);
check('G12 Export preserves remote UI settings and unsupported plugin profiles', exported.appearance.theme === 'cloud-theme' && exported.profiles.some(p => p.id === 'extension:other'));
check('G13 Export replaces matching machines and retains cloud-only machines', exported.profiles.find(p => p.id === 'ssh:lab').options.host === 'local.example' && exported.profiles.some(p => p.id === 'ssh:cloud'));
check('G14 Export contains no local UI or local credentials', !('theme' in exported) && !JSON.stringify(exported.profiles).includes('local-password') && !JSON.stringify(exported.profiles).includes('remote-password'));
const recursive = G.toProfile(local[0], { type: 'ssh', options: { password: 'bad', custom: { token: 'bad', keep: 1 } }, privateKey: 'bad' });
check('G15 Existing matched profile is scrubbed recursively before upload', !JSON.stringify(recursive).includes('bad') && recursive.options.custom.keep === 1);
const rows = G.compare(local, imported.sessions);
check('G16 Preview identifies conflicts and machines unique to either side', rows.some(r => r.state === 'conflict') && rows.some(r => r.state === 'local') && rows.some(r => r.state === 'remote'));
const localWins = G.merge(local, imported.sessions), remoteWins = G.merge(local, imported.sessions, true);
check('G17 Local-priority merge keeps local conflict and adds cloud-only machines', localWins.length === 3 && localWins[0].host === 'local.example');
check('G18 Cloud-priority merge keeps local secrets while updating connection fields', remoteWins[0].host === 'remote.example' && remoteWins[0].password === 'local-password' && remoteWins[0].lastUsed === 7);
check('G19 Replace excludes local-only machine', G.merge(local, imported.sessions, true, true).length === 2);
let invalid = false; try { G.importDocument({ version: 7 }); } catch (_) { invalid = true; }
check('G20 Unrelated/non-Tabby documents cannot be treated as empty machine lists', invalid);
const serial = { name: 'Console', protocol: 'serial', target: '/dev/ttyUSB0', baudRate: 115200, dataBits: 8, parity: 'none' };
check('G21 Serial extension fields roundtrip without losing device settings', G.fromProfile(G.toProfile(serial)).baudRate === 115200 && G.fromProfile(G.toProfile(serial)).target === '/dev/ttyUSB0');
const tcp = { name: 'Socket', protocol: 'tcp', host: 'socket.example', port: 8080 };
check('G22 TCP and local profiles map through the supported protocol boundary', G.fromProfile(G.toProfile(tcp)).port === 8080 && G.fromProfile(G.toProfile(local[1])).command === '/bin/zsh');
check('G22a Equivalent default fields do not create false conflicts after a roundtrip', G.compare(local, G.importDocument(G.exportDocument(local)).sessions).every(row => row.state === 'same'));
const badJump = G.importDocument({ profiles: [{ id: 'loop', type: 'ssh', name: 'Loop', options: { host: 'test.invalid', jumpHost: 'loop' } }] });
check('G22b Circular jump hosts are skipped with an explicit compatibility warning', badJump.sessions.length === 0 && badJump.warnings[0].includes('循环'));
const badSerial = G.importDocument({ profiles: [{ type: 'serial', name: 'Half stop', options: { port: '/dev/ttyUSB0', stopbits: 1.5 } }] });
check('G22c Unsupported fractional stop bits cannot reach the integer backend contract', badSerial.sessions.length === 0 && badSerial.warnings[0].includes('停止位'));
const standardSerial = G.fromProfile({ type: 'serial', name: 'Standard', options: { port: '/dev/ttyACM0', baudrate: 57600, databits: 7, stopbits: 2, parity: 'even', rtscts: true } });
check('G22d Standard Tabby serial fields import without the native extension', standardSerial.baudRate === 57600 && standardSerial.dataBits === 7 && standardSerial.stopBits === 2 && standardSerial.flowControl === 'RTS/CTS');

field('gistId', 'https://gist.github.com/example/abcdef123456'); field('token', 'test-token-not-real'); field('secret', 'test-secret-long');
await click('save');
const persisted = calls.findLast(([c, a]) => c === 'ui_state_save' && a.name === 'gist-sync');
check('G23 Saving persists only ID, file and proxy, never token or encryption secret', persisted && Object.keys(JSON.parse(persisted[1].value)).sort().join(',') === 'filename,gistId,proxy' && !persisted[1].value.includes('test-token') && !persisted[1].value.includes('test-secret'));
await click('test');
check('G24 Connection test uses the backend test operation and causes no writes', calls.filter(([c]) => c === 'gist_request').at(-1)[1].request.operation === 'test' && !calls.some(([c, a]) => c === 'gist_request' && ['write', 'create'].includes(a.request.operation)));
await click('download');
check('G25 Download renders a difference preview before touching local sessions', q('.gs-preview')?.textContent.includes('内容不同') && !calls.some(([c]) => c === 'sessions_save'));
await click('replace');
check('G26 Replacing local machines requires the explicit deletion checkbox', !calls.some(([c]) => c === 'sessions_save') && q('.gs-status').textContent.includes('勾选'));
q('[data-gs-replace]').checked = true; await click('replace');
const backupIndex = calls.findIndex(([c, a]) => c === 'ui_state_save' && a.name === 'gist-machines-backup'), saveIndex = calls.findIndex(([c]) => c === 'sessions_save');
check('G27 Local replacement persists a backup before saving machines', backupIndex >= 0 && saveIndex > backupIndex && same(JSON.parse(calls[backupIndex][1].value), local));
check('G28 Applied machines refresh home and preserve matching local credentials', w.WT.s.sessions.length === 2 && w.WT.s.sessions[0].password === 'local-password' && homeRenders === 1);
await click('upload'); const beforeWrite = calls.filter(([c]) => c === 'gist_request').length;
check('G29 Upload only previews until the explicit confirm action', q('[data-gs-action="confirm-upload"]') && calls.filter(([c]) => c === 'gist_request').at(-1)[1].request.operation === 'read');
await click('confirm-upload'); const write = calls.filter(([c]) => c === 'gist_request').at(-1)[1].request;
check('G30 Confirmed upload includes the preview revision and complete preserved remote document', write.operation === 'write' && write.expectedRevision === 'revision-1' && write.document.appearance.theme === 'cloud-theme');
check('G31 Confirmed upload strips machine credentials at the wire boundary', !JSON.stringify(write.document.profiles).includes('local-password') && !JSON.stringify(write.document.profiles).includes('remote-password'));
await click('create');
check('G32 New private Gist needs a second confirmation and never creates during preview', q('[data-gs-action="confirm-create"]') && calls.filter(([c]) => c === 'gist_request').at(-1)[1].request.operation === 'write');
await click('confirm-create');
check('G33 Confirmed create uploads only machine profiles in a fresh document', calls.filter(([c]) => c === 'gist_request').at(-1)[1].request.operation === 'create' && Object.keys(calls.filter(([c]) => c === 'gist_request').at(-1)[1].request.document).join(',') === 'profiles');
await click('download'); field('proxy', '');
check('G34 Editing connection information invalidates a stale preview', !q('.gs-preview'));
await click('download'); w.WT.s.sessions.push({ name: 'Changed', protocol: 'local' }); await click('merge-local');
check('G35 Changes made after preview are rejected before local overwrite', q('.gs-status').textContent.includes('已改变'));
const originalBridge = bridge;
bridge = async (command, args) => { if (command === 'gist_request') throw new Error('remote failure test-token-not-real test-secret-long'); return originalBridge(command, args); };
await click('test');
check('G36 Provider errors redact token and encryption secret', !q('.gs-status').textContent.includes('test-token-not-real') && !q('.gs-status').textContent.includes('test-secret-long') && q('.gs-status').textContent.includes('[已隐藏]'));
bridge = originalBridge;
let release; bridge = (command, args) => command === 'gist_request' ? new Promise(resolve => { calls.push([command, args]); release = resolve; }) : originalBridge(command, args);
q('[data-gs-action="download"]').click(); const busyCalls = calls.length;
q('[data-gs-action="download"]').click();
check('G37 Busy operation disables controls and suppresses duplicate requests', calls.length === busyCalls && [...root.querySelectorAll('button,input')].every(el => el.disabled));
root.remove(); const other = d.createElement('div'); other.textContent = 'Other settings'; d.body.appendChild(other);
release({ gistId: 'abcdef123456', revision: 'revision-3', document: remote }); await settle();
check('G38 Async completion cannot replace another settings section after navigation', other.textContent === 'Other settings');
d.body.appendChild(root); root.innerHTML = G.view(); G.bind(root); bridge = originalBridge;
await click('forget');
check('G39 Clear credentials erases in-memory token/key and pending preview', q('[data-gs-field="token"]').value === '' && q('[data-gs-field="secret"]').value === '' && !q('.gs-preview'));
const beforeMissing = calls.length; await click('test');
check('G40 Missing token is rejected locally without a GitHub request', calls.length === beforeMissing && q('.gs-status').textContent.includes('Token'));
check('G41 Production settings page loads both Gist assets and mounts an isolated root', readFileSync(new URL('../src/index.html', import.meta.url), 'utf8').includes('src="gist-sync.js"') && readFileSync(new URL('../src/settings.js', import.meta.url), 'utf8').includes('GistSync.bind(bodyEl.querySelector'));
check('G42 Gist styles use the shared current-theme tokens', !/var\(--(?:muted|red|yellow)[,)\s]/.test(readFileSync(new URL('../src/gist-sync.css', import.meta.url), 'utf8')));
check('G43 No JavaScript errors', errors.length === 0);

for (const [passed, name] of results) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
const failed = results.filter(([passed]) => !passed);
console.log(`\nRESULT ${results.length - failed.length} passed, ${failed.length} failed`);
dom.window.close(); assert.equal(failed.length, 0, failed.map(([, name]) => name).join('\n'));
