// Environment for the browser end-to-end tests (npm run test:e2e). The app, the stand-in bank, and every stand-in's
// data run from their own folder and ports, so an e2e run never touches the development database, mailboxes, or
// rate-limit counters. Certificates (PKI_DIR) are shared with development. Redis must be running.

process.env.E2E_RUN_ID ??= String(Date.now());
const DIR = ".data/e2e";

export const E2E_PORT = 3100;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const E2E_BANK_PORT = 8444;

export const E2E_ENV: Record<string, string> = {
  DATABASE_PATH: `${DIR}/payrollhub.db`,
  MOCK_IDP_DIR: `${DIR}/mock-idp`,
  MOCK_MAIL_DIR: `${DIR}/mock-mail`,
  DEV_CREDENTIALS_FILE: `${DIR}/dev-credentials.txt`,
  KEYSTORE_DIR: `${DIR}/keys`,
  MOCK_BANK_DIR: `${DIR}/mock-bank`,
  LOG_DIR: `${DIR}/logs`,
  RATE_LIMIT_PREFIX: `e2e:${process.env.E2E_RUN_ID}`,
  INTERNAL_API_ORIGIN: `http://127.0.0.1:${E2E_PORT}`,
  APP_ORIGIN: E2E_ORIGIN,
  BANK_URL: `https://localhost:${E2E_BANK_PORT}`,
};

/** The full environment for a child process: the developer's environment plus the e2e overrides. */
export const childEnv = (): Record<string, string> => ({
  ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
  ...E2E_ENV,
});
