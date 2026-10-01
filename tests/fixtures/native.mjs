import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let mode = "";
let turnId = "owned-turn";
const threadId = "owned-thread";
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    send({ id: m.id, result: {} });
    return;
  }
  if (m.method === "thread/start") {
    send({
      id: m.id,
      result: { thread: { id: threadId }, model: "native-fixture-model" },
    });
    return;
  }
  if (m.method === "turn/start") {
    mode = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      send({
        method: "turn/completed",
        params: {
          threadId: "foreign-thread",
          turn: { id: turnId, status: "completed" },
        },
      });
      if (mode === "wait" || mode.endsWith("\nTask:\nwait")) return;
      if (mode.includes("<project_data_json>")) {
        send({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { type: "agentMessage", text: mode },
          },
        });
        send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed" } },
        });
        return;
      }
      if (mode === "approval" || mode === "network") {
        send({
          id: 99,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "cmd",
            command: "echo safe",
            cwd: process.cwd(),
            ...(mode === "network"
              ? { networkApprovalContext: { host: "example.com" } }
              : {}),
          },
        });
        return;
      }
      if (mode === "unsupported") {
        send({
          id: 99,
          method: "item/tool/requestUserInput",
          params: { threadId, turnId },
        });
        return;
      }
      if (mode === "file") {
        send({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item: {
              id: "file",
              type: "fileChange",
              changes: [{ path: "test.txt", diff: "-old\n+new" }],
            },
          },
        });
        send({
          id: 99,
          method: "item/fileChange/requestApproval",
          params: { threadId, turnId, itemId: "file" },
        });
        return;
      }
      complete();
    }, 30);
    return;
  }
  if (m.id === 99 && m.result) {
    if (m.result.decision === "accept") complete();
    else
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "interrupted" } },
      });
  }
});
function complete() {
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", text: "fixture result" },
    },
  });
  send({
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: { last: { totalTokens: 12 } } },
  });
  send({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed" } },
  });
}
