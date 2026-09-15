# Learning Module API

## Static Closeout (2026-09-16, Asia/Shanghai)

Reviewed against current source contract 1.31.0, not the version of a running service.
This round did not run tests, type checks, builds, browsers, probes, training or external
requests. Existing test results below are historical evidence, not validation of these edits.
The user workflow, separate consents and retention limits are in [README.md](README.md).

- A saved_receipt_only evidence view now withholds its old preview body. A receipt does
  not authorize displaying content rejected by permissions or a deletion barrier.
- In-page unknown S07 recovery now sends the retained original requestHash to the existing
  attempt GET endpoint, so the dedicated receipt is checked before reading the attempt body.
- With requireReceipt=true, appeal recovery accepts a newer current feedback version only
  after matching the original event ID/hash, exact CAS/resulting version and original
  feedback version in the receipt. A newer feedback projection is not the original event.
- The review panel distinguishes an empty exact-version catalog, exposes the verified event
  receipt and allows reopening cancelled manual feedback editing. No recovery triggers POST.

Current open differences are precise, not missing S07/task/runtime/recovery infrastructure:

1. Services.readReviewAttempt returns ReviewAttemptPublic, not the private answer/rubric
   snapshot needed by model-review.ts. No production ReviewModelDependencies.readAttempt
   installation or learning model route exists. The 1.30 intelligence operation endpoint
   does not supply this source and must not stand in for an S07 event receipt.
2. EvidenceStore still rejects recall/near_transfer writes. S07 persists a 30-day attempt;
   saveAttemptEvidence is an internal legacy adapter, not an installed long-term learning
   archive workflow. Until-deleted use/outcome storage is independently connected.
3. The page does not select/send priorRecallAttemptId. Shared near-transfer start requires
   a same-task/same-node-version submitted unexposed recall; normal runtime unknown cannot
   satisfy that requirement. No client-generated unexposed flag or task replacement is used.
4. Shared 1.31 apiRequest session binding currently covers intelligence paths only, not
   learning/workspace requests. The remaining cross-tab identity race needs a shared policy
   and browser acceptance; 1.26 recovery anchors and unmount wiring already exist.

Application useContext stores the original task bytes and fixed knowledge context, bound by
hashEvidence. It does not claim unsupported taskRevision/taskContentHash fields in the shared
EvidenceUseContext schema. Those explicit fields are consumed by S07 start, where the shared
TaskStore boundState check occurs atomically with attempt and start-receipt persistence.

All responses use the shared ApiResponse envelope, trusted Services.context identity,
and Cache-Control: no-store. Request-body identity, scopes and mode are not trusted.
These endpoints do not create formal knowledge or call a model.
The trusted RequestContext instance is passed unchanged to Services; copying it would lose
the platform SessionRegistry identity binding introduced by the integration baseline.

## Runtime And Recovery (1.25/1.26)

The published 1.25 runtime and 1.26 recovery-anchor contracts are consumed, with 1.24
taskRevision/taskContentHash atomic binding preserved. There is no longer a blanket
fixture-only gate for S07. This does not claim authorized CNB/model live acceptance.

- New catalog reads and starts require all S07 ports and a strictly parsed
  Services.readReviewRuntime response: matching context mode, ready/nonzero catalog,
  revision_hash_atomic task binding, server_observed_unknown_default exposure,
  unassistedCertification=false, and 30-day question/attempt retention. Empty, missing,
  contradictory or private-field-bearing DTOs fail closed. readReviewQuestions must then
  return approved public questions for the exact workspace/node/knowledge revision;
  start must match the selected question ID and question revision. No pre-start GET
  substitutes the latest task for the user's already confirmed task revision/hash.
- Existing events, cancel and read-back use their own S07 ports and dedicated receipts,
  without depending on the current catalog. A successful mutation followed by denied
  receipt/body read-back remains dataState=unknown, not not_written. Live projections
  claiming unassisted_* are rejected; normal runtime exposure remains unknown until
  observed, and no client exposure flag is accepted.
