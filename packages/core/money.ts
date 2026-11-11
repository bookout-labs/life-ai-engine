export function cents(amount: string): bigint {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = amount.replace(/^-/, "").split(".");
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -value : value;
}
export function decimal(value: bigint): string {
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}
