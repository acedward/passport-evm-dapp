// An in-memory private-state provider, one per job (Q5: the relay keeps no per-user data).
//
// midnight-js keeps a contract's private state (here: the Passport coin store the `held_coin`
// witness reads) and a freshly deployed contract's maintenance signing key in a private-state
// provider. The reference client uses a LevelDB store on disk; the relay must write nothing
// about a user to disk, so each job gets this Map-backed store, and the job drops it when it
// ends. The deploy's maintenance key lives here only between wave 1 and wave 2 (which retires
// the authority), then it is gone with the job.

export class MemoryPrivateStateProvider {
  private readonly states = new Map<string, unknown>();
  private readonly signingKeys = new Map<string, unknown>();
  private contractAddress: string | null = null;

  setContractAddress(address: string): void {
    this.contractAddress = address;
  }

  async set(id: string, state: unknown): Promise<void> {
    this.states.set(id, state);
  }

  async get(id: string): Promise<unknown> {
    return this.states.has(id) ? this.states.get(id) : null;
  }

  async remove(id: string): Promise<void> {
    this.states.delete(id);
  }

  async clear(): Promise<void> {
    this.states.clear();
  }

  async setSigningKey(address: string, key: unknown): Promise<void> {
    this.signingKeys.set(address, key);
  }

  async getSigningKey(address: string): Promise<unknown> {
    return this.signingKeys.get(address) ?? null;
  }

  async removeSigningKey(address: string): Promise<void> {
    this.signingKeys.delete(address);
  }

  async clearSigningKeys(): Promise<void> {
    this.signingKeys.clear();
  }

  async exportPrivateStates(): Promise<never> {
    throw new Error('the relay never exports private state');
  }

  async importPrivateStates(): Promise<never> {
    throw new Error('the relay never imports private state');
  }

  async exportSigningKeys(): Promise<never> {
    throw new Error('the relay never exports signing keys');
  }

  async importSigningKeys(): Promise<never> {
    throw new Error('the relay never imports signing keys');
  }

  /** Forget everything (called when the job ends). */
  wipe(): void {
    this.states.clear();
    this.signingKeys.clear();
    this.contractAddress = null;
  }

  /** How many entries it holds (tests: nothing survives a job). */
  get size(): number {
    return this.states.size + this.signingKeys.size + (this.contractAddress ? 1 : 0);
  }
}
