import { fingerprint } from './binding.mjs';

const bindingKey = (issueId, commentId) => `approval-binding:v1:${issueId}:${commentId}`;
const invalidationKey = record => `approval-invalidation:v1:${record.issueId}:${record.commentId}`;
const failure = () => new Error('APPROVAL_BINDING_STORAGE_FAILED');

// Bindings and invalidations are separate, immutable records. Invalidating an
// approval must never replace its original snapshot or erase its audit evidence.
export function createBindingStore(storage, beginsWith) {
  return {
    async get(issueId, commentId) {
      return storage.get(bindingKey(issueId, commentId));
    },
    async getInvalidation(record) { return storage.get(invalidationKey(record)); },
    async save(record) {
      const key = bindingKey(record.issueId, record.commentId);
      try { await storage.set(key, record, { keyPolicy: 'FAIL_IF_EXISTS' }); } catch {
        const existing = await storage.get(key);
        if (!existing || existing.state !== 'bound' || existing.schemaVersion !== 1 ||
            existing.issueId !== record.issueId || existing.commentId !== record.commentId ||
            existing.authorAccountId !== record.authorAccountId ||
            existing.commentCreatedAt !== record.commentCreatedAt ||
            existing.fingerprint !== record.fingerprint || fingerprint(existing.snapshot) !== record.fingerprint) throw failure();
      }
      const saved = await storage.get(key);
      if (saved?.fingerprint !== record.fingerprint || fingerprint(saved.snapshot) !== record.fingerprint) throw failure();
    },
    async invalidate(record, code) {
      const key = invalidationKey(record);
      const value = { issueId: record.issueId, commentId: record.commentId,
        state: 'invalidated', code, invalidatedAt: new Date().toISOString() };
      try { await storage.set(key, value, { keyPolicy: 'FAIL_IF_EXISTS' }); } catch {
        const existing = await storage.get(key);
        if (existing?.state !== 'invalidated' || existing.issueId !== record.issueId ||
            existing.commentId !== record.commentId) throw failure();
      }
      const saved = await storage.get(key);
      if (saved?.state !== 'invalidated' || saved.issueId !== record.issueId || saved.commentId !== record.commentId) throw failure();
    },
    async list(issueId) {
      // Query is eventually consistent: this list drives notifications only.
      // Before a future grant, use get(issueId, commentId), not this query.
      const records = [], seen = new Set();
      let cursor;
      for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
        let query = storage.query().where('key', beginsWith(`approval-binding:v1:${issueId}:`)).limit(100);
        if (cursor) query = query.cursor(cursor);
        const page = await query.getMany();
        if (!Array.isArray(page?.results)) throw failure();
        for (const entry of page.results) {
          if (entry.value?.issueId !== issueId || entry.value.state !== 'bound') throw failure();
          records.push(entry.value);
        }
        if (!page.nextCursor) return records;
        if (seen.has(page.nextCursor)) throw failure();
        cursor = page.nextCursor;
        seen.add(cursor);
      }
      throw failure();
    }
  };
}
