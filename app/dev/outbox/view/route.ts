import { NextResponse } from "next/server";
import { route } from "@/application/http/route";
import { mailboxForm } from "@/application/validation/bank";
import { openMailbox } from "@/partners/mock-mail/mail";

// Opens one mailbox of the stand-in email provider (D13), with that mailbox's own password. Not browsable: no list of
// mailboxes, no mailbox without its password, and no PayrollHub session (an HR Admin's included) opens anyone's mail.
// Listed in edge/login-routes.ts, so Proxy throttles password guessing per mailbox. Pages are no-store, no-referrer.
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const page = (status: number, inner: string) =>
  new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mailbox</title></head>` +
      `<body>${inner}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );

const linkify = (text: string) => escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}">${url}</a>`);

export const POST = route.public({
  body: { type: "form", schema: mailboxForm },
  handler: async ({ body }) => {
    const messages = await openMailbox(body.address, body.password);
    if (!messages) return page(401, `<p>Mailbox not found or wrong password.</p><p><a href="/dev/outbox">Try again</a></p>`);
    const items = messages
      .map((m) => `<article><hr><h3>${escapeHtml(m.subject)}</h3><p>${escapeHtml(m.sentAt)}</p><pre>${linkify(m.body)}</pre></article>`)
      .join("");
    return page(200, `<h1>Mailbox: ${escapeHtml(body.address)}</h1>${items || "<p>No messages.</p>"}`);
  },
});
