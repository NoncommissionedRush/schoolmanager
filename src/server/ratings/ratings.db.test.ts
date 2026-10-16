// Ratings and calendar feeds against a real Postgres
// (docs/architecture/phase5-rules.md §4, §5, §7). Opt-in, like the other DB
// tests: set SCHEDULING_TEST_DATABASE_URL to a migrated database (never
// your dev database; the test creates and deletes its own schools).

import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { AdminError } from "@/server/admin/result";
import {
  createMyFeed,
  hasActiveFeed,
  loadFeedByToken,
  loadMyFeed,
  resetMyFeed,
  revokeFeedAsAdmin,
} from "@/server/calendar-feed/service";
import { scopeToSchool } from "@/server/db/school-scope";
import { zonedTimeToUtc } from "@/server/scheduling";
import type { SchoolDb } from "@/server/timetable/service";

import {
  loadRatingsOverview,
  loadTeacherRatings,
  setRatingHidden,
} from "./admin-data";
import { loadRatingForm, loadStudentRatings, saveRating } from "./student";

const url = process.env.SCHEDULING_TEST_DATABASE_URL;
const TZ = "Europe/Bratislava";
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return zonedTimeToUtc(date, h * 60 + m, TZ);
};
// Fri 20 Nov 2026, 12:00: rating is open (half-term 26 Oct).
const NOW = local("2026-11-20", "12:00");
const ORIGIN = "https://school.example";

process.env.ICAL_TOKEN_SECRET ??= "db-test-ical-secret-0123456789abcdef";

