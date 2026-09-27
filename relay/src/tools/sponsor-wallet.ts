// The sponsor wallet's operator tool (deploy/RUNBOOK.md, "The sponsor wallet"). It ships in the
// relay image and uses the relay's own wallet code, so the keys it derives are the relay's.
//
//   new --out <file>              write a NEW 24-word mnemonic to <file> (mode 600, never
//                                 overwrites) and print the wallet's public NIGHT address
//   address [--seed-file <file>]  print the public NIGHT address (offline)
//   status                        sync the wallet, print NIGHT, its DUST registration and DUST
//   register-dust                 register every unregistered NIGHT UTxO for DUST generation
//                                 (ONE transaction on the network; its fee is paid from the
//                                 DUST those UTxOs generate first)
//
// `status` and `register-dust` read the relay's configuration from the environment (they run as
// `docker compose run --rm --no-deps relay bun relay/src/tools/sponsor-wallet.ts …`, with the
// relay's env and secrets). They refuse while the relay itself holds the wallet open: one wallet
// process per seed. Nothing secret is ever printed: only public addresses and balances.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { ConfigError, loadConfig, parseSponsorSeed } from '../config.js';
import { deriveSponsorKeys, openFacadeWallet } from '../sponsor/facade.js';
import { takeFundingLock } from '../sponsor/funding-lock.js';

const say = (msg: string) => process.stderr.write(`sponsor-wallet: ${msg}\n`);
const out = (o: unknown) =>
  process.stdout.write(`${JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString(10) : v), 2)}\n`);

