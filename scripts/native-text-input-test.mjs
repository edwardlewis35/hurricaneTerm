import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const native = readFileSync(new URL('../src-tauri/src/mac_text_input.rs', import.meta.url), 'utf8');
const script = native.match(/const WEBVIEW_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
assert.ok(script, 'test the production document-start script');
const dom = new JSDOM('<!doctype html><html><body><input id="command" value="sudo ABC"><textarea id="prompt">MiXeD</textarea><div id="editor" contenteditable="true">输入法</div></body></html>', { runScripts: 'dangerously', pretendToBeVisual: true });
const { window: w } = dom;
const d = w.document;
const flush = async () => { await new Promise(resolve => w.setTimeout(resolve, 0)); };
let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log(`PASS ${label}`); };
const literal = element => ['autocapitalize', 'autocorrect', 'spellcheck'].map(name => element.getAttribute(name)).join('|') === 'none|off|false';
w.eval(script);
check('initial command, AI prompt and editable content use literal input', [...d.querySelectorAll('input,textarea,[contenteditable]')].every(literal));
check('initial values and editable text are preserved', d.querySelector('#command').value === 'sudo ABC' && d.querySelector('#prompt').value === 'MiXeD' && d.querySelector('#editor').textContent === '输入法');
const wrapper = d.createElement('section');
wrapper.innerHTML = '<input value="MiXeD" autocorrect="on"><textarea></textarea><div contenteditable=""></div>';
d.body.appendChild(wrapper);
await flush();
check('dynamically added nested controls receive the policy', [...wrapper.children].every(literal));
const command = d.querySelector('#command');
command.setAttribute('autocorrect', 'on');
command.setAttribute('autocapitalize', 'sentences');
command.setAttribute('spellcheck', 'true');
await flush();
check('later app attribute changes cannot reenable correction', literal(command));
const editor = d.createElement('div'); d.body.appendChild(editor); await flush();
editor.setAttribute('contenteditable', 'true'); await flush();
check('existing element becoming editable receives the policy', literal(editor));
let mutations = 0;
const observer = new w.MutationObserver(records => { mutations += records.length; });
observer.observe(d, { attributes: true, subtree: true });
w.eval(script); await flush();
check('duplicate initialization is idempotent', mutations === 0);
command.focus(); command.setSelectionRange(2, 6);
command.dispatchEvent(new w.FocusEvent('focusin', { bubbles: true }));
check('focus preserves typed value and selected text', command.value === 'sudo ABC' && command.selectionStart === 2 && command.selectionEnd === 6);
for (const type of ['keydown', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend']) {
  const event = new w.Event(type, { bubbles: true, cancelable: true });
  check(`${type} remains available for terminal and IME`, command.dispatchEvent(event) && !event.defaultPrevented);
}
await flush(); const settled = mutations; await flush();
check('observer settles without self-triggered attribute loops', mutations === settled);
observer.disconnect(); dom.window.close();
const beforeParse = new JSDOM('<!doctype html><html><body><input value="literal ABC"><textarea>输入法</textarea></body></html>', {
  runScripts: 'dangerously', beforeParse(window) { window.eval(script); }
});
await new Promise(resolve => beforeParse.window.setTimeout(resolve, 0));
check('document-start installation covers the later HTML root and parsed controls', literal(beforeParse.window.document.documentElement) && [...beforeParse.window.document.querySelectorAll('input,textarea')].every(literal));
beforeParse.window.close();
console.log(`${checks} passed / 0 failed (DOM behavior; native macOS text services still need GUI verification)`);
