import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock, invokeHostMock, listenHostMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  invokeHostMock: vi.fn(),
  listenHostMock: vi.fn(),
}));

vi.mock("../src/runtime", () => ({
  invoke: invokeMock,
  listen: listenMock,
  invokeTauri: invokeHostMock,
  listenTauri: listenHostMock,
  emit: vi.fn(),
}));

import { onOtoolsKeyword, OTOOLS_KEYWORD_DISPATCH_EVENT } from "../src/otools-keyword";

const stubPluginWindow = (pluginUuid: string) => {
  vi.stubGlobal("window", {
    __OToolsEnv: { pluginUuid },
    location: { search: "" },
  });
};

const dispatch = (overrides: Partial<{ id: string; keyword: string }> = {}) => ({
  id: overrides.id ?? "kw-1",
  keyword: overrides.keyword ?? "speak",
  payload: null,
  source: "shortcut",
  createdAtMs: 1,
});

describe("onOtoolsKeyword", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    invokeMock.mockReset();
    listenMock.mockReset();
    invokeHostMock.mockReset().mockImplementation((...args) => invokeMock(...args));
    listenHostMock.mockReset().mockImplementation((...args) => listenMock(...args));
  });

  it("uses the host keyword transport and the actual caller webview scope", async () => {
    stubPluginWindow("otools-x");
    window.__TAURI_INTERNALS__ = { metadata: { currentWebview: { label: 'panel-plugin-x' } } } as never;
    invokeMock.mockRejectedValue(new Error('no plugin native configuration'));
    listenMock.mockRejectedValue(new Error('wrong native topic'));
    invokeHostMock.mockResolvedValue([dispatch()]);
    listenHostMock.mockResolvedValue(() => {});
    const handler = vi.fn();
    await onOtoolsKeyword(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith([dispatch()]));
    expect(invokeHostMock).toHaveBeenCalledWith('otools_consume_keyword_dispatch', { pluginUuid: 'otools-x', targetLabel: 'panel-plugin-x' });
    expect(listenHostMock).toHaveBeenCalledWith(OTOOLS_KEYWORD_DISPATCH_EVENT, expect.any(Function));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("stops delivering late consumed keywords after unlisten", async () => {
    stubPluginWindow('otools-x');
    let resolve!: (value: unknown[]) => void;
    invokeHostMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    listenHostMock.mockResolvedValue(() => {});
    const handler = vi.fn();
    const stop = await onOtoolsKeyword(handler);
    await stop();
    resolve([dispatch()]);
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves an in-flight consumed batch for a replacement subscription', async () => {
    stubPluginWindow('otools-reload-test');
    let resolve!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((done) => { resolve = done; });
    invokeHostMock.mockReturnValueOnce(pending).mockResolvedValueOnce([dispatch({id:'newest',keyword:'panel-input'})]);
    listenHostMock.mockResolvedValue(() => {});
    const oldHandler = vi.fn();
    const stopOld = await onOtoolsKeyword(oldHandler);
    await stopOld();
    const newHandler = vi.fn();
    const stopNew = await onOtoolsKeyword(newHandler);
    resolve([dispatch({id:'old-pending'})]);
    await vi.waitFor(() => expect(newHandler).toHaveBeenCalled());
    const delivered = newHandler.mock.calls.flatMap(([items]) => items.map((item: {id:string}) => item.id));
    expect(delivered).toContain('old-pending');
    expect(delivered.at(-1)).toBe('newest');
    expect(oldHandler).not.toHaveBeenCalled();
    await stopNew();
  });

  it("registers the listener before consuming, then delivers drained entries", async () => {
    stubPluginWindow("otools-tts");
    let consumeCalls = 0;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe("otools_consume_keyword_dispatch");
      expect(args?.pluginUuid).toBe("otools-tts");
      consumeCalls += 1;
      return consumeCalls === 1 ? [dispatch(), dispatch({ id: "kw-2", keyword: "status" })] : [];
    });
    listenMock.mockResolvedValue(() => Promise.resolve());
    const handler = vi.fn();

    await onOtoolsKeyword(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    expect(listenMock.mock.calls[0][0]).toBe(OTOOLS_KEYWORD_DISPATCH_EVENT);
    expect(handler).toHaveBeenCalledWith([dispatch(), dispatch({ id: "kw-2", keyword: "status" })]);

    // 模拟一次敲门：consume 已排空 → handler 不再触发。
    const knock = listenMock.mock.calls[0][1] as () => void;
    knock();
    await vi.waitFor(() => expect(consumeCalls).toBe(2));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated ids across knocks and drops unknown-shaped entries", async () => {
    stubPluginWindow("otools-x");
    invokeMock.mockImplementation(async (command: string) => {
      expect(command).toBe("otools_consume_keyword_dispatch");
      return [dispatch(), dispatch(), { id: "", keyword: "" }];
    });
    listenMock.mockResolvedValue(() => Promise.resolve());
    const handler = vi.fn();

    await onOtoolsKeyword(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith([dispatch()]);

    invokeMock.mockResolvedValue([dispatch({ id: "kw-1" }), dispatch({ id: "kw-3", keyword: "stop" })]);
    const knock = listenMock.mock.calls[0][1] as () => void;
    knock();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    // 重复 id 被过滤，只回传新条目。
    expect(handler).toHaveBeenLastCalledWith([dispatch({ id: "kw-3", keyword: "stop" })]);
  });
});
