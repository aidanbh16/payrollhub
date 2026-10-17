// NACHA (ACH) file format for a PPD credit batch: one file, one batch, one entry per employee paid. Every record is
// exactly 94 characters. Built only from pay results and verified accounts, never from a request. The batch ID is
// written inside the file (batch header, company discretionary data), so it is covered by the signature and the
// bank can refuse a duplicate. readControls() parses a built file back, so totals are checked on the exact bytes.

export interface AchEntry {
  routingNumber: string;
  accountNumber: string;
  amountCents: number;
  individualId: string;
  individualName: string;
}

export interface AchFileInput {
  batchId: string;
  originatingBank: { routingNumber: string; name: string };
  company: { id: string; name: string };
  /** The pay date, YYYY-MM-DD. */
  effectiveDate: string;
  createdAt: Date;
  entries: AchEntry[];
}

export class AchFormatError extends Error {}

const RECORD = 94;
const BLOCKING = 10;

/** Upper-case letters, digits, and spaces only, so no field can carry a newline or shift other fields. */
function alpha(value: string, width: number): string {
  const clean = value
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, width).padEnd(width, " ");
}

function num(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new AchFormatError("ACH numeric fields must be non-negative integers");
  const text = String(value);
  if (text.length > width) throw new AchFormatError("ACH numeric field overflow");
  return text.padStart(width, "0");
}

function digits(value: string, width: number, exact = false): string {
  if (!/^\d+$/.test(value) || value.length > width || (exact && value.length !== width)) throw new AchFormatError("ACH digit field is malformed");
  return value;
}

const yymmdd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

function record(parts: string[]): string {
  const line = parts.join("");
  if (line.length !== RECORD) throw new AchFormatError(`ACH record has ${line.length} characters, not ${RECORD}`);
  return line;
}

const entryHash = (entries: AchEntry[]) => entries.reduce((sum, e) => sum + Number(e.routingNumber.slice(0, 8)), 0) % 10_000_000_000;

export function buildAchFile(input: AchFileInput): string {
  const odfi = digits(input.originatingBank.routingNumber, 9, true);
  const companyId = alpha(input.company.id, 10);
  const created = input.createdAt.toISOString();
  const total = input.entries.reduce((sum, e) => sum + e.amountCents, 0);
  const hash = entryHash(input.entries);

  const lines = [
    record(["1", "01", " " + odfi, companyId, yymmdd(created), created.slice(11, 13) + created.slice(14, 16), "A", "094", "10", "1",
      alpha(input.originatingBank.name, 23), alpha(input.company.name, 23), alpha("", 8)]),
    record(["5", "220", alpha(input.company.name, 16), alpha(input.batchId, 20), companyId, "PPD", alpha("PAYROLL", 10), alpha("", 6),
      yymmdd(input.effectiveDate), "   ", "1", odfi.slice(0, 8), num(1, 7)]),
    ...input.entries.map((e, i) =>
      record(["6", "22", digits(e.routingNumber, 9, true).slice(0, 8), e.routingNumber[8], digits(e.accountNumber, 17).padEnd(17, " "),
        num(e.amountCents, 10), alpha(e.individualId, 15), alpha(e.individualName, 22), "  ", "0", odfi.slice(0, 8) + num(i + 1, 7)]),
    ),
    record(["8", "220", num(input.entries.length, 6), num(hash, 10), num(0, 12), num(total, 12), companyId, " ".repeat(19), " ".repeat(6),
      odfi.slice(0, 8), num(1, 7)]),
  ];
  const blocks = Math.ceil((lines.length + 1) / BLOCKING);
  lines.push(record(["9", num(1, 6), num(blocks, 6), num(input.entries.length, 8), num(hash, 10), num(0, 12), num(total, 12), " ".repeat(39)]));
  while (lines.length % BLOCKING !== 0) lines.push("9".repeat(RECORD));
  return `${lines.join("\n")}\n`;
}

export interface AchControls {
  batchId: string;
  entryCount: number;
  entrySumCents: number;
  entryHash: number;
  batchControl: { entryCount: number; entryHash: number; totalDebitCents: number; totalCreditCents: number };
  fileControl: { batchCount: number; blockCount: number; entryCount: number; entryHash: number; totalDebitCents: number; totalCreditCents: number };
  recordCount: number;
}

/** Parses a built file's entries and control records. Throws AchFormatError on any structural problem. */
export function readControls(file: string): AchControls {
  const lines = file.endsWith("\n") ? file.slice(0, -1).split("\n") : file.split("\n");
  if (lines.some((l) => l.length !== RECORD)) throw new AchFormatError("ACH file has a record of the wrong length");
  const records = lines.filter((l) => !/^9{94}$/.test(l));
  const of = (type: string) => records.filter((l) => l[0] === type);
  const [batches, controls, fileControls, entries] = [of("5"), of("8"), of("9"), of("6")];
  if (of("1").length !== 1 || batches.length !== 1 || controls.length !== 1 || fileControls.length !== 1) throw new AchFormatError("ACH file structure is wrong");
  const n = (line: string, from: number, to: number) => Number(line.slice(from, to));
  const [c, f] = [controls[0], fileControls[0]];
  return {
    batchId: batches[0].slice(20, 40).trim(),
    entryCount: entries.length,
    entrySumCents: entries.reduce((sum, e) => sum + n(e, 29, 39), 0),
    entryHash: entries.reduce((sum, e) => sum + n(e, 3, 11), 0) % 10_000_000_000,
    batchControl: { entryCount: n(c, 4, 10), entryHash: n(c, 10, 20), totalDebitCents: n(c, 20, 32), totalCreditCents: n(c, 32, 44) },
    fileControl: { batchCount: n(f, 1, 7), blockCount: n(f, 7, 13), entryCount: n(f, 13, 21), entryHash: n(f, 21, 31), totalDebitCents: n(f, 31, 43), totalCreditCents: n(f, 43, 55) },
    recordCount: lines.length,
  };
}

/**
 * Checks a built file against what the pay results say it must contain: entry count and total credit, and every
 * control record agreeing with the entries themselves. Run on the exact text that will be signed.
 */
export function checkControlTotals(file: string, expected: { batchId: string; entryCount: number; totalCreditCents: number }): void {
  const c = readControls(file);
  const ok =
    c.batchId === expected.batchId &&
    c.entryCount === expected.entryCount &&
    c.entrySumCents === expected.totalCreditCents &&
    c.batchControl.entryCount === c.entryCount && c.batchControl.entryHash === c.entryHash &&
    c.batchControl.totalCreditCents === c.entrySumCents && c.batchControl.totalDebitCents === 0 &&
    c.fileControl.batchCount === 1 && c.fileControl.blockCount === c.recordCount / BLOCKING &&
    c.fileControl.entryCount === c.entryCount && c.fileControl.entryHash === c.entryHash &&
    c.fileControl.totalCreditCents === c.entrySumCents && c.fileControl.totalDebitCents === 0;
  if (!ok) throw new AchFormatError("ACH control totals do not match the pay results");
}
