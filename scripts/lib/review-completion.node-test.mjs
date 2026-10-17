import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,resolveRoutingV2} from './model-routing.mjs';
import {completionFixture} from '../fixtures/model-routing/synthetic.mjs';
import {validateReviewCompletions} from './review-completion.mjs';

test('completion accepts exact-head independent declarations with separate authenticated observations',()=>{
  const x=completionFixture();assert.equal(validateReviewCompletions(x).status,'accepted');
  assert.equal(x.plan.compliance,'unverified');
});
for(const [name,mutate] of Object.entries({
  staleHead:x=>x.trustedContext.expected.headSha='0'.repeat(40),
  staleBase:x=>x.receipts[0].baseSha='0'.repeat(40),
  stalePolicy:x=>x.receipts[0].policyDigest='0'.repeat(64),
  staleArtifact:x=>x.receipts[0].artifactDigest='0'.repeat(64),
  staleDiff:x=>x.receipts[0].diffDigest='0'.repeat(64),
  missingOutput:x=>delete x.receipts[0].resultDigest,
  prosePassOnly:x=>x.receipts=[{verdict:'pass'}],
  requestedAsObserved:x=>x.trustedContext.observations=[],
  unknownEffective:x=>x.receipts[0].observed.model='unknown',
  modelMismatch:x=>x.receipts[0].observed.model='another-model',
  familyFabrication:x=>x.receipts[0].observed.family='different-family',
  effortUnknown:x=>x.receipts[0].observed.effort='unknown',
  emissionMismatch:x=>x.receipts[0].emitted.effort='low',
  copiedId:x=>x.receipts[1].id=x.receipts[0].id,
  copiedOutput:x=>x.receipts[1].resultDigest=x.receipts[0].resultDigest,
  sharedExecution:x=>x.receipts[1].executionId=x.receipts[0].executionId,
  missingSlot:x=>x.receipts.pop(),
  replayId:x=>x.trustedContext.usedReceiptIds.push(x.receipts[0].id),
  replayOutput:x=>x.trustedContext.usedResultDigests.push(x.receipts[0].resultDigest),
  expiredProof:x=>x.trustedContext.observations[0].expiresAt=x.now,
  unboundProof:x=>x.trustedContext.observations[0].receiptDigest='0'.repeat(64),
  priorSnapshot:x=>{x.plan={...x.plan,contextDigest:'0'.repeat(64)};},
  contributorRemoved:x=>x.receipts[0].authors=[],
  budgetReset:x=>x.trustedContext.budget.consumed.tokens=0,
  budgetExpanded:x=>x.trustedContext.budget.ceiling.tokens=1001,
  budgetExceeded:x=>x.receipts[0].usage.tokens=1001,
  repairExhausted:x=>x.trustedContext.budget.repairRounds=2,
  unknownReceiptField:x=>x.receipts[0].providerResponse='payload',
  unknownTrustedField:x=>x.trustedContext.allow=true,
}))test('completion rejects '+name,()=>{const x=completionFixture();mutate(x);assert.equal(validateReviewCompletions(x).status,'blocked');});
for(const status of ['fail','skip','timeout'])test('completion never promotes '+status+' to PASS',()=>{
  const x=completionFixture();x.receipts[0].tests[0].status=status;
  x.trustedContext.observations[0].receiptDigest=digest(x.receipts[0]);
  assert.equal(validateReviewCompletions(x).reason,'review_not_passed');
});
for(const verdict of ['changes_required','blocked'])test('completion rejects verdict '+verdict,()=>{
  const x=completionFixture();x.receipts[0].verdict=verdict;x.trustedContext.observations[0].receiptDigest=digest(x.receipts[0]);
  assert.equal(validateReviewCompletions(x).reason,'review_not_passed');
});
test('completion rejects authenticated but unresolved actionable findings',()=>{
  const x=completionFixture();x.receipts[0].findings=[{id:'finding',actionable:true,disposition:'open'}];
  x.trustedContext.observations[0].receiptDigest=digest(x.receipts[0]);assert.equal(validateReviewCompletions(x).reason,'review_not_passed');
});
test('authenticated but mismatched effective identity cannot satisfy the plan',()=>{
  const x=completionFixture();x.receipts[0].observed.model='unknown';
  x.trustedContext.observations[0].identity={...x.receipts[0].observed};
  x.trustedContext.observations[0].receiptDigest=digest(x.receipts[0]);
  assert.equal(validateReviewCompletions(x).reason,'review_binding_mismatch');
});
test('authenticated current usage still cannot exceed cumulative budget',()=>{
  const x=completionFixture();x.receipts[0].usage.tokens=1001;x.trustedContext.observations[0].receiptDigest=digest(x.receipts[0]);
  assert.equal(validateReviewCompletions(x).reason,'budget_exhausted');
});
test('one valid receipt cannot occupy both required slots',()=>{
  const x=completionFixture();x.receipts[1]=structuredClone(x.receipts[0]);
  assert.equal(validateReviewCompletions(x).reason,'duplicate_or_missing_review');
});
