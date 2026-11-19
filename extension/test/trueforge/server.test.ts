import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { localPort, localTarget, TrueForgeServer } from '../../src/trueforge/server';

function fakeProc() {
  const p = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  p.pid = 0; // no real process to kill in stop()
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = vi.fn();
  return p;
}

const ok = { status: 200 } as Response;
const down = () => Promise.reject(new Error('ECONNREFUSED'));

function setup(fetchFn: typeof fetch, baseUrl = 'http://127.0.0.1:8790') {
  const proc = fakeProc();
  const spawnFn = vi.fn(() => proc);
  const logs: string[] = [];
  const server = new TrueForgeServer({
    baseUrl: () => baseUrl,
    storageDir: path.join(mkdtempSync(path.join(tmpdir(), 'tf-')), 'trueforge'),
    log: (l) => logs.push(l),
    spawnFn: spawnFn as never,
    fetchFn,
    readyTimeoutMs: 200,
    pollMs: 5,
  });
  return { server, spawnFn, proc, logs };
}

describe('localPort', () => {
  it('accepts local URLs only', () => {
    expect(localPort('http://127.0.0.1:8790')).toBe(8790);
    expect(localPort('http://localhost:9000/')).toBe(9000);
    expect(localPort('https://trueforge.example.com')).toBeUndefined();
    expect(localPort('not a url')).toBeUndefined();
  });

  it('binds to an explicit address, never the name localhost (::1 on many Linux systems)', () => {
    expect(localTarget('http://127.0.0.1:8790')).toEqual({ host: '127.0.0.1', port: 8790 });
    expect(localTarget('http://localhost:8790')).toEqual({ host: '127.0.0.1', port: 8790 });
    expect(localTarget('http://[::1]:8790')).toEqual({ host: '::1', port: 8790 });
  });
});

describe('TrueForgeServer', () => {
  it('uses a TrueForge that is already running and starts nothing', async () => {
    const { server, spawnFn } = setup(vi.fn(async () => ok));
    expect(await server.ensure()).toBe('external');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('starts the pinned release with the outbound host list and waits until it answers', async () => {
    let up = false;
    const { server, spawnFn, proc, logs } = setup(vi.fn(async () => (up ? ok : down())) as never);
    const pending = server.ensure();
    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.emit('data', Buffer.from('listening on 8790\n'));
    up = true;
    expect(await pending).toBe('running');

    const [cmd, args, opts] = spawnFn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect([cmd, ...args].join(' ')).toMatch(/^npx(\.cmd)? -y @truefoundry\/trueforge@0\.185\.0 --port 8790$/);
    expect(opts.env.HOST).toBe('127.0.0.1');
    expect(opts.env.OUTBOUND_URL_ALLOWED_HOSTS).toBe('["127.0.0.1"]');
    expect(opts.env.SQLITE_PATH).toMatch(/trueforge\.db$/);
    expect(logs).toContain('[trueforge] listening on 8790');
  });

  it('shares one start between concurrent callers', async () => {
    let up = false;
    const { server, spawnFn } = setup(vi.fn(async () => (up ? ok : down())) as never);
    const a = server.ensure();
    const b = server.ensure();
    setTimeout(() => (up = true), 20);
    expect(await a).toBe('running');
    expect(await b).toBe('running');
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('reports a missing npx clearly', async () => {
    const { server, proc } = setup(vi.fn(down) as never);
    const pending = server.ensure();
    await new Promise((r) => setTimeout(r, 10));
    proc.emit('error', new Error('spawn npx ENOENT'));
    expect(await pending).toBe('failed');
    expect(server.error).toMatch(/Install Node\.js/);
  });

  it('fails when the process exits before it is ready', async () => {
    const { server, proc } = setup(vi.fn(down) as never);
    const pending = server.ensure();
    await new Promise((r) => setTimeout(r, 10));
    proc.emit('exit', 1, null);
    expect(await pending).toBe('failed');
    expect(server.error).toMatch(/exited \(code 1\)/);
  });

  it('times out if TrueForge never answers', async () => {
    const { server } = setup(vi.fn(down) as never);
    expect(await server.ensure()).toBe('failed');
    expect(server.error).toMatch(/did not become ready/);
  });

  it('never starts a process for a remote URL', async () => {
    const { server, spawnFn } = setup(vi.fn(down) as never, 'https://trueforge.example.com');
    expect(await server.ensure()).toBe('failed');
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
