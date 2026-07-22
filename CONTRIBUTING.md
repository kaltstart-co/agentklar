# Contributing to Agentklar

Thanks for wanting to help. Agentklar is a local-first, agent-neutral toolkit that
gives AI coding agents durable tracking, machine-attested evidence, and a completion
boundary a model cannot cross. It's early (Phase 0/1), so good contributions have a lot
of leverage right now.

## Before you start

- **Small fix or docs?** Open a PR directly.
- **New feature, behavior change, or anything touching the workflow, the completion
  boundary, or a public contract?** Open an **issue or discussion first** so we can agree
  on the approach before you write code. The design lives in
  [`docs/superpowers/specs`](docs/superpowers/specs) and the phased roadmap in
  [`docs/superpowers/plans`](docs/superpowers/plans) — skim the relevant part first.

## Dev setup

Requirements: **Go 1.25+**, **git**, macOS or Linux. No Docker or sudo needed.

```bash
git clone https://github.com/kaltstart-co/agentklar
cd agentklar
go build ./...
go test ./...
```

The live Vikunja integration tests skip unless you point them at a running server:

```bash
export AGENTKLAR_VIKUNJA_URL="http://localhost:3456/api/v1"
export AGENTKLAR_VIKUNJA_HUMAN="you:password"
export AGENTKLAR_VIKUNJA_SVC="agentklar-svc:password"
go test ./internal/tracker/vikunja/ -run TestLive
```

## The quality bar

Agentklar is a tool about *not shipping slop*, so we hold its own code to the same line:

- **Every change ships with tests.** Bugs get a failing test first; features get tests
  that prove the behavior. The guarantees in the design are executable tests, not prose.
- **`gofmt` clean** and `go vet` clean. CI enforces both.
- **No placeholder code, silenced errors, or disabled tests.** These are exactly what
  Agentklar's own Slop Guard blocks — don't add them here.
- **Keep packages focused.** Each `internal/*` package has one job; look at how the
  existing ones are bounded before adding to them.
- **Never widen the agent surface's authority.** The agent-facing MCP has no approve /
  reject / done method, by design. A PR that adds one will be declined. See
  `internal/contracts` and the tests in `internal/mcp`.

## Where help is wanted

Good first areas, roughly in roadmap order:

- Cross-provider reviewer adapters (Codex / Gemini / OpenCode) with
  read-only, disposable review snapshots.
- FTS5 context indexing and bounded work packets.
- Established-project onboarding (`agentklar init` discovery).
- The community **pack** library (`agentklar pack ...`) — see the
  [community library plan](docs/superpowers/plans/2026-07-21-agentklar-community-library-plan.md).
- A signed release + interactive installer.

## Commits & PRs

- Use clear, imperative commit subjects, ideally prefixed: `feat:`, `fix:`, `docs:`,
  `test:`, `refactor:`, `chore:`.
- Keep PRs focused on one change. Explain *what* and *why*; link the issue.
- Make sure `go build ./...` and `go test ./...` pass before you open the PR.

## Reporting security issues

Please **do not** open a public issue for vulnerabilities — especially anything that
could let an agent bypass the human-only completion boundary. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](LICENSE).
