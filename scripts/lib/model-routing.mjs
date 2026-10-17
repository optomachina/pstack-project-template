import { createHash } from 'node:crypto';


const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export const schemas = freeze(bundledSchemas());

// JSON data only: no getters, sparse arrays, prototypes, cycles or lossy values.
export function canonicalJSON(value) {
  const ancestors = new Set();
  function encode(v) {
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') {
      if (!v.isWellFormed()) throw new TypeError('invalid_json');
      return JSON.stringify(v);
    }
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || ancestors.has(v)) throw new TypeError('invalid_json');
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('invalid_json');
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string' || ((!array || k !== 'length') && !Object.getOwnPropertyDescriptor(v, k).enumerable))) throw new TypeError('invalid_json');
    if (keys.some(k => !own(Object.getOwnPropertyDescriptor(v, k), 'value'))) throw new TypeError('invalid_json');
    ancestors.add(v);
    let result;
    if (array) {
      if (keys.length !== v.length + 1 || !Array.from({ length: v.length }, (_, i) => own(v, String(i))).every(Boolean)) throw new TypeError('invalid_json');
      result = '[' + v.map(encode).join(',') + ']';
    } else {
      result = '{' + keys.sort().map(k => encode(k) + ':' + encode(v[k])).join(',') + '}';
    }
    ancestors.delete(v);
    return result;
  }
  return encode(value);
}
export const digest = value => createHash('sha256').update(canonicalJSON(value), 'utf8').digest('hex');
function timestamp(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s.replace('Z', '.000Z');
}

// Bounded interpreter for ONLY the keywords used by the six bundled schemas.
export function validate(name, value) {
  if (!own(schemas, name)) return { valid: false, errors: ['unknown_schema'] };
  return validateDefinition(schemas[name], value);
}

function validateDefinition(definition, value) {
  try { canonicalJSON(value); } catch { return { valid: false, errors: ['invalid_json'] }; }
  function walk(s, v, path) {
    const errors = [];
    const fail = keyword => errors.push(`${path}:${keyword}`);
    if (s.oneOf && s.oneOf.filter(x => walk(x, v, path).length === 0).length !== 1) fail('oneOf');
    if (own(s, 'const') && canonicalJSON(v) !== canonicalJSON(s.const)) fail('const');
    if (s.enum && !s.enum.some(x => canonicalJSON(x) === canonicalJSON(v))) fail('enum');
    const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    if (s.type && !(s.type === 'integer' ? Number.isSafeInteger(v) : type === s.type)) { fail('type'); return errors; }
    if (type === 'object') {
      for (const k of s.required ?? []) if (!own(v, k)) fail('required.' + k);
      for (const k of Object.keys(v)) {
        if (s.properties && own(s.properties, k)) errors.push(...walk(s.properties[k], v[k], path + '.' + k));
        else if (s.additionalProperties === false) fail('additionalProperties');
      }
    }
    if (type === 'array') {
      if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) fail('items_length');
      if (s.uniqueItems && new Set(v.map(canonicalJSON)).size !== v.length) fail('uniqueItems');
      if (s.items) v.forEach((x, i) => errors.push(...walk(s.items, x, `${path}[${i}]`)));
    }
    if (type === 'string') {
      if ([...v].length < (s.minLength ?? 0) || [...v].length > (s.maxLength ?? Infinity)) fail('length');
      if (s.pattern && !(new RegExp(s.pattern, 'u')).test(v)) fail('pattern');
      if (s.format === 'date-time' && !timestamp(v)) fail('format');
    }
    if (type === 'number' && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) fail('range');
    return errors;
  }
  const errors = walk(definition, value, '$');
  return { valid: errors.length === 0, errors };
}

const bindingKeys = Object.keys(schemas.request.properties).filter(k => !['schema', 'mode', 'requestedProfile', 'requiredCapabilities', 'actions'].includes(k));
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const uniqueIds = xs => new Set(xs.map(x => x.id)).size === xs.length;
const limitKeys = ['tokens', 'wallTimeMs', 'attempts'];

/** Inert draft: trustedContext/policy/catalog/override must come from an authenticated
 * controller, not request data. Checks declarations, not authenticity. Never admits. */
export function resolveRouting(input) {
  return resolveRoutingCore(input);
}

