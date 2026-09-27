// The token registry: which tokens the bank shows and trades, with their roles.
//
// Every trade is USDC against exactly one stock (spec FR-008), so each token has a ROLE:
// `usdc` (the quote currency; exactly one) or `stock`. The stagenet registry is built from the
// PR #4 deployment records vendored beside this file; the local stack's registry is supplied
// as configuration (its vault and colours are new on every stack).

import { getAddress } from 'ethers';
import { z } from 'zod';

import { normaliseHex32 } from '../hex.js';
import type { NetworkName } from '../network.js';
// Named imports, so a browser bundle carries only these fields of the vendored records.
import { tokens as sepoliaStkTokens } from './deployments/sepolia-stk.json';
import { bridgedTokens, vaultContractAddress } from './deployments/stagenet-vault.json';

export const TOKEN_ROLES = ['usdc', 'stock'] as const;
export type TokenRole = (typeof TOKEN_ROLES)[number];

/** Where a registry entry came from, shown as "bridged from Sepolia 0x…" (spec edge cases). */
export interface TokenSource {
  repo: string;
  commit: string;
  file: string;
}

export interface TokenEntry {
  /** The Sepolia ERC20 symbol: stkA, stkB, stkC, USDC. */
  symbol: string;
  /** The bridged token's name on Midnight: wStkA, …, wUSDC. */
  midnightName: string;
  role: TokenRole;
  decimals: number;
  /** Checksummed ERC20 address on Sepolia; '' when the token has no Sepolia side (local). */
  sepoliaAddress: string;
  /** The shielded colour on Midnight, 64 lowercase hex characters. */
  midnightColour: string;
  /** The vault that mints the bridged colour; '' when not bridged (local test tokens). */
  vault: string;
  /** True while an entry is not yet confirmed by its owner's canonical list. Every stagenet entry
   *  is confirmed (PR #4's description lists them at `07d8ea4`); configuration may still set it. */
  provisional: boolean;
  source: TokenSource | null;
}

/** Sepolia's native currency, for the EVM holdings view. */
export const SEPOLIA_ETH = { symbol: 'ETH', name: 'Sepolia ether', decimals: 18 } as const;

export class TokenRegistryError extends Error {
  override name = 'TokenRegistryError';
}

export class TokenRegistry {
  readonly tokens: readonly TokenEntry[];
  private readonly byColourMap: Map<string, TokenEntry>;
  private readonly byAddressMap: Map<string, TokenEntry>;

  constructor(
    readonly network: NetworkName,
    tokens: readonly TokenEntry[],
  ) {
    const usdc = tokens.filter((t) => t.role === 'usdc');
    if (usdc.length !== 1)
      throw new TokenRegistryError(`a registry needs exactly one usdc token, found ${usdc.length}`);
    if (!tokens.some((t) => t.role === 'stock')) throw new TokenRegistryError('a registry needs at least one stock');
    this.byColourMap = new Map();
    this.byAddressMap = new Map();
    const names = new Set<string>();
    for (const t of tokens) {
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) {
        throw new TokenRegistryError(`${t.midnightName}: decimals ${t.decimals} out of range`);
      }
      if (this.byColourMap.has(t.midnightColour)) throw new TokenRegistryError(`duplicate colour ${t.midnightColour}`);
      if (names.has(t.midnightName)) throw new TokenRegistryError(`duplicate token name ${t.midnightName}`);
      names.add(t.midnightName);
      this.byColourMap.set(t.midnightColour, t);
      if (t.sepoliaAddress !== '') {
        const key = t.sepoliaAddress.toLowerCase();
        if (this.byAddressMap.has(key)) throw new TokenRegistryError(`duplicate Sepolia address ${t.sepoliaAddress}`);
        this.byAddressMap.set(key, t);
      }
    }
    this.tokens = Object.freeze([...tokens]);
  }

  /** The quote currency. */
  usdc(): TokenEntry {
    const t = this.tokens.find((x) => x.role === 'usdc');
    if (!t) throw new TokenRegistryError('no usdc token');
    return t;
  }

  stocks(): TokenEntry[] {
    return this.tokens.filter((t) => t.role === 'stock');
  }

  /** The entry for a Midnight colour (any hex case, with or without 0x), or undefined. */
  byColour(colour: string): TokenEntry | undefined {
    try {
      return this.byColourMap.get(normaliseHex32(colour));
    } catch {
      return undefined;
    }
  }

  bySepoliaAddress(address: string): TokenEntry | undefined {
    return this.byAddressMap.get(address.toLowerCase());
  }

  byMidnightName(name: string): TokenEntry | undefined {
    return this.tokens.find((t) => t.midnightName === name);
  }

  /** A pair the bank trades: USDC against exactly one stock. */
  isTradablePair(colourA: string, colourB: string): boolean {
    const a = this.byColour(colourA);
    const b = this.byColour(colourB);
    return (
      !!a && !!b && a !== b && ((a.role === 'usdc' && b.role === 'stock') || (a.role === 'stock' && b.role === 'usdc'))
    );
  }
}

