import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships } from "@paperclipai/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export type ResponsibleUserValidation =
  | { valid: true; userId: string }
  | { valid: false; reason: "not_found" | "inactive_membership" | "viewer" };

/** One authoritative eligibility check for persisted human responsibility. */
export async function validateResponsibleUser(
  db: DbOrTransaction,
  input: { companyId: string; userId: string },
): Promise<ResponsibleUserValidation> {
  const user = await db.select({ id: authUsers.id }).from(authUsers)
    .where(eq(authUsers.id, input.userId)).then((rows) => rows[0] ?? null);
  if (!user) return { valid: false, reason: "not_found" };
  const membership = await db.select({ status: companyMemberships.status, role: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, input.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, input.userId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!membership || membership.status !== "active") return { valid: false, reason: "inactive_membership" };
  if (membership.role === "viewer") return { valid: false, reason: "viewer" };
  return { valid: true, userId: input.userId };
}
