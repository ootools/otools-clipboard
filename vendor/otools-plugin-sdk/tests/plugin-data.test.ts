import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginDataApi, PluginDataError } from '../src/plugin-data-factory';
import type { PluginDataTransport } from '../src/plugin-data-types';

const provider = { source: 'market', uuid: 'notes' };
afterEach(() => vi.useRealTimers());

describe('plugin data transport boundary', () => {
  it('requests one explicitly listed bundle and tracks consent without accepting consumer identity', async () => {
    const calls: unknown[] = [];
    const data = createPluginDataApi({ invoke: async (command, args) => {
      calls.push([command, args]);
      return { id: 'request-1', status: 'pending', expiresAt: 1000 };
    } });
    const items = [{ provider, type: 'note', subscribe: true }];
    await data.requestAccessBatch({ items, consumer: { source: 'market', uuid: 'spoof' } } as never);
    await data.accessStatus({ id: 'request-1' });
    expect(calls).toEqual([
      ['otools_host_plugin_data_request_access_batch', { request: { items } }],
      ['otools_host_plugin_data_access_status', { request: { id: 'request-1' } }],
    ]);
  });
  it('rejects empty and oversized access bundles before dispatching', async () => {
    let calls = 0;
    const data = createPluginDataApi({ invoke: async () => { calls++; } });
    await expect(data.requestAccessBatch({ items: [] })).rejects.toMatchObject({ code: 'invalidRequest' });
    await expect(data.requestAccessBatch({ items: Array.from({ length: 33 }, () => ({ provider, type: 'note' })) })).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(calls).toBe(0);
  });
  it('rejects duplicate provider/type items before dispatching even when their scopes differ', async () => {
    let calls = 0;
    const data = createPluginDataApi({ invoke: async () => { calls++; return { id: '', status: 'granted' }; } });
    await expect(data.requestAccessBatch({ items: [
      { provider, type: 'note' },
      { provider, type: 'note', scope: { kind: 'ids', ids: ['one'] } },
    ] })).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(calls).toBe(0);
  });
  it.each([
    { provider, type: 'note', scope: { kind: 'unknown' } },
    { provider, type: 'note', scope: { kind: 'ids', ids: [] } },
    { provider, type: 'note', scope: { kind: 'ids', ids: [''] } },
    { provider, type: 'note', scope: { kind: 'ids', ids: 'one' } },
    { provider, type: 'note', scope: { kind: 'ids', ids: Array.from({ length: 257 }, () => 'one') } },
    { provider: null, type: 'note' },
    { provider: { source: 'Market', uuid: 'notes' }, type: 'note' },
    { provider, type: '' },
    { provider, type: 'note', subscribe: 'yes' },
  ])('rejects malformed access items without widening scope or dispatching (%j)', async item => {
    let calls = 0;
    const data = createPluginDataApi({ invoke: async () => { calls++; return { id: '', status: 'granted' }; } });
    await expect(data.requestAccessBatch({ items: [item] } as never)).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(calls).toBe(0);
  });
  it('preserves exact ID scopes and source identities in a valid bundle', async () => {
    let request: unknown;
    const data = createPluginDataApi({ invoke: async (_command, args) => {
      request = args?.request;
      return { id: '', status: 'granted', expiresAt: 0 };
    } });
    await data.requestAccessBatch({ items: [
      { provider, type: 'note', scope: { kind: 'ids', ids: ['one', 'two'] }, subscribe: false },
      { provider: { source: 'dev-debug', uuid: 'notes' }, type: 'note', scope: { kind: 'all' } },
    ] });
    expect(request).toEqual({ items: [
      { provider: { source: 'market', uuid: 'notes' }, type: 'note', scope: { kind: 'ids', ids: ['one', 'two'] }, subscribe: false },
      { provider: { source: 'dev-debug', uuid: 'notes' }, type: 'note', scope: { kind: 'all' } },
    ] });
  });
  it('uses camelCase request envelopes without claiming provider identity for writes', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const transport: PluginDataTransport = { invoke: async (command, args) => { calls.push([command, args]); return null; } };
    const data = createPluginDataApi(transport);
    await data.list({ type: 'note' });
    await data.get({ provider, type: 'note', id: 'one' });
    await data.put({ type: 'note', id: 'one', data: { text: 'hi' }, privateData: { x: 10 }, expectedRevision: 0 });
    await data.remove({ type: 'note', id: 'one', expectedRevision: 1 });
    await data.requestAccess({ provider, type: 'note', subscribe: true });
    await data.revokeAccess({ provider, type: 'note' });
    expect(calls).toEqual([
      ['otools_host_plugin_data_list', { request: { type: 'note' } }],
      ['otools_host_plugin_data_get', { request: { provider, type: 'note', id: 'one' } }],
      ['otools_host_plugin_data_put', { request: { type: 'note', id: 'one', data: { text: 'hi' }, privateData: { x: 10 }, expectedRevision: 0 } }],
      ['otools_host_plugin_data_remove', { request: { type: 'note', id: 'one', expectedRevision: 1 } }],
      ['otools_host_plugin_data_request_access', { request: { provider, type: 'note', subscribe: true } }],
      ['otools_host_plugin_data_revoke_access', { request: { provider, type: 'note' } }],
    ]);
  });
  it('preserves structured conflict and revoked-grant errors', async () => {
    const data = createPluginDataApi({ invoke: async () => { throw JSON.stringify({ code: 'conflict', message: 'Resource revision has changed' }); } });
    await expect(data.put({ type: 'note', id: 'one', data: null, expectedRevision: 1 })).rejects.toMatchObject({ name: 'PluginDataError', code: 'conflict' });
  });
  it('rejects unsafe or missing revisions before invoking the host', async () => {
    let invoked = false;
    const data = createPluginDataApi({ invoke: async () => { invoked = true; } });
    await expect(data.remove({ type: 'note', id: 'one', expectedRevision: Number.MAX_SAFE_INTEGER + 1 })).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(invoked).toBe(false);
  });
});

