#!/usr/bin/env node
import { execSync, spawn } from "child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

type InfraCommands = "deploy" | "preview" | "dev" | "refresh" | "destroy" | "bash";

let ephemeralPulumiDir = false;

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  orange: "\x1b[38;5;208m",
} as const;

const info = (message: string, secondary = false): void => {
  console.log(`${secondary ? COLORS.green : COLORS.cyan}${message}${COLORS.reset}`);
};

const warn = (message: string): void => {
  console.warn(`${COLORS.yellow}${message}${COLORS.reset}`);
};

const alert = (message: string): void => {
  console.warn(`${COLORS.orange}${message}${COLORS.reset}`);
};

const error = (message: string): void => {
  console.error(`${COLORS.red}${message}${COLORS.reset}`);
};

const VALIDATE_HARNESS_SCRIPT = `
import { readFileSync, existsSync } from "fs";

let exitCode = 0;

const schemas = [
  { name: "PulumiEscEnvironment", dataFile: "./env-data.json", schemaFile: "./PulumiEscEnvironment.ts" },
  { name: "PulumiEscConfig",      dataFile: "./config-data.json", schemaFile: "./PulumiEscConfig.ts" },
];

for (const { name, dataFile, schemaFile } of schemas) {
  if (!existsSync(dataFile) || !existsSync(schemaFile)) continue;
  try {
    const data = JSON.parse(readFileSync(dataFile, "utf-8"));
    const mod = require(schemaFile);
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

const getInfraCommandMode = (pulumiCommand: string): InfraCommands => {
  const commandMap: Record<string, InfraCommands> = {
    up: "deploy",
    deploy: "deploy",
    preview: "preview",
    diff: "preview",
    dev: "dev",
    refresh: "refresh",
    destroy: "destroy",
    remove: "destroy",
    bash: "bash",
  };

  const mode = commandMap[pulumiCommand.toLowerCase()];
  if (!mode) {
    error(`Invalid PULUMI_COMMAND: "${pulumiCommand}"`);
    error("Valid commands: up, deploy, preview, diff, dev, refresh, destroy, remove, bash");
    process.exit(1);
  }
  return mode;
};

const getCliCommandMode = (command: string): boolean => {
  if (["generate", "validate", "bash"].includes(command.toLowerCase())) {
    process.env.CLI_COMMAND_MODE = command.toLowerCase();
    return true;
  }
  return false;
};

/** Set an env var, logging when it is introduced and warning when an existing value changes. */
const setEnv = (key: string, value: string, source: string): void => {
  const current = process.env[key];
  if (current === undefined) {
    info(`Set ${key}=${value} from ${source}.`);
  } else if (current !== value) {
    warn(`⚠ Overriding ${key} from ${current} to ${value}`);
  }
  process.env[key] = value;
};

console.info(""); // Init pipe

if (!process.env.SST_WORK_DIR) {
  process.env.SST_WORK_DIR = process.cwd();
  console.warn(`SST_WORK_DIR defaulting to ${process.env.SST_WORK_DIR}`);
}
const SST_WORK_DIR = process.env.SST_WORK_DIR!;
const packageJsonPath = join(SST_WORK_DIR, "package.json");
const sstConfigPath = join(SST_WORK_DIR, "sst.config.ts");

if (!existsSync(sstConfigPath)) {
  error(`sst.config.ts not found in SST_WORK_DIR: ${SST_WORK_DIR}`);
  process.exit(1);
}

if (!existsSync(packageJsonPath)) {
  error(`package.json not found in SST_WORK_DIR: ${SST_WORK_DIR}`);
  process.exit(1);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

if (!packageJson.name) {
  error(`package.json does not contain the required field "name"`);
  process.exit(1);
}

if (!process.env.PULUMI_PROJECT) {
  process.env.PULUMI_PROJECT = packageJson.name;
}

// Usage overload: yaws <project>/<stack> [InfraCommands | DxCommands]
const args = process.argv.slice(2);

if (args.length !== 0 && args.length !== 2) {
  error(`Expected zero or two arguments, received ${args.length}`);
  error(`Usage: yaws <project>/<stack> (also a valid ESC env) <command>`);
  process.exit(1);
}

if (args.length === 2) {
  process.env.PULUMI_COMMAND = args[1];
  const [pulumiStack, pulumiProject, pulumiOrganization] = args[0].split("/").reverse();
  if (pulumiStack) {
    setEnv("PULUMI_STACK", pulumiStack, "args");
  }
  if (pulumiProject) {
    setEnv("PULUMI_PROJECT", pulumiProject, "args");
  }
  if (pulumiOrganization) {
    setEnv("PULUMI_ORGANIZATION", pulumiOrganization, "args");
    process.env.PULUMI_ORG = pulumiOrganization;
  }
}

if (!process.env.PULUMI_COMMAND) {
  error("PULUMI_COMMAND is required but not set (pass a command argument or set the env var)");
  error(`Usage: yaws <project>/<stack> (also a valid ESC env) <command>`);
  process.exit(1);
}

// "bash" is both a CLI and infra command; "generate"/"validate" exit before the infra flow runs
const INFRA_COMMAND_MODE: InfraCommands | null = getCliCommandMode(process.env.PULUMI_COMMAND)
  ? process.env.PULUMI_COMMAND.toLowerCase() === "bash"
    ? "bash"
    : null
  : getInfraCommandMode(process.env.PULUMI_COMMAND);

if (!process.env.PULUMI_WORK_DIR) {
  process.env.PULUMI_WORK_DIR = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "pulumi-"));
  ephemeralPulumiDir = true;
} else if (!existsSync(join(process.env.PULUMI_WORK_DIR, "Pulumi.yaml"))) {
  error(`Fatal: Pulumi.yaml not found in PULUMI_WORK_DIR: ${process.env.PULUMI_WORK_DIR}`);
  process.exit(1);
}

const PULUMI_WORK_DIR = process.env.PULUMI_WORK_DIR!;

const cleanupEphemeralWorkDir = (): void => {
  if (!ephemeralPulumiDir) return;
  try {
    rmSync(PULUMI_WORK_DIR, { recursive: true, force: true });
    info(`✓ Cleaned up ${PULUMI_WORK_DIR}`, true);
  } catch (e) {
    warn(`⚠ Failed to clean up Pulumi work dir: ${e}`);
  }
};

const generateZodTypesFromJson = (typeName: string, inputValuesPath: string): void => {
  const typesFolder = join(SST_WORK_DIR, "types");
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
  if (typeFileExists) {
    try {
      unlinkSync(outputTypePath);
      info(`Unlinked existing type file at ${outputTypePath}`);
    } catch (e) {
      error(`Failed to unlink existing type file at ${outputTypePath}: ${e}`);
      process.exit(1);
    }
  }
  // Unlike zod, this is codegen. Always pin code generator versions.
  execSync(`npx --yes json-to-zod@1.1.2 -s "${inputValuesPath}" -t "${outputTypePath}" -n ${typeName}`, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  appendFileSync(outputTypePath, `\nexport type ${typeName} = z.infer<typeof ${typeName}>;\n`);

  // Generate module augmentation for typed CloudConfigV2
  if (typeName === "PulumiEscConfig") {
    const dtsPath = join(typesFolder, "pulumi-esc.d.ts");
    const dtsContent = `import type { ${typeName} } from "./${typeName}";\n\ndeclare module "@yai/aws" {\n  interface CloudConfigV2 {\n    requireObject<K extends keyof ${typeName}>(key: K): ${typeName}[K];\n    getObject<K extends keyof ${typeName}>(key: K): ${typeName}[K] | undefined;\n  }\n}\n`;
    writeFileSync(dtsPath, dtsContent);
    info(`Generated module augmentation: ${dtsPath}`, true);

    // Ensure sst.config.ts has the triple-slash reference
    const refDirective = '/// <reference path="./types/pulumi-esc.d.ts" />';
    try {
      const sstConfig = readFileSync(sstConfigPath, "utf-8");
      if (!sstConfig.includes(refDirective)) {
        writeFileSync(sstConfigPath, `${refDirective}\n${sstConfig}`);
      }
      info(`Ensured triple-slash reference in sst.config.ts`, true);
    } catch (e) {
      warn(`Could not add triple-slash reference to sst.config.ts: ${e}`);
    }
  }

  info(`${typeFileExists ? "Updated" : "Generated"} types for ${typeName}: ${outputTypePath}`, true);
};

const allDependencies = Object.keys(packageJson.dependencies || {}).concat(Object.keys(packageJson.devDependencies || {}));

const escParts = [process.env.PULUMI_ORG ?? process.env.PULUMI_ORGANIZATION, process.env.PULUMI_PROJECT, process.env.PULUMI_STACK].filter(
  Boolean,
);
const escReference = escParts.join("/");

try {
  const { environmentVariables, pulumiConfig } = JSON.parse(
    execSync(`pulumi esc get ${escReference} --value json --show-secrets`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const userHasZod = allDependencies.includes("zod");
  let cliExecutionErrors = false;

  if (process.env.CLI_COMMAND_MODE === "generate") {
    const envValuesPath = join(PULUMI_WORK_DIR, "pulumiEnvironmentValues.json");
    const escConfigValuesPath = join(PULUMI_WORK_DIR, "pulumiConfigValues.json");

    try {
      if (environmentVariables) {
        writeFileSync(envValuesPath, JSON.stringify(environmentVariables, null, 2));
        info(`Created ${envValuesPath} with ${Object.keys(environmentVariables).length} variables`);
        generateZodTypesFromJson("PulumiEscEnvironment", envValuesPath);
      }
      if (pulumiConfig) {
        writeFileSync(escConfigValuesPath, JSON.stringify(pulumiConfig, null, 2));
        info(`Created ${escConfigValuesPath} with ${Object.keys(pulumiConfig).length} top-level variables`);
        generateZodTypesFromJson("PulumiEscConfig", escConfigValuesPath);
      }
    } catch (e) {
      cliExecutionErrors = true;
      error(`Failed to create ESC types for ${escReference}`);
      error(e instanceof Error ? e.message : String(e));
    } finally {
      for (const tempPath of [envValuesPath, escConfigValuesPath]) {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
          info(`Unlinked ${tempPath}`);
        }
      }
      cleanupEphemeralWorkDir();
    }
    if (!userHasZod) {
      warn(`"npm install zod --save-dev" is recommended to avoid type errors.`);
    }
    process.exit(cliExecutionErrors ? 1 : 0);
  } else if (process.env.CLI_COMMAND_MODE === "validate") {
    const typesDir = join(SST_WORK_DIR, "types");
    const envSchemaPath = join(typesDir, "PulumiEscEnvironment.ts");
    const cfgSchemaPath = join(typesDir, "PulumiEscConfig.ts");
    const hasEnvSchema = existsSync(envSchemaPath);
    const hasCfgSchema = existsSync(cfgSchemaPath);

    const pairs = [
      {
        schema: hasEnvSchema,
        data: !!environmentVariables,
        label: "environmentVariables",
        file: "PulumiEscEnvironment.ts",
      },
      { schema: hasCfgSchema, data: !!pulumiConfig, label: "pulumiConfig", file: "PulumiEscConfig.ts" },
    ];

    const escUrl = `https://app.pulumi.com/${escParts[0]}/esc/${process.env.PULUMI_PROJECT}/${process.env.PULUMI_STACK}`;
    for (const { schema, data, label, file } of pairs) {
      if (schema !== data) {
        error(
          schema
            ? `./types/${file} exists but "${label}" is missing from ${escUrl}`
            : `./types/${file} is missing but "${label}" exists in ${escUrl}`,
        );
        cleanupEphemeralWorkDir();
        process.exit(1);
      }
    }

    if (!hasEnvSchema && !hasCfgSchema) {
      warn(`Pulumi ESC is not configured in this project. Skipping`);
      cleanupEphemeralWorkDir();
      process.exit(0);
    }

    const tempFiles: string[] = [];
    const workNodeModules = join(PULUMI_WORK_DIR, "node_modules");
    let createdNodeModules = false;

    try {
      if (userHasZod) {
        if (!existsSync(workNodeModules)) {
          symlinkSync(join(SST_WORK_DIR, "node_modules"), workNodeModules, "dir");
          createdNodeModules = true;
          info("Zod found, node_modules linked", true);
        }
      } else {
        const workPkgJson = join(PULUMI_WORK_DIR, "package.json");
        writeFileSync(
          workPkgJson,
          JSON.stringify(
            {
              name: "yaws",
              private: true,
              type: "module",
              devDependencies: { zod: "*" },
            },
            null,
            2,
          ),
        );
        tempFiles.push(workPkgJson);
        execSync("npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --prefer-offline zod", {
          cwd: PULUMI_WORK_DIR,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        createdNodeModules = true;
        warn(`"npm install zod --save-dev" is recommended to avoid type errors.`);
      }
      if (environmentVariables) {
        const dataPath = join(PULUMI_WORK_DIR, "env-data.json");
        writeFileSync(dataPath, JSON.stringify(environmentVariables, null, 2));
        tempFiles.push(dataPath);
      }
      if (pulumiConfig) {
        const dataPath = join(PULUMI_WORK_DIR, "config-data.json");
        writeFileSync(dataPath, JSON.stringify(pulumiConfig, null, 2));
        tempFiles.push(dataPath);
      }
      if (hasEnvSchema) {
        const dest = join(PULUMI_WORK_DIR, "PulumiEscEnvironment.ts");
        copyFileSync(envSchemaPath, dest);
        tempFiles.push(dest);
      }
      if (hasCfgSchema) {
        const dest = join(PULUMI_WORK_DIR, "PulumiEscConfig.ts");
        copyFileSync(cfgSchemaPath, dest);
        tempFiles.push(dest);
      }
      const harnessPath = join(PULUMI_WORK_DIR, "validate-esc.ts");
      writeFileSync(harnessPath, VALIDATE_HARNESS_SCRIPT);
      tempFiles.push(harnessPath);

      execSync("npx --yes tsx@4.21.0 validate-esc.ts", {
        cwd: PULUMI_WORK_DIR,
        encoding: "utf-8",
        stdio: "inherit",
      });

      info(`✓ ESC validation passed for ${escReference}`);
    } catch {
      cliExecutionErrors = true;
      error(`ESC validation failed for ${escReference}`);
    } finally {
      if (ephemeralPulumiDir) {
        cleanupEphemeralWorkDir();
      } else {
        for (const tempPath of tempFiles) {
          if (existsSync(tempPath)) unlinkSync(tempPath);
        }
        // Only remove node_modules this run created; never a pre-existing one
        if (createdNodeModules && existsSync(workNodeModules)) {
          rmSync(workNodeModules, { recursive: true, force: true });
        }
      }
    }

    process.exit(cliExecutionErrors ? 1 : 0);
  }

  const { PULUMI_PROVIDERS, STACK_REFERENCES, PULUMI_STACK, PULUMI_COMMAND, PULUMI_PROJECT, PULUMI_ORGANIZATION, PULUMI_ORG, ...otherEnv } =
    environmentVariables ?? {};

  Object.keys(otherEnv).forEach((key) => {
    info(`Added ESC Environment Variable: ${key}`, true);
  });
  process.env = { ...process.env, ...otherEnv };

  if (PULUMI_PROVIDERS) {
    setEnv("PULUMI_PROVIDERS", PULUMI_PROVIDERS, "esc");
  }
  if (STACK_REFERENCES) {
    if (!process.env.STACK_REFERENCES) {
      STACK_REFERENCES.split(",").forEach((ref: string) => {
        info(`Added Stack Reference: ${ref}`, true);
      });
    } else if (process.env.STACK_REFERENCES !== STACK_REFERENCES) {
      warn(`⚠ Overriding STACK_REFERENCES from ${process.env.STACK_REFERENCES} to ${STACK_REFERENCES}`);
    }
    process.env.STACK_REFERENCES = STACK_REFERENCES;
  }
} catch (e) {
  error(`Failed to retrieve ESC environment variables for ${escReference}: ${e}`);
}

