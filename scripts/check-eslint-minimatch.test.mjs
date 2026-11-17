import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { clearCaches, parseAndGenerateServices } from "@typescript-eslint/typescript-estree";

const require = createRequire(import.meta.url);
const parserRequire = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const { minimatch } = parserRequire("minimatch");

test("the reviewed minimatch upgrade is scoped to the TypeScript parser", () => {
  assert.equal(parserRequire("minimatch/package.json").version, "11.0.9");
  assert.equal(require("minimatch/package.json").version, "3.1.5");
  for (const [file, pattern, expected] of [
    [".config.js", "*.js", true],
    ["vite.config.js", "{vite,eslint}.config.js", true],
    ["other.config.js", "{vite,eslint}.config.js", false],
    ["config/build.js", "config/*.js", true],
    ["config/deep/build.js", "config/*.js", false],
    ["config/build.ts", "config/*.js", false],
  ])
    assert.equal(minimatch(file, pattern, { dot: true }), expected, `${file}: ${pattern}`);
});

test("the installed parser still allows only files matched by allowDefaultProject", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cove-eslint-minimatch-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "config"));
    writeFileSync(path.join(root, "src", "index.ts"), "export const value: number = 1;\n");
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { allowJs: true },
        include: ["src/**/*.ts"],
      }),
    );
    for (const file of [".config.js", "vite.config.js", "config/build.js", "unlisted.js"]) {
      clearCaches();
      const code = "export const value = 1;\n";
      const filePath = path.join(root, file);
      writeFileSync(filePath, code);
      const parse = () =>
        parseAndGenerateServices(code, {
          filePath,
          tsconfigRootDir: root,
          projectService: {
            allowDefaultProject: [".config.js", "{vite,eslint}.config.js", "config/*.js"],
          },
        });
      if (file === "unlisted.js") {
        assert.throws(parse, /was not found by the project service/);
      } else {
        const parsed = parse();
        assert.equal(parsed.ast.type, "Program");
        assert.ok(parsed.services.program, `missing TypeScript program for ${file}`);
      }
    }
  } finally {
    clearCaches();
    rmSync(root, { recursive: true, force: true });
  }
});