function resolveRoutingCore(input, allowExecutionBindings = false) {
  const output = {
    schema: 'model-routing.receipt.v1', status: 'blocked', reason: 'invalid_input',
    resolvedAt: null, requestDigest: null, policyDigest: null, catalogDigest: null,
    contextDigest: null, overrideDigest: null, snapshotRevision: null, binding: null,
    requestedProfile: null, requestedEffort: null, selected: null, reviewPlans: [], rejections: [], budget: null,
    appliedBudgetLimits: null, compliance: 'unverified',
  };
  const finish = reason => freeze({ ...output, reason });
  try { canonicalJSON(input); } catch { return finish('invalid_json'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['policy', 'catalog', 'trustedContext', 'request', 'override', 'now'].includes(k))) return finish('invalid_input');
  const { policy, catalog, trustedContext: context, request, override = null, now } = input;
  if (!timestamp(now)) return finish('invalid_time');
  output.resolvedAt = now;
  for (const [name, value] of [['policy', policy], ['catalog', catalog], ['context', context], ['request', request]]) {
    if (!validate(name, value).valid) return finish('invalid_' + name);
  }
  if (override !== null && !validate('override', override).valid) return finish('invalid_override');
  // Copy valid data so no result shares mutable caller-owned objects.
  const copy = x => JSON.parse(canonicalJSON(x));
  output.requestDigest = digest(request); output.policyDigest = digest(policy);
  output.catalogDigest = digest(catalog); output.contextDigest = digest(context);
  output.overrideDigest = override === null ? null : digest(override);
  output.snapshotRevision = context.snapshotRevision;
  output.binding = Object.fromEntries(bindingKeys.map(k => [k, context[k]]));
  output.budget = copy(context.budget);
  output.appliedBudgetLimits = copy(context.budget.ceiling);
  const time = Date.parse(now);
  const fresh = e => Date.parse(e.observedAt ?? e.issuedAt) <= time && time < Date.parse(e.expiresAt) &&
    Date.parse(e.observedAt ?? e.issuedAt) < Date.parse(e.expiresAt);
  if (!fresh(policy) || !fresh(catalog)) return finish('expired_policy_or_catalog');
  if (bindingKeys.some(k => !equal(request[k], context[k])) ||
      !equal(request.actions, context.allowedActions) || !equal(request.requiredCapabilities, context.requiredCapabilities)) return finish('context_mismatch');
  if (context.policyDigest !== output.policyDigest || context.catalogDigest !== output.catalogDigest ||
      policy.catalogDigest !== output.catalogDigest || policy.reviewPolicyDigest !== context.reviewPolicyDigest ||
      policy.projectId !== context.projectId || policy.repoId !== context.repoId) return finish('digest_or_identity_mismatch');
  if (request.mode !== 'new') return finish('integration_deferred');
  if (context.allowedActions.some(x => !policy.allowedActions.includes(x))) return finish('action_not_allowed');
  if (!uniqueIds(policy.profiles) || !uniqueIds(policy.rules) || !uniqueIds(catalog.entries) || !uniqueIds(context.reviews) ||
      !uniqueIds(context.overrideAuthorizations) || new Set(context.evidence.map(x => x.reference)).size !== context.evidence.length ||
      new Set(context.evidence.map(x => `${x.kind}:${x.scope}`)).size !== context.evidence.length) return finish('ambiguous_records');
  if (context.reviews.some(({ subject }) => subject.kind === 'planned_output'
    ? subject.unitId !== context.unitId || subject.attemptId !== context.attemptId
    : subject.sourceSha !== context.sourceSha)) return finish('review_subject_mismatch');
  // The controller supplies immutable existing-artifact contributors. Planned
  // output additionally belongs to the new execution pinned by this context.
  // Main candidate assessment requires an exact match to that producer identity
  // before any plan can be returned; reviewer-role jobs are not blanket-banned.
  function reviewAuthors(obligation) {
    const authors = [context.writer, ...context.existingContributors];
    if (obligation.subject.kind === 'planned_output') authors.push(context.execution);
    return authors.filter((author, index) => authors.findIndex(other => equal(author, other)) === index);
  }
  const entries = new Map(catalog.entries.map(x => [x.id, x]));
  const profiles = new Map(policy.profiles.map(x => [x.id, x]));
  if (profiles.has(request.requestedProfile)) output.requestedProfile = request.requestedProfile;
  if (!allowExecutionBindings && new Set(catalog.entries.map(e => canonicalJSON([e.provider, e.model, e.surface, e.runtimeVersion, e.adapterVersion]))).size !== catalog.entries.length) return finish('ambiguous_catalog');
  if (new Set(policy.rules.map(x => `${x.role}:${x.risk}`)).size !== policy.rules.length) return finish('ambiguous_rules');
  if (catalog.entries.some(e => !uniqueIds(e.mappings) || /(^|[-_.:/])latest($|[-_.:/])/i.test(e.model) ||
      e.supportedEfforts.includes('unknown') || e.mappings.some(m => !e.supportedEfforts.includes(m.emitted)) ||
      (e.parameter === null && (e.supportedEfforts.length || e.mappings.length)))) return finish('invalid_catalog_contract');
  if (policy.profiles.some(p => !entries.has(p.entryId)) ||
      [...policy.rules.flatMap(r => r.candidates), ...policy.overrideEnvelope.profiles, ...context.reviews.flatMap(r => r.candidates)].some(id => !profiles.has(id))) return finish('unresolved_reference');
  if (policy.rules.some(r => r.approvedMappings.some(id => !r.candidates.some(p => entries.get(profiles.get(p).entryId).mappings.some(m => m.id === id))))) return finish('unresolved_mapping');
  const rule = policy.rules.find(x => x.role === context.role && x.risk === context.risk);
  if (!rule) return finish('no_rule');
  let candidates = rule.candidates;
  if (override !== null) {
    const auth = context.overrideAuthorizations.find(x => x.id === override.id);
    if (!policy.overrideEnvelope.enabled || !fresh(override) || !auth || !fresh(auth) || auth.state !== 'unused' ||
        auth.digest !== output.overrideDigest || auth.authorizationRef !== override.authorizationRef ||
        override.expectedPolicyDigest !== output.policyDigest ||
        ['projectId', 'repoId', 'role', 'risk', 'ownerId'].some(k => override[k] !== context[k]) ||
        override.candidates.some(id => !policy.overrideEnvelope.profiles.includes(id) || !rule.candidates.includes(id)) ||
        limitKeys.some(k => override.budgetLimits[k] > context.budget.ceiling[k])) return finish('unauthorized_override');
    candidates = override.candidates;
    output.appliedBudgetLimits = copy(override.budgetLimits);
  }
  const budget = context.budget;
  if (time >= Date.parse(budget.deadline) || budget.repairRounds >= policy.maxRepairRounds ||
      budget.noProgress >= policy.maxNoProgress || budget.similarFailures >= policy.maxSimilarFailures ||
      limitKeys.some(k => budget.consumed[k] >= output.appliedBudgetLimits[k])) return finish('budget_exhausted');
  function evidence(kind, scope, expectedDigest) {
    const e = context.evidence.find(x => x.kind === kind && x.scope === scope);
    return e && e.status === 'confirmed' && e.digest === expectedDigest && fresh(e) &&
      time - Date.parse(e.observedAt) <= policy.maxEvidenceAgeSeconds * 1000 ? e : null;
  }
  const budgetEvidence = evidence('budget', context.unitId, digest(budget));
  if (!budgetEvidence || budgetEvidence.reference !== budget.evidenceRef) return finish('unknown_budget');
  function assess(id, obligation = null) {
    const p = profiles.get(id), e = entries.get(p.entryId);
    const bad = reason => ({ reason });
    if (!fresh(e)) return bad('expired_capability');
    if (e.agentCount !== 1) return bad('multi_agent_not_authorized');
    const proofs = ['capability', 'availability', 'entitlement'].map(k => evidence(k, e.id, digest(e)));
    if (proofs.some(x => !x)) return bad('unknown_capability_availability_or_entitlement');
    if (proofs[2].billing !== 'subscription_included') return bad('entitlement_not_included');
    if (new Set(proofs.map(x => x.executionId)).size !== 1) return bad('execution_mismatch');
    const executionId = proofs[0].executionId;
    if (!obligation && (executionId !== context.execution.executionId || e.provider !== context.execution.provider || e.family !== context.execution.family)) return bad('execution_mismatch');
    if ([...context.requiredCapabilities, ...p.requiredCapabilities].some(x => !e.capabilities.includes(x))) return bad('missing_capability');
    let emitted = null;
    if (p.effort.kind === 'explicit') {
      if (!e.supportedEfforts.includes(p.effort.value)) return bad('unsupported_effort');
      emitted = p.effort.value;
    } else if (p.effort.kind === 'intent') {
      const mapping = e.mappings.find(m => m.id === p.effort.mappingId && m.intent === p.effort.intent);
      if (!mapping || !rule.approvedMappings.includes(mapping.id)) return bad('unsupported_mapping');
      emitted = mapping.emitted;
    } else if (!rule.allowOmission || !e.omissionSupported) return bad('omission_not_allowed');
    if (obligation) {
      if (e.provider !== obligation.provider || e.model !== obligation.model || e.family !== obligation.family ||
          (obligation.explicitEffort !== null && emitted !== obligation.explicitEffort)) return bad('mandatory_review_mismatch');
      if (reviewAuthors(obligation).some(author =>
        (obligation.independent && executionId === author.executionId) ||
        (obligation.crossFamily && e.family === author.family))) return bad('review_not_independent');
      if (obligation.kind === 'service') {
        const proof = evidence('service', obligation.id, digest(obligation));
        if (!proof || proof.executionId !== executionId) return bad('mandatory_service_unconfirmed');
        proofs.push(proof);
      }
    }
    return { selection: {
      profileId: p.id, entryId: e.id, provider: e.provider, model: e.model, family: e.family,
      surface: e.surface, runtimeVersion: e.runtimeVersion, adapterVersion: e.adapterVersion,
      adapterDigest: e.adapterDigest, executionId, requestedEffort: copy(p.effort),
      plannedEmission: { parameter: emitted === null ? null : e.parameter, value: emitted },
      emittedEffort: 'unknown', observedEffective: { provider: 'unknown', model: 'unknown', family: 'unknown', effort: 'unknown' },
      evidenceRefs: proofs.map(x => x.reference),
      evidence: proofs.map(x => ({ ...copy(x), ageSeconds: (time - Date.parse(x.observedAt)) / 1000 })),
    } };
  }
  // Review plans are prerequisites, never claims of completed reviews.
  const reservations = [];
  for (const obligation of context.reviews) {
    let selected;
    for (const id of obligation.candidates) {
      const result = assess(id, obligation);
      if (result.selection) { selected = result.selection; break; }
    }
    if (!selected) return finish('mandatory_review_unavailable');
    output.reviewPlans.push({
      obligationId: obligation.id, subject: copy(obligation.subject),
      independenceAuthors: copy(reviewAuthors(obligation)), selection: selected,
    });
    reservations.push(profiles.get(selected.profileId).reservation);
  }
  if (request.requestedProfile !== null) {
    if (!candidates.includes(request.requestedProfile)) return finish('requested_profile_not_allowed');
    candidates = [request.requestedProfile, ...candidates.filter(id => id !== request.requestedProfile)];
  }
  output.requestedEffort = copy(profiles.get(candidates[0]).effort);
  for (const id of candidates) {
    const result = assess(id);
    if (result.selection) {
      const costs = [...reservations, profiles.get(id).reservation];
      if (limitKeys.some(k => costs.reduce((sum, cost) => sum + cost[k], budget.consumed[k]) > output.appliedBudgetLimits[k]) ||
          costs.reduce((sum, cost) => sum + cost.wallTimeMs, 0) > Date.parse(budget.deadline) - time) {
        output.rejections.push({ profileId: id, reason: 'insufficient_budget' }); continue;
      }
      output.status = 'planned'; output.selected = result.selection;
      return finish('eligible_offline_plan');
    }
    output.rejections.push({ profileId: id, reason: result.reason });
  }
  return finish('no_eligible_candidate');
}