const sanitizeAwsEnv = (baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const cleaned = { ...baseEnv };
  delete cleaned.AWS_PROFILE;
  delete cleaned.AWS_DEFAULT_PROFILE;
  cleaned.AWS_CONFIG_FILE = "/dev/null";
  return cleaned;
};

process.env = sanitizeAwsEnv(process.env);

const { PULUMI_STACK, PULUMI_PROVIDERS } = process.env;

if (!PULUMI_STACK) {
  error("PULUMI_STACK is required but not set");
  process.exit(1);
}

if (ephemeralPulumiDir) {
  const programDescription = packageJson.description || "Pulumi program for " + process.env.PULUMI_PROJECT;
  // Generate minimal Pulumi.yaml and package.json for the ephemeral workspace
  const minimalPulumiYaml = `name: ${process.env.PULUMI_PROJECT}
description: ${programDescription}
runtime:
  name: nodejs
  options:
    typescript: true
`;
  writeFileSync(join(PULUMI_WORK_DIR, "Pulumi.yaml"), minimalPulumiYaml);
  writeFileSync(
    join(PULUMI_WORK_DIR, "package.json"),
    JSON.stringify(
      {
        name: process.env.PULUMI_PROJECT,
        description: programDescription,
        version: "0.0.1",
        private: true,
        main: "index.ts",
      },
      null,
      2,
    ),
  );
}

