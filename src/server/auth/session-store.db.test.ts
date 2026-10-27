// Session revocation against a real Postgres. Opt-in, like the other DB
// tests: set SCHEDULING_TEST_DATABASE_URL to a migrated database (never your
// dev database; the test creates and deletes its own school).

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { createPgAdapter } from "@/lib/pg-adapter";

import type { TokenIdentity } from "./credentials";
import { findSessionMembership, revokeSession } from "./session-store";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!url)("session store (database)", () => {
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let identity: TokenIdentity;
  const schools: string[] = [];

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: createPgAdapter(url),
    });
    const school = await client.school.create({
      data: { name: `Sess ${suffix}`, slug: `sess-${suffix}`, timezone: "UTC" },
    });
    const other = await client.school.create({
      data: {
        name: `Sess O ${suffix}`,
        slug: `sess-o-${suffix}`,
        timezone: "UTC",
      },
    });
    schools.push(school.id, other.id);
    const user = await client.user.create({
      data: { name: "Tina", email: `tina-${suffix}@example.test` },
    });
    await client.membership.create({
      data: { schoolId: school.id, userId: user.id, role: "TEACHER" },
    });
    identity = {
      userId: user.id,
      schoolId: school.id,
      role: "TEACHER",
      sessionId: randomUUID(),
    };
  });

  afterAll(async () => {
    if (!client) return;
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({
      where: { email: { endsWith: `-${suffix}@example.test` } },
    });
    await client.$disconnect();
  });

  it("accepts a session until it is revoked", async () => {
    const before = await findSessionMembership(client, identity);
    expect(before).toMatchObject({
      role: "TEACHER",
      sessionRevoked: false,
      user: { id: identity.userId, name: "Tina" },
      school: { id: identity.schoolId },
    });
    expect(before?.user).not.toHaveProperty("revokedSessions");

    const now = new Date();
    await revokeSession(client, identity, new Date(now.getTime() + DAY), now);
    // Signing out twice (two tabs) is fine.
    await revokeSession(client, identity, new Date(now.getTime() + DAY), now);

    await expect(
      findSessionMembership(client, identity),
    ).resolves.toMatchObject({ sessionRevoked: true });
  });

  it("only refuses the revoked session, not the user's other sign-ins", async () => {
    await expect(
      findSessionMembership(client, { ...identity, sessionId: randomUUID() }),
    ).resolves.toMatchObject({ sessionRevoked: false });
  });

  it("does not match a revocation recorded for another school", async () => {
    const sessionId = randomUUID();
    const now = new Date();
    await revokeSession(
      client,
      { ...identity, schoolId: schools[1], sessionId },
      new Date(now.getTime() + DAY),
      now,
    );
    await expect(
      findSessionMembership(client, { ...identity, sessionId }),
    ).resolves.toMatchObject({ sessionRevoked: false });
  });

  it("prunes revocations whose token has expired", async () => {
    const expired = { ...identity, sessionId: randomUUID() };
    const now = new Date();
    await revokeSession(client, expired, new Date(now.getTime() - DAY), now);
    await revokeSession(
      client,
      { ...identity, sessionId: randomUUID() },
      new Date(now.getTime() + DAY),
      now,
    );
    await expect(
      client.revokedSession.findUnique({ where: { id: expired.sessionId } }),
    ).resolves.toBeNull();
    await expect(
      client.revokedSession.findUnique({ where: { id: identity.sessionId } }),
    ).resolves.not.toBeNull();
  });
});
