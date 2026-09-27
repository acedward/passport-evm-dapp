// A small client for the proof server (midnightntwrk/proof-server 9.0.0-rc.6, the one server the
// relay uses for the wallet's DUST proofs and every Passport circuit; plan Pins, P0.5).
//
// Proving itself goes through midnight-js's HTTP proof provider, which uploads the prover key
// from the key volume with each /prove call. This client covers what the relay needs around it:
// version and readiness for /health, and the capacity the server reports.

export interface ProofServerReady {
  status: string;
  jobsProcessing: number;
  jobsPending: number;
  jobCapacity: number;
}

export interface ProofServerProbe {
  reachable: boolean;
  version: string | null;
  jobCapacity: number | null;
  versionMatches: boolean | null;
}

export class ProofServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly expectedVersion: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(new URL(path, this.baseUrl), { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`proof server ${path} answered ${res.status}`);
    return res;
  }

  async version(): Promise<string> {
    return (await (await this.get('/version')).text()).trim().replace(/^"|"$/g, '');
  }

  async proofVersions(): Promise<string[]> {
    return (await (await this.get('/proof-versions')).json()) as string[];
  }

  async ready(): Promise<ProofServerReady> {
    return (await (await this.get('/ready')).json()) as ProofServerReady;
  }

  async probe(): Promise<ProofServerProbe> {
    try {
      const [version, ready] = await Promise.all([this.version(), this.ready()]);
      return {
        reachable: true,
        version,
        jobCapacity: typeof ready.jobCapacity === 'number' ? ready.jobCapacity : null,
        versionMatches: this.expectedVersion === null ? null : version === this.expectedVersion,
      };
    } catch {
      return { reachable: false, version: null, jobCapacity: null, versionMatches: null };
    }
  }
}
