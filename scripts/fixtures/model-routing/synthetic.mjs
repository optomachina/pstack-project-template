// Frozen fictional records. No live provider, runtime or entitlement claims.
import { digest, resolveRoutingV2 } from '../../lib/model-routing.mjs';
export const now = '2026-10-17T12:00:00Z';
const issuedAt = '2026-10-17T11:00:00Z', expiresAt = '2026-10-18T00:00:00Z';
export function rebind(input) {
  const { policy: p, catalog: c, trustedContext: t, request: r } = input;
  p.catalogDigest = digest(c); t.catalogDigest = p.catalogDigest;
  t.policyDigest = digest(p);
  for (const key of ['projectId','repoId','sourceSha','baseSha','unitId','attemptId','ownerId','policyDigest','reviewPolicyDigest','catalogDigest','role','risk']) r[key] = t[key];
  for (const proof of t.evidence) {
    if (proof.kind === 'budget') proof.digest = digest(t.budget);
    else if (proof.kind === 'service') proof.digest = digest(t.reviews.find(x => x.id === proof.scope));
    else proof.digest = digest(c.entries.find(x => x.id === proof.scope));
  }
  if (input.override) {
    input.override.expectedPolicyDigest = t.policyDigest;
    t.overrideAuthorizations[0].digest = digest(input.override);
  }
  return input;
}
export function fixture() {
  const entry = (id, provider, family, model) => ({ id, provider, family, model, surface:'synthetic-cli', runtimeVersion:'1.0.0', adapterVersion:'1.0.0', adapterDigest:'b'.repeat(64), parameter:'native.effort', supportedEfforts:['low','high'], omissionSupported:true, mappings:[{id:'careful-v1',version:'1',intent:'careful',emitted:'high'}],capabilities:['code'],agentCount:1,effectiveObservability:'unobservable',issuedAt,expiresAt });
  const entries = [entry('writer-entry','fake-a','family-a','fake-model-1'),entry('review-entry','fake-b','family-b','fake-review-1')];
  const profiles = [
    {id:'primary',entryId:'writer-entry',effort:{kind:'explicit',value:'high'},requiredCapabilities:['code'],reservation:{tokens:100,wallTimeMs:1000,attempts:1}},
    {id:'alternate',entryId:'writer-entry',effort:{kind:'explicit',value:'low'},requiredCapabilities:['code'],reservation:{tokens:50,wallTimeMs:500,attempts:1}},
    {id:'review',entryId:'review-entry',effort:{kind:'explicit',value:'high'},requiredCapabilities:['code'],reservation:{tokens:100,wallTimeMs:1000,attempts:1}},
  ];
  const catalog = {schema:'model-routing.catalog.v1',revision:'catalog-1',issuedAt,expiresAt,entries};
  const policy = {schema:'model-routing.policy.v1',revision:'policy-1',projectId:'project',repoId:'repo',reviewPolicyDigest:'c'.repeat(64),catalogDigest:'0'.repeat(64),issuedAt,expiresAt,billing:'subscription_included',maxEvidenceAgeSeconds:7200,allowedActions:['edit'],profiles,rules:[{id:'implement-high',role:'implement',risk:'high',candidates:['primary','alternate'],allowOmission:false,approvedMappings:['careful-v1']}],overrideEnvelope:{enabled:true,profiles:['primary','alternate']},maxRepairRounds:2,maxNoProgress:2,maxSimilarFailures:3};
  const trustedContext = {schema:'model-routing.context.v1',projectId:'project',repoId:'repo',sourceSha:'d'.repeat(40),baseSha:'e'.repeat(40),unitId:'unit',attemptId:'attempt-1',ownerId:'owner',policyDigest:'0'.repeat(64),reviewPolicyDigest:policy.reviewPolicyDigest,catalogDigest:'0'.repeat(64),role:'implement',risk:'high',snapshotRevision:'snapshot-1',writer:{executionId:'author-1',provider:'fake-a',family:'family-a'},existingContributors:[],execution:{executionId:'worker-1',provider:'fake-a',family:'family-a'},requiredCapabilities:['code'],allowedActions:['edit'],reviews:[{id:'named-review',kind:'model',subject:{kind:'planned_output',unitId:'unit',attemptId:'attempt-1'},provider:'fake-b',model:'fake-review-1',family:'family-b',explicitEffort:'high',independent:true,crossFamily:true,candidates:['review']}],budget:{ceiling:{tokens:1000,wallTimeMs:10000,attempts:5},consumed:{tokens:10,wallTimeMs:100,attempts:1},repairRounds:0,noProgress:0,similarFailures:0,deadline:expiresAt,evidenceRef:'budget-proof'},evidence:[],overrideAuthorizations:[]};
  const proof = (kind,scope,reference,executionId) => ({kind,scope,reference,executionId,issuer:'synthetic-controller',observedAt:issuedAt,expiresAt,digest:'0'.repeat(64),status:'confirmed',billing:kind === 'entitlement' ? 'subscription_included' : 'none'});
  for (const e of entries) for (const kind of ['capability','availability','entitlement']) trustedContext.evidence.push(proof(kind,e.id,`${e.id}-${kind}`,e.id === 'writer-entry' ? 'worker-1':'reviewer-1'));
  trustedContext.evidence.push(proof('budget','unit','budget-proof','controller-1'));
  const request = {schema:'model-routing.request.v1',mode:'new',requestedProfile:'primary',requiredCapabilities:['code'],actions:['edit']};
  return rebind({policy,catalog,trustedContext,request,now});
}
export function withOverride(input = fixture()) {
  input.override = {schema:'model-routing.override.v1',id:'override-1',projectId:'project',repoId:'repo',role:'implement',risk:'high',ownerId:'owner',authorizationRef:'auth-1',issuedAt,expiresAt,expectedPolicyDigest:'0'.repeat(64),reason:'bounded-switch',candidates:['alternate'],budgetLimits:{tokens:500,wallTimeMs:5000,attempts:4}};
  input.trustedContext.overrideAuthorizations = [{id:'override-1',digest:'0'.repeat(64),authorizationRef:'auth-1',issuer:'synthetic-controller',observedAt:issuedAt,expiresAt,state:'unused'}];
  input.request.requestedProfile = null;
  return rebind(input);
}

