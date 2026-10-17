import { z } from "zod";
import { uuidParam } from "./common";

// Bank-account change inputs. Strict: unknown fields are rejected. Number formats are checked by the Bank Account
// service (ABA checksum, 4-17 digit account), so invalid numbers get a plain message rather than a schema error.
const digits = z.string().trim().max(32);

export const bankDetailsBody = z.strictObject({
  routingNumber: digits,
  accountNumber: digits,
});

export const changeParams = z.strictObject({ changeId: uuidParam });
export const employeeParams = z.strictObject({ employeeId: uuidParam });

/** The confirmation link's token, posted back from the link page. */
export const linkTokenForm = z.strictObject({ token: z.string().max(128) });

export const mailboxForm = z.strictObject({
  address: z.string().trim().toLowerCase().max(254),
  password: z.string().max(256),
});