// Generated copies of the six JSON schemas. Parity is enforced by the tests.
// Embedded to keep all resolver calls free of filesystem reads.
function bundledSchemas() {
  return {
    "catalog": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:catalog:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.catalog.v1"
        },
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "model": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "surface": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "runtimeVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "adapterVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "adapterDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "parameter": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "supportedEfforts": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "omissionSupported": {
                "type": "boolean"
              },
              "mappings": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "version": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "intent": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "emitted": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "id",
                    "version",
                    "intent",
                    "emitted"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "capabilities": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "agentCount": {
                "type": "integer",
                "minimum": 1,
                "maximum": 128
              },
              "effectiveObservability": {
                "enum": [
                  "observable",
                  "unobservable"
                ]
              },
              "issuedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              }
            },
            "required": [
              "id",
              "provider",
              "family",
              "model",
              "surface",
              "runtimeVersion",
              "adapterVersion",
              "adapterDigest",
              "parameter",
              "supportedEfforts",
              "omissionSupported",
              "mappings",
              "capabilities",
              "agentCount",
              "effectiveObservability",
              "issuedAt",
              "expiresAt"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        }
      },
      "required": [
        "schema",
        "revision",
        "issuedAt",
        "expiresAt",
        "entries"
      ],
      "additionalProperties": false
    },
    "context": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:context:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.context.v1"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "sourceSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "baseSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "unitId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "attemptId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "ownerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "reviewPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "catalogDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "role": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "risk": {
          "enum": [
            "low",
            "moderate",
            "high"
          ]
        },
        "snapshotRevision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "writer": {
          "type": "object",
          "properties": {
            "executionId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "executionId",
            "provider",
            "family"
          ],
          "additionalProperties": false
        },
        "execution": {
          "type": "object",
          "properties": {
            "executionId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "executionId",
            "provider",
            "family"
          ],
          "additionalProperties": false
        },
        "requiredCapabilities": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "reviews": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "kind": {
                "enum": [
                  "model",
                  "service"
                ]
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "model": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "explicitEffort": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "independent": {
                "type": "boolean"
              },
              "crossFamily": {
                "type": "boolean"
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 1,
                "maxItems": 128,
                "uniqueItems": true
              },
              "subject": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "planned_output"
                      },
                      "unitId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "attemptId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "unitId",
                      "attemptId"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "existing_artifact"
                      },
                      "sourceSha": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{40}$"
                      },
                      "artifactDigest": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      }
                    },
                    "required": [
                      "kind",
                      "sourceSha",
                      "artifactDigest"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            },
            "required": [
              "id",
              "kind",
              "provider",
              "model",
              "family",
              "explicitEffort",
              "independent",
              "crossFamily",
              "candidates",
              "subject"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "budget": {
          "type": "object",
          "properties": {
            "ceiling": {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            "consumed": {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            "repairRounds": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "noProgress": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "similarFailures": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "deadline": {
              "type": "string",
              "format": "date-time",
              "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
            },
            "evidenceRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "ceiling",
            "consumed",
            "repairRounds",
            "noProgress",
            "similarFailures",
            "deadline",
            "evidenceRef"
          ],
          "additionalProperties": false
        },
        "evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "enum": [
                  "capability",
                  "availability",
                  "entitlement",
                  "budget",
                  "service"
                ]
              },
              "issuer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "reference": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "observedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "scope": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "digest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "status": {
                "enum": [
                  "confirmed",
                  "unavailable",
                  "unknown"
                ]
              },
              "billing": {
                "enum": [
                  "subscription_included",
                  "none"
                ]
              },
              "executionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "kind",
              "issuer",
              "reference",
              "observedAt",
              "expiresAt",
              "scope",
              "digest",
              "status",
              "billing",
              "executionId"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "overrideAuthorizations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "digest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "authorizationRef": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "issuer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "observedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "state": {
                "enum": [
                  "unused",
                  "used",
                  "revoked"
                ]
              }
            },
            "required": [
              "id",
              "digest",
              "authorizationRef",
              "issuer",
              "observedAt",
              "expiresAt",
              "state"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "existingContributors": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "executionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "executionId",
              "provider",
              "family"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        }
      },
      "required": [
        "schema",
        "projectId",
        "repoId",
        "sourceSha",
        "baseSha",
        "unitId",
        "attemptId",
        "ownerId",
        "policyDigest",
        "reviewPolicyDigest",
        "catalogDigest",
        "role",
        "risk",
        "snapshotRevision",
        "writer",
        "execution",
        "requiredCapabilities",
        "allowedActions",
        "reviews",
        "budget",
        "evidence",
        "overrideAuthorizations",
        "existingContributors"
      ],
      "additionalProperties": false
    },
    "override": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:override:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.override.v1"
        },
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "role": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "risk": {
          "enum": [
            "low",
            "moderate",
            "high"
          ]
        },
        "ownerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "authorizationRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expectedPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "candidates": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "budgetLimits": {
          "type": "object",
          "properties": {
            "tokens": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "wallTimeMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "attempts": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "tokens",
            "wallTimeMs",
            "attempts"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "schema",
        "id",
        "projectId",
        "repoId",
        "role",
        "risk",
        "ownerId",
        "authorizationRef",
        "issuedAt",
        "expiresAt",
        "expectedPolicyDigest",
        "reason",
        "candidates",
        "budgetLimits"
      ],
      "additionalProperties": false
    },
    "policy": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:policy:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.policy.v1"
        },
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "reviewPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "catalogDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "billing": {
          "const": "subscription_included"
        },
        "maxEvidenceAgeSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 604800
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "profiles": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "entryId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "effort": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "explicit"
                      },
                      "value": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "value"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "intent"
                      },
                      "mappingId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "intent": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "mappingId",
                      "intent"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "omit"
                      }
                    },
                    "required": [
                      "kind"
                    ],
                    "additionalProperties": false
                  }
                ]
              },
              "requiredCapabilities": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "reservation": {
                "type": "object",
                "properties": {
                  "tokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "wallTimeMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "attempts": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "tokens",
                  "wallTimeMs",
                  "attempts"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "id",
              "entryId",
              "effort",
              "requiredCapabilities",
              "reservation"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "rules": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "role": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "risk": {
                "enum": [
                  "low",
                  "moderate",
                  "high"
                ]
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 1,
                "maxItems": 128,
                "uniqueItems": true
              },
              "allowOmission": {
                "type": "boolean"
              },
              "approvedMappings": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "id",
              "role",
              "risk",
              "candidates",
              "allowOmission",
              "approvedMappings"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "overrideEnvelope": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "profiles": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "minItems": 0,
              "maxItems": 128,
              "uniqueItems": true
            }
          },
          "required": [
            "enabled",
            "profiles"
          ],
          "additionalProperties": false
        },
        "maxRepairRounds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2
        },
        "maxNoProgress": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2
        },
        "maxSimilarFailures": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        }
      },
      "required": [
        "schema",
        "revision",
        "projectId",
        "repoId",
        "reviewPolicyDigest",
        "catalogDigest",
        "issuedAt",
        "expiresAt",
        "billing",
        "maxEvidenceAgeSeconds",
        "allowedActions",
        "profiles",
        "rules",
        "overrideEnvelope",
        "maxRepairRounds",
        "maxNoProgress",
        "maxSimilarFailures"
      ],
      "additionalProperties": false
    },
    "receipt": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:receipt:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.receipt.v1"
        },
        "status": {
          "enum": [
            "planned",
            "blocked"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "resolvedAt": {
          "oneOf": [
            {
              "type": "string",
              "format": "date-time",
              "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
            },
            {
              "type": "null"
            }
          ]
        },
        "requestDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "policyDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "catalogDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "contextDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "overrideDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "snapshotRevision": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "binding": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "projectId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "repoId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "sourceSha": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{40}$"
                },
                "baseSha": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{40}$"
                },
                "unitId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "attemptId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "ownerId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "policyDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "reviewPolicyDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "catalogDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "role": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "risk": {
                  "enum": [
                    "low",
                    "moderate",
                    "high"
                  ]
                }
              },
              "required": [
                "projectId",
                "repoId",
                "sourceSha",
                "baseSha",
                "unitId",
                "attemptId",
                "ownerId",
                "policyDigest",
                "reviewPolicyDigest",
                "catalogDigest",
                "role",
                "risk"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "requestedProfile": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "selected": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "profileId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "entryId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "provider": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "model": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "family": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "surface": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "runtimeVersion": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "adapterVersion": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "adapterDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "executionId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "requestedEffort": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "explicit"
                        },
                        "value": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        }
                      },
                      "required": [
                        "kind",
                        "value"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "intent"
                        },
                        "mappingId": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "intent": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        }
                      },
                      "required": [
                        "kind",
                        "mappingId",
                        "intent"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "omit"
                        }
                      },
                      "required": [
                        "kind"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "plannedEmission": {
                  "type": "object",
                  "properties": {
                    "parameter": {
                      "oneOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "value": {
                      "oneOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "parameter",
                    "value"
                  ],
                  "additionalProperties": false
                },
                "emittedEffort": {
                  "const": "unknown"
                },
                "observedEffective": {
                  "type": "object",
                  "properties": {
                    "provider": {
                      "const": "unknown"
                    },
                    "model": {
                      "const": "unknown"
                    },
                    "family": {
                      "const": "unknown"
                    },
                    "effort": {
                      "const": "unknown"
                    }
                  },
                  "required": [
                    "provider",
                    "model",
                    "family",
                    "effort"
                  ],
                  "additionalProperties": false
                },
                "evidenceRefs": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "minItems": 1,
                  "maxItems": 128,
                  "uniqueItems": true
                },
                "evidence": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "enum": [
                          "capability",
                          "availability",
                          "entitlement",
                          "budget",
                          "service"
                        ]
                      },
                      "issuer": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "reference": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "observedAt": {
                        "type": "string",
                        "format": "date-time",
                        "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                      },
                      "expiresAt": {
                        "type": "string",
                        "format": "date-time",
                        "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                      },
                      "scope": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "digest": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      },
                      "status": {
                        "enum": [
                          "confirmed",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "billing": {
                        "enum": [
                          "subscription_included",
                          "none"
                        ]
                      },
                      "executionId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "ageSeconds": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "required": [
                      "kind",
                      "issuer",
                      "reference",
                      "observedAt",
                      "expiresAt",
                      "scope",
                      "digest",
                      "status",
                      "billing",
                      "executionId",
                      "ageSeconds"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "maxItems": 128,
                  "uniqueItems": true
                }
              },
              "required": [
                "profileId",
                "entryId",
                "provider",
                "model",
                "family",
                "surface",
                "runtimeVersion",
                "adapterVersion",
                "adapterDigest",
                "executionId",
                "requestedEffort",
                "plannedEmission",
                "emittedEffort",
                "observedEffective",
                "evidenceRefs",
                "evidence"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "reviewPlans": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "obligationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "selection": {
                "type": "object",
                "properties": {
                  "profileId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "entryId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "provider": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "model": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "family": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "surface": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "runtimeVersion": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "adapterVersion": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "adapterDigest": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "executionId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "requestedEffort": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "explicit"
                          },
                          "value": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "intent"
                          },
                          "mappingId": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          "intent": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          }
                        },
                        "required": [
                          "kind",
                          "mappingId",
                          "intent"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "omit"
                          }
                        },
                        "required": [
                          "kind"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "plannedEmission": {
                    "type": "object",
                    "properties": {
                      "parameter": {
                        "oneOf": [
                          {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "value": {
                        "oneOf": [
                          {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "parameter",
                      "value"
                    ],
                    "additionalProperties": false
                  },
                  "emittedEffort": {
                    "const": "unknown"
                  },
                  "observedEffective": {
                    "type": "object",
                    "properties": {
                      "provider": {
                        "const": "unknown"
                      },
                      "model": {
                        "const": "unknown"
                      },
                      "family": {
                        "const": "unknown"
                      },
                      "effort": {
                        "const": "unknown"
                      }
                    },
                    "required": [
                      "provider",
                      "model",
                      "family",
                      "effort"
                    ],
                    "additionalProperties": false
                  },
                  "evidenceRefs": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "minItems": 1,
                    "maxItems": 128,
                    "uniqueItems": true
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "enum": [
                            "capability",
                            "availability",
                            "entitlement",
                            "budget",
                            "service"
                          ]
                        },
                        "issuer": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "reference": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "observedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                        },
                        "expiresAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                        },
                        "scope": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "digest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "status": {
                          "enum": [
                            "confirmed",
                            "unavailable",
                            "unknown"
                          ]
                        },
                        "billing": {
                          "enum": [
                            "subscription_included",
                            "none"
                          ]
                        },
                        "executionId": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "ageSeconds": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "kind",
                        "issuer",
                        "reference",
                        "observedAt",
                        "expiresAt",
                        "scope",
                        "digest",
                        "status",
                        "billing",
                        "executionId",
                        "ageSeconds"
                      ],
                      "additionalProperties": false
                    },
                    "minItems": 1,
                    "maxItems": 128,
                    "uniqueItems": true
                  }
                },
                "required": [
                  "profileId",
                  "entryId",
                  "provider",
                  "model",
                  "family",
                  "surface",
                  "runtimeVersion",
                  "adapterVersion",
                  "adapterDigest",
                  "executionId",
                  "requestedEffort",
                  "plannedEmission",
                  "emittedEffort",
                  "observedEffective",
                  "evidenceRefs",
                  "evidence"
                ],
                "additionalProperties": false
              },
              "subject": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "planned_output"
                      },
                      "unitId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "attemptId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "unitId",
                      "attemptId"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "existing_artifact"
                      },
                      "sourceSha": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{40}$"
                      },
                      "artifactDigest": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      }
                    },
                    "required": [
                      "kind",
                      "sourceSha",
                      "artifactDigest"
                    ],
                    "additionalProperties": false
                  }
                ]
              },
              "independenceAuthors": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "executionId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "provider": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "family": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "executionId",
                    "provider",
                    "family"
                  ],
                  "additionalProperties": false
                },
                "minItems": 1,
                "maxItems": 130,
                "uniqueItems": true
              }
            },
            "required": [
              "obligationId",
              "selection",
              "subject",
              "independenceAuthors"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "rejections": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "profileId",
              "reason"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "budget": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "ceiling": {
                  "type": "object",
                  "properties": {
                    "tokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "wallTimeMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "attempts": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "tokens",
                    "wallTimeMs",
                    "attempts"
                  ],
                  "additionalProperties": false
                },
                "consumed": {
                  "type": "object",
                  "properties": {
                    "tokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "wallTimeMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "attempts": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "tokens",
                    "wallTimeMs",
                    "attempts"
                  ],
                  "additionalProperties": false
                },
                "repairRounds": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "noProgress": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "similarFailures": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "deadline": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                },
                "evidenceRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                }
              },
              "required": [
                "ceiling",
                "consumed",
                "repairRounds",
                "noProgress",
                "similarFailures",
                "deadline",
                "evidenceRef"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "appliedBudgetLimits": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "compliance": {
          "const": "unverified"
        },
        "requestedEffort": {
          "oneOf": [
            {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "explicit"
                    },
                    "value": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "kind",
                    "value"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "intent"
                    },
                    "mappingId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "intent": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "kind",
                    "mappingId",
                    "intent"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "omit"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "schema",
        "status",
        "reason",
        "resolvedAt",
        "requestDigest",
        "policyDigest",
        "catalogDigest",
        "contextDigest",
        "overrideDigest",
        "snapshotRevision",
        "binding",
        "requestedProfile",
        "selected",
        "reviewPlans",
        "rejections",
        "budget",
        "appliedBudgetLimits",
        "compliance",
        "requestedEffort"
      ],
      "additionalProperties": false
    },
    "request": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:request:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.request.v1"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "sourceSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "baseSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "unitId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "attemptId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "ownerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "reviewPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "catalogDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "role": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "risk": {
          "enum": [
            "low",
            "moderate",
            "high"
          ]
        },
        "mode": {
          "enum": [
            "new",
            "running",
            "handoff"
          ]
        },
        "requestedProfile": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "requiredCapabilities": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "actions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        }
      },
      "required": [
        "schema",
        "projectId",
        "repoId",
        "sourceSha",
        "baseSha",
        "unitId",
        "attemptId",
        "ownerId",
        "policyDigest",
        "reviewPolicyDigest",
        "catalogDigest",
        "role",
        "risk",
        "mode",
        "requestedProfile",
        "requiredCapabilities",
        "actions"
      ],
      "additionalProperties": false
    }
  };
}

