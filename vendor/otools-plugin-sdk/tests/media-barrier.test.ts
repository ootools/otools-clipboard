import { describe, expect, it } from 'vitest';
import { createAiApi } from '../src/ai-factory';
function fixture() {
  let model: string | null = 'previous';
  const saves: string[] = []; const generations: unknown[] = []; const releases: Array<() => void> = [];
  const api = createAiApi({ invoke: async (command, args: any) => {
    if (command === 'otools_host_ai_media_save_settings') {
      saves.push(args.model); await new Promise<void>(resolve => releases.push(resolve)); model = args.model; return { model };
    }
    if (command === 'otools_host_ai_media_get_settings') return { model };
    if (command === 'otools_ai_images') { generations.push(args.request); return { model: args.request.model, images: [] }; }
    throw new Error('unexpected command');
  } });
  return { api, saves, generations, releases };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('SDK media save barriers', () => {
  it('serializes saves and snapshots the latest selected model before generation', async () => {
    const f = fixture();
    const first = f.api.media.saveSettings({ channel: 'images', model: 'first' });
    const latest = f.api.media.saveSettings({ channel: 'images', model: 'latest' });
    const generating = f.api.media.images({ prompt: 'fixture' }); await settle();
    expect(f.saves).toEqual(['first']); expect(f.generations).toEqual([]);
    f.releases[0](); await first; await settle();
    expect(f.saves).toEqual(['first', 'latest']); expect(f.generations).toEqual([]);
    f.releases[1](); await latest;
    expect((await generating).model).toBe('latest');
    expect(f.generations).toEqual([{ prompt: 'fixture', model: 'latest' }]);
  });
  it('blocks stale execution after a failed save until retry succeeds', async () => {
    let fail = true; const requests: unknown[] = [];
    const api = createAiApi({ invoke: async (command, args: any) => {
      if (command === 'otools_host_ai_media_save_settings') { if (fail) throw new Error('save failed'); return { model: args.model }; }
      if (command === 'otools_host_ai_media_get_settings') return { model: 'retry' };
      requests.push(args); return { model: args.request.model, images: [] };
    } });
    await expect(api.media.saveSettings({ channel: 'images', model: 'retry' })).rejects.toThrow('save failed');
    await expect(api.media.images({ prompt: 'fixture' })).rejects.toThrow('save failed');
    expect(requests).toEqual([]);
    fail = false; await api.media.saveSettings({ channel: 'images', model: 'retry' });
    expect((await api.media.images({ prompt: 'fixture' })).model).toBe('retry');
  });
});
