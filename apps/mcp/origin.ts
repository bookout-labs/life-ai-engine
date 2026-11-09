export function publicOrigin(value: string | undefined): string {
  if (!value) throw new Error("PUBLIC_ORIGIN is required.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("PUBLIC_ORIGIN must be an HTTPS origin.");
  return url.origin;
}
