// Local-stack test harness (plan L-ACC testing): fund a Passport account with a shielded coin
// the way any third party would, with `deposit_shielded(coin, entry)`, the entry sealed to the
// account's advertised `enc_key` (MIP-0012 §6.2). The funder is a stack wallet that holds the
// colour (the stack's aa-deploy mints its shielded test colour to genesis-3).
//
// Runs in a Bun container on the stack's network, with the repository's node_modules and the key
// volume mounted where the relay mounts it:
//
//   docker run --rm --network <P>_default -v <app volume>:/app:ro \
//     -v ~/.cache/aa-00039/keys:/app/vendor/passport/contract/contracts/managed:ro \
//     -v <seed file>:/run/secrets/funder:ro -e FUND_ACCOUNT=<64 hex> -e FUND_COLOUR=<64 hex> \
//     -e FUND_AMOUNT=<base units> oven/bun:1.3.11 bun /app/test/stack/fund-account.ts
//
// SECRETS: the funder seed is read from the mounted file in-process and never printed. Only
// public values are written: the account, the coin, the transaction and the funder's shielded
// coin public key (a test recipient for withdrawals).

import { readFileSync } from 'node:fs';

import { sealEntryPortable } from '../../vendor/passport/contract/src/wallet/deposit.js';
import { parseSponsorSeed } from '../../relay/src/config.js';
import { createLogger } from '../../relay/src/log.js';
import { PassportRuntime } from '../../relay/src/passport/runtime.js';
import { syncedKeys } from '../../relay/src/passport/wallet-provider.js';
import { openFacadeWallet } from '../../relay/src/sponsor/facade.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`${k} is required`);
  return v;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));

const t0 = Date.now();
const log = createLogger({ level: 'info' }, { service: 'fund-account' });
const account = env('FUND_ACCOUNT').replace(/^0x/, '').toLowerCase();
const colour = env('FUND_COLOUR').replace(/^0x/, '').toLowerCase();
const amount = BigInt(env('FUND_AMOUNT'));
const managedPath = env('MIDNIGHT_MANAGED_PATH', '/app/vendor/passport/contract/contracts/managed');
const proofServerUrl = env('MIDNIGHT_PROOF_SERVER_URL', 'http://proof-server-rc6:6300');
const indexerUrl = env('MIDNIGHT_INDEXER_URL', 'http://indexer:8088/api/v4/graphql');
const indexerWsUrl = env('MIDNIGHT_INDEXER_WS_URL', 'ws://indexer:8088/api/v4/graphql/ws');
const nodeWsUrl = env('MIDNIGHT_NODE_WS_URL', 'ws://node:9944');

const seedHex = parseSponsorSeed(readFileSync(env('FUNDER_SEED_FILE', '/run/secrets/funder'), 'utf8'));
const runtime = await PassportRuntime.load({
  managedPath,
  networkId: 'undeployed',
  indexerUrl,
  indexerWsUrl,
  proofServerUrl,
  log,
});
const opened = await openFacadeWallet(
  seedHex,
  { networkId: 'undeployed', indexerUrl, indexerWsUrl, nodeWsUrl, proofServerUrl },
  { feeBlocksMargin: 5 },
);
const handle = opened.handle as Parameters<typeof syncedKeys>[0];
const keys = await syncedKeys(handle);
log.info('funder wallet synced', { seconds: (Date.now() - t0) / 1000 });

try {
  const l = await runtime.ledgerState(account);
  if (!l?.booted) throw new Error('the account is not active');
  const coin = { nonce: crypto.getRandomValues(new Uint8Array(32)), color: unhex(colour), value: amount };
  const entry = await sealEntryPortable(Uint8Array.from(l.enc_key), coin);
  const providers = await runtime.providers(handle);
  const custody = await runtime.client.account.CustodyAccount.connect(providers, runtime.compiledAccount(), account);
  const t1 = Date.now();
  const r = await custody.depositShielded(coin, entry);
  const af = await import('@midnightntwrk/wallet-sdk-address-format');
  const cpk = keys.coinPublicKey.replace(/^0x/, '');
  const epk = keys.encryptionPublicKey.replace(/^0x/, '');
  const shieldedAddress = af.MidnightBech32m.encode(
    'undeployed',
    new af.ShieldedAddress(
      af.ShieldedCoinPublicKey.fromHexString(cpk),
      new af.ShieldedEncryptionPublicKey(Buffer.from(epk, 'hex')),
    ),
  ).asString();
  const out = {
    account,
    txId: r.txId,
    coin: { nonce: hex(coin.nonce), color: colour, value: amount.toString() },
    funderCoinPublicKey: cpk,
    funderEncryptionPublicKey: epk,
    funderShieldedAddress: shieldedAddress,
    depositSeconds: (Date.now() - t1) / 1000,
    totalSeconds: (Date.now() - t0) / 1000,
  };
  console.log(`FUNDED ${JSON.stringify(out)}`);
} finally {
  await opened.stop().catch(() => {});
}
process.exit(0);
