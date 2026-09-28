// An action's own check at admission (security review F-B2, F-B3): it runs after the request's
// authorisation is verified and the rate limits are taken, and BEFORE the job is queued. A refusal
// here costs no queue slot, no proof and no DUST. Executors still check again when their turn
// comes (the account's state can change while a job waits).

export interface AdmissionRequest {
  /** The Passport account the request names (64 hex, no 0x), when the action takes one. */
  account?: string;
  /** The action's arguments, as validated by its payload schema. */
  payload: Record<string, unknown>;
  /** The verified signer's EVM address. */
  signer: string;
}

export type AdmissionOutcome =
  | {
      ok: true;
      /** Undo everything the check claimed (a single-use entitlement, and the day's append
       *  allowance) when the route refuses the request after all (a full queue), so the customer
       *  can send it again and is charged nothing (security review F-B7). Idempotent. */
      release?: () => void;
    }
  | {
      ok: false;
      status: 401 | 403 | 429 | 503;
      /** The error code the route answers with (`unauthorised` for a signer refusal). */
      code: string;
      reason: string;
      /** The machine-readable detail (e.g. `wrong-signer`), as auth refusals carry. */
      detail?: string;
    };

export type AdmissionCheck = (request: AdmissionRequest) => Promise<AdmissionOutcome>;
