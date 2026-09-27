// Plan P4-A, key-volume completeness: the relay's start-up check covers EVERY circuit it proves
// (the account's gated calls, bridge circuits and offer circuit, the vault circuits they call, the
// vault's own abandonDeposit, and the Signet singleton's signBidirectional), refuses to start with
// a clear message when any key is missing or is not the deployed contract's, and the list cannot
// silently fall behind the code.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { accountCircuitIds } from '../src/passport/account-shape.js';
import { deployedVerifierKeys } from '../src/prover/deployed.js';
import { checkKeyVolume, keyVolumeComplete, keyVolumeProblems, scanKeyTree } from '../src/prover/keys.js';
import {
  ACCOUNT_PROVEN_CIRCUITS,
  RELAY_PROVEN_CIRCUITS,
  SIGNET_PROVEN_CIRCUITS,
  VAULT_PROVEN_CIRCUITS,
} from '../src/prover/required.js';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here('../src');
const CONTRACT = here('../../vendor/passport/contract');
const VAULT = '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** The proof-bearing circuits a compiled contract declares (from compactc's contract-info.json). */
function proofCircuits(managed: string): string[] {
  const info = JSON.parse(readFileSync(join(managed, 'compiler', 'contract-info.json'), 'utf8')) as {
    circuits: Array<{ name: string; proof: boolean }>;
  };
  return info.circuits.filter((c) => c.proof).map((c) => c.name);
}

const ACCOUNT_MANAGED = join(CONTRACT, 'contracts/managed/account');
const VAULT_MANAGED = join(CONTRACT, 'contracts/erc20-vault/managed/Erc20Vault');
const SIGNET_MANAGED = join(CONTRACT, 'contracts/erc20-vault/managed/SignetSigner');

describe('the list of circuits the relay proves', () => {
  it('names only real proof-bearing circuits, and only account circuits an MN Bank account carries', () => {
    const account = new Set(proofCircuits(ACCOUNT_MANAGED));
    const vault = new Set(proofCircuits(VAULT_MANAGED));
    const signet = new Set(proofCircuits(SIGNET_MANAGED));
    const shape = new Set(accountCircuitIds());
    for (const c of ACCOUNT_PROVEN_CIRCUITS) {
      expect(account.has(c), `account/${c} is a circuit`).toBe(true);
      expect(shape.has(c), `account/${c} is in the MN Bank account shape`).toBe(true);
    }
    for (const c of VAULT_PROVEN_CIRCUITS) expect(vault.has(c), `Erc20Vault/${c}`).toBe(true);
    for (const c of SIGNET_PROVEN_CIRCUITS) expect(signet.has(c), `SignetSigner/${c}`).toBe(true);
    expect(RELAY_PROVEN_CIRCUITS).toHaveLength(
      ACCOUNT_PROVEN_CIRCUITS.length + VAULT_PROVEN_CIRCUITS.length + SIGNET_PROVEN_CIRCUITS.length,
    );
  });

  it('covers every circuit the relay code calls by name (a new call without its key fails here)', () => {
    const names = new Set([
      ...proofCircuits(ACCOUNT_MANAGED).map((c) => `account/${c}`),
      ...proofCircuits(VAULT_MANAGED).map((c) => `Erc20Vault/${c}`),
      ...proofCircuits(SIGNET_MANAGED).map((c) => `SignetSigner/${c}`),
    ]);
    const listed = new Set(RELAY_PROVEN_CIRCUITS);
    const called = new Set<string>();
    for (const file of walk(SRC)) {
      if (file.includes('/vendor/') || file.endsWith('/prover/required.ts')) continue;
      // Drop comments: a circuit mentioned in prose is not a call.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const id of names) {
        const circuit = id.split('/')[1]!;
        if (new RegExp(`(callTx\\.|['"\`])${circuit}\\b`).test(code)) called.add(id);
      }
    }
    const missing = [...called].filter((id) => !listed.has(id));
    expect(missing, 'called in relay/src but missing from RELAY_PROVEN_CIRCUITS').toEqual([]);
    // The ones reached indirectly: registration's activation (upstream client), the offer circuit.
    expect(called.has('account/withdraw_shielded_with_evm')).toBe(true);
    expect(called.has('Erc20Vault/abandonDeposit')).toBe(true);
  });

  it('covers every vault circuit the account calls, and the Signet circuit the vault calls', () => {
    const account = readFileSync(join(CONTRACT, 'contracts/account.compact'), 'utf8');
    const vault = readFileSync(join(CONTRACT, 'contracts/erc20-vault/src/erc20-vault.compact'), 'utf8');
    const called = (src: string, circuits: string[]) => circuits.filter((c) => new RegExp(`\\.${c}\\(`).test(src));
    const fromAccount = called(account, proofCircuits(VAULT_MANAGED));
    const fromVault = called(vault, proofCircuits(SIGNET_MANAGED));
    expect(fromAccount.sort()).toEqual(
      ['completeDeposit', 'completeWithdraw', 'refundWithdraw', 'startDeposit', 'startWithdraw'].sort(),
    );
    for (const c of fromAccount) expect(RELAY_PROVEN_CIRCUITS).toContain(`Erc20Vault/${c}`);
    for (const c of fromVault) expect(RELAY_PROVEN_CIRCUITS).toContain(`SignetSigner/${c}`);
  });
});

