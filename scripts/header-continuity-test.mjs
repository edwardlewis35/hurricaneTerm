// Production CSS contract for the two adjacent header rows. JSDOM does not
// perform layout; actual 0..40 / 40..78 geometry is verified in the browser.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';

const source = fileURLToPath(new URL('../src/', import.meta.url));
const html = readFileSync(source + 'index.html', 'utf8');
const css = readFileSync(source + 'style.css', 'utf8');
const tabbar = readFileSync(source + 'tabbar.js', 'utf8');
const appearance = readFileSync(source + 'appearance.js', 'utf8');
let passed = 0;
const errors = [];
for (const width of [720, 1180]) for (const status of [false, true])
for (const opacity of [40, 100]) for (const count of [0, 18]) {
  const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, d = w.document;
  try {
    Object.defineProperty(w, 'innerWidth', { value: width });
    const styles = d.createElement('style'); styles.textContent = css; d.head.appendChild(styles);
    d.body.classList.toggle('no-status', !status);
    w.WT = { s: { backgroundOpacity: opacity, terminalOpacity: opacity, theme: 'tabby-dark' },
      persistSettings() {}, term: { order: [], tabs: {}, active: null, THEMES: { 'tabby-dark': { term: { background: '#171717' } } } } };
    for (let i = 0; i < count; i++) {
      const id = 'header-' + i; w.WT.term.order.push(id);
      w.WT.term.tabs[id] = { title: '标签 ' + i, session: { protocol: 'local' } };
    }
    w.WT.term.active = count ? 'header-0' : null;
    w.eval(appearance); w.Appearance.apply(); w.eval(tabbar); w.TabBar.mount(d.querySelector('#tabbar'));
    // Include a Windows/Linux control so its height contract is covered alongside tabs.
    const control = d.createElement('div'); control.className = 'wc'; d.querySelector('#tb-winctl').appendChild(control);
    const header = w.getComputedStyle(d.querySelector('#titlebar'));
    const toolbar = w.getComputedStyle(d.querySelector('#actbar'));
    const body = w.getComputedStyle(d.body), root = w.getComputedStyle(d.documentElement);
    assert.equal(body.rowGap, '0px', 'grid must not insert a gap between the header rows');
    assert.equal(root.getPropertyValue('--titlebar-h').trim(), '40px');
    assert.equal(root.getPropertyValue('--toolrow-h').trim(), '38px');
    assert.equal(header.borderBottomWidth, '0px', 'no full-width bright seam below the tab row');
    assert.equal(header.marginBottom, '0px'); assert.equal(header.paddingBottom, '0px');
    assert.ok(!toolbar.borderTopWidth || toolbar.borderTopWidth === '0px', 'toolbar must not add a second seam');
    // JSDOM cannot expand border color var(); inspect its parsed production rule.
    const toolbarRule = Array.from(styles.sheet.cssRules).find(rule => rule.selectorText === '#actbar');
    assert.equal(toolbarRule.style.getPropertyValue('border-bottom'), '1px solid var(--border)', 'workspace separator remains below the second row');
    assert.equal(w.getComputedStyle(d.querySelector('.ht-tabbar')).height, '100%', 'tabbar inherits the exact row content height');
    assert.equal(w.getComputedStyle(d.querySelector('.ht-tabs')).height, '100%');
    for (const tab of d.querySelectorAll('.ht-tab, .ht-brand')) assert.equal(w.getComputedStyle(tab).height, '100%');
    if (!count) {
      const brand = w.getComputedStyle(d.querySelector('.ht-brand'));
      assert.equal(brand.flexGrow, '1', 'empty-row brand must paint all available tab-slot width');
      assert.equal(brand.width, '100%', 'no fixed 160px brand inside the 180px empty slot');
    }
    assert.equal(w.getComputedStyle(control).height, '100%');
    assert.equal(d.querySelector('#titlebar').nextElementSibling.id, 'actbar');
    assert.equal(d.querySelector('#actbar').nextElementSibling.id, 'workspace');
    assert.equal(w.getComputedStyle(d.querySelector('#statusbar')).display === 'none', !status);
    assert.equal(d.documentElement.dataset.backgroundOpacity, String(opacity));
    passed++;
    console.log(`PASS header CSS: width=${width}, status=${status}, opacity=${opacity}, tabs=${count}`);
  } finally { w.TabBar?.dispose(); dom.window.close(); }
}
assert.equal(errors.length, 0, errors.join('\n'));
console.log(`\nRESULT ${passed} header configurations passed, ${errors.length} JavaScript errors`);