/** Closed v2 schemas; v1 schema exports and acceptance remain unchanged. */
export const schemasV2 = freeze(bundledV2Schemas());
/** Validate only a bundled v2 contract, never an external schema. */
export function validateV2(name, value) {
  return own(schemasV2, name) ? validateDefinition(schemasV2[name], value) : {valid:false, errors:["unknown_schema"]};
}

function bundledV2Schemas() {
  return {
    "policy": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:policy:v2",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.policy.v2"
        },
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "reviewPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "catalogDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "billing": {
          "const": "subscription_included"
        },
        "maxEvidenceAgeSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 604800
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "profiles": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "entryId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "effort": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "explicit"
                      },
                      "value": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "value"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "intent"
                      },
                      "mappingId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "intent": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "mappingId",
                      "intent"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "omit"
                      }
                    },
                    "required": [
                      "kind"
                    ],
                    "additionalProperties": false
                  }
                ]
              },
              "requiredCapabilities": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "reservation": {
                "type": "object",
                "properties": {
                  "tokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "wallTimeMs": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "attempts": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "tokens",
                  "wallTimeMs",
                  "attempts"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "id",
              "entryId",
              "effort",
              "requiredCapabilities",
              "reservation"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "rules": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "role": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "risk": {
                "enum": [
                  "low",
                  "moderate",
                  "high"
                ]
              },
              "candidates": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 1,
                "maxItems": 128,
                "uniqueItems": true
              },
              "allowOmission": {
                "type": "boolean"
              },
              "approvedMappings": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "id",
              "role",
              "risk",
              "candidates",
              "allowOmission",
              "approvedMappings"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "overrideEnvelope": {
          "type": "object",
          "properties": {
            "enabled": {
              "type": "boolean"
            },
            "profiles": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "minItems": 0,
              "maxItems": 128,
              "uniqueItems": true
            }
          },
          "required": [
            "enabled",
            "profiles"
          ],
          "additionalProperties": false
        },
        "maxRepairRounds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2
        },
        "maxNoProgress": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2
        },
        "maxSimilarFailures": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3
        },
        "reviewRules": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "risk": {
                "enum": [
                  "low",
                  "moderate",
                  "high"
                ]
              },
              "slots": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "independent": {
                      "const": true
                    },
                    "crossFamily": {
                      "type": "boolean"
                    },
                    "binding": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "named"
                            },
                            "provider": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "model": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "family": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "explicitEffort": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "profiles": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 1,
                              "maxItems": 128,
                              "uniqueItems": true
                            }
                          },
                          "required": [
                            "kind",
                            "provider",
                            "model",
                            "family",
                            "explicitEffort",
                            "profiles"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "capability"
                            },
                            "capability": {
                              "enum": [
                                "correctness",
                                "deep"
                              ]
                            },
                            "coverage": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 1,
                              "maxItems": 128,
                              "uniqueItems": true
                            },
                            "primaryProfiles": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 1,
                              "maxItems": 128,
                              "uniqueItems": true
                            },
                            "fallbackProfiles": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 0,
                              "maxItems": 128,
                              "uniqueItems": true
                            },
                            "fallbackWhen": {
                              "const": "confirmed_unavailable"
                            }
                          },
                          "required": [
                            "kind",
                            "capability",
                            "coverage",
                            "primaryProfiles",
                            "fallbackProfiles",
                            "fallbackWhen"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "independent",
                    "crossFamily",
                    "binding"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "risk",
              "slots"
            ],
            "additionalProperties": false
          },
          "minItems": 3,
          "maxItems": 128,
          "uniqueItems": true
        }
      },
      "required": [
        "schema",
        "revision",
        "projectId",
        "repoId",
        "reviewPolicyDigest",
        "catalogDigest",
        "issuedAt",
        "expiresAt",
        "billing",
        "maxEvidenceAgeSeconds",
        "allowedActions",
        "profiles",
        "rules",
        "overrideEnvelope",
        "maxRepairRounds",
        "maxNoProgress",
        "maxSimilarFailures",
        "reviewRules"
      ],
      "additionalProperties": false
    },
    "context": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:context:v2",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.context.v2"
        },
        "projectId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "sourceSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "baseSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "unitId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "attemptId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "ownerId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "reviewPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "catalogDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "role": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "risk": {
          "enum": [
            "low",
            "moderate",
            "high"
          ]
        },
        "snapshotRevision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "writer": {
          "type": "object",
          "properties": {
            "executionId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "executionId",
            "provider",
            "family"
          ],
          "additionalProperties": false
        },
        "execution": {
          "type": "object",
          "properties": {
            "executionId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "executionId",
            "provider",
            "family"
          ],
          "additionalProperties": false
        },
        "requiredCapabilities": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "allowedActions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "budget": {
          "type": "object",
          "properties": {
            "ceiling": {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            "consumed": {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            "repairRounds": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "noProgress": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "similarFailures": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "deadline": {
              "type": "string",
              "format": "date-time",
              "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
            },
            "evidenceRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "ceiling",
            "consumed",
            "repairRounds",
            "noProgress",
            "similarFailures",
            "deadline",
            "evidenceRef"
          ],
          "additionalProperties": false
        },
        "evidence": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "enum": [
                  "capability",
                  "availability",
                  "entitlement",
                  "budget",
                  "service"
                ]
              },
              "issuer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "reference": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "observedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "scope": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "digest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "status": {
                "enum": [
                  "confirmed",
                  "unavailable",
                  "unknown"
                ]
              },
              "billing": {
                "enum": [
                  "subscription_included",
                  "none"
                ]
              },
              "executionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "failure": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "code": {
                        "enum": [
                          "quota_exhausted",
                          "provider_unavailable"
                        ]
                      },
                      "resetAt": {
                        "oneOf": [
                          {
                            "type": "string",
                            "format": "date-time",
                            "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "code",
                      "resetAt"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "kind",
              "issuer",
              "reference",
              "observedAt",
              "expiresAt",
              "scope",
              "digest",
              "status",
              "billing",
              "executionId",
              "failure"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "overrideAuthorizations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "digest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "authorizationRef": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "issuer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "observedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "state": {
                "enum": [
                  "unused",
                  "used",
                  "revoked"
                ]
              }
            },
            "required": [
              "id",
              "digest",
              "authorizationRef",
              "issuer",
              "observedAt",
              "expiresAt",
              "state"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "existingContributors": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "executionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "executionId",
              "provider",
              "family"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "reviewSubject": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "planned_output"
                },
                "unitId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "attemptId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                }
              },
              "required": [
                "kind",
                "unitId",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "existing_artifact"
                },
                "sourceSha": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{40}$"
                },
                "artifactDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "kind",
                "sourceSha",
                "artifactDigest"
              ],
              "additionalProperties": false
            }
          ]
        },
        "artifactDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "diffDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "schema",
        "projectId",
        "repoId",
        "sourceSha",
        "baseSha",
        "unitId",
        "attemptId",
        "ownerId",
        "policyDigest",
        "reviewPolicyDigest",
        "catalogDigest",
        "role",
        "risk",
        "snapshotRevision",
        "writer",
        "execution",
        "requiredCapabilities",
        "allowedActions",
        "budget",
        "evidence",
        "overrideAuthorizations",
        "existingContributors",
        "reviewSubject",
        "artifactDigest",
        "diffDigest"
      ],
      "additionalProperties": false
    },
    "catalog": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:catalog:v2",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.catalog.v2"
        },
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "entries": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "model": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "surface": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "runtimeVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "adapterVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "adapterDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "parameter": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "supportedEfforts": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "omissionSupported": {
                "type": "boolean"
              },
              "mappings": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "version": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "intent": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "emitted": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "id",
                    "version",
                    "intent",
                    "emitted"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "capabilities": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "agentCount": {
                "type": "integer",
                "minimum": 1,
                "maximum": 128
              },
              "effectiveObservability": {
                "enum": [
                  "observable",
                  "unobservable"
                ]
              },
              "issuedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "reviewCapabilities": {
                "type": "array",
                "items": {
                  "enum": [
                    "correctness",
                    "deep"
                  ]
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              },
              "reviewCoverage": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "id",
              "provider",
              "family",
              "model",
              "surface",
              "runtimeVersion",
              "adapterVersion",
              "adapterDigest",
              "parameter",
              "supportedEfforts",
              "omissionSupported",
              "mappings",
              "capabilities",
              "agentCount",
              "effectiveObservability",
              "issuedAt",
              "expiresAt",
              "reviewCapabilities",
              "reviewCoverage"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        }
      },
      "required": [
        "schema",
        "revision",
        "issuedAt",
        "expiresAt",
        "entries"
      ],
      "additionalProperties": false
    },
    "receipt": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:receipt:v2",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.receipt.v2"
        },
        "status": {
          "enum": [
            "planned",
            "blocked"
          ]
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "resolvedAt": {
          "oneOf": [
            {
              "type": "string",
              "format": "date-time",
              "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
            },
            {
              "type": "null"
            }
          ]
        },
        "requestDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "policyDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "catalogDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "contextDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "overrideDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "snapshotRevision": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "binding": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "projectId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "repoId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "sourceSha": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{40}$"
                },
                "baseSha": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{40}$"
                },
                "unitId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "attemptId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "ownerId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "policyDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "reviewPolicyDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "catalogDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "role": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "risk": {
                  "enum": [
                    "low",
                    "moderate",
                    "high"
                  ]
                }
              },
              "required": [
                "projectId",
                "repoId",
                "sourceSha",
                "baseSha",
                "unitId",
                "attemptId",
                "ownerId",
                "policyDigest",
                "reviewPolicyDigest",
                "catalogDigest",
                "role",
                "risk"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "requestedProfile": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "selected": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "profileId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "entryId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "provider": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "model": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "family": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "surface": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "runtimeVersion": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "adapterVersion": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "adapterDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                },
                "executionId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "requestedEffort": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "explicit"
                        },
                        "value": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        }
                      },
                      "required": [
                        "kind",
                        "value"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "intent"
                        },
                        "mappingId": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "intent": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        }
                      },
                      "required": [
                        "kind",
                        "mappingId",
                        "intent"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "const": "omit"
                        }
                      },
                      "required": [
                        "kind"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "plannedEmission": {
                  "type": "object",
                  "properties": {
                    "parameter": {
                      "oneOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "value": {
                      "oneOf": [
                        {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "parameter",
                    "value"
                  ],
                  "additionalProperties": false
                },
                "emittedEffort": {
                  "const": "unknown"
                },
                "observedEffective": {
                  "type": "object",
                  "properties": {
                    "provider": {
                      "const": "unknown"
                    },
                    "model": {
                      "const": "unknown"
                    },
                    "family": {
                      "const": "unknown"
                    },
                    "effort": {
                      "const": "unknown"
                    }
                  },
                  "required": [
                    "provider",
                    "model",
                    "family",
                    "effort"
                  ],
                  "additionalProperties": false
                },
                "evidenceRefs": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "minItems": 1,
                  "maxItems": 128,
                  "uniqueItems": true
                },
                "evidence": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "enum": [
                          "capability",
                          "availability",
                          "entitlement",
                          "budget",
                          "service"
                        ]
                      },
                      "issuer": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "reference": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "observedAt": {
                        "type": "string",
                        "format": "date-time",
                        "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                      },
                      "expiresAt": {
                        "type": "string",
                        "format": "date-time",
                        "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                      },
                      "scope": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "digest": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      },
                      "status": {
                        "enum": [
                          "confirmed",
                          "unavailable",
                          "unknown"
                        ]
                      },
                      "billing": {
                        "enum": [
                          "subscription_included",
                          "none"
                        ]
                      },
                      "executionId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "ageSeconds": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 9007199254740991
                      }
                    },
                    "required": [
                      "kind",
                      "issuer",
                      "reference",
                      "observedAt",
                      "expiresAt",
                      "scope",
                      "digest",
                      "status",
                      "billing",
                      "executionId",
                      "ageSeconds"
                    ],
                    "additionalProperties": false
                  },
                  "minItems": 1,
                  "maxItems": 128,
                  "uniqueItems": true
                }
              },
              "required": [
                "profileId",
                "entryId",
                "provider",
                "model",
                "family",
                "surface",
                "runtimeVersion",
                "adapterVersion",
                "adapterDigest",
                "executionId",
                "requestedEffort",
                "plannedEmission",
                "emittedEffort",
                "observedEffective",
                "evidenceRefs",
                "evidence"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "reviewPlans": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "obligationId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "selection": {
                "type": "object",
                "properties": {
                  "profileId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "entryId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "provider": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "model": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "family": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "surface": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "runtimeVersion": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "adapterVersion": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "adapterDigest": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "executionId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "requestedEffort": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "explicit"
                          },
                          "value": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "intent"
                          },
                          "mappingId": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          "intent": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          }
                        },
                        "required": [
                          "kind",
                          "mappingId",
                          "intent"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "omit"
                          }
                        },
                        "required": [
                          "kind"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "plannedEmission": {
                    "type": "object",
                    "properties": {
                      "parameter": {
                        "oneOf": [
                          {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      },
                      "value": {
                        "oneOf": [
                          {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          {
                            "type": "null"
                          }
                        ]
                      }
                    },
                    "required": [
                      "parameter",
                      "value"
                    ],
                    "additionalProperties": false
                  },
                  "emittedEffort": {
                    "const": "unknown"
                  },
                  "observedEffective": {
                    "type": "object",
                    "properties": {
                      "provider": {
                        "const": "unknown"
                      },
                      "model": {
                        "const": "unknown"
                      },
                      "family": {
                        "const": "unknown"
                      },
                      "effort": {
                        "const": "unknown"
                      }
                    },
                    "required": [
                      "provider",
                      "model",
                      "family",
                      "effort"
                    ],
                    "additionalProperties": false
                  },
                  "evidenceRefs": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "minItems": 1,
                    "maxItems": 128,
                    "uniqueItems": true
                  },
                  "evidence": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "enum": [
                            "capability",
                            "availability",
                            "entitlement",
                            "budget",
                            "service"
                          ]
                        },
                        "issuer": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "reference": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "observedAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                        },
                        "expiresAt": {
                          "type": "string",
                          "format": "date-time",
                          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                        },
                        "scope": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "digest": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        },
                        "status": {
                          "enum": [
                            "confirmed",
                            "unavailable",
                            "unknown"
                          ]
                        },
                        "billing": {
                          "enum": [
                            "subscription_included",
                            "none"
                          ]
                        },
                        "executionId": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 160,
                          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                        },
                        "ageSeconds": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        }
                      },
                      "required": [
                        "kind",
                        "issuer",
                        "reference",
                        "observedAt",
                        "expiresAt",
                        "scope",
                        "digest",
                        "status",
                        "billing",
                        "executionId",
                        "ageSeconds"
                      ],
                      "additionalProperties": false
                    },
                    "minItems": 1,
                    "maxItems": 128,
                    "uniqueItems": true
                  }
                },
                "required": [
                  "profileId",
                  "entryId",
                  "provider",
                  "model",
                  "family",
                  "surface",
                  "runtimeVersion",
                  "adapterVersion",
                  "adapterDigest",
                  "executionId",
                  "requestedEffort",
                  "plannedEmission",
                  "emittedEffort",
                  "observedEffective",
                  "evidenceRefs",
                  "evidence"
                ],
                "additionalProperties": false
              },
              "subject": {
                "oneOf": [
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "planned_output"
                      },
                      "unitId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      },
                      "attemptId": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 160,
                        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                      }
                    },
                    "required": [
                      "kind",
                      "unitId",
                      "attemptId"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "const": "existing_artifact"
                      },
                      "sourceSha": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{40}$"
                      },
                      "artifactDigest": {
                        "type": "string",
                        "pattern": "^[a-f0-9]{64}$"
                      }
                    },
                    "required": [
                      "kind",
                      "sourceSha",
                      "artifactDigest"
                    ],
                    "additionalProperties": false
                  }
                ]
              },
              "independenceAuthors": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "executionId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "provider": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "family": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "executionId",
                    "provider",
                    "family"
                  ],
                  "additionalProperties": false
                },
                "minItems": 1,
                "maxItems": 130,
                "uniqueItems": true
              },
              "obligation": {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "independent": {
                    "const": true
                  },
                  "crossFamily": {
                    "type": "boolean"
                  },
                  "binding": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "named"
                          },
                          "provider": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          "model": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          "family": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          "explicitEffort": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 160,
                            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                          },
                          "profiles": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "minItems": 1,
                            "maxItems": 128,
                            "uniqueItems": true
                          }
                        },
                        "required": [
                          "kind",
                          "provider",
                          "model",
                          "family",
                          "explicitEffort",
                          "profiles"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "const": "capability"
                          },
                          "capability": {
                            "enum": [
                              "correctness",
                              "deep"
                            ]
                          },
                          "coverage": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "minItems": 1,
                            "maxItems": 128,
                            "uniqueItems": true
                          },
                          "primaryProfiles": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "minItems": 1,
                            "maxItems": 128,
                            "uniqueItems": true
                          },
                          "fallbackProfiles": {
                            "type": "array",
                            "items": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "minItems": 0,
                            "maxItems": 128,
                            "uniqueItems": true
                          },
                          "fallbackWhen": {
                            "const": "confirmed_unavailable"
                          }
                        },
                        "required": [
                          "kind",
                          "capability",
                          "coverage",
                          "primaryProfiles",
                          "fallbackProfiles",
                          "fallbackWhen"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  }
                },
                "required": [
                  "id",
                  "independent",
                  "crossFamily",
                  "binding"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "obligationId",
              "selection",
              "subject",
              "independenceAuthors",
              "obligation"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "rejections": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "profileId",
              "reason"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "budget": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "ceiling": {
                  "type": "object",
                  "properties": {
                    "tokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "wallTimeMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "attempts": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "tokens",
                    "wallTimeMs",
                    "attempts"
                  ],
                  "additionalProperties": false
                },
                "consumed": {
                  "type": "object",
                  "properties": {
                    "tokens": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "wallTimeMs": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "attempts": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "tokens",
                    "wallTimeMs",
                    "attempts"
                  ],
                  "additionalProperties": false
                },
                "repairRounds": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "noProgress": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "similarFailures": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "deadline": {
                  "type": "string",
                  "format": "date-time",
                  "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
                },
                "evidenceRef": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                }
              },
              "required": [
                "ceiling",
                "consumed",
                "repairRounds",
                "noProgress",
                "similarFailures",
                "deadline",
                "evidenceRef"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "appliedBudgetLimits": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            {
              "type": "null"
            }
          ]
        },
        "compliance": {
          "const": "unverified"
        },
        "requestedEffort": {
          "oneOf": [
            {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "explicit"
                    },
                    "value": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "kind",
                    "value"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "intent"
                    },
                    "mappingId": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "intent": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    }
                  },
                  "required": [
                    "kind",
                    "mappingId",
                    "intent"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "const": "omit"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "artifactDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "diffDigest": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "policyRevision": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "catalogRevision": {
          "oneOf": [
            {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            {
              "type": "null"
            }
          ]
        },
        "fallbackEvidence": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "appliedCounterLimits": {
          "oneOf": [
            {
              "type": "null"
            },
            {
              "type": "object",
              "properties": {
                "maxRepairRounds": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2
                },
                "maxNoProgress": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 2
                },
                "maxSimilarFailures": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 3
                }
              },
              "required": [
                "maxRepairRounds",
                "maxNoProgress",
                "maxSimilarFailures"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "required": [
        "schema",
        "status",
        "reason",
        "resolvedAt",
        "requestDigest",
        "policyDigest",
        "catalogDigest",
        "contextDigest",
        "overrideDigest",
        "snapshotRevision",
        "binding",
        "requestedProfile",
        "selected",
        "reviewPlans",
        "rejections",
        "budget",
        "appliedBudgetLimits",
        "compliance",
        "requestedEffort",
        "artifactDigest",
        "diffDigest",
        "policyRevision",
        "catalogRevision",
        "fallbackEvidence",
        "appliedCounterLimits"
      ],
      "additionalProperties": false
    },
    "reviewCompletion": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:review-completion:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.review-completion.v1"
        },
        "id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "baseSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "headSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "artifactDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "diffDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "catalogDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "policyRevision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "catalogRevision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "contextDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "planDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "slotId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "subject": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "planned_output"
                },
                "unitId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                },
                "attemptId": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 160,
                  "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                }
              },
              "required": [
                "kind",
                "unitId",
                "attemptId"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "const": "existing_artifact"
                },
                "sourceSha": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{40}$"
                },
                "artifactDigest": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "kind",
                "sourceSha",
                "artifactDigest"
              ],
              "additionalProperties": false
            }
          ]
        },
        "authors": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "executionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "executionId",
              "provider",
              "family"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "executionId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "adapterDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "adapterVersion": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "surface": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "runtimeVersion": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "requested": {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "effort": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "provider",
            "model",
            "family",
            "effort"
          ],
          "additionalProperties": false
        },
        "selected": {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "effort": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "provider",
            "model",
            "family",
            "effort"
          ],
          "additionalProperties": false
        },
        "emitted": {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "effort": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "provider",
            "model",
            "family",
            "effort"
          ],
          "additionalProperties": false
        },
        "observed": {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "family": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "effort": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "provider",
            "model",
            "family",
            "effort"
          ],
          "additionalProperties": false
        },
        "observationRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "issuer": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "startedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "completedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "resultDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "verdict": {
          "enum": [
            "pass",
            "changes_required",
            "blocked"
          ]
        },
        "findings": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "actionable": {
                "type": "boolean"
              },
              "disposition": {
                "enum": [
                  "open",
                  "resolved",
                  "not_actionable"
                ]
              }
            },
            "required": [
              "id",
              "actionable",
              "disposition"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "tests": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "headSha": {
                "type": "string",
                "pattern": "^[a-f0-9]{40}$"
              },
              "digest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "status": {
                "enum": [
                  "pass",
                  "fail",
                  "skip",
                  "timeout"
                ]
              }
            },
            "required": [
              "id",
              "headSha",
              "digest",
              "status"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "usage": {
          "type": "object",
          "properties": {
            "tokens": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "wallTimeMs": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "attempts": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "tokens",
            "wallTimeMs",
            "attempts"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "schema",
        "id",
        "repoId",
        "baseSha",
        "headSha",
        "artifactDigest",
        "diffDigest",
        "policyDigest",
        "catalogDigest",
        "policyRevision",
        "catalogRevision",
        "contextDigest",
        "planDigest",
        "slotId",
        "subject",
        "authors",
        "executionId",
        "adapterDigest",
        "adapterVersion",
        "surface",
        "runtimeVersion",
        "requested",
        "selected",
        "emitted",
        "observed",
        "observationRef",
        "issuer",
        "startedAt",
        "completedAt",
        "expiresAt",
        "resultDigest",
        "verdict",
        "findings",
        "tests",
        "usage"
      ],
      "additionalProperties": false
    },
    "reviewCompletionContext": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:model-routing:review-completion-context:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "model-routing.review-completion-context.v1"
        },
        "expected": {
          "type": "object",
          "properties": {
            "repoId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            },
            "baseSha": {
              "type": "string",
              "pattern": "^[a-f0-9]{40}$"
            },
            "headSha": {
              "type": "string",
              "pattern": "^[a-f0-9]{40}$"
            },
            "artifactDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "diffDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "policyDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "catalogDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "contextDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "planDigest": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "repoId",
            "baseSha",
            "headSha",
            "artifactDigest",
            "diffDigest",
            "policyDigest",
            "catalogDigest",
            "contextDigest",
            "planDigest"
          ],
          "additionalProperties": false
        },
        "observations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "receiptId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "receiptDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "issuer": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "reference": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "observedAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time",
                "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
              },
              "executionId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "identity": {
                "type": "object",
                "properties": {
                  "provider": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "model": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "family": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  },
                  "effort": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 160,
                    "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                  }
                },
                "required": [
                  "provider",
                  "model",
                  "family",
                  "effort"
                ],
                "additionalProperties": false
              },
              "resultDigest": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              }
            },
            "required": [
              "receiptId",
              "receiptDigest",
              "issuer",
              "reference",
              "observedAt",
              "expiresAt",
              "executionId",
              "identity",
              "resultDigest"
            ],
            "additionalProperties": false
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "usedReceiptIds": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 160,
            "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "usedResultDigests": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "minItems": 0,
          "maxItems": 128,
          "uniqueItems": true
        },
        "budget": {
          "type": "object",
          "properties": {
            "ceiling": {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            "consumed": {
              "type": "object",
              "properties": {
                "tokens": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "wallTimeMs": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "attempts": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                }
              },
              "required": [
                "tokens",
                "wallTimeMs",
                "attempts"
              ],
              "additionalProperties": false
            },
            "repairRounds": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "noProgress": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "similarFailures": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "deadline": {
              "type": "string",
              "format": "date-time",
              "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
            },
            "evidenceRef": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160,
              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
            }
          },
          "required": [
            "ceiling",
            "consumed",
            "repairRounds",
            "noProgress",
            "similarFailures",
            "deadline",
            "evidenceRef"
          ],
          "additionalProperties": false
        },
        "limits": {
          "type": "object",
          "properties": {
            "maxRepairRounds": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2
            },
            "maxNoProgress": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2
            },
            "maxSimilarFailures": {
              "type": "integer",
              "minimum": 1,
              "maximum": 3
            }
          },
          "required": [
            "maxRepairRounds",
            "maxNoProgress",
            "maxSimilarFailures"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "schema",
        "expected",
        "observations",
        "usedReceiptIds",
        "usedResultDigests",
        "budget",
        "limits"
      ],
      "additionalProperties": false
    },
    "reviewPolicy": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:review-policy:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "review-policy.v1"
        },
        "version": {
          "const": 1
        },
        "revision": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "enabled": {
          "type": "boolean"
        },
        "ownerHandle": {
          "oneOf": [
            {
              "type": "string",
              "pattern": "^@[A-Za-z0-9][\\w.-]*(?:\\/[\\w.-]+)?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "reviewRules": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "risk": {
                "enum": [
                  "low",
                  "moderate",
                  "high"
                ]
              },
              "slots": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "id": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160,
                      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                    },
                    "independent": {
                      "const": true
                    },
                    "crossFamily": {
                      "type": "boolean"
                    },
                    "binding": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "named"
                            },
                            "provider": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "model": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "family": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "explicitEffort": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 160,
                              "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                            },
                            "profiles": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 1,
                              "maxItems": 128,
                              "uniqueItems": true
                            }
                          },
                          "required": [
                            "kind",
                            "provider",
                            "model",
                            "family",
                            "explicitEffort",
                            "profiles"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "const": "capability"
                            },
                            "capability": {
                              "enum": [
                                "correctness",
                                "deep"
                              ]
                            },
                            "coverage": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 1,
                              "maxItems": 128,
                              "uniqueItems": true
                            },
                            "primaryProfiles": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 1,
                              "maxItems": 128,
                              "uniqueItems": true
                            },
                            "fallbackProfiles": {
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 160,
                                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
                              },
                              "minItems": 0,
                              "maxItems": 128,
                              "uniqueItems": true
                            },
                            "fallbackWhen": {
                              "const": "confirmed_unavailable"
                            }
                          },
                          "required": [
                            "kind",
                            "capability",
                            "coverage",
                            "primaryProfiles",
                            "fallbackProfiles",
                            "fallbackWhen"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  "required": [
                    "id",
                    "independent",
                    "crossFamily",
                    "binding"
                  ],
                  "additionalProperties": false
                },
                "minItems": 0,
                "maxItems": 128,
                "uniqueItems": true
              }
            },
            "required": [
              "risk",
              "slots"
            ],
            "additionalProperties": false
          },
          "minItems": 3,
          "maxItems": 128,
          "uniqueItems": true
        },
        "bindings": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "model": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "surface": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "effort": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "parameter": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "profileId",
              "provider",
              "model",
              "family",
              "surface",
              "effort",
              "parameter"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "legacyRequirementPolicy": {
          "const": "preserve-until-transition"
        }
      },
      "required": [
        "schema",
        "version",
        "revision",
        "enabled",
        "ownerHandle",
        "reviewRules",
        "bindings",
        "legacyRequirementPolicy"
      ],
      "additionalProperties": false
    },
    "reviewTransition": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:review-transition:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "review-transition.v1"
        },
        "repoId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "baseSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "headSha": {
          "type": "string",
          "pattern": "^[a-f0-9]{40}$"
        },
        "patchDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "oldPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "newPolicyDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "allowedBindings": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "profileId": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "provider": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "model": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "family": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "surface": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "effort": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              },
              "parameter": {
                "type": "string",
                "minLength": 1,
                "maxLength": 160,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
              }
            },
            "required": [
              "profileId",
              "provider",
              "model",
              "family",
              "surface",
              "effort",
              "parameter"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "maxItems": 128,
          "uniqueItems": true
        },
        "predicates": {
          "type": "object",
          "properties": {
            "executionIndependence": {
              "const": true
            },
            "preserveExplicitDiversity": {
              "const": true
            },
            "distinctSlots": {
              "const": true
            }
          },
          "required": [
            "executionIndependence",
            "preserveExplicitDiversity",
            "distinctSlots"
          ],
          "additionalProperties": false
        },
        "sourceReviewDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "authorizationRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "issuedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        }
      },
      "required": [
        "schema",
        "repoId",
        "baseSha",
        "headSha",
        "patchDigest",
        "oldPolicyDigest",
        "newPolicyDigest",
        "allowedBindings",
        "predicates",
        "sourceReviewDigest",
        "authorizationRef",
        "issuedAt",
        "expiresAt"
      ],
      "additionalProperties": false
    },
    "reviewTransitionAuthorization": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "urn:pstack:review-transition-authorization:v1",
      "type": "object",
      "properties": {
        "schema": {
          "const": "review-transition-authorization.v1"
        },
        "issuer": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "ownerHandle": {
          "type": "string",
          "pattern": "^@[A-Za-z0-9][\\w.-]*(?:\\/[\\w.-]+)?$"
        },
        "reference": {
          "type": "string",
          "minLength": 1,
          "maxLength": 160,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]*$"
        },
        "transitionDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "sourceReviewDigest": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "observedAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        },
        "expiresAt": {
          "type": "string",
          "format": "date-time",
          "pattern": "^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\dZ$"
        }
      },
      "required": [
        "schema",
        "issuer",
        "ownerHandle",
        "reference",
        "transitionDigest",
        "sourceReviewDigest",
        "observedAt",
        "expiresAt"
      ],
      "additionalProperties": false
    }
  };
}

