/* Trusted, built-in AI plugins and a durable event projection. This is not a
 * network plugin loader. Native persistence acknowledges every side effect. */
(function () {
  'use strict';
  const MAX_METADATA = 64 * 1024, MAX_EVENT = 256 * 1024, MAX_RECORD = 16 * 1024 * 1024;
  const MAX_EVENTS = 4096, MAX_MESSAGES = 64, MAX_IDENTITY = 64 * 1024, MAX_REDACT_DEPTH = 64;
  const KINDS = new Set(['session/start', 'turn/start', 'history/replace', 'step/start', 'assistant/message',
    'tool/call', 'tool/dispatch', 'tool/approval', 'tool/result', 'step/end', 'turn/end', 'session/resume']);
  const encoder = new TextEncoder();
  const size = value => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
  const fail = message => { throw new Error('AI Harness: ' + message); };
  const text = (value, label, maximum = 65536, empty = false) => {
    if (typeof value !== 'string' || (!empty && !value.length) || size(value) > maximum) fail(label + ' 无效');
    return value;
  };
  const keyText = value => text(value, '名称', 256);
  const sessionId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) fail('会话编号无效'); return value; };
  const SECRET_FIELDS = new Set(['apikey', 'password', 'passwd', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'privatekey', 'secret', 'embeddingkey']);
  const clone = value => JSON.parse(JSON.stringify(value));
  function stable(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || seen.has(value)) fail('身份必须是有限的 JSON 数据');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(item => stable(item, seen));
    else {
      result = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) result[key] = stable(value[key], seen);
      }
    }
    seen.delete(value);
    return result;
  }
  const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

  function createRuntime() {
    const records = new Map(), services = new Map(), hooks = new Map();
    let closed = false, mutating = false, leases = 0;
    const live = () => { if (closed) fail('运行时已关闭'); };
    const begin = () => { live(); if (mutating || leases) fail('运行中的插件不可变更'); mutating = true; };
    const lookup = name => { live(); if (!services.has(name)) fail('未注册服务 ' + name); return services.get(name).value; };
    async function dispose(record) {
      record.active = false;
      const errors = [];
      for (const effect of record.effects.slice().reverse()) {
        try { await effect(); } catch (error) { errors.push(error); }
      }
      records.delete(record.id);
      if (errors.length) throw new AggregateError(errors, 'AI Harness 插件清理失败: ' + record.id);
    }
    function context(record) {
      const add = disposer => {
        if (!record.active || typeof disposer !== 'function') fail('插件 scope 已撤销或清理函数无效');
        let active = true;
        const once = () => { if (!active) return; active = false; return disposer(); };
        record.effects.push(once); return once;
      };
      return Object.freeze({
        service: lookup,
        provide(name, value) {
          keyText(name); if (!record.active) fail('插件 scope 已撤销');
          if (services.has(name)) fail('服务重名 ' + name);
          const entry = { value, owner: record.id }; services.set(name, entry); record.services.add(name);
          return add(() => { if (services.get(name) === entry) services.delete(name); record.services.delete(name); });
        },
        on(name, handler) {
          keyText(name); if (!record.active || typeof handler !== 'function') fail('事件监听器无效');
          const entry = { handler, record, active: true }, entries = hooks.get(name) || [];
          entries.push(entry); hooks.set(name, entries);
          return add(() => {
            entry.active = false;
            const current = hooks.get(name); if (!current) return;
            const index = current.indexOf(entry); if (index >= 0) current.splice(index, 1);
            if (!current.length) hooks.delete(name);
          });
        },
        effect: add,
      });
    }
    const runtime = {
      async mountAll(plugins) {
        begin(); const mounted = [];
        try {
          if (!Array.isArray(plugins)) fail('插件列表无效');
          const batch = new Map();
          for (const plugin of plugins) {
            if (!object(plugin) || typeof plugin.setup !== 'function') fail('插件定义无效');
            keyText(plugin.id);
            if (records.has(plugin.id) || batch.has(plugin.id)) fail('插件重名 ' + plugin.id);
            const requires = plugin.requires === undefined ? [] : plugin.requires;
            if (!Array.isArray(requires) || requires.some(value => typeof value !== 'string' || !value.length)
              || new Set(requires).size !== requires.length) fail('插件依赖无效 ' + plugin.id);
            batch.set(plugin.id, { id: plugin.id, setup: plugin.setup, requires: requires.slice() });
          }
          const order = [], visiting = new Set(), visited = new Set();
          const visit = id => {
            if (visited.has(id) || records.has(id)) return;
            if (visiting.has(id)) fail('插件循环依赖 ' + id);
            const entry = batch.get(id); if (!entry) fail('未知插件依赖 ' + id);
            visiting.add(id); entry.requires.forEach(visit); visiting.delete(id); visited.add(id); order.push(entry);
          };
          batch.forEach((_, id) => visit(id));
          for (const { id, setup, requires } of order) {
            const record = { id, requires, effects: [], services: new Set(), active: true };
            records.set(record.id, record); mounted.push(record);
            await setup(context(record));
          }
        } catch (error) {
          const errors = [];
          for (const record of mounted.reverse()) { try { await dispose(record); } catch (cleanup) { errors.push(cleanup); } }
          if (errors.length) throw new AggregateError([error, ...errors], 'AI Harness 插件装载与回滚失败');
          throw error;
        } finally { mutating = false; }
      },
      service: lookup,
      async dispatch(name, data) {
        keyText(name); const release = runtime.acquire();
        try {
          for (const entry of (hooks.get(name) || []).slice()) {
            if (entry.active && entry.record.active) await entry.handler(data);
          }
        } finally { release(); }
      },
      acquire() {
        live(); if (mutating) fail('插件正在变更'); leases++;
        let released = false;
        return () => { if (!released) { released = true; leases--; } };
      },
      async unmount(id) {
        begin();
        try {
          const record = records.get(id); if (!record) fail('未知插件 ' + id);
          for (const candidate of records.values()) if (candidate.requires.includes(id)) fail('插件仍被依赖 ' + candidate.id);
          await dispose(record);
        } finally { mutating = false; }
      },
      async close() {
        if (closed) return;
        begin(); const errors = [];
        try {
          for (const record of [...records.values()].reverse()) { try { await dispose(record); } catch (error) { errors.push(error); } }
          closed = true;
          if (errors.length) throw new AggregateError(errors, 'AI Harness 运行时清理失败');
        } finally { mutating = false; }
      },
      plugins() { return [...records.values()].map(record => ({ id: record.id, requires: record.requires.slice(), services: [...record.services] })); },
    };
    return Object.freeze(runtime);
  }

  function message(value) {
    if (!object(value) || !['system', 'user', 'assistant', 'tool'].includes(value.role)) fail('消息角色无效');
    const result = { role: value.role };
    if (value.content !== null && typeof value.content !== 'string') fail('消息内容无效');
    result.content = value.content;
    if (value.role === 'tool') {
      keyText(value.toolCallId); if (typeof value.content !== 'string') fail('工具结果必须是字符串');
      result.toolCallId = value.toolCallId;
    } else if (own(value, 'toolCallId')) fail('非工具消息包含工具结果编号');
    if (own(value, 'toolCalls')) {
      if (value.role !== 'assistant' || !Array.isArray(value.toolCalls) || value.toolCalls.length > 32) fail('工具调用列表无效');
      const seen = new Set();
      result.toolCalls = value.toolCalls.map(call => {
        if (!object(call)) fail('工具调用无效');
        keyText(call.id); keyText(call.name); text(call.arguments, '工具参数', MAX_EVENT, true);
        if (seen.has(call.id)) fail('工具调用编号重复'); seen.add(call.id);
        return { id: call.id, name: call.name, arguments: call.arguments };
      });
    }
    return result;
  }
  function targetData(value) {
    if (!object(value) || !/^[a-f0-9]{64}$/i.test(value.identity || '')) fail('目标指纹无效');
    for (const key of ['protocol', 'host', 'user', 'title']) text(value[key], '目标 ' + key, 4096, key !== 'protocol');
    if (value.port !== null && (!integer(value.port, 0) || value.port > 65535)) fail('目标端口无效');
    return { identity: value.identity.toLowerCase(), protocol: value.protocol, host: value.host, user: value.user,
      port: value.port, title: value.title };
  }
  function payload(kind, data) {
    if (!KINDS.has(kind) || !object(data)) fail('未知事件或事件内容无效');
    let result = clone(data);
    if (kind === 'history/replace') {
      if (!Array.isArray(data.messages) || data.messages.length > MAX_MESSAGES) fail('历史消息数量超限');
      result.messages = data.messages.map(message);
      for (const key of ['compactions', 'rounds', 'commands']) if (own(data, key) && !integer(data[key])) fail('历史计数无效');
    } else if (kind === 'assistant/message') {
      result.message = message(data.message); if (result.message.role !== 'assistant') fail('助手事件角色无效');
    } else if (kind === 'tool/result') {
      result.message = message(data.message); if (result.message.role !== 'tool') fail('工具结果角色无效');
    } else if (kind === 'step/start') {
      if (!integer(data.round, 1)) fail('步骤计数无效');
    } else if (kind === 'tool/call' || kind === 'tool/dispatch') {
      keyText(data.callId); if (kind === 'tool/call' || own(data, 'name')) keyText(data.name);
      if (own(data, 'requestId')) keyText(data.requestId);
      if (own(data, 'index') && !integer(data.index, 1)) fail('工具执行计数无效');
    } else if (kind === 'tool/approval') {
      keyText(data.callId); if (typeof data.accepted !== 'boolean') fail('工具确认结果无效'); keyText(data.kind);
    } else if (kind === 'turn/end') {
      keyText(data.status); text(data.summary, '任务结果', MAX_EVENT, true);
    } else if (kind === 'turn/start') text(data.goal, '任务目标', MAX_METADATA, true);
    else if (kind === 'session/resume') result.target = targetData(data.target);
    else if (kind === 'step/end' && own(data, 'round') && !integer(data.round, 1)) fail('步骤计数无效');
    if (size({ kind, data: result }) > MAX_EVENT) fail('事件大小超限');
    return result;
  }
  function event(value, expected) {
    if (!object(value) || value.seq !== expected) fail('事件序号不连续');
    if (!integer(value.at)) fail('事件时间无效');
    return { seq: value.seq, kind: value.kind, data: payload(value.kind, value.data), at: value.at };
  }
  function record(value, expectedId) {
    sessionId(expectedId);
    if (!object(value) || value.id !== expectedId || !object(value.metadata) || !Array.isArray(value.events)
      || value.events.length > MAX_EVENTS || typeof value.interruptedTail !== 'boolean') fail('会话记录无效');
    if (size(value.metadata) > MAX_METADATA || size(value) > MAX_RECORD) fail('会话记录大小超限');
    return { ...clone(value), events: value.events.map((entry, index) => event(entry, index + 1)) };
  }
  function redact(value, secrets, seen = new Set(), depth = 0) {
    if (depth > MAX_REDACT_DEPTH) fail('日志内容嵌套深度超限');
    if (typeof value === 'string') {
      let decoded;
      // Tool arguments and results are JSON strings. Decode before cleaning so
      // escaped secrets are removed without corrupting protocol field names.
      // Only parsing belongs in this catch: a recursive cleaning error must
      // stop persistence rather than fall back to an unsafe raw replacement.
      if (/^\s*[\[{]/.test(value)) {
        try { decoded = JSON.parse(value); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      if (decoded && typeof decoded === 'object') return JSON.stringify(redact(decoded, secrets, seen, depth + 1));
      let result = value;
      for (const secret of secrets) {
        // Existing markers survive repeated read/replay cleaning, including
        // keys whose bytes happen to occur in the marker itself.
        // Tiny configured strings are identifier tokens, so they cannot erase
        // ordinary words or tool names such as run_command in system text.
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const token = secret.length < 8 ? new RegExp('(^|[^A-Za-z0-9_-])' + escaped + '(?=$|[^A-Za-z0-9_-])', 'g') : null;
        result = result.split('[REDACTED]').map(part => token
          ? part.replace(token, (_, prefix) => prefix + '[REDACTED]') : part.split(secret).join('[REDACTED]')).join('[REDACTED]');
      }
      return result;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || seen.has(value)) fail('日志只能保存有限的 JSON 数据');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(item => redact(item, secrets, seen, depth + 1));
    else {
      result = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_FIELDS.has(key.toLowerCase().replace(/[_-]/g, ''))) continue;
        if (item !== undefined) result[key] = redact(item, secrets, seen, depth + 1);
      }
    }
    seen.delete(value); return result;
  }
  function replay(value) {
    sessionId(value?.id); const source = record(value, value.id);
    let history = [], rounds = 0, commands = 0, compactions = 0, status = 'interrupted', summary = '', ended = false;
    const allIds = new Set(), dispatched = new Set(), calls = new Map(), knownCalls = new Map();
    function ingest(messages, replacement = false) {
      const local = new Map();
      for (const entry of messages) {
        if (entry.role === 'assistant') for (const call of entry.toolCalls || []) {
          if (local.has(call.id)) fail('历史工具调用编号重复');
          local.set(call.id, { ...call, result: false }); allIds.add(call.id);
          const prior = knownCalls.get(call.id);
          if (prior && !equal(prior, call)) fail('工具调用编号内容冲突');
          if (!replacement && prior) fail('助手重复派发工具调用');
          knownCalls.set(call.id, call); calls.set(call.id, { call, result: false });
        }
        if (entry.role === 'tool') {
          const call = local.get(entry.toolCallId);
          // Appended tool events are matched against the preceding projection.
          const known = replacement ? call : calls.get(entry.toolCallId);
          if (!known || known.result) fail('工具结果没有对应调用或重复');
          known.result = true;
          if (call) call.result = true;
          calls.get(entry.toolCallId).result = true; allIds.add(entry.toolCallId);
        }
      }
    }
    for (const entry of source.events) {
      const data = entry.data;
      if (entry.kind === 'history/replace') {
        const previous = new Map(calls); calls.clear();
        ingest(data.messages, true);
        // Compaction cannot erase an unresolved side effect from the journal.
        for (const [id, prior] of previous) if (!prior.result && !calls.has(id)) fail('历史替换丢失未完成工具调用');
        history = data.messages.map(message);
        if (own(data, 'rounds')) rounds = Math.max(rounds, data.rounds);
        if (own(data, 'commands')) commands = Math.max(commands, data.commands);
        if (own(data, 'compactions')) compactions = Math.max(compactions, data.compactions);
      } else if (entry.kind === 'assistant/message') {
        const m = message(data.message); ingest([m]); history.push(m);
      } else if (entry.kind === 'tool/result') {
        const m = message(data.message); ingest([m]); history.push(m);
      } else if (entry.kind === 'tool/call') {
        allIds.add(data.callId); const call = calls.get(data.callId);
        if (!call || call.call.name !== data.name) fail('工具声明没有对应助手调用');
      } else if (entry.kind === 'tool/dispatch') {
        allIds.add(data.callId); const call = calls.get(data.callId);
        if (!call || call.result || dispatched.has(data.callId) || data.name && call.call.name !== data.name) fail('工具执行记录冲突');
        dispatched.add(data.callId); if (call.call.name === 'run_command') commands++;
      } else if (entry.kind === 'tool/approval') {
        allIds.add(data.callId); if (!calls.has(data.callId)) fail('工具确认没有对应助手调用');
      } else if (entry.kind === 'step/start') { rounds = Math.max(rounds, data.round); ended = false; }
      else if (entry.kind === 'turn/start' || entry.kind === 'session/resume') ended = false;
      else if (entry.kind === 'turn/end') { status = data.status; summary = data.summary; ended = true; }
    }
    if (history.length > 512) fail('恢复历史消息数量超限');
    const pending = [], repairMessages = [], repaired = [];
    for (let index = 0; index < history.length; index++) {
      const current = history[index]; if (current.role === 'tool') fail('工具结果不在对应助手分组内'); repaired.push(current);
      if (current.role !== 'assistant' || !current.toolCalls?.length) continue;
      const results = new Map();
      while (history[index + 1]?.role === 'tool') {
        const next = history[++index];
        if (!current.toolCalls.some(call => call.id === next.toolCallId) || results.has(next.toolCallId)) fail('工具结果分组无效');
        results.set(next.toolCallId, next);
      }
      for (const call of current.toolCalls) {
        let result = results.get(call.id);
        if (!result) {
          const wasDispatched = dispatched.has(call.id);
          pending.push({ id: call.id, name: call.name, dispatched: wasDispatched });
          result = { role: 'tool', toolCallId: call.id, content: JSON.stringify({ code: wasDispatched ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED',
            interrupted: true, requiresReconciliation: true, message: wasDispatched
              ? '连接在工具派发后中断，实际结果未知。请先核对机器状态，禁止自动重放此调用。'
              : '连接在工具派发前中断，此调用未执行。恢复不会自动执行此调用。' }) };
          repairMessages.push(result);
        }
        repaired.push(result);
      }
    }
    const interrupted = source.interruptedTail || pending.length > 0 || !ended;
    return { history: repaired, toolIds: [...allIds], pending, repairMessages, rounds, commands, compactions,
      status: interrupted ? 'interrupted' : status, summary, interrupted, requiresReconciliation: pending.length > 0 };
  }

  function createJournal(T, options = {}) {
    if (!T || typeof T.invoke !== 'function') fail('原生事件桥不可用');
    if (!object(options) || options.secrets !== undefined && !Array.isArray(options.secrets)) fail('密钥清理配置无效');
    const secrets = [...new Set((options.secrets || []).filter(value => typeof value === 'string' && value.length))].sort((a, b) => b.length - a.length);
    let boundId = null, seq = 0, tail = Promise.resolve(), poisoned = null;
    const safe = value => redact(value, secrets);
    // Protocol correlation values are already schema checked and are not user
    // text. Protect them only at these known paths, never inside tool JSON.
    const cleanFields = (value, structural = [], overrides = {}) => {
      const result = Object.create(null), preserved = new Set(structural);
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_FIELDS.has(key.toLowerCase().replace(/[_-]/g, '')) || item === undefined) continue;
        result[key] = own(overrides, key) ? overrides[key] : preserved.has(key) && (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) ? item : safe(item);
      }
      return result;
    };
    const safeArguments = call => {
      if (['memory_get', 'memory_write'].includes(call.name)) {
        let decoded;
        try { decoded = JSON.parse(call.arguments); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        if (object(decoded) && ['current', 'global'].includes(decoded.scope)) {
          const cleaned = redact(decoded, secrets, new Set(), 1);
          // This is a defined enum at a known tool path, not an arbitrary
          // scope/name field inside command output or user JSON.
          cleaned.scope = decoded.scope; return JSON.stringify(cleaned);
        }
      }
      return safe(call.arguments);
    };
    const safeMessage = value => {
      const projected = message(value), result = { role: projected.role, content: safe(projected.content) };
      if (own(projected, 'toolCallId')) result.toolCallId = projected.toolCallId;
      if (own(projected, 'toolCalls')) result.toolCalls = projected.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: safeArguments(call) }));
      return result;
    };
    const safeTarget = value => {
      const target = targetData(value);
      return targetData(cleanFields(target, ['identity', 'protocol', 'port']));
    };
    const safeMetadata = value => {
      if (!object(value)) fail('会话元数据无效');
      const overrides = own(value, 'target') ? { target: safeTarget(value.target) } : {};
      return cleanFields(value, ['model'], overrides);
    };
    const safePayload = (kind, value) => {
      if (!KINDS.has(kind) || !object(value)) fail('未知事件或事件内容无效');
      const overrides = {};
      if (kind === 'history/replace') {
        if (!Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) fail('历史消息数量超限');
        overrides.messages = value.messages.map(safeMessage);
      } else if (kind === 'assistant/message' || kind === 'tool/result') overrides.message = safeMessage(value.message);
      else if (kind === 'session/resume') overrides.target = safeTarget(value.target);
      const structural = kind.startsWith('tool/') ? ['callId', 'name', 'requestId', 'kind', 'type']
        : kind === 'turn/end' ? ['status', 'type'] : kind === 'step/start' ? ['requestId', 'model', 'type'] : ['type'];
      return payload(kind, cleanFields(value, structural, overrides));
    };
    const safeRecord = (value, expectedId) => {
      if (!object(value) || value.id !== expectedId || !Array.isArray(value.events) || value.events.length > MAX_EVENTS
        || typeof value.interruptedTail !== 'boolean') fail('会话记录无效');
      if (size(value) > MAX_RECORD) fail('会话记录大小超限');
      return record({ id: value.id, metadata: safeMetadata(value.metadata), interruptedTail: value.interruptedTail,
        events: value.events.map((entry, index) => {
          if (!object(entry) || entry.seq !== index + 1 || !integer(entry.at)) fail('事件序号或时间无效');
          return { seq: entry.seq, kind: entry.kind, data: safePayload(entry.kind, entry.data), at: entry.at };
        }) }, expectedId);
    };
    const enqueue = operation => {
      const next = tail.then(() => { if (poisoned) throw poisoned; return operation(); });
      // Keep the rejected chain: later calls may never skip a failed append.
      tail = next; return next;
    };
    return Object.freeze({
      create(id, metadata) {
        let cleaned, captureError;
        try {
          if (!object(metadata)) fail('会话元数据无效');
          cleaned = safeMetadata(metadata); if (size(cleaned) > MAX_METADATA) fail('会话元数据大小超限');
        } catch (error) { captureError = error; }
        return enqueue(async () => {
          sessionId(id); if (boundId) fail('日志实例已经绑定会话');
          if (captureError) throw captureError;
          const value = safeRecord(await T.invoke('harness_create', { id, metadata: cleaned }), id);
          if (value.events.length || value.interruptedTail) fail('新会话事件序号无效');
          boundId = id; seq = 0; return value;
        });
      },
      append(kind, data) {
        let cleaned, captureError;
        try { cleaned = safePayload(kind, data); } catch (error) { captureError = error; }
        return enqueue(async () => {
          try {
            if (!boundId) fail('日志尚未绑定会话');
            if (captureError) throw captureError;
            if (seq >= MAX_EVENTS) fail('事件数量超限');
            const expected = seq + 1;
            const value = event(await T.invoke('harness_append', { id: boundId, expectedSeq: seq, kind, data: cleaned }), expected);
            if (value.kind !== kind || !equal(value.data, cleaned)) fail('原生事件确认内容不一致');
            seq = expected; return value;
          } catch (error) { poisoned = error; throw error; }
        });
      },
      read(id) {
        return enqueue(async () => {
          sessionId(id); if (boundId && id !== boundId) fail('日志实例不能切换会话');
          const value = safeRecord(await T.invoke('harness_read', { id }), id);
          boundId = id; seq = value.events.length; return value;
        });
      },
      async list() {
        const value = await T.invoke('harness_list', {});
        if (!Array.isArray(value) || value.length > 1024 || size(value) > MAX_RECORD) fail('会话列表无效');
        const ids = new Set();
        return value.map(entry => {
          sessionId(entry?.id);
          if (!object(entry.metadata) || size(entry.metadata) > MAX_METADATA || !integer(entry.eventCount)
            || entry.eventCount > MAX_EVENTS || !integer(entry.updatedAt) || typeof entry.interruptedTail !== 'boolean'
            || ids.has(entry.id) || own(entry, 'events')) fail('会话摘要无效');
          ids.add(entry.id); return { id: entry.id, metadata: safeMetadata(entry.metadata), eventCount: entry.eventCount,
            updatedAt: entry.updatedAt, interruptedTail: entry.interruptedTail };
        });
      },
      async target(tab) {
        const identity = stable(tab?._connectionIdentity || tab?.session || { protocol: 'local' });
        const serialized = JSON.stringify(identity); if (size(serialized) > MAX_IDENTITY) fail('目标身份大小超限');
        const fingerprint = await T.invoke('harness_fingerprint', { identity: serialized });
        const protocol = String(identity.protocol || 'local').toLowerCase();
        const port = identity.port === null || identity.port === undefined || identity.port === '' ? (protocol === 'ssh' ? 22 : null) : Number(identity.port);
        return Object.freeze(safeTarget({ identity: fingerprint, protocol, host: String(identity.host || ''),
          user: String(identity.user || ''), port, title: String(tab?.title || '终端') }));
      },
      replay(value) { return replay(safeRecord(value, value?.id)); },
      get id() { return boundId; },
      get seq() { return seq; },
    });
  }
  window.AiHarness = Object.freeze({ createRuntime, createJournal });
})();
