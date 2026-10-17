/* hurricaneTerm — settings.js：全页设置面板（Tabby 的 Config 页形态）
 * 原创代码 (Apache-2.0)。左导航 + 右内容，取代 0.6.0 的 <dialog> 弹窗
 * （#dlg-session / #dlg-triggers / #dlg-about 已删除）。
 *
 * 导出：window.Settings = { mount(el), open(section?), close(), toggle(), isOpen(),
 *                          render(), cycleLightDark() }
 * 依赖：window.WT（core.js）、window.Icons、T.term.THEMES、window.Profiles（可选）
 */
(function () {
  'use strict';

  const T = window.WT;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { try { if (window.UI && window.UI.toast) window.UI.toast(m, 2200, k); } catch (_) {} };

  const SECTIONS = [
    { id: 'appearance', icon: 'palette', label: '外观' },
    { id: 'terminal', icon: 'terminal', label: '终端' },
    { id: 'profiles', icon: 'server', label: '机器与连接' },
    { id: 'gist', icon: 'refresh', label: 'Gist 同步' },
    { id: 'triggers', icon: 'bell', label: '触发器' },
    { id: 'hotkeys', icon: 'keyboard', label: '快捷键' },
    { id: 'about', icon: 'info', label: '关于' },
  ];

  // 触发器动作：与后端 main.rs v0_to_trigger 的实际映射严格一致（其余值会被降级为 highlight）
  const TRIGGER_ACTIONS = [['highlight', '高亮行'], ['bell', '响铃'], ['send', '发送文本']];

  const FONT_FAMILIES = [
    ['', '默认（Source Code Pro / JetBrains Mono）'],
    ['Source Code Pro', 'Source Code Pro'],
    ['JetBrains Mono', 'JetBrains Mono'],
    ['Menlo', 'Menlo (macOS)'],
    ['Consolas', 'Consolas (Windows)'],
    ['monospace', '系统等宽'],
  ];

  let el = null, navEl = null, bodyEl = null;
  let section = 'appearance';
  let mounted = false, open = false;

  /* ---------- 亮度：判断主题深浅，供「切换深浅色」用 ---------- */
  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  }
  function isLightTheme(name) {
    const th = T.term.THEMES[name];
    return !!(th && th.term && luminance(th.term.background) > 0.5);
  }

  /* ---------- 小组件 ---------- */
  function row(label, desc, controlHtml) {
    return `<div class="st-row"><div class="st-l"><b>${esc(label)}</b>${desc ? `<i>${esc(desc)}</i>` : ''}</div>
      <div class="st-c">${controlHtml}</div></div>`;
  }
  function toggle(key, on) {
    return `<button class="sw-toggle${on ? ' on' : ''}" data-toggle="${key}" role="switch" aria-checked="${!!on}"></button>`;
  }
  function card(title, inner) {
    return `<div class="st-card">${title ? `<h4>${esc(title)}</h4>` : ''}${inner}</div>`;
  }

  /* ---------- 各分区渲染 ---------- */
  function renderAppearance() {
    const themes = Object.keys(T.term.THEMES);
    const cur = T.s.theme;
    let grid = '<div class="st-themes">';
    for (const n of themes) {
      const t = T.term.THEMES[n].term;
      const dots = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan]
        .map((c) => `<i style="background:${esc(c)}"></i>`).join('');
      grid += `<div class="st-theme${n === cur ? ' on' : ''}" data-theme="${esc(n)}" title="应用主题 ${esc(n)}">
        <div class="prev" style="background:${esc(t.background)};color:${esc(t.foreground)}">${dots}<span>~/</span></div>
        <div class="nm">${esc(n)}</div></div>`;
    }
    grid += '</div>';

    let h = `<h2 class="st-h">外观</h2><p class="st-sub">主题、字号与窗口元素显隐。</p>`;
    h += card('主题', grid);
    const opacity = window.Appearance ? Appearance.percentage() : 100;
    const terminalOpacity = window.Appearance ? Appearance.terminalPercentage() : 100;
    h += card('背景透明度', row('界面背景不透明度', '标题栏、主页与设置等界面背景；文字和图标保持清晰。',
      `<div class="st-opacity-control"><input type="range" min="20" max="100" step="1" value="${opacity}" data-opacity aria-label="界面背景不透明度"><output data-opacity-value>${opacity}%</output></div>`)
      + `<div class="st-opacity-preview"><div class="st-opacity-sample">hurricaneTerm · 界面预览</div></div>`
      + row('终端背景不透明度', '单独调整全部终端的背景。100% 为实色，不影响文字和光标。',
        `<div class="st-opacity-control"><input type="range" min="20" max="100" step="1" value="${terminalOpacity}" data-terminal-opacity aria-label="终端背景不透明度"><output data-terminal-opacity-value>${terminalOpacity}%</output></div>`)
      + `<div class="st-opacity-preview"><div class="st-opacity-sample st-terminal-opacity-sample">$ echo Huricano<br>Huricano · 终端预览</div></div><p class="st-opacity-note">${window.Appearance?.isNative() ? '降低不透明度会透出窗口背后的内容。' : '浏览器使用棋盘背景预览透明度；桌面版会透出窗口背后的内容。'}</p>`);
    h += card('字号与状态栏',
      row('终端字号', '也可用 Ctrl+= / Ctrl+- 调整，范围 8–28',
        `<input type="number" min="8" max="28" step="1" data-num="fontSize" value="${esc(T.s.fontSize)}" style="width:78px">`)
      + row('底部状态栏', '显示终端尺寸、编码、输入模式与主题', toggle('statusBar', T.s.statusBar !== false))
      + row('工具栏提示', '鼠标悬停图标时显示名称与快捷键', toggle('tooltips', T.s.tooltips !== false))
    );
    return h;
  }

  function renderTerminal() {
    const fams = FONT_FAMILIES.map(([v, l]) =>
      `<option value="${esc(v)}"${String(v) === String(T.s.fontFamily || '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
    let h = `<h2 class="st-h">终端</h2><p class="st-sub">字体、输入模式与多会话同步。</p>`;
    h += card('字体',
      row('等宽字体族', '只影响此后新建的终端；已有终端在切换主题时一并刷新',
        `<select data-sel="fontFamily">${fams}</select>`)
    );
    h += card('输入',
      row('模式', 'Local / Remote 模式；仅 Remote 下同步输入生效',
        `<select data-sel="mode"><option value="Remote"${T.s.mode === 'Remote' ? ' selected' : ''}>远程模式</option>
          <option value="Local"${T.s.mode === 'Local' ? ' selected' : ''}>本地模式</option></select>`)
      + row('同步输入', '打开后键盘输入广播到所有会话（群控）', toggle('sync', !!T.s.sync))
      + row('选中自动复制', '鼠标选中即进剪贴板（xterm 选中事件驱动）', toggle('copyOnSelect', T.s.copyOnSelect !== false))
      + row('右键粘贴（PuTTY 习惯）', '关闭后右键恢复为浏览器/终端上下文菜单；中键始终粘贴', toggle('rightClickPaste', T.s.rightClickPaste !== false))
    );
    h += card('行为',
      row('启动时打开主页', '关闭则启动直接落到上次的终端', toggle('homeOnStart', T.s.homeOnStart !== false))
      + row('后台标签活动提示', '有输出且开了「活动时通知」的标签显示圆点', toggle('activityDot', T.s.activityDot !== false))
      + row('会话输出落盘（PuTTY Logging）', '新会话的终端输出写入 配置目录/logs/session-*.log；仅对新开会话生效', toggle('sessionLog', !!T.s.sessionLog))
    );
    h += card('输出高亮',
      row('内置关键字高亮', 'error/warn/ok/地址 四类规则，命中关键词持续着色，直到对应输出被清除', toggle('builtinHighlight', T.s.builtinHighlight !== false))
      + `<div class="st-row"><div class="st-l"><i>
          <span class="wt-hl-err" style="padding:0 6px;border-radius:3px">error / failed / fatal</span>
          <span class="wt-hl-warn" style="padding:0 6px;border-radius:3px">warn / timeout</span>
          <span class="wt-hl-ok" style="padding:0 6px;border-radius:3px">ok / success / running</span>
          <span class="wt-hl-addr" style="padding:0 6px;border-radius:3px">192.168.1.1 / https://…</span>
        </i></div></div>`
    );
    return h;
  }

  function renderProfiles() {
    const ss = Array.isArray(T.s.sessions) ? T.s.sessions : [];
    const groups = {};
    for (const s of ss) (groups[s.folder || '（未分组）'] ||= []).push(s);
    let list = '';
    for (const g of Object.keys(groups).sort()) {
      list += `<div class="grp">▸ ${esc(g)}</div>`;
      for (const s of groups[g]) {
        const sub = s.protocol === 'serial' ? (s.target || '串口')
          : s.host ? `${s.user ? s.user + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}`
            : (s.command || '默认 shell');
        list += `<div class="row" data-edit="${encodeURIComponent(s.name || '')}">
          <span class="ico">${window.Icons ? window.Icons.svg(protoIcon(s.protocol)) : ''}</span>
          <span class="col"><b>${esc(s.name)}</b><i>${esc(sub)}</i></span>
          <span class="x" data-del="${encodeURIComponent(s.name || '')}">×</span></div>`;
      }
    }
    if (!ss.length) list = '<div class="empty">还没有机器。点下面「打开机器管理」新建第一台。</div>';

    let h = `<h2 class="st-h">机器与连接</h2><p class="st-sub">共 ${ss.length} 台。SSH / Telnet / 串口 / TCP / 本地。</p>`;
    h += card('', `<div class="st-row"><div class="st-l"><b>机器管理</b><i>管理本地与远程连接，支持分组、颜色、代理与跳板机</i></div>
      <div class="st-c"><button class="primary" data-open-manager>打开机器管理</button></div></div>`);
    h += card('已保存的机器', list);
    return h;
  }

  function protoIcon(p) {
    return { ssh: 'lock', telnet: 'telnet', serial: 'serial', tcp: 'globe', local: 'terminal' }[(p || '').toLowerCase()] || 'terminal';
  }

  function renderTriggers() {
    const list = Array.isArray(T.s.triggers) ? T.s.triggers : [];
    let rows = '';
    list.forEach((r, i) => {
      rows += `<div class="tr-row">
        <button class="sw-toggle${r.enabled !== false ? ' on' : ''}" data-tren="${i}" role="switch" aria-checked="${r.enabled !== false}" title="启用/停用"></button>
        <span class="nm">${esc(r.name || '(未命名)')}</span>
        <code class="pat">/${esc(r.pattern)}/</code>
        <span class="act">${esc(labelOfAction(r.action))}${r.arg ? ' → ' + esc(r.arg) : ''}</span>
        <button class="icon danger" data-trdel="${i}" title="删除">${window.Icons ? window.Icons.svg('trash') : '×'}</button></div>`;
    });
    if (!list.length) rows = '<div class="empty">还没有触发器。正则匹配终端输出 → 执行动作。</div>';

    const acts = TRIGGER_ACTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    let h = `<h2 class="st-h">触发器</h2><p class="st-sub">匹配终端输出，自动高亮、响铃或发送文本。</p>`;
    h += card('已配置', rows);
    h += card('新增', `<div class="tr-form">
      <input data-tr="name" placeholder="名称" />
      <input data-tr="pattern" placeholder="正则，如 error|failed|权限不足" spellcheck="false" />
      <select data-tr="action">${acts}</select>
      <input data-tr="arg" placeholder="发送内容（action=发送文本 时用）" />
      <button class="primary" data-tradd>添加</button></div>`);
    return h;
  }

  function labelOfAction(a) {
    const f = TRIGGER_ACTIONS.find((x) => x[0] === a);
    return f ? f[1] : (a || 'highlight');
  }

  const HOTKEYS = [
    ['新建本地会话', 'Ctrl+T'], ['关闭当前会话', 'Ctrl+W'], ['命令面板', 'Ctrl+Shift+P'],
    ['机器管理', 'Ctrl+M'], ['设置', 'Ctrl+,'], ['查找', 'Ctrl+F'], ['查找下一个 / 上一个', 'F3 / Shift+F3'],
    ['左右分屏 / 上下分屏', 'Ctrl+Shift+E / Ctrl+Shift+D'], ['取消分屏', 'Ctrl+Shift+W'],
    ['切换侧栏', 'Ctrl+B'], ['侧栏窗格 1–6', 'Ctrl+1 … Ctrl+6'],
    ['放大 / 缩小字号', 'Ctrl+= / Ctrl+-'], ['复制 / 粘贴', 'Ctrl+Shift+C / Ctrl+Shift+V'],
    ['全屏', 'F11'], ['发送文本到终端', 'Ctrl+Enter（发送窗格内）'],
  ];
  function renderHotkeys() {
    let h = `<h2 class="st-h">快捷键</h2><p class="st-sub">当前为固定映射；自定义键位属后续路线。</p>`;
    h += card('', HOTKEYS.map(([l, k]) => `<div class="kb-row"><span class="kb-l">${esc(l)}</span><kbd>${esc(k)}</kbd></div>`).join(''));
    return h;
  }

  function renderAbout() {
    const ui = T.s.updateInfo;
    const newer = ui && ui.latest && window.WT && WT.VERSION && cmp(ui.latest, WT.VERSION) > 0;
    let h = `<h2 class="st-h">关于</h2><p class="st-sub">hurricaneTerm ${esc(window.WT && WT.VERSION || '')}</p>`;
    h += card('更新', `
      <div class="st-row"><div class="st-l"><b>当前版本</b><i>v${esc(window.WT && WT.VERSION || '')}</i></div>
        <div class="st-c"><button data-check-update>检查更新</button></div></div>
      <div class="st-row"><div class="st-l"><b>最新_release tag</b>
        <i>${ui && ui.latest ? 'v' + esc(ui.latest) + (newer ? ' · 有新版本' : ' · 已是最新') : '尚未检查'}</i></div>
        <div class="st-c">${newer ? `<button class="primary" data-open-tag>打开 v${esc(ui.latest)} 标签页</button>` : ''}</div></div>`);
    h += card('', `
      <div class="st-row"><div class="st-l"><b>来历</b><i>独立项目 · Tauri 2 + Rust + xterm.js</i></div></div>
      <div class="st-row"><div class="st-l"><b>架构</b><i>Tauri 2 + Rust（russh / portable-pty / russh-sftp）后端 + xterm.js 前端</i></div></div>
      <div class="st-row"><div class="st-l"><b>界面</b><i>形态参考 Tabby（无边框标题栏 / 图标活动栏 / 全页设置）；配色令牌取自 Tabby 上游 theme.vars.scss</i></div></div>
      <div class="st-row"><div class="st-l"><b>许可</b><i>Apache-2.0，代码全部原创</i></div></div>
      <div class="st-row"><div class="st-l"><b>仓库</b><i>github.com/edwardlewis35/hurricaneTerm</i></div></div>`);
    return h;
  }

  function cmp(a, b) {
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1; }
    return 0;
  }

  const RENDERERS = {
    appearance: renderAppearance, terminal: renderTerminal, profiles: renderProfiles,
    triggers: renderTriggers, hotkeys: renderHotkeys, about: renderAbout,
    gist: () => window.GistSync ? `<div class="gs-root">${GistSync.view()}</div>` : '<p>同步模块未加载</p>',
  };

  /* ---------- 事件绑定（每次 render 后重挂） ---------- */
  function bind() {
    // 主题卡
    bodyEl.querySelectorAll('[data-theme]').forEach((c) => {
      c.onclick = () => { T.term.applyTheme(c.dataset.theme); doRender(); };
    });
    // 布尔开关（sync 缺省 false，其余缺省 true）
    bodyEl.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.toggle;
        const cur = T.s[k] === undefined ? k === 'sync' : !!T.s[k];
        T.s[k] = !cur;
        b.classList.toggle('on', T.s[k]);
        b.setAttribute('aria-checked', String(T.s[k]));
        applyPref(k);
      };
    });
    // 数字
    const opacity = bodyEl.querySelector('[data-opacity]');
    if (opacity && window.Appearance) {
      opacity.addEventListener('input', () => Appearance.setOpacity(opacity.value, { persist: false }));
      opacity.addEventListener('change', () => Appearance.setOpacity(opacity.value));
    }
    const terminalOpacity = bodyEl.querySelector('[data-terminal-opacity]');
    if (terminalOpacity && window.Appearance) {
      terminalOpacity.addEventListener('input', () => Appearance.setTerminalOpacity(terminalOpacity.value, { persist: false }));
      terminalOpacity.addEventListener('change', () => Appearance.setTerminalOpacity(terminalOpacity.value));
    }
    bodyEl.querySelectorAll('[data-num]').forEach((i) => {
      i.onchange = () => {
        const v = Math.max(8, Math.min(28, parseInt(i.value, 10) || 13));
        i.value = v;
        T.s.fontSize = v;
        T.term.applyFontSize(v);
      };
    });
    // 下拉
    bodyEl.querySelectorAll('[data-sel]').forEach((s) => {
      s.onchange = () => {
        T.s[s.dataset.sel] = s.value;
        T.persistSettings();
        if (s.dataset.sel === 'fontFamily') T.term.applyFontFamily(s.value);
        if (s.dataset.sel === 'mode') { if (window.UI) UI.status(); toast('模式：' + (s.value === 'Local' ? '本地' : '远程')); }
      };
    });
    // 机器管理
    const om = bodyEl.querySelector('[data-open-manager]');
    if (om) om.onclick = () => {
      if (window.Profiles) window.Profiles.openManager();
      else toast('机器管理模块未加载');
    };
    bodyEl.querySelectorAll('[data-edit]').forEach((r) => {
      r.onclick = (e) => {
        if (e.target.dataset.del) return;
        const name = decodeURIComponent(r.dataset.edit);
        const s = (T.s.sessions || []).find((x) => x.name === name);
        if (s && window.Profiles) window.Profiles.edit(s);
      };
    });
    bodyEl.querySelectorAll('[data-del]').forEach((x) => {
      x.onclick = async (e) => {
        e.stopPropagation();
        const name = decodeURIComponent(x.dataset.del);
        T.s.sessions = (T.s.sessions || []).filter((s) => s.name !== name);
        await T.persistSessions();
        doRender();
        toast('已删除机器：' + name, 'ok');
      };
    });
    // 触发器
    bodyEl.querySelectorAll('[data-tren]').forEach((b) => {
      b.onclick = () => {
        const r = T.s.triggers[+b.dataset.tren];
        if (!r) return;
        r.enabled = r.enabled === false;
        b.classList.toggle('on', r.enabled !== false);
        T.persistSettings();
      };
    });
    bodyEl.querySelectorAll('[data-trdel]').forEach((b) => {
      b.onclick = () => {
        T.s.triggers.splice(+b.dataset.trdel, 1);
        T.persistSettings();
        doRender();
        toast('已删除触发器');
      };
    });
    const cu = bodyEl.querySelector('[data-check-update]');
    if (cu) cu.onclick = () => T.checkUpdate(true);
    const ot = bodyEl.querySelector('[data-open-tag]');
    if (ot) ot.onclick = () => {
      const v = T.s.updateInfo && T.s.updateInfo.latest;
      const url = 'https://github.com/edwardlewis35/hurricaneTerm/releases/tag/v' + v;
      try { window.open ? window.open(url, '_blank') : null; } catch (e) {}
      toast('已打开 ' + url);
    };
    const addBtn = bodyEl.querySelector('[data-tradd]');
    if (addBtn) addBtn.onclick = addTrigger;
    const patIn = bodyEl.querySelector('[data-tr="pattern"]');
    if (patIn) patIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTrigger(); } });
  }

  function applyPref(k) {
    T.persistSettings();
    if (k === 'statusBar') document.body.classList.toggle('no-status', T.s.statusBar === false);
    if (k === 'sync' && window.UI) UI.status();
    if (window.UI && UI.renderDock) UI.renderDock();
  }

  function addTrigger() {
    const g = (n) => { const e = bodyEl.querySelector(`[data-tr="${n}"]`); return e ? e.value.trim() : ''; };
    const name = g('name'), pattern = g('pattern'), action = g('action') || 'highlight', arg = g('arg');
    if (!pattern) { toast('正则不能为空', 'err'); return; }
    try { new RegExp(pattern); } catch (e) { toast('正则无效：' + e.message, 'err'); return; }
    if (!Array.isArray(T.s.triggers)) T.s.triggers = [];
    T.s.triggers.push({ name, pattern, action, arg, enabled: true });
    T.persistSettings();
    doRender();
    toast('已添加触发器', 'ok');
  }

  /* ---------- 渲染当前分区（模块级，供内部各处裸调用） ---------- */
  function doRender() {
    if (!mounted) return;
    navEl.querySelectorAll('[data-sec]').forEach((n) => n.classList.toggle('on', n.dataset.sec === section));
    const fn = RENDERERS[section] || renderAppearance;
    bodyEl.innerHTML = fn();
    bind();
    if (section === 'gist' && window.GistSync) GistSync.bind(bodyEl.querySelector('.gs-root'));
    bodyEl.scrollTop = 0;
  }

  /* ---------- 外壳 ---------- */
  const Settings = {
    mount(container) {
      el = container;
      if (!el || mounted) { if (mounted) doRender(); return; }
      mounted = true;
      el.innerHTML = `<div class="st-wrap"><nav class="st-nav" aria-label="设置分区"></nav><div class="st-body"></div></div>`;
      navEl = el.querySelector('.st-nav');
      bodyEl = el.querySelector('.st-body');

      navEl.innerHTML = `<div class="st-nav-h"><span>设置</span><button class="icon st-close" title="关闭设置 (Esc)" aria-label="关闭设置">${window.Icons ? window.Icons.svg('x') : '×'}</button></div>` + SECTIONS.map((s) =>
        `<button type="button" class="st-nav-i" data-sec="${s.id}">${window.Icons ? window.Icons.svg(s.icon) : ''}<span>${esc(s.label)}</span></button>`).join('');
      navEl.querySelectorAll('[data-sec]').forEach((n) => {
        n.onclick = () => { section = n.dataset.sec; doRender(); };
      });
      navEl.querySelector('.st-close').onclick = () => this.close();

      // Esc 关闭（焦点在输入框里也生效）
      el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
      doRender();
    },

    render() { doRender(); },

    open(sec) {
      if (!mounted) return;
      if (window.SftpPanel?.isOpen() && !SftpPanel.hide()) return;
      if (window.UI?.closeDock) UI.closeDock();
      if (window.Profiles && Profiles.isOpen()) Profiles.close();
      if (sec) section = sec;
      open = true;
      el.hidden = false;
      // 设置页与主页互斥
      if (window.Home && window.Home.hide) Home.hide();
      this.render();
      this.syncChrome();
    },

    close() {
      if (!mounted) return;
      open = false;
      el.hidden = true;
      this.syncChrome();
      // 没有终端时回到主页，避免主区空白
      if (!T.term.order.length && window.Home) Home.show();
      const t = T.term.activeTab();
      if (t) { try { t.fit.fit(); } catch (e) {} t.term.focus(); }
    },

    toggle(sec) { if (open && !sec) this.close(); else this.open(sec); },
    isOpen() { return open; },

    // 标题栏齿轮 / 活动栏齿轮的按钮态同步
    syncChrome() {
      if (window.TitleBar) TitleBar.syncSettings();
      if (window.ActBar && window.ActBar.syncSettings) ActBar.syncSettings();
    },

    /* 深浅色一键切换：在当前主题的深/浅同类里换 */
    cycleLightDark() {
      const names = Object.keys(T.term.THEMES);
      const wantLight = !isLightTheme(T.s.theme);
      const pool = names.filter((n) => isLightTheme(n) === wantLight);
      const list = pool.length ? pool : names;
      const i = list.indexOf(T.s.theme);
      const next = list[(i + 1) % list.length] || list[0];
      T.term.applyTheme(next);
      toast('主题：' + next);
      if (open && section === 'appearance') doRender();
    },

    goto(sec) { this.open(sec); },
  };

  window.Settings = Settings;
})();
