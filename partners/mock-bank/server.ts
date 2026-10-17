import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";

// Stand-in originating bank (D12; Assignment 5, Sections 2.4 and 2.5). A separate system: it imports no PayrollHub
// code and keeps its own data under MOCK_BANK_DIR. It accepts ACH batch files only:
//   - over mTLS: the client must present a certificate from the local CA with CN "payrollhub-ach";
//   - signed: Ed25519 over the exact bytes received, checked against public keys PayrollHub registered with the bank
//     in advance (trusted-keys/, "pinned"), for the key version the request names; anything altered, or signed with
//     any other key, is rejected;
//   - once: the batch ID is read from inside the signed file, and a batch ID already accepted is refused (409);
//   - consistent: the control records must match the entries.
// It never logs or returns file contents.

export interface MockBankOptions {
  pkiDir: string;
  bankDir: string;
  host?: string;
  port?: number;
  /** TLS server certificate to present instead of PKI_DIR/bank.pem (tests: an unpinned certificate). */
  serverCert?: { cert: string; key: string };
}

export interface AcceptedBatch {
  batchId: string;
  sha256: string;
  keyVersion: number;
  bankReference: string;
  entryCount: number;
  totalCreditCents: number;
  receivedAt: string;
}

export interface MockBank {
  url: string;
  server: Server;
  close(): Promise<void>;
  /** Accept the batch but answer only after this many ms (tests: a response lost to a timeout). */
  setResponseDelay(ms: number): void;
  accepted(): AcceptedBatch[];
}

const KEY_NAME = "ach-batch";
const trustedDir = (bankDir: string) => join(bankDir, "trusted-keys");
const ledgerFile = (bankDir: string) => join(bankDir, "accepted.jsonl");

/** Registers (pins) one of PayrollHub's ACH signing public keys with the bank: the out-of-band key exchange. */
export function trustSigningKey(bankDir: string, version: number, publicKeyPem: string): void {
  mkdirSync(trustedDir(bankDir), { recursive: true });
  writeFileSync(join(trustedDir(bankDir), `${KEY_NAME}-v${version}.pem`), publicKeyPem);
}

/** Stops trusting a key version (the bank's half of responding to a compromised ACH key). */
export function distrustSigningKey(bankDir: string, version: number): void {
  rmSync(join(trustedDir(bankDir), `${KEY_NAME}-v${version}.pem`), { force: true });
}

function trustedKey(bankDir: string, version: number) {
  const file = join(trustedDir(bankDir), `${KEY_NAME}-v${version}.pem`);
  return existsSync(file) ? createPublicKey(readFileSync(file)) : undefined;
}

export function readLedger(bankDir: string): AcceptedBatch[] {
  if (!existsSync(ledgerFile(bankDir))) return [];
  return readFileSync(ledgerFile(bankDir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AcceptedBatch);
}

/** NACHA structure and control totals, recomputed from the entries. Returns the batch ID or a reason to reject. */
function checkFile(text: string): { batchId: string; entryCount: number; totalCreditCents: number } | { reason: string } {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0 || lines.length % 10 !== 0 || lines.some((l) => l.length !== 94 || !/^[ -~]+$/.test(l))) return { reason: "malformed file" };
  const of = (type: string) => lines.filter((l) => l[0] === type && !/^9{94}$/.test(l));
  const [header, batch, control, fileControl] = [of("1"), of("5"), of("8"), of("9")];
  const entries = of("6");
  if (header.length !== 1 || batch.length !== 1 || control.length !== 1 || fileControl.length !== 1 || entries.length === 0) return { reason: "malformed file" };
  const total = entries.reduce((sum, e) => sum + Number(e.slice(29, 39)), 0);
  const hash = entries.reduce((sum, e) => sum + Number(e.slice(3, 11)), 0) % 10_000_000_000;
  const c = control[0];
  const f = fileControl[0];
  const ok =
    Number(c.slice(4, 10)) === entries.length && Number(c.slice(10, 20)) === hash && Number(c.slice(32, 44)) === total && Number(c.slice(20, 32)) === 0 &&
    Number(f.slice(13, 21)) === entries.length && Number(f.slice(21, 31)) === hash && Number(f.slice(43, 55)) === total && Number(f.slice(7, 13)) === lines.length / 10;
  if (!ok) return { reason: "control totals do not match the entries" };
  const batchId = batch[0].slice(20, 40).trim();
  if (!/^[A-Z0-9]{20}$/.test(batchId)) return { reason: "missing batch id" };
  return { batchId, entryCount: entries.length, totalCreditCents: total };
}

export function startMockBank(options: MockBankOptions): Promise<MockBank> {
  const { pkiDir, bankDir } = options;
  mkdirSync(bankDir, { recursive: true });
  let delayMs = 0;
  const server = createServer(
    {
      cert: options.serverCert?.cert ?? readFileSync(join(pkiDir, "bank.pem")),
      key: options.serverCert?.key ?? readFileSync(join(pkiDir, "bank-key.pem")),
      ca: readFileSync(join(pkiDir, "ca.pem")),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    (req, res) => {
      const reply = (status: number, body: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      if (!(req.socket as TLSSocket).authorized || peer?.subject?.CN !== "payrollhub-ach") return reply(403, { status: "rejected", reason: "client certificate not accepted" });
      if (req.method !== "POST" || req.url !== "/ach/batches") return reply(404, { status: "rejected", reason: "not found" });

      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy();
        else chunks.push(chunk);
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const version = Number(req.headers["x-ach-key-version"]);
        const signature = Buffer.from(String(req.headers["x-ach-signature"] ?? ""), "base64");
        const key = Number.isInteger(version) ? trustedKey(bankDir, version) : undefined;
        if (!key) return reply(422, { status: "rejected", reason: "unknown signing key" });
        if (signature.length !== 64 || !verify(null, body, key, signature)) return reply(422, { status: "rejected", reason: "signature does not verify" });
        const checked = checkFile(body.toString("latin1"));
        if ("reason" in checked) return reply(422, { status: "rejected", reason: checked.reason });

        const sha256 = createHash("sha256").update(body).digest("hex");
        const existing = readLedger(bankDir).find((b) => b.batchId === checked.batchId);
        if (existing) return reply(409, { status: "duplicate", batchId: existing.batchId, bankReference: existing.bankReference, sameFile: existing.sha256 === sha256 });

        const accepted: AcceptedBatch = {
          batchId: checked.batchId,
          sha256,
          keyVersion: version,
          bankReference: `BANK-${randomUUID().slice(0, 8).toUpperCase()}`,
          entryCount: checked.entryCount,
          totalCreditCents: checked.totalCreditCents,
          receivedAt: new Date().toISOString(),
        };
        mkdirSync(bankDir, { recursive: true }); // db:reset may have cleared it while the bank was running
        appendFileSync(ledgerFile(bankDir), `${JSON.stringify(accepted)}\n`);
        setTimeout(() => reply(201, { status: "accepted", batchId: accepted.batchId, bankReference: accepted.bankReference }), delayMs);
      });
    },
  );
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `https://localhost:${port}`,
        server,
        close: () => new Promise((done) => server.close(() => done())),
        setResponseDelay: (ms) => void (delayMs = ms),
        accepted: () => readLedger(bankDir),
      });
    });
  });
}
