// Test-only native persistence adapter. The production journal/kernel is real;
// no files, commands, credentials or provider network requests are touched.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function installHarnessFixture(w, T, options = {}) {
  const records = options.records || new Map(), operations = [];
  const copy = value => JSON.parse(JSON.stringify(value));
  const original = T.invoke.bind(T);
  T.invoke = async (command, args = {}) => {
    if (!command.startsWith('harness_')) return original(command, args);
    const operation = { command, args: copy(args) }; operations.push(operation);
    const intercept = options.intercept?.(command, args, { records, operations });
    if (intercept !== undefined) return await intercept;
    if (command === 'harness_fingerprint') return createHash('sha256').update(args.identity).digest('hex');
    if (command === 'harness_create') {
      if (records.has(args.id)) throw Error('already exists');
      const value = { id: args.id, metadata: copy(args.metadata), events: [], interruptedTail: false };
      records.set(args.id, value); return copy(value);
    }
    if (command === 'harness_read') {
      if (!records.has(args.id)) throw Error('not found');
      return copy(records.get(args.id));
    }
    if (command === 'harness_append') {
      const record = records.get(args.id);
      if (!record || record.events.length !== args.expectedSeq) throw Error('sequence conflict');
      const event = { seq: args.expectedSeq + 1, kind: args.kind, data: copy(args.data), at: Date.now() };
      record.events.push(event); record.interruptedTail = false; return copy(event);
    }
    if (command === 'harness_list') return [...records.values()].slice(-100).reverse().map(record => ({
      id: record.id, metadata: copy(record.metadata), eventCount: record.events.length,
      updatedAt: record.events.at(-1)?.at || 0, interruptedTail: record.interruptedTail,
    }));
    throw Error('unsupported harness test operation');
  };
  w.TextEncoder ||= TextEncoder;
  w.eval(readFileSync(new URL('../src/ai-harness.js', import.meta.url), 'utf8'));
  return { records, operations };
}