- Page forwards NavigationProps.retainOperationRecovery to task/review/use/outcome
  controls. An independent, initially unchecked choice retains only the next original
  operation identity for at most 24 hours. It is separate from task/attempt 30-day and
  evidence until_deleted consent. Task/review bind the complete original requestHash;
  each event has its own operationId. Evidence binds hashEvidence(record) and the fixed
  baseRevision. Model-review metadata binds its original approval-registration
  operationId, contentHash and baseRevision. No answer/task/Approval body is retained.
- recovery-anchor.ts validates both the strict input and returned original identity,
  scope, digest and absolute expiry. Retention is confirmed before the business action.
  A lost retention response never continues approval, save or start automatically.
  Reading does not renew expiry; GET/receipt/body reads check expiry before and after
  transport. Unmount/identity change stops continuation of the old page's action.
- Page consumes recoveryIdentity and the shared recoveryId route. RecoveryAnchorPanel
  initially renders no recovered body and performs no writes. A user-triggered read
  rechecks /api/workspace/session, then GETs the original recovery identity. Null,
  mismatch and unknown cannot acknowledge submission. matched metadata still needs
  the original task/evidence/S07 dedicated receipt. A separate explicit action may
  fetch the permitted body, including an already revealed answer; no automatic replay,
  approval, next question or reveal occurs. No browser storage or new database exists.
- GET /api/learning/attempts/:operationId?projection=receipt&requestHash=<sha256>
  returns only the S07 ReviewOperationReceipt under evidence:read, without reading the
  attempt or question. Optional requestHash on the full read is checked against the
  dedicated receipt before readReviewAttempt; full body reads additionally require
  knowledge:read. The generic operation-recovery/review endpoint is metadata only and
  is never treated as this dedicated receipt.
- retained-operation.ts verifies task receipt revision/hash before permitting exact
  task-state display, evidence registration plus dedicated receipt and complete body
  hashes, and review operation/kind/attempt/requestHash/expected/resulting/feedback
  versions. A newer task is not restored as the historical task. Model recovery returns
  metadata only, never output or a learning result. Original unsaved approval payloads
  are intentionally not reconstructed from current task or knowledge.

review-runtime.test.ts uses actual createRuntime, private catalog-file import,
Services, in-process shared HTTP and SQLite reopening/two connections. The CNB/Git
transport is explicitly synthetic and runtime mode stays fixture. These checks and
SSR control tests are not browser refresh, live, G3/G4/G5 or physical-erasure acceptance.

## Application

- GET /api/learning/status: knowledge:read; workspace identity, applicationStorage=shared_services,
  trustedReview=shared_services only after strict runtime capability validation and a ready
  catalog, otherwise not_connected; persistence=not_checked. Exact questions are checked at selection/start.
  This describes wiring, not a successful write.
- GET /api/learning/context: knowledge:read; current snapshot revision plus confirmed,
  non-withdrawn, non-excluded node IDs, titles, conditions and boundaries. No standard answers.
- POST /api/learning/use: knowledge:read; strict discriminated request:
  - `{ action: "preview", selection: UseSelection }` returns UsePreview plus a transient
    UseRecordDraft and optional EvidenceStoragePreview. Task, knowledge conditions, versions and
    graph references are copied. A storage preview has one stable operation ID for its lifetime.
  - `{ action: "cancel" }` returns not_saved without reading or writing content.
  - `{ action: "preview_retrieved", task, retrieval, nodeId, decision, reason }` accepts a
    transient TaskContext/RetrievalResult handoff. Nodes are compared against the shared current
    snapshot; paths, prerequisites, exclusions, gaps and scope are checked. Returns UsePreview
    plus draft and handoffTrust: client_preview_only. This is not a trusted retrieval receipt,
    cannot authorize persistence, and cannot prove unexposed learning. No model, index or write.
    `coverage: "unavailable"` describes unavailable semantic coverage, not necessarily an unusable
    retrieval result: a selected Git-verified hit may still be previewed. The original coverage is
    retained, upstream warnings are preserved, and an explicit completeness warning is added to
    both UsePreview.warnings and draft.retrievalContext.warnings even if upstream warnings are empty.
    Adoption with non-current coverage still requires a rationale. Reject/verify_later remain
    available without an adoption rationale. Empty/no-matching hits, unavailable authoritative Git,
    stale versions, excluded knowledge or invalid formal relationships remain errors.
  - `{ action: "save", selection: UseSelection, consent: boolean }` also requires evidence:write.
    Without consent: FORBIDDEN. This legacy shape remains NOT_IMPLEMENTED because it lacks the
    exact registered approval; use the preview/approve/execute protocol below.
