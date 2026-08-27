import { companyMemberships, type createDb } from "@paperclipai/db";

export async function seedResponsibleUserMembership(
  db: ReturnType<typeof createDb>,
  companyId: string,
  principalId = "responsible-user",
): Promise<void> {
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId,
    membershipRole: "owner",
    status: "active",
  });
}
