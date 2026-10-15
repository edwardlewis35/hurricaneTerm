/* Background transparency: paint surfaces with alpha, keep text and controls opaque. */
(function () {
  'use strict';
  const T = window.WT;
  function percentage(value = T.s.backgroundOpacity) {
    const number = Number(value);
    return Math.max(20, Math.min(100, Number.isFinite(number) ? Math.round(number) : 100));
  }
  function terminalPercentage(value = T.s.terminalOpacity ?? T.s.backgroundOpacity) { return percentage(value); }
  function alpha(color, value = T.s.backgroundOpacity) {
    const opacity = percentage(value) / 100;
    if (opacity === 1) return color;
    const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.exec(String(color).trim());
    if (hex) {
      const digits = hex[1].length <= 4 ? hex[1].split('').map(c => c + c).join('') : hex[1];
      const n = parseInt(digits.slice(0, 6), 16), baseAlpha = digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1;
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity * baseAlpha})`;
    }
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([.\d]+))?\s*\)$/i.exec(String(color).trim());
    if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${opacity * Number(rgb[4] ?? 1)})`;
    return color;
  }
  function terminalTheme(theme) { return { ...theme, background: alpha(theme.background, terminalPercentage()) }; }
  function syncTerminal(tab, baseTheme = T.term?.THEMES?.[T.s.theme]?.term) {
    if (tab._closing || !baseTheme) return;
    const theme = terminalTheme(baseTheme);
    // xterm's DOM renderer normally paints its viewport. That viewport is transparent
    // in our layout, so paint the full-size wrapper once, including its padding and
    // unused rows. Never add the UI background below this layer or fade its text.
    if (tab.wrap) tab.wrap.style.backgroundColor = theme.background;
    if (tab.term) tab.term.options.theme = theme;
  }
  function isNative() { return typeof window.__TAURI__?.window?.getCurrentWindow === 'function'; }
  function apply() {
    T.s.backgroundOpacity = percentage();
    T.s.terminalOpacity = terminalPercentage();
    const root = document.documentElement, styles = getComputedStyle(root);
    for (const [derived, base] of [['--window-bg', '--bg'], ['--window-panel-bg', '--bg2'], ['--window-title-bg', '--bg3']]) {
      const color = root.style.getPropertyValue(base).trim() || styles.getPropertyValue(base).trim();
      if (color) root.style.setProperty(derived, alpha(color));
    }
    const terminalBackground = T.term?.THEMES?.[T.s.theme]?.term?.background
      || root.style.getPropertyValue('--term-bg').trim() || styles.getPropertyValue('--term-bg').trim();
    if (terminalBackground) root.style.setProperty('--window-term-bg', alpha(terminalBackground, T.s.terminalOpacity));
    root.dataset.backgroundOpacity = String(T.s.backgroundOpacity);
    root.dataset.terminalBackgroundOpacity = String(T.s.terminalOpacity);
    root.classList.toggle('transparency-preview', !isNative() && (T.s.backgroundOpacity < 100 || T.s.terminalOpacity < 100));
    const baseTheme = T.term?.THEMES?.[T.s.theme]?.term;
    if (baseTheme) for (const tab of Object.values(T.term.tabs || {})) {
      syncTerminal(tab, baseTheme);
    }
    for (const output of document.querySelectorAll('[data-opacity-value]')) output.textContent = T.s.backgroundOpacity + '%';
    for (const output of document.querySelectorAll('[data-terminal-opacity-value]')) output.textContent = T.s.terminalOpacity + '%';
  }
  function setOpacity(value, { persist = true } = {}) {
    T.s.backgroundOpacity = percentage(value); apply();
    if (persist) T.persistSettings();
  }
  function setTerminalOpacity(value, { persist = true } = {}) {
    T.s.terminalOpacity = terminalPercentage(value); apply();
    if (persist) T.persistSettings();
  }
  window.Appearance = { alpha, terminalTheme, syncTerminal, apply, setOpacity, setTerminalOpacity, percentage, terminalPercentage, isNative };
})();
