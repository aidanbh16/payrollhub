import "server-only";
import { accountHash } from "@/edge/known-devices";
import { consumeUnlockToken, grantUnlockedDevice, storeUnlockToken, UNLOCK_TTL_MS } from "@/edge/unlock";
import { env } from "@/config/env";
import { log } from "@/data/log/logger";
import { withTenant } from "@/data/db/tenant-scope";
import { deliver } from "@/partners/mock-mail/mail";
import { InvalidInputError } from "@/services/errors";
import { findUserByEmail } from "./repository";
import { isPrivilegedRole, randomToken } from "./sessions";

// Self-service unlock links for staff sign-in (RT-04, D46). See edge/unlock.ts for what a link grants.
//   - Anyone may ask; the answer is the same whether or not the account exists, and the same work is done (a token is
//     generated and its hash stored either way). Proxy limits requests per targeted account (edge/login-routes.ts).
//   - The link goes only to the staff member's own mailbox (their account email), sent after the response is decided,
//     so delivery time does not reveal anything either.
//   - The link carries the token in the URL fragment (#...), which browsers never send to a server or in a Referer.
//   - Opening it grants a fresh sign-in budget to the browser that opens it, nothing more.

const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const UNLOCK_LINK_INVALID = "This unlock link is invalid or has expired";

/** Asks for an unlock link for a staff account. Never says whether the account exists. */
export async function requestUnlock(input: { organization: string; email: string }, now = new Date()): Promise<void> {
  const token = randomToken();
  const staff = TENANT_ID.test(input.organization) ? withTenant(input.organization, (s) => findUserByEmail(s, input.email)) : undefined;
  const target = staff && staff.status === "active" && isPrivilegedRole(staff.role) ? staff.email : null;
  await storeUnlockToken(accountHash(input.organization, input.email), token);
  if (!target) return;
  const link = new URL("/login/unlock", env().APP_ORIGIN);
  link.hash = token;
  const expires = new Date(now.getTime() + UNLOCK_TTL_MS).toISOString().replace("T", " ").slice(0, 16);
  setImmediate(() => {
    try {
      deliver({
        to: target,
        subject: "Unlock sign-in to PayrollHub",
        body: [
          "Someone asked to unlock sign-in to your PayrollHub staff account. If it was you, open this link in the browser",
          `you want to sign in with (it works once, until ${expires} UTC):`,
          link.toString(),
          "",
          "It only lets that browser try signing in again: you still need your password and your authenticator code.",
          "If you did not ask for it, ignore this message; nothing changes until the link is opened.",
        ].join("\n"),
      });
    } catch (err) {
      log.error("auth.unlock_mail_failed", { message: (err as Error).message });
    }
  });
}

/** Uses an unlock link: gives `deviceCookie` (the browser opening it) a fresh sign-in budget for that account. */
export async function confirmUnlock(token: string, deviceCookie: string): Promise<void> {
  const account = await consumeUnlockToken(token);
  if (!account) throw new InvalidInputError(UNLOCK_LINK_INVALID);
  await grantUnlockedDevice(account, deviceCookie);
}
