# Agentklar Community Library — Design Plan

**Status:** Proposed. Depends on the optional APM adapter (design §6.2) and pack
enablement (design §13). Not part of the Phase 0/1 slice.

**Date:** 2026-07-21

**Goal:** Let anyone build, share, and install community-made Agentklar features —
review lenses, quality recipes, project skills, agent configs — with the least
possible new machinery. The library must feel like publishing a GitHub repo, not
uploading to a store.

## 1. Principle: compose, don't build a marketplace

Design non-goal §2 forbids Agentklar from becoming "a general MCP, cloud SDK,
framework-skill, or deployment marketplace." The community library honors that by
owning **no registry backend, no hosted index service, and no new daemon**. Every
capability below is delivered by a tool that already exists:

| Need | Reused tool | Not built |
|---|---|---|
| Distribution | **Git repositories** (any host) | A package registry |
| Install / pin / compile / audit | **Microsoft APM** (`apm.yml`, `apm.lock.yaml`) | A dependency resolver |
| Skill format | **Agent Skills specification** (agentskills.io) | A bespoke skill format |
| Review / submission | **GitHub / GitLab pull requests** | A moderation service |
| Discovery | A curated **`awesome-agentklar` list** (a git repo) + host topics | A search service |
| Trust / integrity | **APM integrity hashes** + git provenance | A signing authority |
| Evaluation | The existing **Review Pack eval corpus** (design §10.6) | A new CI product |

A community pack is therefore just a git repo with a manifest. Publishing is a
`git push`. That is the entire hosting story.

## 2. What a community pack is

Four kinds, matching the units Agentklar already understands:

1. **Review Pack** — a specialist review lens (a framework's idioms, a security
   ruleset, an accessibility checklist). Loads only when changed paths match its
   scope (design §10.6).
2. **Quality recipe bundle** — reusable `.agentklar/quality.toml` fragments for a
   language or framework (e.g. "Django L0–L2", "Rust workspace").
3. **Project skill** — an interrogator template, a planning playbook, a debugging
   method, packaged per the Agent Skills spec.
4. **Agent config** — harness-specific setup that raises a new client to a tested
   compatibility tier (design §6 compatibility contract).

Each pack is one repo (or one directory in a monorepo of packs).

## 3. The manifest

One file at the pack root, `agentklar-pack.toml`, declares everything Agentklar
needs to show cost and enforce boundaries **before** enabling anything:

```toml
[pack]
name        = "django-review"
version     = "1.2.0"
kind        = "review-pack"          # review-pack | quality-recipes | project-skill | agent-config
summary      = "Django idioms, N+1 detection, migration safety"
license     = "MIT"
homepage    = "https://github.com/example/agentklar-django-review"

[compatibility]
agents      = ["codex", "gemini", "opencode"]   # tested targets
scopes      = ["**/models.py", "**/migrations/**"]  # when this pack loads

[cost]
context_tokens = 900                 # measured, shown before enable
network        = "none"              # none | declared-hosts
permissions    = ["read-only"]       # read-only reviewers cannot mutate

[provenance]
maintainer  = "example"
source      = "git+https://github.com/example/agentklar-django-review"
```

The manifest maps onto the pack-metadata record Agentklar already keeps
(design §13): identifier, version, integrity hash, supported agents, permissions,
context size, enabled scopes. APM owns resolution, pinning, and integrity; the
manifest just declares intent.

## 4. Building a pack (author flow)

The whole flow is four commands and never leaves the author's own repo:

```text
agentklar pack init django-review --kind review-pack
    # scaffolds: agentklar-pack.toml, the skill/recipe from a reviewed template,
    #            and a fixtures/ directory with example inputs

# ... author edits the skill or recipe ...

agentklar pack validate
    # checks the manifest, the Agent Skills format, scope globs, and that
    # declared permissions/network match what the pack actually references

agentklar pack test
    # runs the pack against its fixtures:
    #   review-pack     -> a corpus of known-good + seeded-defect diffs
    #                      (must catch the defects, must not flag the clean ones)
    #   quality-recipes -> the recipes run and produce machine-attested output
    #   project-skill   -> the skill loads and its examples resolve

agentklar pack publish
    # 1. tags the version in git
    # 2. (optional) opens a PR to the community index repo — a GitHub PR,
    #    no Agentklar-hosted service involved
```

