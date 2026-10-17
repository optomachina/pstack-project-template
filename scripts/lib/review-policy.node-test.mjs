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

// Boundary replan: permanent independent reproductions (synthetic authority only).
{


const {readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, existsSync} = await import('node:fs');
const {execFileSync} = await import('node:child_process');
const {resolve, join, dirname} = await import('node:path');
const {fixtureV2, rebindV2, completionFixture} = await import('../fixtures/model-routing/synthetic.mjs');
const {digest, resolveRoutingV2, schemas, schemasV2, validateV2} = await import('./model-routing.mjs');
const {validateReviewCompletions} = await import('./review-completion.mjs');
const {runReviewGateV2} = await import('../review-gate.mjs');
const {runGit} = await import('./sensitive-paths.mjs');

const root = mkdtempSync(join(tmpdir(),'boundary-review-')); roots.push(root);
const source = repository;
const fixtureRoot = join(root, 'synthetic-review-fixtures');
mkdirSync(fixtureRoot, {recursive:true});
const fixtureDir = label => mkdtempSync(join(fixtureRoot, label+'-'));
const write = (dir, name, content) => {
  mkdirSync(dirname(join(dir,name)), {recursive:true});
  writeFileSync(join(dir,name), content);
};
const git = (dir, ...args) => execFileSync('/usr/bin/git', ['-c','user.name=Independent Review Fixture',
  '-c','user.email=review@example.test','-c','commit.gpgsign=false',...args],
  {cwd:dir, encoding:'utf8', stdio:['ignore','pipe','pipe']});
const commit = (dir, label) => {
  git(dir,'add','.'); git(dir,'commit','-qm',label);
  return git(dir,'rev-parse','HEAD').trim();
};
const rawPatch = (dir, base, head, extra=[]) => git(dir,'diff',...extra,
  '--ignore-submodules=none','--binary','--no-ext-diff',base,head);

test('BH control: exact baseline completion and independent schema parity', () => {
  assert.equal(validateReviewCompletions(completionFixture()).status,'accepted');
  let count=0;
  for(const [version, collection] of [['v1',schemas],['v2',schemasV2]]) {
    for(const [name, definition] of Object.entries(collection)) {
      const file=version==='v1'?`${name}.v1`:
        ['policy','context','catalog','receipt'].includes(name)?`${name}.v2`:
          `${name.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}.v1`;
      assert.deepEqual(JSON.parse(readFileSync(join(source,'schemas/model-routing',file+'.schema.json'))),definition);
      count++;
    }
  }
  assert.equal(count,15);
});

for(const [counter, maximum] of [['repairRounds','maxRepairRounds'],
  ['noProgress','maxNoProgress'],['similarFailures','maxSimilarFailures']]) {
  test(`BH F1: completion must preserve the plan policy's stricter ${maximum}`, () => {
    const input=fixtureV2(); input.policy[maximum]=1; rebindV2(input);
    const completion=completionFixture(input);
    completion.trustedContext.budget[counter]=1;
    const observed=validateReviewCompletions(completion);
    // Same state is rejected by planning, but accepted at completion.
    input.trustedContext.budget[counter]=1; rebindV2(input);
    assert.equal(resolveRoutingV2(input).reason,'budget_exhausted');
    writeFileSync(join(root,`finding-budget-${counter}.json`),JSON.stringify({
      policyLimit:1,completionLimit:completion.trustedContext.limits[maximum],observed,completion
    },null,2)+'\n');
    assert.equal(observed.status,'blocked',JSON.stringify(observed));
  });
  test(`BH control: equal ${maximum} still blocks exhausted completion`, () => {
    const input=fixtureV2(); input.policy[maximum]=1; rebindV2(input);
    const completion=completionFixture(input);
    completion.trustedContext.budget[counter]=1;
    completion.trustedContext.limits[maximum]=1;
    assert.equal(validateReviewCompletions(completion).reason,'budget_exhausted');
  });
}

function policyFor(input) {
  const ids=[...new Set(input.policy.reviewRules.flatMap(rule=>rule.slots.flatMap(slot=>
    [...slot.binding.primaryProfiles,...slot.binding.fallbackProfiles])))];
  return {schema:'review-policy.v1',version:1,revision:'independent-fixture',enabled:true,
    ownerHandle:'@synthetic-owner',reviewRules:input.policy.reviewRules,
    bindings:ids.map(profileId=>{
      const profile=input.policy.profiles.find(p=>p.id===profileId);
      const entry=input.catalog.entries.find(e=>e.id===profile.entryId);
      return {profileId,effort:profile.effort.value,
        ...Object.fromEntries(['provider','model','family','surface','parameter'].map(k=>[k,entry[k]]))};
    }),legacyRequirementPolicy:'preserve-until-transition'};
}

// These synthetic declarations exercise the pure API; they are NOT real
// provider observations, authorization records, or a policy activation.
function governedGitFixture(useTextconv=true, convertedAdoption=false) {
  const dir=fixtureDir('textconv'); git(dir,'init','-q');
  if(useTextconv)git(dir,'config','diff.mask.textconv','true');
  write(dir,'.gitattributes','*.mjs diff=mask\n');
  write(dir,'README.md','synthetic review fixture\n');
  const old=commit(dir,'synthetic baseline');
  const input=fixtureV2(); const policy=policyFor(input);
  for(const file of ['scripts/review-gate.mjs','scripts/check-pr-body.mjs',
    'scripts/lib/review-policy.mjs','scripts/lib/model-routing.mjs',
    'scripts/lib/review-completion.mjs','scripts/lib/sensitive-paths.mjs',
    'scripts/lib/pstack-config.mjs','scripts/jev-client.mjs','docs/sensitive-paths.json','pstack.config.json']) {
    write(dir,file,readFileSync(join(source,file)));
  }
  write(dir,'docs/review-policy.json',JSON.stringify(policy));
  write(dir,'scripts/lib/example.mjs','export const safe = true;\n');
  const adopted=commit(dir,'synthetic adoption fixture');
  const adoptionPatch=rawPatch(dir,old,adopted,convertedAdoption?[]:['--no-textconv']);
  const reviewInput=fixtureV2();
  reviewInput.trustedContext.baseSha=old;reviewInput.trustedContext.sourceSha=adopted;
  reviewInput.trustedContext.reviewSubject.sourceSha=adopted;
  reviewInput.trustedContext.artifactDigest=digest({treeSha:git(dir,'rev-parse',`${adopted}^{tree}`).trim()});
  reviewInput.trustedContext.reviewSubject.artifactDigest=reviewInput.trustedContext.artifactDigest;
  reviewInput.trustedContext.diffDigest=digest(adoptionPatch);
  for(const entry of reviewInput.catalog.entries.filter(e=>['review-entry','deep-entry'].includes(e.id))) {
    Object.assign(entry,{provider:'openai',family:'openai',model:'gpt-6-astra',surface:'gpt-subscription-tool'});
    entry.supportedEfforts.push('xhigh');
  }
  for(const profile of reviewInput.policy.profiles.filter(p=>['review','deep'].includes(p.id)))profile.effort.value='xhigh';
  const sourceReview=completionFixture(rebindV2(reviewInput));
  const transition={schema:'review-transition.v1',repoId:'repo',baseSha:old,headSha:adopted,
    patchDigest:digest(adoptionPatch),oldPolicyDigest:'c'.repeat(64),newPolicyDigest:digest(policy),
    allowedBindings:policy.bindings,predicates:{executionIndependence:true,preserveExplicitDiversity:true,distinctSlots:true},
    sourceReviewDigest:digest(sourceReview),authorizationRef:'synthetic-authorization',
    issuedAt:'2026-10-17T12:01:00Z',expiresAt:'2026-10-18T00:00:00Z'};
  const authorization={schema:'review-transition-authorization.v1',issuer:'synthetic-authority',
    ownerHandle:policy.ownerHandle,reference:transition.authorizationRef,transitionDigest:digest(transition),
    sourceReviewDigest:transition.sourceReviewDigest,observedAt:transition.issuedAt,expiresAt:transition.expiresAt};
  const expected=Object.fromEntries(['repoId','baseSha','headSha','patchDigest','oldPolicyDigest','newPolicyDigest','sourceReviewDigest'].map(k=>[k,transition[k]]));
  write(dir,'scripts/lib/example.mjs','export const unsafe = true;\n');
  const head=commit(dir,'synthetic hidden source change');
  const context=input.trustedContext;
  context.sourceSha=head;context.baseSha=adopted;context.reviewSubject.sourceSha=head;
  context.artifactDigest=digest({treeSha:git(dir,'rev-parse',`${head}^{tree}`).trim()});
  context.reviewSubject.artifactDigest=context.artifactDigest;
  context.diffDigest=digest(rawPatch(dir,adopted,head,['--no-textconv']));
  input.policy.reviewPolicyDigest=digest(policy);context.reviewPolicyDigest=digest(policy);
  rebindV2(input);
  return {root:dir,baseRef:adopted,headRef:head,routingInput:input,
    adoption:{transition,authorization,expected,sourceReview},completion:completionFixture(input),now:'2026-10-17T12:02:00Z'};
}

test('BH F2: gate must not accept a text-converted empty patch as the complete raw diff',async()=>{
  const input=governedGitFixture();
  const actual=rawPatch(input.root,input.baseRef,input.headRef,['--no-textconv']);
  const converted=rawPatch(input.root,input.baseRef,input.headRef);
  assert.match(actual,/unsafe/); assert.equal(converted,'');
  input.routingInput.trustedContext.diffDigest=digest(converted); rebindV2(input.routingInput); input.completion=completionFixture(input.routingInput);
  const decision=await runReviewGateV2(input);
  writeFileSync(join(root,'finding-textconv.json'),JSON.stringify({
    fixture:input.root,base:input.baseRef,head:input.headRef,actual,converted,
    boundDigest:input.routingInput.trustedContext.diffDigest,decision
  },null,2)+'\n');
  assert.equal(decision.status,'blocked',`accepted empty diff: ${decision.status}/${decision.reason}`);
});

test('BH F4: a project PATH executable must not replace the trusted Git inventory',async()=>{
  const input=governedGitFixture(false);
  const config=JSON.parse(readFileSync(join(input.root,'pstack.config.json')));
  assert.equal(config.autoMerge.enabled,true);
  // Model the PATH prefix supplied by npm run in a project checkout.
  const bin=join(input.root,'node_modules/.bin');mkdirSync(bin,{recursive:true});
  const wrapper=join(bin,'git');
  writeFileSync(wrapper,`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
require('node:fs').appendFileSync(__filename+'.invoked','called');
const args=process.argv.slice(2);
if(args[0]==='diff'&&args.includes('--name-only')){process.stdout.write('README.md\\0');process.exit(0);}
if(args[0]==='diff'&&args.includes('--numstat')){process.stdout.write('1\\t0\\tREADME.md\\n');process.exit(0);}
const result=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(result.status??1);
`);chmodSync(wrapper,0o755);
  input.routingInput.trustedContext.risk='low';input.routingInput.policy.rules[0].risk='low';
  rebindV2(input.routingInput);input.completion=completionFixture(input.routingInput);
  input.gate={status:'accepted',choice:'low',confidence:0.99};
  const control=await runReviewGateV2(input);
  assert.equal(control.status,'blocked');assert.equal(control.risk,'risky');
  const priorPath=process.env.PATH;let decision;
  try {process.env.PATH=bin+':'+priorPath;decision=await runReviewGateV2(input);}
  finally {process.env.PATH=priorPath;}
  writeFileSync(join(root,'finding-path-git.json'),JSON.stringify({
    fixture:input.root,wrapper,actualFile:'scripts/lib/example.mjs',control,decision
  },null,2)+'\n');
  assert.equal(existsSync(wrapper+'.invoked'),false);
  assert.equal(decision.status,'blocked',JSON.stringify({status:decision.status,risk:decision.risk,
    obligations:decision.obligations,auto_merge:decision.auto_merge}));
});

test('BH F4 additional: npm lifecycle exposes checkout Git shadow without host binary changes',async()=>{
  const input=governedGitFixture(false);
  assert.match(rawPatch(input.root,input.baseRef,input.headRef),/unsafe/);
  input.routingInput.trustedContext.risk='low';input.routingInput.policy.rules[0].risk='low';
  rebindV2(input.routingInput);input.completion=completionFixture(input.routingInput);
  input.gate={status:'accepted',choice:'low',confidence:0.99};
  const control=await runReviewGateV2(input);assert.equal(control.status,'blocked');assert.equal(control.risk,'risky');
  const bin=join(input.root,'node_modules/.bin');mkdirSync(bin,{recursive:true});
  const wrapper=join(bin,'git');
  writeFileSync(wrapper,`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');
require('node:fs').appendFileSync(__filename+'.invoked','called');
const args=process.argv.slice(2);
if(args[0]==='diff'&&args.includes('--name-only')){process.stdout.write('README.md\\0');process.exit(0);}
if(args[0]==='diff'&&args.includes('--numstat')){process.stdout.write('1\\t0\\tREADME.md\\n');process.exit(0);}
const result=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(result.status??1);
`);chmodSync(wrapper,0o755);
  const inputPath=join(input.root,'probe-input.json'),runner=join(input.root,'probe-runner.mjs');
  writeFileSync(inputPath,JSON.stringify(input));
  writeFileSync(runner,`const {readFileSync} = await import('node:fs');\nimport {runReviewGateV2} from ${JSON.stringify('file://'+join(source,'scripts/review-gate.mjs'))};\nconst input=JSON.parse(readFileSync(${JSON.stringify(inputPath)},'utf8'));\nconsole.log(JSON.stringify(await runReviewGateV2(input)));\n`);
  writeFileSync(join(input.root,'package.json'),JSON.stringify({private:true,scripts:{'gate-probe':JSON.stringify(process.execPath)+' '+JSON.stringify(runner)}}));
  const output=execFileSync('npm',['run','--silent','gate-probe'],{cwd:input.root,encoding:'utf8',env:{...process.env,npm_config_cache:join(root,'npm-cache'),npm_config_update_notifier:'false'}});
  const decision=JSON.parse(output);
  writeFileSync(join(root,'finding-npm-path.json'),JSON.stringify({textconvConfigured:false,rawPatchIncludesUnsafe:true,hostBinariesUnchanged:true,control:{status:control.status,risk:control.risk},decision:{status:decision.status,reason:decision.reason,risk:decision.risk,obligations:decision.obligations,autoMerge:decision.auto_merge.eligible}},null,2)+'\n');
  assert.equal(existsSync(wrapper+'.invoked'),false);
  assert.equal(decision.status,'blocked',JSON.stringify({status:decision.status,risk:decision.risk,obligations:decision.obligations,autoMerge:decision.auto_merge.eligible}));
});


for(const maximum of ['maxRepairRounds','maxNoProgress','maxSimilarFailures']) {
  test('BH counter expansion below exhaustion '+maximum,()=>{
    const f=fixtureV2();f.policy[maximum]=1;const c=completionFixture(rebindV2(f));
    assert.equal(c.plan.appliedCounterLimits[maximum],1);
    assert.equal(validateReviewCompletions(c).status,'blocked');
    c.trustedContext.limits[maximum]=1;
    assert.equal(validateReviewCompletions(c).status,'accepted');
  });
}
for(const [counter,maximum] of [['repairRounds','maxRepairRounds'],['noProgress','maxNoProgress'],['similarFailures','maxSimilarFailures']]) {
  test('BH equal tighter exhausted and reset counters '+counter,()=>{
    const c=completionFixture();assert.equal(validateReviewCompletions(c).status,'accepted');
    c.trustedContext.limits[maximum]=1;assert.equal(validateReviewCompletions(c).status,'accepted');
    c.trustedContext.budget[counter]=1;assert.equal(validateReviewCompletions(c).status,'blocked');
    const f=fixtureV2();f.trustedContext.budget[counter]=1;const reset=completionFixture(rebindV2(f));
    reset.trustedContext.budget[counter]=0;assert.equal(validateReviewCompletions(reset).status,'blocked');
  });
}
for(const alteration of ['missing','null','changed'])test('BH receipt bound counters '+alteration,()=>{
  const c=completionFixture();c.plan=structuredClone(c.plan);
  if(alteration==='missing')delete c.plan.appliedCounterLimits;
  else if(alteration==='null')c.plan.appliedCounterLimits=null;
  else c.plan.appliedCounterLimits.maxRepairRounds=1;
  assert.equal(validateReviewCompletions(c).status,'blocked');
});
test('BH blocked receipt explicitly carries null counter limits',()=>{
  const plan=resolveRoutingV2(null);assert.equal(plan.appliedCounterLimits,null);
  assert.equal(validateV2('receipt',plan).valid,true);
});
test('BH raw current and adoption patches bypass lossy converter',async()=>{
  const x=governedGitFixture(),marker=join(root,'converter-invoked'),converter=join(root,'converter.cjs');
  writeFileSync(converter,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"called");');
  git(x.root,'config','diff.mask.textconv',JSON.stringify(process.execPath)+' '+JSON.stringify(converter));
  assert.match(rawPatch(x.root,x.baseRef,x.headRef,['--no-textconv']),/unsafe/);
  const d=await runReviewGateV2(x);assert.equal(d.status,'consistent',JSON.stringify(d));
  assert.equal(d.risk,'risky');assert.equal(existsSync(marker),false);
});
test('BH converted adoption digest is rejected separately',async()=>{
  const x=governedGitFixture(true,true);
  assert.notEqual(x.adoption.transition.patchDigest,digest(rawPatch(x.root,x.adoption.transition.baseSha,x.adoption.transition.headSha,['--no-textconv'])));
  assert.equal((await runReviewGateV2(x)).reason,'transition_patch_mismatch');
});
for(const executable of ['git','/missing/trusted/git','checkout'])test('BH unverified Git fails closed '+executable,async()=>{
  const x=governedGitFixture(false),prior=process.env.PSTACK_GIT;
  const fake=join(x.root,'fake-git');writeFileSync(fake,'#!/bin/sh\nexit 0\n');chmodSync(fake,0o755);
  try {process.env.PSTACK_GIT=executable==='checkout'?fake:executable;
    assert.throws(()=>runGit(x.root,['--version']));
    assert.equal((await runReviewGateV2(x)).status,'blocked');
  } finally {if(prior===undefined)delete process.env.PSTACK_GIT;else process.env.PSTACK_GIT=prior;}
});
test('BH explicit verified system Git works',async()=>{
  const x=governedGitFixture(false),prior=process.env.PSTACK_GIT;
  try {process.env.PSTACK_GIT='/usr/bin/git';assert.equal((await runReviewGateV2(x)).status,'consistent');}
  finally {if(prior===undefined)delete process.env.PSTACK_GIT;else process.env.PSTACK_GIT=prior;}
});
for(const owner of ['@person','@acme/platform'])test('BH owner authority roundtrip '+owner,()=>{
  const x=governedFixture();x.policy.ownerHandle=owner;x.adoption.authorization.ownerHandle=owner;
  x.adoption.transition.newPolicyDigest=digest(x.policy);x.adoption.expected.newPolicyDigest=digest(x.policy);
  x.adoption.authorization.transitionDigest=digest(x.adoption.transition);
  assert.equal(validateV2('reviewPolicy',x.policy).valid,true);
  assert.equal(validateV2('reviewTransitionAuthorization',x.adoption.authorization).valid,true);
  assert.equal(validateReviewTransition({...x.adoption,policy:x.policy,now:x.now}),true);
  x.adoption.authorization.ownerHandle='@other/team';
  assert.equal(validateReviewTransition({...x.adoption,policy:x.policy,now:x.now}),false);
});
for(const owner of ['@','@org/','org/team','@org/team/extra','{{OWNER}}'])test('BH malformed owner '+owner,()=>{
  const x=governedFixture();x.policy.ownerHandle=owner;x.adoption.authorization.ownerHandle=owner;
  assert.equal(validateV2('reviewPolicy',x.policy).valid,false);
  assert.equal(validateV2('reviewTransitionAuthorization',x.adoption.authorization).valid,false);
});

}
