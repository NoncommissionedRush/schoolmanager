import bcrypt from "bcryptjs";

/** bcrypt work factor; ~100–250 ms per hash on current hardware. */
const COST = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}
