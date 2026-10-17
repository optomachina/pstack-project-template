import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from './model-routing.mjs';
import {loadBaseReviewPolicy,matchesBaseReviewPolicy,validateReviewTransition} from './review-policy.mjs';
import {fixtureV2,rebindV2,completionFixture} from '../fixtures/model-routing/synthetic.mjs';
import {runReviewGateV2,runReviewGate} from '../review-gate.mjs';
const repository=fileURLToPath(new URL('../..',import.meta.url));
const roots=[];after(()=>roots.forEach(p=>rmSync(p,{recursive:true,force:true})));
const git=(root,...args)=>execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false',...args],{cwd:root,encoding:'utf8'}).trim();
const write=(root,path,value)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value);};
const files=['scripts/review-gate.mjs','scripts/check-pr-body.mjs','scripts/lib/review-policy.mjs','scripts/lib/model-routing.mjs','scripts/lib/review-completion.mjs','scripts/lib/sensitive-paths.mjs','scripts/lib/pstack-config.mjs','scripts/jev-client.mjs','docs/sensitive-paths.json','pstack.config.json'];
function policyFor(f) {
  const ids=[...new Set(f.policy.reviewRules.flatMap(r=>r.slots.flatMap(s=>[...s.binding.primaryProfiles,...s.binding.fallbackProfiles])))];
  const bindings=ids.map(profileId=>{
    const p=f.policy.profiles.find(p=>p.id===profileId),e=f.catalog.entries.find(e=>e.id===p.entryId);
    return {profileId,...Object.fromEntries(['provider','model','family','surface','parameter'].map(k=>[k,e[k]])),effort:p.effort.value};
  });
  return {schema:'review-policy.v1',version:1,revision:'synthetic-policy',enabled:true,ownerHandle:'@synthetic-owner',reviewRules:f.policy.reviewRules,bindings,legacyRequirementPolicy:'preserve-until-transition'};
}
function sourceReviewFor(baseSha,headSha,patchDigest) {
  const f=fixtureV2();f.trustedContext.sourceSha=headSha;f.trustedContext.baseSha=baseSha;f.trustedContext.reviewSubject.sourceSha=headSha;f.trustedContext.diffDigest=patchDigest;
  for(const e of f.catalog.entries.filter(e=>['review-entry','deep-entry'].includes(e.id))){e.provider='openai';e.family='openai';e.model='gpt-6-astra';e.surface='gpt-subscription-tool';e.parameter='model_reasoning_effort';e.supportedEfforts.push('xhigh');}
  for(const p of f.policy.profiles.filter(p=>['review','deep'].includes(p.id)))p.effort.value='xhigh';
  return completionFixture(rebindV2(f));
}
function governedFixture(submoduleIgnore=null) {
  const root=mkdtempSync(join(tmpdir(),'review-v2-'));roots.push(root);git(root,'init','-q');
  write(root,'README.md','synthetic baseline\n');git(root,'add','.');git(root,'commit','-qm','old policy');const baseSha=git(root,'rev-parse','HEAD');
  const f=fixtureV2(),policy=policyFor(f);
  for(const file of files)write(root,file,readFileSync(join(repository,file)));
  write(root,'docs/review-policy.json',JSON.stringify(policy));
  if(submoduleIgnore){
    write(root,'.gitmodules','[submodule "shared"]\n path = infra/shared\n url = ./synthetic\n ignore = '+submoduleIgnore+'\n');
  }
  git(root,'add','.');
  if(submoduleIgnore)git(root,'update-index','--add','--cacheinfo','160000,'+baseSha+',infra/shared');
  git(root,'commit','-qm','adoption candidate');
  const headSha=git(root,'rev-parse','HEAD'),patchDigest=digest(execFileSync('git',['diff','--binary','--no-ext-diff','--ignore-submodules=none',baseSha,headSha],{cwd:root,encoding:'utf8'}));
  const sourceReview=sourceReviewFor(baseSha,headSha,patchDigest);
  const transition={schema:'review-transition.v1',repoId:'repo',baseSha,headSha,patchDigest,oldPolicyDigest:'c'.repeat(64),newPolicyDigest:digest(policy),allowedBindings:policy.bindings,
    predicates:{executionIndependence:true,preserveExplicitDiversity:true,distinctSlots:true},sourceReviewDigest:digest(sourceReview),authorizationRef:'owner-transition',issuedAt:'2026-10-17T12:01:00Z',expiresAt:'2026-10-18T00:00:00Z'};
  const authorization={schema:'review-transition-authorization.v1',issuer:'synthetic-authority',ownerHandle:policy.ownerHandle,reference:transition.authorizationRef,transitionDigest:digest(transition),sourceReviewDigest:transition.sourceReviewDigest,observedAt:transition.issuedAt,expiresAt:transition.expiresAt};
  const expected=Object.fromEntries(['repoId','baseSha','headSha','patchDigest','oldPolicyDigest','newPolicyDigest','sourceReviewDigest'].map(k=>[k,transition[k]]));
  f.trustedContext.sourceSha=headSha;f.trustedContext.baseSha=headSha;f.trustedContext.reviewSubject.sourceSha=headSha;
  f.trustedContext.artifactDigest=digest({treeSha:git(root,'rev-parse',`${headSha}^{tree}`)});
  f.trustedContext.reviewSubject.artifactDigest=f.trustedContext.artifactDigest;
  f.trustedContext.diffDigest=digest('');
  f.policy.reviewPolicyDigest=digest(policy);f.trustedContext.reviewPolicyDigest=digest(policy);rebindV2(f);
  return {root,baseRef:headSha,files:['scripts/review-gate.mjs'],routingInput:f,adoption:{transition,authorization,expected,sourceReview},completion:completionFixture(f),policy,now:'2026-10-17T12:02:00Z'};
}
test('base-governed gate preserves risk slots and accepts only an exact authenticated transition plus completions',async()=>{
  const x=governedFixture();assert.equal(validateReviewTransition({...x.adoption,policy:x.policy,now:x.now}),true);
  const d=await runReviewGateV2(x);assert.equal(d.status,'consistent',JSON.stringify(d));assert.equal(d.risk,'risky');assert.equal(d.obligations.length,2);assert.equal(d.auto_merge.eligible,false);assert.equal(d.review_tier,undefined);
});
test('head-side policy edits cannot change base obligations',async()=>{
  const x=governedFixture();write(x.root,'docs/review-policy.json','{"enabled":true,"reviewRules":[]}');
  assert.equal(loadBaseReviewPolicy(x).digest,digest(x.policy));assert.equal((await runReviewGateV2(x)).status,'consistent');
});
for(const [name,mutate] of Object.entries({
  noAuthority:x=>x.adoption=null,
  booleanBypass:x=>x.adoption={approved:true},
  wrongOwner:x=>x.adoption.authorization.ownerHandle='@imposter',
  stalePatch:x=>x.adoption.expected.patchDigest='0'.repeat(64),
  staleHead:x=>x.adoption.expected.headSha='0'.repeat(40),
  noIndependentReview:x=>delete x.adoption.sourceReview,
  unavailableObservedIdentity:x=>{x.adoption.sourceReview.receipts[0].observed.model='unknown';},
  expiredAuthority:x=>x.adoption.authorization.expiresAt=x.now,
  removedDiversity:x=>x.adoption.transition.predicates.preserveExplicitDiversity=false,
  weakerGraph:x=>{x.routingInput.policy.reviewRules[2].slots.pop();rebindV2(x.routingInput);},
  unlistedModel:x=>{x.routingInput.catalog.entries[1].model='unapproved';rebindV2(x.routingInput);},
  lowerRisk:x=>{x.routingInput.trustedContext.risk='low';rebindV2(x.routingInput);},
  noCompletion:x=>x.completion=null,
  staleCompletion:x=>x.completion.trustedContext.expected.headSha='0'.repeat(40),
  staleRoutingHead:x=>{x.routingInput.trustedContext.sourceSha='0'.repeat(40);rebindV2(x.routingInput);},
  changedDiff:x=>{x.routingInput.trustedContext.diffDigest='0'.repeat(64);},
  missingBase:x=>x.baseRef='0'.repeat(40),
}))test('v2 adoption/gate rejects '+name,async()=>{const x=governedFixture();mutate(x);assert.equal((await runReviewGateV2(x)).status,'blocked');});
test('disabled seed has no owner or implicit activation',()=>{
  const seed=JSON.parse(readFileSync(join(repository,'docs/review-policy.json')));assert.equal(seed.enabled,false);assert.equal(seed.ownerHandle,null);
  const x=governedFixture();assert.equal(matchesBaseReviewPolicy(seed,x.routingInput),false);
});

