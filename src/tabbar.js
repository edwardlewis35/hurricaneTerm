/* hurricaneTerm — Tabby 风格「窗口级标签栏」组件
 * 原创代码 (Apache-2.0)，UI 形态参考 Tabby，未复制其代码。
 *
 * 导出：window.TabBar = { mount(el), render() }
 *   mount(el)  把全局标签条渲染进给定容器（父层建 #tabbar 置于工作区顶部）
 *   render()   从 T.term.order / T.term.tabs / T.term.active 全量重绘
 *
 * 数据字段（父层补充）：tab.pinned / tab.activity / tab.notify / tab.color / tab.exited / tab.session
 * 依赖 T.term 新方法（父层稍后实现；缺失时 typeof 守卫 + toast「未接线」）：
 *   moveTab(id, toIndex)        —— 契约：先从 order 移除 id，再插入到剩余数组的 toIndex 处
 *   splitActive(dir)            —— dir: 'right' | 'left' | 'down' | 'up'
 *   closeOthers(id) closeRight(id) closeLeft(id)
 *   togglePin(id) toggleNotify(id) setTabColor(id, color|null) renameTab(id, title)
 *   duplicate(id) newLocal() openHome()
 * 另调用：T.term.activate(id) close(id) create(session)（已存在）；
 *         Profiles.edit(session) / Profiles.openManager()（T.Profiles 或 window.Profiles，typeof 守卫）
 */
