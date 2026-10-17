// Bank details validation (Assignment 5, Section 3.3). Only well-formed numbers are ever stored.

/** ABA routing number: 9 digits, valid check digit (weights 3, 7, 1), not all zeros. */
export function isValidRoutingNumber(value: string): boolean {
  if (!/^\d{9}$/.test(value) || /^0{9}$/.test(value)) return false;
  const d = [...value].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}

/** US deposit account number as carried in a NACHA entry: 4 to 17 digits, not all zeros. */
export function isValidAccountNumber(value: string): boolean {
  return /^\d{4,17}$/.test(value) && !/^0+$/.test(value);
}

/** The only form of a bank number that may appear in a response, notice, or log. */
export const last4 = (value: string) => value.slice(-4);
