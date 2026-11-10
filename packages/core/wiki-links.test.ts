import assert from "node:assert/strict";
import test from "node:test";
import { resolveLink, slugFor } from "./wiki-links.ts";

const slugs = new Set([
  "projects/nested/source",
  "projects/nested/local",
  "projects/sibling",
  "areas/unique",
  "areas/shared",
  "people/shared",
  "projects/nested/shared",
]);

const cases: { name: string; target: string; from?: string; expected: string | undefined }[] = [
  { name: "direct slug", target: "areas/unique", expected: "areas/unique" },
  { name: "alias", target: "areas/unique|label", expected: "areas/unique" },
  { name: "heading fragment", target: "areas/unique#section", expected: "areas/unique" },
  { name: "fragment and alias", target: "areas/unique#section|label", expected: "areas/unique" },
  { name: "markdown suffix", target: "areas/unique.md", expected: "areas/unique" },
  { name: "wiki prefix", target: "wiki/areas/unique.md#section|label", expected: "areas/unique" },
  { name: "sibling in nested folder", target: "local", expected: "projects/nested/local" },
  { name: "explicit relative path", target: "./local.md", expected: "projects/nested/local" },
  { name: "parent relative path", target: "../sibling.md#section|label", expected: "projects/sibling" },
  { name: "root page relative path", target: "./areas/unique.md", from: "root", expected: "areas/unique" },
  { name: "unique basename", target: "unique", expected: "areas/unique" },
  { name: "ambiguous basename", target: "shared", from: "projects/sibling", expected: undefined },
  { name: "local before ambiguous basename", target: "shared", expected: "projects/nested/shared" },
  { name: "missing target", target: "missing", expected: undefined },
  { name: "missing alias", target: "missing|label", expected: undefined },
  { name: "missing fragment", target: "missing#section", expected: undefined },
  { name: "missing relative path", target: "../missing.md", expected: undefined },
  { name: "nested path is not a basename", target: "nested/local", from: "root", expected: undefined },
  { name: "empty target", target: "", expected: "projects/nested/source" },
  { name: "self fragment", target: "#section", expected: "projects/nested/source" },
  { name: "empty target with alias", target: "|label", expected: "projects/nested/source" },
  { name: "whitespace is preserved", target: " unique ", expected: undefined },
];

for (const { name, target, from = "projects/nested/source", expected } of cases) {
  test(`resolves ${name}`, () => {
    assert.equal(resolveLink(target, from, slugs), expected);
  });
}

test("direct root slugs take precedence over same-folder links", () => {
  const candidates = new Set(["target", "projects/target"]);
  assert.equal(resolveLink("target", "projects/source", candidates), "target");
});

test("slug normalization removes only the wiki prefix and markdown suffix", () => {
  for (const { path, expected } of [
    { path: "wiki/areas/unique.md", expected: "areas/unique" },
    { path: "areas/unique.md", expected: "areas/unique" },
    { path: "wiki/wiki/unique.md", expected: "wiki/unique" },
    { path: "areas/unique.MD", expected: "areas/unique.MD" },
  ]) {
    assert.equal(slugFor(path), expected);
  }
});
