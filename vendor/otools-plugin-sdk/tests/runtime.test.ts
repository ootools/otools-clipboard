import { beforeEach, describe, expect, it, vi } from "vitest";
import { transformCallback } from "../src/tauri-core-shim";
import { invoke, listen } from "../src/runtime";
import { confirm, open as openDialog } from "../src/tauri-plugin-dialog-shim";

describe("otools runtime bridge", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    delete (window as Window & { otools?: unknown }).otools;
    delete (window as Window & { utools?: unknown }).utools;
    delete (
      window as Window & { __TAURI_INTERNALS__?: unknown }
    ).__TAURI_INTERNALS__;
    delete (
      window as Window & { __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__;
    delete (window as Window & { __OToolsEnv?: unknown }).__OToolsEnv;
  });

  it('routes media execution directly to the host even when the plugin has no native library', async () => {
    const native = vi.fn().mockRejectedValue(new Error('Plugin has no native library'));
    const host = vi.fn().mockResolvedValue({ model: 'chosen', images: [] });
    Object.assign(window, { otools: { invokeNative: native, invokeNativePlugin: native }, __TAURI_INTERNALS__: { invoke: host } });
    expect(await invoke('otools_ai_images', { request: { prompt: 'fixture', model: 'chosen' } })).toEqual({ model: 'chosen', images: [] });
    expect(native).not.toHaveBeenCalled();
    expect(host).toHaveBeenCalledWith('otools_ai_images', { request: { prompt: 'fixture', model: 'chosen' } });
  });

  it("copies text through the host and waits for the actual clipboard result", async () => {
    const native = vi.fn().mockRejectedValue(new Error('Plugin has no native library'));
    const host = vi.fn().mockResolvedValue(true);
    Object.assign(window, {
      otools: { invokeNative: native, invokeNativePlugin: native },
      __TAURI_INTERNALS__: { invoke: host },
    });
    await expect(invoke('otools_copy_text', { text: '#12ABEF' })).resolves.toBe(true);
    expect(host).toHaveBeenCalledWith('otools_copy_text', { text: '#12ABEF' });
    expect(native).not.toHaveBeenCalled();
    host.mockRejectedValueOnce(new Error('Clipboard is unavailable'));
    await expect(invoke('otools_copy_text', { text: '#12ABEF' })).rejects.toThrow('Clipboard is unavailable');
  });

  it("hides only the host Panel without calling the plugin native library", async () => {
    const native = vi.fn().mockRejectedValue(new Error('Plugin has no native library'));
    const host = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, {
      otools: { invokeNative: native, invokeNativePlugin: native },
      __TAURI_INTERNALS__: { invoke: host },
    });
    await invoke('hide_panel_window', {});
    expect(host).toHaveBeenCalledWith('hide_panel_window', {});
    expect(native).not.toHaveBeenCalled();
  });

  it("opens iframe popup for secondary window commands", async () => {
    (window as Window & { otools?: unknown }).otools = {
      invokeNative: vi.fn().mockResolvedValue({ path: "/settings/system" }),
    };

    await invoke("open_settings_window", { section: "system" });
    const iframe = document.querySelector(
      "iframe[data-otools-popup-target]",
    ) as HTMLIFrameElement | null;
    expect(iframe?.src).toContain("/settings/system");
  });

  it("forwards listenNative events into tauri-style listeners", async () => {
    (window as Window & { otools?: unknown }).otools = {
      invokeNative: vi.fn(),
      listenNative: vi.fn(
        async (
          handler: (event: { payload: { topic: string; payload: unknown } }) => void,
        ) => {
          handler({ payload: { topic: "acp://event", payload: { seq: 1 } } });
          return async () => {};
        },
      ),
    };

    const seen: number[] = [];
    const unlisten = await listen("acp://event", (event) => {
      seen.push((event.payload as { seq: number }).seq);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 50));
    await unlisten();
    expect(seen).toEqual([1]);
  });

  it("installs tauri-style unregister hooks for native event listeners", async () => {
    let nativeHandler:
      | ((event: { payload: { topic: string; payload: unknown } }) => void)
      | undefined;

    (window as Window & { otools?: unknown }).otools = {
      invokeNative: vi.fn(),
      listenNative: vi.fn(
        async (
          handler: (event: { payload: { topic: string; payload: unknown } }) => void,
        ) => {
          nativeHandler = handler;
          return async () => {};
        },
      ),
    };

    const seen: number[] = [];
    const handlerId = transformCallback((event: { payload: { seq: number } }) => {
      seen.push(event.payload.seq);
    });

    const eventId = await invoke<number>("plugin:event|listen", {
      event: "acp://event",
      target: { kind: "Any" },
      handler: handlerId,
    });

    nativeHandler?.({
      payload: { topic: "acp://event", payload: { seq: 1 } },
    });
    expect(seen).toEqual([1]);

    await (
      window as Window & {
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener?: (event: string, eventId: number) => Promise<void> | void;
        };
      }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener?.(
      "acp://event",
      eventId,
    );

    nativeHandler?.({
      payload: { topic: "acp://event", payload: { seq: 2 } },
    });
    expect(seen).toEqual([1]);
  });

  it("prefers host dialog APIs when available", async () => {
    const dialog = {
      open: vi.fn().mockResolvedValue("/tmp/example.txt"),
      save: vi.fn().mockResolvedValue("/tmp/output.txt"),
      message: vi.fn().mockResolvedValue(undefined),
      confirm: vi.fn().mockResolvedValue(true),
      ask: vi.fn().mockResolvedValue(true),
    };

    (window as Window & { otools?: unknown }).otools = {
      invokeNative: vi.fn(),
      dialog,
    };

    await expect(openDialog({ title: "Pick" })).resolves.toBe("/tmp/example.txt");
    await expect(confirm("Continue?")).resolves.toBe(true);

    expect(dialog.open).toHaveBeenCalledWith({ title: "Pick" });
    expect(dialog.confirm).toHaveBeenCalledWith("Continue?", undefined);
  });

  it("falls back to tauri internals when otools runtime is absent", async () => {
    const invokeInternal = vi
      .fn<(command: string, payload?: Record<string, unknown>) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true });

    (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: typeof invokeInternal;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeInternal,
    };

    await expect(invoke("healthcheck", { scope: "desktop" })).resolves.toEqual({
      ok: true,
    });
    expect(invokeInternal).toHaveBeenCalledWith(
      "healthcheck",
      { scope: "desktop" },
    );
  });

  it("routes tauri plugin commands through tauri internals in otools runtime", async () => {
    const invokeNativePlugin = vi.fn().mockResolvedValue({ ignored: true });
    const invokeInternal = vi
      .fn<(command: string, payload?: Record<string, unknown>) => Promise<string | null>>()
      .mockResolvedValue("D:/Downloads/demo.torrent");

    (window as Window & { otools?: unknown }).otools = {
      invokeNativePlugin,
    };
    (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: typeof invokeInternal;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeInternal,
    };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-bt" };

    await expect(openDialog({ title: "Pick BT" })).resolves.toBe(
      "D:/Downloads/demo.torrent",
    );
    expect(invokeInternal).toHaveBeenCalledWith("plugin:dialog|open", {
      options: { title: "Pick BT" },
    });
    expect(invokeNativePlugin).not.toHaveBeenCalled();
  });

  it("adapts directory reads through the shared host filesystem API", async () => {
    const invokeNative = vi.fn();
    const invokeNativePlugin = vi.fn();
    const listHostDir = vi.fn().mockResolvedValue([
      {
        name: "src",
        path: "C:/repo/src",
        kind: "directory",
        size: 0,
        mime: "inode/directory",
      },
      {
        name: "README.md",
        path: "C:/repo/README.md",
        kind: "file",
        size: 12,
        mime: "text/markdown",
      },
      {
        name: ".git",
        path: "C:/repo/.git",
        kind: "directory",
        size: 0,
        mime: "inode/directory",
      },
    ]);

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
      invokeNativePlugin,
      listHostDir,
    };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-git" };

    await expect(
      invoke("read_directory_recursive", { path: "C:/repo" }),
    ).resolves.toEqual([
      {
        id: "C:/repo/src",
        label: "src",
        path: "C:/repo/src",
        is_directory: true,
        isLeaf: false,
      },
      {
        id: "C:/repo/README.md",
        label: "README.md",
        path: "C:/repo/README.md",
        is_directory: false,
        isLeaf: true,
      },
    ]);
    expect(listHostDir).toHaveBeenCalledOnce();
    expect(listHostDir).toHaveBeenCalledWith("C:/repo");
    expect(invokeNative).not.toHaveBeenCalled();
    expect(invokeNativePlugin).not.toHaveBeenCalled();
  });

  it("adapts UTF-8 text reads through the shared host filesystem API", async () => {
    const invokeNative = vi.fn();
    const readHostFile = vi.fn().mockResolvedValue({
      path: "C:/repo/demo.txt",
      name: "demo.txt",
      size: 12,
      mime: "text/plain",
      dataBase64: "aGVsbG8g5LiW55WM",
    });

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
      readHostFile,
    };

    await expect(
      invoke("read_file_content", { filePath: "C:/repo/demo.txt" }),
    ).resolves.toBe("hello 世界");
    expect(readHostFile).toHaveBeenCalledWith("C:/repo/demo.txt");
    expect(invokeNative).not.toHaveBeenCalled();
  });

  it("adapts UTF-8 text writes through the shared host filesystem API", async () => {
    const invokeNative = vi.fn();
    const writeHostFile = vi.fn().mockResolvedValue(undefined);

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
      writeHostFile,
    };

    await expect(
      invoke("write_file_content", {
        filePath: "C:/repo/demo.txt",
        content: "hello 世界",
      }),
    ).resolves.toBeUndefined();
    expect(writeHostFile).toHaveBeenCalledWith({
      path: "C:/repo/demo.txt",
      dataBase64: "aGVsbG8g5LiW55WM",
    });
    expect(invokeNative).not.toHaveBeenCalled();
  });

  it("adapts empty text writes through the shared host filesystem API", async () => {
    const invokeNative = vi.fn();
    const writeHostFile = vi.fn().mockResolvedValue(undefined);

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
      writeHostFile,
    };

    await invoke("write_file_content", {
      filePath: "C:/repo/empty.txt",
      content: "",
    });

    expect(writeHostFile).toHaveBeenCalledWith({
      path: "C:/repo/empty.txt",
      dataBase64: "",
    });
    expect(invokeNative).not.toHaveBeenCalled();
  });

  it("falls back to native plugin invoke when host returns unknown method", async () => {
    const invokeInternal = vi
      .fn<(command: string, payload?: Record<string, unknown>) => Promise<never>>()
      .mockRejectedValue(new Error("unknown method: load_repos_data"));
    const invokeNative = vi.fn().mockResolvedValue([{ id: 1 }]);

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
    };
    (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: typeof invokeInternal;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeInternal,
    };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-git" };

    await expect(invoke("load_repos_data")).resolves.toEqual([{ id: 1 }]);
    expect(invokeNative).toHaveBeenCalledWith("load_repos_data", null);
  });

  it("falls back when host error message is wrapped in object fields", async () => {
    const invokeInternal = vi
      .fn<(command: string, payload?: Record<string, unknown>) => Promise<never>>()
      .mockRejectedValue({ message: "unknown method: git_get_installation_status" });
    const invokeNative = vi.fn().mockResolvedValue({ installed: true });

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
    };
    (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: typeof invokeInternal;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeInternal,
    };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-git" };

    await expect(invoke("git_get_installation_status")).resolves.toEqual({
      installed: true,
    });
    expect(invokeNative).toHaveBeenCalledWith(
      "git_get_installation_status",
      null,
    );
  });

  it("routes plugin commands directly to the plugin-native bridge when plugin context is available", async () => {
    const invokeNative = vi.fn().mockResolvedValue({ installed: false });
    const invokeNativePlugin = vi.fn().mockResolvedValue({ installed: true });

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
      invokeNativePlugin,
    };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-git" };

    await expect(invoke("git_get_installation_status")).resolves.toEqual({
      installed: true,
    });
    expect(invokeNative).not.toHaveBeenCalled();
    expect(invokeNativePlugin).toHaveBeenCalledWith(
      "otools-git",
      "git_get_installation_status",
      null,
    );
  });

  it("routes host plugin-state commands to the host state API, not the plugin dylib", async () => {
    const invokeNative = vi.fn();
    const invokeNativePlugin = vi.fn();
    const savePluginLocalState = vi.fn().mockResolvedValue(undefined);

    (window as Window & { otools?: unknown }).otools = {
      invokeNative,
      invokeNativePlugin,
      savePluginLocalState,
    };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-term" };

    await invoke("save_otools_plugin_localstate_with_scheme", {
      plugin: "term",
      scheme: "workspace",
      state: { version: 1 },
    });

    expect(savePluginLocalState).toHaveBeenCalledWith(
      "term",
      { version: 1 },
      "workspace",
    );
    expect(invokeNativePlugin).not.toHaveBeenCalled();
    expect(invokeNative).not.toHaveBeenCalled();
  });

  it("falls back to Tauri IPC for host state commands when the host state API is absent", async () => {
    const invokeNativePlugin = vi.fn();
    const invokeInternal = vi.fn().mockResolvedValue({ version: 1 });

    (window as Window & { otools?: unknown }).otools = {
      invokeNative: vi.fn(),
      invokeNativePlugin,
    };
    (
      window as Window & {
        __TAURI_INTERNALS__?: { invoke?: typeof invokeInternal };
      }
    ).__TAURI_INTERNALS__ = { invoke: invokeInternal };
    window.__OToolsEnv = { pluginUuid: "dev-debug:otools-term" };

    await expect(
      invoke("get_otools_plugin_localstate_with_scheme", {
        plugin: "term",
        scheme: "workspace",
      }),
    ).resolves.toEqual({ version: 1 });

    expect(invokeInternal).toHaveBeenCalledWith(
      "get_otools_plugin_localstate_with_scheme",
      { plugin: "term", scheme: "workspace" },
    );
    expect(invokeNativePlugin).not.toHaveBeenCalled();
  });

  it("recovers when the plugin runtime is injected after the first Tauri rejection", async () => {
    const invokeNativePlugin = vi.fn().mockResolvedValue({ installed: true });
    const invokeInternal = vi
      .fn<(command: string, payload?: Record<string, unknown>) => Promise<never>>()
      .mockImplementation(async () => {
        (window as Window & { otools?: unknown }).otools = {
          invokeNativePlugin,
        };
        window.__OToolsEnv = { pluginUuid: "dev-debug:otools-git" };
        throw new Error("git_get_installation_status not allowed. Command not found");
      });

    (
      window as Window & {
        __TAURI_INTERNALS__?: {
          invoke?: typeof invokeInternal;
        };
      }
    ).__TAURI_INTERNALS__ = {
      invoke: invokeInternal,
    };
    window.history.replaceState({}, "", "/");
    delete (window as Window & { __OToolsEnv?: unknown }).__OToolsEnv;

    await expect(invoke("git_get_installation_status")).resolves.toEqual({
      installed: true,
    });
    expect(invokeNativePlugin).toHaveBeenCalledWith(
      "otools-git",
      "git_get_installation_status",
      null,
    );
  });
});
