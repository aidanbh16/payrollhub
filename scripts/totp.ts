import { currentTotp } from "./lib/dev-credentials";

// Prints a seeded staff account's current authenticator code, from the development credentials file:
//   npm run totp -- admin@acme.test
//   npm run -s totp -- admin@acme.test --code-only     (just the six digits, for scripts)
// Each code works once (the server refuses a reused step), so a second sign-in or an approval step-up needs the next
// code: wait for the countdown.
const [email, flag] = process.argv.slice(2);
if (!email) {
  console.error("Usage: npm run totp -- <staff email> [--code-only]   (staff accounts are listed in the development credentials file)");
  process.exit(1);
}
try {
  const { code, secondsLeft, organization } = currentTotp(email);
  console.log(flag === "--code-only" ? code : `${code}   (${email}, organization ${organization}; valid for ${secondsLeft} more seconds)`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
