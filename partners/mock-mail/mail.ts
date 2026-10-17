import "server-only";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@/config/env";

// Stand-in for each employee's email provider: the separate channel of D13 (Assignment 5, Sections 2.1 and 2.4).
// PayrollHub only *sends* here; it cannot read mailboxes. Reading a mailbox needs that mailbox's own password, which is
// separate from PayrollHub and from the stand-in IdP (development values are documented in the README), so an HR Admin,
// another employee, or anyone with a stolen PayrollHub session cannot read an employee's confirmation link.
// Like the stand-in IdP, it keeps its own data under MOCK_MAIL_DIR and imports no PayrollHub service code.

export interface MailMessage {
  id: string;
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

interface Mailboxes {
  [address: string]: { passwordHash: string };
}

const dir = () => env().MOCK_MAIL_DIR;
const normalize = (address: string) => address.trim().toLowerCase();
const mailboxFile = (address: string) => join(dir(), `${createHash("sha256").update(normalize(address)).digest("hex")}.json`);
const registryFile = () => join(dir(), "mailboxes.json");

function scryptHash(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashMailboxPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("base64")}$${(await scryptHash(password, salt)).toString("base64")}`;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Seeds mailboxes with their (development) passwords. */
export async function provisionMailboxes(entries: { address: string; password: string }[]): Promise<void> {
  mkdirSync(/*turbopackIgnore: true*/ dir(), { recursive: true });
  const registry: Mailboxes = {};
  for (const e of entries) registry[normalize(e.address)] = { passwordHash: await hashMailboxPassword(e.password) };
  writeFileSync(/*turbopackIgnore: true*/ registryFile(), JSON.stringify(registry, null, 2), { mode: 0o600 });
}

/** Delivers a message ("sends an email"). PayrollHub's only way into this system. */
export function deliver(message: { to: string; subject: string; body: string }): void {
  mkdirSync(/*turbopackIgnore: true*/ dir(), { recursive: true });
  const path = mailboxFile(message.to);
  const messages = readJson<MailMessage[]>(path, []);
  messages.push({ id: randomUUID(), to: normalize(message.to), subject: message.subject, body: message.body, sentAt: new Date().toISOString() });
  writeFileSync(/*turbopackIgnore: true*/ path, JSON.stringify(messages, null, 2), { mode: 0o600 });
}

let dummy: Promise<string> | undefined;

/** Opens a mailbox with its own password. Unknown mailboxes cost the same scrypt work as a wrong password. */
export async function openMailbox(address: string, password: string): Promise<MailMessage[] | null> {
  const entry = readJson<Mailboxes>(registryFile(), {})[normalize(address)];
  dummy ??= hashMailboxPassword(randomBytes(16).toString("base64"));
  const [salt, hash] = (entry?.passwordHash ?? (await dummy)).split("$");
  const actual = await scryptHash(password, Buffer.from(salt, "base64"));
  const expected = Buffer.from(hash, "base64");
  if (!entry || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return readJson<MailMessage[]>(mailboxFile(address), []).reverse();
}
