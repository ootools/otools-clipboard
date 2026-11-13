import { beforeEach, describe, expect, it, vi } from "vitest";

async function sdk() {
  return import("../src/tauri-webview-window-shim");
}

function nativeHost(custom = true) {
  const windows = new Map<string, { label: string; windowId: string }>();
  const native = vi.fn(async (command: string, args: any = {}) => {
    if (command === "open_custom_plugin_window") {
      const instance = { label: `custom-dev-notes-${args.windowId}`, windowId: args.windowId };
      windows.set(instance.label, instance);
      return instance;
    }
    if (command === "list_custom_plugin_windows") return [...windows.values()];
    if (command === "plugin:window|close" || command === "plugin:window|destroy") windows.delete(args.label);
    if (command === "plugin:window|get_all_windows") return ["main", "ordinary"];
  });
  Object.assign(window, {
    __TAURI_INTERNALS__: { invoke: native, metadata: { currentWindow: { label: "custom-dev-notes-main" }, currentWebview: { label: "custom-dev-notes-main" } } },
    otools: { invokeNative: vi.fn(), invokeNativePlugin: vi.fn() },
  });
  if (custom) Object.assign(window, { __OTOOLS_CUSTOM_WINDOW__: { pluginUuid: "notes", pluginSource: "dev", windowId: "main" } });
  return { native, windows };
}

