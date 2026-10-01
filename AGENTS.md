# AgentKlar
Fresh TypeScript implementation. src/ owns the local durable service, Codex app-server adapter, and MCP stdio bridge. web/ owns the React and Mantine support UI. One root npm package. Node 24.

Keep native harness config, authentication, and permission decisions. Only the trusted local UI can answer concrete native approval requests. MCP cannot approve. Completion means the worker finished; it does not mean a human reviewed the changes. Do not read or migrate legacy AgentKlar databases.

Use plain English. Prefer small functions and native libraries. Validate inputs at API boundaries. Run npm run check, npm test, and npm run build. Real inference tests must be bounded and explicitly authorized. Avoid storing credentials, native auth payloads, or full event dumps.
