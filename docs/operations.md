# Operations: keys, logs, production build, reverse proxy

## Production build

```bash
npm run build
npm run start            # http://localhost:3000, listening on 127.0.0.1 only
```

On startup the server log prints `[info] startup.redis_connected {"ping":"PONG"}`. If it prints
`startup.redis_unreachable`, Redis is not running or `REDIS_URL` does not match `REDIS_PASSWORD` (see
`docs/platform-setup.md`). With an invalid configuration (for example the published Redis placeholder password, or a
non-loopback `INTERNAL_API_ORIGIN`), it logs `startup.invalid_configuration` and exits. `next start` may print its
"Ready" line just before that check exits it (RT-16, accepted); it never serves a request.

## Rotating a signing key (L2-18)

```bash
npm run keys:rotate -- approval-token     # or: service-token, ach-batch
```

**Approval and service tokens:**

- The script writes the next key version and moves every older version to `.data/keys/<name>/retired/`.
- From that moment, every token signed with an old version fails verification. A running server picks this up
  immediately; no restart is needed, because the key store re-reads the key folder on each use.
- Approvers whose tokens died can approve the same runs again at once. Tokens signed with a retired key are ignored by
  the "a token for this run is still valid" check.
- Use it on a schedule, and immediately if a key may be compromised.
- Retired key files are kept for audit only; delete them when no longer needed.

**The ACH batch key (`ach-batch`, L1-22) rotates differently:** old versions are retired for *signing* only. Their
private keys are deleted, their public keys move to `.data/keys/ach-batch/verify-only/`, and they keep verifying. The
script also registers the new public key with the stand-in bank, which keeps trusting the old ones.

- **Why it differs:** an approval token is a short-lived bearer credential, so rotation is the compromise response
  and every outstanding token must die at once. A batch signature is evidence attached to a stored record: batches
  already signed and sent must stay verifiable (audit, disputes, resending the same signed bytes after a timeout),
  long after their key stops signing.
- **If an ACH key is compromised:** rotate it, and have the bank stop trusting the old version (with the stand-in
  bank, delete `.data/mock-bank/trusted-keys/ach-batch-v<N>.pem`). Batches signed with it then stop being accepted.

## Key material

Key material comes from one place: the key store, `data/keys/kms.ts` (the local stand-in for KMS, DV-07).

- **Signing keys** (service tokens, approval tokens, ACH batches) are versioned Ed25519 keys under
  `KEYSTORE_DIR/<name>/v<N>.pem`. Callers ask the store to sign or verify; no function returns a private key.
- **The field-encryption key** is also read only through the key store (`fieldEncryptionKey()`).
  - `npm run setup` writes 32 random bytes (base64) into `.env`, which is gitignored and never copied into the
    database.
  - Next.js loads `.env` at startup; scripts load it with `tsx --env-file=.env`.
  - `config/env.ts` checks that it decodes to exactly 32 bytes, and the key store reads it once into memory.
  - **Documented limitation:** the key sits in a file next to the app rather than in an HSM.
- Tests use a fresh random key and a temporary key store for each test file.

## Logs (L2-12, D14, D37)

Every log line goes through one logger (`data/log/logger.ts`), which redacts before anything is written, and is
appended as JSON to `.data/logs/payrollhub.log` (`LOG_DIR`); the console shows the same, redacted.

## Client IP and per-IP limits (D26)

Next.js 16 gives Proxy no client address that a client cannot forge. There is no `request.ip`, and Next.js copies the
socket address into `X-Forwarded-For` only when the client did not send that header itself, so any client can put any
value there. PayrollHub therefore never reads `X-Forwarded-For`.

Locally, rate limits are keyed per targeted account (sign-in steps), per tenant and per session (signed-in traffic;
D45), and per route class (anonymous traffic), not per IP. On localhost every request comes from one address anyway,
so per-IP limits would add nothing there. What that means on a single-IP local setup is spelled out in DV-27
(`docs/deviations.md`).

### Deploying behind a reverse proxy (adds per-IP limits)

Put nginx, Caddy, or a load balancer in front of the app. Have it **overwrite** (never append to) a header with the
real client address. Bind the app to localhost so the proxy is the only way in. Then set `TRUSTED_CLIENT_IP_HEADER`
to that header's name.

```nginx
# nginx: the app listens only on 127.0.0.1:3000; nginx terminates TLS and sets X-Real-IP itself.
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Real-IP $remote_addr;      # overwrites anything the client sent
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
}
```

```text
# Caddy equivalent
reverse_proxy 127.0.0.1:3000 {
    header_up X-Real-IP {remote_host}
}
```

Then start the app with `TRUSTED_CLIENT_IP_HEADER=x-real-ip` (and `npm run start`, which already listens on
`127.0.0.1`). `tests/threats/L1-05-trusted-ip.test.ts` covers this mode.

## Packaging the submission

`npm run submission -- <new folder>` (needs git) copies every file git would include (tracked files, plus new files
that `.gitignore` does not exclude) into the folder, then checks that no dependency, build output, `.git`, `.env`,
`.data/` content, database, log, key, certificate, or credentials file is in it. ZIP that folder. Before submitting,
extract the ZIP into a clean folder and follow the README from the start.

## Serving to other machines

`npm run dev`, `npm run start`, and the stand-in bank listen on `127.0.0.1` only (RT-02, D44). To serve the app to
other machines on purpose, pass another address: `npm run start -- -H 0.0.0.0` (or `npm run dev -- -H 0.0.0.0`; the
last `-H` wins). Do that only on a network you trust: the stand-ins (IdP, mailbox, bank) are demo partners, not
hardened services. The bank's address is fixed in `scripts/mock-bank.ts`.
