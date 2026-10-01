# Build plan

The old application has been replaced. Git retains its source. This plan describes the new implementation only.

1. **Current slice:** one local TypeScript service, a small React support UI, durable SQLite records, MCP stdio bridge, explicit projects and roles, and the native Codex worker. Keep the existing harness as the user's starting point.
2. **More harnesses:** add Claude Code, Gemini CLI, Cursor, and OpenCode workers only after verifying their real native interfaces, authentication, lifecycle, and permission behavior. Discovered CLI presence does not prove worker support.
3. **Shared project setup:** add project configurations and skills with visible ownership and native harness compatibility. Preserve existing entry points and files.
4. **Model choice:** add measured benchmarks and transparent recommendations. Keep actual usage separate from estimates; cost preference alone is not evidence of model quality.
5. **Longer workflows:** support lead and worker coordination, review and fix loops, explicit handoff, and more worker concurrency when real work needs them. Avoid a forced completion ceremony.
6. **Reach and setup:** add service startup support, secure device pairing, and remote access after the local permission and ownership boundaries are proven. The hosted UI currently has no connection to localhost.

Do not add an LLM gateway, API key requirement, chat, editor, or browser. Build one verified path before widening the adapters.
