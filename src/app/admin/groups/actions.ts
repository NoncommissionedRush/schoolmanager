"use server";

import { revalidatePath } from "next/cache";

import { runAdminAction } from "@/server/admin/context";
import {
  addMembersSchema,
  addToGroupSchema,
  groupSchema,
  removeMemberSchema,
} from "@/server/admin/groups/schema";
import {
  addMembers,
  archiveGroup,
  createGroup,
  removeMember,
  restoreGroup,
  updateGroup,
} from "@/server/admin/groups/service";
import { type ActionResult, msg, ok } from "@/server/admin/result";
import {
  assertIds,
  assertOptionalId,
  schoolToday,
} from "@/server/admin/shared";
import { formDataToObject, parseInput } from "@/server/admin/validation";
import { fromIsoDate } from "@/server/scheduling";

/** Groups and memberships (§6.6, §6.10). Lists and details all refresh. */
const refresh = () => revalidatePath("/admin", "layout");

type Saved = { id: string; name: string };

export async function saveGroupAction(
  id: string | null,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<Saved>> {
  return runAdminAction(async (scope) => {
    assertOptionalId(id);
    const parsed = parseInput(groupSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const group = id
      ? await updateGroup(scope, id, parsed.data)
      : await createGroup(
          scope,
          parsed.data,
          schoolToday(scope.viewer.school.timezone),
        );
    refresh();
    return ok(
      group,
      id
        ? msg("common.toast.saved")
        : msg("common.toast.created", { name: group.name }),
    );
  });
}

export async function archiveGroupAction(id: string) {
  return runAdminAction(async (scope) => {
    assertIds(id);
    await archiveGroup(scope, id, schoolToday(scope.viewer.school.timezone));
    refresh();
    // The client shows the toast with Undo (§5.3).
    return ok(undefined);
  });
}

export async function restoreGroupAction(id: string) {
  return runAdminAction(async (scope) => {
    assertIds(id);
    const group = await restoreGroup(scope, id);
    refresh();
    return ok(undefined, msg("common.toast.restored", { name: group.name }));
  });
}

export async function addMembersAction(
  groupId: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ count: number }>> {
  return runAdminAction(async (scope) => {
    assertIds(groupId);
    const parsed = parseInput(addMembersSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const { group, count } = await addMembers(
      scope,
      groupId,
      parsed.data.studentIds,
      fromIsoDate(parsed.data.startDate),
    );
    refresh();
    return ok(
      { count },
      msg("groups.members.added", { count, group: group.name }),
    );
  });
}

/** "Add to group" for one student (students list and detail). */
export async function addToGroupAction(
  studentId: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ count: number }>> {
  return runAdminAction(async (scope) => {
    assertIds(studentId);
    const parsed = parseInput(addToGroupSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const { group, count } = await addMembers(
      scope,
      parsed.data.groupId,
      [studentId],
      fromIsoDate(parsed.data.startDate),
    );
    refresh();
    return ok(
      { count },
      msg("groups.members.added", { count, group: group.name }),
    );
  });
}

export async function removeMemberAction(
  membershipId: string,
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAdminAction(async (scope) => {
    assertIds(membershipId);
    const parsed = parseInput(removeMemberSchema, formDataToObject(formData));
    if (!parsed.ok) return { ok: false, fieldErrors: parsed.fieldErrors };
    const removed = await removeMember(
      scope,
      membershipId,
      fromIsoDate(parsed.data.date),
      schoolToday(scope.viewer.school.timezone),
    );
    refresh();
    return ok(
      undefined,
      msg("groups.members.removed", {
        name: removed.student,
        group: removed.group,
      }),
    );
  });
}