/** A fake key volume holding every circuit the relay proves (or `except`), with made-up keys. */
function volume(
  opts: { except?: Record<string, Array<'prover' | 'verifier' | 'zkir'>>; vk?: (id: string) => string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'mnbank-vol-'));
  dirs.push(root);
  for (const id of RELAY_PROVEN_CIRCUITS) {
    const [contract, circuit] = id.split('/') as [string, string];
    mkdirSync(join(root, contract, 'keys'), { recursive: true });
    mkdirSync(join(root, contract, 'zkir'), { recursive: true });
    const skip = opts.except?.[id] ?? [];
    if (!skip.includes('verifier'))
      writeFileSync(join(root, contract, 'keys', `${circuit}.verifier`), opts.vk?.(id) ?? `vk:${id}`);
    if (!skip.includes('prover')) writeFileSync(join(root, contract, 'keys', `${circuit}.prover`), 'pk');
    if (!skip.includes('zkir')) writeFileSync(join(root, contract, 'zkir', `${circuit}.bzkir`), 'ir');
  }
  return root;
}

describe('the key-volume check', () => {
  it('passes a volume with every key, and names each missing prover key, verifier key and ZKIR', () => {
    const full = volume();
    const ok = checkKeyVolume(full, null, RELAY_PROVEN_CIRCUITS);
    expect(keyVolumeComplete(ok)).toBe(true);
    expect(keyVolumeProblems(ok, { root: full, pin: null })).toEqual([]);

    const holes = volume({
      except: {
        'account/open_swap_shielded_with_evm': ['prover'],
        'Erc20Vault/abandonDeposit': ['verifier', 'prover', 'zkir'],
        'SignetSigner/signBidirectional': ['zkir'],
      },
    });
    const k = checkKeyVolume(holes, null, RELAY_PROVEN_CIRCUITS);
    expect(keyVolumeComplete(k)).toBe(false);
    expect(k.missingProverKeys).toEqual(['account/open_swap_shielded_with_evm', 'Erc20Vault/abandonDeposit']);
    expect(k.missingVerifierKeys).toEqual(['Erc20Vault/abandonDeposit']);
    expect(k.missingZkir).toEqual(['Erc20Vault/abandonDeposit', 'SignetSigner/signBidirectional']);
    expect(keyVolumeProblems(k, { root: holes, pin: null })).toEqual([
      'missing verifier keys (1): Erc20Vault/abandonDeposit',
      'missing prover keys (1): account/open_swap_shielded_with_evm',
      'missing ZKIR (1): SignetSigner/signBidirectional',
    ]);
  });

  it('refuses keys that are not the deployed vault’s and singleton’s, and a fingerprint other than the pin', () => {
    const deployed = deployedVerifierKeys('stagenet', VAULT);
    // PR #4's record: the vault's seven circuits and the singleton's three.
    expect(Object.keys(deployed)).toHaveLength(10);
    expect(deployed['Erc20Vault/abandonDeposit']).toBe(
      'b50ff3961af1dc904e5e2559a3a93f9a16abde58ea1a8154cd925562bf67a350',
    );
    expect(deployed['SignetSigner/signBidirectional']).toBe(
      '101ac368e366286272dbabd81ea7ca5c192e34fc69b7a3f5159d85054625214f',
    );
    expect(deployedVerifierKeys('stagenet', 'ab'.repeat(32))).toEqual({});
    expect(deployedVerifierKeys('undeployed', VAULT)).toEqual({});

    const root = volume();
    const k = checkKeyVolume(root, '0'.repeat(64), RELAY_PROVEN_CIRCUITS, deployed);
    expect(k.mismatchedVerifierKeys).toEqual([
      'Erc20Vault/abandonDeposit',
      'Erc20Vault/completeDeposit',
      'Erc20Vault/completeWithdraw',
      'Erc20Vault/refundWithdraw',
      'Erc20Vault/startDeposit',
      'Erc20Vault/startWithdraw',
      'SignetSigner/signBidirectional',
    ]);
    const problems = keyVolumeProblems(k, { root, pin: '0'.repeat(64), deployed });
    expect(problems[0]).toMatch(/fingerprint [0-9a-f]{64} is not RELAY_KEYS_FINGERPRINT 0{64}/);
    expect(problems).toContain(
      "Erc20Vault/abandonDeposit: the verifier key does not match the deployed contract's (sha256 b50ff3961af1dc904e5e2559a3a93f9a16abde58ea1a8154cd925562bf67a350); the keys were built from other sources",
    );
    // With the pinned fingerprint and no deployed record, the same volume passes.
    const fp = scanKeyTree(root).fingerprint;
    expect(keyVolumeComplete(checkKeyVolume(root, fp, RELAY_PROVEN_CIRCUITS))).toBe(true);
  });
});

