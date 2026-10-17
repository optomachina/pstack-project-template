# Model routing A0 — proposed and inactive

This is an isolated offline contract draft. Nothing loads it into a controller,
changes a project default, starts a provider, or makes a review pass. Treat the
entire unit as governance: independent Opus and applicable project reviews remain
required. GPT plan review is not named Claude review. Do not land this as ordinary
low-risk documentation or scripts. A1 must first reserve and protect every routing
schema, registry/configuration, resolver and documentation path and separately
review sync/consumer integration. Existing review rules are unchanged.

## API and trust boundary

`model-routing.mjs` exports `schemas`, `validate(name, value)`, `canonicalJSON`,
`digest`, and `resolveRouting({policy, catalog, trustedContext, request, override?, now})`.
Names accepted by `validate` are policy, override, catalog, request, receipt and
context. Every nested object is closed; there are no implicit policy defaults.
`override` may be absent or null. All other top-level inputs are mandatory.

Only `request` is untrusted request data. An authenticated controller must load the
other inputs from approved control-plane state, authenticate evidence issuers,
resolve the authoritative risk/review policy, and establish ownership. Never merge
request fields into trusted context. A digest proves content equality, not approval,
entitlement, caller identity, provenance or resource reservation. A0 checks declared
bindings and temporal validity only; synthetic evidence never proves live access.

The request repeats context's project/repository, exact source/base SHA, unit,
attempt, owner, role, risk and policy/review-policy/catalog digests. Disagreement,
including differing ordered capabilities/actions, blocks. `snapshotRevision` pins
the controller snapshot. The controller supplies immutable `writer` provenance,
the explicit `existingContributors` array, and all mandatory review obligations.
Empty obligations are appropriate only when the authenticated review policy
requires none; the resolver cannot infer the real
review graph from its digest. Request data cannot add or remove obligations.

Every obligation requires a closed `subject` union. A `planned_output` subject names
this context's `unitId` and `attemptId`; an `existing_artifact` subject names this
context's exact `sourceSha` and the immutable artifact's `artifactDigest`. Missing,
ambiguous or mismatched subjects block. The authenticated controller establishes
the artifact digest and complete contributor provenance; A0 does not read artifact
bytes or infer authors from Git. The request cannot redefine subjects or authors.

For either subject, required execution/family independence is checked against
`writer` and every `existingContributors` identity. For planned output, it is also
checked against `context.execution`, the new producer. Every eligible main candidate
must exactly match that pinned execution ID/provider/family before the resolver can
return `planned`, so this includes the selected producer even when the prior author
differs. For an existing artifact, the current reviewing execution is not treated
as its author merely because it is the current job; a reviewer-role execution may
legitimately match the review plan while remaining independent of all artifact
authors. An existing-artifact obligation does not cover future output. The trusted
review policy must explicitly require a planned-output obligation when needed.

A request's mode must be `new` to produce a plan. `running` and `handoff` are
recognized negative cases returning `integration_deferred`. A new approved policy
may select another provider for a new job with newly bound execution context and
evidence. Existing jobs retain their snapshots. Actual checkpoint authorization,
old-worker quiescence/fencing, uncertain tool reconciliation and exactly-once
resumption belong to the controller, not this library.

## Resolution

1. Validate all input shapes, injected UTC time, policy/catalog validity and exact
   request/context/content bindings. Reject duplicate IDs, ambiguous role/risk
   rules or exact catalog keys, unresolved references and model `latest` aliases.
2. Match exactly one role/risk rule. An override must be allowed, scoped, current,
   unused and bound to an authenticated authorization record and policy digest.
   Its ordered candidates must be in both the rule and override envelope. Budgets
   may only tighten. Reject the whole invalid override; never silently restore a
   baseline or partially apply it. A caller may separately request baseline planning.
3. Check the inherited budget deadline, consumed amounts and repair/replan counters.
   The supported ceilings are finite tokens, wall-time milliseconds and attempts.
   The combined repair ceiling is at most two, no-progress ceiling at most two,
   and materially similar failures ceiling at most three. Infrastructure-failure
   classification is the trusted controller's responsibility.
4. Plan every mandatory review, enforcing exact provider/model/family, explicit
   effort where required, subject-bound execution independence and family
   independence against every relevant author, including the new producer for
   planned output.
   A mandatory service step additionally requires a fresh confirmed service record;
   an agent's claim or prediction score is not such evidence. Plans are never
   completed reviews, including when synthetic service evidence is supplied.
5. Walk only the explicitly eligible candidate list, promoting a requested profile
   only within that list. Record rejected candidates; take the first eligible route
   whose reservation plus all review reservations fits remaining budgets/deadline.
   There is no retry, automatic escalation or paid/API fallback.

Each candidate needs fresh capability, availability and included-subscription
entitlement evidence. The evidence scope is the catalog entry ID and its digest
covers the complete exact provider/model/family/surface/runtime/adapter record.
All three records must agree on execution ID. Main execution must match the trusted
execution identity; review execution must meet its independence predicates.
The catalog key is provider/model/surface/runtimeVersion/adapterVersion. Changing
any record requires fresh evidence/content bindings, not a compatibility guess.

Evidence timestamps must bracket `now`; expiry is exclusive. Maximum evidence age
is inclusive and applies separately to each selected record. Policy, catalog,
entry, override and authorization validity are also checked. Budget evidence uses
the unit ID as scope and `digest(context.budget)` as digest, including its evidence
reference. Service evidence uses obligation ID and `digest(obligation)`. The
controller authenticates issuer/reference semantics; A0 does not fetch references.

