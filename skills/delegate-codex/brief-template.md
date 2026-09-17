# <task title, one line>

## Goal
One paragraph: what must be true when you are done. Outcome, not steps.

## Context
- Repo/dir: <path> (the launcher passes --cd; every relative path is relative to it)
- Read first: <2–5 files or grep targets, with line ranges where possible>
- Known facts / already ruled out: <bullets; save the worker from re-deriving>

## Scope
- In: <files/modules the worker may change>
- Out: <what NOT to touch, e.g. "do not commit", "no new dependencies", "don't edit lib/console.js — another worker owns it">

## Constraints
- <project rules that apply: zero deps, tests must stay green, style rules, safety rules>
- Fix the category, not the instance: if this is a bug, audit every site where it can occur and report a per-site verdict.

## Acceptance criteria
- [ ] <observable check 1 — a command and its expected output, or a file state>
- [ ] <check 2>
- [ ] `npm test` (or the project's equivalent) green; paste the tail.

## Report format
DONE / ACCEPTANCE (each criterion pass|fail) / VERIFICATION (commands + summarized output) / FILES TOUCHED (with line ranges) / OPEN QUESTIONS.
Ambiguity or blocker: stop and ask under OPEN QUESTIONS. Never guess a decision that belongs to the orchestrator.

## Why each section exists
- Goal: prevents solving the wrong problem.
- Context: prevents re-reading the world.
- Scope out: prevents collateral edits.
- Constraints: keeps the worker inside project rules without re-deriving them.
- Acceptance criteria: makes "done" checkable.
- Report format: matches the worker preamble's required sections.

The launcher prepends worker-preamble.md automatically; the template is for the orchestrator's side.
