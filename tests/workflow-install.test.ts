/**
 * Guard: no workflow should fall back to a plain `npm install`.
 * Reads every .github/workflows/*.yml and fails if any run line
 * contains `npm install` without a specific package argument.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WF_DIR = join(import.meta.dirname ?? ".", "..", ".github", "workflows");

describe("workflow install hygiene", () => {
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"));

  it("has workflow files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("no bare 'npm install' in %s", (file) => {
    const content = readFileSync(join(WF_DIR, file), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match `npm install` not followed by a package specifier
      if (/run:\s*npm install\s*$/.test(line) || /npm ci \|\| npm install/.test(line)) {
        throw new Error(`${file}:${i + 1} uses bare \`npm install\` — must use \`npm ci\``);
      }
    }
  });
});
