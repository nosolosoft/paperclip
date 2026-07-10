import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys } from "@paperclipai/db";
import { validateResponsibleUser, type ResponsibleUserValidation } from "./responsible-user.js";

export type OrphanedAgentApiKey = {
  id: string;
  agentId: string;
  companyId: string;
  name: string;
  responsibleUserId: string | null;
  invalidReason: "not_found" | "inactive_membership" | "viewer";
};

/** Lists active keys whose named human is no longer eligible to own them. */
export async function listOrphanedAgentApiKeys(db: Db, companyId: string): Promise<OrphanedAgentApiKey[]> {
  const keys = await db.select({
    id: agentApiKeys.id,
    agentId: agentApiKeys.agentId,
    companyId: agentApiKeys.companyId,
    name: agentApiKeys.name,
    responsibleUserId: agentApiKeys.responsibleUserId,
  }).from(agentApiKeys).where(and(eq(agentApiKeys.companyId, companyId), isNull(agentApiKeys.revokedAt)));
  const inventory: OrphanedAgentApiKey[] = [];
  for (const key of keys) {
    const validation: ResponsibleUserValidation = key.responsibleUserId
      ? await validateResponsibleUser(db, { companyId, userId: key.responsibleUserId })
      : { valid: false, reason: "not_found" };
    if (!validation.valid) inventory.push({ ...key, invalidReason: validation.reason });
  }
  return inventory;
}
