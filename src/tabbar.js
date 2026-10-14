/* hurricaneTerm — tabbar.js：Tabby 风格「窗口级标签栏」
 * 原创代码 (Apache-2.0)，UI 形态参考 Tabby，未复制其代码。
 *
 * 0.7.0 改版：标签栏内嵌无边框标题栏；圆角无边框标签，活动标签底色与终端区连成一体；
 *            emoji 图标换成内联 SVG；浮层菜单样式上移到 style.css 统一管理。
 *
 * 导出：window.TabBar = { mount(el), render() }
 *   mount(el)  渲染进给定容器（父层把 #tabbar 放在 #titlebar 内）
 *   render()   从 T.term.order / T.term.tabs / T.term.active 全量重绘
 *
 * 数据字段（父层补充）：tab.pinned / tab.activity / tab.notify / tab.color / tab.exited / tab.session
 * 依赖 T.term：moveTab(id,toIndex) splitActive(dir) closeOthers/closeRight/closeLeft(id)
 *              togglePin/toggleNotify/setTabColor/renameTab(id,…) duplicate(id) newLocal() openHome()
 *              activate(id) close(id) create(session)
 * 以及 Profiles.edit(session) / Profiles.openManager()（T.Profiles 或 window.Profiles）
 */
(function () {
  'use strict';
  const T = window.WT;

  /* ---------- 常量 ---------- */
  // 协议 → icons.js 里的图标名
  const ICONS = { '': 'terminal', local: 'terminal', ssh: 'lock', telnet: 'telnet', serial: 'serial', tcp: 'globe' };
  // 标签色板：取自 Tabby 上游 theme.vars.scss 的 $theme-colors / 基础色
  const COLORS = ['#d9534f', '#f0ad4e', '#ffd500', '#5cb85c', '#5bc0de', '#0275d8', '#4fadff', '#ff5b77', '#613d7c'];

  const STYLE_TEXT = `
.ht-tabbar { display:flex; align-items:stretch; flex:1 1 auto; width:100%; min-width:0; height:var(--titlebar-h);
  user-select:none; font-size:12.5px; }
.ht-tabs { position:relative; display:flex; align-items:stretch; flex:1 1 auto; min-width:0; height:100%;
  overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
.ht-tabs::-webkit-scrollbar { display:none; }
.ht-brand { display:flex; align-items:center; gap:9px; flex:0 0 160px; padding:0 16px; height:100%; color:var(--fg3);
  font-size:12.5px; white-space:nowrap; user-select:none; border-radius:0; background:var(--bg); }
.ht-brand b { color:var(--fg3); font-weight:600; }
.ht-brand i { color:var(--accent); font-style:normal; font-weight:700; }

.ht-tab { position:relative; display:flex; align-items:center; gap:9px; flex:0 0 var(--ht-tab-width, 180px);
  min-width:0; height:var(--titlebar-h);
  padding:0 10px 0 15px; cursor:default; color:var(--fg2); background:transparent;
  border-radius:0; border-right:1px solid var(--border); transition:background .12s ease, color .12s ease; }
.ht-tab:hover { background:var(--surface-hover); color:var(--fg3); }
.ht-tab.ht-active { background:var(--term-bg, var(--bg)); color:var(--fg3); }
.ht-tab.ht-active::after { content:''; position:absolute; left:0; right:0; bottom:0; height:2px;
  background:var(--htc, var(--accent)); }
.ht-tab.ht-exited .ht-title { text-decoration:line-through; opacity:.55; }
.ht-ico { flex:0 0 auto; width:15px; display:flex; align-items:center; justify-content:center; color:var(--fg2); }
.ht-ico svg { width:var(--ico-tab, 12px); height:var(--ico-tab, 12px); stroke-width:1.5; }
.ht-tab.ht-active .ht-ico { color:var(--htc, var(--accent)); }
.ht-title { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ht-dot { flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 6px var(--accent); }
.ht-pin { flex:0 0 auto; width:12px; display:flex; align-items:center; color:var(--fg2); }
.ht-pin svg { width:11px; height:11px; }
.ht-x { flex:0 0 auto; width:17px; height:17px; display:flex; align-items:center; justify-content:center;
  border-radius:var(--r-sm); opacity:0; color:var(--fg2); transition:opacity .1s, background .1s; }
.ht-x svg { width:9px; height:9px; stroke-width:1.8; }
.ht-tab:hover .ht-x, .ht-tab.ht-active .ht-x { opacity:.75; }
.ht-x:hover { background:var(--danger-bg); color:var(--danger); opacity:1; }
.ht-tab.ht-dragging { opacity:.35; }
.ht-tab.ht-drop-l { box-shadow:inset 2px 0 0 var(--accent); }
.ht-tab.ht-drop-r { box-shadow:inset -2px 0 0 var(--accent); }
.ht-tab input.ht-rename { flex:1 1 auto; min-width:0; background:var(--input-bg); color:var(--fg3);
  border:1px solid var(--accent); border-radius:var(--r-sm); padding:0 4px; height:19px; font:inherit; }

.ht-actions { display:flex; align-items:center; gap:0; flex:0 0 auto; height:100%; padding:0 4px; }
.ht-plus, .ht-caret, .ht-split { display:flex; align-items:center; justify-content:center; border-radius:var(--r);
  cursor:default; color:var(--fg2); transition:var(--t); }
.ht-plus { width:30px; height:30px; }
.ht-caret { width:30px; height:30px; }
.ht-split { width:30px; height:30px; margin-left:4px; }
.ht-actions button { padding:0; border:0; background:transparent; color:var(--fg2); }
.ht-plus svg, .ht-caret svg, .ht-split svg { width:var(--ico-titlebar, 16px); height:var(--ico-titlebar, 16px); }
.ht-plus:hover, .ht-caret:hover, .ht-split:hover { background:var(--surface-hover); color:var(--fg3); }
`;

  /* ---------- 状态 ---------- */
  let root = null, tabsEl = null;
  let dragId = null;
  let menuEl = null, menuBindTimer = null;
  let resizeObserver = null, resizeListener = null, revealFrame = null, lastActive = null, lastOrder = [];
  const MAX_TAB_WIDTH = 180, MIN_TAB_WIDTH = 110;


  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/[^A-Za-z0-9_-]/g, (ch) => '\\' + ch);
  }
  function svg(name) { return window.Icons ? window.Icons.svg(name) : ''; }

  function ensureStyle() {
    if (document.getElementById('ht-tabbar-style')) return;
    const s = document.createElement('style');
    s.id = 'ht-tabbar-style';
    s.textContent = STYLE_TEXT;
    document.head.appendChild(s);
  }

  function toast(msg) {
    const U = window.UI;
    if (U && typeof U.toast === 'function') { U.toast(msg); return; }
    console.warn('[tabbar]', msg);
  }

  /* 调用父层将实现的 T.term 方法；缺失时守卫 + 提示 */
  function call(name, ...args) {
    const term = T && T.term;
    const f = term && term[name];
    if (typeof f === 'function') {
      try { f.apply(term, args); return true; } catch (e) { toast('调用失败：' + name); return false; }
    }
    toast('未接线：' + name);
    return false;
  }

  /* 已存在方法的守卫式调用（activate/close/create） */
  function callExisting(name, ...args) {
    const term = T && T.term;
    const f = term && term[name];
    if (typeof f === 'function') { try { f.apply(term, args); return true; } catch (e) {} }
    toast('未接线：' + name);
    return false;
  }

  function callProfiles(name, ...args) {
    const P = (T && T.Profiles) || window.Profiles;
    if (P && typeof P[name] === 'function') {
      if (window.SftpPanel && SftpPanel.isOpen() && SftpPanel.hide() === false) return false;
      if (T.ui) T.ui.closeDock();
      if (window.Settings && Settings.isOpen()) Settings.close();
      try { P[name].apply(P, args); return true; } catch (e) {}
    }
    toast('未接线：Profiles.' + name);
    return false;
  }

  function protoIcon(session) {
    const p = ((session && session.protocol) || '').toLowerCase();
    return ICONS[p] || ICONS[''];
  }

  function displayOrder() {
    const term = T.term;
    const ids = (term.order || []).filter((id) => term.tabs[id]);
    const pinned = ids.filter((id) => term.tabs[id].pinned);
    const rest = ids.filter((id) => !term.tabs[id].pinned);
    return pinned.concat(rest);
  }

  /* ---------- 浮层菜单（自建 DOM，点击别处 / Esc 关闭） ---------- */
  function closeMenu() {
    clearTimeout(menuBindTimer); menuBindTimer = null;
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  function onDocKey(e) { if (e.key === 'Escape') { closeMenu(); e.stopPropagation(); } }

  function openMenu(x, y, build) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'ht-menu';
    document.body.appendChild(m);
    build(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(2, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(2, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
    menuEl = m;
    menuBindTimer = setTimeout(() => {
      menuBindTimer = null;
      if (menuEl !== m) return;
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);
    return m;
  }

  /* opt: { label, svg?, checked?, danger?, disabled?, key?, submenu?, onClick? } */
  function mi(menu, opt) {
    const d = document.createElement('div');
    d.className = 'mi' + (opt.danger ? ' danger' : '') + (opt.submenu ? ' sub' : '') + (opt.disabled ? ' dis' : '');
    const chk = document.createElement('span'); chk.className = 'chk';
    chk.textContent = opt.checked ? '✓' : '';
    d.appendChild(chk);
    if (opt.svg) {
      const ic = document.createElement('span'); ic.className = 'mic'; ic.innerHTML = svg(opt.svg);
      d.appendChild(ic);
    }
    const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = opt.label;
    d.appendChild(lab);
    if (opt.key) { const k = document.createElement('span'); k.className = 'key'; k.textContent = opt.key; d.appendChild(k); }
    if (opt.submenu) {
      const a = document.createElement('span'); a.className = 'arrow'; a.textContent = '▸';
      d.appendChild(a);
      const body = document.createElement('div'); body.className = 'subbody ht-menu';
      for (const sub of opt.submenu) mi(body, sub);
      d.appendChild(body);
    }
    if (opt.onClick && !opt.disabled) {
      d.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); opt.onClick(); });
    }
    menu.appendChild(d);
    return d;
  }
  function msep(menu) { const s = document.createElement('div'); s.className = 'sep'; menu.appendChild(s); }
  function mhead(menu, text) { const h = document.createElement('div'); h.className = 'head'; h.textContent = text; menu.appendChild(h); }

  /* ---------- 右键菜单（Tabby 菜单集） ---------- */
  function tabMenu(id, x, y) {
    const tab = T.term.tabs[id];
    if (!tab) return;
    const ids = displayOrder();
    const idx = ids.indexOf(id);
    openMenu(x, y, (m) => {
      mi(m, { label: '重命名', svg: 'output', onClick: () => startInlineRename(id) });
      mi(m, { label: '复制标签', svg: 'copy', onClick: () => call('duplicate', id) });
      mi(m, { label: '分屏', svg: 'splitH', submenu: [
        { label: '向右分屏', key: 'Ctrl+Shift+E', onClick: () => call('splitActive', 'right') },
        { label: '向左分屏', onClick: () => call('splitActive', 'left') },
        { label: '向下分屏', key: 'Ctrl+Shift+D', onClick: () => call('splitActive', 'down') },
        { label: '向上分屏', onClick: () => call('splitActive', 'up') },
      ] });
      msep(m);
      mhead(m, '标签颜色');
      const swrap = document.createElement('div'); swrap.className = 'swatches';
      for (const c of COLORS) {
        const s = document.createElement('div'); s.className = 'sw' + (tab.color === c ? ' sel' : '');
        s.style.background = c; s.title = c;
        s.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); call('setTabColor', id, c); });
        swrap.appendChild(s);
      }
      const clr = document.createElement('div'); clr.className = 'sw clear'; clr.textContent = '✕'; clr.title = '清除颜色';
      clr.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); call('setTabColor', id, null); });
      swrap.appendChild(clr);
      m.appendChild(swrap);
      msep(m);
      if (ids.length > 1) {
        mi(m, { label: '关闭其他标签', onClick: () => call('closeOthers', id) });
        if (idx < ids.length - 1) mi(m, { label: '关闭右侧标签', onClick: () => call('closeRight', id) });
        if (idx > 0) mi(m, { label: '关闭左侧标签', onClick: () => call('closeLeft', id) });
        msep(m);
      }
      mi(m, { label: '固定标签', svg: 'pin', checked: !!tab.pinned, onClick: () => call('togglePin', id) });
      mi(m, { label: '活动时通知', svg: 'bell', checked: !!tab.notify, onClick: () => call('toggleNotify', id) });
      msep(m);
      mi(m, { label: '另存为机器', svg: 'server', onClick: () => callProfiles('edit', tab.session) });
      mi(m, { label: tab.exited ? '关闭标签' : '断开连接', svg: 'x', danger: true, key: 'Ctrl+W', onClick: () => callExisting('close', id) });
    });
  }

  /* ---------- 行内重命名（输入框替换标题；Enter 提交 / Esc 取消） ---------- */
  function startInlineRename(id) {
    const tab = T.term.tabs[id];
    const el = tabsEl && tabsEl.querySelector('.ht-tab[data-id="' + cssEscape(id) + '"]');
    if (!tab || !el) return;
    const title = el.querySelector('.ht-title');
    if (!title) return;
    const input = document.createElement('input');
    input.className = 'ht-rename';
    input.value = tab.title || '';
    el.replaceChild(input, title);
    input.focus(); input.select();
    let done = false;
    const restore = () => { if (input.parentNode) el.replaceChild(title, input); };
    const commit = () => {
      if (done) return; done = true;
      const v = input.value.trim();
      restore();
      if (v && v !== tab.title) call('renameTab', id, v.slice(0, 28));
      else render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.removeEventListener('blur', commit); commit(); }
      else if (e.key === 'Escape') { done = true; input.removeEventListener('blur', commit); restore(); }
    });
    input.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  /* ---------- 拖拽排序 ---------- */
  function clearDropMarks() {
    if (!tabsEl) return;
    for (const el of tabsEl.querySelectorAll('.ht-drop-l, .ht-drop-r')) {
      el.classList.remove('ht-drop-l', 'ht-drop-r');
    }
  }
  /* moveTab 契约：先从 order 移除 dragId，再插入到剩余数组的返回下标处 */
  function dropIndex(dragId, dropId, after) {
    const base = (T.term.order || []).filter((x) => x !== dragId && T.term.tabs[x]);
    const i = base.indexOf(dropId);
    return i < 0 ? base.length : (after ? i + 1 : i);
  }

  /* ---------- 标签 DOM ---------- */
  function tabEl(id) {
    const tab = T.term.tabs[id];
    const el = document.createElement('div');
    el.className = 'ht-tab'
      + (id === T.term.active ? ' ht-active' : '')
      + (tab.exited ? ' ht-exited' : '');
    el.dataset.id = id;
    el.draggable = true;
    el.title = tab.title || '';
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(id === T.term.active));
    el.tabIndex = id === T.term.active ? 0 : -1;
    if (tab.color) el.style.setProperty('--htc', tab.color);

    const ico = document.createElement('span'); ico.className = 'ht-ico'; ico.innerHTML = svg(protoIcon(tab.session));
    const title = document.createElement('span'); title.className = 'ht-title'; title.textContent = tab.title || '';
    el.append(ico, title);
    if (tab.activity && T.s.activityDot !== false) {
      const dot = document.createElement('span'); dot.className = 'ht-dot'; dot.title = '有活动'; el.appendChild(dot);
    }
    if (tab.pinned) {
      const pin = document.createElement('span'); pin.className = 'ht-pin';
      pin.innerHTML = svg('pin'); pin.title = '已固定'; el.appendChild(pin);
    }
    const x = document.createElement('span'); x.className = 'ht-x'; x.innerHTML = svg('x'); x.title = '关闭';
    x.addEventListener('click', (e) => { e.stopPropagation(); callExisting('close', id); });
    el.appendChild(x);

    el.addEventListener('click', (e) => { if (e.button === 0) callExisting('activate', id); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); callExisting('activate', id); }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const ids = displayOrder();
        const next = e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1]
          : ids[(ids.indexOf(id) + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
        callExisting('activate', next, false);
        const target = tabsEl.querySelector('[data-id="' + cssEscape(next) + '"]');
        if (target) target.focus({ preventScroll: true });
        revealActive();
      }
    });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); startInlineRename(id); });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); callExisting('close', id); }
      // 阻止标题栏拖拽吞掉标签上的按下事件
      e.stopPropagation();
    });
    el.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      tabMenu(id, e.clientX, e.clientY);
    });

    /* HTML5 拖拽 */
    el.addEventListener('dragstart', (e) => {
      dragId = id;
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('ht-dragging');
    });
    el.addEventListener('dragend', () => {
      dragId = null; clearDropMarks(); el.classList.remove('ht-dragging');
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      if (!dragId || dragId === id) { clearDropMarks(); return; }
      const r = el.getBoundingClientRect();
      clearDropMarks();
      el.classList.add(e.clientX < r.left + r.width / 2 ? 'ht-drop-l' : 'ht-drop-r');
    });
    el.addEventListener('dragleave', () => el.classList.remove('ht-drop-l', 'ht-drop-r'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!dragId || dragId === id) { clearDropMarks(); return; }
      const r = el.getBoundingClientRect();
      const after = e.clientX >= r.left + r.width / 2;
      const from = dragId;
      dragId = null; clearDropMarks();
      call('moveTab', from, dropIndex(from, id, after));
    });
    return el;
  }

  /* ---------- 无标签时的品牌位（同时也是拖拽区） ---------- */
  function brandEl() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ht-brand';
    b.innerHTML = svg('home') + '<span>开始</span>';
    b.title = '打开主页';
    b.addEventListener('click', () => call('openHome'));
    return b;
  }

  /* ---------- 「＋」区（新建 + 下拉：最近机器 / 添加机器 / 打开主页） ---------- */
  function buildPlusMenu(m) {
    mhead(m, '最近使用的机器');
    const list = ((T.s && T.s.sessions) || [])
      .filter((s) => s && s.lastUsed)
      .sort((a, b) => ((b.lastUsed || 0) > (a.lastUsed || 0)) ? 1 : -1)
      .slice(0, 10);
    if (!list.length) {
      mi(m, { label: '（暂无最近机器）', disabled: true });
    } else {
      for (const s of list) {
        mi(m, {
          svg: protoIcon(s),
          label: s.name || s.host || s.target || '未命名机器',
          onClick: () => callExisting('create', s),
        });
      }
    }
    msep(m);
    mi(m, { label: '新建本地会话', svg: 'terminal', key: 'Ctrl+T', onClick: () => call('newLocal') });
    mi(m, { label: '添加机器…', svg: 'server', key: 'Ctrl+M', onClick: () => callProfiles('openManager') });
    mi(m, { label: '打开主页', svg: 'home', onClick: () => call('openHome') });
  }

  /* ---------- 渲染 ---------- */
  function revealActive() {
    if (revealFrame !== null) cancelAnimationFrame(revealFrame);
    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      const activeId = T.term && T.term.active;
      const act = activeId && tabsEl && tabsEl.querySelector('.ht-tab[data-id="' + cssEscape(activeId) + '"]');
      if (!act) return;
      // Scroll this row only. scrollIntoView can also move Home/Settings in WebKit.
      const view = tabsEl.getBoundingClientRect(), box = act.getBoundingClientRect();
      const delta = box.left < view.left ? box.left - view.left : box.right > view.right ? box.right - view.right : 0;
      tabsEl.scrollLeft = Math.max(0, tabsEl.scrollLeft + delta);
    });
  }

  function layout() {
    if (!root || !root.parentElement) return;
    const host = root.parentElement, bar = host.parentElement;
    const count = Math.max(1, displayOrder().length);
    const actions = root.querySelector('.ht-actions');
    const actionWidth = actions ? actions.getBoundingClientRect().width : 0;
    // The titlebar's fixed controls always retain their space; the tab row alone scrolls.
    const siblings = Array.from(bar.children).filter(el => el !== host);
    const occupied = siblings.reduce((sum, el) => sum + (el.classList.contains('tb-drag-fill') ? 24 : el.getBoundingClientRect().width), 0);
    const available = Math.max(0, bar.clientWidth - occupied);
    const forTabs = Math.max(0, available - actionWidth);
    const width = Math.max(MIN_TAB_WIDTH, Math.min(MAX_TAB_WIDTH, Math.floor(forTabs / count)));
    root.style.setProperty('--ht-tab-width', width + 'px');
    host.style.width = Math.min(available, count * width + actionWidth) + 'px';
  }

  function dispose() {
    closeMenu();
    if (resizeObserver) resizeObserver.disconnect();
    if (resizeListener) window.removeEventListener('resize', resizeListener);
    if (revealFrame !== null) cancelAnimationFrame(revealFrame);
    if (root) root.remove();
    root = tabsEl = resizeObserver = resizeListener = null;
    revealFrame = null; lastActive = null; lastOrder = []; dragId = null;
  }

  function render() {
    if (!tabsEl) return;
    const activeId = T.term ? T.term.active : null;
    const scroll = tabsEl.scrollLeft;
    tabsEl.textContent = '';
    const ids = displayOrder();
    if (!ids.length) tabsEl.appendChild(brandEl());
    for (const id of ids) tabsEl.appendChild(tabEl(id));
    layout();
    tabsEl.scrollLeft = scroll;
    const moved = ids.length !== lastOrder.length || ids.some((id, index) => id !== lastOrder[index]);
    if (lastActive !== activeId || moved) revealActive();
    lastActive = activeId; lastOrder = ids;
    // 主区窗口标题跟随活动标签
    try {
      const t = activeId && T.term.tabs[activeId];
      document.title = t && t.title ? `${t.title} — hurricaneTerm` : 'hurricaneTerm';
    } catch (e) {}
  }

  function mount(el) {
    // 幂等：同一容器重复 mount 直接复用（防 boot 双触发产生双实例）
    if (root && el && root.parentNode === el) { render(); return; }
    dispose();
    ensureStyle();
    root = document.createElement('div');
    root.className = 'ht-tabbar';

    tabsEl = document.createElement('div');
    tabsEl.className = 'ht-tabs';
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.setAttribute('aria-label', '终端标签');
    tabsEl.addEventListener('wheel', (e) => {
      if (e.ctrlKey || tabsEl.scrollWidth <= tabsEl.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      const multiplier = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tabsEl.clientWidth : 1;
      tabsEl.scrollLeft = Math.max(0, Math.min(tabsEl.scrollWidth - tabsEl.clientWidth, tabsEl.scrollLeft + delta * multiplier));
    }, { passive: false });
    tabsEl.addEventListener('dragover', (e) => e.preventDefault());
    tabsEl.addEventListener('drop', (e) => { /* 落到尾部空白 → 移到末尾 */
      e.preventDefault();
      if (!dragId) return;
      const base = (T.term.order || []).filter((x) => x !== dragId && T.term.tabs[x]);
      const from = dragId; dragId = null; clearDropMarks();
      call('moveTab', from, base.length);
    });
    tabsEl.addEventListener('contextmenu', (e) => { /* 空白区右键：新建入口 */
      if (e.target.closest('.ht-tab')) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, (m) => {
        mi(m, { label: '新建本地会话', svg: 'terminal', key: 'Ctrl+T', onClick: () => call('newLocal') });
        mi(m, { label: '添加机器…', svg: 'server', key: 'Ctrl+M', onClick: () => callProfiles('openManager') });
        mi(m, { label: '打开主页', svg: 'home', onClick: () => call('openHome') });
      });
    });

    const actions = document.createElement('div');
    actions.className = 'ht-actions';
    const plus = document.createElement('button'); plus.type = 'button';
    plus.className = 'ht-plus'; plus.innerHTML = svg('plus'); plus.title = '新建本地会话 (Ctrl+T)';
    plus.setAttribute('aria-label', '新建标签页');
    plus.addEventListener('click', (e) => { e.stopPropagation(); call('newLocal'); });
    const caret = document.createElement('button'); caret.type = 'button';
    caret.className = 'ht-caret'; caret.innerHTML = svg('caret'); caret.title = '最近机器 / 添加机器';
    caret.setAttribute('aria-label', '选择连接');
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = caret.getBoundingClientRect();
      openMenu(r.left, r.bottom + 2, buildPlusMenu);
    });
    const split = document.createElement('button'); split.type = 'button';
    split.className = 'ht-split'; split.innerHTML = svg('splitH'); split.title = '分屏';
    split.setAttribute('aria-label', '分屏');
    split.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = split.getBoundingClientRect();
      openMenu(r.left, r.bottom + 2, (m) => {
        mi(m, { label: '向右分屏', svg: 'splitH', key: 'Ctrl+Shift+E', onClick: () => call('splitActive', 'right') });
        mi(m, { label: '向下分屏', svg: 'splitV', key: 'Ctrl+Shift+D', onClick: () => call('splitActive', 'down') });
        mi(m, { label: '取消分屏', onClick: () => call('unsplit') });
      });
    });
    actions.append(plus, caret, split);

    root.append(tabsEl, actions);
    el.appendChild(root);
    const onResize = () => { layout(); revealActive(); };
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(el.parentElement);
    } else {
      resizeListener = onResize; window.addEventListener('resize', resizeListener);
    }
    render();
  }

  window.TabBar = {
    mount,
    render,
    dispose,
    revealActive,
    closeMenu,
    menuOpen: () => !!menuEl,
    // 对外暴露的浮层菜单：build(m, mi, msep, mhead)，供侧栏/状态栏复用同一套样式与交互
    openMenu: (x, y, build) => openMenu(x, y, (m) => build(m, mi, msep, mhead)),
    renameActive: () => { const id = T.term && T.term.active; if (id) startInlineRename(id); },
  };
})();
