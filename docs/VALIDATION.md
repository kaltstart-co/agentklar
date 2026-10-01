# Validation evidence

Verified on 2026-10-01 using Node 24.21.0. The old application was not used.

`npm run check`, `npm test`, and `npm run build` pass. Ten automated test groups cover the official MCP SDK over the exact silent npm stdio setup, caller disconnect, persistence, canonical paths, project isolation, role context, full launch idempotency, busy behavior, cancellation, interrupted restart, exclusive SQLite service ownership, browser session separation across ports, possibly surviving process groups, input validation, permission boundaries, native event identity, and explicit response budgets.

The native CLI model catalog on this machine rejected `gpt-6.1-sol` for its ChatGPT account. Its installed catalog exposed `gpt-5.6-sol`, which was explicitly authorized for the bounded checks. No default Astra inference was used.

- Read-only smoke: `gpt-5.6-sol` returned exactly `AGENTKLAR_NATIVE_OK`, completed through the fresh service, and reported 19,541 native tokens. Native thread `01a0f51b-8fcd-7223-85b8-1b4bbe6bb6f9`; turn `01a0f51b-904e-7203-95a9-ef0beb6a0fb5`.
- Coding task: actual MCP stdio client started run `1fa64374-ca6a-4e61-af7a-5f9c3ee87d0b` in a disposable project. The client disconnected. Reconnecting and repeating the same idempotency key returned that exact run. A concrete native file approval showed only the authorized `add.js` creation. Its diff was inspected and allowed once through the authenticated local UI. The worker created the function, ran its existing tests, completed, and reported 20,211 native tokens. No separate command approval arose.
- Independent local check: only `add.js` and the original `add.test.js` existed. `node --test` passed both tests: numeric sum and TypeError for nonnumeric inputs.
- Read-only review: a separate `gpt-5.6-sol` run `af087837-f6e5-4737-ae26-45061a405740` examined that implementation and returned `NO_FINDINGS`, with 19,860 native tokens. No fix was required or exercised.

Local browser checks also verified project registration, task start and cancellation, saved team settings, concrete file and command permission displays, the hosted disconnected state, mobile layout, and event pagination beyond 200 events with a bounded visible history. Browser evidence was captured by the UI agent.

This proves one local Codex worker path. It does not prove other worker adapters, automatic service startup, device pairing, remote access, model quality benchmarks, remaining account quota, or a complete review-and-fix loop with a real finding. Those remain staged work.
