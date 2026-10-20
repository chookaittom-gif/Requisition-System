# AGENTS.md

## Purpose and scope

Shared repository instructions for compatible coding agents.
Work safely, make minimal changes, preserve existing contracts, and report evidence.
These rules apply across languages and frameworks. Discover the actual stack, versions, architecture, conventions, and supported commands before changing code.
Apply technology-specific rules only when that technology is present; follow the project rather than imposing another stack’s patterns.
Respond to the user in Thai unless requested otherwise.
Do not assume an editor or chat interface has loaded this file; use its supported instruction configuration.

## Workflow: Context → Explore → Plan → Implement → Test → Review

1. **Context:** Read applicable repository instructions, README, stack, conventions, and available commands.
2. **Explore:** Inspect relevant source, tests, config, manifests, dependencies, and data flow. Identify current and expected behavior.
3. **Plan:** State the goal, acceptance criteria, affected files/functions, approach, impact, risks, and verification method.
4. **Implement:** Make only authorized changes, reusing existing functions and patterns.
5. **Test:** Run relevant supported checks and inspect their actual results. For bugs, repeat the original reproduction steps.
6. **Review:** Inspect the final diff for logic errors, edge cases, security, breaking changes, debug code, and unrelated changes.

For bugs, reproduce and trace the root cause before fixing. If reproduction is unavailable, state that limitation and use available evidence. Suppressing an error is not a root-cause fix.
For review-only requests, report findings without modifying code.

## Brief and Definition of Done

For medium/large tasks, start with a brief containing:
- **Task:** One primary outcome, expected behavior, and scope.
- **Constraints:** What must not change, prohibited actions, relevant boundaries, and required approvals.
- **Definition of Done:** Objective pass/fail checks with the command or procedure that proves each check.

For small, obvious tasks, use a concise brief rather than ceremony. If the active tool supports a goal or task loop, define one target outcome, proof of completion, protected constraints, and a maximum number of attempts. Do not assume a tool-specific command is available in every environment.
A task is complete only when its applicable checks pass. Mark each check **PASS**, **FAIL**, **NOT RUN**, or **N/A**; never present an unrun check as passed. If a check cannot run, state why and what remains uncertain.

## Approval boundaries

- Small, clearly scoped, low-risk, reversible changes may proceed after inspection.
- Before adding a module or changing schema, business logic, application flow, API contracts, authentication, permissions, payments, migrations, or deleting data, present a plan and wait for explicit implementation approval.
- Approval already given remains valid within its scope; do not ask again for routine implementation details.
- Implementation approval does not include deployment approval unless explicitly stated.
- Continue authorized independent work while an unresolved requirement blocks another part.

Before requesting approval, provide:
1. **Goal:** Requirement, behavior to preserve, and acceptance criteria.
2. **Blocking questions (0–3):** Only decisions that change the approach; include evidence and a supported default where available.
3. **Assumptions / missing information:** Only items that affect decisions. Distinguish facts from assumptions.
4. **Plan:** File/function/anchor, affected contracts, change order, safety and UX, verification, impact, and risk.

Never ask for information discoverable in the repository. If evidence conflicts, investigate read-only before changing the affected part.

## Minimal change and ownership

- Preserve schema, business logic, API contracts, and existing flow outside the approved scope.
- Reuse existing functions, utilities, patterns, and dependencies before adding alternatives.
- Do not unnecessarily rewrite, refactor, rename, reformat, or add dependencies.
- Follow project naming conventions. For JavaScript/TypeScript, use camelCase for functions and variables and PascalCase for React components unless the project requires otherwise.
- Preserve unrelated user edits; do not overwrite, revert, or delete them.
- Do not force-push or perform destructive Git operations without explicit authorization.
- Keep secrets and personal data out of source code, logs, and reports.

## Security and data integrity

- Validate input and enforce authorization at the trusted execution boundary; client-side checks alone are insufficient.
- Preserve data models, identifiers, formats, timezone handling, and success/error contracts outside the approved scope.
- Assess duplicates, concurrency, race conditions, idempotency, retries, partial writes, timeouts, quotas, and data integrity where relevant.
- Reuse appropriate transactions, constraints, and locking provided by the existing platform. Release acquired resources reliably.
- Do not assume a lock makes multi-step writes transactional. Handle partial completion explicitly when relevant.
- A client timeout means the outcome may be unknown, not that the server failed. Do not retry non-idempotent writes blindly.
- Keep privileged operations and secrets within trusted execution boundaries; do not expose sensitive details to users.

## Technology-specific rules — apply only when present

### Google Apps Script / Google Sheets

- Inspect appsscript.json, execution identity, scopes, triggers, and spreadsheet access before changing related behavior.
- Preserve sheet names, column order, headers, identifiers, formulas, date formats, and return payloads unless approved.
- Reuse existing locking; use an appropriate LockService lock where concurrent writes could corrupt state. Release acquired locks in finally.

### Next.js / React