Effort is one of `{kind: "explicit", value}`, `{kind: "intent", mappingId, intent}`,
or `{kind: "omit"}`. Explicit effort must be exactly supported. Intent requires an
explicitly approved, catalog-versioned mapping; no nearest-value conversion occurs.
Omission requires policy permission and catalog support and cannot meet an explicit
effort obligation. `unknown` is never a supported requested effort. Catalog entries
with no native control use `parameter: null`, empty supported/mapping arrays and
explicit omission. Multi-agent records (`agentCount > 1`) are conservatively blocked
in A0; no delegation/resource authorization is inferred from an effort label.

## Receipts and limitations

Receipts have only `planned` or `blocked`, with `compliance: "unverified"`.
The receipt schema deliberately restricts states to A0; later lifecycle states need
separate versioned integration work. It preserves request/context/policy/catalog/
override digests, source bindings, snapshot revision, inherited budget counters,
applied ceiling, review plans and bounded rejection reasons. Each review plan
retains its exact subject and `independenceAuthors` identities. Duplicate identical
author identities are recorded once. These provenance fields remain unverified
controller declarations, not a completed review receipt. Requested profile and
original requested effort are separate from selected profile/requested effort and
`plannedEmission`. Actual `emittedEffort` and every `observedEffective` field remain
`unknown`. A high-effort plan cannot certify high effective effort. Authorized
omission can be planned with selected exact identity while effective effort remains
unknown; even that identity has not been observed at runtime by A0.

Evidence summaries retain issuer/reference, scope/digest, timestamps, calculated age,
execution identity and subscription classification. No arbitrary provider response,
command, endpoint, environment or credential field is accepted. Errors contain
fixed codes, not validation payloads. Unresolved request identifiers are not echoed.
Inputs and outputs must contain identifiers/references, never credentials. A0 cannot
recognize a secret deliberately disguised as an otherwise valid trusted identifier.

Budget reservations are conservative caller-supplied estimates, not measurements.
All review reservations are summed with the worker reservation. Review choices are
greedy in listed order; A0 may block a feasible combination instead of searching
combinations. It never overcommits knowingly. Atomic budget/ownership reservation,
policy compare-and-swap, revocation, live observations, named-review completion,
command classification/serialization and active-worker safety remain unimplemented.
No source SHA/digest can substitute for those checks.

## Schemas and canonicalization

The six files are JSON Schema 2020-12 documents with a deliberately bounded subset:
`$schema`, `$id`, `type`, `properties`, `required`, `additionalProperties: false`,
`oneOf`, `const`, `enum`, `items`, `minItems`, `maxItems`, `uniqueItems`, `minLength`,
`maxLength`, `pattern`, `format: date-time`, `minimum`, and `maximum`.
The runtime interpreter implements these bundled documents only. It is **not** a
complete JSON Schema validator and accepts no external schemas. Tests compare the
embedded copies byte-structurally to the files and reject unsupported keywords;
they exercise every populated object's closure and required fields. No independent
full JSON Schema engine is added or claimed as validation evidence.

Canonical JSON sorts object keys using JavaScript UTF-16 lexical order, preserves
array order, uses ECMAScript JSON string/number serialization (`-0` becomes `0`),
and hashes the UTF-8 bytes with SHA-256. No Unicode normalization is performed.
Only well-formed Unicode and plain JSON data are accepted: reject undefined,
nonfinite numbers, sparse arrays, accessors, symbols, cycles and exotic objects.
Numeric limits/counters are nonnegative safe integers. Inputs must be deserialized
JSON, not executable objects/Proxies. The resolver reads no filesystem, network,
environment, process, credential or implicit clock; Node crypto is its only import.

Timestamps are exactly `YYYY-MM-DDTHH:mm:ssZ`, valid calendar dates, with seconds
00–59. Offsets, fractional seconds, leap seconds and invalid dates are rejected.
There is no hidden current-time fallback. Identity/reference strings use bounded
ASCII identifier syntax; arbitrary natural language belongs outside this contract.

## Offline verification and deferred acceptance

Run `node --test scripts/lib/model-routing.node-test.mjs` and the unchanged
`node --test scripts/review-gate.node-test.mjs`. All fixture identities and evidence
are fictional. No current vendor support tables, credentials or entitlement probes
are included. The Researcher/Jev recommendations inform semantics, not live facts.

A0 tests cover ARCH-R01–R10, R21 (missing input), R24 (synthetic service evidence),
R25 (bounded output) and R28 (unchanged regression suite). They include relevant
JEV effort/surface/version, budget, override, review, omission and replan cases.
ARCH-R16's offline portion demonstrates unverified effective effort; actual runtime
observation is deferred. Explicit skipped cases identify controller/adapter/sync
acceptance; mocks do not turn those into passes.

Repair round 1 adds same-execution and same-family regressions for both subject
types, additional-contributor conflicts, exact subject bindings, selected-producer
identity and a valid existing-artifact reviewer job. Removing the planned producer
or existing contributors from independence checks must turn those regressions red;
blanket treatment of the current reviewer as an existing-artifact author must also
fail the positive cases. The original head's passing tests did not cover this defect.

Temporary guard-removal checks must make negative tests fail, followed by exact
source restoration and a passing rerun. Independent QA and named-provider review
are still required at the exact draft head. No PR boundary preflight, live adapter
validation, sync, activation or merge is claimed by these unit tests. The cohesive
schemas/resolver/fixtures exceed the usual small-PR guideline; keep this draft as
one reviewable contract unit, then scope later integrations separately.