describe.skipIf(!url)("ratings and calendar feeds (database)", () => {
  // Unique per file: the cleanup deletes only this file's users.
  const suffix = randomUUID().slice(0, 8);
  let client: PrismaClient;
  let db: SchoolDb;
  let otherDb: SchoolDb;
  let schoolId: string;
  let otherId: string;
  const schools: string[] = [];
  const user: Record<string, string> = {};
  const ids = {
    tomas: randomUUID(),
    ana: randomUUID(),
    eva: randomUUID(),
    foreignTeacher: randomUUID(),
    sara: randomUUID(),
    pavol: randomUUID(),
    rita: randomUUID(),
    g1: randomUUID(),
    g2: randomUUID(),
    foreignGroup: randomUUID(),
    room: randomUUID(),
    term: randomUUID(),
    draft: randomUUID(),
    foreignTerm: randomUUID(),
  };
  const lessons = {
    l1: randomUUID(), // Mon 2 Nov, Tomas
    l2: randomUUID(), // Mon 9 Nov, Tomas (Pavol absent)
    l3: randomUUID(), // Mon 16 Nov, Tomas (Rita's replacement)
    l4: randomUUID(), // Mon 23 Nov, future (Sara absent)
    l5: randomUUID(), // Tue 10 Nov, cancelled
    l6: randomUUID(), // Thu 12 Nov, Ana substitutes
    l7: randomUUID(), // Wed 25 Nov, future, Ana substitutes
    far: randomUUID(), // 2027-07-01, outside the feed window
    old: randomUUID(), // Mon 7 Sep, Eva, outside the feed window (> 30 days)
    g2a: randomUUID(), // Rita's own group, Eva
    draftLesson: randomUUID(), // unpublished term
    foreign: randomUUID(),
  };
  const student = (name: "Sara" | "Pavol" | "Rita") => user[name];

  beforeAll(async () => {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const school = await client.school.create({
      data: { name: `Rate ${suffix}`, slug: `rate-${suffix}`, timezone: TZ },
    });
    const other = await client.school.create({
      data: {
        name: `Rate O ${suffix}`,
        slug: `rate-o-${suffix}`,
        timezone: TZ,
      },
    });
    schools.push(school.id, other.id);
    schoolId = school.id;
    otherId = other.id;
    db = scopeToSchool(client, schoolId);
    otherDb = scopeToSchool(client, otherId);

    const person = async (
      name: string,
      role: "ADMIN" | "TEACHER" | "STUDENT",
      inSchool = schoolId,
    ) => {
      const row = await client.user.create({
        data: { name, email: `${name.toLowerCase()}-${suffix}@example.test` },
      });
      user[name] = row.id;
      await client.membership.create({
        data: { schoolId: inSchool, userId: row.id, role },
      });
      return row.id;
    };
    await person("Admin", "ADMIN");
    for (const [name, id] of [
      ["Tomas", ids.tomas],
      ["Ana", ids.ana],
      ["Eva", ids.eva],
    ] as const) {
      await client.teacherProfile.create({
        data: { id, schoolId, userId: await person(name, "TEACHER") },
      });
    }
    await client.teacherProfile.create({
      data: {
        id: ids.foreignTeacher,
        schoolId: otherId,
        userId: await person("Olga", "TEACHER", otherId),
      },
    });
    for (const [name, id] of [
      ["Sara", ids.sara],
      ["Pavol", ids.pavol],
      ["Rita", ids.rita],
    ] as const) {
      await client.studentProfile.create({
        data: { id, schoolId, userId: await person(name, "STUDENT") },
      });
    }
    const level = await client.level.create({
      data: { schoolId, code: "B1", name: "B1", rank: 1 },
    });
    const foreignLevel = await client.level.create({
      data: { schoolId: otherId, code: "B1", name: "B1", rank: 1 },
    });
    await client.group.createMany({
      data: [
        {
          id: ids.g1,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "B1 Evening",
          capacity: 8,
        },
        {
          id: ids.g2,
          schoolId,
          levelId: level.id,
          type: "GROUP",
          name: "B1 Morning",
          capacity: 8,
        },
        {
          id: ids.foreignGroup,
          schoolId: otherId,
          levelId: foreignLevel.id,
          type: "GROUP",
          name: "Foreign",
          capacity: 8,
        },
      ],
    });
    const joined = new Date("2026-08-01T00:00:00Z");
    await client.groupMembership.createMany({
      data: [
        { schoolId, groupId: ids.g1, studentId: ids.sara, joinedAt: joined },
        { schoolId, groupId: ids.g1, studentId: ids.pavol, joinedAt: joined },
        { schoolId, groupId: ids.g2, studentId: ids.rita, joinedAt: joined },
      ],
    });
    await client.room.create({
      data: {
        id: ids.room,
        schoolId,
        name: "Online 1",
        kind: "ONLINE",
        meetingUrl: "https://meet.example/secret-room",
      },
    });
    const published = new Date("2026-08-20T00:00:00Z");
    await client.term.createMany({
      data: [
        {
          id: ids.term,
          schoolId,
          name: "Autumn 2026",
          startDate: new Date("2026-09-01"),
          endDate: new Date("2026-12-20"),
          timetablePublishedAt: published,
        },
        {
          id: ids.draft,
          schoolId,
          name: "Spring 2027",
          startDate: new Date("2027-01-10"),
          endDate: new Date("2027-06-20"),
        },
        {
          id: ids.foreignTerm,
          schoolId: otherId,
          name: "Autumn 2026",
          startDate: new Date("2026-09-01"),
          endDate: new Date("2026-12-20"),
          timetablePublishedAt: published,
        },
      ],
    });
    const lesson = (
      id: string,
      date: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      schoolId,
      termId: ids.term,
      groupId: ids.g1,
      teacherId: ids.tomas,
      roomId: ids.room,
      startsAt: local(date, "17:00"),
      endsAt: local(date, "18:00"),
      ...extra,
    });
    await client.lesson.createMany({
      data: [
        lesson(lessons.l1, "2026-11-02"),
        lesson(lessons.l2, "2026-11-09"),
        lesson(lessons.l3, "2026-11-16"),
        lesson(lessons.l4, "2026-11-23"),
        lesson(lessons.l5, "2026-11-10", {
          status: "CANCELLED",
          cancelReason: "HOLIDAY",
        }),
        lesson(lessons.l6, "2026-11-12", { substituteTeacherId: ids.ana }),
        lesson(lessons.l7, "2026-11-25", { substituteTeacherId: ids.ana }),
        lesson(lessons.far, "2026-12-18", {
          startsAt: new Date("2027-07-01T15:00:00Z"),
          endsAt: new Date("2027-07-01T16:00:00Z"),
        }),
        lesson(lessons.old, "2026-09-07", { teacherId: ids.eva }),
        lesson(lessons.g2a, "2026-11-03", {
          groupId: ids.g2,
          teacherId: ids.eva,
        }),
        lesson(lessons.draftLesson, "2027-01-11", { termId: ids.draft }),
        {
          id: lessons.foreign,
          schoolId: otherId,
          termId: ids.foreignTerm,
          groupId: ids.foreignGroup,
          teacherId: ids.foreignTeacher,
          startsAt: local("2026-11-24", "17:00"),
          endsAt: local("2026-11-24", "18:00"),
        },
      ],
    });
    // Pavol missed L2; Sara will miss L4 (future).
    const pavolAbsence = await client.absenceReport.create({
      data: {
        schoolId,
        lessonId: lessons.l2,
        studentId: ids.pavol,
        reason: "Doctor's appointment",
      },
    });
    await client.absenceReport.create({
      data: {
        schoolId,
        lessonId: lessons.l4,
        studentId: ids.sara,
        reason: "Private reason",
      },
    });
    // Rita missed her own lesson and joined L3 as a replacement.
    const ritaAbsence = await client.absenceReport.create({
      data: { schoolId, lessonId: lessons.g2a, studentId: ids.rita },
    });
    const credit = await client.makeupCredit.create({
      data: {
        schoolId,
        studentId: ids.rita,
        sourceLessonId: lessons.g2a,
        absenceReportId: ritaAbsence.id,
        status: "USED",
        usedAt: local("2026-11-04", "10:00"),
        expiresAt: local("2026-12-03", "00:00"),
      },
    });
    await client.replacementRequest.create({
      data: {
        schoolId,
        studentId: ids.rita,
        originalLessonId: lessons.g2a,
        targetLessonId: lessons.l3,
        makeupCreditId: credit.id,
      },
    });
    void pavolAbsence;
  });

  afterAll(async () => {
    if (!client) return;
    const where = { where: { schoolId: { in: schools } } };
    await client.teacherRating.deleteMany(where);
    await client.replacementRequest.deleteMany(where);
    await client.makeupCredit.deleteMany(where);
    await client.lesson.deleteMany(where);
    await client.school.deleteMany({ where: { id: { in: schools } } });
    await client.user.deleteMany({
      where: {
        email: { endsWith: `-${suffix}@example.test` },
        memberships: { none: {} },
      },
    });
    await client.$disconnect();
  });

  const rate = (
    name: "Sara" | "Pavol" | "Rita",
    teacherId: string,
    score: number,
    now = NOW,
    comment: string | null = null,
  ) =>
    saveRating(
      db,
      student(name),
      { teacherId, termId: ids.term, score, comment },
      now,
      TZ,
    );

  describe("ratings", () => {
    it("lists who the student can rate, with dates from the server", async () => {
      const data = await loadStudentRatings(db, student("Sara"), NOW, TZ);
      expect(data.current).toHaveLength(1);
      const cards = data.current[0].cards;
      // Tomas: L1, L2, L3 ended and attended (L5 cancelled, L4 future);
      // Ana covered only one ended lesson → not listed.
      expect(cards.map((c) => [c.teacherName, c.state])).toEqual([
        ["Tomas", "open"],
      ]);
      expect(cards[0]).toMatchObject({
        groups: ["B1 Evening"],
        substitute: false,
        rating: null,
        editableUntil: local("2027-01-03", "00:00"),
      });
      expect(data.unrated).toBe(1);
    });

    it("doesn't count an absence (Pavol has 2 lessons with Tomas)", async () => {
      const data = await loadStudentRatings(db, student("Pavol"), NOW, TZ);
      expect(data.current).toEqual([]);
      await expect(rate("Pavol", ids.tomas, 4)).rejects.toBeInstanceOf(
        AdminError,
      );
      expect(
        await loadRatingForm(
          db,
          student("Pavol"),
          ids.tomas,
          undefined,
          NOW,
          TZ,
        ),
      ).toBeNull();
    });

    it("counts a replacement lesson, but one isn't enough", async () => {
      const data = await loadStudentRatings(db, student("Rita"), NOW, TZ);
      expect(data.current).toEqual([]);
    });

    it("shows a teacher before half-term as opening later, and refuses a rating", async () => {
      // 25 Oct: L1–L3 haven't happened yet, so add the facts differently:
      // the window is checked even with enough lessons.
      const early = local("2026-10-25", "12:00");
      const data = await loadStudentRatings(db, student("Sara"), early, TZ);
      expect(data.current).toEqual([]);
      await expect(rate("Sara", ids.tomas, 5, early)).rejects.toBeInstanceOf(
        AdminError,
      );
    });

    it("creates, then updates a rating; audits without the comment", async () => {
      expect(
        await rate("Sara", ids.tomas, 4, NOW, "  Clear explanations  "),
      ).toEqual({ status: "saved", created: true });
      const later = local("2026-11-21", "09:00");
      expect(await rate("Sara", ids.tomas, 5, later, "")).toEqual({
        status: "saved",
        created: false,
      });
      const rows = await client.teacherRating.findMany({
        where: { schoolId, studentId: ids.sara },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ score: 5, comment: null });
      const audit = await client.auditLog.findMany({
        where: { schoolId, entityType: "TeacherRating" },
        orderBy: { createdAt: "asc" },
      });
      expect(audit.map((a) => a.action)).toEqual([
        "rating.created",
        "rating.updated",
      ]);
      expect(audit[1].data).toMatchObject({ score: 5, previousScore: 4 });
      expect(JSON.stringify(audit)).not.toContain("Clear explanations");

      const form = await loadRatingForm(
        db,
        student("Sara"),
        ids.tomas,
        undefined,
        later,
        TZ,
      );
      expect(form).toMatchObject({
        teacher: { name: "Tomas" },
        rating: { score: 5, comment: null },
        editable: true,
      });
      // The student DTO never carries ids or aggregates.
      expect(Object.keys(form!.rating!).sort()).toEqual([
        "comment",
        "createdAt",
        "score",
        "updatedAt",
      ]);
    });

    it("keeps a rating read-only once the window closed", async () => {
      const closed = local("2027-01-03", "00:00");
      expect(await rate("Sara", ids.tomas, 1, closed)).toEqual({
        status: "closed",
      });
      const data = await loadStudentRatings(db, student("Sara"), closed, TZ);
      expect(data.current).toEqual([]);
      expect(data.earlier[0].cards[0]).toMatchObject({
        state: "closed",
        rating: { score: 5 },
      });
    });

    it("doesn't accept another school's teacher or term", async () => {
      await expect(rate("Sara", ids.foreignTeacher, 5)).rejects.toBeInstanceOf(
        AdminError,
      );
      await expect(
        saveRating(
          db,
          student("Sara"),
          {
            teacherId: ids.tomas,
            termId: ids.foreignTerm,
            score: 5,
            comment: null,
          },
          NOW,
          TZ,
        ),
      ).rejects.toBeInstanceOf(AdminError);
    });

    it("the database enforces the score range and one rating per term", async () => {
      await expect(
        client.teacherRating.create({
          data: {
            schoolId,
            studentId: ids.pavol,
            teacherId: ids.tomas,
            termId: ids.term,
            score: 6,
          },
        }),
      ).rejects.toThrow();
      await expect(
        client.teacherRating.create({
          data: {
            schoolId,
            studentId: ids.sara,
            teacherId: ids.tomas,
            termId: ids.term,
            score: 3,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("admin: summary hides the average below 3, hide/unhide is audited", async () => {
      // Two more ratings written directly (the rules are tested above).
      await client.teacherRating.createMany({
        data: [
          {
            schoolId,
            studentId: ids.pavol,
            teacherId: ids.tomas,
            termId: ids.term,
            score: 3,
          },
          {
            schoolId,
            studentId: ids.rita,
            teacherId: ids.tomas,
            termId: ids.term,
            score: 1,
            comment: "Rude words",
          },
        ],
      });
      let overview = await loadRatingsOverview(db, undefined, NOW);
      expect(overview.term?.id).toBe(ids.term);
      const tomas = () => overview.rows.find((r) => r.teacherId === ids.tomas)!;
      expect(tomas().summary).toMatchObject({ count: 3, average: 3 });
      expect(overview.rows.map((r) => r.name)).toEqual(["Ana", "Eva", "Tomas"]);

      const detail = await loadTeacherRatings(
        db,
        ids.tomas,
        { shown: 20 },
        NOW,
      );
      const rude = detail!.visible.find((r) => r.comment === "Rude words")!;
      expect(rude.studentName).toBe("Rita");
      const sara = detail!.visible.find((r) => r.studentName === "Sara")!;
      expect(sara).toMatchObject({ groups: ["B1 Evening"], edited: true });

      expect(
        await setRatingHidden(
          db,
          { userId: user.Admin },
          { ratingId: rude.id, hidden: true },
          NOW,
        ),
      ).toBe(true);
      expect(
        await setRatingHidden(
          db,
          { userId: user.Admin },
          { ratingId: rude.id, hidden: true },
          NOW,
        ),
      ).toBe(false);
      overview = await loadRatingsOverview(db, ids.term, NOW);
      expect(tomas().summary).toMatchObject({
        count: 2,
        average: null,
        hidden: 1,
      });
      const hidden = await loadTeacherRatings(
        db,
        ids.tomas,
        { shown: 20 },
        NOW,
      );
      expect(hidden!.hidden).toEqual([
        expect.objectContaining({ id: rude.id, hiddenByName: "Admin" }),
      ]);
      expect(hidden!.visible.map((r) => r.id)).not.toContain(rude.id);
      // Hiding doesn't count as the student editing it.
      const row = await client.teacherRating.findUniqueOrThrow({
        where: { id: rude.id },
      });
      expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime());

      expect(
        await setRatingHidden(
          db,
          { userId: user.Admin },
          { ratingId: rude.id, hidden: false },
          NOW,
        ),
      ).toBe(true);
      const actions = await client.auditLog.findMany({
        where: { schoolId, entityId: rude.id },
        orderBy: { createdAt: "asc" },
      });
      expect(actions.map((a) => a.action)).toEqual([
        "rating.hidden",
        "rating.unhidden",
      ]);
    });

    it("admin reads are scoped to the school", async () => {
      expect(
        await loadTeacherRatings(otherDb, ids.tomas, { shown: 20 }, NOW),
      ).toBeNull();
      const overview = await loadRatingsOverview(otherDb, undefined, NOW);
      expect(overview.rows.map((r) => r.name)).toEqual(["Olga"]);
      expect(overview.rows[0].summary.count).toBe(0);
      const rating = await client.teacherRating.findFirstOrThrow({
        where: { schoolId },
      });
      await expect(
        setRatingHidden(
          otherDb,
          { userId: user.Admin },
          { ratingId: rating.id, hidden: true },
          NOW,
        ),
      ).rejects.toBeInstanceOf(AdminError);
    });
  });

  describe("calendar feeds", () => {
    const tokenOf = (feedUrl: string) =>
      feedUrl.slice(`${ORIGIN}/api/calendar/`.length, -".ics".length);
    const owner = (name: string, role: "TEACHER" | "STUDENT") => ({
      userId: user[name],
      role,
    });

    it("creates a link on request only, idempotently", async () => {
      expect(await loadMyFeed(db, owner("Sara", "STUDENT"), ORIGIN)).toEqual({
        link: null,
        revokedByAdmin: false,
      });
      await createMyFeed(db, owner("Sara", "STUDENT"), NOW);
      await createMyFeed(db, owner("Sara", "STUDENT"), NOW);
      expect(
        await client.calendarFeed.count({ where: { userId: user.Sara } }),
      ).toBe(1);
      const feed = await loadMyFeed(db, owner("Sara", "STUDENT"), ORIGIN);
      expect(feed.link?.url).toMatch(
        /^https:\/\/school\.example\/api\/calendar\/[A-Za-z0-9_-]{43}\.ics$/,
      );
      // Shown again identically (recomputed from the salt).
      expect(
        (await loadMyFeed(db, owner("Sara", "STUDENT"), ORIGIN)).link?.url,
      ).toBe(feed.link?.url);
      const audit = await client.auditLog.findMany({
        where: { schoolId, entityType: "CalendarFeed" },
      });
      expect(audit.map((a) => a.action)).toEqual(["calendar_feed.created"]);
      expect(JSON.stringify(audit)).not.toContain(tokenOf(feed.link!.url));
    });

    it("a student's feed: own lessons, replacements, cancelled, absent", async () => {
      const { link } = await loadMyFeed(db, owner("Sara", "STUDENT"), ORIGIN);
      const loaded = await loadFeedByToken(client, tokenOf(link!.url), NOW);
      expect(loaded?.role).toBe("STUDENT");
      expect(loaded?.school.name).toBe(`Rate ${suffix}`);
      const byId = new Map(loaded!.lessons.map((l) => [l.id, l]));
      expect([...byId.keys()].sort()).toEqual(
        [
          lessons.l1,
          lessons.l2,
          lessons.l3,
          lessons.l4,
          lessons.l5,
          lessons.l6,
          lessons.l7,
        ].sort(),
      );
      expect(byId.get(lessons.l4)).toMatchObject({
        notAttending: true,
        viewerIs: "student",
      });
      expect(byId.get(lessons.l5)).toMatchObject({
        cancelled: true,
        cancelReason: "HOLIDAY",
      });
      expect(byId.get(lessons.l6)).toMatchObject({
        substituteName: "Ana",
        teacherName: "Tomas",
      });
      expect(byId.get(lessons.l1)).toMatchObject({
        room: "Online 1",
        level: "B1",
      });
      // No meeting link, no absence reason, no classmates anywhere.
      const json = JSON.stringify(loaded);
      for (const secret of [
        "meet.example",
        "Private reason",
        "Pavol",
        "Rita",
      ]) {
        expect(json).not.toContain(secret);
      }

      await createMyFeed(db, owner("Rita", "STUDENT"), NOW);
      const rita = await loadMyFeed(db, owner("Rita", "STUDENT"), ORIGIN);
      const ritaFeed = await loadFeedByToken(
        client,
        tokenOf(rita.link!.url),
        NOW,
      );
      expect(ritaFeed!.lessons.map((l) => l.id).sort()).toEqual(
        [lessons.g2a, lessons.l3].sort(),
      );
      expect(
        ritaFeed!.lessons.find((l) => l.id === lessons.g2a)?.notAttending,
      ).toBe(true);
    });

    it("a teacher's feed: own, substituting and covered lessons", async () => {
      await createMyFeed(db, owner("Ana", "TEACHER"), NOW);
      await createMyFeed(db, owner("Tomas", "TEACHER"), NOW);
      const ana = await loadMyFeed(db, owner("Ana", "TEACHER"), ORIGIN);
      const anaFeed = await loadFeedByToken(
        client,
        tokenOf(ana.link!.url),
        NOW,
      );
      expect(anaFeed!.lessons.map((l) => [l.id, l.viewerIs])).toEqual([
        [lessons.l6, "substitute"],
        [lessons.l7, "substitute"],
      ]);
      const tomas = await loadMyFeed(db, owner("Tomas", "TEACHER"), ORIGIN);
      const tomasFeed = await loadFeedByToken(
        client,
        tokenOf(tomas.link!.url),
        NOW,
      );
      expect(tomasFeed!.lessons.find((l) => l.id === lessons.l6)).toMatchObject(
        {
          viewerIs: "regular",
          substituteName: "Ana",
        },
      );
      expect(tomasFeed!.lessons.map((l) => l.id)).not.toContain(lessons.g2a);
    });

    it("reset invalidates the old token at once", async () => {
      const before = await loadMyFeed(db, owner("Sara", "STUDENT"), ORIGIN);
      await resetMyFeed(db, owner("Sara", "STUDENT"), NOW);
      const after = await loadMyFeed(db, owner("Sara", "STUDENT"), ORIGIN);
      expect(after.link?.url).not.toBe(before.link?.url);
      expect(
        await loadFeedByToken(client, tokenOf(before.link!.url), NOW),
      ).toBeNull();
      expect(
        await loadFeedByToken(client, tokenOf(after.link!.url), NOW),
      ).not.toBeNull();
      expect(
        await client.calendarFeed.count({
          where: { userId: user.Sara, revokedAt: null },
        }),
      ).toBe(1);
    });

    it("the database allows one active link per user", async () => {
      await expect(
        client.calendarFeed.create({
          data: {
            schoolId,
            userId: user.Sara,
            salt: new Uint8Array(32),
            tokenHash: `x-${suffix}`,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });

    it("updates lastUsedAt at most once an hour", async () => {
      const { link } = await loadMyFeed(db, owner("Ana", "TEACHER"), ORIGIN);
      const token = tokenOf(link!.url);
      const lastUsed = async () =>
        (
          await client.calendarFeed.findFirstOrThrow({
            where: { userId: user.Ana, revokedAt: null },
          })
        ).lastUsedAt;
      const t0 = local("2026-11-20", "13:00");
      await loadFeedByToken(client, token, t0);
      expect(await lastUsed()).toEqual(t0);
      await loadFeedByToken(
        client,
        token,
        new Date(t0.getTime() + 30 * 60_000),
      );
      expect(await lastUsed()).toEqual(t0);
      const t1 = new Date(t0.getTime() + 61 * 60_000);
      await loadFeedByToken(client, token, t1);
      expect(await lastUsed()).toEqual(t1);
    });

    it("admin revoke: no new link, the user is notified", async () => {
      expect(await hasActiveFeed(db, user.Tomas)).toBe(true);
      const { link } = await loadMyFeed(db, owner("Tomas", "TEACHER"), ORIGIN);
      expect(
        await revokeFeedAsAdmin(db, { userId: user.Admin }, user.Tomas, NOW),
      ).toBe(true);
      expect(
        await revokeFeedAsAdmin(db, { userId: user.Admin }, user.Tomas, NOW),
      ).toBe(false);
      expect(await hasActiveFeed(db, user.Tomas)).toBe(false);
      expect(await loadFeedByToken(client, tokenOf(link!.url), NOW)).toBeNull();
      expect(await loadMyFeed(db, owner("Tomas", "TEACHER"), ORIGIN)).toEqual({
        link: null,
        revokedByAdmin: true,
      });
      const notes = await client.notification.findMany({
        where: { schoolId, recipientId: user.Tomas },
      });
      expect(notes).toEqual([
        expect.objectContaining({
          type: "CALENDAR_FEED_REVOKED",
          link: { kind: "calendarFeed" },
        }),
      ]);
      // Another school's admin can't reach this user's link.
      await createMyFeed(db, owner("Tomas", "TEACHER"), NOW);
      await expect(
        revokeFeedAsAdmin(otherDb, { userId: user.Admin }, user.Tomas, NOW),
      ).rejects.toBeInstanceOf(AdminError);
      expect(await hasActiveFeed(db, user.Tomas)).toBe(true);
    });

    it("never returns another school's lessons, and 404s a forged school", async () => {
      await createMyFeed(otherDb, owner("Olga", "TEACHER"), NOW);
      const olga = await loadMyFeed(otherDb, owner("Olga", "TEACHER"), ORIGIN);
      const olgaFeed = await loadFeedByToken(
        client,
        tokenOf(olga.link!.url),
        NOW,
      );
      expect(olgaFeed!.lessons.map((l) => l.id)).toEqual([lessons.foreign]);
      // A feed row pointing at a school the user isn't a member of.
      const forged = await client.calendarFeed.findFirstOrThrow({
        where: { userId: user.Olga, revokedAt: null },
      });
      await client.calendarFeed.update({
        where: { id: forged.id },
        data: { schoolId },
      });
      expect(
        await loadFeedByToken(client, tokenOf(olga.link!.url), NOW),
      ).toBeNull();
    });

    it("404s a deleted user, an admin and an unknown token", async () => {
      const { link } = await loadMyFeed(db, owner("Rita", "STUDENT"), ORIGIN);
      await client.user.update({
        where: { id: user.Rita },
        data: { deletedAt: NOW },
      });
      expect(await loadFeedByToken(client, tokenOf(link!.url), NOW)).toBeNull();
      await expect(
        createMyFeed(db, { userId: user.Admin, role: "ADMIN" }, NOW),
      ).rejects.toBeInstanceOf(AdminError);
      expect(await loadFeedByToken(client, "A".repeat(43), NOW)).toBeNull();
    });
  });
});