- GET /api/learning/records?taskId=...: evidence:read; reads through Services.listEvidence.
  Optional useId/evidenceId use exact Services.readEvidence calls, checking the original use kind,
  shared task and outcome.useRecordId; no fallback to unrelated records. Repeated/unknown parameters
  fail closed. GET /api/learning/records/:id reads one exact record.
  Missing historical conditions remain not_recorded. Current knowledge never replaces old context.
  Invalid, foreign or duplicate-ID lists fail closed rather than selecting an arbitrary record.

UseSelection is defined by the strict module schema in use.ts. Existing TaskContext,
VersionRef and EvidenceRecord types are imported, not redefined. The draft is not
silently encoded into EvidenceRecord.answer or stored in a second database.

## Private Application Storage (1.14+)

application-record.ts constructs the shared EvidenceRecord: useContext contains original task,
snapshotRevision, knowledge, formal relations, paths, reason, coverage, warnings and missingConditions.
The answer field is empty in use drafts and stored use/outcome records. Outcomes have their own
ID, reference the original use, keep result/verification=self_reported and never rewrite that use.
Preview and execute consume shared validateTaskContext (1.15). Only a matching nodeRef/conditionId
with status=satisfied satisfies a task premise; unknown, missing and not_satisfied remain gaps.
Knowledge confirmation and free-text constraints cannot substitute for exact task checks.

EvidenceStoragePreview contains operationId, actorId, record, fixed full Git baseRevision,
retention=until_deleted, persistence=not_saved and indexing=excluded. The UI freezes this payload,
requires an initially unchecked retention choice, and separates these two actions:

1. POST /api/workspace/approvals/evidence with the complete shared EvidenceApprovalRequest
   {operationId,record,baseRevision,retention:'until_deleted',confirmed:true}.
2. POST /api/learning/use or /api/learning/outcomes with {action:'execute',request,approval}.

Execution needs knowledge:read and evidence:read/write, unchanged trusted ctx, original registration,
full hashes/identity/object/version checks and platform appendEvidence. Returned record and exact
readEvidenceReceipt operation are independently checked. A saved response is
{receipt,persistence:'saved',indexing:'excluded'}, not a trusted retrieval or learning receipt.
Neither a null receipt, identical-content peer operation nor a later version proves our success.

evidence-save-flow.ts retains only the selected preview in memory. Approval/save/revoke unknown
states block local navigation and payload changes. Execute and recovery verify the original
receipt and then read the exact record by recordId, checking the full EvidenceRecord hash before
marking the body as saved. A matching receipt with a blocked, missing or mismatched body is kept
as receipt-only or unknown, never as a full body readback. Verification only uses GETs after an
operation has been sent; it never automatically registers or appends. Cancel before approval has
zero writes; after registration it revokes and checks the original registration. A sent save
cannot be undone by calling its approval revoked. client_preview_only persists only the human use
context.

evidence-recovery.ts and its panel recover a known operation ID without the old flow object, using
only shared registration/receipt/record GETs. Full body recovery checks the complete original
request hash and approval/receipt bindings. Missing receipts remain unresolved. A receipt without
readable body does not reconstruct the body or prove physical deletion. An approval-only registration
cannot restore its unsaved payload. Separately consented minimal-ID retention across forced
unmounts is consumed through 1.26; automatic retention or current-task reconstruction is forbidden.

## Historical Knowledge

GET /api/learning/records/:id/knowledge?nodeId=... requires evidence:read and knowledge:read.
The record is loaded through Services.readEvidence when supplied (legacy fixture adapters may only
provide listEvidence); nodeId must belong to its nodeRefs. The exact record is rechecked after the
historical read, so deleted or changed evidence cannot expose the old response body.
The caller cannot supply a replacement revision. Only complete immutable Git SHAs in the
saved reference are accepted (40 or 64 lowercase hexadecimal characters, matching the platform).
Services.snapshot(ctx, revision) must return that exact revision.
Current exclusions/workspace access are checked before and after the historical read.
A currently missing or excluded node is not disclosed via history. Withdrawn knowledge can
remain historically explainable, with its current lifecycle stated explicitly.

