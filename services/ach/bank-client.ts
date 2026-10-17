import "server-only";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { env } from "@/config/env";
import { BankUnavailableError } from "@/services/errors";

// ACH Disbursement's single egress to the originating bank (Assignment 5, Section 2.5; L1-22; D12). mTLS: PayrollHub
// presents its client certificate from the local CA, verifies the bank's certificate chain and hostname, and then pins
// it: the certificate's SHA-256 fingerprint must equal the one recorded at setup (PKI_DIR/bank-pin.txt). A different
// certificate is refused even if the same CA signed it. The request carries the exact signed bytes and the signature.

export type BankAnswer =
  | { status: "accepted"; bankReference: string }
  | { status: "duplicate"; bankReference: string; sameFile: boolean }
  | { status: "rejected"; reason: string };

class PinMismatchError extends Error {}

function tlsMaterial() {
  const dir = env().PKI_DIR;
  const read = (file: string) => readFileSync(/*turbopackIgnore: true*/ join(dir, file), "utf8");
  return { ca: read("ca.pem"), cert: read("payrollhub-client.pem"), key: read("payrollhub-client-key.pem"), pin: read("bank-pin.txt").trim() };
}

export function sendBatch(input: { bytes: Buffer; signature: Buffer; keyVersion: number }): Promise<BankAnswer> {
  const url = new URL("/ach/batches", env().BANK_URL);
  const { ca, cert, key, pin } = tlsMaterial();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        ca,
        cert,
        key,
        minVersion: "TLSv1.2",
        agent: false,
        checkServerIdentity: (host: string, peer: PeerCertificate) => {
          const identity = checkServerIdentity(host, peer);
          if (identity) return identity;
          return peer.fingerprint256 === pin ? undefined : new PinMismatchError("bank certificate does not match the pinned certificate");
        },
        timeout: env().BANK_TIMEOUT_MS,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": input.bytes.length,
          "x-ach-signature": input.signature.toString("base64"),
          "x-ach-key-version": String(input.keyVersion),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let body: { status?: string; bankReference?: string; sameFile?: boolean; reason?: string } = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8").slice(0, 4096));
          } catch {
            // Not JSON: treated by status code below.
          }
          if (res.statusCode === 201 && body.bankReference) return resolve({ status: "accepted", bankReference: body.bankReference });
          if (res.statusCode === 409 && body.bankReference) return resolve({ status: "duplicate", bankReference: body.bankReference, sameFile: body.sameFile === true });
          if (res.statusCode && res.statusCode >= 400 && res.statusCode < 500) {
            return resolve({ status: "rejected", reason: typeof body.reason === "string" ? body.reason.slice(0, 100) : `http ${res.statusCode}` });
          }
          reject(new BankUnavailableError(`unexpected answer (http ${res.statusCode})`));
        });
      },
    );
    req.on("timeout", () => req.destroy(new BankUnavailableError("timeout")));
    req.on("error", (err) => {
      if (err instanceof BankUnavailableError) return reject(err);
      if (err instanceof PinMismatchError) return reject(new BankUnavailableError("bank certificate not pinned"));
      const code = (err as NodeJS.ErrnoException).code ?? "";
      reject(new BankUnavailableError(/CERT|SSL|TLS|ALERT|HANDSHAKE/i.test(`${code} ${err.message}`) ? `tls failed (${code || "handshake"})` : `unreachable (${code || "error"})`));
    });
    req.end(input.bytes);
  });
}
