# Agent review architecture

Decision date: 2026-10-19. Status: agreed direction for when we introduce multiple agents; not implemented by this note.

## The decision

Reuse OpenRig's coordination ideas: task ownership, durable queues, review handoffs, and explicit integration ownership. Make our runtime prepare workspaces and generate code evidence. Do not depend on agents remembering bookkeeping or on their summaries proving what changed.

This is inspired by the local OpenRig checkout at 76a4b335. Its software-factory example and wave SDLC describe exact candidates, evidence, work boundaries, and independent review. Do not confuse those workflow instructions with automatic per-write attribution or automatic snapshots at agent launch.

## Default review package

A reviewer normally needs a known baseline, the attributable net contribution, a fixed candidate, relevant intent, and verification evidence. It does not need every intermediate edit loaded into context. Keep references to the underlying conversation for investigation.

- Baseline: the exact starting code, including relevant existing uncommitted changes if those are part of the task input.
- Contribution: changes attributable to this task, with incoming changes explicitly accounted for.
- Candidate: immutable code version being reviewed; do not use a moving working directory as its identity.
- Intent: task, acceptance criteria, constraints, decisions, and conversation references. Agent explanations remain claims, not independently established facts.
- Verification: candidate identity, command, result, output reference, and limitations. An agent saying tests passed is not equivalent to runtime-recorded test evidence.
- Dependencies: other contributions needed to understand or execute this one.

## Runtime responsibilities

1. Bind an assignment to task, agent, workspace, and baseline IDs.
2. Prepare a separate worktree per task by default and launch the agent there. Worktrees separate normal activity but are not filesystem security boundaries.
3. Record incoming integrations or explicit baseline changes; never silently attribute incoming work to the task's agent.
4. At review request, consistently capture a fixed candidate, including relevant uncommitted and newly created files. Quiesce writers or otherwise establish a consistent capture.
5. Generate the baseline-to-candidate diff and attach intent/evidence references to the durable review handoff.
6. Bind the review verdict to that candidate ID. Changed candidates require appropriately scoped renewed review.
7. Bind runtime-managed tests to the tested code. Concurrent changes invalidate a simple claim that the final candidate was tested; flag or rerun against the fixed candidate.
8. Check that integration uses the reviewed candidate and account for any integration changes and checks.

The agent supplies reasoning and implementation. The runtime supplies recorded code facts and handoff identity. The reviewer supplies independent judgment.

## Parallel work limitation

Initial and final snapshots alone cannot isolate Agent 1's contribution when multiple writers share a workspace. A Git commit identifies content, not per-agent authorship. Disjoint file ownership is a convention unless enforced. Shared overlapping writes require write instrumentation and coordination, or an explicit unknown-attribution label.

Prefer isolated task workspaces for the first multi-agent implementation. Review the integrated result as well when interaction between contributions matters.

## Current scope

We are still learning to track one Pi session. Do not build orchestration, task worktrees, or review automation merely because this note exists. See [single-session storage](single-pi-storage.md).
