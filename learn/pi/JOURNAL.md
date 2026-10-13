# Pi learning journal

Write this yourself while completing the sprint. Do not use an agent to fill in comprehension answers before you attempt them.

## Environment inventory

| Item | Value |
|---|---|
| Date | |
| Operating system | |
| Shell | |
| Node version | |
| npm version | |
| Pi executable | |
| Pi version | |
| Pi package name | |
| Installed Pi docs path | |
| OpenRig checkout commit | |

## Starting model

Before Day 1, answer:

1. What do I currently mean by "context"?
2. What do I currently mean by "causality"?
3. What information do I believe a Pi session file contains?
4. What information do I expect only a live collector can observe?
5. What would make a cross-agent handoff trustworthy?

## Pi record map

| Record | Surface/direction | Durable in Pi? | Stable identifier | Final/streaming | Planned Wisdom treatment |
|---|---|---|---|---|---|
| | | | | | |

## Concept notes

Use one copy of this block per concept.

### Concept: _name_

**My prediction before studying:**

**Source read or watched:**

**Explanation in my own words:**

**Small experiment:**

**What surprised me:**

**How it changes Wisdom's design:**

**Question still unresolved:**

## Architecture decision record

Copy this block for every meaningful decision.

### ADR-_number_: _title_

- Status: proposed / accepted / replaced
- Date:
- Problem:
- Evidence:
- Options considered:
- Decision:
- Consequences:
- How to reverse or migrate:

Minimum decisions to record:

- Raw record hash boundary.
- Capture ordering mechanism.
- Stable source-record identity.
- Wisdom ID strategy.
- SQLite transaction boundary.
- Edge vocabulary and confidence.
- Coverage-gap representation.
- API pagination cursor.
- Raw-content exposure policy.

## Daily checkpoint

### Day _number_

**What I can now explain:**

**What I built:**

**Tests that prove it:**

**Known gaps:**

**Wrong assumptions corrected:**

**Tomorrow's first task:**

## Final reflection

Answer after Day 3:

1. What is the authoritative evidence in my system?
2. Which data is derived and safely rebuildable?
3. Which relationships are causal, correlated, lineage-only, or unknown?
4. How does a consumer detect incomplete capture?
5. What would adding Codex require from the canonical model?
6. Which Pi-specific assumptions should not become universal?
7. What is the safest future integration point in OpenRig?
8. What would I redesign before calling this production-ready?
