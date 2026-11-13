/**
 * Whether this conversation can actually be asked.
 *
 * The approval policy and the file sandbox are two different switches: a session
 * with full workspace permission still resolves every request as rejected when its
 * approval policy is `never`, and the core decides that **before** dispatching the
 * `approval/request` waterfall, so a plugin listener cannot rescue an ask there. The
 * only place left to decide is the gate itself, which means reading the same policy
 * the approval service would apply.
 *
 * The precedence here mirrors `ApprovalService.effectivePolicy` — the session's
 * logged override, then the service's configured default, then `'ask'` — reached
 * through optional reads so a profile without the approval service still works.
 *
 * @module @jie2gg/dsh-plugin-ssh/approval
 */

/** What a conversation does with a request that needs its answer. */
export type ApprovalAnswer = 'ask' | 'never' | 'unavailable'

/**
 * Determine the policy one tool call would be answered under.
 * @param approval - the `approval` service from the context, when one is mounted.
 * @param agent - the agent the call belongs to, when one is known.
 * @returns the effective policy, or `unavailable` when nobody could answer.
 */
export function effectiveApprovalPolicy(approval: unknown, agent: unknown): ApprovalAnswer {
  const service = approval as {
    overrideOf?: ((session: unknown) => unknown) | undefined
    config?: { policy?: unknown } | undefined
  } | undefined
  if (service === undefined || service === null) return 'unavailable'
  const scope = agent as { session?: unknown } | undefined
  if (scope?.session === undefined) return 'unavailable'
  let override: unknown
  try {
    override = service.overrideOf?.(scope.session)
  } catch {
    // A policy read that failed is not a licence to run unattended: ask anyway and
    // let the approval surface answer for itself.
    return 'ask'
  }
  if (override === 'never' || override === 'ask') return override
  const configured = service.config?.policy
  if (configured === 'never' || configured === 'ask') return configured
  return 'ask'
}
