/* hurricaneTerm — Markdown tokens rendered as safe DOM, without HTML sinks. */
(function () {
  let parser, parserFactory;
  const tags = {
    paragraph: 'p', blockquote: 'blockquote', bullet_list: 'ul', ordered_list: 'ol', list_item: 'li',
    em: 'em', strong: 'strong', s: 's', table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td',
  };
  const attribute = (token, name) => typeof token.attrGet === 'function' ? token.attrGet(name) : null;

  function getParser() {
    const factory = window.markdownit;
    if (typeof factory !== 'function') throw new Error('Markdown parser unavailable');
    if (parserFactory !== factory) {
      const candidate = factory({ html: false, linkify: false, typographer: false, breaks: false });
      if (!candidate || typeof candidate.parse !== 'function') throw new Error('Invalid Markdown parser');
      parser = candidate; parserFactory = factory;
    }
    return parser;
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || !value || /[\x00-\x20\x7f]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function anchor(document, token) {
    const href = safeUrl(attribute(token, 'href'));
    const link = document.createElement(href ? 'a' : 'span');
    if (href) { link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else link.className = 'ai-link-disabled';
    const title = attribute(token, 'title'); if (title) link.title = title;
    return link;
  }

  function altText(tokens) {
    return (tokens || []).map(token => token.children ? altText(token.children)
      : ['text', 'code_inline', 'html_inline'].includes(token.type) ? token.content
      : ['softbreak', 'hardbreak'].includes(token.type) ? ' ' : '').join('');
  }

  function closedFence(token, sourceLines) {
    if (token.type !== 'fence' || !Array.isArray(token.map) || token.map.length !== 2) return false;
    if (!/^(?:`{3,}|~{3,})$/.test(token.markup || '')) return false;
    const lastLine = sourceLines[token.map[1] - 1] || '';
    const closer = new RegExp('^[ \\t>]*' + token.markup[0] + '{' + token.markup.length + ',}[ \\t]*$');
    if (!closer.test(lastLine)) return false;
    // map includes opening/closing lines; content has only body lines, including
    // an EOF body line without LF. Implicit EOF closure has only one extra line.
    // Container prefixes are already handled by the parser, not guessed here.
    const body = String(token.content || '');
    const bodyLines = (body.match(/\n/g) || []).length + (body && !body.endsWith('\n') ? 1 : 0);
    return token.map[1] - token.map[0] === bodyLines + 2;
  }

  function codeBlock(document, token, host, options, sourceLines) {
    const block = document.createElement('div'); block.className = 'ai-code';
    const info = String(token.info || '').trim();
    const language = (info.split(/\s+/)[0] || '').slice(0, 64);
    // Closed fences/indented code have a structural final LF. For an open
    // streamed fence, preserve its actual final newline (or lack of one).
    const rawCode = String(token.content || '');
    const code = token.type === 'code_block' || closedFence(token, sourceLines) ? rawCode.replace(/\n$/, '') : rawCode;
    const bar = document.createElement('div'); bar.className = 'ai-code-bar';
    bar.append(document.createTextNode(info.slice(0, 120) || '代码'));
    const actions = document.createElement('span');
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.dataset.aiCopyCode = '';
    copy.disabled = typeof options.onCopyCode !== 'function';
    copy.onclick = () => { if (host.isConnected && host.contains(block) && typeof options.onCopyCode === 'function') options.onCopyCode(code, language); };
    actions.append(copy);
    const canInsert = () => {
      if (options.complete !== true || !closedFence(token, sourceLines) || typeof options.onInsertCode !== 'function' || typeof options.canInsertCode !== 'function') return false;
      try { return options.canInsertCode(code, language) === true; } catch (_) { return false; }
    };
    if (canInsert()) {
      const insert = document.createElement('button'); insert.type = 'button'; insert.textContent = '插入终端'; insert.dataset.aiInsert = '';
      insert.title = '仅插入当前已连接终端，不执行，不同步到其他标签';
      insert.onclick = () => { if (host.isConnected && host.contains(block) && canInsert()) options.onInsertCode(code, language); };
      actions.append(insert);
    }
    bar.append(actions);
    const pre = document.createElement('pre'), content = document.createElement('code'); content.textContent = code;
    if (language) content.dataset.language = language;
    pre.append(content); block.append(bar, pre); return block;
  }

  function renderTokens(tokens, parent, host, options, sourceLines) {
    const document = host.ownerDocument, stack = [parent];
    for (const token of tokens) {
      if (!token || token.hidden) continue;
      const current = stack[stack.length - 1];
      if (token.type === 'inline') { renderTokens(token.children || [], current, host, options, sourceLines); continue; }
      if (['text', 'html_inline', 'html_block'].includes(token.type)) { current.append(document.createTextNode(token.content || '')); continue; }
      if (token.type === 'softbreak') { current.append(document.createTextNode('\n')); continue; }
      if (token.type === 'hardbreak' || token.type === 'hr') { current.append(document.createElement(token.type === 'hr' ? 'hr' : 'br')); continue; }
      if (token.type === 'code_inline') { const node = document.createElement('code'); node.textContent = token.content; current.append(node); continue; }
      if (token.type === 'fence' || token.type === 'code_block') { current.append(codeBlock(document, token, host, options, sourceLines)); continue; }
      if (token.type === 'image') {
        // Images are never assigned a src: remote content loads only after the
        // user follows an explicit safe link in their browser.
        const placeholder = document.createElement('span'); placeholder.className = 'ai-image-placeholder';
        placeholder.textContent = '[图片：' + (altText(token.children) || token.content || '未提供说明') + ']';
        const href = safeUrl(attribute(token, 'src'));
        if (href && !current.closest?.('a')) {
          const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看图片';
          placeholder.append(document.createTextNode(' '), link);
        }
        current.append(placeholder); continue;
      }
      if (token.type.endsWith('_close')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.type.endsWith('_open')) {
        const kind = token.type.slice(0, -5);
        let node;
        if (kind === 'link') node = anchor(document, token);
        else {
          const tag = kind === 'heading' && /^h[1-6]$/.test(token.tag) ? token.tag : tags[kind];
          if (!tag) { stack.push(current); continue; }
          node = document.createElement(tag);
          if (kind === 'ordered_list') {
            const start = attribute(token, 'start');
            if (/^[1-9]\d{0,8}$/.test(start || '')) node.setAttribute('start', start);
          }
          if (kind === 'th') node.setAttribute('scope', 'col');
          if (kind === 'th' || kind === 'td') {
            const alignment = /^text-align:\s*(left|right|center)\s*;?$/.exec(attribute(token, 'style') || '');
            if (alignment) node.style.textAlign = alignment[1];
          }
        }
        if (kind === 'table') {
          const wrapper = document.createElement('div'); wrapper.className = 'ai-table-wrap'; wrapper.append(node); current.append(wrapper);
        } else current.append(node);
        stack.push(node); continue;
      }
      if (token.content) current.append(document.createTextNode(token.content));
    }
  }

  function render(host, text, options = {}) {
    const value = String(text ?? '');
    try {
      const tokens = getParser().parse(value, {});
      if (!Array.isArray(tokens)) throw new Error('Invalid Markdown tokens');
      const fragment = host.ownerDocument.createDocumentFragment();
      renderTokens(tokens, fragment, host, options || {}, value.replace(/\r\n?/g, '\n').split('\n'));
      host.replaceChildren(fragment); return true;
    } catch (_) { host.textContent = value; return false; }
  }

  window.AiMarkdown = Object.freeze({ render });
})();
