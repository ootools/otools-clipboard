import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browseHostDir,
  listHostDir,
  pickFromHostTree,
  readHostFile,
} from '../src/host-file-tree';
import type { HostBrowsePayload } from '../src/host-file-tree';

const home = '/home/test';
const file = { name: 'one.txt', path: `${home}/one.txt`, kind: 'file', size: 3, mime: 'text/plain' };
const second = { name: 'two.txt', path: `${home}/two.txt`, kind: 'file', size: 4, mime: 'text/plain' };
const directory = { name: 'docs', path: `${home}/docs`, kind: 'directory', size: 0, mime: 'inode/directory' };
const browsePayload: HostBrowsePayload = {
  currentPath: home,
  parentPath: '/home',
  roots: [{ name: 'Home', path: home }],
  entries: [file, second, directory],
};
const readPayload = { path: file.path, name: file.name, size: 3, mime: file.mime, dataBase64: 'YWJj' };

function installHost(browse = vi.fn().mockResolvedValue(browsePayload)) {
  const native = vi.fn().mockRejectedValue(new Error('Plugin method must not handle host filesystem commands'));
  const dialog = { open: vi.fn().mockRejectedValue(new Error('Panel must not open a native dialog')) };
  Object.assign(window, {
    otools: { invokeNative: native, browseHostDir: browse, dialog },
    __OToolsEnv: { pluginUuid: 'market:otools-fileshare' },
  });
  return { browse, native, dialog };
}

function button(name: 'confirm' | 'cancel'): HTMLButtonElement {
  return document.querySelector(`[data-host-tree-${name}]`) as HTMLButtonElement;
}

function entry(path: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-host-tree-entry]'))
    .find(row => row.getAttribute('data-path') === path);
  expect(row, `Missing host tree entry ${path}`).toBeDefined();
  return row!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  delete window.otools;
  delete window.utools;
  delete window.__TAURI_INTERNALS__;
  delete window.__OToolsEnv;
});

afterEach(() => {
  document.querySelectorAll<HTMLButtonElement>('[data-host-tree-cancel]').forEach(button => button.click());
});

