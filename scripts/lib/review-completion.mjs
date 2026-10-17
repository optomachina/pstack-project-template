import { canonicalJSON, digest, validateV2, isKnownRoutingValue } from './model-routing.mjs';
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const dimensions = ['tokens', 'wallTimeMs', 'attempts'];
const blocked = reason => Object.freeze({status:'blocked', reason, acceptedReceiptIds:[]});
const knownIdentity = identity => ['provider','model','family','effort'].every(k => isKnownRoutingValue(identity?.[k]));

function receiptMatchesPlan(receipt, plan, expected) {
  const review = plan.reviewPlans.find(r => r.obligationId === receipt.slotId);
  if (!review || Object.keys(expected).some(k => receipt[k] !== expected[k])) return false;
  const s = review.selection;
  const identity = {provider:s.provider, model:s.model, family:s.family, effort:s.plannedEmission.value};
  if (!knownIdentity(identity) || !['requested','selected','emitted','observed'].every(k => knownIdentity(receipt[k]))) return false;
  return receipt.policyRevision === plan.policyRevision && receipt.catalogRevision === plan.catalogRevision &&
    same(receipt.subject, review.subject) && receipt.subject.kind === 'existing_artifact' &&
    same(receipt.authors, review.independenceAuthors) && receipt.executionId === s.executionId &&
    ['adapterDigest','adapterVersion','surface','runtimeVersion'].every(k => receipt[k] === s[k]) &&
    ['requested','selected','emitted','observed'].every(k => same(receipt[k], identity)) &&
    review.independenceAuthors.every(a => a.executionId !== s.executionId &&
      (!review.obligation.crossFamily || (a.family !== s.family && a.provider !== s.provider)));
}

function validObservation(receipt, context, time) {
  const proof = context.observations.find(p => p.receiptId === receipt.id);
  return proof && knownIdentity(proof.identity) && proof.receiptDigest === digest(receipt) && proof.reference === receipt.observationRef &&
    proof.issuer === receipt.issuer && proof.executionId === receipt.executionId &&
    same(proof.identity, receipt.observed) && proof.resultDigest === receipt.resultDigest &&
    Date.parse(receipt.startedAt) <= Date.parse(receipt.completedAt) && Date.parse(receipt.completedAt) <= time &&
    Date.parse(receipt.completedAt) <= Date.parse(proof.observedAt) && Date.parse(proof.observedAt) <= time &&
    time < Date.parse(receipt.expiresAt) && time < Date.parse(proof.expiresAt);
}

function budgetProblem(plan, receipts, context, time) {
  const b = context.budget, prior = plan.budget;
  if (!prior || dimensions.some(k => b.ceiling[k] > plan.appliedBudgetLimits[k] || b.consumed[k] < prior.consumed[k])) return true;
  for (const [counter, maximum] of [['repairRounds','maxRepairRounds'],['noProgress','maxNoProgress'],['similarFailures','maxSimilarFailures']]) {
    if (b[counter] < prior[counter] || b[counter] >= context.limits[maximum]) return true;
  }
  return time >= Date.parse(b.deadline) || Date.parse(b.deadline) > Date.parse(prior.deadline) ||
    dimensions.some(k => receipts.reduce((sum, r) => sum + r.usage[k], b.consumed[k]) > b.ceiling[k]);
}

/** Validate supplied completion declarations against authenticated controller inputs.
 * This does not authenticate issuers, fetch outputs, reserve budget or update replay state. */
export function validateReviewCompletions({plan, receipts, trustedContext, now} = {}) {
  if (!validateV2('receipt', plan).valid || plan.status !== 'planned' ||
      !validateV2('reviewCompletionContext', trustedContext).valid || !Array.isArray(receipts) ||
      receipts.some(r => !validateV2('reviewCompletion', r).valid) ||
      typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now) ||
      !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now.replace('Z','.000Z')) return blocked('invalid_input');
  const expected = trustedContext.expected, time = Date.parse(now);
  if (expected.planDigest !== digest(plan) || expected.repoId !== plan.binding.repoId ||
      expected.baseSha !== plan.binding.baseSha || expected.headSha !== plan.binding.sourceSha ||
      ['artifactDigest','diffDigest','policyDigest','catalogDigest','contextDigest'].some(k => expected[k] !== plan[k])) return blocked('stale_plan');
  if (receipts.length !== plan.reviewPlans.length || new Set(receipts.map(r => r.slotId)).size !== receipts.length ||
      ['id','resultDigest','executionId'].some(k => new Set(receipts.map(r => r[k])).size !== receipts.length) ||
      new Set(trustedContext.observations.map(p => p.receiptId)).size !== trustedContext.observations.length) return blocked('duplicate_or_missing_review');
  for (const r of receipts) {
    if (trustedContext.usedReceiptIds.includes(r.id) || trustedContext.usedResultDigests.includes(r.resultDigest)) return blocked('replayed_review');
    if (!receiptMatchesPlan(r, plan, expected)) return blocked('review_binding_mismatch');
    if (!validObservation(r, trustedContext, time)) return blocked('unconfirmed_observation');
    if (r.verdict !== 'pass' || r.findings.some(f => f.actionable && f.disposition !== 'resolved') ||
        r.tests.some(t => t.status !== 'pass' || t.headSha !== expected.headSha)) return blocked('review_not_passed');
  }
  if (budgetProblem(plan, receipts, trustedContext, time)) return blocked('budget_exhausted');
  return Object.freeze({status:'accepted', reason:'authenticated_declarations_consistent', acceptedReceiptIds:receipts.map(r=>r.id)});
}