export const correctnessCoverage = ['contracts','invalid-input','tests','documentation','regressions'];
export const deepCoverage = ['security','data-money','architecture','concurrency','gate-integrity','sensitive-files','adversarial-evidence'];
export function rebindV2(f) {
  f.policy.catalogDigest = digest(f.catalog);
  f.trustedContext.catalogDigest = digest(f.catalog);
  f.trustedContext.policyDigest = digest(f.policy);
  for (const k of ['projectId','repoId','sourceSha','baseSha','unitId','attemptId','ownerId','policyDigest','reviewPolicyDigest','catalogDigest','role','risk']) f.request[k] = f.trustedContext[k];
  for (const e of f.trustedContext.evidence) e.digest = e.kind === 'budget'
    ? digest(f.trustedContext.budget) : digest(f.catalog.entries.find(c => c.id === e.scope));
  return f;
}
export function fixtureV2() {
  const f = fixture(), t = f.trustedContext;
  f.policy.schema = 'model-routing.policy.v2'; f.catalog.schema = 'model-routing.catalog.v2';
  t.schema = 'model-routing.context.v2'; delete t.reviews;
  t.reviewSubject = {kind:'existing_artifact',sourceSha:t.sourceSha,artifactDigest:'a'.repeat(64)};
  t.artifactDigest = t.reviewSubject.artifactDigest; t.diffDigest = 'b'.repeat(64);
  for (const e of f.catalog.entries) { e.reviewCapabilities=['correctness','deep']; e.reviewCoverage=[...correctnessCoverage,...deepCoverage]; }
  const reviewEntry = f.catalog.entries[1], templateProofs = t.evidence.filter(e=>e.scope===reviewEntry.id);
  for (const [id, model, executionId, provider, family] of [
    ['deep-entry','fake-deep-1','deep-1','fake-b','family-b'],
    ['astra-c-entry','fake-astra-1','astra-c-1','fake-c','family-c'],
    ['astra-d-entry','fake-astra-1','astra-d-1','fake-c','family-c'],
  ]) {
    const entry = {...structuredClone(reviewEntry),id,model,provider,family};
    if (id.startsWith('astra')) entry.supportedEfforts.push('xhigh');
    f.catalog.entries.push(entry);
    f.policy.profiles.push({...structuredClone(f.policy.profiles[2]),id:id.replace('-entry',''),entryId:id,effort:{kind:'explicit',value:id.startsWith('astra')?'xhigh':'high'}});
    t.evidence.push(...templateProofs.map(e=>({...e,scope:id,reference:id+'-'+e.kind,executionId})));
  }
  for(const e of t.evidence)e.failure=null;
  const slot = (id,primary,fallback,coverage) => ({id,independent:true,crossFamily:false,binding:{kind:'capability',capability:id,coverage,primaryProfiles:[primary],fallbackProfiles:[fallback],fallbackWhen:'confirmed_unavailable'}});
  const correctness=slot('correctness','review','astra-c',correctnessCoverage);
  const deep=slot('deep','deep','astra-d',deepCoverage);
  f.policy.reviewRules=[{risk:'low',slots:[]},{risk:'moderate',slots:[structuredClone(correctness)]},{risk:'high',slots:[correctness,deep]}];
  return rebindV2(f);
}
export function unavailableV2(f, entryId) {
  const e=f.trustedContext.evidence.find(x=>x.scope===entryId&&x.kind==='availability');
  e.status='unavailable';e.failure={code:'quota_exhausted',resetAt:null};return f;
}

