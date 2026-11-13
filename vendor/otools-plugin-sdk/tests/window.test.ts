import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize, Position, Size } from "@tauri-apps/api/dpi";
import { getCurrentWindow, availableMonitors } from "../src/tauri-window-shim";
import { invoke, listen, listenTauri } from "../src/runtime";
import { getCurrentWebviewWindow } from "../src/tauri-webview-window-shim";

function installHost() {
  let nextId = 0;
  const callbacks = new Map<number, (payload: unknown) => void>();
  const subscriptions = new Map<number, { event: string; target: { kind: string; label?: string }; handler: number }>();
  const invokeHost = vi.fn(async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") {
      const id = ++nextId;
      subscriptions.set(id, args);
      return id;
    }
    if (command === "plugin:event|unlisten") subscriptions.delete(args.eventId);
    if (command === "plugin:window|outer_position") return { x: 300, y: 600 };
    if (command === "plugin:window|inner_size") return { width: 720, height: 600 };
    if (command === "plugin:window|scale_factor") return 2;
  });
  const unregisterCallback = vi.fn((id: number) => callbacks.delete(id));
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "custom-note-a" } },
      invoke: invokeHost,
      transformCallback: (callback: (payload: unknown) => void) => {
        const id = ++nextId;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback,
    },
    otools: { invokeNative: vi.fn(), invokeNativePlugin: vi.fn(), listenNative: vi.fn(), getPluginUuid: () => "notes" },
  });
  return {
    invokeHost, callbacks, subscriptions, unregisterCallback,
    fire(event: string, label: string, payload: unknown) {
      for (const [id, sub] of subscriptions) {
        if (sub.event === event && (!sub.target.label || sub.target.label === label)) {
          callbacks.get(sub.handler)?.({ event, id, payload });
        }
      }
    },
  };
}

