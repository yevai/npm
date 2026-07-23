/**
 * ESC reflection: type extraction, Zod codegen (generate), and schema validation (validate)
 * against a resolved Pulumi ESC environment.
 *
 * Both flows run dynamically in the directory where the CLI was invoked (SST_WORK_DIR):
 * codegen happens in-process via the bundled json-to-zod API, and the validation harness
 * is evaluated inline with tsx (data passed via env vars) against the project's own
 * ./types schemas. The only files ever written are the actual deliverables in ./types.
 */
import { execSync } from "child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { jsonToZod } from "json-to-zod";
import { tmpdir } from "os";
import { join } from "path";

import type { CliContext, EscValues } from "./common.js";
import { cleanupEphemeralWorkDir, error, info, warn } from "./common.js";

/**
 * Inline CJS harness evaluated by tsx in SST_WORK_DIR.
 * Reads ESC data from env vars and requires the project's ./types schemas directly.
 * Must contain no single quotes: it is wrapped in single quotes for the shell.
 */
const VALIDATE_HARNESS_SCRIPT = `
const { resolve } = require("path");

let exitCode = 0;

const schemas = [
  { name: "PulumiEscEnvironment", dataEnv: "PSST_ESC_ENV_DATA", schemaFile: "./types/PulumiEscEnvironment.ts" },
  { name: "PulumiEscConfig",      dataEnv: "PSST_ESC_CFG_DATA", schemaFile: "./types/PulumiEscConfig.ts" },
];

for (const { name, dataEnv, schemaFile } of schemas) {
  const raw = process.env[dataEnv];
  if (!raw || !require("fs").existsSync(schemaFile)) continue;
  try {
    const data = JSON.parse(raw);
    const mod = require(resolve(schemaFile));
    const schema = mod[name];
    if (!schema || typeof schema.safeParse !== "function") {
      console.error("⚠ Schema " + name + " not found or not a Zod schema");
      exitCode = 1;
      continue;
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      console.error("✗ " + name + " validation failed:");
      console.error(JSON.stringify(result.error.format(), null, 2));
      exitCode = 1;
    } else {
      console.log("✓ " + name + " validated successfully");
    }
  } catch (e) {
    console.error("✗ Error validating " + name + ": " + e);
    exitCode = 1;
  }
}

process.exit(exitCode);
`;

/**
 * Write the Zod schema for `data` to ./types/<typeName>.ts via in-process
 * json-to-zod codegen. For PulumiEscConfig, also emit the CloudConfigV2 module
 * augmentation and ensure sst.config.ts references it.
 */
const generateZodTypes = (
  ctx: CliContext,
  typeName: string,
  data: unknown,
): void => {
  const typesFolder = join(ctx.sstWorkDir, "types");
  if (!existsSync(typesFolder)) {
    try {
      mkdirSync(typesFolder);
      info(`Created types folder at ${typesFolder}`);
    } catch (e) {
      error(`Failed to create types folder at ${typesFolder}: ${e}`);
      process.exit(1);
    }
  }
  const outputTypePath = join(typesFolder, `${typeName}.ts`);
  const typeFileExists = existsSync(outputTypePath);

  writeFileSync(outputTypePath, jsonToZod(data, typeName, true));
  appendFileSync(
    outputTypePath,
    `\nexport type ${typeName} = z.infer<typeof ${typeName}>;\n`,
  );

  if (typeName === "PulumiEscConfig") {
    const dtsPath = join(typesFolder, "pulumi-esc.d.ts");
    const dtsContent = `import type { ${typeName} } from "./${typeName}";\n\ndeclare module "@yai/aws" {\n  interface CloudConfigV2 {\n    requireObject<K extends keyof ${typeName}>(key: K): ${typeName}[K];\n    getObject<K extends keyof ${typeName}>(key: K): ${typeName}[K] | undefined;\n  }\n}\n`;
    writeFileSync(dtsPath, dtsContent);
    info(`Generated module augmentation: ${dtsPath}`, true);

    const refDirective = '/// <reference path="./types/pulumi-esc.d.ts" />';
    try {
      const sstConfig = readFileSync(ctx.sstConfigPath, "utf-8");
      if (!sstConfig.includes(refDirective)) {
        writeFileSync(ctx.sstConfigPath, `${refDirective}\n${sstConfig}`);
      }
      info(`Ensured triple-slash reference in sst.config.ts`, true);
    } catch (e) {
      warn(`Could not add triple-slash reference to sst.config.ts: ${e}`);
    }
  }

  info(
    `${typeFileExists ? "Updated" : "Generated"} types for ${typeName}: ${outputTypePath}`,
    true,
  );
};