test('an adopted v2 base cannot silently downgrade through the legacy gate',async()=>{
  const x=governedFixture();let asks=0;
  const d=await runReviewGate({...x,ask:async()=>{asks++;throw Error('must not call provider');}});
  assert.equal(d.reason,'adopted_policy_requires_v2');assert.equal(asks,0);
});
test('unknown committed policy version blocks legacy parsing',async()=>{
  const x=governedFixture();const policy={...x.policy,version:99};write(x.root,'docs/review-policy.json',JSON.stringify(policy));git(x.root,'add','.');git(x.root,'commit','-qm','invalid version');
  const d=await runReviewGate({...x,baseRef:'HEAD',useJev:false});assert.equal(d.reason,'invalid_base_review_policy');
});
test('executing head code cannot replace the required base bundle',()=>{
  const x=governedFixture();write(x.root,'scripts/lib/review-completion.mjs','// different approved bytes\n');git(x.root,'add','.');git(x.root,'commit','-qm','different code');
  assert.throws(()=>loadBaseReviewPolicy({...x,baseRef:'HEAD'}),/base_code_mismatch/);
});
test('eligible bindings cannot be expanded by the routing policy',()=>{
  const x=governedFixture();x.routingInput.catalog.entries[1].model='unapproved';rebindV2(x.routingInput);
  assert.equal(matchesBaseReviewPolicy(x.policy,x.routingInput),false);
});
test('routing graph cannot replace base independence predicates',()=>{
  const x=governedFixture(), base=structuredClone(x.policy);
  x.routingInput.policy.reviewRules[2].slots[0].crossFamily=true;rebindV2(x.routingInput);
  assert.equal(matchesBaseReviewPolicy(base,x.routingInput),false);
});

