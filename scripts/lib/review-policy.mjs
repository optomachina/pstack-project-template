import {readFileSync} from 'node:fs';
import {canonicalJSON,digest,validateV2} from './model-routing.mjs';
import {readRefFile} from './sensitive-paths.mjs';
import {validateReviewCompletions} from './review-completion.mjs';
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
export const REVIEW_POLICY_PATH='docs/review-policy.json';
const BASE_CODE=['scripts/review-gate.mjs','scripts/check-pr-body.mjs','scripts/lib/review-policy.mjs',
  'scripts/lib/model-routing.mjs','scripts/lib/review-completion.mjs','scripts/lib/sensitive-paths.mjs',
  'scripts/lib/pstack-config.mjs','scripts/jev-client.mjs'];

/** Load only committed base policy/code; never bootstrap by substituting head files. */
export function loadBaseReviewPolicy({root,baseRef}) {
  if(!baseRef)throw Error('base_revision_required');
  for(const file of BASE_CODE){
    const expected=readRefFile(root,baseRef,file);
    const actual=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
    if(expected===null||actual!==expected)throw Error('base_code_mismatch');
  }
  const text=readRefFile(root,baseRef,REVIEW_POLICY_PATH);
  if(text===null)throw Error('base_review_policy_missing');
  const policy=JSON.parse(text);
  if(!validateV2('reviewPolicy',policy).valid)throw Error('invalid_review_policy');
  if(!policy.enabled||policy.ownerHandle===null)throw Error('review_policy_not_adopted');
  return {policy,digest:digest(policy),source:'base'};
}

/** Check an authenticated owner transition against exact, externally established patch bindings. */
export function validateReviewTransition({transition,authorization,expected,policy,sourceReview,now}) {
  if(!validateV2('reviewTransition',transition).valid||!validateV2('reviewTransitionAuthorization',authorization).valid||
    !validateV2('reviewPolicy',policy).valid)return false;
  if(!expected||Object.keys(expected).sort().join(',')!==['repoId','baseSha','headSha','patchDigest','oldPolicyDigest','newPolicyDigest','sourceReviewDigest'].sort().join(','))return false;
  if(Object.keys(expected).some(k=>transition[k]!==expected[k])||transition.newPolicyDigest!==digest(policy)||
    !same(transition.allowedBindings,policy.bindings)||authorization.ownerHandle!==policy.ownerHandle||
    authorization.reference!==transition.authorizationRef||authorization.transitionDigest!==digest(transition)||
    authorization.sourceReviewDigest!==transition.sourceReviewDigest)return false;
  if(!sourceReview||transition.sourceReviewDigest!==digest(sourceReview)||
    validateReviewCompletions({...sourceReview,now}).status!=='accepted'||
    sourceReview.plan.binding.repoId!==transition.repoId||
    sourceReview.plan.binding.sourceSha!==transition.headSha||sourceReview.plan.binding.baseSha!==transition.baseSha||
    sourceReview.plan.diffDigest!==transition.patchDigest||
    !sourceReview.receipts.some(r=>r.observed.provider==='openai'&&r.observed.model==='gpt-6-astra'&&
      r.observed.family==='openai'&&r.observed.effort==='xhigh'&&r.surface==='gpt-subscription-tool'))return false;
  const time=Date.parse(now);
  return typeof now==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now)&&Number.isFinite(time)&&
    new Date(time).toISOString()===now.replace('Z','.000Z')&&
    Date.parse(transition.issuedAt)<=time&&time<Date.parse(transition.expiresAt)&&
    Date.parse(authorization.observedAt)<=time&&time<Date.parse(authorization.expiresAt);
}

/** Require the routing policy to retain the base policy's graph and exact eligible bindings. */
export function matchesBaseReviewPolicy(policy,routingInput) {
  if(!routingInput||!validateV2('policy',routingInput.policy).valid||!validateV2('catalog',routingInput.catalog).valid)return false;
  if(routingInput.policy.reviewPolicyDigest!==digest(policy)||!same(routingInput.policy.reviewRules,policy.reviewRules))return false;
  const ids=policy.reviewRules.flatMap(r=>r.slots.flatMap(s=>s.binding.kind==='named'?s.binding.profiles:[...s.binding.primaryProfiles,...s.binding.fallbackProfiles]));
  if(new Set(policy.bindings.map(b=>b.profileId)).size!==policy.bindings.length)return false;
  return ids.every(id=>{
    const binding=policy.bindings.find(b=>b.profileId===id), profile=routingInput.policy.profiles.find(p=>p.id===id);
    const entry=routingInput.catalog.entries.find(e=>e.id===profile?.entryId);
    return binding&&entry&&profile.effort.kind==='explicit'&&profile.effort.value===binding.effort&&
      ['provider','model','family','surface','parameter'].every(k=>entry[k]===binding[k]);
  });
}