/** Start the relay (Bun, as deployed) with `env`; resolve with its exit code and output, or with
 *  'served' once it answers /v1/config when `expectServe` (then it is stopped). */
function startRelay(
  env: Record<string, string>,
  timeoutMs = 60_000,
  expectServe = false,
): Promise<{ code: number | null | 'served'; out: string }> {
  const port = 10_000 + Math.floor(Math.random() * 40_000);
  return new Promise((resolve, reject) => {
    const tokens = join(mkdtempSync(join(tmpdir(), 'mnbank-tok-')), 'tokens.json');
    dirs.push(join(tokens, '..'));
    writeFileSync(
      tokens,
      JSON.stringify({
        tokens: [
          { symbol: 'tUSDC', midnightName: 'a', role: 'usdc', decimals: 6, midnightColour: 'aa'.repeat(32) },
          { symbol: 'tSTK', midnightName: 'b', role: 'stock', decimals: 6, midnightColour: 'bb'.repeat(32) },
        ],
      }),
    );
    const child = spawn('bun', [join(SRC, 'main.ts')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        RELAY_NETWORK: 'undeployed',
        TOKENS_FILE: tokens,
        RELAY_HOST: '127.0.0.1',
        RELAY_PORT: String(port),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the relay did not exit within ${timeoutMs} ms:\n${out}`));
    }, timeoutMs);
    let served = false;
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: served ? 'served' : code, out });
    });
    if (expectServe) {
      const poll = async () => {
        for (;;) {
          if (child.exitCode !== null) return;
          const ok = await fetch(`http://127.0.0.1:${port}/v1/config`).then(
            (r) => r.ok,
            () => false,
          );
          if (ok) {
            served = true;
            child.kill('SIGTERM');
            return;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      void poll();
    }
  });
}

describe('the relay at start-up (Bun)', () => {
  it('refuses to start when a circuit it proves has no key, naming it', async () => {
    const root = volume({ except: { 'account/open_swap_shielded_with_evm': ['prover'] } });
    const r = await startRelay({ MIDNIGHT_MANAGED_PATH: root });
    expect(r.code).toBe(78);
    expect(r.out).toContain('the key volume is incomplete or does not match; refusing to start');
    expect(r.out).toContain('missing prover keys (1): account/open_swap_shielded_with_evm');
  }, 90_000);

  it('refuses to start on stagenet when the vault keys are not the deployed ones', async () => {
    const r = await startRelay({ RELAY_NETWORK: 'stagenet', MIDNIGHT_MANAGED_PATH: volume() });
    expect(r.code).toBe(78);
    expect(r.out).toContain('Erc20Vault/startDeposit: the verifier key does not match the deployed contract');
  }, 90_000);

  it('with RELAY_REQUIRE_KEYS, refuses to start without a key volume or on an empty one', async () => {
    const r = await startRelay({ RELAY_REQUIRE_KEYS: 'true' });
    expect(r.code).toBe(78);
    expect(r.out).toContain('RELAY_REQUIRE_KEYS is set but MIDNIGHT_MANAGED_PATH names no key volume');
    const empty = mkdtempSync(join(tmpdir(), 'mnbank-empty-'));
    dirs.push(empty);
    const e = await startRelay({ MIDNIGHT_MANAGED_PATH: empty, RELAY_REQUIRE_KEYS: 'true' });
    expect(e.code).toBe(78);
    expect(e.out).toContain('no compiled contracts with keys were found');
  }, 90_000);

  it('without it, an empty key path (the image default, nothing mounted) starts keyless and says so', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mnbank-empty-'));
    dirs.push(empty);
    const r = await startRelay({ MIDNIGHT_MANAGED_PATH: empty }, 60_000, true);
    expect(r.code).toBe('served');
    expect(r.out).toContain('no key volume at MIDNIGHT_MANAGED_PATH');
  }, 90_000);
});
