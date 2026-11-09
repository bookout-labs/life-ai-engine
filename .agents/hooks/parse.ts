import assert from "node:assert/strict";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected an object");
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  assert.equal(typeof value, "string", "Expected a string");
  return value as string;
}

export function nonempty(value: unknown): string {
  const text = string(value);
  assert.ok(text.length > 0, "Expected a nonempty string");
  return text;
}

export function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : string(value);
}

export function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected an array");
  return value;
}

export function boolean(value: unknown): boolean {
  assert.equal(typeof value, "boolean", "Expected a boolean");
  return value as boolean;
}

export function integer(value: unknown, minimum = 0): number {
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum, "Expected an integer");
  return value as number;
}
