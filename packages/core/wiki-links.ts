import { basename, join } from "node:path";

export const slugFor = (path: string): string => path.replace(/^wiki\//, "").replace(/\.md$/, "");

export function resolveLink(target: string, from: string, slugs: Set<string>): string | undefined {
  const clean = target.split("|")[0]?.split("#")[0]?.replace(/\.md$/, "") ?? "";
  if (!clean) return from;
  const direct = slugFor(clean);
  if (slugs.has(direct)) return direct;
  const local = slugFor(join(from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "", clean));
  if (slugs.has(local)) return local;
  const candidates = [...slugs].filter((s) => basename(s) === clean);
  return candidates.length === 1 ? candidates[0] : undefined;
}