describe('owned change polling', () => {
  it('uses returned cursor, drains backlog, and stops immediately on revocation', async () => {
    vi.useFakeTimers();
    const afters: unknown[] = []; let calls = 0;
    const data = createPluginDataApi({ invoke: async (_command, args) => {
      afters.push((args?.request as { after: string }).after); calls++;
      if (calls === 3) throw { code: 'permissionDenied', message: 'revoked' };
      return { items: [], after: calls === 1 ? 'second' : 'third', hasMore: calls === 1 };
    } });
    const pages: string[] = []; const errors: PluginDataError[] = [];
    data.subscribe({ provider, type: 'note', after: 'first' }, page => { pages.push(page.after); }, { intervalMs: 1000, onError: error => errors.push(error) });
    await vi.advanceTimersByTimeAsync(1);
    expect(pages).toEqual(['second', 'third']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(afters).toEqual(['first', 'second', 'third']);
    expect(errors[0]?.code).toBe('permissionDenied');
    await vi.advanceTimersByTimeAsync(10000); expect(calls).toBe(3);
  });
  it('suppresses in-flight results after cleanup and does not overlap requests', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void; let calls = 0;
    const data = createPluginDataApi({ invoke: () => { calls++; return new Promise(r => { resolve = r; }); } });
    const received: unknown[] = [];
    const stop = data.subscribe({ type: 'note', after: 'first' }, page => { received.push(page); }, { intervalMs: 250, onError: () => {} });
    await vi.advanceTimersByTimeAsync(5000); expect(calls).toBe(1);
    stop(); stop(); resolve({ items: [], after: 'late', hasMore: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(received).toEqual([]); expect(calls).toBe(1);
  });
  it('does not start an already-aborted subscription', async () => {
    const abort = new AbortController(); abort.abort(); let calls = 0;
    const data = createPluginDataApi({ invoke: async () => { calls++; } });
    data.subscribe({ type: 'note', after: 'first' }, () => {}, { signal: abort.signal, onError: () => {} });
    await Promise.resolve(); expect(calls).toBe(0);
  });
});