The response is HistoricalKnowledgeView (history-reader.ts): provenance is historical_knowledge,
contextState is recorded/linked_use/not_recorded based only on the original record; applicability
remains not_assessed. It contains the old
knowledge text/conditions, not a reconstructed original TaskContext or saved relationship path.
No private query is indexed or persisted. Reading knowledge is not proof of unexposed learning.
The provided 1.5.0 platform deletion barrier applies to both current and historical Services.snapshot
reads. Learning consumes it through that existing port, keeping its own before/after visibility
checks as well. No separate deletion registry or production store is introduced. A blocked read is
not evidence of physical deletion; unknown/unsupported cleanup layers remain the platform's report.

## Outcomes

POST /api/learning/outcomes: evidence:read; `{ action: "preview", outcome: OutcomeInput }`
or `{ action: "cancel" }`. OutcomeInput links useRecordId, status (succeeded/failed/unclear),
summary and failureReason. Verification is always self_reported. Original records are loaded
from Services, not accepted from the client. No formal knowledge or old evidence is overwritten.
Failure previews include revisionLinks for explicit navigation to the original node version,
carrying only nodeId, revision, useId and taskId. They do not commit a revision or save the
outcome. Saved failures additionally carry evidenceId from the stored outcome.
An outcome storage preview uses its own approval/execute protocol. Saved failures link to
#governance with nodeId/revision/useId/evidenceId/taskId from the shared whitelist; unsaved previews
do not advertise a persisted outcome ID. Both use and outcome retain an original-task return link.

## Reviews

The strict request schemas live in review-api.ts:

- GET /api/learning/reviews?nodeId=...&revision=...: knowledge:read.
- POST /api/learning/attempts: evidence:write; all actions except the owning actor's cancel
  additionally require knowledge:read. Permission is rechecked for non-cancel state transitions,
  not only when starting. Revoked knowledge access cannot reveal hints/answers or submit.
  - `{action:"start",operationId,taskId,taskRevision,taskContentHash,questionId,questionRevision,nodeRef,retentionDays:30,confirmed:true}`. The start
    `operationId` is retained independently from `attemptId`; it must be supplied by the
    caller before the request so a lost start can be recovered by that exact operation.
    Shared contract 1.24 requires the positive `taskRevision` and SHA-256 `taskContentHash`
    from the same task state already read back and confirmed by the user. ReviewPanel uses
    that state without silently fetching a newer task before start. The platform atomically
    checks the binding, expiry, permissions and deletion barrier in the attempt/receipt write
    transaction. Changed text or a newer same-content task revision conflicts without an attempt.
    Both fields are included in the complete requestHash checked by the service adapter and
    AttemptRequestGate. Recovery retains that hash, uses only the original operation GET and
    never substitutes the current task or its version. Public attempt DTOs remain unchanged.
  - `{action:"event",operationId,attemptId,expectedVersion,event}`. Event is confidence/begin/hint/reveal/submit/cancel.
  - `{action:"feedback",operationId,attemptId,expectedVersion,feedbackVersion,review}`.
  - `{action:"appeal",operationId,attemptId,expectedVersion,feedbackVersion,nodeRef,reason}`.
    The learning consumer dispatches this only through the shared S07 port. It creates no local
    appeal record; original event receipts and CAS, not the current catalog, control this action.
- GET /api/learning/attempts/:id: evidence:read and knowledge:read; read back by the original
  event operation ID, not another event or the attempt's start operation. Cancellation without
  knowledge access still needs trusted ownership and evidence:write; it does not grant access
  to the attempt body. The receipt-only projection above remains available under evidence:read.

Valid runtime requests dispatch through shared S07 Services and read the original operation
receipt before returning state. New starts use the 1.25 capability/catalog checks above;
existing operations do not consult today's catalog. Invalid/foreign input is rejected first.
No production fixture bank or client-supplied exposure proof is accepted.
Each confidence, hint, submit, feedback and appeal mutation must use a distinct stable
operationId. An attempt ID, feedback version or incremented attempt version does not identify
which concurrent mutation was applied. The response must include a
request-bound receipt containing the original operationId, actor/workspace, base version and
server-computed request summary hash; a matching state version alone is not sufficient.
The prepared response types are ReviewCatalogResponse and AttemptResponse. Only publicQuestion
and publicAttempt may cross the HTTP boundary. A private AttemptSession contains answers and
must never be serialized directly. Standard answers/rubric evidence are not sent before submission
or an explicitly recorded reveal. Exposure must be supplied by a trusted cross-module session;
unknown exposure is never unassisted. UI context/knowledge browsing also needs exposure tracking.