(function () {
  'use strict';
  const T = window.WT;

  /* ---------- 常量 ---------- */
  const ICONS = { '': '▣', local: '▣', ssh: '🔒', telnet: '📡', serial: '🔌', tcp: '🌐' };
  const COLORS = ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#ff8f40', '#d070b0'];

  /* 注意：不用 CSS 作变量名，避免遮蔽全局 CSS 命名空间（CSS.escape） */
  const STYLE_TEXT = `
.ht-tabbar { display:flex; align-items:stretch; height:34px; background:var(--bg2); border-bottom:1px solid var(--border); user-select:none; font-size:12px; }
.ht-tabs { display:flex; align-items:stretch; flex:1 1 auto; min-width:0; overflow-x:auto; overflow-y:hidden; scrollbar-width:none; }
.ht-tabs::-webkit-scrollbar { display:none; }
.ht-tab { position:relative; display:flex; align-items:center; gap:5px; flex:0 1 auto; min-width:96px; max-width:180px;
  padding:0 6px 0 11px; cursor:default; color:var(--fg2); background:var(--bg2); border-right:1px solid var(--border); }
.ht-tab::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--htc, transparent); }
.ht-tab:hover { background:var(--bg3); color:var(--fg); }
.ht-tab.ht-active { background:var(--bg3); color:var(--fg); box-shadow:inset 0 2px 0 var(--accent); }
.ht-tab.ht-exited .ht-title { text-decoration:line-through; opacity:.6; }
.ht-ico { flex:0 0 auto; font-size:11px; opacity:.85; }
.ht-title { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ht-dot { flex:0 0 auto; width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 5px var(--accent); }
.ht-pin { flex:0 0 auto; font-size:10px; opacity:.85; }
.ht-x { flex:0 0 auto; width:16px; height:16px; line-height:15px; text-align:center; border-radius:3px; opacity:0; color:var(--fg2); }
.ht-tab:hover .ht-x, .ht-tab.ht-active .ht-x { opacity:.7; }
.ht-x:hover { background:rgba(224,108,117,.28); color:#e06c75; opacity:1; }
.ht-tab.ht-dragging { opacity:.4; }
.ht-tab.ht-drop-l { box-shadow:inset 2px 0 0 var(--accent); }
.ht-tab.ht-drop-r { box-shadow:inset -2px 0 0 var(--accent); }
.ht-tab input.ht-rename { flex:1 1 auto; min-width:0; background:var(--bg); color:var(--fg); border:1px solid var(--accent);
  border-radius:3px; padding:1px 4px; font:inherit; }
.ht-actions { display:flex; align-items:center; gap:2px; flex:0 0 auto; padding:0 6px; border-left:1px solid var(--border); }
.ht-plus, .ht-caret { display:flex; align-items:center; justify-content:center; border-radius:4px; cursor:default; color:var(--fg2); }
.ht-plus { width:26px; height:24px; font-size:15px; }
.ht-caret { width:18px; height:24px; font-size:9px; }
.ht-plus:hover, .ht-caret:hover { background:var(--bg3); color:var(--fg); }
.ht-tabbar .ht-toast { position:fixed; top:40px; right:14px; z-index:400; background:var(--bg3); border:1px solid var(--accent);
  color:var(--fg); padding:6px 12px; border-radius:6px; font-size:12px; box-shadow:0 6px 20px rgba(0,0,0,.4);
  animation: ht-in .15s ease-out; }
@keyframes ht-in { from { opacity:0; transform:translateY(-4px); } }
.ht-menu { position:fixed; z-index:300; min-width:190px; background:var(--bg3); border:1px solid var(--border); border-radius:6px;
  box-shadow:0 8px 28px rgba(0,0,0,.5); padding:4px 0; font-size:12.5px; color:var(--fg); user-select:none; }
.ht-menu .mi { display:flex; align-items:center; gap:8px; padding:5px 12px; cursor:default; position:relative; }
.ht-menu .mi:hover { background:var(--accent); color:#08131a; }
.ht-menu .mi.danger:hover { background:#e06c75; color:#fff; }
.ht-menu .mi .chk { flex:0 0 auto; width:13px; text-align:center; }
.ht-menu .mi .mic { flex:0 0 auto; width:16px; text-align:center; font-size:11px; }
.ht-menu .mi .lab { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ht-menu .mi .arrow { flex:0 0 auto; opacity:.6; font-size:10px; }
.ht-menu .sep { height:1px; background:var(--border); margin:4px 0; }
.ht-menu .head { padding:5px 12px 3px; font-size:11px; opacity:.65; }
.ht-menu .mi.dis { opacity:.5; }
.ht-menu .mi.sub .subbody { display:none; position:absolute; left:100%; top:-5px; }
.ht-menu .mi.sub:hover .subbody { display:block; }
.ht-menu .swatches { display:flex; align-items:center; gap:5px; padding:5px 12px 7px; }
.ht-menu .sw { width:16px; height:16px; border-radius:4px; border:1px solid rgba(128,128,128,.4); cursor:default; }
.ht-menu .sw:hover { transform:scale(1.18); }
.ht-menu .sw.sel { outline:2px solid var(--fg); outline-offset:1px; }
.ht-menu .sw.clear { display:flex; align-items:center; justify-content:center; background:transparent; color:var(--fg2); font-size:12px; }
.ht-menu .sw.clear:hover { color:#e06c75; }
`;

  /* ---------- 状态 ---------- */
  let root = null, tabsEl = null;
  let dragId = null;
  let menuEl = null;
  let selfToastTimer = null;

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/[^A-Za-z0-9_-]/g, (ch) => '\\' + ch);
  }

  /* ---------- 小工具 ---------- */
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
    if (!root) return;
    let el = root.querySelector('.ht-toast');
    if (!el) { el = document.createElement('div'); el.className = 'ht-toast'; root.appendChild(el); }
    el.textContent = msg;
    clearTimeout(selfToastTimer);
    selfToastTimer = setTimeout(() => el.remove(), 2400);
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
    if (P && typeof P[name] === 'function') { try { P[name].apply(P, args); return true; } catch (e) {} }
    toast('未接线：Profiles.' + name);
    return false;
  }

  function protoIcon(session) {
    const p = ((session && session.protocol) || '').toLowerCase();
    return ICONS[p] || '▣';
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
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);
    return m;
  }

  function mi(menu, opt) {
    const d = document.createElement('div');
    d.className = 'mi' + (opt.danger ? ' danger' : '') + (opt.submenu ? ' sub' : '') + (opt.disabled ? ' dis' : '');
    const chk = document.createElement('span'); chk.className = 'chk';
    chk.textContent = opt.checked ? '✓' : '';
    d.appendChild(chk);
    if (opt.icon) { const ic = document.createElement('span'); ic.className = 'mic'; ic.textContent = opt.icon; d.appendChild(ic); }
    const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = opt.label;
    d.appendChild(lab);
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
      mi(m, { label: '重命名', onClick: () => startInlineRename(id) });
      mhead(m, '颜色');
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
      mi(m, { label: '复制标签', onClick: () => call('duplicate', id) });
      mi(m, { label: '分屏', submenu: [
        { label: '右侧', onClick: () => call('splitActive', 'right') },
        { label: '左侧', onClick: () => call('splitActive', 'left') },
        { label: '下方', onClick: () => call('splitActive', 'down') },
        { label: '上方', onClick: () => call('splitActive', 'up') },
      ] });
      if (ids.length > 1) {
        mi(m, { label: '关闭其他', onClick: () => call('closeOthers', id) });
        if (idx < ids.length - 1) mi(m, { label: '关闭右侧', onClick: () => call('closeRight', id) });
        if (idx > 0) mi(m, { label: '关闭左侧', onClick: () => call('closeLeft', id) });
      }
      msep(m);
      mi(m, { label: '固定标签', checked: !!tab.pinned, onClick: () => call('togglePin', id) });
      mi(m, { label: '活动时通知', checked: !!tab.notify, onClick: () => call('toggleNotify', id) });
      msep(m);
      mi(m, { label: '另存为机器', onClick: () => callProfiles('edit', tab.session) });
      mi(m, { label: tab.exited ? '关闭标签' : '断开', danger: true, onClick: () => callExisting('close', id) });
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
    if (tab.color) el.style.setProperty('--htc', tab.color);

    const ico = document.createElement('span'); ico.className = 'ht-ico'; ico.textContent = protoIcon(tab.session);
    const title = document.createElement('span'); title.className = 'ht-title'; title.textContent = tab.title || '';
    el.append(ico, title);
    if (tab.activity) { const dot = document.createElement('span'); dot.className = 'ht-dot'; dot.title = '有活动'; el.appendChild(dot); }
    if (tab.pinned) { const pin = document.createElement('span'); pin.className = 'ht-pin'; pin.textContent = '📌'; el.appendChild(pin); }
    const x = document.createElement('span'); x.className = 'ht-x'; x.textContent = '×'; x.title = '关闭';
    x.addEventListener('click', (e) => { e.stopPropagation(); callExisting('close', id); });
    el.appendChild(x);

    el.addEventListener('click', (e) => { if (e.button === 0) callExisting('activate', id); });
    el.addEventListener('dblclick', () => startInlineRename(id));
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); callExisting('close', id); }
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
          icon: protoIcon(s),
          label: s.name || s.host || s.target || '未命名机器',
          onClick: () => callExisting('create', s),
        });
      }
    }
    msep(m);
    mi(m, { label: '添加机器…', onClick: () => callProfiles('openManager') });
    mi(m, { label: '打开主页', onClick: () => call('openHome') });
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!tabsEl) return;
    const activeId = T.term ? T.term.active : null;
    tabsEl.textContent = '';
    for (const id of displayOrder()) tabsEl.appendChild(tabEl(id));
    if (activeId) {
      const act = tabsEl.querySelector('.ht-tab[data-id="' + cssEscape(activeId) + '"]');
      if (act) requestAnimationFrame(() => act.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
  }

  function mount(el) {
    // 幂等：同一容器重复 mount 直接复用（防 boot 双触发产生双实例）
    if (root && el && root.parentNode === el) { render(); return; }
    ensureStyle();
    root = document.createElement('div');
    root.className = 'ht-tabbar';

    tabsEl = document.createElement('div');
    tabsEl.className = 'ht-tabs';
    tabsEl.addEventListener('dragover', (e) => e.preventDefault());
    tabsEl.addEventListener('drop', (e) => { /* 落到尾部空白 → 移到末尾 */
      e.preventDefault();
      if (!dragId) return;
      const base = (T.term.order || []).filter((x) => x !== dragId && T.term.tabs[x]);
      const from = dragId; dragId = null; clearDropMarks();
      call('moveTab', from, base.length);
    });
    tabsEl.addEventListener('contextmenu', (e) => { /* 空白区右键：给「新建本地」快捷入口 */
      if (e.target !== tabsEl) return;
      e.preventDefault();
      openMenu(e.clientX, e.clientY, (m) => {
        mi(m, { label: '新建本地会话', icon: '▣', onClick: () => call('newLocal') });
        mi(m, { label: '打开主页', onClick: () => call('openHome') });
      });
    });

    const actions = document.createElement('div');
    actions.className = 'ht-actions';
    const plus = document.createElement('div');
    plus.className = 'ht-plus'; plus.textContent = '＋'; plus.title = '新建本地会话';
    plus.addEventListener('click', () => call('newLocal'));
    const caret = document.createElement('div');
    caret.className = 'ht-caret'; caret.textContent = '▾'; caret.title = '最近机器 / 添加机器';
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = caret.getBoundingClientRect();
      openMenu(r.left - 120, r.bottom + 2, buildPlusMenu);
    });
    actions.append(plus, caret);

    root.append(tabsEl, actions);
    el.appendChild(root);
    render();
  }

  window.TabBar = { mount, render };
})();
