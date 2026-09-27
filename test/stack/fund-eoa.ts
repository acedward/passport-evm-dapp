// Funds the L-BRG live runs' test EOA from the owner's Sepolia funder (plan 00039 Q8 caps: at
// most 0.006 ETH per call here, 0.02 ETH per run; at most 10 of each token). Sends only what the
// EOA lacks. The funder's key file (SK=…) is read in THIS process only and never printed; the
// output is public (addresses, hashes, balances).
//
//   SEPOLIA_KEY_FILE=/secrets/sepolia FUND_TO=0x… FUND_ETH_WEI=5000000000000000 \
//   FUND_TOKENS=0x2Ab7…:2000000,0x1c7D…:2000000 bun test/stack/fund-eoa.ts

import { readFileSync } from 'node:fs';

import { Contract, JsonRpcProvider, Wallet, getAddress } from 'ethers';

const FUNDER = '0x484738A67858305Edfc139B194Ed430Fe4D8e56b';
const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const CAP_ETH_WEI = 6_000_000_000_000_000n; // 0.006 ETH (instruction for this lane; run cap 0.02)
const CAP_TOKEN = 10_000_000n; // 10 tokens at 6 decimals
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
];

const to = getAddress(process.env.FUND_TO ?? '');
const wantEth = BigInt(process.env.FUND_ETH_WEI ?? '0');
const wantTokens = (process.env.FUND_TOKENS ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const [token, amount] = s.split(':');
    return { token: getAddress(token!), amount: BigInt(amount!) };
  });
if (wantEth > CAP_ETH_WEI) throw new Error('FUND_ETH_WEI is above the cap');
for (const t of wantTokens) if (t.amount > CAP_TOKEN) throw new Error('a token amount is above the cap');

const provider = new JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const line = readFileSync(process.env.SEPOLIA_KEY_FILE ?? '/secrets/sepolia', 'utf8')
  .split(/\r?\n/)
  .find((l) => /^\s*SK\s*=/.test(l));
if (!line) throw new Error('the key file has no SK= line');
const funder = new Wallet(
  `0x${line
    .replace(/^\s*SK\s*=\s*/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^0x/i, '')}`,
  provider,
);
if (funder.address !== FUNDER) throw new Error('the key file does not derive the expected funder');
if ((await provider.getNetwork()).chainId !== 11155111n) throw new Error('not Sepolia');

const latest = await provider.getTransactionCount(FUNDER, 'latest');
const pending = await provider.getTransactionCount(FUNDER, 'pending');
if (pending > latest)
  throw new Error(`the funder has ${pending - latest} transaction(s) in flight: another sender is active`);

const out: Record<string, unknown> = { funder: FUNDER, to, at: new Date().toISOString(), txs: [] as unknown[] };
const before = {
  eth: await provider.getBalance(to),
  tokens: {} as Record<string, string>,
  funderEth: await provider.getBalance(FUNDER),
  funderTokens: {} as Record<string, string>,
};
for (const t of wantTokens) {
  const c = new Contract(t.token, ERC20, provider);
  before.tokens[t.token] = String(await c.balanceOf!(to));
  before.funderTokens[t.token] = String(await c.balanceOf!(FUNDER));
}
out.before = {
  eth: String(before.eth),
  tokens: before.tokens,
  funderEth: String(before.funderEth),
  funderTokens: before.funderTokens,
};

const txs = out.txs as Array<Record<string, unknown>>;
for (const t of wantTokens) {
  const have = BigInt(before.tokens[t.token]!);
  if (have >= t.amount) continue;
  if (BigInt(before.funderTokens[t.token]!) < t.amount - have)
    throw new Error(`the funder holds too little of ${t.token}`);
  const c = new Contract(t.token, ERC20, funder);
  const sent = await c.transfer!(to, t.amount - have);
  const r = await sent.wait(1);
  txs.push({
    what: `${t.token} ${t.amount - have}`,
    hash: r.hash,
    block: r.blockNumber,
    status: r.status,
    feeWei: String(r.gasUsed * r.gasPrice),
  });
}
if (before.eth < wantEth) {
  const sent = await funder.sendTransaction({ to, value: wantEth - before.eth });
  const r = await sent.wait(1);
  txs.push({
    what: `ETH ${wantEth - before.eth}`,
    hash: r!.hash,
    block: r!.blockNumber,
    status: r!.status,
    feeWei: String(r!.gasUsed * r!.gasPrice),
    valueWei: String(wantEth - before.eth),
  });
}
const after = { eth: String(await provider.getBalance(to)), tokens: {} as Record<string, string> };
for (const t of wantTokens) after.tokens[t.token] = String(await new Contract(t.token, ERC20, provider).balanceOf!(to));
out.after = after;
console.log(`FUNDED ${JSON.stringify(out)}`);
provider.destroy();