attempt-response.ts now validates the entire strict public AttemptResponse, including paired
confidence/timestamp, phase, hint count, frozen submission, evidence classification and feedback
ownership/rubric/answer consistency. Private question fields such as standardAnswer or rubric are
rejected, not silently stripped. PublicAttemptView includes answerRevealed, the server-owned flag
for an explicitly recorded reveal. Before submission, only an answering phase with that flag may
contain standardAnswer; answerVisible alone (which also represents seen/unknown prior exposure)
does not authorize delivery. Cancelled views contain neither standard answers nor hints.
This response validation is not an attestation of cross-session unexposed status.

State must be durably updated with actor/workspace isolation and CAS before delivering hints or
answers. The independently retained start operationId must identify the start operation so a
timed-out start can be read back; the client must not assume it equals attemptId.
The client blocks further mutations after unknown/conflicting results and uses the read-back route.
The current start mapping is operationId = attempt.id. attempt-request.ts synchronously locks
mutations, retains that ID after local cancellation, ignores obsolete response tickets and checks
task/question/node/rubric bindings across later events, not just start. A local mutation must use
the last accepted attempt version. Read-back must observe at least expectedVersion+1 for an event,
  or feedbackVersion+1 for feedback; an old snapshot is not evidence that a request was not applied.
Definitive not-written mutation errors release the gate; failed read-back does not. The published
dedicated operation receipt identifies an applied request. Null/unknown recovery is never proof
that a rejected operation did not write, even when the attempt version did not advance.
Higher versions alone do not acknowledge unrelated events: submit needs a frozen submission,
reveal its explicit flag, hint the requested minimum level, confidence the requested choice,
begin a locked confidence, and cancel a cancelled phase. Responses with inconsistent state stay
unknown under the original operation ID. These checks do not replace a durable operation receipt.
Request and response counters use safe integers; a counter that would overflow on increment is
rejected before sending. The request gate keeps identifiers, counters and event metadata, not
answer text, and does not create a second learning store.

The temporary queue has an explicit return action after a submitted or cancelled view is
accepted. AttemptRequestGate.releaseView(attemptId) checks the original ID and accepted phase,
and refuses while any mutation/read-back is active or unresolved, including feedback on a
submitted answer. Leaving an open feedback form asks for explicit confirmation before dropping
unconfirmed local edits; declining keeps the view and gate intact. It only releases local request/view metadata; it does not cancel/delete a
server attempt, save evidence, remove the queue item, launch the next question or attest exposure.
The next attempt still needs an explicit start and trusted S07 exposure/operation evidence.

The gate stores no answers and is not a durable session store. Shared session ports must also
declare temporary retention, deletion and consent boundaries. A saved server session must not
be represented to the user as no persistence merely because an EvidenceRecord was not saved.

## Evidence Persistence

saveAttemptEvidence is an internal, tested Services adapter, not a client upload endpoint.
It derives EvidenceRecord from a server-owned submitted attempt, uses shared hashEvidence,
validates scope/actor/purpose/object/time/base revision, calls appendEvidence, and verifies listEvidence
read-back. The approval objectIds scope is exactly [record.id]. Platform registration, revocation,
durable unknown-operation tracking and atomic idempotency by record.id remain mandatory.

Only basic_evidence_only has a compatible current shared schema. Its receipt explicitly lists
missing question text, full conditions and feedback/appeal history. Do not advertise this as a full
learning archive. Until W5-REQ-001 is resolved, HTTP saves remain closed instead of silently dropping
context or encoding JSON into answer. Synthetic Services are injected only by tests, not production.

The 1.6.0 optional semanticQueryWithStatus port belongs to retrieval; application previews consume
the supplied RetrievalResult and do not issue another semantic query. The optional approveModel
contract does not grant save_evidence approval, a reviewed question catalog, a trusted attempt or
exposure evidence. Learning does not call it or complete merely because the method is available.
New independent reviews require the published runtime capability and exact question checks above.

