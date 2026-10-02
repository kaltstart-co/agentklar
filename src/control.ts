import {
  createHash,
  randomUUID
} from 'node:crypto';
import type {
  DatabaseSync
} from 'node:sqlite';
import type {
  ProjectLead,
  ControlStatus,
  ControlPacket,
  ControlReceipt
} from './contracts.ts';
export class ControlError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}
export class Control {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_control(projectId TEXT PRIMARY KEY,mode TEXT NOT NULL,revision INTEGER NOT NULL,epoch INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS control_packets(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS control_receipts(requestId TEXT PRIMARY KEY,packetId TEXT UNIQUE NOT NULL,bridgeId TEXT NOT NULL,inputs TEXT NOT NULL,data TEXT NOT NULL); UPDATE project_control SET revision=revision+1;`);
  }
  status(projectId: string, lead: ProjectLead|null): ControlStatus {
    this.db.prepare("INSERT OR IGNORE INTO project_control VALUES(?,'advisory',0,0)").run(projectId);
    const r = this.db.prepare('SELECT mode,revision FROM project_control WHERE projectId=?').get(projectId)!;
    return {
      projectId,
      mode: r.mode as ControlStatus['mode'],
      revision: Number(r.revision),
      lead
    };
  }
  bump(projectId: string) {
    this.status(projectId, null);
    this.db.prepare('UPDATE project_control SET revision=revision+1 WHERE projectId=?').run(projectId);
  }
  policy(projectId: string, mode: ControlStatus['mode'], expectedRevision: number) {
    const r = this.db.prepare('UPDATE project_control SET mode=?,revision=revision+1,epoch=epoch+1 WHERE projectId=? AND revision=?').run(mode, projectId, expectedRevision);
    if (r.changes !== 1) throw new ControlError('Project control changed. Read its current revision.');
  }
  stamp(projectId: string, bridgeId: string|undefined, lead: (ProjectLead& {
    bridgeId: string
  })|undefined, bypass: boolean) {
    const s = this.status(projectId, lead ?? null);
    if (!bypass && s.mode === 'coordinated' && (!bridgeId || !lead || lead.bridgeId !== bridgeId)) throw new ControlError('This project requires its active coordinating lead. Claim or accept a handoff first.');
    return {
      mode: s.mode,
      epoch: Number(this.db.prepare("SELECT epoch FROM project_control WHERE projectId=?").get(projectId)!.epoch),
      revision: s.revision,
      claimId: lead?.claimId ?? null,
      bypass,
      bridgeId
    };
  }
  check(projectId: string, stamp: ReturnType<Control['stamp']>, lead: (ProjectLead& {
    bridgeId: string
  })|undefined) {
    if (stamp.bypass)return;
    const s = this.status(projectId, lead ?? null);
    const epoch = Number(this.db.prepare("SELECT epoch FROM project_control WHERE projectId=?").get(projectId)!.epoch);
    if (stamp.mode === "advisory" && s.mode === "advisory" && epoch === stamp.epoch)return;
    if (s.revision !== stamp.revision || (lead?.claimId ?? null) !== stamp.claimId) throw new ControlError('Project control changed while this request was waiting. No new worker was launched.');
    if (s.mode === 'coordinated' && (!lead || lead.bridgeId !== stamp.bridgeId)) throw new ControlError('The coordinating lead is no longer active.');
  }
  prepare(input: Omit<ControlPacket, 'id'|'digest'|'createdAt'>): ControlPacket {
    const packet = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const full = {
      ...packet,
      digest: createHash('sha256').update(JSON.stringify(packet)).digest('hex')
    };
    if (JSON.stringify(full).length>22000) throw new ControlError('Handoff packet exceeds its review budget. Read project context and work pages separately.', 413);
    this.db.prepare('INSERT INTO control_packets VALUES(?,?,?)').run(full.id, full.projectId, JSON.stringify(full));
    return full;
  }
  read(projectId: string, id: string): ControlPacket {
    const row = this.db.prepare('SELECT data FROM control_packets WHERE projectId=? AND id=?').get(projectId, id);
    if (!row) throw new ControlError('Handoff packet not found.', 404);
    return JSON.parse(row.data as string);
  }
  receipt(id: string) {
    const row = this.db.prepare("SELECT data FROM control_receipts WHERE packetId=?").get(id);
    return row?JSON.parse(row.data as string) as ControlReceipt: undefined;
  }
  hasRequest(requestId: string) {
    return !!this.db.prepare("SELECT 1 FROM control_receipts WHERE requestId=?").get(requestId);
  }
  list(projectId: string, offset: number, limit: number) {
    const rows = this.db.prepare('SELECT data FROM control_packets WHERE projectId=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(projectId, limit+1, offset);
    return {
      packets: rows.slice(0, limit).map(r => {
        const p = JSON.parse(r.data as string) as ControlPacket;
        const receipt = this.db.prepare('SELECT data FROM control_receipts WHERE packetId=?').get(p.id);
        return {
          id: p.id,
          projectId,
          createdAt: p.createdAt,
          digest: p.digest,
          contextRevision: p.context.revision,
          controlRevision: p.control.revision,
          ...(receipt? {
            receipt: JSON.parse(receipt.data as string)
          }
          : {
          })
        };
      }),
      nextOffset: rows.length>limit?offset+limit: null
    };
  }
  accept(projectId: string, id: string, bridgeId: string, inputs: {
    requestId: string;
    expectedDigest: string;
    expectedContextRevision: number;
    expectedControlRevision: number
  }, contextRevision: number, status: ControlStatus, lead: ProjectLead): ControlReceipt {
    const encoded = JSON.stringify({
      projectId,
      id,
      ...inputs
    });
    const prior = this.db.prepare('SELECT bridgeId,inputs,data FROM control_receipts WHERE requestId=?').get(inputs.requestId);
    if (prior) {
      if (prior.bridgeId !== bridgeId || prior.inputs !== encoded) throw new ControlError('Acceptance request ID already used for a different handoff or client.');
      return JSON.parse(prior.data as string);
    }
    const packet = this.read(projectId, id);
    if (packet.digest !== inputs.expectedDigest || packet.context.revision !== inputs.expectedContextRevision || contextRevision !== inputs.expectedContextRevision || packet.control.revision !== inputs.expectedControlRevision || status.revision !== inputs.expectedControlRevision || packet.observedLead?.claimId !== (status.lead?.claimId)) throw new ControlError('Handoff is stale. Prepare and review a fresh packet.');
    const receipt: ControlReceipt = {
      id: randomUUID(),
      packetId: id,
      projectId,
      requestId: inputs.requestId,
      digest: packet.digest,
      revision: status.revision+1,
      lead,
      acceptedAt: new Date().toISOString()
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('UPDATE project_control SET revision=revision+1 WHERE projectId=? AND revision=?').run(projectId, status.revision).changes !== 1) throw new ControlError('Project control changed.');
      this.db.prepare('INSERT INTO control_receipts VALUES(?,?,?,?,?)').run(inputs.requestId, id, bridgeId, encoded, JSON.stringify(receipt));
      this.db.exec('COMMIT');
    }
    catch (e) {
      this.db.exec('ROLLBACK');
      if (e instanceof ControlError) throw e;
      throw new ControlError('This packet was already accepted.');
    }
    return receipt;
  }
}
