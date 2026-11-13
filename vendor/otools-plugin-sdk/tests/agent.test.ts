import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../src/index';
import type { AgentApi, AgentEvent, AgentReadResult, AgentStartRequest, AgentTransport } from '../src/agent-types';

const request: AgentStartRequest = { sessionId: 'session', prompt: 'hello' };
const createAgentApi = (transport: AgentTransport): AgentApi => {
  expect(sdk).toHaveProperty('createAgentApi', expect.any(Function));
  return (sdk as unknown as { createAgentApi(transport: AgentTransport): AgentApi }).createAgentApi(transport);
};
function fixture(reads: unknown[] = []) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const api = createAgentApi({ invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === 'otools_host_agent_start') return { id: 'run', sessionId: 'session' };
    if (command === 'otools_host_agent_read') {
      const result = reads.shift();
      if (result instanceof Error) throw result;
      return result;
    }
    return undefined;
  } });
  return { api, calls };
}
function page(events: AgentEvent[], overrides: Partial<AgentReadResult> = {}): AgentReadResult {
  return { id: 'run', after: events.at(-1)?.sequence ?? 0, events, done: false, status: 'running', ...overrides };
}

afterEach(() => vi.useRealTimers());

describe('agent replay and lifecycle', () => {
  it('projects bounded media model snapshots without credentials', async () => {
    const { api, calls } = fixture();
    await api.start({ ...request, mediaModels: { images: 'selected-image' }, apiKey: 'must-not-cross' } as never);
    expect(calls).toEqual([['otools_host_agent_start', { request, mediaModels: { images: 'selected-image' } }]]);
  });

  it('consumes rich events once across replay overlap and never acknowledges retained data', async () => {
    const first: AgentEvent = { sequence: 1, type: 'text', text: 'hello ' };
    const { api, calls } = fixture([
      page([first]),
      page([first, { sequence: 2, type: 'reasoning', text: 'thinking' }, { sequence: 3, type: 'tool', itemId: 'tool-1', data: { name: 'search', result: ['a'] } }, { sequence: 4, type: 'permission', data: { id: 'p' } }, { sequence: 5, type: 'question', data: { id: 'q' } }, { sequence: 6, type: 'status', text: 'working' }, { sequence: 7, type: 'text', text: 'world' }, { sequence: 8, type: 'done' }], { done: true, status: 'completed' }),
    ]);
    const events: AgentEvent[] = [];
    await expect(api.consume(request, { pollIntervalMs: 0, onEvent: event => events.push(event) })).resolves.toEqual({ id: 'run', sessionId: 'session', text: 'hello world' });
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events[2]).toEqual({ sequence: 3, type: 'tool', itemId: 'tool-1', data: { name: 'search', result: ['a'] } });
    expect(calls).toEqual([
      ['otools_host_agent_start', { request }],
      ['otools_host_agent_read', { id: 'run', after: 0 }],
      ['otools_host_agent_read', { id: 'run', after: 1 }],
    ]);
  });

  it.each([undefined, 'earlier suffix'])('resumes with optional cumulative text and no start call: %s', async snapshot => {
    const { api, calls } = fixture([page([{ sequence: 6, type: 'text', text: 'suffix' }, { sequence: 7, type: 'done' }], { done: true, status: 'completed', ...(snapshot === undefined ? {} : { text: snapshot }) })]);
    await expect(api.resume({ id: 'run', after: 5 })).resolves.toEqual({ id: 'run', text: snapshot ?? 'suffix' });
    expect(calls).toEqual([['otools_host_agent_read', { id: 'run', after: 5 }]]);
  });

  it('allows resuming an already consumed terminal cursor without repeating callbacks', async () => {
    const { api, calls } = fixture([page([], { after: 9, done: true, status: 'completed', text: 'retained' })]);
    const events: AgentEvent[] = [];
    await expect(api.resume({ id: 'run', after: 9 }, { onEvent: event => events.push(event) })).resolves.toEqual({ id: 'run', text: 'retained' });
    expect(events).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [page([{ sequence: 2, type: 'text', text: 'gap' }]), 'cursorGap'],
    [page([{ sequence: 1, type: 'text', text: 'x' }], { id: 'foreign' }), 'invalidResponse'],
    [page([{ sequence: 1, type: 'text', text: 'x' }], { after: 99 }), 'invalidResponse'],
    [page([{ sequence: 1, type: 'text', text: 'x' }, { sequence: 1, type: 'text', text: 'x' }]), 'invalidResponse'],
    [page([{ sequence: 1, type: 'done' }, { sequence: 2, type: 'text', text: 'late' }], { done: true, status: 'completed' }), 'invalidResponse'],
    [page([{ sequence: 1, type: 'done' }]), 'invalidResponse'],
    [page([{ sequence: 1, type: 'text', text: 'x' }], { done: true, status: 'completed' }), 'invalidResponse'],
    [page([{ sequence: 1, type: 'text' }]), 'invalidResponse'],
    [page([{ sequence: 1, type: 'error' }], { done: true, status: 'failed' }), 'invalidResponse'],
    [page([{ sequence: 1, type: 'tool', data: { invalid: Infinity } }]), 'invalidResponse'],
    [page(Array.from({ length: 257 }, (_, n) => ({ sequence: n + 1, type: 'status' }))), 'responseTooLarge'],
    [page([{ sequence: 1, type: 'text', text: 'x'.repeat(256 * 1024 + 1) }]), 'responseTooLarge'],
    [page([], { text: 'x'.repeat(4 * 1024 * 1024 + 1) }), 'responseTooLarge'],
  ])('rejects invalid or unbounded replay before callbacks', async (batch, code) => {
    const { api, calls } = fixture([batch]);
    const events: AgentEvent[] = [];
    await expect(api.consume(request, { onEvent: event => events.push(event) })).rejects.toMatchObject({ code });
    expect(events).toEqual([]);
    expect(calls.at(-1)).toEqual(['otools_host_agent_cancel', { id: 'run' }]);
  });

  it.each([
    ['error', 'failed', 'providerFailed'], ['cancelled', 'cancelled', 'cancelled'], ['error', 'interrupted', 'interrupted'],
  ] as const)('delivers %s terminal callback once and rejects without an ACK', async (type, status, code) => {
    const { api, calls } = fixture([page([{ sequence: 1, type, ...(type === 'error' ? { error: code } : {}) }], { done: true, status })]);
    const events: AgentEvent[] = [];
    await expect(api.consume(request, { onEvent: event => events.push(event) })).rejects.toMatchObject({ code });
    expect(events).toHaveLength(1);
    expect(calls.map(([command]) => command)).toEqual(['otools_host_agent_start', 'otools_host_agent_read']);
  });

  it('aborts before start dispatch and cancels an ID returned after an in-flight start abort', async () => {
    let resolveStart!: (value: unknown) => void;
    const calls: Array<[string, unknown]> = [];
    const api = createAgentApi({ invoke: async (command, args) => {
      calls.push([command, args]);
      if (command.endsWith('_start')) return new Promise(resolve => { resolveStart = resolve; });
    } });
    const preAborted = new AbortController(); preAborted.abort();
    await expect(api.consume(request, { signal: preAborted.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(calls).toEqual([]);
    const controller = new AbortController();
    const pending = api.consume(request, { signal: controller.signal });
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    resolveStart({ id: 'late', sessionId: 'session' });
    await vi.waitFor(() => expect(calls).toContainEqual(['otools_host_agent_cancel', { id: 'late' }]));
    expect(calls).toHaveLength(2);
  });

  it.each([false, true])('resume abort detaches unless cancelOnAbort=%s and ignores a late poll', async cancelOnAbort => {
    let resolveRead!: (value: unknown) => void;
    const calls: string[] = [];
    const api = createAgentApi({ invoke: async command => {
      calls.push(command);
      if (command.endsWith('_read')) return new Promise(resolve => { resolveRead = resolve; });
    } });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const pending = api.resume({ id: 'run', after: 1 }, { signal: controller.signal, cancelOnAbort, onEvent: event => events.push(event) });
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    resolveRead(page([{ sequence: 2, type: 'done' }], { done: true, status: 'completed' }));
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(calls).toEqual(cancelOnAbort ? ['otools_host_agent_read', 'otools_host_agent_cancel'] : ['otools_host_agent_read']);
  });

  it('honors bounded timeout even when the transport never settles', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const api = createAgentApi({ invoke: async command => {
      calls.push(command);
      if (command.endsWith('_start')) return { id: 'run', sessionId: 'session' };
      if (command.endsWith('_read')) return new Promise(() => {});
    } });
    const pending = expect(api.consume(request, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(calls).toEqual(['otools_host_agent_start', 'otools_host_agent_read', 'otools_host_agent_cancel']);
  });

  it('cancels owned execution when onEvent throws but never cancels a detached resume', async () => {
    for (const resume of [false, true]) {
      const { api, calls } = fixture([page([{ sequence: 1, type: 'text', text: 'x' }])]);
      const options = { onEvent() { throw new Error('consumer failed'); } };
      await expect(resume ? api.resume({ id: 'run' }, options) : api.consume(request, options)).rejects.toThrow('consumer failed');
      expect(calls.some(([command]) => command.endsWith('_cancel'))).toBe(!resume);
    }
  });
});

describe('host agent SDK boundary', () => {
  it('exports a dependency-free agent factory for host service integration', () => {
    expect(sdk).toHaveProperty('createAgentApi', expect.any(Function));
  });

  it('routes exact host command envelopes and projects out owner, launch and credential fields', async () => {
    const { api, calls } = fixture();
    const injected = { owner: { source: 'other', uuid: 'foreign' }, command: 'sh', args: ['-c', 'payload'], env: { TOKEN: 'secret' }, apiKey: 'secret', path: '/etc' };
    await api.providers();
    await api.tools();
    await api.capabilities({ providerId: 'codex', ...injected });
    await api.health({ providerId: 'codex', refresh: true, ...injected });
    await api.openManager();
    await api.openManager({ providerId: 'codex', ...injected });
    await api.openSession({ providerId: 'codex', clientSessionId: 'client', workspaceId: 'work', instructions: 'rules', sandbox: 'workspace-write', network: false, background: true, tools: ['search'], ...injected });
    await api.configOptions({ sessionId: 'session', ...injected });
    await api.setConfigOption({ sessionId: 'session', configId: 'model', value: 'model-a', ...injected });
    await api.start({ ...request, model: 'model-a', reasoningEffort: null, timeoutSecs: 300, requestId: 'req', ...injected });
    await api.read({ id: 'run', ...injected });
    await api.cancel({ id: 'run', ...injected });
    await api.closeSession({ sessionId: 'session', ...injected });
    await api.respondQuestion({ id: 'question', answers: { choice: ['one'] }, ...injected });
    await api.openPermission({ id: 'permission', ...injected });
    await api.workspace();
    await api.workspace({ workspaceId: 'work', ...injected });
    await api.syncAssets({ workspaceId: 'work', files: [{ path: 'src/a.txt', contentBase64: 'YQ==', ...{ owner: 'foreign' } }], ...injected });
    await api.workspaceFiles({ workspaceId: 'work', ...injected, path: 'src' });
    expect(calls).toEqual([
      ['otools_host_agent_providers', undefined],
      ['otools_host_agent_tools', undefined],
      ['otools_host_agent_capabilities', { providerId: 'codex' }],
      ['otools_host_agent_health', { providerId: 'codex', refresh: true }],
      ['otools_host_agent_open_manager', {}],
      ['otools_host_agent_open_manager', { providerId: 'codex' }],
      ['otools_host_agent_open_session', { request: { providerId: 'codex', clientSessionId: 'client', workspaceId: 'work', instructions: 'rules', sandbox: 'workspace-write', network: false, background: true, tools: ['search'] } }],
      ['otools_host_agent_config_options', { sessionId: 'session' }],
      ['otools_host_agent_set_config_option', { sessionId: 'session', configId: 'model', value: 'model-a' }],
      ['otools_host_agent_start', { request: { sessionId: 'session', prompt: 'hello', model: 'model-a', reasoningEffort: null, timeoutSecs: 300, requestId: 'req' } }],
      ['otools_host_agent_read', { id: 'run', after: 0 }],
      ['otools_host_agent_cancel', { id: 'run' }],
      ['otools_host_agent_close_session', { sessionId: 'session' }],
      ['otools_host_agent_respond_question', { id: 'question', answers: { choice: ['one'] } }],
      ['otools_host_agent_open_permission', { id: 'permission' }],
      ['otools_host_agent_workspace', {}],
      ['otools_host_agent_workspace', { workspaceId: 'work' }],
      ['otools_host_agent_sync_assets', { workspaceId: 'work', files: [{ path: 'src/a.txt', contentBase64: 'YQ==' }] }],
      ['otools_host_agent_workspace_files', { workspaceId: 'work', path: 'src' }],
    ]);
  });

  it.each([
    ['openSession', { providerId: '' }],
    ['openSession', { providerId: 'codex', sandbox: 'unsafe' }],
    ['openSession', { providerId: 'codex', network: 'yes' }],
    ['openSession', { providerId: 'codex', tools: Array(129).fill('tool') }],
    ['start', { sessionId: 'session', prompt: '' }],
    ['start', { sessionId: 'session', prompt: 'x'.repeat(1024 * 1024 + 1) }],
    ['start', { ...request, timeoutSecs: Infinity }],
    ['start', { ...request, timeoutSecs: -1 }],
    ['start', { ...request, reasoningEffort: 42 }],
    ['start', { ...request, model: 'x'.repeat(513) }],
    ['read', { id: 'run', after: -1 }],
    ['read', { id: 'run', after: 1.5 }],
    ['read', { id: 'run', after: Number.MAX_SAFE_INTEGER + 1 }],
    ['cancel', { id: {} }],
    ['closeSession', { sessionId: '' }],
    ['respondQuestion', { id: 'q', answers: { choice: 'yes' } }],
    ['respondQuestion', { id: 'q', answers: JSON.parse('{"__proto__":["yes"]}') }],
    ['syncAssets', { workspaceId: 'work', files: [{ path: '../escape', contentBase64: '' }] }],
    ['syncAssets', { workspaceId: 'work', files: [{ path: '/etc/file', contentBase64: '' }] }],
    ['syncAssets', { workspaceId: 'work', files: [{ path: 'C:\\escape', contentBase64: '' }] }],
    ['syncAssets', { workspaceId: 'work', files: [{ path: 'a', contentBase64: 'not base64' }] }],
    ['workspaceFiles', { workspaceId: 'work', path: 'a/../../escape' }],
    ['setConfigOption', { sessionId: 'session', configId: '', value: 'model' }],
    ['health', { providerId: 'codex', refresh: 'yes' }],
  ])('rejects malformed %s arguments before IPC', async (method, args) => {
    const { api, calls } = fixture();
    await expect((api[method as keyof AgentApi] as (args: unknown) => Promise<unknown>)(args)).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(calls).toEqual([]);
  });

  it('syncs a valid large asset without overflowing base64 validation', async () => {
    const { api, calls } = fixture();
    const contentBase64 = 'YWFh'.repeat(4 * 1024 * 1024);
    await expect(api.syncAssets({ workspaceId: 'work', files: [{ path: 'asset.bin', contentBase64 }] })).resolves.toBeUndefined();
    expect(calls[0]).toEqual(['otools_host_agent_sync_assets', { workspaceId: 'work', files: [{ path: 'asset.bin', contentBase64 }] }]);
  });

  it('surfaces missing API and structured host errors explicitly', async () => {
    const missing = createAgentApi({} as AgentTransport);
    await expect(missing.providers()).rejects.toMatchObject({ code: 'unavailable' });
    const api = createAgentApi({ invoke: async () => { throw { code: 'unsupported', message: 'No model configuration' }; } });
    await expect(api.configOptions({ sessionId: 'session' })).rejects.toMatchObject({ name: 'AgentError', code: 'unsupported', message: 'No model configuration' });
    const unknown = createAgentApi({ invoke: async () => { throw new Error('unknown command otools_host_agent_providers'); } });
    await expect(unknown.providers()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
