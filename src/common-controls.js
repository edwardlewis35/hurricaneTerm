/* Theme-aware single-select controls. Native selects remain the form/command data source. */
(function () {
  'use strict';
  const states = new WeakMap();
  let opened = null, nextId = 0;

  function attr(el, name, value) {
    if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
    else if (el.getAttribute(name) !== String(value)) el.setAttribute(name, value);
  }
  function allowed(option) {
    return !option.disabled && !option.hidden && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);
  }
  function visible(state) {
    return state.select.isConnected && !state.select.closest('[hidden]') && !state.select.disabled;
  }
  function labelFor(select) {
    if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
    const labels = Array.from(select.labels || []).map(l => {
      const clone = l.cloneNode(true); clone.querySelectorAll('select, .wt-select').forEach(el => el.remove());
      return clone.textContent.trim();
    }).filter(Boolean);
    if (labels.length) return labels.join(' ');
    const field = select.closest('.ht-pm-field, .st-row');
    return field?.querySelector('.st-t, .st-l > b, :scope > span')?.textContent.trim() || select.title || '选择选项';
  }
  function sync(state) {
    const { select, button, text, wrapper } = state;
    const selected = select.options[select.selectedIndex];
    const value = selected?.label || selected?.textContent || '请选择';
    if (text.textContent !== value) text.textContent = value;
    button.disabled = select.disabled;
    wrapper.hidden = select.hidden;
    attr(button, 'aria-label', labelFor(select));
    attr(button, 'aria-labelledby', select.getAttribute('aria-labelledby'));
    attr(button, 'aria-describedby', select.getAttribute('aria-describedby'));
    attr(button, 'aria-required', select.required ? 'true' : null);
    attr(button, 'title', select.title || null);
    if (opened === state) {
      if (!visible(state)) close();
      else renderMenu(state);
    }
  }
  function close(restoreFocus = false) {
    const state = opened;
    if (!state) return;
    opened = null;
    state.menu?.remove(); state.menu = null;
    state.wrapper.classList.remove('is-open');
    attr(state.button, 'aria-expanded', 'false');
    attr(state.button, 'aria-activedescendant', null);
    state.search = '';
    if (restoreFocus && state.button.isConnected && !state.button.disabled) state.button.focus();
  }
  function position(state) {
    if (!state.menu || !visible(state)) { close(); return; }
    const rect = state.button.getBoundingClientRect();
    const width = Math.max(160, rect.width);
    state.menu.style.width = Math.min(width, Math.max(80, window.innerWidth - 16)) + 'px';
    state.menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + 'px';
    const below = window.innerHeight - rect.bottom - 12, above = rect.top - 12;
    const upwards = below < 160 && above > below;
    const available = upwards ? above : below;
    state.menu.style.maxHeight = Math.max(48, Math.min(288, available)) + 'px';
    state.menu.style.top = upwards ? 'auto' : Math.max(8, rect.bottom + 5) + 'px';
    state.menu.style.bottom = upwards ? Math.max(8, window.innerHeight - rect.top + 5) + 'px' : 'auto';
  }
  function highlight(state, index, scroll = true) {
    const rows = Array.from(state.menu?.querySelectorAll('[role="option"]') || []);
    state.active = index;
    for (const row of rows) row.classList.toggle('is-active', Number(row.dataset.index) === index);
    const row = rows.find(r => Number(r.dataset.index) === index);
    attr(state.button, 'aria-activedescendant', row?.id || null);
    if (scroll && row) row.scrollIntoView?.({ block: 'nearest' });
  }
  function choose(state, index) {
    const option = state.select.options[index];
    if (!option || !allowed(option)) return;
    const changed = state.select.selectedIndex !== index;
    state.select.selectedIndex = index;
    close(true);
    sync(state);
    if (changed) {
      // Preserve existing listeners and form collectors without duplicating business logic.
      state.select.dispatchEvent(new Event('input', { bubbles: true }));
      state.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function renderMenu(state) {
    if (!state.menu) return;
    const menu = state.menu;
    menu.replaceChildren();
    let group = null;
    for (let i = 0; i < state.select.options.length; i++) {
      const option = state.select.options[i];
      if (option.hidden || option.parentElement?.hidden) continue;
      const parent = option.parentElement;
      if (parent?.tagName === 'OPTGROUP' && parent !== group) {
        const heading = document.createElement('div'); heading.className = 'wt-select-group';
        heading.textContent = parent.label; heading.setAttribute('role', 'presentation'); menu.appendChild(heading);
      }
      group = parent;
      const row = document.createElement('div');
      row.className = 'wt-select-option'; row.id = state.id + '-option-' + i; row.dataset.index = i;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === state.select.selectedIndex));
      row.setAttribute('aria-disabled', String(!allowed(option)));
      const text = document.createElement('span'); text.textContent = option.label || option.textContent;
      const check = document.createElement('span'); check.className = 'wt-select-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      row.append(text, check);
      row.addEventListener('pointermove', () => { if (allowed(option)) highlight(state, i, false); });
      row.addEventListener('pointerdown', e => e.preventDefault());
      row.addEventListener('click', e => { e.stopPropagation(); choose(state, i); });
      menu.appendChild(row);
    }
    const indices = enabledIndices(state);
    highlight(state, indices.includes(state.active) ? state.active : indices.includes(state.select.selectedIndex) ? state.select.selectedIndex : indices[0] ?? -1);
    position(state);
  }
  function enabledIndices(state) {
    return Array.from(state.select.options).map((o, i) => allowed(o) && !o.parentElement?.hidden ? i : -1).filter(i => i >= 0);
  }
  function open(state) {
    if (!visible(state)) return;
    close(); sync(state);
    const menu = document.createElement('div');
    menu.id = state.id + '-list'; menu.className = 'wt-select-menu'; menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', labelFor(state.select));
    menu.addEventListener('contextmenu', e => e.preventDefault());
    document.body.appendChild(menu);
    state.menu = menu; state.active = state.select.selectedIndex; opened = state;
    state.wrapper.classList.add('is-open'); attr(state.button, 'aria-expanded', 'true');
    renderMenu(state);
  }
  function move(state, direction) {
    const indices = enabledIndices(state), at = indices.indexOf(state.active);
    if (!indices.length) return;
    highlight(state, indices[Math.max(0, Math.min(indices.length - 1, at + direction))]);
  }
  function keydown(state, e) {
    if (e.ctrlKey || e.metaKey || e.altKey && !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    if (e.key === 'Tab') { if (opened === state) close(); return; }
    if (e.key === 'Escape') {
      if (opened !== state) return;
      e.preventDefault(); e.stopPropagation(); close(true); return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      const wasOpen = opened === state;
      if (!wasOpen) open(state);
      else if (e.key === 'Enter' || e.key === ' ') { choose(state, state.active); return; }
      if (e.key === 'Home' || e.key === 'End') {
        const indices = enabledIndices(state); highlight(state, indices[e.key === 'Home' ? 0 : indices.length - 1] ?? -1);
      } else if (wasOpen && e.key === 'ArrowDown') move(state, 1);
      else if (wasOpen && e.key === 'ArrowUp') move(state, -1);
      return;
    }
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      if (opened !== state) open(state);
      const now = Date.now();
      state.search = now - state.searchAt > 700 ? e.key : state.search + e.key; state.searchAt = now;
      const repeating = Array.from(state.search).every(c => c === state.search[0]);
      const query = (repeating ? e.key : state.search).toLocaleLowerCase();
      const indices = enabledIndices(state), at = indices.indexOf(state.active);
      const start = repeating ? at + 1 : at;
      for (let n = 0; n < indices.length; n++) {
        const i = indices[(Math.max(0, start) + n) % indices.length];
        if ((state.select.options[i].label || state.select.options[i].textContent).trim().toLocaleLowerCase().startsWith(query)) { highlight(state, i); break; }
      }
    }
  }
  function enhance(select) {
    if (states.has(select) || select.multiple || select.size > 1 || select.hasAttribute('data-native-select') || select.closest('.xterm')) return;
    const wrapper = document.createElement('span'); wrapper.className = 'wt-select';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'wt-select-trigger';
    const text = document.createElement('span'); text.className = 'wt-select-value';
    const arrow = document.createElement('span'); arrow.className = 'wt-select-arrow'; arrow.setAttribute('aria-hidden', 'true');
    arrow.innerHTML = window.Icons ? Icons.svg('caret') : '⌄';
    button.append(text, arrow);
    const id = 'wt-select-' + (++nextId);
    button.setAttribute('role', 'combobox'); button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id + '-list');
    select.before(wrapper); wrapper.append(select, button);
    select.classList.add('wt-select-native'); select.setAttribute('aria-hidden', 'true'); select.tabIndex = -1;
    const state = { select, wrapper, button, text, id, menu: null, active: -1, search: '', searchAt: 0 };
    states.set(select, state);
    button.addEventListener('click', e => { e.stopPropagation(); opened === state ? close() : open(state); });
    button.addEventListener('keydown', e => keydown(state, e));
    button.addEventListener('focus', () => sync(state));
    button.addEventListener('blur', e => { if (opened === state && !state.menu?.contains(e.relatedTarget)) close(); });
    select.addEventListener('change', () => sync(state)); select.addEventListener('input', () => sync(state));
    select.addEventListener('focus', () => button.focus());
    sync(state);
  }
  function scan(root) {
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.matches?.('select')) enhance(root);
    root.querySelectorAll('select').forEach(enhance);
  }
  const observer = new MutationObserver(records => {
    const dirty = new Set();
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      // Terminal output and this control's own render must not trigger document rescans.
      if (target?.closest('.xterm, .wt-select-trigger, .wt-select-menu')) continue;
      // Only real selects/options and newly inserted UI matter. Generated label changes are ignored.
      const select = target?.matches('select') ? target : target?.closest('select');
      if (select) dirty.add(select);
      if (record.type === 'childList') for (const node of record.addedNodes) scan(node);
    }
    for (const select of dirty) { enhance(select); const state = states.get(select); if (state) sync(state); }
    if (opened && !visible(opened)) close();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'label', 'value', 'hidden', 'aria-label', 'aria-labelledby', 'aria-describedby', 'title', 'required'] });
  document.addEventListener('pointerdown', e => { if (opened && !opened.wrapper.contains(e.target) && !opened.menu?.contains(e.target)) close(); }, true);
  // Escape is handled before the SFTP / profiles modal shortcuts can close the outer panel.
  document.addEventListener('keydown', e => { if (opened && e.key === 'Escape') keydown(opened, e); }, true);
  // One delegated reset listener avoids retaining removed fields on long-lived forms.
  document.addEventListener('reset', e => queueMicrotask(() => {
    e.target.querySelectorAll('select').forEach(select => { const state = states.get(select); if (state) sync(state); });
  }), true);
  window.addEventListener('resize', () => { if (opened) position(opened); });
  window.addEventListener('scroll', e => { if (opened && !opened.menu?.contains(e.target)) position(opened); }, true);
  scan(document);
  window.CommonControls = { refresh(root = document) { scan(root); const own = states.get(root); if (own) sync(own); root.querySelectorAll?.('select').forEach(select => { const s = states.get(select); if (s) sync(s); }); }, close, get isOpen() { return !!opened; } };
})();