## Approved AI Review

model-review.ts is a server-only adapter to the real shared Services model implementation,
not an HTTP endpoint or a client-owned AttemptSession upload. The host must install a trusted
readAttempt callback backed by S07. No model-private attempt callback is installed in the
production learning route; the ordinary S07 public catalog/attempt ports are already connected.
Missing model-private reader returns NOT_IMPLEMENTED before any model activity.

- prepareReviewModel(attemptId, dependencies, ctx) requires knowledge:read, evidence:read and
  model:review, enabled aiReview, an owned submitted attempt, an approved question, and a current
  non-excluded node/complete snapshot revision. It produces the exact bounded JSON input and
  hashModelInput digest. Source IDs come from saved SourceRecords, never node IDs. The payload
  includes question/rubric, the submitted answer and permitted knowledge excerpts, not confidence,
  actor identity, hidden hints, unrelated task text or conversation history. No approval or send.
- approveReviewModel({operationId,attemptId,previewHash,confirmed:true}, dependencies, ctx)
  rebuilds the preview and checks the original hash before Services.approveModel. The stable
  operationId is registered with the shared model approval so it can be recovered later. The
  shared service registers model_input approval, not save_evidence. The response is checked
  against original scope/hash. Unknown registration is not retried; the caller must retain the
  original approval operationId.
  An optional fourth argument `{expiresAt,confirmed:true}` is separate recovery consent.
  It validates and saves the exact model-review metadata through Services.saveRecoveryAnchor
  before approveModel. Missing/unknown retention stops approval; no automatic retry occurs.
  This internal adapter adds no public model route or paid-model invocation.
- requestReviewModel({attemptId,approval,confirmed:true}, dependencies, ctx) rebuilds and validates
  scope/actor/purpose/hash/version/expiry, then calls Services.complete exactly once. The platform
  enforces registration, revocation, independent settings revisions and budgets. It rechecks the
  session, settings and snapshot before delivering a result. No automatic re-approval or retry.
- ReviewModelOutputSchema is strict: fixed attempt/question/rubric versions, exactly one entry
  per rubric criterion, finding, answerQuote, rationale and sourceQuotes. Nonempty answer evidence
  for met/partial must occur verbatim in the submitted answer; each source quote must occur in its
  named saved excerpt. Invented references, duplicate/missing criteria, stale versions and extra
  overall grades are rejected without returning the rejected model text. A valid response is only
  ai_suggestion, requiresHumanReview=true, not_saved and indexing=excluded. It does not overwrite
  FeedbackDraft, grade a person, create EvidenceRecord or infer unassisted learning.
- inspectReviewModelOperation(originalApproval, services, ctx, operationId) consumes the 1.22
  `Services.readOperationRecovery` model query with the exact
  `{kind:'model',operationId,modelPurpose:'review'}` shape. It checks the shared minimal metadata
  against the original actor/workspace/approval/purpose/hash/base, even after AI shutdown or
  approval expiry/revocation. It never calls the legacy private model receipt reader and returns
  `receipt:null` plus `recovery` metadata only. The result is operation_metadata_only,
  reviewResult=not_recovered, retryAllowed=false. Missing/approved/not_registered/unknown stages
  do not become a never-sent or never-charged claim; `done` is not a verified learning grade or
  saved evidence, and the recovery response cannot restore private model input/output.

model-review.test.ts injects only a synthetic owned-session reader and model/HTTP/Git transport;
approval registration, settings, one-send enforcement and operation read-back use shared platform
implementations. This is not S07 persistence, production UI wiring, model billing or live acceptance.

## Shared Fixture Verification

composition.test.ts uses the shared createApp and platformFixture with synthetic HTTP/Git transport
and in-memory fixture operation metadata. It covers the retrieval API's semantic outage fallback,
learning preview, an approved fixture Git premise change, and the actual current/historical snapshot
deletion barrier, including a block arriving during a historical read. Only listEvidence is explicitly
stubbed for legacy historical-record cases. No evidence is saved in those preserved cases.
application-platform.test.ts separately uses actual createServices/createApp, shared approval and
SQLite storage/reopening, cold recovery, two sessions/connections, revoked/expired/altered approvals,
and persisted use/outcome to governance/retrieval HTTP handoff. External transports are synthetic;
these are not browser, full G3/G4 or authorized live acceptance.