/** Generate Zod schemas (and CloudConfigV2 module augmentation) from the resolved ESC values. Exits when done. */
export const runGenerate = (
  ctx: CliContext,
  { environmentVariables, pulumiConfig }: EscValues,
): never => {
  const userHasZod = ctx.allDependencies.includes("zod");
  let cliExecutionErrors = false;

  try {
    if (environmentVariables) {
      info(
        `Reflecting ${Object.keys(environmentVariables).length} ESC environment variables`,
      );
      generateZodTypes(ctx, "PulumiEscEnvironment", environmentVariables);
    }
    if (pulumiConfig) {
      info(
        `Reflecting ${Object.keys(pulumiConfig).length} top-level ESC config values`,
      );
      generateZodTypes(ctx, "PulumiEscConfig", pulumiConfig);
    }
  } catch (e) {
    cliExecutionErrors = true;
    error(`Failed to create ESC types for ${ctx.escReference}`);
    error(e instanceof Error ? e.message : String(e));
  } finally {
    cleanupEphemeralWorkDir(ctx);
  }
  if (!userHasZod) {
    warn(`"npm install zod --save-dev" is recommended to avoid type errors.`);
  }
  process.exit(cliExecutionErrors ? 1 : 0);
};

/**
 * Ensure each ./types schema has matching ESC data and vice versa; exits on mismatch,
 * or with success when ESC is not configured at all. Returns normally when validation
 * should proceed.
 */
const assertSchemasMatchEscData = (
  ctx: CliContext,
  { environmentVariables, pulumiConfig }: EscValues,
): void => {
  const typesDir = join(ctx.sstWorkDir, "types");
  const pairs = [
    {
      file: "PulumiEscEnvironment.ts",
      label: "environmentVariables",
      data: !!environmentVariables,
    },
    { file: "PulumiEscConfig.ts", label: "pulumiConfig", data: !!pulumiConfig },
  ].map((pair) => ({ ...pair, schema: existsSync(join(typesDir, pair.file)) }));

  const escUrl = `https://app.pulumi.com/${ctx.escParts[0]}/esc/${process.env.PULUMI_PROJECT}/${process.env.PULUMI_STACK}`;
  for (const { schema, data, label, file } of pairs) {
    if (schema !== data) {
      error(
        schema
          ? `./types/${file} exists but "${label}" is missing from ${escUrl}`
          : `./types/${file} is missing but "${label}" exists in ${escUrl}`,
      );
      cleanupEphemeralWorkDir(ctx);
      process.exit(1);
    }
  }

  if (pairs.every(({ schema }) => !schema)) {
    warn(`Pulumi ESC is not configured in this project. Skipping`);
    cleanupEphemeralWorkDir(ctx);
    process.exit(0);
  }
};

/**
 * The schema files import "zod": install it into an ephemeral temp dir and expose it
 * via NODE_PATH when the project does not depend on zod. Returns the dir to clean up.
 */
const setupZodFallback = (childEnv: NodeJS.ProcessEnv): string => {
  const zodFallbackDir = mkdtempSync(join(tmpdir(), "pulumi-sst-zod-"));
  execSync(
    "npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --prefer-offline zod",
    {
      cwd: zodFallbackDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  childEnv.NODE_PATH = [
    join(zodFallbackDir, "node_modules"),
    process.env.NODE_PATH,
  ]
    .filter(Boolean)
    .join(":");
  warn(`"npm install zod --save-dev" is recommended to avoid type errors.`);
  return zodFallbackDir;
};

/** Validate the resolved ESC values against the project's generated Zod schemas. Exits when done. */
export const runValidate = (ctx: CliContext, escValues: EscValues): never => {
  assertSchemasMatchEscData(ctx, escValues);

  const { environmentVariables, pulumiConfig } = escValues;
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PSST_ESC_ENV_DATA: environmentVariables
      ? JSON.stringify(environmentVariables)
      : undefined,
    PSST_ESC_CFG_DATA: pulumiConfig ? JSON.stringify(pulumiConfig) : undefined,
  };

  const userHasZod = ctx.allDependencies.includes("zod");
  let zodFallbackDir: string | null = null;
  let cliExecutionErrors = false;

  try {
    if (userHasZod) {
      info("Zod found in project dependencies", true);
    } else {
      zodFallbackDir = setupZodFallback(childEnv);
    }

    execSync(`npx --yes tsx@4.21.0 -e '${VALIDATE_HARNESS_SCRIPT}'`, {
      cwd: ctx.sstWorkDir,
      encoding: "utf-8",
      stdio: ["ignore", "inherit", "inherit"],
      env: childEnv,
    });

    info(`✓ ESC validation passed for ${ctx.escReference}`);
  } catch {
    cliExecutionErrors = true;
    error(`ESC validation failed for ${ctx.escReference}`);
  } finally {
    if (zodFallbackDir) {
      rmSync(zodFallbackDir, { recursive: true, force: true });
    }
    cleanupEphemeralWorkDir(ctx);
  }

  process.exit(cliExecutionErrors ? 1 : 0);
};
