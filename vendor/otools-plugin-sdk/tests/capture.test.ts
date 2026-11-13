import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sdk from '../src/index';

const image = { imageId: 'image-a', mimeType: 'image/png', width: 2, height: 1, expiresAt: 9999 };
const completed = { status: 'completed', captureId: 'capture-a', image, displayId: 'display-a', rect: { x: 0, y: 0, width: 2, height: 1 }, action: 'copy' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('capture host protocol', () => {
  it('exports a shared factory', () => { expect(sdk.createCaptureApi).toBeTypeOf('function'); });
  it('registers before begin and queries an already completed result even when the hint precedes the begin response', async () => {
    const calls: string[] = [];
    const stop = vi.fn();
    let hint!: (event: { payload: { captureId: string } }) => void;
    const api = sdk.createCaptureApi({
      listen: async (_event, handler) => { calls.push('listen'); hint = handler; return stop; },
      invoke: async (command, args) => {
        calls.push(command);
        if (command.endsWith('_begin')) { hint({ payload: { captureId: 'capture-a' } }); return { captureId: 'capture-a' }; }
        if (command.endsWith('_result')) { expect(args).toEqual({ captureId: 'capture-a' }); return completed; }
        throw Error(command);
      },
    });
    expect(await api.select()).toEqual(completed);
    expect(calls).toEqual(['listen', 'otools_host_capture_begin', 'otools_host_capture_result']);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('forwards silent single-pixel selection options and keeps the existing image lease result', async () => {
    const requests: unknown[] = [];
    const point = { ...completed, action: 'complete', image: { ...image, width: 1, height: 1 }, rect: { x: 17, y: 29, width: 1, height: 1 } };
    const api = sdk.createCaptureApi({ invoke: async (command, args) => {
      requests.push([command, args]);
      if (command.endsWith('_begin')) return { captureId: 'capture-a' };
      if (command.endsWith('_result')) return point;
      throw Error(command);
    } });
    expect(await api.select({ mode: 'color', edit: false, hideHost: true, restoreHost: false })).toEqual(point);
    expect(requests[0]).toEqual(['otools_host_capture_begin', { options: { mode: 'color', edit: false, hideHost: true, restoreHost: false } }]);
  });
  it.each([false, true])('preserves the selected freezeScreen=%s mode through the host protocol', async freezeScreen => {
    const requests: unknown[] = [];
    const api = sdk.createCaptureApi({ invoke: async (command, args) => {
      requests.push([command, args]);
      if (command.endsWith('_begin')) return { captureId: 'capture-a' };
      if (command.endsWith('_result')) return completed;
      throw Error(command);
    } });
    await api.select({ mode: 'color', edit: false, hideHost: false, restoreHost: false, freezeScreen });
    expect(requests[0]).toEqual(['otools_host_capture_begin', { options: { mode: 'color', edit: false, hideHost: false, restoreHost: false, freezeScreen } }]);
  });
  it('polls through missing notifications, serializes queries, and clears timers', async () => {
    vi.useFakeTimers();
    let queries = 0;
    const api = sdk.createCaptureApi({ invoke: async command => {
      if (command.endsWith('_begin')) return { captureId: 'capture-a' };
      if (command.endsWith('_result')) return ++queries === 3 ? completed : null;
      throw Error(command);
    } });
    const result = api.select();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual(completed);
    expect(queries).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts promptly and cancels a begin response that arrives after abort', async () => {
    vi.useFakeTimers();
    const begin = deferred<{ captureId: string }>();
    const cancelled: unknown[] = [];
    const controller = new AbortController();
    const stop = vi.fn();
    const api = sdk.createCaptureApi({ listen: async () => stop, invoke: async (command, args) => {
      if (command.endsWith('_begin')) return begin.promise;
      if (command.endsWith('_cancel')) { cancelled.push(args); return; }
      throw Error(command);
    } });
    const result = api.select({}, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await tick();
    controller.abort();
    await rejection;
    begin.resolve({ captureId: 'late-capture' });
    await tick();
    expect(cancelled).toEqual([{ captureId: 'late-capture' }]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not begin after abort while listener registration is pending and cleans a late listener', async () => {
    const registration = deferred<() => void>();
    const stop = vi.fn();
    const invoke = vi.fn();
    const controller = new AbortController();
    const api = sdk.createCaptureApi({ invoke, listen: () => registration.promise });
    const result = api.select({}, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await rejection;
    registration.resolve(stop);
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('bounds a silent session and cancels it on timeout', async () => {
    vi.useFakeTimers();
    const cancellations: unknown[] = [];
    const api = sdk.createCaptureApi({ invoke: async (command, args) => {
      if (command.endsWith('_begin')) return { captureId: 'capture-a' };
      if (command.endsWith('_cancel')) { cancellations.push(args); return; }
      return null;
    } });
    const result = api.select();
    const rejection = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await rejection;
    expect(cancellations).toEqual([{ captureId: 'capture-a' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('assembles exact bytes in bounded 1MiB reads and forwards resource leases', async () => {
    const first = new Uint8Array(1024 * 1024).fill(7);
    const requests: unknown[] = [];
    const api = sdk.createCaptureApi({ invoke: async (command, args) => {
      requests.push([command, args]);
      if (command.endsWith('_read_chunk')) {
        return args?.offset === 0
          ? { dataBase64: Buffer.from(first).toString('base64'), nextOffset: first.length, totalBytes: first.length + 2 }
          : { dataBase64: 'AP8=', nextOffset: first.length + 2, totalBytes: first.length + 2 };
      }
      if (command.endsWith('_retain')) return image;
    } });
    const bytes = await api.readImage('image-a');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(1048578);
    expect([...bytes.subarray(-3)]).toEqual([7, 0, 255]);
    expect(await api.retain('image-a')).toEqual(image);
    await api.release('image-a');
    expect(requests).toEqual([
      ['otools_host_capture_read_chunk', { imageId: 'image-a', offset: 0, length: 1048576 }],
      ['otools_host_capture_read_chunk', { imageId: 'image-a', offset: 1048576, length: 1048576 }],
      ['otools_host_capture_retain', { imageId: 'image-a' }],
      ['otools_host_capture_release', { imageId: 'image-a' }],
    ]);
  });
  it.each([
    { dataBase64: '', nextOffset: 0, totalBytes: 1 },
    { dataBase64: 'AQ==', nextOffset: 2, totalBytes: 2 },
    { dataBase64: '!', nextOffset: 1, totalBytes: 1 },
    { dataBase64: 'AQ==', nextOffset: 1, totalBytes: 1024 ** 4 },
  ])('rejects malformed chunks without looping or unbounded allocation (%j)', async chunk => {
    const api = sdk.createCaptureApi({ invoke: async () => chunk });
    await expect(api.readImage('image-a')).rejects.toMatchObject({ code: 'captureFailed' });
  });
  it('releases a completed artifact when a pending result response arrives after abort', async () => {
    const pending = deferred<unknown>();
    const releases: unknown[] = [];
    const api = sdk.createCaptureApi({ invoke: async (command, args) => {
      if (command.endsWith('_begin')) return { captureId: 'capture-a' };
      if (command.endsWith('_result')) return pending.promise;
      if (command.endsWith('_release')) releases.push(args);
    } });
    const controller = new AbortController();
    const result = api.select({}, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); controller.abort(); await rejection;
    pending.resolve(completed); await tick();
    expect(releases).toEqual([{ imageId: 'image-a' }]);
  });
  it('subscribes the singleton to host events rather than plugin native events', async () => {
    const commands: string[] = [];
    const nativeListen = vi.fn();
    vi.stubGlobal('window', { otools: { invokeNative: vi.fn(), listenNative: nativeListen },
      __TAURI_INTERNALS__: { transformCallback: () => 42, unregisterCallback: vi.fn(), invoke: async (command: string) => {
        commands.push(command);
        if (command === 'plugin:event|listen') return 1;
        if (command.endsWith('_begin')) return { captureId: 'capture-a' };
        if (command.endsWith('_result')) return completed;
      } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    expect(await sdk.capture.select()).toEqual(completed);
    expect(commands.slice(0, 2)).toEqual(['plugin:event|listen', 'otools_host_capture_begin']);
    expect(nativeListen).not.toHaveBeenCalled();
  });
  it('releases an artifact completed between polling and abort', async () => {
    const releases: unknown[] = [];
    let terminal = false;
    const api = sdk.createCaptureApi({ invoke: async (command, args) => {
      if (command.endsWith('_begin')) return { captureId: 'capture-a' };
      if (command.endsWith('_result')) return terminal ? completed : null;
      if (command.endsWith('_release')) releases.push(args);
    } });
    const controller = new AbortController();
    const result = api.select({}, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    await tick(); terminal = true; controller.abort(); await rejection; await tick();
    expect(releases).toEqual([{ imageId: 'image-a' }]);
  });
  it('unregisters its callback when host event registration fails', async () => {
    const unregisterCallback = vi.fn();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { transformCallback: () => 77, unregisterCallback,
      invoke: async (command: string) => {
        if (command === 'plugin:event|listen') throw Error('events unavailable');
        if (command.endsWith('_begin')) return { captureId: 'capture-a' };
        if (command.endsWith('_result')) return completed;
      } } });
    expect(await sdk.capture.select()).toEqual(completed);
    expect(unregisterCallback).toHaveBeenCalledWith(77);
  });
  it('pins processed images through the public host capability', async () => {
    const requests: unknown[] = [];
    const api = sdk.createCaptureApi({ invoke: async (command, args) => { requests.push([command, args]); return { pinId: 'pin-a' }; } });
    const options = { dataUrl: 'data:image/png;base64,AP8=', logicalBounds: { x: -100, y: 20, width: 200, height: 100 } };
    expect(await api.pin(options)).toEqual({ pinId: 'pin-a' });
    expect(requests).toEqual([['otools_host_capture_pin', { options }]]);
  });
  it('normalizes structured wire rejections and unavailable runtimes', async () => {
    const api = sdk.createCaptureApi({ invoke: async () => { throw JSON.stringify({ code: 'permissionDenied', message: 'Denied' }); } });
    await expect(api.screen()).rejects.toMatchObject({ code: 'permissionDenied', message: 'Denied' });
    await expect(sdk.createCaptureApi({ invoke: async () => { throw Error('unknown command: otools_host_capture_capabilities'); } }).capabilities()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(sdk.capture.capabilities()).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('opens managed gallery windows through host routing without a native library', async () => {
    const plugin = vi.fn(() => { throw Error('No native library'); });
    const commands: string[] = [];
    vi.stubGlobal('window', { otools: { invokeNative: plugin, invokeNativePlugin: plugin }, __TAURI_INTERNALS__: { invoke: async (command: string) => { commands.push(command); } } });
    await sdk.invoke('detach_tools_tab_to_window', { label: 'crop-editor-a', title: 'Editor', pluginUuid: 'otools-crop', url: 'otools-plugin://localhost/otools-crop/dist/index.html?mode=editor' });
    expect(commands).toEqual(['detach_tools_tab_to_window']);
    expect(plugin).not.toHaveBeenCalled();
  });
  it('routes official gallery update events between detached and main plugin views', async () => {
    const commands: unknown[] = [];
    const native = vi.fn();
    vi.stubGlobal('window', { otools: { invokeNative: native, listenNative: native },
      __TAURI_INTERNALS__: { transformCallback: () => 9, unregisterCallback: vi.fn(), invoke: async (command: string, args: unknown) => { commands.push([command, args]); return 2; } },
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
    const stop = await sdk.listen('crop-images-updated', () => {});
    await sdk.emit('crop-images-updated', { path: '/new.png' });
    await stop();
    expect(commands).toEqual([
      ['plugin:event|listen', { event: 'crop-images-updated', target: { kind: 'Any' }, handler: 9 }],
      ['plugin:event|emit', { event: 'crop-images-updated', payload: { path: '/new.png' } }],
      ['plugin:event|unlisten', { event: 'crop-images-updated', eventId: 2 }],
    ]);
    expect(native).not.toHaveBeenCalled();
  });
  it('forwards permission repair to the host without extra arguments or native routing', async () => {
    const nativePlugin = vi.fn(() => { throw Error('No plugin native library'); });
    const calls: unknown[] = [];
    vi.stubGlobal('window', { otools: { invokeNative: nativePlugin, invokeNativePlugin: nativePlugin }, __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => { calls.push([command, args]); return { status: 'reset', restartRequired: true }; } } });
    expect(await sdk.capture.repairPermission()).toEqual({ status: 'reset', restartRequired: true });
    expect(calls).toEqual([['otools_host_capture_repair_permission', undefined]]);
    expect(nativePlugin).not.toHaveBeenCalled();
  });
  it('routes singleton commands to the host without a plugin native library', async () => {
    const nativePlugin = vi.fn(() => { throw Error('No plugin native library'); });
    const calls: unknown[] = [];
    vi.stubGlobal('window', { otools: { invokeNative: nativePlugin, invokeNativePlugin: nativePlugin }, __TAURI_INTERNALS__: { invoke: async (command: string, args: unknown) => { calls.push([command, args]); return completed; } } });
    expect(await sdk.capture.region({ displayId: 'left', rect: { x: 2, y: 3, width: 4, height: 5 } })).toEqual(completed);
    expect(calls).toEqual([['otools_host_capture_region', { options: { displayId: 'left', rect: { x: 2, y: 3, width: 4, height: 5 } } }]]);
    expect(nativePlugin).not.toHaveBeenCalled();
  });
});
