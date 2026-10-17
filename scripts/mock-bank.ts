import { env } from "@/config/env";
import { startMockBank } from "@/partners/mock-bank/server";

// Runs the stand-in originating bank (D12): npm run bank. Listens on the port in BANK_URL, over mTLS with the
// certificates npm run setup created. It prints nothing about the batches it receives.
const url = new URL(env().BANK_URL);
startMockBank({ pkiDir: env().PKI_DIR, bankDir: env().MOCK_BANK_DIR, host: "127.0.0.1", port: Number(url.port || 443) })
  .then(() => console.log(`Stand-in bank listening on ${env().BANK_URL} (mTLS; accepts signed ACH batches only).`))
  .catch((err: Error) => {
    console.error(`Stand-in bank could not start: ${err.message}. Run npm run setup (certificates) and npm run db:reset.`);
    process.exit(1);
  });
