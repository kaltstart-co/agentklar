import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Approval } from "./contracts.ts";
import type { Store } from "./store.ts";

export const approvalAnswerSchema = z.object({
  approvalId: z.uuid(), requestId: z.uuid(), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.string().min(1).max(80),
}).strict();
export type ApprovalReceipt = {
  requestId: string; approvalId: string; runId: string; decision: string; digest: string;
  state: "recorded" | "submitted" | "callback_failed"; recordedAt: string; message: string;
};
export class ApprovalError extends Error { constructor(message: string, public status = 400) { super(message); } }
const digest = (approval: Approval) => createHash("sha256").update(JSON.stringify(approval)).digest("hex");
const byteLimit = 64_000;

/** One recorded decision consumes one live native callback. A receipt never proves native execution. */
export class Approvals {
  constructor(private store: Store, private answers: Map<string, (decision: string) => void>, private live: (runId: string) => boolean) {
    store.db.exec("CREATE TABLE IF NOT EXISTS approval_receipts(requestId TEXT PRIMARY KEY,approvalId TEXT UNIQUE NOT NULL,runId TEXT NOT NULL,data TEXT NOT NULL)");
  }
  private pending(runId: string, id: string) {
    const approval = this.store.approvals().find(a => a.id === id && a.runId === runId);
    if (!approval) throw new ApprovalError("Approval no longer pending", 404);
    return approval;
  }
  private receipt(column: "requestId" | "approvalId", id: string) {
    const row = this.store.db.prepare(`SELECT data FROM approval_receipts WHERE ${column}=?`).get(id);
    return row ? JSON.parse(row.data as string) as ApprovalReceipt : undefined;
  }
  private complete(approval: Approval) {
    if (Buffer.byteLength(JSON.stringify({ approval, digest: digest(approval) })) > byteLimit)
      throw new ApprovalError("This native request is too large to relay completely. Review it in the owner computer's UI.", 413);
  }
  list(runId: string) {
    const pending = this.store.approvals().filter(a => a.runId === runId);
    return { ownerRunId: runId, approvals: pending.slice(0, 10).map(a => {
      let reason: string | undefined;
      try { this.complete(a); } catch (error) { reason = (error as Error).message; }
      if (!this.answers.has(a.id) || !this.live(runId)) reason = "The native worker is no longer available.";
      return { id: a.id, runId, kind: a.kind, title: a.title.slice(0,160), decisions: a.decisions, createdAt: a.createdAt,
        digest: digest(a), available: !reason, ...(reason ? { reason } : {}) };
    }), hasMore: pending.length > 10 };
  }
  read(runId: string, approvalId: string) {
    const receipt = this.receipt("approvalId", approvalId);
    if (receipt?.runId === runId) return { approval: null, receipt };
    const approval = this.pending(runId, approvalId);
    this.complete(approval);
    if (!this.answers.has(approvalId) || !this.live(runId)) throw new ApprovalError("Native worker unavailable",409);
    return { approval, digest: digest(approval) };
  }
  local(approvalId: string, decision: unknown) {
    const approval = this.store.approvals().find(a => a.id === approvalId);
    if (!approval) throw new ApprovalError("Approval no longer pending",404);
    return this.consume(approval.runId, { approvalId, requestId: randomUUID(), expectedDigest: digest(approval), decision }, false);
  }
  consume(runId: string, input: unknown, relay = true): ApprovalReceipt {
    const parsed = approvalAnswerSchema.safeParse(input);
    if (!parsed.success) throw new ApprovalError("Provide a stable request ID, exact approval digest and supported decision.");
    const data = parsed.data;
    const prior = this.receipt("requestId",data.requestId);
    if (prior) {
      if (prior.runId !== runId || prior.approvalId !== data.approvalId || prior.digest !== data.expectedDigest || prior.decision !== data.decision)
        throw new ApprovalError("This request ID already recorded a different approval or decision.",409);
      return prior;
    }
    if (this.receipt("approvalId",data.approvalId)) throw new ApprovalError("A decision was already recorded for this approval. Refresh its receipt.",409);
    const approval = this.pending(runId,data.approvalId);
    if (relay) this.complete(approval);
    if (digest(approval) !== data.expectedDigest) throw new ApprovalError("The native request changed. Read and review its complete details again.",409);
    if (!approval.decisions.includes(data.decision)) throw new ApprovalError("Unsupported decision");
    const answer = this.answers.get(data.approvalId);
    if (!answer || !this.live(runId)) throw new ApprovalError("Native worker unavailable",409);
    let receipt: ApprovalReceipt = { requestId:data.requestId,approvalId:data.approvalId,runId,decision:data.decision,digest:data.expectedDigest,
      state:"recorded",recordedAt:new Date().toISOString(),message:"Decision recorded. Native execution is not confirmed." };
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare("INSERT INTO approval_receipts VALUES(?,?,?,?)").run(receipt.requestId,receipt.approvalId,runId,JSON.stringify(receipt));
      this.store.db.prepare("DELETE FROM approvals WHERE id=? AND runId=?").run(data.approvalId,runId);
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    this.answers.delete(data.approvalId);
    try { answer(data.decision); receipt = { ...receipt,state:"submitted",message:"Decision submitted to the native callback. Native execution is not confirmed." }; }
    catch {
      receipt = { ...receipt,state:"callback_failed",message:"Decision recorded, but the native callback failed. Native execution is unknown; this request cannot be answered again." };
      const run = this.store.run(runId);
      if (run) this.store.saveRun({ ...run,error:receipt.message,updatedAt:new Date().toISOString() });
    }
    this.store.db.prepare("UPDATE approval_receipts SET data=? WHERE requestId=?").run(JSON.stringify(receipt),receipt.requestId);
    return receipt;
  }
}