const COLOR_ENV = {
  FORCE_COLOR: "1",
  PULUMI_COLOR: "always",
  CLICOLOR_FORCE: "1",
};

// Sanitize the merged result so AWS profile vars from extraEnv (e.g. a restored env snapshot) are also stripped
const buildEnv = (extraEnv: Record<string, string>): NodeJS.ProcessEnv =>
  sanitizeAwsEnv({
    ...process.env,
    ...extraEnv,
    ...COLOR_ENV,
  });

const spawnWithEnv = (shellCommand: string, extraEnv: Record<string, string>): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", shellCommand], {
      stdio: "inherit",
      env: buildEnv(extraEnv),
      cwd: SST_WORK_DIR,
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on("error", reject);
  });
};

const runSstWithEnv = async (shellCommand: string, extraEnv: Record<string, string>): Promise<void> => {
  try {
    await spawnWithEnv(shellCommand, extraEnv);
    info(`✓ SST completed successfully`, true);
  } catch (e) {
    throw new Error(`Failed to run SST: ${e}`);
  }
};

const maskSecretsForGithubActions = (): void => {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return;
  }

  const sensitivePatterns = ["PRIVATE", "SECRET"];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && sensitivePatterns.some((pattern) => key.includes(pattern))) {
      console.log(`::add-mask::${value}`);
    }
  }
};