const REVIEW_COVERAGE = freeze({
  correctness: ['contracts', 'invalid-input', 'tests', 'documentation', 'regressions'],
  deep: ['security', 'data-money', 'architecture', 'concurrency', 'gate-integrity', 'sensitive-files', 'adversarial-evidence'],
});
const cloneJSON = value => JSON.parse(canonicalJSON(value));

/** Reserved unknown observations cannot stand in for a selected or effective identity. */
export function isKnownRoutingValue(value) {
  return typeof value === 'string' && value.length > 0 && !/^unknown$/i.test(value);
}

function originalV2EvidenceProblem(catalog, context) {
  if (catalog.entries.some(entry => ['provider', 'model', 'family'].some(k => !isKnownRoutingValue(entry[k])) ||
      entry.supportedEfforts.some(value => !isKnownRoutingValue(value)))) return 'unknown_catalog_identity';
  for (const proof of context.evidence) {
    if (!['capability', 'availability', 'entitlement'].includes(proof.kind)) continue;
    const entry = catalog.entries.find(e => e.id === proof.scope);
    if (!entry || proof.digest !== digest(entry)) return 'invalid_original_entry_evidence';
  }
  return null;
}


function v2Blocked(reason) {
  return freeze({ ...resolveRouting(null), schema: 'model-routing.receipt.v2', reason,
    artifactDigest: null, diffDigest: null, policyRevision: null, catalogRevision: null, fallbackEvidence: [], appliedCounterLimits: null });
}

