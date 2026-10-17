import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test file gets its own throwaway database file and encryption key; nothing touches .data/ or .env.
process.env.DATABASE_PATH = join(tmpdir(), `payrollhub-test-${randomUUID()}.db`);
// Rate-limiter tests need a real Redis (docker compose up -d). TEST_REDIS_URL overrides the development default; each
// test file gets its own key prefix so files never share counters.
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://:dev-only-redis-password-change-me@127.0.0.1:6379";
process.env.RATE_LIMIT_PREFIX = `test:${randomUUID()}`;
process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.MOCK_IDP_DIR = join(tmpdir(), `payrollhub-test-idp-${randomUUID()}`);
process.env.MOCK_MAIL_DIR = join(tmpdir(), `payrollhub-test-mail-${randomUUID()}`);
process.env.DEV_CREDENTIALS_FILE = join(tmpdir(), `payrollhub-test-dev-credentials-${randomUUID()}.txt`);
process.env.PKI_DIR = join(tmpdir(), `payrollhub-test-pki-${randomUUID()}`);
process.env.MOCK_BANK_DIR = join(tmpdir(), `payrollhub-test-bank-${randomUUID()}`);
process.env.LOG_DIR = join(tmpdir(), `payrollhub-test-logs-${randomUUID()}`);
process.env.KEYSTORE_DIR = join(tmpdir(), `payrollhub-test-keys-${randomUUID()}`);
// The stand-in bank: each test file that needs one starts it on its own port (see tests/helpers/ach.ts). A short
// timeout keeps the "response lost to a timeout" test fast.
process.env.BANK_URL = `https://localhost:${20_000 + Math.floor(Math.random() * 30_000)}`;
process.env.BANK_TIMEOUT_MS = "1500";