/** Collect maskable string values: long enough to be unambiguous, and not emails. */
const extractStringValues = (obj: unknown): string[] => {
  const values: string[] = [];

  if (typeof obj === "string") {
    if (obj.length > 10 && !obj.includes("@")) {
      values.push(obj);
    }
  } else if (typeof obj === "object" && obj !== null) {
    for (const value of Object.values(obj)) {
      values.push(...extractStringValues(value));
    }
  }

  return values;
};

/** Mask secret stack config values directly from the Automation API (replaces the preview-side mask.txt file). */
const maskStackSecretsForGithubActions = async (stack: {
  getAllConfig(): Promise<Record<string, { value: string; secret?: boolean }>>;
}): Promise<void> => {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return;
  }

  try {
    const allConfig = await stack.getAllConfig();
    const secretValues = new Set<string>();

    for (const { value, secret } of Object.values(allConfig)) {
      if (!secret || !value) continue;

      if (value.startsWith("{") || value.startsWith("[")) {
        try {
          extractStringValues(JSON.parse(value)).forEach((v) => secretValues.add(v));
          continue;
        } catch {
          // Not valid JSON, mask the raw string below
        }
      }
      extractStringValues(value).forEach((v) => secretValues.add(v));
    }

    for (const secret of secretValues) {
      console.log(`::add-mask::${secret}`);
    }
    info(`✓ Masked ${secretValues.size} secrets`, true);
  } catch (e) {
    error(`Failed to mask stack config secrets: ${e}`);
  }
};

