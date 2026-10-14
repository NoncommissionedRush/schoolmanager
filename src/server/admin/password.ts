// No ambiguous characters (0 O 1 l I) — the admin reads it out (§5.4).
export const PASSWORD_ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Uniform random integer in [0, max) from Web Crypto (browser and Node). */
function randomBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return buffer[0] % max;
}

/**
 * A random 12-character password for the admin to hand over. Runs in the
 * browser (the Generate button), so it uses Web Crypto, not node:crypto.
 */
export function generatePassword(
  length = 12,
  random: (max: number) => number = randomBelow,
): string {
  let password = "";
  for (let i = 0; i < length; i++) {
    password += PASSWORD_ALPHABET[random(PASSWORD_ALPHABET.length)];
  }
  return password;
}
