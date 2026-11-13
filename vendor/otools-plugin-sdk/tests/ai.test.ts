import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiApi } from '../src/ai-factory';
import type { AiCapabilities, AiEvent, AiModelCatalog, AiRequest, AiSelection } from '../src/ai-types';

const request: AiRequest = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', captureImageId: 'owned' }] }], maxTokens: 42 };
const capabilities: AiCapabilities = { configured: true, provider: 'openai', model: 'host-model', streaming: true, cancellation: true, vision: 'unknown' };
function fixture(reads: unknown[], hostCapabilities = capabilities) {
  const commands: Array<[string, Record<string, unknown> | undefined]> = [];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    commands.push([command, args]);
    switch (command) {
      case 'otools_host_ai_capabilities': return hostCapabilities;
      case 'otools_host_ai_start': return { id: 'job' };
      case 'otools_host_ai_read': return reads.shift();
      case 'otools_host_ai_cancel': return;
      default: throw new Error(`Misrouted command ${command}`);
    }
  };
  return { api: createAiApi({ invoke }), commands };
}

afterEach(() => vi.useRealTimers());

describe('host AI', () => {
  it('exposes transcription without forwarding credential overrides', async () => {
    const calls: unknown[] = [];
    const api = createAiApi({ invoke: async (command, args) => { calls.push([command, args]); return { model: 'chosen-asr', text: 'fixture' }; } });
    await api.media.transcribe({ audioBase64: 'Zml4dHVyZQ==', filename: 'clip.wav', language: 'en', model: 'chosen-asr', apiKey: 'fixture-must-not-cross', baseUrl: 'https://must-not-cross.test' } as never);
    expect(calls).toEqual([['otools_ai_transcribe', { request: { audioBase64: 'Zml4dHVyZQ==', filename: 'clip.wav', language: 'en', model: 'chosen-asr' } }]]);
  });

  it('projects all media generation requests to fields supported by the host', async () => {
    const calls: unknown[] = [];
    const api = createAiApi({ invoke: async (command, args) => { calls.push([command, args]); return {}; } });
    await api.media.images({ prompt: 'fixture', model: 'chosen', apiKey: 'must-not-cross', baseUrl: 'https://bad.test' } as never);
    await api.media.speech({ input: 'fixture', model: 'chosen', apiKey: 'must-not-cross' } as never);
    await api.media.embeddings({ input: ['fixture'], model: 'chosen', apiKey: 'must-not-cross' } as never);
    await api.media.videoSubmit({ prompt: 'fixture', model: 'chosen', apiKey: 'must-not-cross' } as never);
    expect(calls).toEqual([
      ['otools_ai_images', { request: { prompt: 'fixture', model: 'chosen' } }],
      ['otools_ai_speech', { request: { input: 'fixture', model: 'chosen' } }],
      ['otools_ai_embeddings', { request: { input: ['fixture'], model: 'chosen' } }],
      ['otools_ai_video_submit', { request: { prompt: 'fixture', model: 'chosen' } }],
    ]);
  });

  it('routes media catalog and owner preferences without accepting credentials', async () => {
    const calls: unknown[] = [];
    const api = createAiApi({ invoke: async (command, args) => { calls.push([command, args]); return { model: 'chosen' }; } });
    await api.media.models({ channel: 'images' });
    await api.media.getSettings({ channel: 'video' });
    await api.media.saveSettings({ channel: 'tts', model: 'voice', apiKey: 'must-not-cross' } as never);
    expect(calls).toEqual([
      ['otools_host_ai_media_models', { channel: 'images' }],
      ['otools_host_ai_media_get_settings', { channel: 'video' }],
      ['otools_host_ai_media_save_settings', { channel: 'tts', model: 'voice' }],
    ]);
  });

  it('routes only host-prefixed commands and passes typed messages without credential options', async () => {
    const { api, commands } = fixture([{ id: 'job', events: [], done: false }]);
    expect(await api.capabilities()).toEqual(capabilities);
    expect(await api.start(request)).toEqual({ id: 'job' });
    await api.read({ id: 'job', after: 0 });
    await api.cancel({ id: 'job' });
    expect(commands).toEqual([
      ['otools_host_ai_capabilities', undefined], ['otools_host_ai_start', { request }],
      ['otools_host_ai_read', { id: 'job', after: 0 }], ['otools_host_ai_cancel', { id: 'job' }],
    ]);
  });

  it('routes model discovery and settings reads to the host without arguments', async () => {
    const selection: AiSelection = { model: null, reasoningEffort: null };
    const catalog: AiModelCatalog = {
      models: [{
        id: 'vendor/model:preview', ownedBy: 'vendor', capabilities: ['vision', 'reasoning'],
        reasoningLevels: [{ effort: 'high', description: 'More reasoning' }],
        defaultReasoningLevel: 'high', contextWindow: 128000,
      }],
      defaultModel: 'vendor/model:preview', selection,
    };
    const commands: Array<[string, Record<string, unknown> | undefined]> = [];
    const api = createAiApi({ invoke: async (command, args) => {
      commands.push([command, args]);
      if (command === 'otools_host_ai_models') return catalog;
      if (command === 'otools_host_ai_get_settings') return selection;
      throw new Error(`Misrouted command ${command}`);
    } });
    expect(await api.models()).toEqual(catalog);
    expect(await api.getSettings()).toEqual(selection);
    expect(commands).toEqual([
      ['otools_host_ai_models', undefined], ['otools_host_ai_get_settings', undefined],
    ]);
  });

  it('trims and projects saved settings and returns the host selection', async () => {
    const commands: Array<[string, Record<string, unknown> | undefined]> = [];
    const saved: AiSelection = { model: 'canonical-model', reasoningEffort: 'high' };
    const api = createAiApi({ invoke: async (command, args) => {
      commands.push([command, args]);
      return saved;
    } });
    const settings = {
      model: '  vendor/model:preview @2026  ', reasoningEffort: ' high ',
      apiKey: 'must-not-leave-plugin', provider: 'custom', baseUrl: 'https://example.invalid',
    };
    expect(await api.saveSettings(settings)).toEqual(saved);
    expect(settings.model).toBe('  vendor/model:preview @2026  ');
    await api.saveSettings({ model: null, reasoningEffort: null });
    expect(commands).toEqual([
      ['otools_host_ai_save_settings', { settings: { model: 'vendor/model:preview @2026', reasoningEffort: 'high' } }],
      ['otools_host_ai_save_settings', { settings: { model: null, reasoningEffort: null } }],
    ]);
  });

  it.each([
    null, [], {},
    { model: undefined, reasoningEffort: null },
    { model: null, reasoningEffort: undefined },
    { model: 42, reasoningEffort: null },
    { model: null, reasoningEffort: false },
    { model: { toString: () => 'model' }, reasoningEffort: null },
    { model: null, reasoningEffort: new String('high') },
    { model: '', reasoningEffort: null },
    { model: ' \t\n ', reasoningEffort: null },
    { model: null, reasoningEffort: '' },
    { model: null, reasoningEffort: ' \t\n ' },
    { model: 'm'.repeat(513), reasoningEffort: null },
    { model: null, reasoningEffort: 'r'.repeat(65) },
  ])('rejects malformed settings before IPC: %j', async settings => {
    const { api, commands } = fixture([]);
    await expect(api.saveSettings(settings as AiSelection)).rejects.toMatchObject({ code: 'invalidSettings' });
    expect(commands).toEqual([]);
  });

  it('forwards model and reasoning overrides without applying default-model vision metadata', async () => {
    const { api, commands } = fixture([
      { id: 'job', events: [{ sequence: 1, type: 'done' }], done: true },
      { id: 'job', events: [], done: true },
    ], { ...capabilities, vision: 'unsupported' });
    const selected: AiRequest = { ...request, model: 'vendor/vision:preview', reasoningEffort: 'high' };
    expect(await api.start(selected)).toEqual({ id: 'job' });
    expect(await api.consume(selected)).toEqual({ id: 'job', text: '' });
    expect(commands).toEqual([
      ['otools_host_ai_start', { request: selected }],
      ['otools_host_ai_capabilities', undefined],
      ['otools_host_ai_start', { request: selected }],
      ['otools_host_ai_read', { id: 'job', after: 0 }],
      ['otools_host_ai_read', { id: 'job', after: 1 }],
    ]);
  });

  it.each([undefined, 'host-model'])('retains the vision guard when using the default model: %s', async model => {
    const { api, commands } = fixture([], { ...capabilities, vision: 'unsupported' });
    await expect(api.consume({ ...request, model })).rejects.toMatchObject({ code: 'visionUnsupported' });
    expect(commands).toEqual([['otools_host_ai_capabilities', undefined]]);
  });

  it('normalizes transport errors from the new host methods', async () => {
    const api = createAiApi({ invoke: async () => { throw { code: 'hostUnavailable', message: 'Host unavailable' }; } });
    for (const call of [() => api.models(), () => api.getSettings(), () => api.saveSettings({ model: null, reasoningEffort: null })]) {
      await expect(call()).rejects.toMatchObject({ name: 'AiError', code: 'hostUnavailable', message: 'Host unavailable' });
    }
  });

  it('consumes sequenced private polls and acknowledges the terminal result', async () => {
    const { api, commands } = fixture([
      { id: 'job', events: [{ sequence: 1, type: 'delta', text: 'one ' }], done: false },
      { id: 'job', events: [{ sequence: 2, type: 'delta', text: 'two' }, { sequence: 3, type: 'done' }], done: true },
      { id: 'job', events: [], done: true },
    ]);
    const events: AiEvent[] = [];
    expect(await api.consume(request, { onEvent: event => events.push(event), pollIntervalMs: 0 })).toEqual({ id: 'job', text: 'one two' });
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(commands.filter(([command]) => command.endsWith('_read')).map(([, args]) => args?.after)).toEqual([0, 1, 3]);
  });

  it('does not reject unknown vision metadata and stops when host is not configured', async () => {
    const { api } = fixture([{ id: 'job', events: [{ sequence: 1, type: 'done' }], done: true }, { id: 'job', events: [], done: true }]);
    await expect(api.consume(request)).resolves.toEqual({ id: 'job', text: '' });
    const blocked = createAiApi({ invoke: async command => {
      if (command !== 'otools_host_ai_capabilities') throw new Error('must not start');
      return { ...capabilities, configured: false };
    } });
    await expect(blocked.consume(request)).rejects.toMatchObject({ code: 'notConfigured' });
  });

  it.each([
    { id: 'foreign', events: [], done: true },
    { id: 'job', events: [{ sequence: 2, type: 'delta', text: 'gap' }], done: false },
    { id: 'job', events: [{ sequence: 1, type: 'done' }, { sequence: 2, type: 'delta', text: 'late' }], done: true },
    { id: 'job', events: [], done: true },
  ])('rejects malformed batches and cancels the job', async result => {
    const { api, commands } = fixture([result]);
    await expect(api.consume(request)).rejects.toMatchObject({ code: 'invalidResponse' });
    expect(commands.some(([command]) => command === 'otools_host_ai_cancel')).toBe(true);
  });

  it('surfaces provider errors and host cancellation as terminal failures', async () => {
    for (const [type, code] of [['error', 'providerFailed'], ['cancelled', 'cancelled']] as const) {
      const { api } = fixture([{ id: 'job', events: [{ sequence: 1, type, ...(type === 'error' ? { error: code } : {}) }], done: true }]);
      await expect(api.consume(request)).rejects.toMatchObject({ code });
    }
  });

  it('aborts promptly during a stalled start, cancels the late id, and never dispatches callbacks', async () => {
    let resolveStart!: (value: unknown) => void;
    const calls: string[] = [];
    const callback = vi.fn();
    const controller = new AbortController();
    const api = createAiApi({ invoke: async command => {
      calls.push(command);
      if (command.endsWith('_capabilities')) return capabilities;
      if (command.endsWith('_start')) return new Promise(resolve => { resolveStart = resolve; });
    } });
    const pending = api.consume(request, { signal: controller.signal, onEvent: callback });
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    resolveStart({ id: 'late' });
    await vi.waitFor(() => expect(calls).toContain('otools_host_ai_cancel'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('aborts a stalled poll without waiting for IPC and ignores its late response', async () => {
    let resolveRead!: (value: unknown) => void;
    const controller = new AbortController();
    const callback = vi.fn();
    const calls: string[] = [];
    const api = createAiApi({ invoke: async command => {
      calls.push(command);
      if (command.endsWith('_capabilities')) return capabilities;
      if (command.endsWith('_start')) return { id: 'job' };
      if (command.endsWith('_read')) return new Promise(resolve => { resolveRead = resolve; });
    } });
    const pending = api.consume(request, { signal: controller.signal, onEvent: callback });
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    resolveRead({ id: 'job', events: [{ sequence: 1, type: 'delta', text: 'late' }], done: false });
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(calls).toContain('otools_host_ai_cancel');
  });

  it('does not start an already aborted request and cancels when a consumer callback throws', async () => {
    const { api, commands } = fixture([{ id: 'job', events: [{ sequence: 1, type: 'delta', text: 'x' }], done: false }]);
    const controller = new AbortController(); controller.abort();
    await expect(api.consume(request, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(commands).toEqual([]);
    await expect(api.consume(request, { onEvent() { throw new Error('callback'); } })).rejects.toThrow('callback');
    expect(commands.some(([command]) => command.endsWith('_cancel'))).toBe(true);
  });
});