function bindCurrentRevision(x) {
  const f=x.routingInput,t=f.trustedContext,head=git(x.root,'rev-parse','HEAD');
  t.sourceSha=head;t.reviewSubject.sourceSha=head;
  t.artifactDigest=digest({treeSha:git(x.root,'rev-parse',`${head}^{tree}`)});t.reviewSubject.artifactDigest=t.artifactDigest;
  t.diffDigest=digest(execFileSync('git',['diff','--binary','--no-ext-diff','--ignore-submodules=none',x.baseRef,head],{cwd:x.root,encoding:'utf8'}));
  rebindV2(f);x.completion=completionFixture(f);
}
test('TR1 committed workflow cannot be hidden behind caller README and low risk',async()=>{
  const x=governedFixture();write(x.root,'.github/workflows/security.yml','name: security\n');git(x.root,'add','.');git(x.root,'commit','-qm','security change');
  x.routingInput.trustedContext.risk='low';x.routingInput.policy.rules[0].risk='low';bindCurrentRevision(x);
  x.files=['README.md'];x.changedLines=0;x.gate={status:'accepted',choice:'low',confidence:0.99};
  const d=await runReviewGateV2(x);assert.equal(d.auto_merge.eligible,false);assert.equal(d.status,'blocked');assert.equal(d.risk,'risky');assert.equal(d.obligations.length,2);
});
test('TR1 genuine sensitive review derives file inventory and size from bound revisions',async()=>{
  const x=governedFixture();write(x.root,'.github/workflows/security.yml','name: security\n');git(x.root,'add','.');git(x.root,'commit','-qm','security change');bindCurrentRevision(x);
  x.files=['README.md'];x.changedLines=0;
  const d=await runReviewGateV2(x);assert.equal(d.status,'consistent');assert.equal(d.risk,'risky');
  assert.ok(d.sensitive.files.some(f=>f.path==='.github/workflows/security.yml'));assert.equal(d.pr_size.changed_lines,1);
});
for(const action of ['delete','rename'])test('TR1 derives sensitive '+action+' source paths',async()=>{
  const x=governedFixture();
  if(action==='delete')git(x.root,'rm','scripts/jev-client.mjs');else git(x.root,'mv','scripts/jev-client.mjs','docs/retired-client.md');
  git(x.root,'commit','-qm',action+' sensitive source');bindCurrentRevision(x);x.files=['docs/retired-client.md'];x.changedLines=0;
  const d=await runReviewGateV2(x);assert.equal(d.status,'consistent');assert.equal(d.risk,'risky');
  assert.ok(d.sensitive.files.some(f=>f.path==='scripts/jev-client.mjs'));assert.equal(d.files,action==='rename'?2:1);assert.ok(d.pr_size.changed_lines>0);
});
test('TR1 source review cannot authorize another repository with the same Git history',()=>{
  const x=governedFixture();x.adoption.transition.repoId='other-repo';x.adoption.expected.repoId='other-repo';x.adoption.authorization.transitionDigest=digest(x.adoption.transition);
  assert.equal(validateReviewTransition({...x.adoption,policy:x.policy,now:x.now}),false);
});
test('TR1 routing repository must equal the authenticated adoption target',async()=>{
  const x=governedFixture();x.routingInput.policy.repoId='other-repo';x.routingInput.trustedContext.repoId='other-repo';rebindV2(x.routingInput);x.completion=completionFixture(x.routingInput);
  assert.equal((await runReviewGateV2(x)).status,'blocked');
});

for(const ignore of ['all','none','local-all'])test('TR2 committed gitlink remains sensitive with ignore='+ignore,async()=>{
  const x=governedFixture(ignore==='local-all'?'none':ignore);
  if(ignore==='local-all')git(x.root,'config','submodule.shared.ignore','all');
  git(x.root,'update-index','--cacheinfo','160000,'+x.baseRef+',infra/shared');
  write(x.root,'README.md','synthetic baseline\nnew docs\n');git(x.root,'add','README.md');git(x.root,'commit','-qm','update gitlink and docs');
  x.routingInput.trustedContext.risk='low';x.routingInput.policy.rules[0].risk='low';bindCurrentRevision(x);
  x.files=['README.md'];x.changedLines=0;x.gate={status:'accepted',choice:'low',confidence:0.99};
  let d=await runReviewGateV2(x);assert.equal(d.risk,'risky');assert.equal(d.status,'blocked');assert.equal(d.auto_merge.eligible,false);
  assert.equal(d.obligations.length,2);assert.ok(d.sensitive.files.some(f=>f.path==='infra/shared'));assert.equal(d.files,2);assert.equal(d.pr_size.changed_lines,3);
  x.routingInput.trustedContext.risk='high';x.routingInput.policy.rules[0].risk='high';bindCurrentRevision(x);
  d=await runReviewGateV2(x);assert.equal(d.status,'consistent');assert.equal(d.auto_merge.eligible,false);
});
