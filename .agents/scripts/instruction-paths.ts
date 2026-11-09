import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function instructionPaths(repo: string): string[] {
  const files = globSync(
    [
      "AGENTS.md",
      "CLAUDE.md",
      "docs/**/*.md",
      ".agents/rules.ts",
      ".agents/{rules,skills}/**/*.md",
      ".claude/{rules,skills}/**/*.md",
      ".codex/{rules,skills}/**/*.md",
    ],
    { cwd: repo },
  );
  return files.flatMap((file) => {
    const source = resolve(repo, file);
    return readFileSync(source, "utf8")
      .split(/\r?\n/)
      .flatMap((line, index) =>
        [...line.matchAll(/`([^`]+)`/g)].flatMap((match) =>
          (match[1] ?? "").split(/\s+/).flatMap((word) => {
            const path = word.replace(/^["']|["',;)]$/g, "").replace(/:\d+(?::\d+)?$/, "");
            if (/^(?:[~@$]|\w+:)|[<>{}]/.test(path) || isAbsolute(path)) return [];
            if (!path.includes("/") && !/^[.\w-]+\.[a-zA-Z][\w-]*$/.test(path) && !/^\.[\w-]+$/.test(path)) return [];
            const bases = [repo, dirname(source)];
            if (
              bases.some((base) => {
                const target = resolve(base, path);
                const inside = relative(repo, target);
                return (
                  !inside.startsWith("..") &&
                  !isAbsolute(inside) &&
                  (existsSync(target) || globSync(path, { cwd: base }).length > 0)
                );
              })
            )
              return [];
            // A reference outside the repository belongs to the user's environment.
            if (bases.every((base) => relative(repo, resolve(base, path)).startsWith(".."))) return [];
            return [`${file}:${index + 1}: missing repository path ${path}`];
          }),
        ),
      );
  });
}

if (import.meta.main) {
  const errors = instructionPaths(resolve(import.meta.dirname, "../.."));
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}
