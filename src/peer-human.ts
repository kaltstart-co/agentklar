import { z } from "zod";

const uuid = z.uuid();
const token = z.string().regex(/^[0-9a-f]{64}$/);
export const humanAnswerSchema = z.object({approvalId:z.string().min(1).max(200),requestId:uuid,expectedDigest:token,decision:z.string().min(1).max(200)}).strict();
export const humanEnvelopeSchema = z.object({version:z.literal(1),channel:z.literal("human"),sourceDeviceId:uuid,targetDeviceId:uuid,humanGrantId:uuid,token,operation:z.enum(["list","read","answer"]),runId:uuid,approvalId:z.string().min(1).max(200).optional(),requestId:uuid,expectedDigest:token.optional(),decision:z.string().min(1).max(200).optional()}).strict();
export type HumanEnvelope = z.infer<typeof humanEnvelopeSchema>;
export type HumanCall = (runId:string,operation:HumanEnvelope["operation"],fields:Record<string,string>) => Promise<{status:number;body:unknown}>;
export type HumanGrant = {id:string;grantId:string;sourceDeviceId:string;ownerDeviceId:string;projectId:string;tokenHash:string;revoked:boolean};
export type HumanConfiguration = {id:string;humanGrantId:string;token:string;grantId:string;deviceId:string;remoteProjectId:string};
