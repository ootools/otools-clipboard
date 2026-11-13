import { describe, expect, it } from 'vitest';
import { createReminderApi, ReminderError } from '../src/reminder-factory';

const provider = { source: 'installed', uuid: 'notes' };
const status = { provider, type: 'notes.v1', enabled: true, cooldownMs: 300_000, available: true };
const id = 'a'.repeat(64);

describe('reminder factory', () => {
  it('configures only a provider-scoped watcher without caller-supplied ownership', async () => {
    const calls: unknown[] = [];
    const api = createReminderApi({ invoke: async (command, args) => { calls.push([command,args]); return status; } });
    const request = { provider, type: 'notes.v1', enabled: true, quietHours: {start:1320,end:420} };
    expect(await api.configure(request)).toEqual(status);
    expect(calls).toEqual([['otools_host_plugin_reminders_configure',{request}]]);
  });
  it('rejects ambiguous settings before invoking the host', async () => {
    const api = createReminderApi({ invoke: async () => { throw new Error('unexpected invoke'); } });
    await expect(api.configure({provider,type:'notes.v1',enabled:true,quietHours:{start:1440,end:0}})).rejects.toMatchObject({code:'invalidRequest'});
    await expect(api.configure({provider,type:'notes.v1',enabled:true,cooldownMs:0})).rejects.toMatchObject({code:'invalidRequest'});
  });
  it('preserves typed broker revocation errors rather than silently making a local timer', async () => {
    const api = createReminderApi({ invoke: async () => { throw {code:'forbidden',message:'Grant revoked'}; } });
    await expect(api.pending()).rejects.toMatchObject({code:'forbidden',message:'Grant revoked'});
    await expect(api.status()).rejects.toBeInstanceOf(ReminderError);
  });
  it('returns private pending data and acknowledges the exact owned delivery IDs', async () => {
    const calls: unknown[] = [];
    const item = {id,provider,type:'notes.v1',resourceId:'note',dueAt:1_794_304_800_000,title:'Planning',body:'[notes / notes.v1] Call',deliveredAt:1_794_304_800_000};
    const api = createReminderApi({ invoke: async (command,args) => {
      calls.push([command,args]);
      return command.endsWith('_pending') ? [item] : command.endsWith('_status') ? [status] : undefined;
    } });
    expect(await api.pending()).toEqual([item]);
    expect(await api.status()).toEqual([status]);
    await api.acknowledge([id]);
    expect(calls).toEqual([['otools_host_plugin_reminders_pending',undefined],['otools_host_plugin_reminders_status',undefined],['otools_host_plugin_reminders_acknowledge',{ids:[id]}]]);
  });
  it('rejects malformed host feed rather than displaying arbitrary unbounded data', async () => {
    const api = createReminderApi({ invoke: async () => [{id,body:'x'.repeat(501)}] });
    await expect(api.pending()).rejects.toMatchObject({code:'invalidResponse'});
  });
  it('rejects invalid acknowledgement IDs without sending them to another owner', async () => {
    const api = createReminderApi({ invoke: async () => { throw new Error('unexpected invoke'); } });
    await expect(api.acknowledge(['other-owner'])).rejects.toMatchObject({code:'invalidRequest'});
  });
});