/** Whole units of a base-unit amount (NIGHT: 10^6 STAR; DUST: 10^15 specks), as text. */
export function units(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Write a new 24-word mnemonic to `path` (exclusive create, mode 600). Returns the words. */
export function writeNewMnemonic(path: string): string {
  if (existsSync(path)) throw new Error(`${path} already exists; the tool never overwrites a seed`);
  const mnemonic = generateMnemonic(wordlist, 256);
  writeFileSync(path, `${mnemonic}\n`, { flag: 'wx', mode: 0o600 });
  return mnemonic;
}

/** The wallet's public unshielded (NIGHT) address, derived offline from its seed. */
export async function unshieldedAddress(seedHex: string, networkId: string): Promise<string> {
  const [hd, unshielded] = await Promise.all([
    import('@midnightntwrk/wallet-sdk-hd'),
    import('@midnightntwrk/wallet-sdk-unshielded-wallet'),
  ]);
  const keys = deriveSponsorKeys(hd, seedHex);
  const keystore = unshielded.createKeystore({ kind: 'schnorr', secret: keys.night } as never, networkId as never) as {
    getBech32Address(): { asString(): string };
  };
  return keystore.getBech32Address().asString();
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Refuse while the relay holds the wallet: a second wallet process on one seed breaks the first. */
async function refuseIfRelayHoldsWallet(): Promise<void> {
  const url = process.env.SPONSOR_TOOL_RELAY_HEALTH_URL ?? 'http://relay:8080/health';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    const body = (await res.json()) as { sponsor?: { state?: string } };
    const state = body.sponsor?.state;
    if (state && !['disabled', 'stopped'].includes(state)) {
      throw new Error(
        `the relay has the sponsor wallet open (state ${state}); stop it first: docker compose stop relay`,
      );
    }
  } catch (e) {
    if ((e as Error).message.startsWith('the relay has')) throw e;
    /* the relay is not running: go on */
  }
}

type FacadeState = {
  isSynced: boolean;
  unshielded: {
    balances: Record<string, bigint>;
    availableCoins: { utxo: { type: string; value: bigint }; meta: { registeredForDustGeneration: boolean } }[];
  };
  dust: { balance(t: Date): bigint };
};

async function withWallet<T>(
  fn: (
    w: {
      facade: Record<string, (...a: unknown[]) => Promise<unknown>>;
      state: () => Promise<FacadeState>;
      handle: Record<string, unknown>;
    },
    ctx: { networkId: string; seedHex: string; vault: string; indexerUrl: string; indexerWsUrl: string },
  ) => Promise<T>,
): Promise<T> {
  const { config, secrets } = loadConfig(process.env, (p) => readFileSync(p, 'utf8'));
  if (!secrets.sponsorSeedHex) throw new ConfigError('SPONSOR_SEED_FILE is not set');
  await refuseIfRelayHoldsWallet();
  const lock = config.sponsor.fundingLockFile
    ? takeFundingLock(config.sponsor.fundingLockFile, 'mn-bank sponsor-wallet tool')
    : null;
  try {
    const opened = await openFacadeWallet(
      secrets.sponsorSeedHex,
      {
        networkId: config.network.midnightNetworkId,
        indexerUrl: config.network.midnight.indexerUrl,
        indexerWsUrl: config.network.midnight.indexerWsUrl,
        nodeWsUrl: config.network.midnight.nodeWsUrl,
        proofServerUrl: config.proofServerUrl,
      },
      { feeBlocksMargin: config.sponsor.feeBlocksMargin },
    );
    const handle = opened.handle as Record<string, unknown>;
    const wallet = handle.wallet as {
      state(): { subscribe(o: { next(s: FacadeState): void; error(e: unknown): void }): { unsubscribe(): void } };
    } & Record<string, (...a: unknown[]) => Promise<unknown>>;
    const state = (timeoutMs = 20 * 60_000) =>
      new Promise<FacadeState>((resolve, reject) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          reject(new Error(`the wallet did not sync within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        const sub = wallet.state().subscribe({
          next: (s) => {
            if (s.isSynced) {
              clearTimeout(timer);
              queueMicrotask(() => sub.unsubscribe());
              resolve(s);
            }
          },
          error: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    try {
      return await fn(
        { facade: wallet, state, handle },
        {
          networkId: config.network.midnightNetworkId,
          seedHex: secrets.sponsorSeedHex,
          vault: config.network.bridge.vaultAddress,
          indexerUrl: config.network.midnight.indexerUrl,
          indexerWsUrl: config.network.midnight.indexerWsUrl,
        },
      );
    } finally {
      await opened.stop();
    }
  } finally {
    lock?.release();
  }
}

/** The live DUST generation parameters, read with the ledger parameters of any contract. */
async function liveDustParameters(ctx: { networkId: string; vault: string; indexerUrl: string; indexerWsUrl: string }) {
  if (!ctx.vault) return null;
  try {
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(ctx.networkId as never);
    const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
    const pdp = indexerPublicDataProvider(ctx.indexerUrl, ctx.indexerWsUrl) as unknown as {
      queryZSwapAndContractState(a: string): Promise<readonly unknown[] | null>;
    };
    const states = await pdp.queryZSwapAndContractState(ctx.vault);
    const dust = (states?.[2] as { dust?: Record<string, unknown> } | undefined)?.dust;
    if (!dust) return null;
    const pick = (k: string) =>
      typeof dust[k] === 'bigint' || typeof dust[k] === 'number' ? BigInt(dust[k] as bigint) : null;
    return {
      nightDustRatio: pick('nightDustRatio'),
      generationDecayRate: pick('generationDecayRate'),
      dustGracePeriodSeconds: pick('dustGracePeriodSeconds'),
      timeToCapSeconds: pick('timeToCapSeconds'),
    };
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const networkId =
    arg(args, '--network') ?? process.env.MIDNIGHT_NETWORK_ID ?? process.env.RELAY_NETWORK ?? 'stagenet';

  if (cmd === 'new') {
    const path = arg(args, '--out');
    if (!path) throw new Error('usage: new --out <file>');
    const mnemonic = writeNewMnemonic(path);
    const address = await unshieldedAddress(parseSponsorSeed(mnemonic), networkId);
    out({ wrote: path, mode: '600', network: networkId, nightAddress: address });
    say('keep the file private: it is the sponsor wallet. Back it up like any wallet seed.');
    return 0;
  }

  if (cmd === 'address') {
    const file = arg(args, '--seed-file') ?? process.env.SPONSOR_SEED_FILE;
    if (!file) throw new Error('usage: address --seed-file <file> (or set SPONSOR_SEED_FILE)');
    const address = await unshieldedAddress(parseSponsorSeed(readFileSync(file, 'utf8')), networkId);
    out({ network: networkId, nightAddress: address });
    return 0;
  }

  if (cmd === 'status' || cmd === 'register-dust') {
    const ledger = (await import('@midnightntwrk/ledger-v9')) as unknown as { nativeToken(): { raw: string } };
    const night = ledger.nativeToken().raw;
    return withWallet(async (w, ctx) => {
      say('syncing the wallet (read-only)…');
      let s = await w.state();
      const coins = () => s.unshielded.availableCoins.filter((c) => c.utxo.type === night);
      const unregistered = () => coins().filter((c) => !c.meta.registeredForDustGeneration);
      const summary = async () => {
        const registered = coins()
          .filter((c) => c.meta.registeredForDustGeneration)
          .reduce((a, c) => a + c.utxo.value, 0n);
        const params = await liveDustParameters(ctx);
        return {
          network: ctx.networkId,
          nightAddress: await unshieldedAddress(ctx.seedHex, ctx.networkId),
          night: {
            balance: units(s.unshielded.balances[night] ?? 0n, 6),
            utxos: coins().length,
            registeredForDust: units(registered, 6),
            unregisteredUtxos: unregistered().length,
          },
          dust: { balance: units(s.dust.balance(new Date()), 15) },
          ...(params
            ? {
                dustGeneration: {
                  source: 'the live ledger parameters',
                  ...params,
                  capForRegisteredNight:
                    params.nightDustRatio === null ? null : units(registered * params.nightDustRatio, 15),
                  perDayForRegisteredNight:
                    params.generationDecayRate === null
                      ? null
                      : units(registered * params.generationDecayRate * 86_400n, 15),
                },
              }
            : {}),
        };
      };
      if (cmd === 'status') {
        out(await summary());
        return 0;
      }
      const utxos = unregistered();
      if (utxos.length === 0) {
        say('no unregistered NIGHT UTxO: nothing to do');
        out(await summary());
        return 0;
      }
      // The recipe the Offer Files ladder tools use on stagenet (wallet-sdk-facade 5.0.0-beta.2):
      // estimate the fee, wait until the UTxOs have generated it, register, prove, submit.
      const keystore = w.handle.unshieldedKeystore as {
        getPublicKey(): unknown;
        signDataAsync(d: Uint8Array): Promise<unknown>;
      };
      const { fee } = (await w.facade.estimateRegistration(utxos)) as { fee: bigint };
      say(`registration fee ${units(fee, 15)} DUST; waiting until the NIGHT has generated it`);
      await w.facade.waitForGeneratedDust(utxos, fee, { timeoutMs: 60 * 60_000 });
      const recipe = (await w.facade.registerNightUtxosForDustGeneration(
        utxos,
        keystore.getPublicKey(),
        (d: Uint8Array) => keystore.signDataAsync(d),
      )) as { type: string };
      if (recipe.type !== 'UNPROVEN_TRANSACTION') throw new Error(`unexpected registration recipe ${recipe.type}`);
      const finalized = (await w.facade.finalizeRecipe(recipe)) as { identifiers(): string[] };
      const txId = await w.facade.submitTransaction(finalized);
      say(`registration submitted: ${String(txId)}`);
      s = await w.state();
      out({ registered: utxos.length, transaction: String(txId), after: await summary() });
      return 0;
    });
  }

  say('usage: sponsor-wallet.ts new --out <file> | address [--seed-file <file>] | status | register-dust');
  return 64;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      say(`error: ${e instanceof Error ? e.message : 'failed'}`);
      process.exit(e instanceof ConfigError ? 78 : 1);
    },
  );
}
