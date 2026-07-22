# Security Policy

Agentklar's core promise is a trust boundary: an AI agent can claim, submit, and prove
work, but **only a human can mark it done**. Anything that could let an agent, a stale
worker, or a service account cross that boundary is a serious security issue and we want
to hear about it privately.

## Reporting a vulnerability

**Please do not open a public issue.** Instead, use one of:

1. **GitHub private vulnerability reporting** — the preferred channel. On this repo, go to
   the **Security** tab → **Report a vulnerability**.
2. Email **security@kaltstart.co** with a description and, ideally, a minimal reproduction.

Please include:

- What the issue is and the impact (e.g. "an agent-callable path can reach `done`").
- Steps to reproduce or a proof of concept.
- Affected version / commit.

We'll acknowledge your report, work with you on a fix, and credit you (if you'd like)
once a fix is released. Please give us reasonable time to address the issue before any
public disclosure.

## Especially in scope

- Any way to reach the `done` state without a valid, human-authored, nonce-bound approval.
- A stale or duplicate worker mutating protected workflow state after its lease is superseded.
- The approval nonce leaking to the agent surface.
- Evidence that is agent-reported being treated as machine-attested.
- A reviewer or community pack escaping its read-only / sandboxed boundary.

## Out of scope

- Vulnerabilities in third-party components (Vikunja, Go toolchain, etc.) — report those
  upstream, though a heads-up is welcome.
- Issues that require an already-compromised local machine or the user handing an agent
  their own tracker credentials (documented as a weakened boundary).
