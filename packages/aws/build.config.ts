import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defineBuildConfig } from "unbuild";

const entries = [
  { input: "src/sst.ts", name: "sst" },
  { input: "src/cli.ts", name: "cli" },
];

export default defineBuildConfig({
  entries,
  declaration: true,
  clean: false,
  rollup: {
    emitCJS: true,
    inlineDependencies: true,
    esbuild: {
      minify: false,
    },
    commonjs: {
      exclude: [/node_modules\/zod\/.*\.d\.ts$/],
    },
  },
  hooks: {
    "rollup:options": (_ctx, options) => {
      const originalOnwarn = options.onwarn;
      options.onwarn = (warning, warn) => {
        if (warning.code === "EMPTY_BUNDLE") return;
        if (originalOnwarn) {
          originalOnwarn(warning, warn);
        } else {
          warn(warning);
        }
      };
    },
    "build:done": async (ctx) => {
      const root = ctx.options.rootDir;
      copyFileSync(
        join(root, "src/index.ts"),
        join(root, "dist/pulumi-template.ts"),
      );
      const shebang = "#!/usr/bin/env node\n";
      for (const file of ["dist/cli.mjs", "dist/cli.cjs"]) {
        const filePath = join(root, file);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          if (!content.startsWith("#!")) {
            writeFileSync(filePath, shebang + content);
          }
          chmodSync(filePath, 0o755);
        }
      }
      const unusedDts = ["dist/cli.d.ts", "dist/cli.d.mts", "dist/cli.d.cts"];
      for (const file of unusedDts) {
        const filePath = join(root, file);
        if (existsSync(filePath)) {
          rmSync(filePath);
        }
      }
    },
  },
});