function checkV2Input(input) {
  try { canonicalJSON(input); } catch { return 'invalid_json'; }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k =>
    !['policy', 'catalog', 'trustedContext', 'request', 'override', 'now'].includes(k))) return 'invalid_input';
  if (input.override != null) return 'v2_override_unsupported';
  for (const [name, value] of [['policy', input.policy], ['catalog', input.catalog], ['context', input.trustedContext]]) {
    if (!validateV2(name, value).valid) return 'invalid_' + name;
  }
  if (!validate('request', input.request).valid || !timestamp(input.now)) return 'invalid_request_or_time';
  const { policy: p, catalog: c, trustedContext: t, request: r } = input;
  if (t.policyDigest !== digest(p) || t.catalogDigest !== digest(c) || p.catalogDigest !== digest(c) ||
      bindingKeys.some(k => !equal(r[k], t[k]))) return 'digest_or_context_mismatch';
  const evidenceProblem = originalV2EvidenceProblem(c, t);
  if (evidenceProblem) return evidenceProblem;
  if (t.reviewSubject.kind === 'existing_artifact' && t.reviewSubject.artifactDigest !== t.artifactDigest) return 'review_subject_mismatch';
  if (new Set(p.reviewRules.map(x => x.risk)).size !== 3 || p.reviewRules.length !== 3) return 'ambiguous_review_rules';
  for (const rule of p.reviewRules) {
    const ids = rule.slots.map(x => x.id);
    if (new Set(ids).size !== ids.length ||
        (rule.risk !== 'low' && !ids.includes('correctness')) ||
        (rule.risk === 'high' && !ids.includes('deep'))) return 'missing_review_slot';
    for (const slot of rule.slots) {
      const b = slot.binding, required = REVIEW_COVERAGE[b.kind === 'capability' ? b.capability : slot.id] ?? [];
      if (b.kind === 'capability' && ((REVIEW_COVERAGE[slot.id] && b.capability !== slot.id) || required.some(x => !b.coverage.includes(x)))) return 'missing_review_coverage';
      const profiles = b.kind === 'named' ? b.profiles : [...b.primaryProfiles, ...b.fallbackProfiles];
      if (new Set(profiles).size !== profiles.length || profiles.some(id => !p.profiles.some(x => x.id === id))) return 'unresolved_review_profile';
    }
  }
  const tuples = new Map();
  for (const entry of c.entries) {
    const key = canonicalJSON([entry.provider, entry.model, entry.surface, entry.runtimeVersion, entry.adapterVersion]);
    const { id, ...contract } = entry;
    if (tuples.has(key) && !equal(tuples.get(key), contract)) return 'conflicting_execution_bindings';
    tuples.set(key, contract);
  }
  return null;
}