export function completionFixture(f=fixtureV2()) {
  const plan=resolveRoutingV2(f);
  if(plan.status!=='planned')throw new Error('fixture plan blocked: '+plan.reason);
  const expected={repoId:plan.binding.repoId,baseSha:plan.binding.baseSha,headSha:plan.binding.sourceSha,
    artifactDigest:plan.artifactDigest,diffDigest:plan.diffDigest,policyDigest:plan.policyDigest,catalogDigest:plan.catalogDigest,
    contextDigest:plan.contextDigest,planDigest:digest(plan)};
  const receipts=plan.reviewPlans.map((r,i)=>{
    const s=r.selection,identity={provider:s.provider,model:s.model,family:s.family,effort:s.plannedEmission.value};
    return {schema:'model-routing.review-completion.v1',id:'receipt-'+i,...expected,
      policyRevision:plan.policyRevision,catalogRevision:plan.catalogRevision,slotId:r.obligationId,
      subject:r.subject,authors:r.independenceAuthors,executionId:s.executionId,adapterDigest:s.adapterDigest,
      adapterVersion:s.adapterVersion,surface:s.surface,runtimeVersion:s.runtimeVersion,
      requested:{...identity},selected:{...identity},emitted:{...identity},observed:{...identity},
      observationRef:'observation-'+i,issuer:'synthetic-controller',startedAt:'2026-10-17T12:00:00Z',
      completedAt:'2026-10-17T12:01:00Z',expiresAt:'2026-10-18T00:00:00Z',resultDigest:String(i+1).repeat(64),
      verdict:'pass',findings:[],tests:[{id:'offline-contract',headSha:expected.headSha,digest:'8'.repeat(64),status:'pass'}],
      usage:{tokens:50,wallTimeMs:1000,attempts:1}};
  });
  const trustedContext={schema:'model-routing.review-completion-context.v1',expected,
    observations:receipts.map(r=>({receiptId:r.id,receiptDigest:digest(r),issuer:r.issuer,reference:r.observationRef,
      observedAt:r.completedAt,expiresAt:r.expiresAt,executionId:r.executionId,identity:r.observed,resultDigest:r.resultDigest})),
    usedReceiptIds:[],usedResultDigests:[],budget:structuredClone(plan.budget),
    limits:{maxRepairRounds:2,maxNoProgress:2,maxSimilarFailures:3}};
  return {plan,receipts,trustedContext,now:'2026-10-17T12:02:00Z'};
}