describe("window host contracts", () => {
  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI_EVENT_PLUGIN_INTERNALS__;
    delete window.otools;
    delete window.__OToolsEnv;
    delete (window as any).__OTOOLS_CUSTOM_WINDOW__;
  });

  it("serializes physical, logical and wrapped geometry without losing DPI units", async () => {
    const host = installHost();
    const current = getCurrentWindow();
    for (const position of [new PhysicalPosition(300, 600), new LogicalPosition(150, 300), new Position(new LogicalPosition(20, 30)), { x: 4, y: 6 }]) await current.setPosition(position);
    for (const size of [new PhysicalSize(720, 600), new LogicalSize(360, 300), new Size(new LogicalSize(50, 60)), { width: 10, height: 12 }]) await current.setSize(size);
    const values = host.invokeHost.mock.calls.map(([, args]) => JSON.parse(JSON.stringify(args)).value);
    expect(values).toEqual([
      { Physical: { x: 300, y: 600 } }, { Logical: { x: 150, y: 300 } },
      { Logical: { x: 20, y: 30 } }, { Physical: { x: 4, y: 6 } },
      { Physical: { width: 720, height: 600 } }, { Logical: { width: 360, height: 300 } },
      { Logical: { width: 50, height: 60 } }, { Physical: { width: 10, height: 12 } },
    ]);
    expect((await current.outerPosition()).toLogical(await current.scaleFactor())).toMatchObject({ x: 150, y: 300 });
    expect((await current.innerSize()).toLogical(2)).toMatchObject({ width: 360, height: 300 });
  });

  it("targets move and resize events to the captured window and releases callbacks", async () => {
    const host = installHost();
    const a = getCurrentWindow();
    window.__TAURI_INTERNALS__!.metadata!.currentWindow!.label = "custom-note-b";
    const b = getCurrentWindow();
    const moved = vi.fn();
    const resized = vi.fn();
    const stopMove = await a.onMoved(moved);
    const stopResize = await b.onResized(resized);
    expect([...host.subscriptions.values()].map(({ target }) => target)).toEqual([
      { kind: "Window", label: "custom-note-a" }, { kind: "Window", label: "custom-note-b" },
    ]);
    host.fire("tauri://move", "custom-note-a", { x: 300, y: 600 });
    host.fire("tauri://resize", "custom-note-a", { width: 1, height: 2 });
    host.fire("tauri://resize", "custom-note-b", { width: 720, height: 600 });
    expect(moved.mock.calls[0][0].payload.toLogical(2)).toMatchObject({ x: 150, y: 300 });
    expect(resized.mock.calls[0][0].payload.toLogical(2)).toMatchObject({ width: 360, height: 300 });
    expect(resized).toHaveBeenCalledTimes(1);
    await stopMove(); await stopMove(); await stopResize();
    host.fire("tauri://move", "custom-note-a", { x: 0, y: 0 });
    expect(moved).toHaveBeenCalledTimes(1);
    expect(host.callbacks.size).toBe(0);
    expect(host.subscriptions.size).toBe(0);
    expect(host.unregisterCallback).toHaveBeenCalledTimes(2);
    expect(window.otools!.listenNative).not.toHaveBeenCalled();
  });

  it("keeps dragging and close on the original instance", async () => {
    const host = installHost();
    const current = getCurrentWindow();
    window.__TAURI_INTERNALS__!.metadata!.currentWindow!.label = "custom-note-b";
    await current.startDragging();
    await current.startResizeDragging("SouthEast");
    await current.close();
    expect(host.invokeHost.mock.calls).toEqual([
      ["plugin:window|start_dragging", { label: "custom-note-a" }],
      ["plugin:window|start_resize_dragging", { label: "custom-note-a", value: "SouthEast" }],
      ["plugin:window|close", { label: "custom-note-a" }],
    ]);
  });

  it("releases a native callback when subscription fails", async () => {
    const host = installHost();
    host.invokeHost.mockRejectedValueOnce(new Error("denied"));
    await expect(listenTauri("tauri://move", () => {})).rejects.toThrow("denied");
    expect(host.callbacks.size).toBe(0);
  });

  it("routes custom activation and explicit event targets through the host", async () => {
    const host = installHost();
    const seen = vi.fn();
    const stop = await listen("otools:custom-open", seen);
    const stopTarget = await listen("note-updated", seen, { target: { kind: "Window", label: "custom-note-a" } });
    host.fire("otools:custom-open", "custom-note-a", { source: "launcher" });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ payload: { source: "launcher" } }));
    expect(window.otools!.listenNative).not.toHaveBeenCalled();
    await stop(); await stopTarget();
  });

  it("announces custom readiness only after the native activation listener exists", async () => {
    const host = installHost();
    Object.assign(window, { __OTOOLS_CUSTOM_WINDOW__: { pluginUuid: "notes", pluginSource: "dev", windowId: "a" } });
    const stop = await listen("otools:custom-open", () => {});
    expect(host.invokeHost.mock.calls.map(([command]) => command)).toEqual(["plugin:event|listen", "custom_plugin_window_ready"]);
    expect(host.invokeHost).toHaveBeenLastCalledWith("custom_plugin_window_ready", { ready: true });
    expect([...host.subscriptions.values()][0].target).toEqual({ kind: "Webview", label: "custom-note-a" });
    const stopSecond = await listen("otools:custom-open", () => {});
    await stop();
    expect(host.invokeHost.mock.calls.filter(([command]) => command === "custom_plugin_window_ready")).toHaveLength(1);
    await stopSecond();
    expect(host.invokeHost).toHaveBeenCalledWith("custom_plugin_window_ready", { ready: false });
    host.invokeHost.mockClear();
    host.invokeHost.mockRejectedValueOnce(new Error("listen denied"));
    await expect(listen("otools:custom-open", () => {})).rejects.toThrow("listen denied");
    expect(host.invokeHost).not.toHaveBeenCalledWith("custom_plugin_window_ready", {});
  });

  it("shares custom-open readiness across runtime, Window and WebviewWindow listeners", async () => {
    const host = installHost();
    window.__OTOOLS_CUSTOM_WINDOW__ = { pluginUuid: "notes", pluginSource: "dev", windowId: "a" };
    const stopRuntime = await listen("otools:custom-open", () => {});
    const stopWindow = await getCurrentWindow().listen("otools:custom-open", () => {});
    const stopWebview = await getCurrentWebviewWindow().listen("otools:custom-open", () => {});
    const stopGeneric = await getCurrentWebviewWindow().listen("note-updated", () => {});
    const targets = [...host.subscriptions.values()].map(({ target }) => target);
    await stopRuntime();
    const readinessAfterRuntimeStops = host.invokeHost.mock.calls.filter(([command]) => command === "custom_plugin_window_ready");
    await stopWindow(); await stopWebview(); await stopGeneric();
    expect(targets).toEqual([
      { kind: "Webview", label: "custom-note-a" },
      { kind: "Webview", label: "custom-note-a" },
      { kind: "Webview", label: "custom-note-a" },
      { kind: "Window", label: "custom-note-a" },
    ]);
    expect(readinessAfterRuntimeStops).toEqual([["custom_plugin_window_ready", { ready: true }]]);
    expect(host.invokeHost.mock.calls.filter(([command]) => command === "custom_plugin_window_ready")).toEqual([
      ["custom_plugin_window_ready", { ready: true }], ["custom_plugin_window_ready", { ready: false }],
    ]);
    expect(host.callbacks.size).toBe(0);
  });

  it("automatically disables readiness after the current WebviewWindow once listener fires", async () => {
    const host = installHost();
    window.__OTOOLS_CUSTOM_WINDOW__ = { pluginUuid: "notes", pluginSource: "dev", windowId: "a" };
    const handler = vi.fn();
    const stop = await getCurrentWebviewWindow().once("otools:custom-open", handler);
    host.fire("otools:custom-open", "custom-note-a", { windowId: "a" });
    host.fire("otools:custom-open", "custom-note-a", { windowId: "a" });
    await vi.waitFor(() => expect(host.callbacks.size).toBe(0));
    await stop();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(host.invokeHost.mock.calls.filter(([command]) => command === "custom_plugin_window_ready")).toEqual([
      ["custom_plugin_window_ready", { ready: true }], ["custom_plugin_window_ready", { ready: false }],
    ]);
  });

  it("cleans concurrent subscriptions when readiness fails", async () => {
    const host = installHost();
    window.__OTOOLS_CUSTOM_WINDOW__ = { pluginUuid: "notes", pluginSource: "dev", windowId: "a" };
    const original = host.invokeHost.getMockImplementation()!;
    host.invokeHost.mockImplementation(async (command, args) => {
      if (command === "custom_plugin_window_ready") throw new Error("ready denied");
      return original(command, args);
    });
    const results = await Promise.allSettled([
      listen("otools:custom-open", () => {}), listen("otools:custom-open", () => {}),
    ]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(host.callbacks.size).toBe(0);
    expect(host.subscriptions.size).toBe(0);
  });

  it.each(["open_custom_plugin_window", "list_custom_plugin_windows", "close_custom_plugin_windows", "custom_plugin_window_ready"])("routes %s directly to the host", async (command) => {
    const host = installHost();
    await invoke(command, {});
    expect(host.invokeHost).toHaveBeenCalledWith(command, {});
    expect(window.otools!.invokeNativePlugin).not.toHaveBeenCalled();
    expect(window.otools!.invokeNative).not.toHaveBeenCalled();
  });

  it("exposes physical monitor bounds and centers only the selected window", async () => {
    const host = installHost();
    host.invokeHost.mockResolvedValueOnce([{ name: "Display", position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 2 }]);
    const monitors = await availableMonitors();
    expect(host.invokeHost).toHaveBeenCalledWith("plugin:window|available_monitors", undefined);
    expect(monitors[0].position.toLogical(2)).toMatchObject({ x: -960, y: 0 });
    expect(monitors[0].size.toLogical(2)).toMatchObject({ width: 960, height: 540 });
    await getCurrentWindow().center();
    expect(host.invokeHost).toHaveBeenLastCalledWith("plugin:window|center", { label: "custom-note-a" });
    delete window.__TAURI_INTERNALS__;
    expect((await availableMonitors())[0].size.width).toBeGreaterThan(0);
  });

  it("allows browser activation listeners and current window APIs without native internals", async () => {
    const seen = vi.fn();
    const stop = await listen("otools:custom-open", seen);
    window.dispatchEvent(new CustomEvent("otools-tauri:otools:custom-open", { detail: { payload: { source: "preview" } } }));
    expect(seen).toHaveBeenCalledTimes(1);
    await stop();
    await getCurrentWindow().startDragging();
    await getCurrentWindow().startResizeDragging("SouthEast");
  });
});