function projectV2(input) {
  const p = cloneJSON(input);
  delete p.override;
  p.policy.schema = 'model-routing.policy.v1'; delete p.policy.reviewRules;
  p.catalog.schema = 'model-routing.catalog.v1';
  for (const e of p.catalog.entries) { delete e.reviewCapabilities; delete e.reviewCoverage; }
  const t = p.trustedContext;
  t.schema = 'model-routing.context.v1'; t.reviews = [];
  delete t.reviewSubject; delete t.artifactDigest; delete t.diffDigest;
  for (const proof of t.evidence) {
    delete proof.failure;
    // Only fully bound entry proofs validated above may enter the v1 projection.
    if (['capability', 'availability', 'entitlement'].includes(proof.kind)) {
      proof.digest = digest(p.catalog.entries.find(e => e.id === proof.scope));
    }
  }
  p.policy.catalogDigest = digest(p.catalog);
  t.catalogDigest = p.policy.catalogDigest; t.policyDigest = digest(p.policy);
  p.request.catalogDigest = t.catalogDigest; p.request.policyDigest = t.policyDigest;
  return p;
}

function confirmedUnavailable(input, profileId) {
  const profile = input.policy.profiles.find(p => p.id === profileId);
  const entry = input.catalog.entries.find(e => e.id === profile.entryId);
  const proof = input.trustedContext.evidence.find(e => e.kind === 'availability' && e.scope === entry?.id);
  const now = Date.parse(input.now);
  return proof && proof.status === 'unavailable' && proof.failure !== null && proof.digest === digest(entry) &&
    Date.parse(proof.observedAt) <= now && now < Date.parse(proof.expiresAt) &&
    now - Date.parse(proof.observedAt) <= input.policy.maxEvidenceAgeSeconds * 1000 ? proof.reference : null;
}