`pack init` uses a small reviewed template (design plan Task 7: "generate skills
from a small reviewed template, not arbitrary giant prompts"), so authors start
from something that already passes `validate`.

## 5. Installing and using a pack (consumer flow)

```text
agentklar pack add github.com/example/agentklar-django-review
    # APM resolves the repo, pins it in apm.lock.yaml, records the integrity
    # hash, and prints context cost + permissions for approval before enabling

agentklar pack enable django-review --project        # workspace | project | session
```

Enablement reuses the existing scope model (design §13): session overrides
project overrides workspace; user and project instructions override pack
instructions; disabled packs deploy nothing and cost no context.

## 6. Discovery without a service

Discovery is a **curated list, not a search backend**:

- A community-maintained `awesome-agentklar` git repo holds a reviewed
  `index.json` (name, kind, repo URL, one-line summary, tags). Adding a pack is a
  PR against that repo — the same review surface every OSS list already uses.
- `agentklar pack search <term>` reads that index (cached locally, rebuildable),
  filters by kind/tag/agent, and shows cost before install.
- Git host topics (`agentklar-pack`, `agentklar-review-pack`) give a zero-infra
  fallback for finding packs the index hasn't listed yet.

No hosted index means no uptime to run and no gatekeeper to become — the list is
just data in a repo.

## 7. Trust and safety (all reused boundaries)

Community packs inherit every existing guardrail; the library adds none of its own
enforcement code:

- **Explicit enable only.** Packs never auto-load (design non-goal: "load every
  project, document, skill, or MCP schema into every prompt" is forbidden). A
  freshly added pack is Cached, not active.
- **Cost shown first.** Context tokens, permissions, and network are surfaced
  before enable, through the existing context-budget warning.
- **Custom, never recommended.** Community packs appear only under "Custom" and
  are never part of a recommended install (design §13).
- **Read-only review by default.** A community Review Pack runs under the same
  disposable-snapshot, read-only reviewer sandbox as core packs (design §10.5) —
  a third-party lens cannot edit, push, or weaken tests.
- **Allowlisted recipes only.** A community quality bundle still declares recipes
  in `.agentklar/quality.toml` with enforced workdir/timeout/network; nothing runs
  that the project did not approve.
- **Integrity + provenance.** APM pins a hash and records source; a changed
  upstream is a visible drift, not a silent update (design §14, Propose policy).
- **Review Packs are evaluated before promotion.** The eval corpus that gates core
  packs (design §10.6) is the same one `pack test` runs, so a community pack is
  held to the same false-positive/false-negative bar.

## 8. What this adds to Agentklar

Only a thin `agentklar pack` command group and one template set:

```text
agentklar pack init      scaffold from a reviewed template
agentklar pack validate  manifest + format + scope + permission checks
agentklar pack test      run against fixtures / eval corpus
agentklar pack publish   git tag (+ optional index PR)
agentklar pack search    read the curated index
agentklar pack add       resolve + pin via APM, show cost, cache
agentklar pack enable    scope-based activation (existing model)
```

Everything under the hood — resolution, pinning, integrity, review sandboxing,
recipe execution, enablement scopes, context accounting — is machinery Agentklar
already has or delegates to APM. The library is a **workflow over existing parts**,
which is exactly the project's first design principle.

## 9. Delivery

This lands after the optional APM adapter (design Phase 6). Suggested increments:

1. Freeze `agentklar-pack.toml` and the four pack kinds; ship `pack validate`.
2. `pack init` templates + `pack test` against fixtures for one kind (Review Pack).
3. `pack add`/`enable` over APM with cost-before-enable and Custom-only placement.
4. The `awesome-agentklar` index repo + `pack search`/`pack publish` PR flow.
5. Extend `test`/templates to the remaining three kinds.

Each increment is independently useful: authors can build and validate packs
(steps 1–2) before any install path exists, and users can install by URL (step 3)
before discovery (step 4) is built.
