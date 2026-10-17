import "server-only";
import { deliver } from "@/partners/mock-mail/mail";

// Notices to an employee's existing, previously verified contact address (Section 2.4), sent through the stand-in email
// provider (D13). Every bank-account change is announced to that address when requested, confirmed, rejected, or
// superseded, so a change made through a hijacked session never happens silently. Notices show only the last 4 digits.

const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function noticeRequested(to: string, args: { last4: string; requestedBy: "you" | "your HR administrator"; at: Date; link: string; expiresAt: Date }) {
  deliver({
    to,
    subject: "Confirm the change to your pay account",
    body: [
      `A change to the bank account your pay goes to was requested by ${args.requestedBy} on ${when(args.at)}.`,
      `New account ending in ${args.last4}.`,
      "",
      `If you made or expected this change, open this link while signed in to PayrollHub and confirm it (expires ${when(args.expiresAt)}):`,
      args.link,
      "",
      "If you did not, open the link and reject it, then contact HR. Until you confirm, your pay keeps going to your current account.",
    ].join("\n"),
  });
}

export function noticeResolved(to: string, args: { last4: string; outcome: "confirmed" | "rejected" | "superseded"; at: Date }) {
  const text = {
    confirmed: `The change to your pay account (new account ending in ${args.last4}) was confirmed on ${when(args.at)}. Future pay goes to that account.`,
    rejected: `The change to your pay account (account ending in ${args.last4}) was rejected on ${when(args.at)}. Your pay account is unchanged.`,
    superseded: `A pending change to your pay account (account ending in ${args.last4}) was replaced by a newer request on ${when(args.at)}. Its confirmation link no longer works.`,
  }[args.outcome];
  deliver({ to, subject: `Pay account change ${args.outcome}`, body: `${text}\n\nIf this was not you, contact HR immediately.` });
}
