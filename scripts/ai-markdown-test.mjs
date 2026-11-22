// Production Markdown module + the installed official parser in a real DOM.
// Resource loading is blocked; no network, clipboard or terminal is accessed.
import { JSDOM, VirtualConsole, requestInterceptor } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url), requests = [], errors = [], copied = [], inserted = [];
const vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM('<!doctype html><body><main></main></body>', {
  runScripts: 'outside-only', resources: { interceptors: [requestInterceptor(request => { requests.push(request.url); return new Response('', { status: 403 }); })] }, virtualConsole: vc, url: 'http://fixture.invalid/',
});
const w = dom.window, d = w.document, host = d.querySelector('main');
w.fetch = () => { throw new Error('Markdown rendering must not fetch resources'); };
w.eval(readFileSync(require.resolve('markdown-it/browser'), 'utf8'));
const realParser = w.markdownit;
w.eval(readFileSync(new URL('../src/ai-markdown.js', import.meta.url), 'utf8'));
// Reject HTML sinks, including accidental future use of the parser's renderer.
Object.defineProperty(w.Element.prototype, 'innerHTML', { set() { throw new Error('innerHTML forbidden'); } });
Object.defineProperty(w.Element.prototype, 'outerHTML', { set() { throw new Error('outerHTML forbidden'); } });
const options = extra => ({
  complete: true,
  onCopyCode(code, language) { copied.push([code, language]); },
  onInsertCode(code, language) { inserted.push([code, language]); },
  canInsertCode(code, language) { return /^(?:sh|shell|bash|zsh|fish|powershell|pwsh|cmd|bat|console|terminal)?$/i.test(language) && !!code.trim() && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(code.trim()); },
  ...extra,
});
const render = (text, extra = {}) => w.AiMarkdown.render(host, text, options(extra));
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS ' + name); }
function equal(name, actual, expected) { assert.deepEqual(actual, expected, name); passed++; console.log('PASS ' + name); }
const click = selector => { const button = host.querySelector(selector); assert.ok(button, selector); button.click(); };
try {
  check('M01 production module exposes a render function', typeof w.AiMarkdown.render === 'function');
  render('# Title\n\nParagraph *emphasis* **strong** ~~deleted~~.\n\n- first\n  - nested\n- second\n\n3. third\n4. fourth\n\n> quoted\n\n---\n\n| Name | Value |\n| :--- | ---: |\n| `alpha` | **beta** |');
  check('M02 headings, paragraphs, emphasis and strikethrough use semantic elements', host.querySelector('h1')?.textContent === 'Title' && host.querySelector('p em')?.textContent === 'emphasis' && host.querySelector('p strong')?.textContent === 'strong' && host.querySelector('s')?.textContent === 'deleted');
  check('M03 nested unordered lists and ordered-list start are preserved', host.querySelectorAll('ul').length === 2 && host.querySelector('ul ul li')?.textContent === 'nested' && host.querySelector('ol')?.getAttribute('start') === '3' && host.querySelectorAll('ol > li').length === 2);
  check('M04 blockquote and horizontal rule are rendered', host.querySelector('blockquote p')?.textContent === 'quoted' && !!host.querySelector('hr'));
  check('M05 GFM table retains headers, alignment and inline formatting', host.querySelectorAll('table th').length === 2 && host.querySelector('th')?.getAttribute('scope') === 'col' && host.querySelector('th')?.style.textAlign === 'left' && host.querySelectorAll('th')[1]?.style.textAlign === 'right' && host.querySelector('td code')?.textContent === 'alpha' && host.querySelector('td strong')?.textContent === 'beta');
  check('M05 tables have a dedicated horizontal overflow wrapper', !!host.querySelector('.ai-table-wrap > table'));
  for (let level = 1; level <= 6; level++) { render('#'.repeat(level) + ' heading'); check('M06 heading level ' + level, !!host.querySelector('h' + level)); }
  render('first  \nsecond\nsoft\n\n\\*literal\\* &lt;img src=x&gt;');
  check('M07 hard breaks, soft breaks, escapes and entities remain literal', host.querySelectorAll('br').length === 1 && host.textContent.includes('second\nsoft') && host.textContent.includes('*literal* <img src=x>') && !host.querySelector('img'));

  const malicious = '<script>window.__markdownExecuted=1</script>\n<img src="https://tracker.invalid/pixel" onerror="window.__markdownExecuted=2">\n<iframe src="file:///etc/passwd"></iframe>';
  render(malicious);
  check('M08 raw HTML is visible text and never executable DOM', host.textContent.includes('<script>') && host.textContent.includes('<img') && !host.querySelector('script,img,iframe,svg,object,embed') && !w.__markdownExecuted);
  render('`<img src=x onerror=alert(1)>`\n\n```html\n<script>alert(1)</script>\n```');
  check('M09 inline and fenced HTML code stays text', host.querySelectorAll('code').length === 2 && !host.querySelector('script,img') && host.querySelector('pre code')?.textContent === '<script>alert(1)</script>');
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd', 'vbscript:msgbox(1)', '//tracker.invalid/path', '/relative', '#local', 'https://user:secret@example.com/']) {
    render('[unsafe](' + url + ')');
    check('M10 unsafe/relative link has no navigable anchor: ' + url, !host.querySelector('a[href]'));
  }
  for (const url of ['https://example.com/docs?q=%22%3E', 'http://127.0.0.1:8080/path', 'mailto:person@example.com']) {
    render('[safe](' + url + ' "A title")');
    const link = host.querySelector('a');
    check('M11 allowed link is explicit and isolated: ' + url, !!link && link.target === '_blank' && link.rel === 'noopener noreferrer' && link.title === 'A title' && ['http:', 'https:', 'mailto:'].includes(new URL(link.href).protocol));
  }
  render('![*remote* alt](https://tracker.invalid/pixel "image")');
  check('M12 image shows alt text and an explicit link without creating an image', !host.querySelector('img') && host.textContent.includes('[图片：remote alt]') && host.querySelector('a')?.href === 'https://tracker.invalid/pixel');
  render('![data image](data:image/png;base64,iVBORw0KGgo=)');
  check('M13 data image is neither loaded nor navigable', !host.querySelector('img,a[href]') && host.textContent.includes('data image'));
  render('[![alt](https://tracker.invalid/pixel)](https://outer.example/)');
  check('M14 image inside a link cannot create nested or conflicting anchors', host.querySelectorAll('a').length === 1 && host.querySelector('a')?.href === 'https://outer.example/' && !host.querySelector('a a,img'));

  render('```bash\nprintf hello\n```');
  check('M15 code uses existing DOM classes and action markers', !!host.querySelector('.ai-code > .ai-code-bar > span [data-ai-copy-code]') && !!host.querySelector('.ai-code > pre > code') && host.querySelector('pre code')?.textContent === 'printf hello' && !!host.querySelector('[data-ai-insert]'));
  click('[data-ai-copy-code]'); click('[data-ai-insert]');
  equal('M16 copy and insert receive exact code with no appended newline', [copied.at(-1), inserted.at(-1)], [['printf hello', 'bash'], ['printf hello', 'bash']]);
  render('```sh\nprintf first\nprintf second\n\n```'); click('[data-ai-copy-code]');
  equal('M17 copy preserves intentional blank lines without a structural extra LF', copied.at(-1), ['printf first\nprintf second\n', 'sh']);
  check('M18 unsafe multiline shell code is copyable without an insert control', !!host.querySelector('[data-ai-copy-code]') && !host.querySelector('[data-ai-insert]'));
  render('```python\nprint("hello")\n```');
  check('M19 parent policy can deny insertion by language', !host.querySelector('[data-ai-insert]') && !!host.querySelector('[data-ai-copy-code]'));
  render('```<img src=x onerror=alert(1)>\nplain\n```');
  check('M20 language information is displayed as text', host.querySelector('.ai-code-bar')?.textContent.includes('<img src=x onerror=alert(1)>') && !host.querySelector('img'));

  const fences = [
    ['```sh\necho x\n```', true], ['~~~sh\necho x\n~~~', true],
    ['```sh\necho x\n````', true], ['````sh\necho x\n```', false],
    ['```sh\necho x\n``` trailing', false], ['```sh\necho x\n~~~', false],
    ['```sh\necho x', false], ['```sh\necho x\n', false], ['```sh', false],
    ['> ```sh\n> echo x\n> ```', true], ['- item\n  ```sh\n  echo x\n  ```', true],
    ['> ```sh\n> echo x\n> ', false], ['> ```sh\n> echo x\n```', false],
    ['- ```sh\n  echo x\n```', false], ['```sh\necho x\n    ```', false],
    ['```sh\r\necho x\r\n```', true],
  ];
  for (const [markdown, closed] of fences) {
    render(markdown, { canInsertCode: () => true });
    check('M21 only a structurally closed fence can insert: ' + JSON.stringify(markdown), !!host.querySelector('[data-ai-insert]') === closed);
  }
  for (const [markdown, code] of [['```sh\necho partial', 'echo partial'], ['```sh\necho partial\n', 'echo partial\n']]) {
    render(markdown, { complete: false }); click('[data-ai-copy-code]');
    equal('M22 open streamed code copies its actual partial text', copied.at(-1), [code, 'sh']);
  }
  for (const complete of [false, undefined, 'true', 1]) {
    render('```sh\necho x\n```', { complete });
    check('M23 complete must be boolean true: ' + String(complete), !host.querySelector('[data-ai-insert]'));
  }
  render('```sh\necho x\n```', { canInsertCode: () => 1 });
  check('M24 parent permission must be exactly true', !host.querySelector('[data-ai-insert]'));
  render('```sh\necho x\n```', { canInsertCode: () => { throw new Error('policy unavailable'); } });
  check('M25 a policy error denies insertion without breaking rendering', !host.querySelector('[data-ai-insert]') && !!host.querySelector('pre code'));
  let allowed = true; const beforeRevoked = inserted.length;
  render('```sh\necho x\n```', { canInsertCode: () => allowed }); allowed = false; click('[data-ai-insert]');
  equal('M26 insertion permission is rechecked at click time', inserted.length, beforeRevoked);
  render('```sh\necho stale\n```');
  const staleCopy = host.querySelector('[data-ai-copy-code]'), staleInsert = host.querySelector('[data-ai-insert]');
  const beforeStale = [copied.length, inserted.length];
  render('replacement'); staleCopy.click(); staleInsert.click();
  equal('M27 removed controls cannot trigger stale callbacks', [copied.length, inserted.length], beforeStale);
  render('```sh\necho detached\n```');
  const detachedCopy = host.querySelector('[data-ai-copy-code]'), detachedInsert = host.querySelector('[data-ai-insert]');
  const beforeDetached = [copied.length, inserted.length]; host.remove(); detachedCopy.click(); detachedInsert.click();
  equal('M27 removing an entire message host invalidates both code actions', [copied.length, inserted.length], beforeDetached);
  d.body.append(host);
  render('    echo indented');
  check('M28 indented code remains copyable and conservatively has no terminal action', host.querySelector('pre code')?.textContent === 'echo indented' && !host.querySelector('[data-ai-insert]'));
  for (const partial of ['**partial', '[partial](https://', '`partial', '\ud83d', '```sh\nprintf \ud83d']) {
    check('M29 partial syntax and Unicode render without an exception: ' + JSON.stringify(partial), render(partial, { complete: false }) && !!host.textContent);
  }
  const fallback = '**raw** <img src=x>';
  w.markdownit = undefined;
  check('M30 a missing parser falls back to exact text', w.AiMarkdown.render(host, fallback) === false && host.textContent === fallback && !host.querySelector('strong,img'));
  w.markdownit = () => ({ parse() { throw new Error('fixture parse failure'); } });
  check('M31 a parser exception falls back to exact text', w.AiMarkdown.render(host, fallback) === false && host.textContent === fallback && !host.querySelector('strong,img'));
  w.markdownit = realParser; render('**restored**');
  check('M32 the real parser can recover after a failed render', host.querySelector('strong')?.textContent === 'restored');
  equal('M33 rendering never attempts remote resource loading', requests, []);
  equal('M34 no DOM/script errors occurred', errors, []);
  console.log(`\nRESULT ${passed} passed, 0 failed`);
} catch (error) { console.error('FAIL ' + (error.stack || error)); process.exitCode = 1; }
finally { dom.window.close(); }
