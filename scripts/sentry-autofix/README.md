# scripts/sentry-autofix

GH Action runner for the Sentry autofix loop. Triggered by
`repository_dispatch: sentry-autofix` (see
`.github/workflows/sentry-autofix.yml`). The webhook receiver in
`services/sentry-autofix/` fires those events.

Responsibilities (`run.mjs`):

1. Fetch Sentry issue + latest event via Sentry REST.
2. Resolve the in-app source files from the stack trace and read them
   from the checked-out repo.
3. Build a structured XML prompt and call Claude via
   `POST api.anthropic.com/v1/messages`.
4. Parse the `<patch>`/`<explanation>`/`<confidence>` XML response.
5. Apply the unified diff via `git apply`.
6. Check changed paths against the denylist (`policy.mjs`).
7. Open a PR with `sentry-autofix`/`sentry-autofix-draft` labels.
8. Update the `autofix_attempts` row in Supabase.

See [`docs/sentry-autofix.md`](../../docs/sentry-autofix.md) for the
full design and [`docs/runbooks/09-sentry-autofix.md`](../../docs/runbooks/09-sentry-autofix.md)
for the operator runbook.

## Manual test (from the GitHub UI)

Actions → Sentry Autofix → Run workflow. Fill in:
- `issue_id`: a real Sentry issue numeric ID from your project
- `sentry_project`: `club-arena-client` or `club-arena-engine`
- `attempt_id`: leave blank for manual runs
- `short_id`, `issue_title`, `issue_level`: optional — populated from Sentry if omitted
