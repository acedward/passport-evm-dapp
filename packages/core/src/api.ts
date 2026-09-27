// The relay's HTTP API: paths, request and response shapes. The browser and the relay both
// import these, so a change here is a change of the wire contract for both.
//
// State-changing requests are `POST /v1/actions/:action`, each carrying a signed
// authorisation (see ./auth.ts). The relay keeps no per-user data (Q5): a job lives in the
// relay's memory until its TTL, and the browser keeps the request id to resume it.

import { z } from 'zod';

import { RELAY_ACTIONS, type RelayActionName, SignedRelayActionSchema } from './auth.js';

export const API_PATHS = {
  health: '/health',
  config: '/v1/config',
  nonce: '/v1/auth/nonce',
  action: (action: RelayActionName) => `/v1/actions/${action}`,
  job: (requestId: string) => `/v1/jobs/${requestId}`,
  queue: '/v1/queue',
  accountState: (account: string) => `/v1/accounts/${account}/state`,
  accountInbox: (account: string) => `/v1/accounts/${account}/inbox`,
  accountZswap: (account: string) => `/v1/accounts/${account}/zswap`,
  /** `?kind=deposit|withdraw&account=<64 hex>[&erc20=<0x…>]`: the Sepolia fields to sign (plan L-BRG). */
  bridgeQuote: '/v1/bridge/quote',
  /** A bridge request the relay closed recently (plan P4-A, Q21 A): public chain facts only. */
  bridgeClosed: (requestId: string) => `/v1/bridge/closed/${requestId}`,
} as const;

// ── Errors ──────────────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.object({
    /** Machine-readable: `unauthorised`, `rate-limited`, `not-found`, `bad-request`, … */
    code: z.string(),
    message: z.string(),
    /** For auth failures, the precise reason (see AuthFailureCode). */
    detail: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── Nonces ──────────────────────────────────────────────────────────────────

export const NonceResponseSchema = z.object({
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** Unix seconds after which the relay forgets the nonce. */
  expiresAt: z.number().int(),
  /** The furthest ahead an authorisation's expiry may be, in seconds. */
  maxTtlSeconds: z.number().int(),
});
export type NonceResponse = z.infer<typeof NonceResponseSchema>;

// ── Actions and jobs ────────────────────────────────────────────────────────

/** A lane is the queue a job waits in (plan P1.3): proofs one at a time; bridge deposits one
 *  at a time per account (they share the account's deposit address); bridge withdrawals one
 *  at a time across the whole relay (they share the vault's EVM account). */
export const JOB_LANES = ['prover', 'deposit', 'withdrawal'] as const;
export type JobLane = (typeof JOB_LANES)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JobStageSchema = z.object({
  /** A short stable id, e.g. `queued`, `proving`, `submitted`, `mpc-signature`. */
  stage: z.string(),
  at: z.number().int(),
  /** Public details only: transaction hashes, request ids, heights. Never a secret. */
  detail: z.record(z.string(), z.string()).optional(),
});
export type JobStage = z.infer<typeof JobStageSchema>;

/** Jobs the relay runs on its own, never requested through a route (plan P4-A, Q21 A): closing a
 *  bridge request its owner left open. `POST /v1/actions/bridge-close` does not exist. */
export const INTERNAL_JOB_ACTIONS = ['bridge-close'] as const;
export type InternalJobAction = (typeof INTERNAL_JOB_ACTIONS)[number];
export type JobActionName = RelayActionName | InternalJobAction;