## Routing

LearningPageProps extends the current shared NavigationProps, including 1.26 retention/recovery.
An optional registerLeaveGuard
registers one learning owner in an effect and returns the unregister callback. leave-guard.ts
aggregates application, outcome and review panels locally; callbacks read current refs/state.
Application text/decisions, outcome input, queued items and unfinished attempts are dirty.
AttemptRequestGate.blocked (sending/read-back/unknown) has priority and blocks unload even when
the review panel is hidden or a local request was interrupted. onBlocked displays the reason
and opens the review tab; it never marks an operation cancelled or sends another mutation.
Workspace refresh is also refused while a child operation is unresolved, including when an
in-flight refresh resolves or fails, so a module-initiated remount does not drop its operation ID.
External App focus/session revalidation clears old-session page content. Only independently
consented 1.26 identities survive through shared storage; their consumers recheck session identity,
original operation, hashes and receipts without granting old permissions. Real browser unmount,
focus and reconnection acceptance remains separate from the in-process HTTP tests.

The shared router owns dirty confirmation, hash/back/forward and beforeunload. Learning adds no
second global navigation handler or browser storage. These protections cannot guarantee survival
of a forced browser close/reload without prior recovery consent. Guard unit tests are not
browser routing, keyboard or screenreader acceptance. The shared PageOutlet now injects the callback.
navigation.test.ts exercises actual PageOutlet props, TransientRetrieval and HashNavigation with
learning guards; SSR does not run effects and does not prove real mounted guard behavior.

Page remains compatible with zero props. Optional routeParams accept taskId, nodeId, revision,
queryId, useId, evidenceId and recoveryId from the shared router. Optional retrieved: {task: TaskContext, result: RetrievalResult}
accepts the transient output of retrieval Page.onResult(task, result) via the composition layer.
Original task constraint IDs, confirmedBy, mode, sourceIssueNumber and updatedAt are preserved.
Task text stays read-only while bound to the handoff; changing the task requires returning to
retrieval. The feature does not parse or replace the global hash router or persist this handoff.
prepareRetrievedUse consumes the shared RetrievalResult contract, checks versions and graph paths,
and freezes conditions for all referenced nodes plus retrieval coverage/warnings. Task storage is
provided by shared 1.16 Services with separate 30-day consent; transient HTTP previews do not attest that the
client-supplied grouping or query identity came from an actual retrieval run. Direct confirmed
adjacent relations are checked even if the client omits them. A trusted stored receipt remains
required for trusted retrieval and learning exposure, not for separately approved human use-context
storage. W12 connects the Page props in the shared outlet.
When queryId exists but its transient task/result is absent, the page displays an explicit missing
context alert, keeps original-task inputs read-only and blocks application previews/new review
selection. It offers an ID-only return-to-task link. It never binds new manual text to the old query.
View switching preserves local drafts; changing route/workspace identity cannot silently rebind them.

## Final Gate Dependencies

S05/S06 application storage, 1.24 task CAS, 1.25 S07 runtime capability/catalog and 1.26 recovery
anchors are consumed, not missing interface requests. Dedicated per-event receipts and exact
request hashes remain mandatory; a peer's version increase cannot acknowledge this operation.
The current acceptance gaps also include the private model-review source, long-term S07 evidence
archive, near-transfer entry and shared learning session-binding policy listed in Static Closeout.
They remain separate from actual browser form/refresh/unmount/320px/keyboard/screenreader
checks, window one's coordinated four-to-five-to-six G3/G4/G5, and separately authorized live CNB,
model, publication/deployment and physical-erasure verification. Metadata-only recovery intentionally
cannot reconstruct an unsaved approval payload. No new model capability replaces these gates.

The submitted-attempt view also exposes a separate appeal control. It sends only the person's
bounded reason plus the trusted node reference, current attempt version and feedback version;
the request gate assigns and verifies a distinct appeal operationId and `kind:'appeal'` receipt.
No appeal record is created in learning; shared S07 owns its persistence, permissions and CAS.
