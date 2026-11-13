// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const embeddedPath = process.env.OTOOLS_HOST_ROOT
  ? `${process.env.OTOOLS_HOST_ROOT}/src/platform/runtime/otools/embedded-runtime.js`
  : new URL('../../../src/platform/runtime/otools/embedded-runtime.js', import.meta.url);
const embedded = readFileSync(embeddedPath, 'utf8');
function load(invoke: (command: string, args?: unknown) => Promise<unknown>) {
  const target = { __TAURI_INTERNALS__: { invoke }, location: { search: '' } } as any;
  target.parent = target; target.top = target;
  new Function('window', embedded)(target);
  return target.otools;
}
describe('plain webview capture injection', () => {
  it('exposes host capture without module imports or plugin native library', async () => {
    const calls: unknown[] = [];
    const api = load(async (command, args) => { calls.push([command, args]); return { granted: true, canRequest: true }; });
    expect(api.capture).toBeDefined();
    expect(await api.capture.permissionStatus()).toEqual({ granted: true, canRequest: true });
    expect(calls).toEqual([['otools_host_capture_permission_status', undefined]]);
  });
  it('matches current factory build so SDK fixes cannot leave stale injected behavior', () => {
    const source = readFileSync(new URL('../src/capture-factory.ts', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export (?=(?:class|function|const) )/gm, '');
    const block = embedded.split('// BEGIN GENERATED CAPTURE FACTORY\n')[1]?.split('// END GENERATED CAPTURE FACTORY')[0];
    expect(block).toBe(compiled);
  });
  it('cleans native callbacks when event subscription fails', async () => {
    const unregisterCallback = vi.fn();
    const target: any = { location: { search: '' }, __TAURI_INTERNALS__: { transformCallback: () => 13, unregisterCallback, invoke: async (command: string) => {
      if (command === 'plugin:event|listen') throw Error('events unavailable');
      if (command.endsWith('_begin')) return { captureId: 'a' };
      if (command.endsWith('_result')) return { status: 'cancelled', captureId: 'a' };
    } } };
    target.parent = target; target.top = target;
    new Function('window', embedded)(target);
    expect(await target.otools.capture.select()).toEqual({ status: 'cancelled', captureId: 'a' });
    expect(unregisterCallback).toHaveBeenCalledWith(13);
  });
  it('runs injected cancellation and chunk behavior', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const api = load(async (command, args: any) => {
      calls.push(command);
      if (command.endsWith('_begin')) return { captureId: 'a' };
      if (command.endsWith('_result')) return null;
      if (command.endsWith('_read_chunk')) return { dataBase64: 'AP8=', nextOffset: 2, totalBytes: 2 };
    });
    try {
      const controller = new AbortController();
      const promise = api.capture.select({}, controller.signal);
      const rejection = expect(promise).rejects.toMatchObject({ code: 'cancelled' });
      await vi.advanceTimersByTimeAsync(1);
      controller.abort(); await rejection;
      expect(calls).toContain('otools_host_capture_cancel');
      expect([...await api.capture.readImage('a')]).toEqual([0, 255]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
