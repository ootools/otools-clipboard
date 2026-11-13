// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const path = process.env.OTOOLS_HOST_ROOT
  ? `${process.env.OTOOLS_HOST_ROOT}/src/platform/runtime/otools/embedded-runtime.js`
  : new URL('../../../src/platform/runtime/otools/embedded-runtime.js', import.meta.url);
const embedded = readFileSync(path, 'utf8');

describe('plain WebView companion services', () => {
  it('exposes media choices and snapshots in the plain WebView runtime', async () => {
    const calls: unknown[] = [];
    const target: any = { location: { search: '' }, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push([command, args]);
        return { model: 'opaque-image' };
      },
    } };
    target.parent = target; target.top = target;
    new Function('window', embedded)(target);
    expect(typeof target.otools.ai.media?.getSettings).toBe('function');
    expect(await target.otools.ai.media.getSettings({ channel: 'images' })).toEqual({ model: 'opaque-image' });
    await target.otools.agent.start({ sessionId: 'fixture-session', prompt: 'fixture', mediaModels: { images: 'opaque-image' } });
    expect(calls).toEqual([
      ['otools_host_ai_media_get_settings', { channel: 'images' }],
      ['otools_host_agent_start', { request: { sessionId: 'fixture-session', prompt: 'fixture' }, mediaModels: { images: 'opaque-image' } }],
    ]);
  });

  it('routes typed services to the host without a native plugin library', async () => {
    const calls: unknown[] = [];
    const target: any = { location: { search: '' }, __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push([command, args]);
        if (command.endsWith('capabilities')) return { configured: true, streaming: true, cancellation: true, vision: 'unknown' };
        if (command.endsWith('targets')) return { screens: [], windows: [] };
        return [];
      },
    } };
    target.parent = target; target.top = target;
    new Function('window', embedded)(target);
    expect(target.otools.ai).toBeDefined();
    expect(target.otools.data).toBeDefined();
    expect(target.otools.observation).toBeDefined();
    expect(target.otools.reminders).toBeDefined();
    await target.otools.ai.capabilities();
    await target.otools.data.discover();
    await target.otools.observation.targets();
    await target.otools.reminders.status();
    expect(calls.map((call: any) => call[0])).toEqual([
      'otools_host_ai_capabilities', 'otools_host_plugin_data_discover',
      'otools_host_observation_targets', 'otools_host_plugin_reminders_status',
    ]);
  });
});
