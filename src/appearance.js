/* Background transparency: paint surfaces with alpha, keep text and controls opaque. */
(function () {
  'use strict';
  const T = window.WT;
  function percentage(value = T.s.backgroundOpacity) {
    const number = Number(value);
    return Math.max(20, Math.min(100, Number.isFinite(number) ? Math.round(number) : 100));
  }
  function alpha(color) {
    const opacity = percentage() / 100;
    if (opacity === 1) return color;
    const hex = /^#([\da-f]{3}|[\da-f]{6})(?:[\da-f]{2})?$/i.exec(String(color).trim());
    if (hex) {
      const digits = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
      const n = parseInt(digits, 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
    }
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([.\d]+))?\s*\)$/i.exec(String(color).trim());
    if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${opacity * Number(rgb[4] ?? 1)})`;
    return color;
  }
  function terminalTheme(theme) { return { ...theme, background: alpha(theme.background) }; }
  function isNative() { return typeof window.__TAURI__?.window?.getCurrentWindow === 'function'; }
  function apply() {
    T.s.backgroundOpacity = percentage();
    const root = document.documentElement, styles = getComputedStyle(root);
    for (const [derived, base] of [['--window-bg', '--bg'], ['--window-panel-bg', '--bg2'], ['--window-title-bg', '--bg3'], ['--window-term-bg', '--term-bg']]) {
      const color = root.style.getPropertyValue(base).trim() || styles.getPropertyValue(base).trim();
      if (color) root.style.setProperty(derived, alpha(color));
    }
    root.dataset.backgroundOpacity = String(T.s.backgroundOpacity);
    root.classList.toggle('transparency-preview', !isNative() && T.s.backgroundOpacity < 100);
    const baseTheme = T.term?.THEMES?.[T.s.theme]?.term;
    if (baseTheme) for (const tab of Object.values(T.term.tabs || {})) {
      if (!tab._closing && tab.term) tab.term.options.theme = terminalTheme(baseTheme);
    }
    for (const output of document.querySelectorAll('[data-opacity-value]')) output.textContent = T.s.backgroundOpacity + '%';
  }
  function setOpacity(value, { persist = true } = {}) {
    T.s.backgroundOpacity = percentage(value); apply();
    if (persist) T.persistSettings();
  }
  window.Appearance = { alpha, terminalTheme, apply, setOpacity, percentage, isNative };
})();
