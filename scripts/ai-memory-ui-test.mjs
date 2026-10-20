// Production memory UI + IPC contract, with a deterministic in-memory native bridge.
// No model/embedding network, user documents, or operating-system credentials are used.
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/ai-memory.js', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const markdownParser = readFileSync(require.resolve('markdown-it/browser'), 'utf8');
const markdownSource = readFileSync(new URL('../src/ai-markdown.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ai-memory.css', import.meta.url), 'utf8');
const checks = [], errors = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS ' + name); };
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 12)); };
const tab = (host = 'Example.COM', user = 'Alice', id = 'unstable-id') => ({ id, session: { protocol: 'ssh', host, user, port: 22 } });
function fixture(config = {}, options = {}) {
  const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><body><aside id="ai-panel" hidden><textarea id="ai-input"></textarea></aside></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://tauri.localhost/', virtualConsole: vc });
  const w = dom.window, d = w.document, calls = [], snapshots = [], documents = new Map(), credentials = new Map(options.credentials || []);
  const heldReads = [], heldWrites = [], heldLists = []; let holdRead = !!options.holdRead, holdWrite = false, holdList = false, failCredentials = false, searchMode = '';
  Object.defineProperty(w, 'crypto', { value: webcrypto }); w.TextEncoder = TextEncoder;
  const sha = content => createHash('sha256').update(content).digest('hex');
  const docKey = (scope, path) => scope + ':' + path;
  const put = (scope, path, content) => { const doc = { scope, path, content, hash: sha(content), bytes: Buffer.byteLength(content), updatedMs: Date.now() }; documents.set(docKey(scope, path), doc); return doc; };
  const compactDoc = doc => { const { content, ...metadata } = doc; return metadata; };
  const T = w.WT = { s: { aiMemory: { ...config }, ai: { endpoint: 'https://chat.example/v1', model: 'chat-only' } },
    term: { activeTab: () => tab() }, persistSettings() { snapshots.push(JSON.parse(JSON.stringify(T.s))); },
    async invoke(command, args = {}) {
      calls.push([command, JSON.parse(JSON.stringify(args))]);
      if (command.startsWith('memory_key_')) {
        if (failCredentials) throw new Error('secret-fixture-body-never-display');
        if (command === 'memory_key_read') {
          const captured = credentials.get(args.endpoint) || null;
          if (holdRead) return new Promise(resolve => heldReads.push(() => resolve(captured)));
          return captured;
        }
        if (command === 'memory_key_write') {
          if (holdWrite) return new Promise(resolve => heldWrites.push(() => { credentials.set(args.endpoint, args.apiKey); resolve(null); }));
          credentials.set(args.endpoint, args.apiKey); return null;
        }
        credentials.delete(args.endpoint); return null;
      }
      if (command === 'memory_list') {
        const result = [...documents.values()].filter(doc => doc.scope === args.scope).map(compactDoc);
        if (holdList) return new Promise(resolve => heldLists.push(() => resolve(result)));
        return result;
      }
      if (command === 'memory_status') return { documents: 2, indexedChunks: 3, embeddingChunks: 2, mode: 'hybrid' };
      if (command === 'memory_get') {
        const doc = documents.get(docKey(args.scope, args.path)); if (!doc) throw new Error('not found');
        return { ...doc, startLine: 1, endLine: doc.content.split('\n').length, totalLines: doc.content.split('\n').length };
      }
      if (command === 'memory_write') {
        const req = args.request, existing = documents.get(docKey(req.scope, req.path));
        if (req.expectedHash != null && req.expectedHash !== (existing?.hash || '')) throw new Error('conflict: changed file');
        return compactDoc(put(req.scope, req.path, req.append ? (existing?.content || '') + req.content : req.content));
      }
      if (command === 'memory_delete') {
        const req = args.request, existing = documents.get(docKey(req.scope, req.path));
        if (!existing || existing.hash !== req.expectedHash) throw new Error('conflict: changed file');
        documents.delete(docKey(req.scope, req.path)); return { deleted: true, backupPath: '/private/fixture-backup' };
      }
      if (command === 'memory_embedding_test') return { dimensions: 768, message: 'ok' };
      if (command === 'memory_reindex') return { indexedChunks: 3, embeddingChunks: args.request.embedding ? 3 : 0, mode: args.request.embedding ? 'hybrid' : 'keyword' };
      if (command === 'memory_search') {
        const req = args.request;
        return { hits: [...documents.values()].filter(doc => doc.scope === req.scope || (req.includeGlobal && doc.scope === 'global')).slice(0, req.maxResults).map(doc => ({ scope: doc.scope, path: doc.path, startLine: 1, endLine: 2, snippet: doc.content, hash: doc.hash, score: .8 })),
          indexedChunks: 3, embeddingChunks: req.embedding ? 2 : 0, mode: searchMode || (req.embedding ? 'hybrid' : 'keyword'), warning: searchMode === 'keyword' ? 'Embedding 服务不可用，已降级关键词检索' : '' };
      }
      throw new Error('Unexpected IPC: ' + command);
    } };
  w.eval(markdownParser); w.eval(markdownSource); w.eval(source); const A = w.AiMemory;
  const q = selector => d.querySelector(selector), input = (selector, value) => { const n = q(selector); assert.ok(n, selector); n.value = value; n.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = async selector => { assert.ok(q(selector), selector); q(selector).click(); await settle(); };
  return { w, d, A, T, calls, snapshots, documents, credentials, put, q, input, click, heldReads, heldWrites, heldLists,
    flags(value) { if ('holdRead' in value) holdRead = value.holdRead; if ('holdWrite' in value) holdWrite = value.holdWrite; if ('holdList' in value) holdList = value.holdList; if ('failCredentials' in value) failCredentials = value.failCredentials; if ('searchMode' in value) searchMode = value.searchMode; },
    count(name) { return calls.filter(([command]) => command === name).length; }, last(name) { return calls.filter(([command]) => command === name).at(-1)?.[1]; }, close() { dom.window.close(); } };
}
const f = fixture();
try {
  const { A, q, input, click, T } = f;
  check('M01 Loading module starts no IPC or external retrieval', f.calls.length === 0 && !A.isEnabled());
  check('M02 Defaults match opt-in memory and OpenClaw top6/minScore .35', !A.settings().enabled && A.settings().maxResults === 6 && A.settings().minScore === .35 && !A.settings().flushBeforeCompact);
  await A.recall({ query: 'private user query', tab: tab() });
  check('M03 Disabled automatic recall starts no native request or credential read', f.calls.length === 0);
  A.mount(); A.mount();
  check('M04 Mount creates one hidden management view without retrieval', f.d.querySelectorAll('#ai-memory').length === 1 && !A.isOpen() && f.calls.length === 0);
  const scope = await A.scopeFor(tab());
  check('M05 Remote scope is canonical SHA256 with machine prefix', /^machine-[0-9a-f]{64}$/.test(scope));
  check('M06 Host case and unstable saved-session IDs do not split one machine', scope === await A.scopeFor(tab('example.com', 'Alice', 'different-id')));
  check('M07 Case-sensitive SSH users and hosts isolate machine memories', scope !== await A.scopeFor(tab('example.com', 'alice')) && scope !== await A.scopeFor(tab('other.example', 'Alice')));
  check('M08 Local tabs share only the canonical local scope', await A.scopeFor({ session: { protocol: 'local' } }) === 'machine-local');
  check('M08b Serial device target and case-sensitive paths have independent memory scopes',
    await A.scopeFor({ session: { protocol: 'serial', target: '/dev/ttyUSB0' } }) !== await A.scopeFor({ session: { protocol: 'serial', target: '/dev/ttyUSB1' } })
    && await A.scopeFor({ session: { protocol: 'serial', target: '/dev/ttyUSB0' } }) !== await A.scopeFor({ session: { protocol: 'serial', target: '/dev/ttyusb0' } }));
  check('M08c Target-only TCP profiles keep different peer addresses in separate scopes',
    await A.scopeFor({ session: { protocol: 'tcp', target: 'one.fixture.invalid:9000' } }) !== await A.scopeFor({ session: { protocol: 'tcp', target: 'two.fixture.invalid:9000' } }));

  f.put(scope, 'MEMORY.md', '# Server\n<img src=x onerror=alert(1)>'); f.put('global', 'MEMORY.md', 'Global conventions');
  await A.open({ tab: tab() });
  check('M09 Opening lists machine documents with no Embedding request', A.isOpen() && q('#aim-documents').textContent.includes('MEMORY.md') && !f.count('memory_search') && !f.count('memory_embedding_test'));
  check('M09b First open without a provider shows and focuses Embedding configuration guidance', !q('#aim-config').hidden && q('#aim-endpoint').value === '' && !q('#aim-enabled').checked && f.d.activeElement === q('#aim-endpoint'));
  check('M10 Settings explain external Embedding data and separate chat credentials', q('#aim-config').textContent.includes('记忆片段会发送') && q('#aim-config').textContent.includes('聊天模型与此服务独立') && !q('#aim-enabled').checked);
  check('M11 Key field is masked and all text fields disable autocapitalization', q('#aim-key').type === 'password' && q('#aim-key').autocomplete === 'new-password' && [...f.d.querySelectorAll('#ai-memory input:not([type=checkbox]),#ai-memory textarea')].every(n => n.getAttribute('autocapitalize') === 'none' && n.getAttribute('autocorrect') === 'off'));
  input('#aim-query', 'server'); await click('#aim-search');
  check('M12 Manual search while disabled uses native keywords without Embedding credentials', f.last('memory_search').request.embedding === undefined && q('#aim-status').textContent.includes('关键词检索'));
  check('M13 Search results show original path and line provenance safely', q('#aim-results').textContent.includes('MEMORY.md:1–2') && !q('#aim-results img') && q('#aim-results').textContent.includes('<img src=x'));
  await click('#aim-results .aim-hit button');
  check('M14 Result click reads full original text rather than rendering HTML', q('#aim-content').value.includes('<img src=x') && !q('#aim-editor img'));
  input('#aim-content', 'user draft'); await click('#aim-global');
  check('M15 Unsaved editing prevents silent scope changes', q('#aim-machine').classList.contains('on') && q('#aim-content').value === 'user draft' && q('#aim-status').textContent.includes('草稿'));
  // An outside editor modifies the source after it was read.
  f.put(scope, 'MEMORY.md', 'outside edit'); await click('#aim-write');
  check('M16 Hash conflict retains local draft without overwriting outside changes', q('#aim-content').value === 'user draft' && f.documents.get(scope + ':MEMORY.md').content === 'outside edit' && q('#aim-status').textContent.includes('未覆盖'));
  await click('#aim-discard');
  check('M17 Explicit discard reloads the new original', q('#aim-content').value === 'outside edit');
  input('#aim-content', 'approved user edit'); await click('#aim-write');
  check('M18 Explicit save writes only edited Markdown with expected hash', f.documents.get(scope + ':MEMORY.md').content === 'approved user edit' && !!f.last('memory_write').request.expectedHash);
  const deletedBefore = f.count('memory_delete'); await click('#aim-delete');
  check('M19 Delete only opens an explicit backup confirmation', !q('#aim-delete-confirm').hidden && f.count('memory_delete') === deletedBefore);
  await click('#aim-delete-cancel');
  check('M20 Cancelling deletion preserves original', q('#aim-delete-confirm').hidden && f.documents.has(scope + ':MEMORY.md'));
  await click('#aim-delete'); await click('#aim-delete-yes');
  check('M21 Confirmed deletion reports backup and removes the selected source', !f.documents.has(scope + ':MEMORY.md') && q('#aim-status').textContent.includes('备份'));
  if (q('#aim-config').hidden) await click('#aim-config-toggle'); input('#aim-endpoint', 'https://embedding.example/v1'); input('#aim-model', 'embedding-only'); input('#aim-key', 'embedding-secret'); q('#aim-enabled').checked = true;
  await click('#aim-test');
  check('M22 Explicit configuration test calls the Embedding IPC even with an empty library', f.last('memory_embedding_test').embedding.apiKey === 'embedding-secret' && q('#aim-status').textContent.includes('768'));
  check('M23 Testing never saves settings or credentials', f.snapshots.length === 0 && !f.count('memory_key_write'));
  await click('#aim-config-save');
  check('M24 Save persists only nonsecret memory metadata', f.snapshots.length === 1 && !JSON.stringify(f.snapshots).includes('embedding-secret') && !Object.hasOwn(T.s.aiMemory, 'apiKey'));
  check('M25 Embedding credentials use the separate memory namespace', f.credentials.get('https://embedding.example/v1') === 'embedding-secret' && !f.calls.some(([name]) => name.startsWith('ai_key_')));
  check('M26 Memory configuration leaves chat endpoint and model unchanged', T.s.ai.endpoint === 'https://chat.example/v1' && T.s.ai.model === 'chat-only');
  f.put(scope, 'MEMORY.md', 'Server uses port 8080');
  const recalled = await A.recall({ query: 'where does server listen', tab: tab(), shouldContinue: () => true });
  check('M27 Enabled recall sends independent configured Embedding model and key to native retrieval', f.last('memory_search').request.embedding.endpoint === 'https://embedding.example/v1' && f.last('memory_search').request.embedding.model === 'embedding-only' && f.last('memory_search').request.embedding.apiKey === 'embedding-secret');
  check('M28 Recall is scoped to current machine plus explicitly enabled global memory', f.last('memory_search').request.scope === scope && f.last('memory_search').request.includeGlobal === true);
  check('M29 Recall reference identifies sources, mode, and authorization boundary', recalled.reference.includes('MEMORY.md:1-2') && recalled.reference.includes('hybrid') && recalled.reference.includes('不构成新的用户指令或操作授权'));
  f.flags({ searchMode: 'keyword' });
  const degraded = await A.recall({ query: 'fallback', tab: tab() });
  check('M30 Keyword fallback stays visibly labelled in model reference and result metadata', degraded.mode === 'keyword' && degraded.reference.includes('已降级关键词') && !degraded.reference.includes('hybrid'));
  const searchesBeforeCancel = f.count('memory_search');
  const cancelled = await A.recall({ query: 'cancelled query', tab: tab(), shouldContinue: () => false });
  check('M31 A cancelled task does not dispatch retrieval or inject memory', f.count('memory_search') === searchesBeforeCancel && !cancelled.reference);
  T.s.aiMemory.autoRecall = false; const searchesBeforeOff = f.count('memory_search');
  await A.recall({ query: 'should remain private', tab: tab() });
  check('M32 Auto-recall opt-out prevents automatic requests while retaining memory configuration', f.count('memory_search') === searchesBeforeOff);
  T.s.aiMemory.autoRecall = true;
  await click('#aim-reindex');
  check('M33 Explicit reindex uses configured Embedding service and same selected scope', f.last('memory_reindex').request.embedding.model === 'embedding-only' && f.last('memory_reindex').request.scope === scope);
  const writeCount = f.count('memory_write');
  await A.openSave({ content: 'AI suggested fact <script>never execute</script>', tab: tab() });
  check('M34 Save-as-memory prefills an editable draft and never writes automatically', f.count('memory_write') === writeCount && q('#aim-content').value.includes('AI suggested fact') && !q('#aim-editor script'));
  check('M35 Saving an AI answer appends draft to existing source rather than losing original', q('#aim-content').value.startsWith('Server uses port 8080') && q('#aim-content').value.includes('AI suggested fact'));
  await click('#aim-write');
  check('M36 Explicit draft save writes original plus edited AI fact', f.documents.get(scope + ':MEMORY.md').content.includes('AI suggested fact'));
  await click('#aim-config-toggle'); input('#aim-endpoint', 'https://another-embedding.example/v1');
  check('M37 Endpoint draft changes immediately clear the previous service key', q('#aim-key').value === '');
  input('#aim-endpoint', 'https://embedding.example/v1'); await click('#aim-forget-key');
  check('M38 Forget deletes only the selected Embedding credential and clears in-memory key', !f.credentials.has('https://embedding.example/v1') && (await A.getEmbeddingConfig()).apiKey === '');
  A.close();
  check('M39 Closing memory view returns to composer without discarding the conversation', !A.isOpen() && f.d.activeElement === q('#ai-input'));
  A.reportStatus('已整理当日记忆'); await A.open({ tab: tab() });
  check('M40 Background memory-flush status survives reopening manager', q('#aim-status').textContent.includes('已整理当日记忆'));
  check('M41 Shared theme stylesheet supports hidden views and responsive scrolling', css.includes('var(--accent)') && css.includes('.aim-scroll') && css.includes('#ai-memory[hidden]'));
  await assert.rejects(() => A.writeApproved({ scope, path: '../secrets.md', content: 'bad' }));
  check('M42 Frontend rejects traversal before writing native memory', f.count('memory_write') === writeCount + 1);
} finally { f.close(); }

// A credential read may finish after a delete/save; late data must never revive the key.
const race = fixture({ enabled: true, endpoint: 'https://old.example/v1', model: 'embed-old' }, { holdRead: true, credentials: [['https://old.example/v1', 'late-old-secret']] });
try {
  const opening = race.A.open({ tab: tab() }); await settle();
  check('M43 A controlled startup key read can remain pending while manager is usable', race.heldReads.length === 1);
  await race.click('#aim-config-toggle'); await race.click('#aim-forget-key'); race.heldReads.shift()(); await opening;
  check('M44 Late credential read cannot revive an explicitly deleted key', (await race.A.getEmbeddingConfig()).apiKey === '' && race.q('#aim-key').value === '');
  race.flags({ holdRead: false, holdWrite: true });
  race.input('#aim-endpoint', 'https://new.example/v1'); race.input('#aim-model', 'embed-new'); race.input('#aim-key', 'new-secret');
  await race.click('#aim-config-save');
  check('M45 Pending key save disables duplicate mutations and document commands', race.q('#aim-config-save').disabled && race.q('#aim-forget-key').disabled && race.q('#aim-reindex').disabled && race.q('#aim-search').disabled);
  const callsBefore = race.count('memory_search'); await assert.rejects(() => race.A.search({ query: 'during save', tab: tab() }));
  check('M46 Retrieval cannot use a half-saved endpoint/key pair', race.count('memory_search') === callsBefore);
  race.A.close(); race.heldWrites.shift()(); await settle();
  check('M47 Closing during a key save leaves view closed and persists intended endpoint atomically', !race.A.isOpen() && race.T.s.aiMemory.endpoint === 'https://new.example/v1' && race.credentials.get('https://new.example/v1') === 'new-secret');
  race.flags({ holdWrite: false }); await race.A.open({ tab: tab() });
  check('M48 Reopening uses the committed new endpoint/key without old service leakage', (await race.A.getEmbeddingConfig()).apiKey === 'new-secret' && race.q('#aim-key').value === 'new-secret');
  check('M48b A configured provider reopens with settings collapsed and search focused', race.q('#aim-config').hidden && race.d.activeElement === race.q('#aim-query'));
  race.flags({ failCredentials: true }); await race.click('#aim-config-toggle'); race.input('#aim-key', 'failure-secret'); await race.click('#aim-config-save');
  check('M49 Credential write failure reports a safe error without claiming settings saved', race.q('#aim-status').textContent.includes('未保存') && !race.q('#aim-status').textContent.includes('secret-fixture-body') && race.credentials.get('https://new.example/v1') === 'new-secret');
  check('M50 Failed or successful saves never persist key plaintext in metadata snapshots', !JSON.stringify(race.snapshots).includes('new-secret') && !JSON.stringify(race.snapshots).includes('failure-secret'));
} finally { race.close(); }

const scopeRace = fixture();
try {
  const one = await scopeRace.A.scopeFor(tab('first.example')); const two = await scopeRace.A.scopeFor(tab('second.example'));
  scopeRace.put(one, 'MEMORY.md', 'first machine secret'); scopeRace.put(two, 'MEMORY.md', 'second machine record');
  scopeRace.flags({ holdList: true }); const firstOpen = scopeRace.A.open({ tab: tab('first.example') }); await settle();
  scopeRace.A.close(); const secondOpen = scopeRace.A.open({ tab: tab('second.example') }); await settle();
  scopeRace.heldLists.at(-1)(); await secondOpen; scopeRace.heldLists[0](); await firstOpen;
  check('M51 A late previous-machine list cannot replace the new machine document list', scopeRace.last('memory_list').scope === two && scopeRace.q('#aim-machine').classList.contains('on'));
  scopeRace.flags({ holdList: false }); await scopeRace.click('#aim-documents button');
  check('M52 Reading after a machine-switch race returns only the new machine original', scopeRace.q('#aim-content').value === 'second machine record');
  scopeRace.put('global', 'MEMORY.md', 'global record'); scopeRace.input('#aim-query', 'global'); await scopeRace.click('#aim-search');
  const globalHit = [...scopeRace.d.querySelectorAll('.aim-hit button')].find(n => n.textContent.startsWith('全局')); globalHit.click(); await settle();
  check('M53 Clicking a global result switches editor scope to global explicitly', scopeRace.q('#aim-global').classList.contains('on') && scopeRace.q('#aim-content').value === 'global record');
  scopeRace.input('#aim-content', 'global updated'); await scopeRace.click('#aim-write');
  check('M54 Editing a global hit never accidentally writes into machine scope', scopeRace.documents.get('global:MEMORY.md').content === 'global updated' && scopeRace.documents.get(two + ':MEMORY.md').content === 'second machine record');
} finally { scopeRace.close(); }
const preserve = fixture({ enabled: true, endpoint: 'https://restore.example/v1', model: 'old-model' }, { holdRead: true, credentials: [['https://restore.example/v1', 'restoring-secret']] });
try {
  const opening = preserve.A.open({ tab: tab() }); await settle(); await preserve.click('#aim-config-toggle');
  preserve.input('#aim-model', 'new-model'); await preserve.click('#aim-config-save');
  check('M55 Saving only preferences waits for a pending credential read without deleting it', preserve.q('#aim-config-save').disabled && !preserve.count('memory_key_delete') && !preserve.count('memory_key_write'));
  preserve.heldReads.shift()(); await opening; await settle();
  check('M56 Restored key survives a model-only save and is paired with the new model', (await preserve.A.getEmbeddingConfig()).apiKey === 'restoring-secret' && preserve.T.s.aiMemory.model === 'new-model' && preserve.credentials.get('https://restore.example/v1') === 'restoring-secret');
} finally { preserve.close(); }
const previewRace = fixture();
try {
  const firstScope = await previewRace.A.scopeFor(tab('preview-first.example')), secondScope = await previewRace.A.scopeFor(tab('preview-second.example'));
  previewRace.put(firstScope, 'MEMORY.md', 'first original'); previewRace.put(secondScope, 'MEMORY.md', 'second original');
  previewRace.flags({ holdList: true });
  const first = previewRace.A.openSave({ content: 'first assistant', tab: tab('preview-first.example') }); await settle();
  const second = previewRace.A.openSave({ content: 'second assistant', tab: tab('preview-second.example') }); await settle();
  previewRace.heldLists.at(-1)(); await second; previewRace.heldLists[0](); await first;
  check('M57 Late earlier save-preview cannot overwrite the newest machine draft', previewRace.q('#aim-content').value === 'second original\n\nsecond assistant' && !previewRace.count('memory_write'));
} finally { previewRace.close(); }
const providerSwitch = fixture({ enabled: true, endpoint: 'https://provider-a.example/v1', model: 'embed-a' }, { credentials: [['https://provider-a.example/v1', 'provider-a-key'], ['https://provider-b.example/v1', 'provider-b-key']] });
try {
  await providerSwitch.A.open({ tab: tab() }); await providerSwitch.click('#aim-config-toggle');
  providerSwitch.input('#aim-endpoint', 'https://provider-b.example/v1'); providerSwitch.input('#aim-model', 'embed-b'); await providerSwitch.click('#aim-config-save');
  check('M58 Returning to a saved Embedding provider restores only its own key after endpoint change', (await providerSwitch.A.getEmbeddingConfig()).apiKey === 'provider-b-key' && providerSwitch.credentials.get('https://provider-a.example/v1') === 'provider-a-key');
  await providerSwitch.click('#aim-config-toggle'); providerSwitch.input('#aim-key', ''); await providerSwitch.click('#aim-config-save');
  check('M59 Deliberately clearing a key removes the selected saved credential and runtime copy', !providerSwitch.credentials.has('https://provider-b.example/v1') && (await providerSwitch.A.getEmbeddingConfig()).apiKey === '');
} finally { providerSwitch.close(); }
const markdown = fixture();
try {
  const { A, q, input, click, T } = markdown, clipboard = [];
  T.copyText = async value => { clipboard.push(value); };
  const scope = await A.scopeFor(tab());
  const original = '# Stored memory\n\n- first item\n\n```sh\nprintf preview-only\n```\n\n![remote image](https://tracker.invalid/pixel)\n\n<script>never run</script>';
  markdown.put(scope, 'MEMORY.md', original);
  await A.open({ tab: tab() }); await click('#aim-documents button');
  check('M70 Opening a memory shows a real Markdown preview and preserves exact editable source', !q('#aim-preview').hidden && q('#aim-preview h1')?.textContent === 'Stored memory' && q('#aim-preview li')?.textContent === 'first item' && q('#aim-content').value === original && q('#aim-preview-toggle').getAttribute('aria-expanded') === 'true');
  check('M71 Memory preview displays HTML/images as safe text and manual links only', !q('#aim-preview img, #aim-preview script') && q('#aim-preview').textContent.includes('<script>never run</script>') && q('#aim-preview .ai-image-placeholder a')?.href === 'https://tracker.invalid/pixel');
  check('M72 Memory code is copyable but never offers terminal insertion', !!q('#aim-preview [data-ai-copy-code]') && !q('#ai-memory [data-ai-insert]'));
  const writes = markdown.count('memory_write'), searches = markdown.count('memory_search'), reads = markdown.count('memory_get');
  await click('#aim-preview [data-ai-copy-code]');
  check('M73 Preview code copy preserves exact bytes without terminal/native write side effects', clipboard.at(-1) === 'printf preview-only' && markdown.count('memory_write') === writes && !markdown.calls.some(([command]) => ['write', 'write_binary', 'ai_chat'].includes(command)));
  const draft = '## Edited draft\n\n| Key | Value |\n| --- | --- |\n| **answer** | `42` |\n\n[blocked](javascript:alert(1))';
  input('#aim-content', draft);
  const field = q('#aim-content'); field.focus(); field.setSelectionRange(2, 7);
  field.dispatchEvent(new markdown.w.Event('input', { bubbles: true }));
  check('M74 Preview follows the unsaved Markdown draft without changing focus or source selection', q('#aim-preview h2')?.textContent === 'Edited draft' && !!q('#aim-preview .ai-table-wrap table td strong') && q('#aim-content').value === draft && markdown.d.activeElement === field && field.selectionStart === 2 && field.selectionEnd === 7);
  check('M75 Preview typing never saves or retrieves memory or makes unsafe links clickable', markdown.count('memory_write') === writes && markdown.count('memory_search') === searches && markdown.count('memory_get') === reads && !q('#aim-preview a[href]'));
  await click('#aim-preview-toggle');
  check('M76 Preview can be collapsed without hiding or discarding editable source', q('#aim-preview').hidden && q('#aim-preview-toggle').getAttribute('aria-expanded') === 'false' && !q('#aim-content').hidden && q('#aim-content').value === draft);
  await click('#aim-preview-toggle');
  check('M77 Reopening preview retains the current unsaved draft', !q('#aim-preview').hidden && q('#aim-preview h2')?.textContent === 'Edited draft');
  await click('#aim-write');
  check('M78 Saving stores original Markdown syntax rather than rendered preview text', markdown.documents.get(scope + ':MEMORY.md').content === draft && markdown.last('memory_write').request.content === draft && q('#aim-content').value === draft);
  input('#aim-query', 'edited'); await click('#aim-search');
  check('M79 Search excerpts use the same safe Markdown renderer without execution controls', q('#aim-results .aim-hit-preview h2')?.textContent === 'Edited draft' && !!q('#aim-results table') && !q('#aim-results [data-ai-insert], #aim-results img'));
  check('M80 Preview layout uses theme tokens and scrollable bounded content', css.includes('.aim-preview') && css.includes('max-height: 340px') && css.includes('overflow: auto') && css.includes('var(--input-bg)'));
} finally { markdown.close(); }
const limits = fixture({ enabled: true, endpoint: 'https://limits.example/v1', model: 'embed-limits' });
try {
  const scope = await limits.A.scopeFor(tab());
  limits.flags({ searchMode: 'keyword' });
  const truncated = await limits.A.search({ query: '中文检索'.repeat(2000), tab: tab() });
  const sent = limits.last('memory_search').request.query;
  check('M60 CJK query truncation respects native 8KiB UTF8 budget rather than character count', Buffer.byteLength(sent) <= 8192 && Buffer.byteLength(sent) >= 8189 && sent === '中文检索'.repeat(2000).slice(0, sent.length));
  check('M61 Query truncation is explicit and preserves the native Embedding-fallback warning', truncated.mode === 'keyword' && truncated.warning.includes('8 KiB') && truncated.warning.includes('已降级关键词'));
  const emoji = await limits.A.search({ query: 'a'.repeat(8191) + '😀', tab: tab() });
  check('M62 UTF8 query clipping never slices an emoji surrogate pair', limits.last('memory_search').request.query === 'a'.repeat(8191) && emoji.warning.includes('UTF-8'));
  const writes = limits.count('memory_write'), tooLarge = '中'.repeat(174763);
  await assert.rejects(() => limits.A.writeApproved({ scope, path: 'MEMORY.md', content: tooLarge }));
  check('M63 Memory write enforces 512KiB by UTF8 bytes before native IPC', tooLarge.length < 512 * 1024 && limits.count('memory_write') === writes);
  const exact = '中'.repeat(174762) + 'ab';
  await limits.A.writeApproved({ scope, path: 'MEMORY.md', content: exact, expectedHash: '' });
  check('M64 A complete multibyte document exactly at 512KiB remains writable', Buffer.byteLength(exact) === 512 * 1024 && limits.documents.get(scope + ':MEMORY.md').content === exact);
  await limits.A.open({ tab: tab() }); await limits.click('#aim-documents button');
  limits.input('#aim-content', tooLarge); await limits.click('#aim-write');
  check('M65 Editor save keeps oversized multibyte draft and does not cross native boundary', limits.count('memory_write') === writes + 1 && limits.q('#aim-content').value === tooLarge && limits.q('#aim-status').textContent.includes('UTF-8'));
  await limits.click('#aim-discard');
  const preview = await limits.A.openSave({ content: 'x', tab: tab() });
  check('M66 Save-reply checks combined original plus appended content by bytes without truncation', preview === false && limits.count('memory_write') === writes + 1 && limits.documents.get(scope + ':MEMORY.md').content === exact);
  const validPath = 'memory/' + 'a'.repeat(125) + '.md', invalidPath = 'memory/' + 'a'.repeat(126) + '.md';
  await limits.A.writeApproved({ scope, path: validPath, content: 'valid filename', expectedHash: '' });
  await assert.rejects(() => limits.A.writeApproved({ scope, path: invalidPath, content: 'invalid filename' }));
  check('M67 Markdown basename limit is 128 ASCII characters and rejects 129 before writing', validPath.split('/').pop().length === 128 && limits.count('memory_write') === writes + 2);
  check('M68 Save-reply rejects a native-invalid basename before opening a draft', await limits.A.openSave({ content: 'fact', tab: tab(), path: invalidPath }) === false && limits.count('memory_write') === writes + 2);
} finally { limits.close(); }
check('M69 All DOM interactions finish without browser runtime errors', errors.length === 0);
console.log(JSON.stringify({ passed: checks.length, total: checks.length, networkRequests: 0, realCredentials: false, realUserDocuments: false }));
