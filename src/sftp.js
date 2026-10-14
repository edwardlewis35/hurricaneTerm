/* Original SFTP workspace. Reference UI: https://github.com/10D24D/Tabby-SFTP-Plus */
(function () {
  "use strict";
  const T = window.WT;
  const esc = (v) =>
    String(v == null ? "" : v).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const svg = (n) => window.Icons.svg(n);
  const size = (n) =>
    n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : n < 1073741824
          ? `${(n / 1048576).toFixed(1)} MB`
          : `${(n / 1073741824).toFixed(1)} GB`;
  const date = (n) =>
    n
      ? new Date(n * 1000).toLocaleString("zh-CN", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "—";
  const basename = (p) =>
    String(p)
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop();
  const uuid = () =>
    window.crypto?.randomUUID
      ? crypto.randomUUID()
      : `sftp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  function join(base, name, side) {
    const sep =
      side === "local" && /^[A-Za-z]:\\|^\\\\/.test(base) ? "\\" : "/";
    return String(base).replace(/[\\/]+$/, "") + sep + name;
  }
  function parent(path) {
    if (/^[A-Za-z]:[\\/]?$/.test(path) || path === "/") return path;
    const p = String(path)
      .replace(/[\\/]+$/, "")
      .replace(/[\\/][^\\/]+$/, "");
    return /^[A-Za-z]:$/.test(p) ? p + "\\" : p || "/";
  }
  const permissions = (n) =>
    n == null
      ? "—"
      : [..."rwxrwxrwx"].map((c, i) => (n & (1 << (8 - i)) ? c : "-")).join("");
  const label = {
    queued: "等待",
    preparing: "准备中",
    running: "传输中",
    paused: "已暂停",
    pausing: "暂停中",
    completed: "完成",
    skipped: "已跳过",
    failed: "失败",
    cancelled: "已取消",
    cancelling: "取消中",
  };
  let root,
    current,
    modalClose,
    clipboard,
    dragSelection,
    dragGhost,
    suppressDragClickUntil = 0,
    dropGeneration = 0,
    focused = "local",
    activeWorkers = 0,
    searchTimer,
    nativeUnlisten,
    modalLocked = false;
  const contexts = new Map(),
    tasks = [];
  let conflictChain = Promise.resolve();
  function prefs() {
    const p = T.s.sftp || (T.s.sftp = {});
    return Object.assign(p, {
      layout: p.layout || "auto",
      pathMode: p.pathMode || "remember",
      concurrency: Math.min(10, Math.max(1, Number(p.concurrency) || 2)),
      bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
      paths: p.paths || {},
      history: Array.isArray(p.history) ? p.history : [],
      showHidden: !!p.showHidden,
      zebra: p.zebra !== false,
    });
  }
  function save() {
    T.persistSettings();
  }
  function toast(e, kind) {
    if (window.UI) UI.toast(String((e && e.message) || e), 3200, kind || "");
  }
  function guard(fn) {
    return (...args) => {
      try {
        return Promise.resolve(fn(...args)).catch((e) => toast(e, "err"));
      } catch (e) {
        toast(e, "err");
        return Promise.resolve();
      }
    };
  }
  const ssh = (tab) =>
    !!(tab && tab.session && tab.session.protocol === "ssh" && !tab.exited);
  const contextKey = (tab) =>
    ssh(tab)
      ? `${tab.session.user || ""}@${tab.session.host}:${tab.session.port || 22}`
      : "local";
  function newPane(path) {
    return {
      path,
      home: null,
      entries: [],
      selected: new Set(),
      history: [],
      historyIndex: -1,
      filter: "",
      sort: "name",
      asc: true,
      loading: false,
      error: null,
      seq: 0,
      anchor: null,
    };
  }
  function bind(tab) {
    const id = (tab && tab.id) || "local";
    if (!contexts.has(id)) {
      const p = prefs(),
        remembered = (p.pathMode !== "off" && p.paths[contextKey(tab)]) || {};
      contexts.set(id, {
        id,
        tab,
        key: contextKey(tab),
        local: newPane(remembered.local || null),
        remote: newPane(remembered.remote || "."),
        ratio: 0.5,
      });
    }
    const c = contexts.get(id);
    c.tab = tab;
    return c;
  }
  function connected(c = current) {
    return c && ssh(c.tab) && T.term.tabs[c.id] === c.tab;
  }
  function invoke(c, side, op, args = {}) {
    if (side === "remote" && !connected(c))
      return Promise.reject(new Error("远程操作需要已连接的 SSH 会话"));
    return T.invoke(
      (side === "remote" ? "sftp_" : "fs_") + op,
      side === "remote" ? { id: c.id, ...args } : args,
    );
  }
  function button(action, icon, text, disabled = false, on = false) {
    return `<button type="button" class="sftp-icon${on ? " on" : ""}" data-action="${action}" title="${esc(text)}" aria-label="${esc(text)}"${disabled ? " disabled" : ""}>${svg(icon)}</button>`;
  }
  function paneHtml(side) {
    const p = current[side],
      disconnected = side === "remote" && !connected();
    return `<section class="sftp-pane${focused === side ? " focused" : ""}" data-side="${side}">
      <div class="sftp-nav"><span class="sftp-label">${svg(side === "local" ? "server" : "globe")}${side === "local" ? "本地" : "远程"}</span><input class="sftp-path" aria-label="${side === "local" ? "本地" : "远程"}路径" value="${esc(p.path || "~")}" spellcheck="false"${disconnected ? " disabled" : ""}>
      ${button("back", "arrowLeft", "后退", disconnected || p.historyIndex <= 0)}${button("forward", "arrowRight", "前进", disconnected || p.historyIndex >= p.history.length - 1)}${button("up", "arrowUp", "上级目录", disconnected)}${button("refresh", "refresh", "刷新 (F5)", disconnected)}${button("home", "home", "主目录", disconnected)}${button("filter", "search", "筛选文件", disconnected)}${button("bookmarks", "star", "书签", disconnected)}</div>
      <div class="sftp-filter"${p.filterVisible ? "" : " hidden"}><input aria-label="${side === "local" ? "本地" : "远程"}文件筛选" placeholder="筛选名称…" value="${esc(p.filter)}"></div>
      <div class="sftp-list" tabindex="0" aria-label="${side === "local" ? "本地" : "远程"}文件列表"></div><footer class="sftp-foot"></footer></section>`;
  }
  function renderShell() {
    if (!root || !current) return;
    cancelDrag();
    const p = prefs(),
      tab = current.tab,
      isSsh = connected();
    root.innerHTML = `<header class="sftp-head"><strong>SFTP</strong><span class="sftp-host">${isSsh ? esc(current.key) : "本地文件管理"}</span><div class="sftp-head-actions">${button("pathMode", "pin", "路径模式：" + { off: "不记忆", remember: "记忆路径", sync: "跟随终端" }[p.pathMode], false, p.pathMode !== "off")}${button("layout", "splitH", "切换布局")}${button("history", "output", "传输记录")}${button("settings", "gear", "文件管理设置")}${button("maximize", "maximize", "最大化 / 还原")}${button("close", "x", "关闭文件管理 (Esc)")}</div></header>
      <div class="sftp-body">${paneHtml("local")}<div class="sftp-splitter" title="拖动调整；双击复位"></div>${paneHtml("remote")}</div><div class="sftp-queue"></div><div class="sftp-corner"></div>`;
    root.querySelectorAll("[data-action]").forEach((b) => {
      b.onclick = guard(() => {
        const side = b.closest("[data-side]")?.dataset.side;
        return side
          ? navAction(side, b.dataset.action)
          : topAction(b.dataset.action);
      });
    });
    for (const side of ["local", "remote"]) wirePane(side);
    wireSplit();
    wireMove();
    layout();
    renderList("local");
    renderList("remote");
    renderQueue();
  }
  function layout() {
    if (!root || !current) return;
    const mode = prefs().layout;
    root.dataset.layout =
      mode === "auto"
        ? root.clientWidth < 850
          ? "vertical"
          : "horizontal"
        : mode;
    const first = root.querySelector('[data-side="local"]');
    if (first)
      first.style.flex =
        root.dataset.layout === "single"
          ? ""
          : `0 0 calc(${current.ratio * 100}% - 4px)`;
  }
  async function load(c, side, path, remember = true) {
    const p = c[side],
      seq = ++p.seq;
    p.loading = true;
    p.error = null;
    p.selected.clear();
    p.anchor = null;
    p.prefix = "";
    if (current === c && Panel.isOpen()) renderList(side);
    try {
      if (side === "remote" && !connected(c))
        throw new Error("连接 SSH 会话后即可浏览远程目录");
      const canonical = await invoke(c, side, "realpath", {
        path:
          path == null || path === "~" ? (side === "local" ? null : ".") : path,
      });
      const entries = await invoke(c, side, "list", { path: canonical });
      if (seq !== p.seq) return;
      if (!p.home) {
        const home = await invoke(c, side, "realpath", {
          path: side === "local" ? null : ".",
        });
        if (seq !== p.seq) return;
        p.home = home;
      }
      p.path = canonical;
      p.entries = (Array.isArray(entries) ? entries : [])
        .filter((e) => e.name !== "." && e.name !== "..")
        .map((e) => ({ ...e, modified: e.modified ?? e.mtime ?? 0 }));
      if (remember && p.history[p.historyIndex] !== canonical) {
        p.history = p.history.slice(0, p.historyIndex + 1);
        p.history.push(canonical);
        p.historyIndex = p.history.length - 1;
      }
      if (prefs().pathMode !== "off") {
        prefs().paths[c.key] = { local: c.local.path, remote: c.remote.path };
        save();
      }
      if (current === c) {
        if (side === "local") T.s.filerPath = canonical;
        else T.s.remotePath = canonical;
      }
    } catch (e) {
      if (seq === p.seq) {
        p.error = String((e && e.message) || e);
        p.entries = [];
      }
    } finally {
      if (seq === p.seq) {
        p.loading = false;
        if (current === c && Panel.isOpen()) {
          renderList(side);
          const input = root.querySelector(`[data-side="${side}"] .sftp-path`);
          input.value = p.path || "~";
          updateNav(side);
        }
      }
    }
  }
  function updateNav(side) {
    const p = current[side],
      pane = root.querySelector(`[data-side="${side}"]`);
    pane.querySelector('[data-action="back"]').disabled = p.historyIndex <= 0;
    pane.querySelector('[data-action="forward"]').disabled =
      p.historyIndex >= p.history.length - 1;
  }
  function visible(p) {
    const q = p.filter.toLocaleLowerCase();
    return p.entries
      .filter(
        (e) =>
          (prefs().showHidden || !e.name.startsWith(".")) &&
          e.name.toLocaleLowerCase().includes(q),
      )
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        const av =
            p.sort === "type"
              ? a.is_dir
                ? "目录"
                : a.name.split(".").pop()
              : a[p.sort],
          bv =
            p.sort === "type"
              ? b.is_dir
                ? "目录"
                : b.name.split(".").pop()
              : b[p.sort];
        return (
          (typeof av === "number"
            ? av - bv
            : String(av ?? "").localeCompare(String(bv ?? ""), "zh-CN", {
                numeric: true,
                sensitivity: "base",
              })) * (p.asc ? 1 : -1)
        );
      });
  }
  function selected(c, side) {
    return c[side].entries.filter((e) => c[side].selected.has(e.path));
  }
  function renderList(side) {
    const c = current,
      p = c[side],
      pane = root.querySelector(`[data-side="${side}"]`);
    if (!pane) return;
    const list = pane.querySelector(".sftp-list"),
      entries = visible(p);
    if (p.loading)
      list.innerHTML = '<div class="sftp-empty">正在读取目录…</div>';
    else if (p.error)
      list.innerHTML = `<div class="sftp-empty">${esc(p.error)}<br><button data-retry>重新读取</button></div>`;
    else
      list.innerHTML = `<table class="sftp-table${prefs().zebra ? " zebra" : ""}" aria-label="${side === "local" ? "本地" : "远程"}文件"><thead><tr>${[
        ["name", "名称"],
        ["size", "大小"],
        ["modified", "修改时间"],
        [
          side === "local" ? "type" : "permissions",
          side === "local" ? "类型" : "权限",
        ],
      ]
        .map(
          ([key, text]) =>
            `<th><button data-sort="${key}">${text}${p.sort === key ? (p.asc ? " ↑" : " ↓") : ""}</button></th>`,
        )
        .join(
          "",
        )}</tr></thead><tbody>${entries.map((e) => `<tr data-path="${esc(e.path)}" class="${p.selected.has(e.path) ? "selected" : ""}" draggable="false" aria-selected="${p.selected.has(e.path)}"><td title="${esc(e.name)}"><div class="sftp-file${e.is_dir ? " directory" : /\.(png|jpe?g|gif|webp|bmp)$/i.test(e.name) ? " image" : ""}">${svg(e.is_dir ? "folder" : "output")}<span>${esc(e.name)}</span>${e.is_link ? '<i class="sftp-link">↗</i>' : ""}</div></td><td>${e.is_dir ? "—" : size(e.size || 0)}</td><td>${date(e.modified)}</td><td class="${side === "remote" ? "sftp-perms" : ""}">${side === "remote" ? permissions(e.permissions) : e.is_dir ? "目录" : esc(e.name.includes(".") ? e.name.split(".").pop().toUpperCase() : "文件")}</td></tr>`).join("")}</tbody></table>${entries.length ? "" : '<div class="sftp-empty">' + (p.filter ? "没有匹配的文件" : "目录为空") + "</div>"}`;
    list
      .querySelector("[data-retry]")
      ?.addEventListener("click", () => load(c, side, p.path));
    list.querySelectorAll("[data-sort]").forEach((b) => {
      b.onclick = () => {
        if (p.sort === b.dataset.sort) p.asc = !p.asc;
        else {
          p.sort = b.dataset.sort;
          p.asc = true;
        }
        renderList(side);
      };
    });
    list.querySelectorAll("tr[data-path]").forEach((row) => {
      const e = p.entries.find((x) => x.path === row.dataset.path);
      row.onclick = (ev) => {
        if (Date.now() < suppressDragClickUntil) {
          ev.preventDefault();
          return;
        }
        focusSide(side);
        selectRow(side, e, ev);
      };
      row.ondblclick = guard(() =>
        e.is_dir ? load(c, side, e.path) : preview(c, side, e),
      );
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        focusSide(side);
        if (!p.selected.has(e.path)) {
          p.selected.clear();
          p.selected.add(e.path);
          renderList(side);
        }
        contextMenu(side, ev.clientX, ev.clientY);
      };
      // Tauri's native file-drop handler replaces HTML5 DnD on Windows. Use
      // pointer capture for pane-to-pane transfers, retaining native OS drops.
      row.ondragstart = (ev) => ev.preventDefault();
      row.onpointerdown = (ev) => beginDrag(ev, c, side, e);
    });
    const sel = selected(c, side),
      total = sel.reduce((n, e) => n + (e.is_dir ? 0 : e.size || 0), 0);
    pane.querySelector(".sftp-foot").innerHTML =
      `<span>${entries.length} 项${sel.length ? " · 已选 " + sel.length + " 项" : ""}</span><span>${sel.length ? size(total) : ""}</span>`;
  }
  function focusSide(side) {
    focused = side;
    root
      .querySelectorAll(".sftp-pane")
      .forEach((e) => e.classList.toggle("focused", e.dataset.side === side));
  }
  function selectRow(side, e, ev) {
    const p = current[side],
      entries = visible(p);
    if (ev.shiftKey && p.anchor && entries.some((x) => x.path === p.anchor)) {
      const a = entries.findIndex((x) => x.path === p.anchor),
        b = entries.findIndex((x) => x.path === e.path);
      if (!ev.ctrlKey && !ev.metaKey) p.selected.clear();
      entries
        .slice(Math.min(a, b), Math.max(a, b) + 1)
        .forEach((x) => p.selected.add(x.path));
    } else if (ev.ctrlKey || ev.metaKey) {
      p.selected.has(e.path)
        ? p.selected.delete(e.path)
        : p.selected.add(e.path);
      p.anchor = e.path;
    } else {
      p.selected.clear();
      p.selected.add(e.path);
      p.anchor = e.path;
    }
    renderList(side);
    root.querySelector(`[data-side="${side}"] .sftp-list`).focus();
  }
  function wirePane(side) {
    const pane = root.querySelector(`[data-side="${side}"]`),
      c = current,
      p = c[side],
      list = pane.querySelector(".sftp-list");
    pane.onmousedown = () => focusSide(side);
    pane.querySelector(".sftp-path").onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        load(c, side, ev.target.value.trim());
      }
    };
    pane.querySelector(".sftp-filter input").oninput = (ev) => {
      p.filter = ev.target.value;
      renderList(side);
    };
    list.oncontextmenu = (ev) => {
      if (ev.target.closest("tr[data-path]")) return;
      ev.preventDefault();
      contextMenu(side, ev.clientX, ev.clientY);
    };
    list.onkeydown = guard(async (ev) => {
      if (ev.target.tagName === "INPUT") return;
      const mod = ev.ctrlKey || ev.metaKey,
        entries = visible(p),
        sel = selected(c, side);
      if (mod && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        entries.forEach((e) => p.selected.add(e.path));
        renderList(side);
      } else if (mod && ["c", "x", "v"].includes(ev.key.toLowerCase())) {
        ev.preventDefault();
        if (ev.key.toLowerCase() === "v") await paste(c, side);
        else
          clipboard = {
            context: c,
            side,
            entries: sel,
            move: ev.key.toLowerCase() === "x",
          };
      } else if (ev.key === "F5") {
        ev.preventDefault();
        await load(c, side, p.path, false);
      } else if (ev.key === "Backspace") {
        ev.preventDefault();
        await load(c, side, parent(p.path));
      } else if (ev.key === "F2") {
        ev.preventDefault();
        await rename(c, side);
      } else if (ev.key === "Delete") {
        ev.preventDefault();
        await remove(c, side);
      } else if (ev.key === "Enter" && sel[0]) {
        ev.preventDefault();
        await (sel[0].is_dir
          ? load(c, side, sel[0].path)
          : preview(c, side, sel[0]));
      } else if (["ArrowDown", "ArrowUp"].includes(ev.key)) {
        ev.preventDefault();
        const last = p.anchor || sel[0]?.path,
          idx = entries.findIndex((e) => e.path === last);
        const e =
          entries[
            Math.max(
              0,
              Math.min(
                entries.length - 1,
                idx + (ev.key === "ArrowDown" ? 1 : -1),
              ),
            )
          ];
        if (e) {
          p.selected.clear();
          p.selected.add(e.path);
          p.anchor = e.path;
          renderList(side);
          list
            .querySelector(
              `tr[data-path="${window.CSS?.escape ? CSS.escape(e.path) : e.path.replace(/"/g, '\\"')}"]`,
            )
            ?.scrollIntoView({ block: "nearest" });
        }
      } else if (ev.key.length === 1 && !mod && !ev.altKey) {
        clearTimeout(searchTimer);
        p.prefix = (p.prefix || "") + ev.key;
        searchTimer = setTimeout(() => (p.prefix = ""), 900);
        const e = entries.find((e) =>
          e.name.toLocaleLowerCase().startsWith(p.prefix.toLocaleLowerCase()),
        );
        if (e) {
          p.selected.clear();
          p.selected.add(e.path);
          p.anchor = e.path;
          renderList(side);
        }
      }
    });
    // Never let a browser navigate to an OS-dropped file. The Tauri callback
    // below is the only path accepting native paths, preventing double sends.
    pane.ondragover = (ev) => ev.preventDefault();
    pane.ondrop = (ev) => ev.preventDefault();
  }
  function clearDropTargets() {
    root?.querySelectorAll(".drop-target,.drop-directory").forEach((el) => {
      el.classList.remove("drop-target", "drop-directory");
    });
  }
  function cancelDrag() {
    const d = dragSelection;
    dragSelection = null;
    if (d && root?.hasPointerCapture?.(d.pointerId))
      root.releasePointerCapture(d.pointerId);
    dragGhost?.remove();
    dragGhost = null;
    root?.classList.remove("sftp-dragging");
    clearDropTargets();
  }
  function dropTarget(x, y, sourceSide) {
    if (!Panel.isOpen() || root.querySelector(".sftp-modal")) return null;
    const el = document.elementFromPoint(x, y),
      pane = el?.closest(".sftp-pane");
    if (!pane || !root.contains(pane)) return null;
    const side = pane.dataset.side, c = current;
    if (side === sourceSide || (side === "remote" && !connected(c)) || c[side].loading || c[side].error)
      return null;
    const row = el.closest("tr[data-path]"),
      directory = c[side].entries.find((e) => e.path === row?.dataset.path && e.is_dir);
    return { context: c, side, path: directory?.path || c[side].path, pane, row: directory ? row : null };
  }
  function highlightDrop(target) {
    clearDropTargets();
    target?.pane.classList.add("drop-target");
    target?.row?.classList.add("drop-directory");
  }
  function beginDrag(ev, c, side, entry) {
    if (ev.button !== 0 || ev.isPrimary === false || root.querySelector(".sftp-modal")) return;
    if (side === "remote" && !connected(c)) return;
    cancelDrag();
    suppressDragClickUntil = 0;
    dragSelection = { context: c, side, entry, sourceSeq: c[side].seq, pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, active: false };
  }
  function moveDrag(ev) {
    const d = dragSelection;
    if (!d || ev.pointerId !== d.pointerId) return;
    if (current !== d.context || d.context[d.side].seq !== d.sourceSeq || (d.side === "remote" && !connected(d.context)) || !Panel.isOpen() || root.querySelector(".sftp-modal")) return cancelDrag();
    if (!d.active && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 6) return;
    ev.preventDefault();
    if (!d.active) {
      d.active = true;
      root.setPointerCapture?.(ev.pointerId);
      const p = d.context[d.side];
      if (!p.selected.has(d.entry.path)) {
        p.selected.clear();
        p.selected.add(d.entry.path);
        p.anchor = d.entry.path;
      }
      d.entries = selected(d.context, d.side).map((e) => ({ ...e }));
      root.classList.add("sftp-dragging");
      dragGhost = document.createElement("div");
      dragGhost.className = "sftp-drag-ghost";
      document.body.appendChild(dragGhost);
    }
    const target = dropTarget(ev.clientX, ev.clientY, d.side);
    highlightDrop(target);
    dragGhost.textContent = `${d.entries.length} 项 · ${target ? (d.side === "local" ? "上传到 " : "下载到 ") + target.path : "拖到另一栏传输"}`;
    dragGhost.style.left = ev.clientX + 14 + "px";
    dragGhost.style.top = ev.clientY + 14 + "px";
    dragGhost.classList.toggle("valid", !!target);
    const list = target?.pane.querySelector(".sftp-list");
    if (list) {
      const r = list.getBoundingClientRect();
      if (ev.clientY < r.top + 24) list.scrollTop -= 18;
      else if (ev.clientY > r.bottom - 24) list.scrollTop += 18;
    }
  }
  async function finishDrag(ev) {
    const d = dragSelection;
    if (!d || ev.pointerId !== d.pointerId) return;
    const target = d.active && current === d.context ? dropTarget(ev.clientX, ev.clientY, d.side) : null;
    if (d.active) {
      ev.preventDefault();
      suppressDragClickUntil = Date.now() + 400;
    }
    cancelDrag();
    if (d.active && current === d.context) renderList(d.side);
    if (target) await enqueue(d.context, d.side, d.entries, target.context, target.side, target.path);
  }
  async function navAction(side, action) {
    const c = current,
      p = c[side];
    if (action === "refresh") return load(c, side, p.path, false);
    if (action === "up") return load(c, side, parent(p.path));
    if (action === "home")
      return load(c, side, p.home || (side === "local" ? null : "."));
    if (action === "back" || action === "forward") {
      p.historyIndex += action === "back" ? -1 : 1;
      return load(c, side, p.history[p.historyIndex], false);
    }
    if (action === "filter") {
      p.filterVisible = !p.filterVisible;
      const el = root.querySelector(`[data-side="${side}"] .sftp-filter`);
      el.hidden = !p.filterVisible;
      if (p.filterVisible) el.querySelector("input").focus();
      else {
        p.filter = "";
        el.querySelector("input").value = "";
        renderList(side);
      }
      return;
    }
    if (action === "bookmarks") return bookmarks(c, side);
  }
  function topAction(action) {
    if (action !== "close" && root.querySelector(".sftp-modal")) {
      toast("请先处理当前对话框");
      return;
    }
    if (action === "close") return Panel.close();
    if (action === "maximize") {
      root.classList.toggle("maximized");
      root.style.left =
        root.style.top =
        root.style.width =
        root.style.height =
          "";
      layout();
      return;
    }
    if (action === "layout") {
      const modes = ["auto", "horizontal", "vertical", "single"];
      prefs().layout =
        modes[(modes.indexOf(prefs().layout) + 1) % modes.length];
      current.ratio = 0.5;
      save();
      layout();
      return;
    }
    if (action === "pathMode") {
      const modes = ["off", "remember", "sync"];
      prefs().pathMode = modes[(modes.indexOf(prefs().pathMode) + 1) % 3];
      save();
      renderShell();
      if (prefs().pathMode === "sync" && current.tab?.cwd)
        Panel.syncCwd(current.id, current.tab.cwd);
      return;
    }
    if (action === "history") return historyDialog();
    if (action === "settings") return settingsDialog();
  }
  function wireSplit() {
    const bar = root.querySelector(".sftp-splitter");
    bar.ondblclick = () => {
      current.ratio = 0.5;
      layout();
    };
    bar.onpointerdown = (ev) => {
      ev.preventDefault();
      bar.setPointerCapture(ev.pointerId);
      const c = current,
        body = root.querySelector(".sftp-body");
      bar.onpointermove = (e) => {
        const r = body.getBoundingClientRect(),
          vertical = root.dataset.layout === "vertical";
        c.ratio = Math.min(
          0.8,
          Math.max(
            0.2,
            vertical
              ? (e.clientY - r.top) / r.height
              : (e.clientX - r.left) / r.width,
          ),
        );
        layout();
      };
      bar.onpointerup = () => (bar.onpointermove = null);
    };
  }
  function wireMove() {
    const head = root.querySelector(".sftp-head");
    head.onpointerdown = (ev) => {
      if (
        root.classList.contains("maximized") ||
        ev.target.closest("button,input")
      )
        return;
      const area = root.parentElement.getBoundingClientRect(),
        r = root.getBoundingClientRect(),
        x = ev.clientX,
        y = ev.clientY;
      head.setPointerCapture(ev.pointerId);
      head.onpointermove = (e) => {
        root.style.inset = "auto";
        root.style.width = r.width + "px";
        root.style.height = r.height + "px";
        root.style.left =
          Math.min(
            area.width - r.width,
            Math.max(0, r.left - area.left + e.clientX - x),
          ) + "px";
        root.style.top =
          Math.min(
            area.height - r.height,
            Math.max(0, r.top - area.top + e.clientY - y),
          ) + "px";
      };
      head.onpointerup = () => (head.onpointermove = null);
    };
    const corner = root.querySelector(".sftp-corner");
    corner.onpointerdown = (ev) => {
      if (root.classList.contains("maximized")) return;
      const r = root.getBoundingClientRect(),
        a = root.parentElement.getBoundingClientRect(),
        x = ev.clientX,
        y = ev.clientY;
      corner.setPointerCapture(ev.pointerId);
      corner.onpointermove = (e) => {
        root.style.inset = "auto";
        root.style.left = r.left - a.left + "px";
        root.style.top = r.top - a.top + "px";
        root.style.width =
          Math.min(a.right - r.left, Math.max(400, r.width + e.clientX - x)) +
          "px";
        root.style.height =
          Math.min(a.bottom - r.top, Math.max(280, r.height + e.clientY - y)) +
          "px";
        layout();
      };
      corner.onpointerup = () => (corner.onpointermove = null);
    };
  }
  function dialog(title, bodyHtml, buttons, options = {}) {
    if (modalLocked) {
      toast("请先处理当前文件冲突");
      return Promise.resolve(null);
    }
    if (modalClose) modalClose();
    if (root.querySelector(".sftp-modal")) return Promise.resolve(null);
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sftp-modal";
      overlay.innerHTML = `<section class="sftp-modal-box" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${bodyHtml}<div class="sftp-modal-error" hidden></div><div class="sftp-modal-actions"></div></section>`;
      root.appendChild(overlay);
      const finish = (value) => {
        overlay.remove();
        if (modalClose === cancel) {
          modalClose = null;
          modalLocked = false;
        }
        Panel.onSessionChange();
        resolve(value);
      };
      const cancel = () => finish(null);
      modalClose = cancel;
      modalLocked = !!options.locked;
      for (const [name, value, cls] of buttons) {
        const b = document.createElement("button");
        b.textContent = name;
        b.className = cls || "";
        b.onclick = () => {
          const result = typeof value === "function" ? value(overlay) : value;
          if (result?.error) {
            const el = overlay.querySelector(".sftp-modal-error");
            el.textContent = result.error;
            el.hidden = false;
          } else finish(result);
        };
        overlay.querySelector(".sftp-modal-actions").appendChild(b);
      }
      overlay.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Escape") cancel();
        else if (
          e.key === "Enter" &&
          e.target.tagName === "INPUT" &&
          buttons.length === 2
        )
          overlay
            .querySelector(".sftp-modal-actions button:last-child")
            .click();
      };
      options.setup?.(overlay);
      overlay.querySelector("input,button")?.focus();
    });
  }
  async function inputName(title, value) {
    return dialog(
      title,
      `<input type="text" aria-label="${esc(title)}" value="${esc(value || "")}" spellcheck="false">`,
      [
        ["取消", null],
        [
          "确定",
          (el) => {
            const name = el.querySelector("input").value.trim();
            return !name ||
              name === "." ||
              name === ".." ||
              /[\\/\0]/.test(name)
              ? { error: "请输入不含路径分隔符的名称" }
              : name;
          },
          "primary",
        ],
      ],
    );
  }
  async function rename(c, side) {
    const sel = selected(c, side);
    if (sel.length !== 1) {
      toast("请选择一个文件或目录");
      return;
    }
    const name = await inputName("重命名", sel[0].name);
    if (name) {
      await invoke(c, side, "rename", {
        from: sel[0].path,
        to: join(c[side].path, name, side),
      });
      await load(c, side, c[side].path, false);
    }
  }
  async function create(c, side, directory) {
    const name = await inputName(directory ? "新建文件夹" : "新建文件", "");
    if (name) {
      await invoke(c, side, directory ? "mkdir" : "create_file", {
        path: join(c[side].path, name, side),
      });
      await load(c, side, c[side].path, false);
    }
  }
  async function remove(c, side) {
    const sel = selected(c, side);
    if (!sel.length) return;
    const yes = await dialog(
      "删除所选项目",
      `<p>${esc(sel.map((e) => e.path).join("\n"))}</p><p>目录及其内容会一并删除，此操作无法撤销。</p>`,
      [
        ["取消", false],
        ["删除", true, "danger"],
      ],
    );
    if (yes) {
      for (const e of sel)
        await invoke(c, side, "remove", {
          path: e.path,
          recursive: !!e.is_dir,
        });
      await load(c, side, c[side].path, false);
    }
  }
  function contextMenu(side, x, y) {
    const c = current,
      sel = selected(c, side),
      items = [
        ["新建文件夹", () => create(c, side, true), "folder"],
        ["新建文件", () => create(c, side, false), "output"],
        ["刷新", () => load(c, side, c[side].path, false), "refresh"],
      ];
    if (sel.length) {
      items.unshift([
        side === "local" ? "上传到远程" : "下载到本地",
        () => enqueue(c, side, sel, c, side === "local" ? "remote" : "local"),
        side === "local" ? "arrowUp" : "arrowDown",
      ]);
      if (sel.length === 1 && !sel[0].is_dir)
        items.push(["查看 / 编辑", () => preview(c, side, sel[0]), "output"]);
      items.push(
        ["重命名", () => rename(c, side), "output"],
        [
          "复制",
          () => (clipboard = { context: c, side, entries: sel, move: false }),
          "copy",
        ],
        [
          "剪切",
          () => (clipboard = { context: c, side, entries: sel, move: true }),
          "copy",
        ],
        [
          "复制路径",
          () =>
            navigator.clipboard.writeText(sel.map((e) => e.path).join("\n")),
          "copy",
        ],
      );
      if (side === "remote" && sel.length === 1)
        items.push(["权限", () => chmod(c, sel[0]), "lock"]);
      items.push(["删除", () => remove(c, side), "trash"]);
    }
    if (clipboard) items.push(["粘贴", () => paste(c, side), "copy"]);
    items.push(
      [
        "全选",
        () => {
          visible(c[side]).forEach((e) => c[side].selected.add(e.path));
          renderList(side);
        },
        "copy",
      ],
      [
        "反选",
        () => {
          visible(c[side]).forEach((e) =>
            c[side].selected.has(e.path)
              ? c[side].selected.delete(e.path)
              : c[side].selected.add(e.path),
          );
          renderList(side);
        },
        "copy",
      ],
    );
    window.TabBar.openMenu(x, y, (menu, mi) =>
      items.forEach(([text, fn, icon]) =>
        mi(menu, {
          label: text,
          svg: icon,
          disabled: text.includes("远程") && !connected(c),
          danger: text === "删除",
          onClick: guard(fn),
        }),
      ),
    );
  }
  async function copyEntry(source, sourceSide, e, target, targetSide, move, targetPath = target[targetSide].path) {
    if (sourceSide !== targetSide) {
      if (move) throw new Error("跨栏请先传输，确认完成后再删除源文件");
      return enqueue(source, sourceSide, [e], target, targetSide, targetPath);
    }
    if (sourceSide === "remote" && source.id !== target.id)
      throw new Error("不同 SSH 会话之间请通过本地目录中转");
    const to = join(targetPath, e.name, targetSide);
    if (to === e.path) throw new Error("目标和源路径相同");
    await invoke(target, targetSide, "copy", {
      from: e.path,
      to,
      moveItem: move,
    });
    await load(target, targetSide, target[targetSide].path, false);
    if (move) await load(source, sourceSide, source[sourceSide].path, false);
  }
  async function paste(c, side) {
    if (!clipboard) return;
    const clip = clipboard;
    for (const e of clip.entries)
      await copyEntry(clip.context, clip.side, e, c, side, clip.move);
    if (clip.move) clipboard = null;
  }
  async function chmod(c, e) {
    if (e.permissions == null) throw new Error("服务器未提供权限信息");
    const special = e.permissions & 0o7000;
    const readMode = (el) => [...el.querySelectorAll("input:checked")].reduce(
      (n, input) => n | Number(input.dataset.bit), special,
    );
    const rows = ["所有者", "用户组", "其他"],
      body = `<p>${esc(e.path)}</p><div class="sftp-permission-grid"><span></span><span>读</span><span>写</span><span>执行</span>${rows.map((r, i) => `<span>${r}</span>${[4, 2, 1].map((bit) => `<input type="checkbox" aria-label="${r}${{ 4: "读", 2: "写", 1: "执行" }[bit]}" data-bit="${bit << ((2 - i) * 3)}"${e.permissions & (bit << ((2 - i) * 3)) ? " checked" : ""}>`).join("")}`).join("")}</div><p>八进制权限：<output data-mode></output>${special ? " · 保留特殊权限位" : ""}</p>`;
    const mode = await dialog("修改权限", body, [
      ["取消", null],
      [
        "保存",
        readMode,
        "primary",
      ],
    ], { setup(el) {
      const update = () => el.querySelector("[data-mode]").textContent = readMode(el).toString(8).padStart(4, "0");
      el.addEventListener("change", update);
      update();
    } });
    if (mode != null) {
      await invoke(c, "remote", "chmod", { path: e.path, mode });
      await load(c, "remote", c.remote.path, false);
    }
  }
  async function preview(c, side, e) {
    const file = await invoke(c, side, "read_file", { path: e.path });
    if (modalClose) modalClose();
    if (root.querySelector(".sftp-modal")) return;
    const overlay = document.createElement("div");
    overlay.className = "sftp-modal";
    overlay.innerHTML = `<section class="sftp-modal-box sftp-editor" role="dialog" aria-modal="true" aria-label="${esc(e.name)}"><h3>${esc(e.name)}</h3><p>${esc(e.path)} · ${size(file.size)}</p>${file.kind === "image" ? `<img alt="${esc(e.name)}">` : '<textarea aria-label="文件内容" spellcheck="false"></textarea>'}<span class="sftp-modal-error" hidden></span><div class="sftp-modal-actions"><button data-close>关闭</button>${file.kind === "text" ? '<button class="primary" data-save>保存</button>' : ""}</div></section>`;
    root.appendChild(overlay);
    const close = async () => {
      if (
        file.kind === "text" &&
        overlay.querySelector("textarea").value !== file.content
      ) {
        const yes = window.confirm("放弃尚未保存的修改？");
        if (!yes) return;
      }
      overlay.remove();
      if (modalClose === close) modalClose = null;
      Panel.onSessionChange();
    };
    modalClose = close;
    if (file.kind === "image") overlay.querySelector("img").src = file.content;
    else overlay.querySelector("textarea").value = file.content;
    overlay.querySelector("[data-close]").onclick = close;
    overlay.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") close();
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        overlay.querySelector("[data-save]")?.click();
      }
    };
    const saveButton = overlay.querySelector("[data-save]");
    if (saveButton)
      saveButton.onclick = async () => {
        saveButton.disabled = true;
        const content = overlay.querySelector("textarea").value;
        try {
          const args = {
            path: e.path,
            content,
            expectedModified: file.modified,
            expectedRevision: file.revision,
            force: false,
          };
          try {
            await invoke(c, side, "write_file", args);
          } catch (err) {
            if (
              /changed|conflict|已.*修改|变化|冲突/i.test(String(err)) &&
              window.confirm("文件已被外部程序修改。确认覆盖最新内容？")
            )
              await invoke(c, side, "write_file", { ...args, force: true });
            else throw err;
          }
          const updated = await invoke(c, side, "read_file", { path: e.path });
          Object.assign(file, updated);
          toast("已保存", "ok");
          record({
            name: e.name,
            direction: "edit",
            status: "completed",
            source: e.path,
            target: e.path,
            done: file.size,
            total: file.size,
          });
          await load(c, side, c[side].path, false);
        } catch (err) {
          const msg = overlay.querySelector(".sftp-modal-error");
          msg.hidden = false;
          msg.textContent = String(err);
        } finally {
          saveButton.disabled = false;
        }
      };
  }
  async function bookmarks(c, side) {
    const list = prefs().bookmarks.filter(
      (b) =>
        b.side === side && (b.scope === "global" || b.connection === c.key),
    );
    const body = `<div class="sftp-bookmarks">${list.map((b, i) => `<div class="sftp-bookmark"><button data-bookmark="${i}" title="${esc(b.path)}">${esc(b.name)} <small>· ${b.scope === "global" ? "全局" : "当前连接"}</small></button><button data-delete="${i}" aria-label="删除书签">${svg("x")}</button></div>`).join("") || "<p>尚无书签</p>"}</div><input type="text" aria-label="书签名称" value="${esc(basename(c[side].path) || "主目录")}"><label><input type="checkbox" data-global> 所有连接可用</label>`;
    const pending = dialog("目录书签", body, [
      ["关闭", null],
      [
        "收藏当前目录",
        (el) => ({
          name: el.querySelector('input[type="text"]').value.trim() || "目录",
          path: c[side].path,
          side,
          scope: el.querySelector("[data-global]").checked
            ? "global"
            : "connection",
          connection: c.key,
        }),
        "primary",
      ],
    ]);
    const modal = root.querySelector(".sftp-modal:last-child");
    modal.querySelectorAll("[data-bookmark]").forEach(
      (b) =>
        (b.onclick = () => {
          const item = list[Number(b.dataset.bookmark)];
          modalClose();
          load(c, side, item.path);
        }),
    );
    modal.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = () => {
          prefs().bookmarks = prefs().bookmarks.filter(
            (x) => x !== list[Number(b.dataset.delete)],
          );
          save();
          b.parentElement.remove();
        }),
    );
    const value = await pending;
    if (value) {
      prefs().bookmarks.push(value);
      save();
      toast("书签已保存", "ok");
    }
  }
  function record(task) {
    prefs().history.unshift({
      name: task.name,
      direction: task.direction,
      status: task.status,
      source: task.source,
      target: task.target,
      done: task.done,
      total: task.total,
      error: task.error || "",
      time: Date.now(),
    });
    prefs().history = prefs().history.slice(0, 200);
    save();
  }
  async function enqueue(source, side, entries, target, destSide, targetPath = target[destSide].path) {
    const remote = side === "local" ? target : source;
    if (!connected(remote)) throw new Error("传输需要已连接的 SSH 会话");
    if (side === destSide) throw new Error("跨栏传输需要本地与远程两栏");
    for (const e of entries) {
      const dest = join(targetPath, e.name, destSide),
        from = e.path,
        key = `${remote.id}|${side}|${from}|${dest}`;
      if (
        tasks.some(
          (t) =>
            t.key === key &&
            !["completed", "cancelled", "failed", "skipped"].includes(t.status),
        )
      ) {
        toast("该传输已在队列中");
        continue;
      }
      tasks.push({
        id: uuid(),
        key,
        sessionId: remote.id,
        context: remote,
        sourceContext: source,
        targetContext: target,
        sourceSide: side,
        targetSide: destSide,
        source: from,
        target: dest,
        name: e.name,
        direction: side === "local" ? "up" : "down",
        isDir: e.is_dir,
        done: 0,
        total: e.is_dir ? 0 : e.size || 0,
        status: "queued",
        policy: null,
        started: 0,
        speed: 0,
      });
    }
    renderQueue();
    pump();
  }
  async function conflictPolicy(task) {
    const exists = await invoke(task.targetContext, task.targetSide, "stat", {
      path: task.target,
    });
    if (!exists) return "skip";
    if (task.policy) return task.policy;
    if (!Panel.isOpen()) await Panel.open();
    return (
      (await dialog(
        "目标已存在",
        `<p>${task.direction === "up" ? "上传" : "下载"}：${esc(task.name)}\n目标：${esc(task.target)}\n目标大小：${size(exists.size || 0)} · ${date(exists.modified ?? exists.mtime)}</p><p>${task.isDir ? "覆盖会合并目录并替换内部同名文件；跳过会跳过整个目录，保留两份会使用新目录名。" : "请选择处理方式。"}</p>`,
        [
          ["取消传输", "cancel"],
          ["跳过", "skip"],
          ["保留两份", "rename"],
          ["覆盖", "overwrite", "danger"],
        ],
        { locked: true },
      )) || "cancel"
    );
  }
  async function runTask(task) {
    try {
      const previous = conflictChain;
      let unlock;
      conflictChain = new Promise((resolve) => (unlock = resolve));
      await previous;
      try {
        if (task.status === "cancelled") return;
        task.policy = await conflictPolicy(task);
      } finally {
        unlock();
      }
      if (task.policy === "cancel") {
        task.status = "cancelled";
        return;
      }
      if (task.status === "paused")
        await new Promise((resolve) => (task.resumeWaiter = resolve));
      if (task.status === "cancelled") return;
      task.status = "running";
      task.started = Date.now();
      renderQueue();
      await T.invoke("sftp_transfer_start", {
        id: task.sessionId,
        transferId: task.id,
        local: task.direction === "up" ? task.source : task.target,
        remote: task.direction === "up" ? task.target : task.source,
        upload: task.direction === "up",
        policy: task.policy,
      });
      if (!["cancelled", "skipped"].includes(task.status))
        task.status = "completed";
      await Promise.all([
        load(
          task.sourceContext,
          task.sourceSide,
          task.sourceContext[task.sourceSide].path,
          false,
        ),
        load(
          task.targetContext,
          task.targetSide,
          task.targetContext[task.targetSide].path,
          false,
        ),
      ]);
    } catch (e) {
      if (task.status === "cancelling" || /cancel/i.test(String(e)))
        task.status = "cancelled";
      else {
        task.status = "failed";
        task.error = String(e);
        toast("传输失败：" + task.name + " · " + e, "err");
      }
    } finally {
      record(task);
      renderQueue();
    }
  }
  function pump() {
    while (activeWorkers < prefs().concurrency) {
      const t = tasks.find((t) => t.status === "queued" && !t.claimed);
      if (!t) break;
      t.claimed = true;
      activeWorkers++;
      runTask(t).finally(() => {
        activeWorkers--;
        pump();
      });
    }
  }
  async function control(task, action) {
    if (!task.started) {
      task.status =
        action === "cancel"
          ? "cancelled"
          : action === "pause"
            ? "paused"
            : "queued";
      if (action !== "pause") {
        task.resumeWaiter?.();
        task.resumeWaiter = null;
      }
      if (action === "cancel" && !task.claimed) record(task);
      renderQueue();
      pump();
      return;
    }
    task.status =
      action === "cancel"
        ? "cancelling"
        : action === "pause"
          ? "pausing"
          : "running";
    renderQueue();
    await T.invoke("sftp_transfer_control", { transferId: task.id, action });
  }
  function renderQueue() {
    if (!root) return;
    const queue = root.querySelector(".sftp-queue");
    if (!queue) return;
    const shown = tasks.slice(-40);
    queue.hidden = !shown.length;
    if (!shown.length) return;
    queue.innerHTML = `<div class="sftp-queue-head"><b>传输队列 · ${tasks.filter((t) => ["queued", "preparing", "running", "paused", "pausing"].includes(t.status)).length} 项进行中</b><button data-clear>清除已完成</button></div>${shown
      .map((t) => {
        const pct = t.total
          ? Math.min(100, (t.done / t.total) * 100)
          : t.status === "completed"
            ? 100
            : 0;
        return `<div class="sftp-queue-row" data-task="${esc(t.id)}"><div class="sftp-queue-name" title="${esc(t.source + " → " + t.target)}">${t.direction === "up" ? "↑" : "↓"} ${esc(t.name)}<div class="sftp-progress"><i style="width:${pct}%"></i></div></div><span>${size(t.done)} / ${t.total ? size(t.total) : "计算中"}</span><span class="sftp-queue-speed sftp-status ${t.status}" title="${esc(t.error || "")}">${label[t.status] || t.status}${t.status === "running" && t.speed ? " · " + size(t.speed) + "/s" : ""}</span><div class="sftp-queue-buttons">${["preparing", "running", "queued", "paused", "pausing"].includes(t.status) ? button(t.status === "paused" ? "resume" : "pause", t.status === "paused" ? "play" : "pause", t.status === "paused" ? "继续" : "暂停") + button("cancel", "x", "取消") : t.status === "failed" ? button("retry", "refresh", "重试") : ""}</div></div>`;
      })
      .join("")}`;
    queue.querySelector("[data-clear]").onclick = () => {
      for (let i = tasks.length - 1; i >= 0; i--)
        if (["completed", "cancelled", "skipped"].includes(tasks[i].status))
          tasks.splice(i, 1);
      renderQueue();
    };
    queue.querySelectorAll("[data-task] [data-action]").forEach(
      (b) =>
        (b.onclick = guard(() => {
          const t = tasks.find(
            (t) => t.id === b.closest("[data-task]").dataset.task,
          );
          if (b.dataset.action === "retry") {
            t.id = uuid();
            t.status = "queued";
            t.claimed = false;
            t.done = 0;
            t.started = 0;
            t.speed = 0;
            t.resumeWaiter = null;
            t.error = "";
            renderQueue();
            pump();
          } else return control(t, b.dataset.action);
        })),
    );
  }
  async function historyDialog() {
    await dialog(
      "传输记录",
      `<select aria-label="筛选传输记录"><option value="all">全部记录</option><option value="completed">成功</option><option value="failed">失败</option></select><div class="sftp-bookmarks" data-log></div>`,
      [
        ["关闭", null],
        [
          "导出 JSON",
          () => {
            downloadJson("hurricaneTerm-sftp-history.json", prefs().history);
            return null;
          },
        ],
      ],
    );
  }
  function downloadJson(name, data) {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function settingsDialog() {
    const p = prefs(),
      result = await dialog(
        "文件管理设置",
        `<label>布局 <select data-pref="layout">${[
          ["auto", "自适应"],
          ["horizontal", "左右双栏"],
          ["vertical", "上下双栏"],
          ["single", "远程单栏"],
        ]
          .map(
            ([v, t]) =>
              `<option value="${v}"${p.layout === v ? " selected" : ""}>${t}</option>`,
          )
          .join(
            "",
          )}</select></label><label>传输并发 <input type="number" min="1" max="10" data-pref="concurrency" value="${p.concurrency}"></label><label><input type="checkbox" data-pref="showHidden"${p.showHidden ? " checked" : ""}> 显示隐藏文件</label><label><input type="checkbox" data-pref="zebra"${p.zebra ? " checked" : ""}> 列表斑马纹</label><p>界面颜色跟随主主题；传输通过 SFTP 执行。</p>`,
        [
          ["取消", null],
          [
            "保存",
            (el) => ({
              layout: el.querySelector('[data-pref="layout"]').value,
              concurrency: Math.max(
                1,
                Math.min(
                  10,
                  Number(el.querySelector('[data-pref="concurrency"]').value) ||
                    2,
                ),
              ),
              showHidden: el.querySelector('[data-pref="showHidden"]').checked,
              zebra: el.querySelector('[data-pref="zebra"]').checked,
            }),
            "primary",
          ],
        ],
      );
    if (result) {
      Object.assign(p, result);
      save();
      renderShell();
      pump();
    }
  }
  const Panel = {
    mount(el) {
      root = el;
      if (!root) return;
      root.hidden = true;
      root.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape" && dragSelection) {
          ev.stopPropagation();
          ev.preventDefault();
          cancelDrag();
          return;
        }
        if (ev.key === "Escape" && !ev.target.closest(".sftp-modal")) {
          ev.stopPropagation();
          this.close();
        }
      });
      root.addEventListener("pointermove", moveDrag);
      root.addEventListener("pointerup", guard(finishDrag));
      root.addEventListener("pointercancel", cancelDrag);
      window.addEventListener("pointerup", guard(finishDrag));
      window.addEventListener("blur", cancelDrag);
      window.addEventListener("resize", layout);
      const view = window.__TAURI__?.webview?.getCurrentWebview?.();
      if (view?.onDragDropEvent)
        view
          .onDragDropEvent(
            guard(async (event) => {
              // Native callbacks must not reinterpret an internal pointer drag
              // as an external file drop or enqueue it a second time.
              if (!this.isOpen() || dragSelection) return;
              const p = event.payload;
              if (p.type === "leave") {
                clearDropTargets();
                return;
              }
              const position = p.position || {},
                target = dropTarget(
                  position.x / (window.devicePixelRatio || 1),
                  position.y / (window.devicePixelRatio || 1),
                );
              highlightDrop(target);
              if (!target) return;
              if (p.type === "over" || p.type === "enter") {
                return;
              }
              if (p.type === "drop") {
                clearDropTargets();
                // Capture the pane, session and folder before asynchronous
                // stat calls; navigation must not redirect a pending drop.
                const { context: c, side, path: targetPath } = target,
                  generation = dropGeneration;
                const entries = [];
                for (const path of new Set(p.paths || [])) {
                  const e = await T.invoke("fs_stat", { path });
                  if (e) entries.push(e);
                }
                if (!this.isOpen() || generation !== dropGeneration || root.querySelector(".sftp-modal")) return;
                if (side === "remote")
                  await enqueue(c, "local", entries, c, "remote", targetPath);
                else
                  for (const e of entries)
                    await copyEntry(c, "local", e, c, "local", false, targetPath);
              }
            }),
          )
          .then((fn) => (nativeUnlisten = fn))
          .catch((e) => toast("系统文件拖入不可用：" + e, "err"));
    },
    async open() {
      if (this.isOpen() && root.querySelector(".sftp-modal")) return;
      if (!root) return;
      if (window.Home) Home.hide();
      if (window.Settings?.isOpen()) Settings.close();
      if (window.Profiles?.isOpen()) Profiles.close();
      current = bind(T.term.activeTab());
      root.hidden = false;
      renderShell();
      await Promise.all([
        load(current, "local", current.local.path),
        load(
          current,
          "remote",
          prefs().pathMode === "sync" && current.tab?.cwd
            ? current.tab.cwd
            : current.remote.path,
        ),
      ]);
    },
    hide() {
      dropGeneration++;
      cancelDrag();
      if (modalClose) {
        const close = modalClose;
        close();
        if (root.querySelector(".sftp-modal")) return false;
      }
      if (root) root.hidden = true;
      return true;
    },
    close() {
      if (!this.hide()) return false;
      if (!T.term.order.length && window.Home) Home.show();
      else T.term.activeTab()?.term.focus();
      return true;
    },
    toggle() {
      return this.isOpen() ? this.close() : this.open();
    },
    isOpen: () => !!(root && !root.hidden),
    onSessionChange() {
      if (
        this.isOpen() &&
        current?.id !== T.term.activeTab()?.id &&
        !root.querySelector(".sftp-modal")
      ) {
        current = bind(T.term.activeTab());
        renderShell();
        load(current, "local", current.local.path);
        load(current, "remote", current.remote.path);
      }
    },
    syncCwd(id, path) {
      const c = contexts.get(id);
      if (!c || prefs().pathMode !== "sync" || !path?.startsWith("/")) return;
      if (c.remote.path !== path && current === c && this.isOpen())
        load(c, "remote", path);
      else c.remote.path = path;
    },
    progress(data) {
      try {
        const p = typeof data === "string" ? JSON.parse(data) : data,
          t = tasks.find(
            (t) => t.id === p.transferId && t.sessionId === p.sessionId,
          );
        if (!t) return;
        t.done = p.done || 0;
        t.total = p.total || 0;
        if (p.status) t.status = p.status;
        if (p.error) t.error = p.error;
        const seconds = (Date.now() - t.started) / 1000;
        t.speed = seconds > 0 ? t.done / seconds : 0;
        renderQueue();
      } catch (e) {
        toast("传输进度解析失败：" + e, "err");
      }
    },
    // Public state/API makes integration tests exercise the same paths as the UI.
    refresh: () =>
      current &&
      Promise.all([
        load(current, "local", current.local.path, false),
        load(current, "remote", current.remote.path, false),
      ]),
    get context() {
      return current;
    },
    get tasks() {
      return tasks;
    },
    join,
    parent,
    size,
    permissions,
    enqueue,
    control,
    preview,
  };
  // Populate log after dialog creation without rendering untrusted names as HTML.
  const originalHistory = historyDialog;
  historyDialog = async function () {
    const pending = originalHistory();
    const overlay = root.querySelector(".sftp-modal:last-child");
    if (overlay) {
      const select = overlay.querySelector("select"),
        list = overlay.querySelector("[data-log]");
      const render = () =>
        (list.innerHTML =
          prefs()
            .history.filter(
              (x) => select.value === "all" || x.status === select.value,
            )
            .map(
              (x) =>
                `<div class="sftp-history-row">${esc(x.name)} · ${esc(label[x.status] || x.status)}<br><span class="dim">${new Date(x.time).toLocaleString()} · ${esc(x.source)} → ${esc(x.target)}</span>${x.error ? "<br>" + esc(x.error) : ""}</div>`,
            )
            .join("") || "<p>暂无传输记录</p>");
      select.onchange = render;
      render();
    }
    return pending;
  };
  window.SftpPanel = Panel;
})();
