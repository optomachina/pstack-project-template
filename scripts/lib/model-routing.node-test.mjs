import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalJSON, digest, schemas, validate, resolveRouting } from './model-routing.mjs';
import { fixture, rebind, withOverride } from '../fixtures/model-routing/synthetic.mjs';
const resolve = input => {
  const result = resolveRouting(input);
  assert.equal(validate('receipt', result).valid, true, JSON.stringify(validate('receipt', result)));
  assert.ok(['planned','blocked'].includes(result.status));
  assert.equal(result.compliance,'unverified');
  if (result.selected) {
    assert.equal(result.selected.emittedEffort,'unknown');
    assert.deepEqual(result.selected.observedEffective,{provider:'unknown',model:'unknown',family:'unknown',effort:'unknown'});
  }
  return result;
};
function blocked(name, mutate, reason, bind = true) {
  test(name, () => {
    const input = fixture(); mutate(input); if (bind) rebind(input);
    const result = resolve(input); assert.equal(result.status,'blocked');
    if (reason) assert.equal(result.reason,reason);
    assert.equal(result.selected,null);
  });
}
function deepFreeze(o) { if (o && typeof o === 'object') {Object.values(o).forEach(deepFreeze);Object.freeze(o);}return o; }

test('ARCH-R01 deterministic immutable offline plan; requested/planned/emitted/observed distinct', () => {
  const input = deepFreeze(fixture()), before = canonicalJSON(input);
  const result = resolve(input);
  assert.equal(result.status,'planned'); assert.equal(result.selected.profileId,'primary');
  assert.deepEqual(result.selected.requestedEffort,{kind:'explicit',value:'high'});
  assert.deepEqual(result.selected.plannedEmission,{parameter:'native.effort',value:'high'});
  assert.equal(result.reviewPlans.length,1); assert.deepEqual(result.budget,input.trustedContext.budget);
  assert.equal(result.requestDigest,digest(input.request)); assert.equal(result.contextDigest,digest(input.trustedContext));
  assert.equal(canonicalJSON(resolve(input)),canonicalJSON(result)); assert.equal(canonicalJSON(input),before);
  assert.ok(Object.isFrozen(result.selected));
});
test('canonical sorted keys, ordered arrays, UTF-8 and stable SHA-256', () => {
  assert.equal(canonicalJSON({z:1,a:['é',2]}),'{"a":["é",2],"z":1}');
  assert.equal(digest({b:2,a:1}),digest({a:1,b:2}));
  assert.notEqual(digest([1,2]),digest([2,1]));
  assert.equal(digest({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  for (const value of [undefined,NaN,Infinity,{x:undefined},new Date(),[undefined],Array(2),()=>{},1n,'\ud800']) assert.throws(() => canonicalJSON(value));
  const cycle = {};cycle.x=cycle;assert.throws(() => canonicalJSON(cycle));
  assert.throws(() => canonicalJSON(Object.defineProperty({},'x',{enumerable:true,get(){throw Error('getter invoked');}})),/invalid_json/);
});
test('schema files equal immutable embedded schemas; all object schemas closed; bounded keyword coverage', () => {
  const keywords = new Set(['$schema','$id','type','properties','required','additionalProperties','oneOf','const','enum','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','format','minimum','maximum']);
  function inspect(s) {
    for (const k of Object.keys(s)) assert.ok(keywords.has(k),k);
    if (s.type === 'object') {assert.equal(s.additionalProperties,false);assert.deepEqual(s.required,Object.keys(s.properties));Object.values(s.properties).forEach(inspect);}
    if(s.items)inspect(s.items);if(s.oneOf)s.oneOf.forEach(inspect);
  }
  for(const [name,s] of Object.entries(schemas)) {
    assert.deepEqual(JSON.parse(readFileSync(new URL(`../../schemas/model-routing/${name}.v1.schema.json`,import.meta.url),'utf8')),s);inspect(s);
  }
});
test('every populated nested object rejects unknown fields and missing required fields', () => {
  const f=withOverride(); const samples={policy:f.policy,catalog:f.catalog,context:f.trustedContext,request:f.request,override:f.override,receipt:resolve(f)};
  function visit(name,root,path=[]) {
    const node=path.reduce((v,k)=>v[k],root);
    if(node===null || typeof node!=='object')return;
    if(!Array.isArray(node)) {
      const mutated=structuredClone(root), target=path.reduce((v,k)=>v[k],mutated);target.untrustedField=true;
      assert.equal(validate(name,mutated).valid,false,`${name}.${path.join('.')}`);
      for(const key of Object.keys(node)) {
        const missing=structuredClone(root);delete path.reduce((v,k)=>v[k],missing)[key];
        assert.equal(validate(name,missing).valid,false,`${name}.${path.join('.')}.${key}`);
      }
    }
    for(const key of Object.keys(node))visit(name,root,[...path,key]);
  }
  for(const [name,root] of Object.entries(samples)){assert.equal(validate(name,root).valid,true);visit(name,root);}
});
for(const effort of [{kind:'omit',value:'high'},{kind:'explicit'},{kind:'intent',mappingId:'careful-v1',intent:'careful',value:'high'},{kind:'unknown'}]) {
  blocked('ARCH-R02 exclusive effort union '+JSON.stringify(effort),f=>{f.policy.profiles[0].effort=effort;},'invalid_policy');
}
for(const field of ['projectId','repoId','sourceSha','baseSha','unitId','attemptId','ownerId','policyDigest','reviewPolicyDigest','catalogDigest','role','risk']) {
  blocked('request/context binding disagreement '+field,f=>{f.request[field]=field.endsWith('Sha')?'a'.repeat(40):field.endsWith('Digest')?'a'.repeat(64):field==='risk'?'low':'other';},'context_mismatch',false);
}
blocked('request cannot redefine actions',f=>{f.request.actions=['execute'];},'context_mismatch');
blocked('request cannot drop capabilities',f=>{f.request.requiredCapabilities=[];},'context_mismatch');
blocked('ARCH-R21 missing context',f=>{delete f.trustedContext;},'invalid_context',false);
blocked('ARCH-R21 missing policy',f=>{delete f.policy;},'invalid_policy',false);
blocked('policy digest is not interchangeable',f=>{f.policy.revision='changed';},'digest_or_identity_mismatch',false);
blocked('catalog digest is not interchangeable',f=>{f.catalog.revision='changed';},'digest_or_identity_mismatch',false);
blocked('trusted review-policy mismatch',f=>{f.policy.reviewPolicyDigest='a'.repeat(64);},'digest_or_identity_mismatch');
blocked('policy project identity mismatch',f=>{f.policy.projectId='other';},'digest_or_identity_mismatch');
blocked('ARCH-R02 unknown role',f=>{f.trustedContext.role='unlisted';},'no_rule');
blocked('ARCH-R02 unknown risk',f=>{f.trustedContext.risk='critical';},'invalid_context');
blocked('ARCH-R02 unresolved profile',f=>{f.policy.rules[0].candidates=['missing'];},'unresolved_reference');
blocked('ARCH-R02 unresolved catalog',f=>{f.policy.profiles[0].entryId='missing';},'unresolved_reference');
blocked('ARCH-R02 unknown capabilities',f=>{f.policy.profiles.forEach(p=>p.requiredCapabilities=['unknown']);},'mandatory_review_unavailable');
blocked('ARCH-R10 ambiguous rules',f=>{f.policy.rules.push({...f.policy.rules[0],id:'conflict'});},'ambiguous_rules');
blocked('ARCH-R10 duplicate profile IDs',f=>{f.policy.profiles[1].id='primary';},'ambiguous_records');
blocked('duplicate evidence scope',f=>{f.trustedContext.evidence.push({...f.trustedContext.evidence[0],reference:'other'});},'ambiguous_records');
blocked('unresolved approved mapping',f=>{f.policy.rules[0].approvedMappings=['absent'];},'unresolved_mapping');
blocked('ARCH-R03 named review cannot be substituted',f=>{f.trustedContext.reviews[0].model='mandatory-other';},'mandatory_review_unavailable');
blocked('ARCH-R03 named provider cannot be substituted',f=>{f.trustedContext.reviews[0].provider='fake-a';},'mandatory_review_unavailable');
blocked('ARCH-R04 writer cannot self-review',f=>{f.trustedContext.writer.executionId='reviewer-1';},'mandatory_review_unavailable');
blocked('ARCH-R04 JEV-R13 different models same family insufficient',f=>{f.trustedContext.writer.family='family-b';},'mandatory_review_unavailable');
blocked('ARCH-R05 JEV-R02 unsupported effort no coercion',f=>{f.policy.rules[0].candidates=['primary'];f.policy.profiles[0].effort.value='xhigh';},'no_eligible_candidate');
blocked('ARCH-R05 unknown intent',f=>{f.policy.rules[0].candidates=['primary'];f.policy.profiles[0].effort={kind:'intent',mappingId:'careful-v1',intent:'unknown'};},'no_eligible_candidate');
blocked('mapping must be approved',f=>{f.policy.rules[0].candidates=['primary'];f.policy.rules[0].approvedMappings=[];f.policy.profiles[0].effort={kind:'intent',mappingId:'careful-v1',intent:'careful'};},'no_eligible_candidate');
test('versioned intent mapping retains request separately from planned emission',()=>{const f=fixture();f.policy.profiles[0].effort={kind:'intent',mappingId:'careful-v1',intent:'careful'};rebind(f);const r=resolve(f);assert.equal(r.status,'planned');assert.equal(r.selected.requestedEffort.kind,'intent');assert.equal(r.selected.plannedEmission.value,'high');});
test('ARCH-R07 ordered eligible alternate retains requested candidate and failure',()=>{const f=fixture();f.policy.profiles[0].effort.value='xhigh';rebind(f);const r=resolve(f);assert.equal(r.status,'planned');assert.equal(r.requestedProfile,'primary');assert.equal(r.selected.profileId,'alternate');assert.deepEqual(r.rejections,[{profileId:'primary',reason:'unsupported_effort'}]);});
blocked('hidden candidate not dispatch eligible',f=>{f.request.requestedProfile='review';},'requested_profile_not_allowed');
for(const kind of ['capability','availability','entitlement','budget']) {
  for(const failure of ['missing','expired','future','old','unknown']) {
    blocked(`ARCH-R06 ${kind} ${failure}`,f=>{const es=f.trustedContext.evidence;const e=es.find(x=>x.kind===kind);if(failure==='missing')es.splice(es.indexOf(e),1);else if(failure==='expired')e.expiresAt=f.now;else if(failure==='future')e.observedAt='2026-10-17T12:01:00Z';else if(failure==='old')e.observedAt='2026-10-17T00:00:00Z';else e.status='unknown';});
  }
}
blocked('JEV-R11 no paid overflow',f=>{f.trustedContext.evidence.filter(e=>e.kind==='entitlement').forEach(e=>e.billing='none');});
blocked('JEV-R24 executing runtime differs from evidence',f=>{f.catalog.entries[0].runtimeVersion='0.9.0';f.policy.catalogDigest=digest(f.catalog);f.trustedContext.catalogDigest=f.policy.catalogDigest;f.trustedContext.policyDigest=digest(f.policy);f.request.policyDigest=f.trustedContext.policyDigest;f.request.catalogDigest=f.trustedContext.catalogDigest;},'no_eligible_candidate',false);
blocked('JEV-R05 execution surface differs from evidence',f=>{f.catalog.entries[0].surface='synthetic-api';f.policy.catalogDigest=digest(f.catalog);f.trustedContext.catalogDigest=f.policy.catalogDigest;f.trustedContext.policyDigest=digest(f.policy);f.request.policyDigest=f.trustedContext.policyDigest;f.request.catalogDigest=f.trustedContext.catalogDigest;},'no_eligible_candidate',false);
blocked('JEV-R29 latest alias rejected',f=>{f.catalog.entries[0].model='fake-latest';},'invalid_catalog_contract');
blocked('unknown is observation not setting',f=>{f.catalog.entries[0].supportedEfforts.push('unknown');},'invalid_catalog_contract');
blocked('JEV-R27 automatic multi-agent control rejected',f=>{f.catalog.entries[0].agentCount=4;},'no_eligible_candidate');
blocked('ARCH-R24 mandatory service unknown is not approval',f=>{f.trustedContext.reviews[0].kind='service';},'mandatory_review_unavailable');
test('ARCH-R24 synthetic confirmed service still only produces plan',()=>{const f=fixture();const o=f.trustedContext.reviews[0];o.kind='service';f.trustedContext.evidence.push({...f.trustedContext.evidence[3],kind:'service',scope:o.id,reference:'service-proof',digest:digest(o)});rebind(f);assert.equal(resolve(f).status,'planned');});
for(const counter of ['repairRounds','noProgress','similarFailures']) blocked('JEV-R16/R28 preserved replan counter '+counter,f=>{f.trustedContext.budget[counter]=counter==='similarFailures'?3:2;},'budget_exhausted');
for(const dimension of ['tokens','wallTimeMs','attempts']) {
  blocked('missing finite budget '+dimension,f=>{delete f.trustedContext.budget.ceiling[dimension];},'invalid_context');
  blocked('exhausted '+dimension,f=>{f.trustedContext.budget.consumed[dimension]=f.trustedContext.budget.ceiling[dimension];},'budget_exhausted');
  blocked('review plus worker reservation exceeds '+dimension,f=>{f.trustedContext.budget.ceiling[dimension]=f.trustedContext.budget.consumed[dimension]+f.policy.profiles[2].reservation[dimension];},'no_eligible_candidate');
}
blocked('deadline expired',f=>{f.trustedContext.budget.deadline=f.now;},'budget_exhausted');
blocked('policy expired',f=>{f.policy.expiresAt=f.now;},'expired_policy_or_catalog');
blocked('catalog expired',f=>{f.catalog.expiresAt=f.now;},'expired_policy_or_catalog');
blocked('capability expired',f=>{f.catalog.entries[0].expiresAt=f.now;},'no_eligible_candidate');
for(const time of ['2026-02-30T12:00:00Z','2026-10-17T12:00:00.000Z','2026-10-17T12:00:00+00:00','not-time']) blocked('exact timestamp '+time,f=>{f.now=time;},'invalid_time');
test('authorized override selects alternate and tightens budgets without resetting usage',()=>{const f=withOverride();const r=resolve(f);assert.equal(r.status,'planned');assert.equal(r.selected.profileId,'alternate');assert.deepEqual(r.budget,f.trustedContext.budget);assert.deepEqual(r.appliedBudgetLimits,f.override.budgetLimits);});
for(const [name,mutate] of Object.entries({expired:f=>f.override.expiresAt=f.now,future:f=>f.override.issuedAt='2026-10-17T13:00:00Z',project:f=>f.override.projectId='other',owner:f=>f.override.ownerId='other',role:f=>f.override.role='other',risk:f=>f.override.risk='low',budget:f=>f.override.budgetLimits.tokens=1001,scope:f=>f.override.candidates=['review'],used:f=>f.trustedContext.overrideAuthorizations[0].state='used',revoked:f=>f.trustedContext.overrideAuthorizations[0].state='revoked',authExpiry:f=>f.trustedContext.overrideAuthorizations[0].expiresAt=f.now,disabled:f=>f.policy.overrideEnvelope.enabled=false,unauthorized:f=>f.trustedContext.overrideAuthorizations=[]})) {
  test('ARCH-R08/09 override '+name,()=>{const f=withOverride();mutate(f);if(name!=='unauthorized')rebind(f);assert.equal(resolve(f).status,'blocked');});
}
for(const field of ['billing','reviews','riskFloor','consumed']) test('ARCH-R09 override cannot redefine '+field,()=>{const f=withOverride();f.override[field]='weaken';assert.equal(resolve(f).reason,'invalid_override');});
test('stale override digest and policy binding fail closed',()=>{for(const field of ['expectedPolicyDigest','reason']){const f=withOverride();f.override[field]=field==='reason'?'changed':'a'.repeat(64);assert.equal(resolve(f).reason,'unauthorized_override');}});
test('omission explicitly permitted leaves unknown effort, known selected identity',()=>{const f=fixture();f.policy.rules[0].allowOmission=true;f.policy.profiles[0].effort={kind:'omit'};rebind(f);const r=resolve(f);assert.equal(r.status,'planned');assert.equal(r.selected.model,'fake-model-1');assert.deepEqual(r.selected.plannedEmission,{parameter:null,value:null});assert.equal(r.selected.observedEffective.effort,'unknown');});
blocked('omission cannot satisfy explicit review effort',f=>{f.policy.rules[0].allowOmission=true;f.policy.profiles[2].effort={kind:'omit'};},'mandatory_review_unavailable');
blocked('omission requires policy permission',f=>{f.policy.rules[0].candidates=['primary'];f.policy.profiles[0].effort={kind:'omit'};},'no_eligible_candidate');
blocked('omission requires catalog support',f=>{f.policy.rules[0].candidates=['primary'];f.policy.rules[0].allowOmission=true;f.policy.profiles[0].effort={kind:'omit'};f.catalog.entries[0].omissionSupported=false;},'no_eligible_candidate');
blocked('JEV-R04/06 default-only model rejects explicit effort',f=>{f.catalog.entries[0].supportedEfforts=[];f.catalog.entries[0].mappings=[];f.catalog.entries[0].parameter=null;f.policy.rules[0].approvedMappings=[];},'no_eligible_candidate');
for(const mode of ['running','handoff']) blocked('active '+mode+' requires later integration',f=>{f.request.mode=mode;},'integration_deferred');
test('ARCH-R25 errors never echo untrusted payloads',()=>{const f=fixture();f.request.secret='DO-NOT-ECHO';const text=canonicalJSON(resolve(f));assert.ok(!text.includes('DO-NOT-ECHO'));assert.ok(!text.includes('secret'));});
test('resolver has no IO, clock, environment, provider or process imports',()=>{const source=readFileSync(new URL('./model-routing.mjs',import.meta.url),'utf8');assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(x=>x[1]),['node:crypto']);assert.doesNotMatch(source,/Date\.now|new Date\(\)|process\.|fetch\(|node:(fs|http|child_process)/);});
for(const id of ['ARCH-R11','ARCH-R12','ARCH-R13','ARCH-R14','ARCH-R15','ARCH-R16-runtime','ARCH-R17-controller','ARCH-R18-adapter','ARCH-R19','ARCH-R20','ARCH-R22','ARCH-R23','ARCH-R26','ARCH-R27','JEV-R08','JEV-R09','JEV-R10','JEV-R17','JEV-R19-runtime']) test(id+' integration deferred', {skip:'A0 cannot prove admission, runtime observation, fencing, sync or live completion'},()=>{});
blocked('ambiguous exact catalog key',f=>{f.catalog.entries.push({...f.catalog.entries[0],id:'duplicate-tuple'});},'ambiguous_catalog');
test('fallback receipt preserves original requested effort and freshness evidence',()=>{const f=fixture();f.policy.profiles[0].effort.value='xhigh';rebind(f);const r=resolve(f);assert.deepEqual(r.requestedEffort,{kind:'explicit',value:'xhigh'});assert.equal(r.selected.plannedEmission.value,'low');assert.equal(r.selected.evidence[0].ageSeconds,3600);});
test('unresolved request identifiers are not echoed',()=>{const f=fixture();f.request.requestedProfile='DO-NOT-ECHO';assert.ok(!canonicalJSON(resolve(f)).includes('DO-NOT-ECHO'));});
for(const time of ['2026-10-17T23:59:60Z','2026-10-17T24:00:00Z']) test('schema and runtime reject noncanonical RFC date '+time,()=>{const f=fixture();f.policy.issuedAt=time;assert.equal(validate('policy',f.policy).valid,false);assert.equal(resolve(f).reason,'invalid_policy');});
test('canonicalization rejects hidden object length property',()=>{assert.throws(()=>canonicalJSON(Object.defineProperty({},'length',{value:1})),/invalid_json/);});
test('schema range, array uniqueness, enum, scalar type and safe integer bounds',()=>{
  for(const mutate of [
    f=>f.trustedContext.budget.ceiling.tokens=-1,
    f=>f.trustedContext.budget.ceiling.tokens=1.5,
    f=>f.trustedContext.budget.ceiling.tokens=Number.MAX_SAFE_INTEGER+1,
    f=>f.trustedContext.budget.ceiling.tokens=null,
    f=>f.policy.maxRepairRounds=3,
    f=>f.policy.rules[0].candidates.push('primary'),
    f=>f.policy.profiles[0].requiredCapabilities=Array.from({length:129},(_,i)=>'cap-'+i),
    f=>f.policy.allowedActions=[],
    f=>f.policy.billing='paid',
    f=>f.policy.projectId='x'.repeat(161),
    f=>f.policy.projectId='unsafe; command',
    f=>f.trustedContext.execution.executionId='',
  ]){const f=fixture();mutate(f);assert.equal(resolve(f).status,'blocked');}
});