describe('host file-tree transport', () => {
  it('preserves filesystem payloads instead of adapting them into editor nodes or text', async () => {
    const { browse, native } = installHost();
    const list = vi.fn().mockResolvedValue([file, directory]);
    const read = vi.fn().mockResolvedValue(readPayload);
    Object.assign(window.otools!, { listHostDir: list, readHostFile: read });

    expect(await browseHostDir()).toEqual(browsePayload);
    expect(browse).toHaveBeenCalledWith('');
    expect(await listHostDir(home)).toEqual([file, directory]);
    expect(await readHostFile(file.path)).toEqual(readPayload);
    expect(native).not.toHaveBeenCalled();
  });

  it('uses the registered webview commands when the injected host wrappers are absent', async () => {
    const { native, dialog } = installHost();
    delete window.otools!.browseHostDir;
    const invoke = vi.fn(async (command: string, payload: unknown) => {
      if (command === 'tools_webview_browse_dialog') {
        expect(payload).toEqual({ request: { path: '' } });
        return browsePayload;
      }
      if (command === 'tools_webview_list_dir') {
        expect(payload).toEqual({ path: home });
        return [file];
      }
      if (command === 'tools_webview_read_file') {
        expect(payload).toEqual({ path: file.path });
        return readPayload;
      }
      throw new Error(`Unknown host command: ${command}`);
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });

    expect(await browseHostDir()).toEqual(browsePayload);
    expect(await listHostDir(home)).toEqual([file]);
    expect(await readHostFile(file.path)).toEqual(readPayload);
    expect(native).not.toHaveBeenCalled();
    expect(dialog.open).not.toHaveBeenCalled();
  });
  it('bypasses the old injected browse wrapper that discarded the requested directory', async () => {
    const { browse, native } = installHost();
    const nested = { currentPath: directory.path, parentPath: home, roots: [], entries: [] };
    const invoke = vi.fn(async (command: string, payload: unknown) => {
      expect(command).toBe('tools_webview_browse_dialog');
      expect(payload).toEqual({ request: { path: directory.path } });
      return nested;
    });
    Object.assign(window, { __TAURI_INTERNALS__: { invoke } });
    expect(await browseHostDir(directory.path)).toEqual(nested);
    expect(browse).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
});

describe('panel-safe file tree selection', () => {
  it('selects a file and closes only the DOM overlay', async () => {
    const { native, dialog } = installHost();
    const result = pickFromHostTree({ directory: false });
    await vi.waitFor(() => expect(entry(file.path)).toBeDefined());
    expect(button('confirm').disabled).toBe(true);
    entry(file.path).click();
    expect(button('confirm').disabled).toBe(false);
    button('confirm').click();

    expect(await result).toEqual({ kind: 'picked', source: 'host-tree', paths: [file.path], names: ['one.txt'] });
    expect(document.querySelector('[data-host-tree]')).toBeNull();
    expect(native).not.toHaveBeenCalled();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('shows a persistent selected highlight, check mark and count for file selection', async () => {
    installHost();
    const result = pickFromHostTree({ multiple: true });
    await vi.waitFor(() => expect(entry(file.path)).toBeDefined());
    const first = entry(file.path);
    const before = window.getComputedStyle(first).backgroundColor;
    first.click();
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(window.getComputedStyle(first).backgroundColor).not.toBe(before);
    expect((first.querySelector('[data-host-tree-check]') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('[data-host-tree-selection]')?.textContent).toBe('已选 1 个文件');
    entry(second.path).click();
    expect(document.querySelector('[data-host-tree-selection]')?.textContent).toBe('已选 2 个文件');
    first.click();
    expect(first.getAttribute('aria-selected')).toBe('false');
    expect((first.querySelector('[data-host-tree-check]') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector('[data-host-tree-selection]')?.textContent).toBe('已选 1 个文件');
    button('confirm').click();
    expect((await result).paths).toEqual([second.path]);
  });

  it('highlights the current directory and names the directory awaiting confirmation', async () => {
    const browse = vi.fn().mockImplementation(async (path: string) => {
      if (path === directory.path) return { currentPath: directory.path, parentPath: home, roots: [], entries: [] };
      return browsePayload;
    });
    installHost(browse);
    const result = pickFromHostTree({ directory: true });
    await vi.waitFor(() => expect(entry(directory.path)).toBeDefined());
    entry(directory.path).click();
    await vi.waitFor(() => expect(document.querySelector('.otools-host-tree-path')?.textContent).toBe(directory.path));
    expect(document.querySelector('.otools-host-tree-path')?.classList.contains('otools-host-tree-current')).toBe(true);
    expect(document.querySelector('[data-host-tree-selection]')?.textContent).toBe(`已选目录：${directory.path}`);
    button('confirm').click();
    expect((await result).paths).toEqual([directory.path]);
  });

  it.each([
    { name: 'Windows', path: 'D:\\', label: 'D:\\' },
    { name: 'macOS', path: '/Volumes/外置 SSD', label: '外置 SSD' },
    { name: 'Linux', path: '/mnt/Data Disk', label: 'Data Disk' },
  ])('switches to a $name disk shortcut and confirms its directory', async ({ path, label }) => {
    const roots = [{ name: label, path }];
    const browse = vi.fn().mockImplementation(async (requested: string) => ({
      currentPath: requested || home,
      parentPath: null,
      roots,
      entries: requested === path ? [] : [file],
    }));
    const { native, dialog } = installHost(browse);
    const result = pickFromHostTree({ directory: true });
    await vi.waitFor(() => expect(document.querySelector('[data-host-tree-root]')).not.toBeNull());
    const root = document.querySelector('[data-host-tree-root]') as HTMLElement;
    expect(root.textContent).toContain(label);
    root.click();
    await vi.waitFor(() => expect(document.querySelector('.otools-host-tree-path')?.textContent).toBe(path));
    expect(browse).toHaveBeenLastCalledWith(path);
    expect(document.querySelector('[data-host-tree-selection]')?.textContent).toBe(`已选目录：${path}`);
    expect(button('confirm').disabled).toBe(false);
    button('confirm').click();
    expect((await result).paths).toEqual([path]);
    expect(native).not.toHaveBeenCalled();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('returns all selected files for a multiple-file picker', async () => {
    installHost();
    const result = pickFromHostTree({ multiple: true });
    await vi.waitFor(() => expect(entry(second.path)).toBeDefined());
    entry(file.path).click();
    entry(second.path).click();
    button('confirm').click();
    expect(await result).toEqual({ kind: 'picked', source: 'host-tree', paths: [file.path, second.path], names: ['one.txt', 'two.txt'] });
  });

  it('does not confirm an empty directory path while the initial load is pending', async () => {
    let resolve!: (payload: HostBrowsePayload) => void;
    const loading = new Promise<HostBrowsePayload>(done => { resolve = done; });
    installHost(vi.fn().mockReturnValue(loading));
    const result = pickFromHostTree({ directory: true });
    expect(button('confirm').disabled).toBe(true);
    resolve(browsePayload);
    await vi.waitFor(() => expect(button('confirm').disabled).toBe(false));
    button('confirm').click();
    expect(await result).toEqual({ kind: 'picked', source: 'host-tree', paths: [home], names: ['test'] });
  });

  it('clears a stale file selection when navigating into another directory', async () => {
    const browse = vi.fn().mockImplementation(async (path: string) => {
      if (path === directory.path) return { currentPath: directory.path, parentPath: home, roots: [], entries: [] };
      return browsePayload;
    });
    installHost(browse);
    const result = pickFromHostTree({});
    await vi.waitFor(() => expect(entry(file.path)).toBeDefined());
    entry(file.path).click();
    entry(directory.path).click();
    await vi.waitFor(() => expect(document.querySelector('.otools-host-tree-path')?.textContent).toBe(directory.path));
    expect(button('confirm').disabled).toBe(true);
    button('cancel').click();
    expect((await result).kind).toBe('cancelled');
  });

  it('shows navigation failures, keeps confirmation disabled and allows retry or cancel', async () => {
    const browse = vi.fn().mockRejectedValueOnce(new Error('Permission denied')).mockResolvedValue(browsePayload);
    const { dialog } = installHost(browse);
    const result = pickFromHostTree({ directory: true });
    await vi.waitFor(() => expect(document.querySelector('[data-host-tree-error]')?.textContent).toContain('Permission denied'));
    expect(button('confirm').disabled).toBe(true);
    const retry = document.querySelector('[data-host-tree-retry]') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    retry.click();
    await vi.waitFor(() => expect(button('confirm').disabled).toBe(false));
    button('cancel').click();
    expect(await result).toEqual({ kind: 'cancelled', source: 'host-tree', paths: [], names: [] });
    expect(dialog.open).not.toHaveBeenCalled();

    const reopened = pickFromHostTree({});
    await vi.waitFor(() => expect(entry(file.path)).toBeDefined());
    entry(file.path).click();
    button('confirm').click();
    expect((await reopened).paths).toEqual([file.path]);
  });

  it('handles Escape inside the picker without forwarding it to panel close handlers', async () => {
    installHost();
    const result = pickFromHostTree({});
    await vi.waitFor(() => expect(entry(file.path)).toBeDefined());
    const hostKey = vi.fn();
    window.addEventListener('keydown', hostKey);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(hostKey).not.toHaveBeenCalled();
    window.removeEventListener('keydown', hostKey);
    expect((await result).kind).toBe('cancelled');
  });
});
