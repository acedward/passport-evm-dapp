// Every state-changing action the relay offers, with its lane, how it is authorised, the shape
// of its body, and its executor.
//
// In P1 every executor is a stub that fails with `not-implemented`: the Passport operations are
// behind this one interface, and the lanes fill them in (L-ACC: register, withdraw,
// append-inbox; L-TRD: open-swap, take; L-BRG: bridge-deposit, bridge-withdraw). A lane that
// implements a gated call's digest builder may switch its `auth` to 'passport-call' so the
// customer signs only the contract's own typed data (one prompt per action).

import { z } from 'zod';

import {
  AppendInboxPayloadSchema,
  RELAY_ACTIONS,
  RegisterPayloadSchema,
  WithdrawPayloadSchema,
  type JobLane,
  type RelayActionName,
} from '@mnbank/core';

import type { AuthKind } from '../auth/verifiers.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';

export interface ActionDefinition {
  action: RelayActionName;
  lane: JobLane;
  auth: AuthKind;
  /** Whether the request names an existing Passport account. */
  requiresAccount: boolean;
  /** Whether the action spends the sponsor's DUST (refused while the sponsor is not ready). */
  requiresSponsor: boolean;
  payload: z.ZodType<Record<string, unknown>>;
  executor: JobExecutor;
  /** The plan lane that implements the executor. */
  implementedBy: string;
}

import { appendInboxExecutor, registerExecutor, withdrawExecutor, type AccountActionDeps } from './account-actions.js';

/** Until a lane defines its action's body, any JSON object (the size limit still applies). */
const anyObject = z.record(z.string(), z.unknown());

export { RegisterPayloadSchema };

const notImplemented =
  (action: RelayActionName, lane: string): JobExecutor =>
  async () => {
    throw new PublicError('not-implemented', `the ${action} operation is not available yet (plan lane ${lane})`);
  };

const def = (
  action: RelayActionName,
  lane: JobLane,
  implementedBy: string,
  extra: Partial<Pick<ActionDefinition, 'requiresAccount' | 'payload' | 'auth'>> = {},
): ActionDefinition => ({
  action,
  lane,
  auth: extra.auth ?? 'relay-action',
  requiresAccount: extra.requiresAccount ?? true,
  requiresSponsor: true,
  payload: extra.payload ?? anyObject,
  executor: notImplemented(action, implementedBy),
  implementedBy,
});

export function defaultCatalogue(): Map<RelayActionName, ActionDefinition> {
  const list: ActionDefinition[] = [
    def('register', 'prover', 'L-ACC', { requiresAccount: false, payload: RegisterPayloadSchema }),
    def('withdraw', 'prover', 'L-ACC'),
    def('append-inbox', 'prover', 'L-ACC'),
    def('open-swap', 'prover', 'L-TRD'),
    def('take', 'prover', 'L-TRD'),
    def('bridge-deposit', 'deposit', 'L-BRG'),
    def('bridge-withdraw', 'withdrawal', 'L-BRG'),
  ];
  const map = new Map(list.map((d) => [d.action, d]));
  for (const a of RELAY_ACTIONS) if (!map.has(a)) throw new Error(`action ${a} has no definition`);
  return map;
}

/**
 * The catalogue with plan lane L-ACC's executors: register (authorised by its RelayAction
 * signature, which is also the enrolment), and withdraw and append-inbox, each authorised by the
 * gated call's OWN Passport signature (`passport-call`), so every action is one wallet prompt.
 */
export function accountCatalogue(deps: AccountActionDeps): Map<RelayActionName, ActionDefinition> {
  const map = defaultCatalogue();
  const set = (action: RelayActionName, patch: Partial<ActionDefinition>) =>
    map.set(action, { ...map.get(action)!, ...patch });
  set('register', { executor: registerExecutor(deps) });
  set('withdraw', { auth: 'passport-call', payload: WithdrawPayloadSchema, executor: withdrawExecutor(deps) });
  set('append-inbox', {
    auth: 'passport-call',
    payload: AppendInboxPayloadSchema,
    executor: appendInboxExecutor(deps),
  });
  return map;
}
