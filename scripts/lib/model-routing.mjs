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
  const errors = walk(schemas[name], value, '$');
  return { valid: errors.length === 0, errors };
}

const bindingKeys = Object.keys(schemas.request.properties).filter(k => !['schema', 'mode', 'requestedProfile', 'requiredCapabilities', 'actions'].includes(k));
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);
const uniqueIds = xs => new Set(xs.map(x => x.id)).size === xs.length;
const limitKeys = ['tokens', 'wallTimeMs', 'attempts'];

/** Inert draft: trustedContext/policy/catalog/override must come from an authenticated
 * controller, not request data. Checks declarations, not authenticity. Never admits. */
export function resolveRouting(input) {
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
  const entries = new Map(catalog.entries.map(x => [x.id, x]));
  const profiles = new Map(policy.profiles.map(x => [x.id, x]));
  if (profiles.has(request.requestedProfile)) output.requestedProfile = request.requestedProfile;
  if (new Set(catalog.entries.map(e => canonicalJSON([e.provider, e.model, e.surface, e.runtimeVersion, e.adapterVersion]))).size !== catalog.entries.length) return finish('ambiguous_catalog');
  if (new Set(policy.rules.map(x => `${x.role}:${x.risk}`)).size !== policy.rules.length) return finish('ambiguous_rules');
  if (catalog.entries.some(e => !uniqueIds(e.mappings) || /(^|[-_.])latest($|[-_.])/i.test(e.model) ||
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
      if ((obligation.independent && executionId === context.writer.executionId) ||
          (obligation.crossFamily && e.family === context.writer.family)) return bad('review_not_independent');
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
    output.reviewPlans.push({ obligationId: obligation.id, selection: selected });
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
              "candidates"
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
        "overrideAuthorizations"
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
              }
            },
            "required": [
              "obligationId",
              "selection"
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
