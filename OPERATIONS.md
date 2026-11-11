# Operations and recovery

## Backups and restore

Back up PostgreSQL with `pg_dump -Fc` and protect the encryption keys separately. Test restoration into a **new, isolated database**, then verify migrations and credential decryption before switching traffic. Restore is not an ordinary deploy rollback. Do not run destructive `pg_restore --clean` against a live database as a recovery shortcut.

Schema changes are additive. To roll back application code, stop incompatible worker/API versions first and keep the new fields. Reverting a deploy does not remove comments or commits already published to GitHub.

## Credential migration, rotation and revocation

Use `openssl rand -hex 32` to generate each new encryption key. To rotate:

1. Back up the database and current key. Keep the old key securely available.
2. Set `ENCRYPTION_KEY_PREVIOUS` to the old key, `ENCRYPTION_KEY` to the new one, and increment `ENCRYPTION_KEY_VERSION`.
3. Restart all credential-consuming processes with compatible configuration.
4. Run `npm --workspace=backend run credentials:migrate` to re-encrypt existing records and remove plaintext fields.
5. Verify no live records still use the old key version, then retire the previous key. Preserve keys needed to restore older backups.

The migration uses conditional updates to avoid overwriting a concurrent login. If a record cannot be decrypted, it stops instead of erasing credentials. Review the key configuration and rerun. Revoked credentials are cleared. Users without usable credentials must reconnect. The database `tokenRevokedAt` marker stops workers and assertions; revocation at GitHub must also be performed for a compromised token. Removing a browser session alone does not revoke the stored GitHub credential.

## Webhook provisioning

`desiredActive` records the intention; `provisioningState` records the result. `ACTIVE` requires a confirmed GitHub hook. Failure is visible as `ERROR`; use Retry in the dashboard. ID references are retained after failed deletion.

A worker reconciles interrupted `PROVISIONING` operations after their lease expires. Provisioning uses conditional ownership/version checks and paginated hook lookup. An API timeout or failed hook listing must not be interpreted as permission to blindly create another hook. Multiple hooks at the configured URL are ambiguous: inspect them and remove only those known to belong to this installation.

A configuration change during an active operation pauses local processing. The original operation cannot override a changed intention; the next reconciliation applies the latest desired state.

For 401 deliveries, inspect HMAC secret and original body preservation; never disable signature verification. Missing delivery/event headers or malformed PR fields return 400. A known delivery ID with different bytes returns 409. Database admission failure returns 503 so delivery can be retried. A duplicate delivery returns 200 without another execution.

## Worker recovery

A worker claims jobs transactionally with PostgreSQL row locking. Leases last 120 seconds and are renewed every 30 seconds. Expired `RUNNING` jobs are eligible for recovery, with a new lease version fencing the former owner. Exhausted attempts become `ERROR` instead of remaining stuck.

The initial retry budget is three attempts, with delays of 30 and 120 seconds; GitHub `Retry-After`/reset is respected. `SKIPPED` and `SUPERSEDED` do not count as successful reviews. A published review with a later failed stage can become `PARTIAL_SUCCESS`. The dashboard reads persisted runs/steps, not the legacy log table.

Stored analysis is reused after recovery. Comments carry an execution-specific marker and analyzed head SHA. Reconciliation paginates comments and verifies the publishing account. A failed reconciliation is not treated as an empty result. GitHub has no transactional exactly-once interface; ambiguous effects must be reconciled before replay. Do not force a database status to success or delete idempotency records to unblock a run.

The head is rechecked after fetching the moving PR diff and before external publication. A push can still race with comment publication; the comment identifies the analyzed SHA. Documentation ref updates are non-force, so newer incompatible commits are not overwritten.

## Documentation proposals

The owner reviews exact replacements and resulting README before approval. The backend verifies ownership, current write permissions, PR state, source repository, head, file hash and preview. Rejection uses a conditional state update so it cannot overwrite a concurrent approval.

Approval metadata and a commit intent are persisted before publishing. The exact prepared Git commit SHA is stored before updating the branch. If the response is lost, keep the proposal `APPLYING` and intent `PENDING`; use **Reconcile application** to verify ancestry/content or publish that same prepared commit when still safe. Do not mark an ambiguous timeout abandoned or create another commit blindly.

A request interrupted before preparing a commit can be retried after five minutes. The old intent is abandoned and its callback is fenced. Self-generated webhooks are skipped only after commit parent, prepared SHA, marker and content hash are verified. A pending intent alone never suppresses a human push.

For forks or protected/closed/stale branches, preserve the suggestion for manual editing. If an applied change is unsuitable, review a normal revert/correction with the maintainer; never force-push as an automatic recovery.

## Privacy, retention and limits

Filtered code, bounded PR metadata and README context go to Google. File filters and known-pattern redaction reduce exposure but cannot guarantee that arbitrary content is free of secrets. Do not enable the installation on private repositories without understanding this boundary.

Database results/proposals may contain source snippets. Restrict database/API access and backups. There is no automated retention policy yet; coordinate removal of old results with preservation of delivery/run identities needed to prevent duplicate effects. Operational dashboards, automated cleanup, membership sharing and a community pilot remain future work.