// The native IPC boundary is faked; the constructor, identity resolution,
// lifecycle events, window operations and popup DOM all run real SDK code.
describe("WebviewWindow compatibility", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
    delete window.__TAURI_INTERNALS__;
    delete window.otools;
    delete (window as any).__OTOOLS_CUSTOM_WINDOW__;
    delete (window as any).__OTOOLS_POPUP_MANAGER__;
  });

  it("creates two independently targeted custom windows and emits created", async () => {
    const host = nativeHost();
    const { WebviewWindow } = await sdk();
    const a = new WebviewWindow("a", { title: "A", url: "index.html?noteId=a#body", width: 360, height: 300, x: 10, y: 20 });
    const b = new WebviewWindow("b", { width: 420 });
    const created = vi.fn();
    await a.once("tauri://created", created);
    await b.once("tauri://created", created);
    // Operations issued during creation must wait for the namespaced native label.
    await Promise.all([a.setPosition({ x: 100, y: 200 }), b.setSize({ width: 500, height: 600 })]);
    expect(created).toHaveBeenCalledTimes(2);
    expect(a.label).toBe("custom-dev-notes-a");
    expect(b.label).toBe("custom-dev-notes-b");
    expect(a.windowId).toBe("a");
    expect(host.native).toHaveBeenCalledWith("open_custom_plugin_window", {
      windowId: "a", title: "A", url: "index.html?noteId=a#body", options: { width: 360, height: 300, x: 10, y: 20 },
    });
    expect(host.native).toHaveBeenCalledWith("plugin:window|set_position", expect.objectContaining({ label: "custom-dev-notes-a" }));
    expect(host.native).toHaveBeenCalledWith("plugin:window|set_size", expect.objectContaining({ label: "custom-dev-notes-b" }));
    expect(window.otools!.invokeNativePlugin).not.toHaveBeenCalled();
  });

  it("looks up IDs and actual labels from the live host registry and drops closed windows", async () => {
    const host = nativeHost();
    const { WebviewWindow, getAllWebviewWindows, getCurrentWebviewWindow } = await sdk();
    const a = new WebviewWindow("a");
    const b = new WebviewWindow("b");
    await Promise.all([a.show(), b.show()]);
    expect((await WebviewWindow.getByLabel("a"))?.label).toBe("custom-dev-notes-a");
    expect((await WebviewWindow.getByLabel("custom-dev-notes-b"))?.windowId).toBe("b");
    expect((await getAllWebviewWindows()).map(w => w.windowId)).toEqual(["a", "b"]);
    expect(getCurrentWebviewWindow()).toMatchObject({ label: "custom-dev-notes-main", windowId: "main" });
    await a.close();
    expect(await WebviewWindow.getByLabel("a")).toBeNull();
    expect((await WebviewWindow.getAll()).map(w => w.windowId)).toEqual(["b"]);
    expect(host.native.mock.calls.filter(([command]) => command === "open_custom_plugin_window")).toHaveLength(2);
    await b.destroy();
    expect(await WebviewWindow.getAll()).toEqual([]);
  });

  it("prefers an exact native label over another instance's logical windowId", async () => {
    const host = nativeHost();
    const { WebviewWindow } = await sdk();
    const collision = new WebviewWindow("custom-dev-notes-a");
    const a = new WebviewWindow("a");
    await Promise.all([collision.show(), a.show()]);
    const exact = await WebviewWindow.getByLabel("custom-dev-notes-a");
    expect(exact).toMatchObject({ label: "custom-dev-notes-a", windowId: "a" });
    await exact!.close();
    expect([...host.windows.values()]).toEqual([
      { label: "custom-dev-notes-custom-dev-notes-a", windowId: "custom-dev-notes-a" },
    ]);
  });

  it("delivers creation errors once without leaving managed windows", async () => {
    const host = nativeHost();
    host.native.mockRejectedValueOnce("creation denied");
    const { WebviewWindow } = await sdk();
    const child = new WebviewWindow("bad");
    const failed = vi.fn();
    const created = vi.fn();
    child.once("tauri://error", failed);
    child.listen("tauri://created", created);
    await expect(child.show()).rejects.toBe("creation denied");
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: "tauri://error", payload: "creation denied" }));
    expect(created).not.toHaveBeenCalled();
    expect(await WebviewWindow.getAll()).toEqual([]);
  });

  it("allows lifecycle unlisten before creation finishes", async () => {
    const host = nativeHost();
    let resolve!: (value: any) => void;
    host.native.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const { WebviewWindow } = await sdk();
    const child = new WebviewWindow("a");
    const created = vi.fn();
    const stop = await child.listen("tauri://created", created);
    await stop(); await stop();
    resolve({ label: "custom-dev-notes-a", windowId: "a" });
    await child.show();
    expect(created).not.toHaveBeenCalled();
  });

  it("retains ordinary Tauri native creation outside custom context", async () => {
    const host = nativeHost(false);
    const { WebviewWindow } = await sdk();
    const parent = new WebviewWindow("parent");
    const child = new WebviewWindow("ordinary", { url: "settings.html", title: "Settings", parent });
    const created = vi.fn();
    await child.once("tauri://created", created);
    await child.show();
    expect(host.native).toHaveBeenCalledWith("plugin:webview|create_webview_window", { options: { label: "ordinary", url: "settings.html", title: "Settings", parent: "parent" } });
    expect(created).toHaveBeenCalledTimes(1);
    expect((await WebviewWindow.getByLabel("ordinary"))?.label).toBe("ordinary");
    expect(host.native.mock.calls.some(([command]) => command === "open_custom_plugin_window")).toBe(false);
  });

  it("propagates popup identity and registry into iframe child APIs", async () => {
    const { WebviewWindow } = await sdk();
    const child = new WebviewWindow("inside", { url: "index.html?noteId=inside" });
    await child.show();
    const iframe = document.querySelector("iframe")!;
    const childWindow = iframe.contentWindow!;
    const sibling = new WebviewWindow("sibling", { url: "index.html?noteId=sibling" });
    await sibling.show();
    vi.stubGlobal("window", childWindow);
    try {
      const childSdk = await sdk();
      const current = childSdk.getCurrentWebviewWindow();
      expect(current).toMatchObject({ label: "inside", windowId: "inside" });
      expect((await childSdk.WebviewWindow.getAll()).map(item => item.windowId)).toEqual(["inside", "sibling"]);
      expect(await childSdk.WebviewWindow.getByLabel("inside")).toMatchObject({ label: "inside" });
      const siblingHandle = await childSdk.WebviewWindow.getByLabel("sibling");
      await siblingHandle!.close();
      expect((await childSdk.WebviewWindow.getAll()).map(item => item.windowId)).toEqual(["inside"]);
      const childWindowSdk = await import("../src/tauri-window-shim");
      expect(childWindowSdk.getCurrentWindow().label).toBe("inside");
      await current.close();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("closes the current browser popup through the existing current-window fallback", async () => {
    const { WebviewWindow, getCurrentWebviewWindow } = await sdk();
    const child = new WebviewWindow("preview", { url: "index.html?noteId=preview" });
    await child.show();
    await getCurrentWebviewWindow().close();
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(await WebviewWindow.getAll()).toEqual([]);
  });

  it("opens independent browser iframe fallbacks and removes the selected popup", async () => {
    const { WebviewWindow } = await sdk();
    const a = new WebviewWindow("a", { url: "index.html?noteId=a" });
    const b = new WebviewWindow("b", { url: "index.html?noteId=b" });
    await Promise.all([a.show(), b.show()]);
    expect(document.querySelectorAll("iframe")).toHaveLength(2);
    expect((await WebviewWindow.getAll()).map(w => w.label)).toEqual(["a", "b"]);
    await a.close();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector("iframe")?.src).toContain("noteId=b");
    expect(await WebviewWindow.getByLabel("a")).toBeNull();
    (document.querySelector("button") as HTMLButtonElement).click();
    expect(await WebviewWindow.getAll()).toEqual([]);
  });
});