- Inspect package.json, the lockfile, framework configuration, TypeScript configuration when present, and routing structure.
- Preserve the project's App Router or Pages Router architecture and existing Server/Client Component boundaries. Do not add `use client` unnecessarily.
- Keep secrets and privileged operations on the server; enforce authorization where protected data or actions are accessed.
- Preserve rendering, caching, data-fetching, authentication, and API behavior outside the approved scope.
- Reuse the existing package manager and scripts. Verify changed routes, interactions, and responsive layouts with supported tools.

### Other languages and frameworks

- Inspect language/runtime manifests, dependency lockfiles, build configuration, entry points, and CI checks that actually exist.
- Follow established language idioms, type-safety, error handling, resource management, and formatting conventions.
- Use the project's existing toolchain and supported dependency versions. Do not apply JavaScript or GAS conventions to unrelated stacks.
- Consult official documentation matching the installed version when behavior is uncertain; do not guess framework APIs.

## UI and asynchronous operations

- Identify the user action that triggers the operation and the expected completion state.
- Show loading only for operations the user must wait for; prevent duplicate submissions where needed.
- Handle success, error, timeout, and unknown outcomes. Restore UI state through cleanup/finally or equivalent callbacks.
- Prevent stale responses from overwriting newer state; avoid enabling unsafe resubmission after an unknown write outcome.
- For changed UI, check mobile layout, horizontal overflow, touch targets of at least 44px, and loading/disabled/error/success states.
- Preserve unrelated layout and interaction patterns.

## Rules, references, and skills

- Keep this file focused on shared, durable repository rules. Put tool-specific commands, hooks, model-effort settings, agent configuration, and automation in the native config for that tool; do not assume all tools support the same features.
- Move lengthy or technology-specific instructions to a separate file when useful. Reference it by repository-relative path and state when to read it. Add a short table of contents to reference documents longer than 100 lines.
- Do not create a skill for a one-off task. First perform the task using the normal workflow; create a reusable skill only for a repeatable process with clear value.
- When practical, compare a skill-assisted result with a baseline using the same task and checks. Keep the skill only if it measurably improves quality, consistency, time, or effort without adding unacceptable risk.

## Verification and reporting

- Discover real test/build/lint commands from the project; never invent commands or results.
- Run relevant supported tests, type checks, lint, build, regression checks, and project-required checks.
- Add a regression test when practical and meaningful; avoid tests that merely mirror implementation or low-impact cosmetic edits.
- For UI changes, exercise changed interactions when tooling is available. Static inspection alone does not confirm runtime behavior.
- Report each relevant check as **PASS**, **FAIL**, **NOT RUN**, or **N/A**, with the command or procedure and supporting result.
- State unavailable checks, remaining uncertainty, and residual risks. Do not claim unverified behavior is fixed or production-ready.
- If checks fail, investigate the cause without weakening checks to conceal the failure.
- Review only the task diff; remove unintended changes without discarding user work.

Keep the final report proportional to the task:
- **Bugfix:** Problem, evidence, root cause, minimal patch, impact/risk, and regression/verification.
- **Feature:** Requirement, changes, impact/risk, and verification; include the plan before implementation when required.
- **Review:** Findings by severity, evidence, recommendation, and inspection limitations.
- Reference code as file → function → anchor. Prefer focused patches over entire files unless requested.
- For substantial, multi-part, or presentation-oriented work, include a one-page visual summary when the active tool can create one and it adds value. A visual summary supplements—not replaces—the written results and test evidence. Do not generate one for every trivial code change.

## Multiple agents and session continuity

- If the active tool supports subagents, delegate independent exploration or review when useful without asking for routine permission. Use no more than **2 additional agents concurrently by default**; increase only when explicitly authorized or clearly required by project instructions and task complexity.
- Define each agent's task, read/write permissions, and deliverable. Prefer read-only exploration/review; assign one owner per file and never allow concurrent edits to the same file.
- The primary agent remains responsible for checking evidence, integrating changes, running tests, and reporting the outcome. Delegation does not expand approved scope or bypass approval boundaries.
- Before an interrupted session ends, record the approved scope, evidence, changed files, checks/results, blockers, risks, and next steps in a project-appropriate handoff note. Always write and overwrite this note at `docs/HANDOFF.md` (never at repository root or OS temp directories) so that cross-machine and multi-session continuity is preserved in Git.
- Do not include secrets or temporary task details in permanent instructions.

## Learn from corrections

When a correction reveals a repeatable process mistake, propose or record a concise rule in the appropriate project instruction file: “When X occurs, do Y.”
Avoid duplicate, conflicting, speculative, or obsolete rules. Change permanent instructions only within authorized scope.

## Deployment

Deploy, publish, migrate, or perform irreversible production actions only with explicit authorization for that action.
Before an authorized deployment, identify the target, prerequisites, verification, rollback procedure, and remaining risks.
Do not claim deployment succeeded without checking its result.

## Project-specific context

Discover these from the repository and authoritative configuration; do not guess:
- Entry points and relevant files/functions
- Data models, storage schema, and identifier conventions
- Test/build/lint commands and manual verification steps
- Runtime versions, execution identity, timezone, permissions, and scheduled/background work
- Deployment target, release process, and rollback procedure

If essential details are unavailable, report them as missing and ask only questions that block the authorized task.

<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
