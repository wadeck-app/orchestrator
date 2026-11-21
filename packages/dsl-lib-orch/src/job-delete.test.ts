import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteJob, elevateForJobWrites } from './job-delete.js';

/*
 * DELETE /api/jobs/:id is a sensitive route of the app-core module: app-core answers 401 elevation-required to a request
 * with no access token, and only the shell's own fetcher asks for the PIN and repeats the request. A bare fetch would just
 * fail. Outside the shell (orch-app) there is no PIN and the same call is a plain fetch.
 */
const SHELL = '__APP_CORE_SHELL__';

afterEach(() => {
  Reflect.deleteProperty(globalThis, SHELL);
  vi.unstubAllGlobals();
});

function stubShell(api: { fetcher?: (...args: unknown[]) => Promise<unknown>; elevate?: () => Promise<void> }): void {
  Reflect.set(globalThis, SHELL, api);
}

describe('deleteJob', () => {
  it('goes through the shell fetcher inside app-core, with the module prefix, so the PIN is asked', async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    stubShell({ fetcher });

    await deleteJob('job-1', '/api/modules/orchestrator');

    expect(fetcher).toHaveBeenCalledWith('DELETE /api/modules/orchestrator/api/jobs/job-1', undefined, undefined, undefined);
  });

  it('lets the error of the shell fetcher out (PIN refused, route refused) instead of reporting a deletion', async () => {
    stubShell({ fetcher: vi.fn().mockRejectedValue(new Error('elevation cancelled')) });

    await expect(deleteJob('job-1', '/api/modules/orchestrator')).rejects.toThrow('elevation cancelled');
  });

  it('is a plain fetch outside the shell', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    await deleteJob('job-1', '');

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-1', { method: 'DELETE' });
  });

  it('says why a plain fetch was refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: 'Server Error', json: () => Promise.resolve({ error: 'daemon is down' }),
    }));

    await expect(deleteJob('job-1', '')).rejects.toThrow(/daemon is down/);
  });

  it('encodes the id in the path', async () => {
    const fetcher = vi.fn().mockResolvedValue(undefined);
    stubShell({ fetcher });

    await deleteJob('a/b', '/m');

    expect(fetcher.mock.calls[0]?.[0]).toBe('DELETE /m/api/jobs/a%2Fb');
  });
});

describe('elevateForJobWrites', () => {
  it('asks for the PIN once up front inside the shell, so a batch does not ask once per job', async () => {
    const elevate = vi.fn().mockResolvedValue(undefined);
    stubShell({ elevate });

    await elevateForJobWrites();

    expect(elevate).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside the shell', async () => {
    await expect(elevateForJobWrites()).resolves.toBeUndefined();
  });
});
