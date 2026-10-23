import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Checks `Authorization: Bearer <secret>` against an expected secret in
 * constant time. Both sides are hashed first so their lengths always match
 * (timingSafeEqual requires that) and the secret's length doesn't leak.
 * An unset expected secret always fails closed.
 */
export function hasValidBearerToken(
  request: Request,
  expected: string | undefined,
): boolean {
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided) return false;

  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
