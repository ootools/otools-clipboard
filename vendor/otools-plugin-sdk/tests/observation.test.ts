import { describe, expect, it } from 'vitest';
import { createObservationApi } from '../src/observation-factory';
const target = { kind: 'screen' as const, displayId: '1' };
const active = { id: 'session', state: 'active', target, intervalMs: 60_000 };
const image = { imageId: 'image', mimeType: 'image/png', width: 100, height: 100, expiresAt: 9_999_999_999_999 };
describe('host-owned observation', () => {
  it('requires explicit targets and rejects aggressive intervals without invoking the host', async () => {
    const calls: string[] = [];
    const api = createObservationApi({ invoke: async command => { calls.push(command); return active; } });
    await expect(api.request({ target, intervalMs: 1 })).rejects.toMatchObject({ code: 'invalidRequest' });
    await expect(api.request({ target: { kind: 'window', windowId: '' } })).rejects.toMatchObject({ code: 'invalidRequest' });
    expect(calls).toEqual([]);
  });
  it('defaults to sixty seconds and returns pending consent without auto-approval or capture', async () => {
    const calls: unknown[] = [];
    const api = createObservationApi({ invoke: async (command, args) => {
      calls.push([command, args]); return { ...active, state: 'pending' };
    } });
    expect((await api.request({ target })).state).toBe('pending');
    expect(calls).toEqual([['otools_host_observation_request', { options: { target, intervalMs: 60_000 } }]]);
  });
  it('releases a late image when stop races capture completion', async () => {
    let deliver!: (value: unknown) => void;
    const released: string[] = [];
    const api = createObservationApi({ invoke: async (command, args) => {
      if (command.endsWith('_capture')) return new Promise(resolve => { deliver = resolve; });
      if (command.endsWith('_release')) released.push(String(args?.imageId));
      return active;
    } });
    const pending = api.capture({ id: 'session' });
    await api.stop({ id: 'session' });
    deliver(image);
    await expect(pending).rejects.toMatchObject({ code: 'stopped' });
    expect(released).toEqual(['image']);
  });
  it('rechecks live host status before handing an image to inference', async () => {
    const released: string[] = [];
    const api = createObservationApi({ invoke: async (command, args) => {
      if (command.endsWith('_capture')) return image;
      if (command.endsWith('_status')) return { ...active, state: 'stopped' };
      if (command.endsWith('_release')) released.push(String(args?.imageId));
    } });
    await expect(api.capture({ id: 'session' })).rejects.toMatchObject({ code: 'stopped' });
    expect(released).toEqual(['image']);
  });
  it('does not swallow cross-owner denial and returns successful owned image', async () => {
    const api = createObservationApi({ invoke: async command => {
      if (command.endsWith('_capture')) return image;
      if (command.endsWith('_status')) return active;
      throw { code: 'forbidden', message: 'Another caller' };
    } });
    expect(await api.capture({ id: 'session' })).toEqual(image);
    await expect(api.targets()).rejects.toMatchObject({ code: 'forbidden' });
  });
});
