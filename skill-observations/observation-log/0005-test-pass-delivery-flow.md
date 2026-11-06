---
id: 5
title: "Standard delivery sequence: test, handoff update, git commit, push, and cloudflare deployment sync"
status: actioned
type: internal
skill: []
proposes_skill: [continuous-delivery-workflow]
target_file: [AGENTS.md]
siblings_checked: none
area: "delivery / handoff automation"
date: 2026-11-02
session_context: "Requisition form placeholder and validation update with automated handoff and deploy"
parked_until:
resolved: 2026-11-06
resolution: "Documented as Rule 7 (Standard Delivery & Completion Pipeline) in AGENTS.md enforcing the 4-step completion sequence (test pass -> handoff update -> git commit -> git push -> deploy verification)."
reference:
commands_verified: none
---

**Issue:** User requires a strict recurring completion workflow whenever tests pass: update `docs/HANDOFF.md`, create git commit, push to GitHub, and sync deployment to Cloudflare. Without this explicit checklist or rule, sessions might finish after tests without recording the handoff or triggering deployment.

**Suggested improvement:** Document this rule in `AGENTS.md` and project delivery procedures: "Whenever implementation tests pass, always (1) update `docs/HANDOFF.md`, (2) git commit, (3) git push to origin, and (4) verify Cloudflare deployment sync."

**Principle:** Quality assurance does not end at passing unit tests; completion requires synchronizing the durable handoff log, version control, and remote deployment pipeline.
