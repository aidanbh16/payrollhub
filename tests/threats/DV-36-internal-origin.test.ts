import { describe, expect, it } from "vitest";
import { parseEnv } from "@/config/env";

// DV-36: the BFF sends single-use service tokens to INTERNAL_API_ORIGIN, so it must be this machine. config/env.ts
// refuses any non-loopback origin, and instrumentation.ts exits at startup when the configuration is invalid.

const base = { ...process.env };
const withOrigin = (origin: string) => () => parseEnv({ ...base, INTERNAL_API_ORIGIN: origin });

describe("[L1-19 DiD] DV-36: INTERNAL_API_ORIGIN must be a loopback address", () => {
  it("accepts loopback origins", () => {
    for (const origin of ["http://127.0.0.1:3000", "http://127.8.9.10:4000", "http://localhost:3000", "https://localhost", "http://[::1]:3000"]) {
      expect(withOrigin(origin)().INTERNAL_API_ORIGIN).toBe(origin);
    }
    expect(parseEnv({ ...base, INTERNAL_API_ORIGIN: undefined }).INTERNAL_API_ORIGIN).toBe("http://127.0.0.1:3000");
  });

  it("refuses any origin that leaves the machine, naming the variable but not the value", () => {
    for (const origin of [
      "http://evil.example",
      "https://payroll.example.com",
      "http://10.0.0.5:3000",
      "http://0.0.0.0:3000",
      "http://localhost.evil.example",
      "http://127.0.0.1.evil.example",
      "http://[::ffff:8.8.8.8]",
      "ftp://127.0.0.1",
    ]) {
      expect(withOrigin(origin), origin).toThrow(/INTERNAL_API_ORIGIN/);
      expect(withOrigin(origin), origin).not.toThrow(new RegExp(origin.replace(/[.*+?^${}()|[\]\/]/g, "\$&")));
    }
  });
});
