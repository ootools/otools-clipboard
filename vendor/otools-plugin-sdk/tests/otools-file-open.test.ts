import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("../src/runtime", () => ({
  invoke: invokeMock,
  listen: listenMock,
  emit: vi.fn(),
}));

import {
  onOtoolsOpenFile,
  parseLaunchOpenFiles,
  toOpenFileEntries,
} from "../src/otools-file-open";

const stubPluginWindow = (pluginUuid: string, search = "") => {
  vi.stubGlobal("window", {
    __OToolsEnv: { pluginUuid },
    location: { search },
  });
};

describe("parseLaunchOpenFiles", () => {
  it("parses the JSON array payload", () => {
    expect(parseLaunchOpenFiles('?plugin=x&otoolsOpenFile=%5B%22C%3A%2Fa.pdf%22%5D')).toEqual([
      "C:/a.pdf",
    ]);
  });

  it("returns empty for missing, invalid or non-array payloads", () => {
    expect(parseLaunchOpenFiles("?plugin=x")).toEqual([]);
    expect(parseLaunchOpenFiles("?otoolsOpenFile=not-json")).toEqual([]);
    expect(parseLaunchOpenFiles(`?otoolsOpenFile=${encodeURIComponent('"str"')}`)).toEqual([]);
    expect(parseLaunchOpenFiles("")).toEqual([]);
  });
});

describe("toOpenFileEntries", () => {
  it("derives name and lowercase ext from paths", () => {
    expect(toOpenFileEntries(["C:\\dir\\Report.PDF", "/home/u/data.csv"])).toEqual([
      { path: "C:\\dir\\Report.PDF", name: "Report.PDF", ext: "pdf" },
      { path: "/home/u/data.csv", name: "data.csv", ext: "csv" },
    ]);
  });

  it("keeps dotfiles extension-less", () => {
    expect(toOpenFileEntries(["/repo/.gitignore"])).toEqual([
      { path: "/repo/.gitignore", name: ".gitignore", ext: "" },
    ]);
  });
});

describe("onOtoolsOpenFile", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("registers the listener before consuming, then merges URL param with queue dedupe", async () => {
    stubPluginWindow("otools-x", '?otoolsOpenFile=%5B%22C%3A%2Fa.pdf%22%5D');
    let consumeCalls = 0;
    invokeMock.mockImplementation(async (command: string) => {
      expect(command).toBe("otools_consume_open_files");
      consumeCalls += 1;
      return consumeCalls === 1 ? ["C:/a.pdf", "C:/b.csv"] : [];
    });
    listenMock.mockResolvedValue(() => Promise.resolve());
    const handler = vi.fn();

    await onOtoolsOpenFile(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));

    // URL 参数先到；consume 取回的 a.pdf 命中去重窗口被滤掉，b.csv 正常回调。
    expect(handler).toHaveBeenNthCalledWith(1, [
      { path: "C:/a.pdf", name: "a.pdf", ext: "pdf" },
    ]);
    expect(handler).toHaveBeenNthCalledWith(2, [
      { path: "C:/b.csv", name: "b.csv", ext: "csv" },
    ]);

    // listener 必须先于第一次 consume 注册，保证投递竞态不漏件。
    const listenOrder = listenMock.mock.invocationCallOrder[0];
    const invokeOrder = invokeMock.mock.invocationCallOrder[0];
    expect(listenOrder).toBeLessThan(invokeOrder);
  });

  it("delivers files when the host knocks after registration", async () => {
    stubPluginWindow("otools-x");
    invokeMock.mockResolvedValue(["C:/new.xlsx"]);
    let knock: (() => void) | undefined;
    listenMock.mockImplementation(async (_event, handler) => {
      knock = handler as unknown as () => void;
      return () => Promise.resolve();
    });
    const handler = vi.fn();

    await onOtoolsOpenFile(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith([{ path: "C:/new.xlsx", name: "new.xlsx", ext: "xlsx" }]);

    // 再次敲门 + 队列里换了新文件 → 正常投递。
    invokeMock.mockResolvedValue(["C:/new2.xlsx"]);
    knock?.();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler).toHaveBeenLastCalledWith([
      { path: "C:/new2.xlsx", name: "new2.xlsx", ext: "xlsx" },
    ]);
  });

  it("skips consume when no plugin identity is available", async () => {
    vi.stubGlobal("window", { __OToolsEnv: {}, location: { search: "" } });
    listenMock.mockResolvedValue(() => Promise.resolve());
    const handler = vi.fn();

    await onOtoolsOpenFile(handler);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows consume errors (old host without the command)", async () => {
    stubPluginWindow("otools-x");
    invokeMock.mockRejectedValue(new Error("unknown command"));
    listenMock.mockResolvedValue(() => Promise.resolve());
    const handler = vi.fn();

    await expect(onOtoolsOpenFile(handler)).resolves.toBeTypeOf("function");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });
});
