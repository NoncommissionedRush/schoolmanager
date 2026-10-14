"use server";

import { signOut } from "@/auth";
import { LOGIN_PATH } from "@/server/auth/roles";

export async function signOutAction() {
  await signOut({ redirectTo: LOGIN_PATH });
}