function reviewCandidates(input, slot) {
  const b = slot.binding;
  if (b.kind === 'named') return { profiles: b.profiles, fallbackEvidence: [] };
  const unavailable = b.primaryProfiles.map(id => confirmedUnavailable(input, id));
  return unavailable.every(Boolean)
    ? { profiles: b.fallbackProfiles, fallbackEvidence: unavailable }
    : { profiles: b.primaryProfiles, fallbackEvidence: [] };
}

function exactObligation(input, slot, profileId) {
  const profile = input.policy.profiles.find(p => p.id === profileId);
  const entry = input.catalog.entries.find(e => e.id === profile.entryId);
  if (!entry || profile.effort.kind !== 'explicit') return null;
  const binding = slot.binding;
  if (binding.kind === 'capability' && (!entry.reviewCapabilities.includes(binding.capability) ||
      binding.coverage.some(c => !entry.reviewCoverage.includes(c)))) return null;
  if (binding.kind === 'named' && (entry.provider !== binding.provider || entry.model !== binding.model ||
      entry.family !== binding.family || profile.effort.value !== binding.explicitEffort)) return null;
  return { id: slot.id, kind: 'model', subject: cloneJSON(input.trustedContext.reviewSubject),
    provider: entry.provider, model: entry.model, family: entry.family, explicitEffort: profile.effort.value,
    independent: slot.independent, crossFamily: slot.crossFamily, candidates: [profileId] };
}

function tryReviewSlot(input, projected, chosen, slot, executionIds) {
  const candidates = reviewCandidates(input, slot);
  for (const profileId of candidates.profiles) {
    const obligation = exactObligation(input, slot, profileId);
    if (!obligation) continue;
    projected.trustedContext.reviews = [...chosen, obligation];
    const result = resolveRoutingCore(projected, true);
    if (result.status !== 'planned') continue;
    const review = result.reviewPlans.at(-1);
    if (executionIds.has(review.selection.executionId)) continue;
    if (slot.crossFamily && review.independenceAuthors.some(a => a.provider === review.selection.provider)) continue;
    return { obligation, result, fallbackEvidence: candidates.fallbackEvidence };
  }
  return null;
}

function restoreV2Receipt(input, result, slots, fallbackEvidence) {
  const out = cloneJSON(result), t = input.trustedContext;
  out.schema = 'model-routing.receipt.v2'; out.policyDigest = digest(input.policy);
  out.catalogDigest = digest(input.catalog); out.contextDigest = digest(t); out.requestDigest = digest(input.request);
  out.binding = Object.fromEntries(bindingKeys.map(k => [k, t[k]]));
  out.artifactDigest = t.artifactDigest; out.diffDigest = t.diffDigest;
  out.policyRevision = input.policy.revision; out.catalogRevision = input.catalog.revision;
  out.fallbackEvidence = [...new Set(fallbackEvidence)];
  out.appliedCounterLimits = Object.fromEntries(['maxRepairRounds','maxNoProgress','maxSimilarFailures'].map(k => [k,input.policy[k]]));
  for (const review of out.reviewPlans) review.obligation = cloneJSON(slots.find(s => s.id === review.obligationId));
  for (const selection of [out.selected, ...out.reviewPlans.map(r => r.selection)].filter(Boolean)) {
    for (const proof of selection.evidence) {
      const original = t.evidence.find(e => e.reference === proof.reference);
      proof.digest = original.digest;
    }
  }
  return freeze(out);
}

/** Plan v2 capability reviews using only approved inputs; does not accept completed reviews. */
export function resolveRoutingV2(input) {
  const problem = checkV2Input(input);
  if (problem) return v2Blocked(problem);
  const projected = projectV2(input);
  let result = resolveRoutingCore(projected, true);
  if (result.status !== 'planned') return v2Blocked(result.reason);
  const slots = input.policy.reviewRules.find(r => r.risk === input.trustedContext.risk).slots;
  const chosen = [], executionIds = new Set(), fallbackEvidence = [];
  for (const slot of slots) {
    const attempt = tryReviewSlot(input, projected, chosen, slot, executionIds);
    if (!attempt) return v2Blocked('mandatory_review_unavailable');
    chosen.push(attempt.obligation); result = attempt.result;
    executionIds.add(result.reviewPlans.at(-1).selection.executionId);
    fallbackEvidence.push(...attempt.fallbackEvidence);
  }
  return restoreV2Receipt(input, result, slots, fallbackEvidence);
}