// ── The stagenet registry, from the vendored PR #4 records ──────────────────

export const STAGENET_SOURCE: TokenSource = {
  repo: 'acedward/passport',
  commit: '07d8ea4f4e83ad264b3d2eef536be02047308827',
  file: 'contract/contracts/erc20-vault/deployments/stagenet-vault.json',
};

/** Symbols whose ERC20 is the quote currency. */
const USDC_SYMBOLS = new Set(['USDC']);

export function stagenetRegistry(): TokenRegistry {
  const stk = new Map(sepoliaStkTokens.map((t) => [t.address.toLowerCase(), t]));
  const tokens = bridgedTokens.map((b): TokenEntry => {
    const sepolia = stk.get(b.erc20Address.toLowerCase());
    if (sepolia && (sepolia.decimals !== b.decimals || sepolia.midnightColour !== b.midnightColour)) {
      throw new TokenRegistryError(`${b.erc20}: sepolia-stk.json and stagenet-vault.json disagree`);
    }
    return {
      symbol: b.erc20,
      midnightName: b.midnightName,
      role: USDC_SYMBOLS.has(b.erc20) ? 'usdc' : 'stock',
      decimals: b.decimals,
      sepoliaAddress: getAddress(b.erc20Address),
      midnightColour: normaliseHex32(b.midnightColour),
      vault: normaliseHex32(vaultContractAddress),
      // Canonical: PR #4's description lists every one of these at `07d8ea4` (PROVENANCE.md).
      provisional: false,
      source: STAGENET_SOURCE,
    };
  });
  return new TokenRegistry('stagenet', tokens);
}

// ── Registries from configuration (the local stack, or an owner override) ───

export const TokenConfigSchema = z.object({
  tokens: z
    .array(
      z.object({
        symbol: z.string().min(1),
        midnightName: z.string().min(1),
        role: z.enum(TOKEN_ROLES),
        decimals: z.number().int().min(0).max(18),
        sepoliaAddress: z
          .string()
          .regex(/^(0x[0-9a-fA-F]{40})?$/)
          .default(''),
        midnightColour: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
        vault: z
          .string()
          .regex(/^([0-9a-fA-F]{64})?$/)
          .default(''),
        provisional: z.boolean().default(false),
      }),
    )
    .min(2),
});
export type TokenConfig = z.input<typeof TokenConfigSchema>;

/** Build a registry from JSON configuration (for example the local stack's test colours
 *  mapped to the USDC and stock roles). */
export function registryFromConfig(network: NetworkName, config: unknown): TokenRegistry {
  const parsed = TokenConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TokenRegistryError(`invalid token configuration: ${issues}`);
  }
  return new TokenRegistry(
    network,
    parsed.data.tokens.map((t) => ({
      ...t,
      sepoliaAddress: t.sepoliaAddress === '' ? '' : getAddress(t.sepoliaAddress),
      midnightColour: normaliseHex32(t.midnightColour),
      vault: t.vault === '' ? '' : normaliseHex32(t.vault),
      source: null,
    })),
  );
}

/** The registry for a network: stagenet's from the vendored records unless configuration is
 *  given; the local stack always needs configuration. */
export function registryFor(network: NetworkName, config?: unknown): TokenRegistry {
  if (config !== undefined) return registryFromConfig(network, config);
  if (network === 'stagenet') return stagenetRegistry();
  throw new TokenRegistryError(`the ${network} network has no built-in token list; pass a token configuration`);
}
