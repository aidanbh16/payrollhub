// Gross-to-net (D16: a flat withholding rate per tenant). All money is integer cents; no floating point.
//
// Rounding rule: withholding = gross x rate / 10,000 (rate in basis points), rounded HALF UP to the whole cent,
// computed exactly in integers as floor((gross x rate + 5,000) / 10,000).
// Net = gross - withholding, and is always kept within [0, gross].
// Examples (22% = 2,200 bp): 312,500 -> 68,750.00 exactly; 341,667 -> 75,166.74 -> 75,167; 312,525 -> 68,755.50 -> 68,756.

export interface PayAmounts {
  grossCents: number;
  withholdingCents: number;
  netCents: number;
}

export function computePay(grossCents: number, withholdingRateBp: number): PayAmounts {
  if (!Number.isSafeInteger(grossCents) || grossCents <= 0) throw new Error("gross pay must be a positive whole number of cents");
  if (!Number.isInteger(withholdingRateBp) || withholdingRateBp < 0 || withholdingRateBp > 10_000) throw new Error("invalid withholding rate");
  const product = grossCents * withholdingRateBp;
  if (!Number.isSafeInteger(product + 5_000)) throw new Error("amount too large");
  const withholdingCents = Math.floor((product + 5_000) / 10_000);
  const netCents = Math.min(grossCents, Math.max(0, grossCents - withholdingCents));
  return { grossCents, withholdingCents: grossCents - netCents, netCents };
}