export const JobViewSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  action: z.enum([...RELAY_ACTIONS, ...INTERNAL_JOB_ACTIONS]),
  lane: z.enum(JOB_LANES),
  state: z.enum(JOB_STATES),
  /** The newest stage. */
  stage: z.string(),
  stages: z.array(JobStageSchema),
  /** 1-based position among the jobs waiting in the same queue, while queued. */
  position: z.number().int().positive().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Unix seconds after which the relay forgets this job. */
  expiresAt: z.number().int(),
  /** Public outcome (addresses, hashes, the new coin's public data). */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const ActionRequestSchema = z.object({
  /** The Passport account the action is for; absent for registration. */
  account: z
    .string()
    .regex(/^(0x)?[0-9a-f]{64}$/)
    .optional(),
  /** The action's arguments. Bytes are hex strings, amounts decimal strings. */
  payload: z.record(z.string(), z.unknown()),
  /** The relay authorisation (a RelayAction signature). */
  auth: SignedRelayActionSchema.optional(),
  /** A gated call's own Passport authorisation, for routes that accept it instead. */
  passportAuth: z.record(z.string(), z.unknown()).optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResponseSchema = z.object({ job: JobViewSchema });
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

// ── Health (FR-013) ─────────────────────────────────────────────────────────

export const HEALTH_STATUSES = ['ok', 'degraded', 'down'] as const;

export const HealthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  network: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int(),
  sponsor: z.object({
    configured: z.boolean(),
    state: z.string(),
    synced: z.boolean(),
    /** DUST balance in specks (10^-15 DUST), decimal string; null when unknown. */
    dustSpecks: z.string().nullable(),
    dustLow: z.boolean(),
  }),
  proofServer: z.object({
    reachable: z.boolean(),
    version: z.string().nullable(),
    jobCapacity: z.number().nullable(),
    keys: z.object({
      present: z.boolean(),
      fingerprint: z.string().nullable(),
      pinned: z.boolean(),
      matchesPin: z.boolean().nullable(),
      /** Every circuit the relay proves has its keys, as deployed (plan P4-A). */
      complete: z.boolean().optional(),
      /** How many circuits the relay proves lack a key or do not match the deployed contract. */
      problems: z.number().int().optional(),
    }),
  }),
  queue: z.object({
    jobs: z.number().int(),
    lanes: z.record(z.string(), z.object({ running: z.number().int(), waiting: z.number().int() })),
  }),
  kernel: z.object({ reachable: z.boolean(), synced: z.boolean().nullable() }),
  batcher: z.object({
    reachable: z.boolean(),
    /** The batcher's last refusal of a take this relay submitted (plan P4-A): 429 = its request cap,
     *  500 = a generic failure (a replayed settlement answers 500 too). Null when none. */
    lastRefusal: z.object({ httpStatus: z.number().int(), at: z.number().int() }).nullable().optional(),
  }),
  vaultGas: z.object({
    address: z.string(),
    balanceWei: z.string().nullable(),
    low: z.boolean().nullable(),
  }),
  /** The bridge (plan P4-A): the MPC's recent behaviour and the stale-request closer (Q21 A). */
  bridge: z
    .object({
      available: z.boolean(),
      mpc: z.object({
        /** Seconds the MPC took to sign the last request this relay drove; null before any. */
        lastSignatureAfterSeconds: z.number().int().nullable(),
        /** Requests whose signature did not arrive within the 20-minute budget, last 24 h. */
        timeouts24h: z.number().int(),
        /** Requests being driven now (waiting for the MPC or Sepolia). */
        inFlight: z.number().int(),
      }),
      staleRequests: z.object({
        enabled: z.boolean(),
        lastScanAt: z.number().int().nullable(),
        /** Open in the vault right now (every requester, not only this bank's customers). */
        open: z.object({ deposit: z.number().int(), withdraw: z.number().int() }),
        /** Stale requests of this bank's accounts, waiting to be closed. */
        waiting: z.number().int(),
        closing: z.number().int(),
        /** Settle or abandonDeposit transactions the sponsor paid for closing stale requests, last 24 h. */
        closed24h: z.number().int(),
        maxPerDay: z.number().int(),
        /** The newest closes (public ids only). */
        recent: z.array(
          z.object({
            kind: z.enum(['deposit', 'withdraw']),
            requestId: z.string(),
            circuit: z.string(),
            tx: z.string(),
            at: z.number().int(),
          }),
        ),
        /** Why the closer is holding back, when it is (the sponsor is low, the daily cap is reached). */
        paused: z.string().nullable(),
      }),
    })
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ── Public configuration ────────────────────────────────────────────────────

export const PublicConfigSchema = z.object({
  network: z.string(),
  chainId: z.number().int(),
  relayVersion: z.string(),
  bridge: z.object({
    vaultAddress: z.string(),
    vaultEvmAddress: z.string(),
  }),
  limits: z.object({
    authMaxTtlSeconds: z.number().int(),
    jobTtlSeconds: z.number().int(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