/** Resolve the environmentVariables of each ESC provider environment directly (replaces the preview-side env.json snapshot). */
const resolveProviderEnvVars = (organization: string | undefined, providers: string[]): Record<string, string> => {
  const merged: Record<string, string> = {};

  for (const provider of providers) {
    const envRef = provider.split("/").length >= 3 || !organization ? provider : `${organization}/${provider}`;
    try {
      const opened = JSON.parse(
        execSync(`pulumi env open ${envRef} --format json`, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      for (const [key, value] of Object.entries(opened.environmentVariables ?? {})) {
        merged[key] = String(value);
      }
      info(`Resolved ESC Environment: ${envRef}`, true);
    } catch (e) {
      error(`Failed to open ESC environment ${envRef}: ${e}`);
    }
  }

  return merged;
};

(async () => {
  try {
    maskSecretsForGithubActions(); // Mask sensitive env vars (config secrets are masked after stack selection)
    const commandMode = INFRA_COMMAND_MODE!; // generate/validate exited before this point

    const sstCommandMap: Record<InfraCommands, string> = {
      deploy: "deploy",
      preview: "diff",
      dev: "dev",
      refresh: "refresh",
      destroy: "remove", // SST uses 'remove' not 'destroy'
      bash: "bash",
    };

    const sstCommand = sstCommandMap[commandMode];

    info(`Starting ${commandMode} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
    info(`Working directory: ${PULUMI_WORK_DIR}`);

    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "pulumi-template.ts"), join(PULUMI_WORK_DIR, "index.ts"));

    const nodeModulesLink = join(PULUMI_WORK_DIR, "node_modules");

    if (ephemeralPulumiDir && !existsSync(nodeModulesLink)) {
      symlinkSync(join(SST_WORK_DIR, "node_modules"), nodeModulesLink, "dir");
      info(`✓ Symlinked node_modules from ${SST_WORK_DIR}`, true);
    }

    // Use explicit index.js for ESM compatibility
    const { LocalWorkspace } = await import("@pulumi/pulumi/automation/index.js");

    const stack = await LocalWorkspace.createOrSelectStack(
      {
        stackName: PULUMI_STACK,
        workDir: PULUMI_WORK_DIR,
      },
      {
        envVars: {
          ...(process.env as Record<string, string>),
        },
      },
    );

    if (PULUMI_PROVIDERS) {
      const providers = PULUMI_PROVIDERS.split(",").map((p) => p.trim());
      providers.forEach((provider) => info(`Added ESC Environment: ${provider}`, true));
      await stack.addEnvironments(...providers);
    } else {
      alert("Environment variable PULUMI_PROVIDERS is not set. This is likely unintended.");
    }

    // Mask secret config values before any engine output is streamed
    await maskStackSecretsForGithubActions(stack);

    // Preview must always run: it resolves the registered StackReferences against Pulumi Cloud,
    // pulling in upstream stack output changes and persisting them in this stack's state.
    await stack.preview({
      color: "always",
      onOutput: (msg: string) => process.stdout.write(msg),
    });

    const {
      PULUMI_ACCESS_TOKEN: HOST_PULUMI_ACCESS_TOKEN,
      PULUMI_BACKEND_URL: HOST_PULUMI_BACKEND_URL,
      PULUMI_ORG: HOST_PULUMI_ORG,
      PULUMI_ORGANIZATION: HOST_PULUMI_ORGANIZATION,
      HOME: HOST_HOME,
      PATH: HOST_PATH,
      USER: HOST_USER,
    } = process.env;

    // Resolve provider ESC env vars directly instead of snapshotting them from inside the preview run
    const hostEnv = {
      HOST_PULUMI_ACCESS_TOKEN,
      HOST_PULUMI_BACKEND_URL,
      HOST_PULUMI_ORG,
      HOST_PULUMI_ORGANIZATION,
      HOST_HOME,
      HOST_PATH,
      HOST_USER,
    };
    const envFromPulumi: Record<string, string> = {
      ...resolveProviderEnvVars(
        HOST_PULUMI_ORG ?? HOST_PULUMI_ORGANIZATION,
        PULUMI_PROVIDERS ? PULUMI_PROVIDERS.split(",").map((p) => p.trim()) : [],
      ),
      ...(Object.fromEntries(Object.entries(hostEnv).filter(([, v]) => v !== undefined)) as Record<string, string>),
    };
    info(`✓ Loaded environment`, true);

    if (process.env.CLI_COMMAND_MODE === "bash") {
      const nvmScript = join(HOST_HOME || "", ".nvm", "nvm.sh");
      if (!existsSync(nvmScript)) {
        error(`NVM is required but was not found at ${nvmScript}.`);
        process.exit(1);
      }

      const rawUserShell = process.env.SHELL || "bash";
      const isZsh = rawUserShell.endsWith("zsh");
      const userShell = isZsh ? "zsh" : "bash";

      info(`Dropping into AWS state linked shell (${userShell}) for ${PULUMI_STACK}`);
      info(`Helpful tips below. If you're here, good luck!`);
      warn(` npx sst state export --stage ${PULUMI_STACK}        [Export stack state]`);
      warn(` npx sst unlock --stage ${PULUMI_STACK}              [Unlock deployment]`);
      warn(` npx sst state remove <urn> --stage ${PULUMI_STACK}  [Remove resource]`);
      warn(` npx sst state edit --stage ${PULUMI_STACK}          [Interactive editor]`);

      const nvmInitLines = [`export NVM_DIR="$HOME/.nvm"`, `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`];

      if (isZsh) {
        const zshrcPath = join(PULUMI_WORK_DIR, ".zshrc");
        writeFileSync(zshrcPath, nvmInitLines.join("\n"));
        await spawnWithEnv(userShell, { ...envFromPulumi, ZDOTDIR: PULUMI_WORK_DIR });
        if (existsSync(zshrcPath)) unlinkSync(zshrcPath);
      } else {
        const tmpInitPath = join(PULUMI_WORK_DIR, "bash-init.sh");
        writeFileSync(tmpInitPath, [`export BASH_SILENCE_DEPRECATION_WARNING=1`, ...nvmInitLines].join("\n"));
        await spawnWithEnv(`bash --init-file "${tmpInitPath}"`, envFromPulumi);
        if (existsSync(tmpInitPath)) unlinkSync(tmpInitPath);
      }
      return; // skip the normal SST/Pulumi flow
    }

    if (commandMode === "dev") {
      await spawnWithEnv(`npx sst dev --stage ${PULUMI_STACK}`, envFromPulumi);
    } else if (commandMode === "refresh") {
      // First refresh SST state, then Pulumi state
      await runSstWithEnv(`npx sst refresh --stage ${PULUMI_STACK}`, envFromPulumi);
      await stack.refresh({
        color: "always",
        onOutput: (msg: string) => process.stdout.write(msg),
      });
    } else if (commandMode === "destroy") {
      // Run SST remove first, then Pulumi destroy
      await runSstWithEnv(`npx sst remove --stage ${PULUMI_STACK}`, envFromPulumi);
      await stack.destroy({
        color: "always",
        onOutput: (msg: string) => process.stdout.write(msg),
      });
    } else {
      // deploy or preview
      await runSstWithEnv(`npx sst ${sstCommand} --stage ${PULUMI_STACK}`, envFromPulumi);

      if (commandMode === "deploy") {
        await stack.up({
          color: "always",
          onOutput: (msg: string) => process.stdout.write(msg),
        });
      }
    }
    info(`✓ Finished ${commandMode} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
  } catch (e) {
    error(`Error during SST execution: ${e}`);
    process.exitCode = 1;
  } finally {
    cleanupEphemeralWorkDir();
  }
})();
