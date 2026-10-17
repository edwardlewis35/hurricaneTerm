/* hurricaneTerm — 图标集（内联 SVG，16×16 描边风格）
 * 原创代码 (Apache-2.0)。无外部图标字体依赖，离线可用。
 * 用法：Icons.svg('terminal') → '<svg class="ico" ...>…</svg>'
 *       Icons.el('terminal')   → SVGElement（需要挂事件时用）
 */
(function () {
  'use strict';

  // path 内容：viewBox 0 0 16 16，stroke 由 CSS 控制
  const P = {
    book: '<path d="M8 3.6C6.4 2.5 3.6 2.3 1.7 3v10c2-.7 4.7-.5 6.3.6 1.6-1.1 4.3-1.3 6.3-.6V3C12.4 2.3 9.6 2.5 8 3.6z"/><path d="M8 3.6v10"/>',
    sparkles: '<path d="m6 1.5 1.6 4.4L12 7.5l-4.4 1.6L6 13.5 4.4 9.1 0 7.5l4.4-1.6z"/><path d="m12.5 1 .7 1.8L15 3.5l-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7zM13 10l.7 1.8 1.8.7-1.8.7L13 15l-.7-1.8-1.8-.7 1.8-.7z"/>',
    terminal: '<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><polyline points="4.6 6.6 6.6 8.6 4.6 10.6"/><line x1="8.4" y1="10.8" x2="11.4" y2="10.8"/>',
    server: '<rect x="2" y="2.8" width="12" height="4.2" rx="1.2"/><rect x="2" y="9" width="12" height="4.2" rx="1.2"/><circle cx="4.6" cy="4.9" r=".55" fill="currentColor" stroke="none"/><circle cx="4.6" cy="11.1" r=".55" fill="currentColor" stroke="none"/>',
    folder: '<path d="M1.8 3h4.1l1.5 1.7h6.8V13H1.8z"/>',
    send: '<path d="M14.2 1.8 6.9 9.1"/><path d="M14.2 1.8 9.7 14.2 6.9 9.1 1.8 6.3z"/>',
    transfer: '<line x1="5" y1="13.4" x2="5" y2="4"/><polyline points="2.6 6.4 5 4 7.4 6.4"/><line x1="11" y1="2.6" x2="11" y2="12"/><polyline points="8.6 9.6 11 12 13.4 9.6"/>',
    output: '<line x1="2.8" y1="4" x2="13.2" y2="4"/><line x1="2.8" y1="8" x2="13.2" y2="8"/><line x1="2.8" y1="12" x2="9.2" y2="12"/>',
    gear: '<path d="m6.5 1.8-.4 1.6-1.2.7-1.6-.5-1.5 2.6L3 7.3v1.4l-1.2 1.1 1.5 2.6 1.6-.5 1.2.7.4 1.6h3l.4-1.6 1.2-.7 1.6.5 1.5-2.6L13 8.7V7.3l1.2-1.1-1.5-2.6-1.6.5-1.2-.7-.4-1.6z"/><circle cx="8" cy="8" r="2"/>',
    theme: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" stroke="none"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><line x1="10.3" y1="10.3" x2="14.2" y2="14.2"/>',
    plus: '<line x1="8" y1="3.2" x2="8" y2="12.8"/><line x1="3.2" y1="8" x2="12.8" y2="8"/>',
    x: '<line x1="4.2" y1="4.2" x2="11.8" y2="11.8"/><line x1="11.8" y1="4.2" x2="4.2" y2="11.8"/>',
    minimize: '<line x1="3" y1="8" x2="13" y2="8"/>',
    maximize: '<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.2"/>',
    restore: '<rect x="2.6" y="5" width="8" height="8" rx="1.2"/><path d="M5.4 5V3.8A1.2 1.2 0 0 1 6.6 2.6h5.6A1.2 1.2 0 0 1 13.4 3.8v5.6a1.2 1.2 0 0 1-1.2 1.2H11"/>',
    splitH: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.4"/><line x1="8" y1="3" x2="8" y2="13"/>',
    splitV: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.4"/><line x1="1.8" y1="8" x2="14.2" y2="8"/>',
    caret: '<polyline points="4.4 6.4 8 10 11.6 6.4"/>',
    pin: '<path d="M5.8 1.8h4.4l-.8 4.4 2.4 2.5H4.2l2.4-2.5z"/><line x1="8" y1="8.7" x2="8" y2="14.2"/>',
    bell: '<path d="M8 2.2a3.7 3.7 0 0 0-3.7 3.7c0 3.2-1.1 4.3-1.1 4.3h9.6s-1.1-1.1-1.1-4.3A3.7 3.7 0 0 0 8 2.2z"/><path d="M6.7 13.1a1.5 1.5 0 0 0 2.6 0"/>',
    home: '<path d="M2.2 7.4 8 2.6l5.8 4.8"/><path d="M3.8 6.8v6.8h8.4V6.8"/>',
    copy: '<rect x="5.4" y="5.4" width="8.4" height="8.4" rx="1.4"/><path d="M11.2 5.4V3.6A1.4 1.4 0 0 0 9.8 2.2H3.6A1.4 1.4 0 0 0 2.2 3.6v6.2a1.4 1.4 0 0 0 1.4 1.4h1.8"/>',
    trash: '<line x1="3" y1="4.6" x2="13" y2="4.6"/><path d="M6.4 4.6V3.2h3.2v1.4"/><path d="M4.4 4.6l.7 8.6h5.8l.7-8.6"/>',
    tunnel: '<path d="M6.4 9.6 9.6 6.4"/><path d="M8.2 4.4 10 2.6a2.7 2.7 0 0 1 3.8 3.8L12 8.2"/><path d="M7.8 11.6 6 13.4a2.7 2.7 0 0 1-3.8-3.8L4 7.8"/>',
    refresh: '<polyline points="13.4 3.4 13.4 7.2 9.6 7.2"/><path d="M12.6 9.4A5 5 0 1 1 11.4 4.4l2 2.8"/>',
    up: '<polyline points="4.4 9.6 8 6 11.6 9.6"/>',
    down: '<polyline points="4.4 6.4 8 10 11.6 6.4"/>',
    arrowUp: '<line x1="8" y1="13" x2="8" y2="3.4"/><polyline points="4.6 6.8 8 3.4 11.4 6.8"/>',
    arrowDown: '<line x1="8" y1="3" x2="8" y2="12.6"/><polyline points="4.6 9.2 8 12.6 11.4 9.2"/>',
    arrowLeft: '<line x1="13" y1="8" x2="3" y2="8"/><polyline points="6.5 4.5 3 8 6.5 11.5"/>',
    arrowRight: '<line x1="3" y1="8" x2="13" y2="8"/><polyline points="9.5 4.5 13 8 9.5 11.5"/>',
    star: '<path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5l-3.8 2.1.7-4.3-3.1-3 4.3-.6z"/>',
    pause: '<line x1="5.5" y1="3" x2="5.5" y2="13"/><line x1="10.5" y1="3" x2="10.5" y2="13"/>',
    play: '<path d="m5 2.8 8 5.2-8 5.2z"/>',
    zoomIn: '<circle cx="7" cy="7" r="4.5"/><line x1="10.3" y1="10.3" x2="14.2" y2="14.2"/><line x1="5" y1="7" x2="9" y2="7"/><line x1="7" y1="5" x2="7" y2="9"/>',
    zoomOut: '<circle cx="7" cy="7" r="4.5"/><line x1="10.3" y1="10.3" x2="14.2" y2="14.2"/><line x1="5" y1="7" x2="9" y2="7"/>',
    keyboard: '<rect x="1.6" y="4.2" width="12.8" height="7.6" rx="1.4"/><line x1="4.2" y1="6.6" x2="4.2" y2="6.6"/><line x1="6.6" y1="6.6" x2="6.6" y2="6.6"/><line x1="9" y1="6.6" x2="9" y2="6.6"/><line x1="11.4" y1="6.6" x2="11.4" y2="6.6"/><line x1="5.4" y1="9.4" x2="10.6" y2="9.4"/>',
    palette: '<circle cx="8" cy="8" r="6.2"/><circle cx="5.6" cy="6" r=".9" fill="currentColor" stroke="none"/><circle cx="8" cy="4.8" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="6" r=".9" fill="currentColor" stroke="none"/><path d="M8 14.2a2.2 2.2 0 0 1 0-4.4h1.6a1.8 1.8 0 0 0 0-3.6"/>',
    info: '<circle cx="8" cy="8" r="6.2"/><line x1="8" y1="7.2" x2="8" y2="11.4"/><circle cx="8" cy="4.9" r=".7" fill="currentColor" stroke="none"/>',
    lock: '<rect x="3.4" y="7" width="9.2" height="6.4" rx="1.3"/><path d="M5.6 7V5a2.4 2.4 0 0 1 4.8 0v2"/>',
    telnet: '<circle cx="8" cy="8" r="2"/><path d="M4.4 4.4a5 5 0 0 0 0 7.2M11.6 4.4a5 5 0 0 1 0 7.2M2.2 2.2a8.2 8.2 0 0 0 0 11.6M13.8 2.2a8.2 8.2 0 0 1 0 11.6"/>',
    serial: '<rect x="1.8" y="5" width="12.4" height="6" rx="1.6"/><circle cx="4.8" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="11.2" cy="8" r=".8"/>',
    globe: '<circle cx="8" cy="8" r="6.2"/><line x1="1.8" y1="8" x2="14.2" y2="8"/><path d="M8 1.8a10 10 0 0 1 0 12.4 10 10 0 0 1 0-12.4z"/>',
    plug: '<path d="M6 1.8v4M10 1.8v4"/><path d="M4 5.8h8v2.4a4 4 0 0 1-4 4 4 4 0 0 1-4-4z"/><line x1="8" y1="12.2" x2="8" y2="14.4"/>',
  };

  function svg(name, cls) {
    const body = P[name];
    if (!body) return '';
    return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  }

  // 需要挂事件时用：返回真实元素
  function el(name, cls) {
    const tpl = document.createElement('template');
    tpl.innerHTML = svg(name, cls).trim();
    return tpl.content.firstElementChild;
  }

  function has(name) { return Object.prototype.hasOwnProperty.call(P, name); }

  window.Icons = { svg, el, has, names: () => Object.keys(P) };
})();
