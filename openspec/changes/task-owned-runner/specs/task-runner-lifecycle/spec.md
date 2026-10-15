# Task runner lifecycle and artifacts

## ADDED Requirements

### Requirement: A task attempt owns its execution environment
The system SHALL run preparation, setup, agent execution, gates, helpers, services, publication,
session readout and artifact export within one task-attempt pod. Separate containers are allowed;
independent auxiliary Kubernetes Jobs are not. Docker SHALL implement the same lifecycle contract.

#### Scenario: Complete execution
- **WHEN** a task uses gates, services and helpers
- **THEN** all execution resources belong to its task pod/group and share only explicitly scoped state.
- **AND** agent exit leaves the supervisor alive to verify, finalize artifacts and report.

### Requirement: The execution plan is schedulable before launch
The system SHALL resolve images, tools, resources, service connectivity and profile boundaries
before launch, and SHALL reject unsupported plans explicitly without launching auxiliary Jobs.

#### Scenario: Conflicting service ports or undeclared image
- **WHEN** a plan cannot provide requested environments inside the pod
- **THEN** planning fails with an actionable configuration error before agent execution.

### Requirement: The supervisor owns controls and authoritative evidence
The supervisor SHALL enforce stage deadlines, question-wait budget pauses, cancellation,
resource limits and revision-bound verification. Agents SHALL NOT receive supervisor credentials,
cluster API access or authority to declare their own gates passed.

#### Scenario: Agent mutates files after verification
- **WHEN** publication sees a different tree from the verified tree
- **THEN** it refuses the stale evidence and requires verification of the publication candidate.

#### Scenario: User stops a task while waiting for answers
- **WHEN** Stop arrives during a paused budget
- **THEN** outstanding waits terminate, child execution stops and artifact finalization proceeds.

### Requirement: Task storage survives execution resource replacement
Active state SHALL use a task-owned persistent volume independent of pod garbage collection.
Normal execution and analysis SHALL require no EFS mount. Checkpoints SHALL be immutable,
complete manifests containing enough checkout/session state for supported resume semantics.

#### Scenario: Pod replacement
- **WHEN** a pod disappears but its task volume remains available
- **THEN** the next fenced owner can recover persisted state and pending artifacts.
- **AND** no concurrent attempt can write the same active volume.

### Requirement: Driver authority survives supervisor failure
The external driver SHALL retain lease enforcement, stale-attempt fencing and orphan cleanup.
Checkpoint-pointer updates and verdicts SHALL validate claim sequence. Publication SHALL
reconcile remote side effects after uncertain responses before retrying.

#### Scenario: Old attempt reports after replacement
- **WHEN** a stale supervisor uploads or reports completion
- **THEN** its immutable attempt artifacts may be retained but its authoritative updates are refused.

### Requirement: Reviewer and helper isolation survives consolidation
Internal reviewer/helper sessions SHALL preserve profile credentials, budgets and separate
session identity. Reviewers SHALL consume a frozen snapshot. Explicit standalone board review
tasks SHALL remain independently scheduled tasks, not auxiliary execution resources.

#### Scenario: Agent continues editing during review
- **WHEN** an internal reviewer starts on a snapshot
- **THEN** later agent edits do not change the review input or the revision identified by its result.

### Requirement: Transcripts are continuously durable and analyzable
Both executors SHALL preserve raw Claude and OpenCode transcripts/session exports on retained
storage while running, and continuously upload immutable chunks. Analysis SHALL remain available
after task-pod deletion without reading its filesystem. Normalized data SHALL retain raw provenance.

#### Scenario: Agent killed before final export
- **WHEN** the agent is killed and the task volume survives
- **THEN** every transcript record persisted before the kill remains recoverable for export.

#### Scenario: Unrecoverable volume loss
- **WHEN** local state is unrecoverable before outstanding uploads are acknowledged
- **THEN** acknowledged chunks remain readable and the attempt is explicitly incomplete.
- **AND** the system does not claim zero loss or a complete transcript.

### Requirement: Artifact uploads are scoped, ordered and idempotent
Artifacts SHALL identify tenant, member, task/root, claim sequence, executor, session and stream.
Manifests SHALL record chunk sequence/checksum, producer/schema version, timestamps, completion,
truncation and terminal cause. Retries SHALL NOT duplicate records or usage accounting.

#### Scenario: Upload response lost
- **WHEN** the same chunk is retried
- **THEN** it resolves to the same content and analysis observes each record once.

### Requirement: Export handles live executor formats safely
Claude export SHALL handle partial JSONL records and rotation. OpenCode export SHALL use a
consistent database read or supported export. Session redirection SHALL preserve baked hooks
and settings. Members SHALL NOT override reserved artifact/session control paths.

#### Scenario: Export races an executor write
- **WHEN** an executor is still writing
- **THEN** export does not publish a partial record as complete or copy an inconsistent database.

### Requirement: Retention and backpressure are explicit
Uploads SHALL have bounded buffering, retry and visible lag. Buffer exhaustion SHALL pause or
fail execution explicitly. Artifact completion SHALL be separate from the execution verdict.
Automatic volume cleanup SHALL wait for acknowledged required artifacts. Retention/deletion
policy SHALL cover raw and normalized data, manifests and access authorization.

#### Scenario: Object storage unavailable at completion
- **WHEN** the task finishes while uploads remain pending
- **THEN** its verdict is preserved, artifacts remain pending/partial, and its recovery volume is retained.

#### Scenario: Cross-tenant artifact request
- **WHEN** a caller requests another tenant's artifact
- **THEN** access is refused regardless of knowledge of the object key.

## Existing capability replacement

On implementation, update `openspec/specs/executor-transcripts/spec.md` in the same change:
replace workspace-volume location, Claude-only scope and path-equivalence requirements with
the executor-neutral identity, retained-volume durability and object-store analysis contract above.
Preserve the existing kill-survival, baked-settings and reserved-environment protections.
