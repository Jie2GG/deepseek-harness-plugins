// The approval question the tool gate asks: what the effective policy of one
// conversation is, and which answers mean "somebody decided" versus "nobody is
// there to decide". Task book §3.5: the two must not be merged — full-access
// mode is consent stated on purpose, a missing approval service is the absence
// of anyone who could give it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveApprovalPolicy } from '../lib/approval.js'

const session = { id: 'session-1' }
const agent = { session }

test('no approval service mounted at all reads as unavailable, not as permission', () => {
  assert.equal(effectiveApprovalPolicy(undefined, agent), 'unavailable')
  assert.equal(effectiveApprovalPolicy(null, agent), 'unavailable')
})

test('a service with no session to route through is the same unavailability', () => {
  const service = { overrideOf: () => 'ask', config: { policy: 'ask' } }
  assert.equal(effectiveApprovalPolicy(service, undefined), 'unavailable')
  assert.equal(effectiveApprovalPolicy(service, {}), 'unavailable')
  assert.equal(effectiveApprovalPolicy(service, { session: undefined }), 'unavailable')
})

test('the session override outranks the configured default, exactly like ApprovalService.effectivePolicy', () => {
  const service = policy => ({ overrideOf: sessionArg => (sessionArg === session ? policy : undefined), config: { policy: 'ask' } })
  assert.equal(effectiveApprovalPolicy(service('never'), agent), 'never')
  assert.equal(effectiveApprovalPolicy(service('ask'), agent), 'ask')
  // No override recorded: the service's configured policy speaks, and a policy
  // outside the closed vocabulary is not a licence — it falls through to ask.
  assert.equal(effectiveApprovalPolicy(service(undefined), agent), 'ask')
  assert.equal(effectiveApprovalPolicy({ overrideOf: () => undefined, config: { policy: 'never' } }, agent), 'never')
  assert.equal(effectiveApprovalPolicy({ overrideOf: () => undefined }, agent), 'ask')
  assert.equal(effectiveApprovalPolicy({ overrideOf: () => undefined, config: { policy: 'sometimes' } }, agent), 'ask')
})

test('a policy read that throws asks rather than assumes', () => {
  const service = {
    overrideOf () { throw new Error('storage offline') },
    config: { policy: 'never' }
  }
  assert.equal(effectiveApprovalPolicy(service, agent), 'ask')
})
