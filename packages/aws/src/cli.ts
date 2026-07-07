#!/usr/bin/env node
import { execSync, spawn } from "child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { load } from "js-yaml";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

type CliCommands = "deploy" | "preview" | "dev" | "refresh" | "destroy" | "generate" | "validate" | "bash";
type DxCommands = "generate" | "validate";
type InfraCommands = Exclude<CliCommands, DxCommands>;

let ephemeralPulumiDir = false;
let hasPulumiYaml = false;

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

// Usage overload: pulumi-sst <project>/<stack> [InfraCommands | DxCommands]
const args = process.argv.slice(2);

if (args.length !== 2 && args.length > 0) {
  error(`Expected zero or two arguments, received ${args.length}`);
  error(`Usage: pulumi-sst <project>/<stack> (also a valid ESC env) <command>`);
  process.exit(1);
}

process.env.PULUMI_COMMAND = args[1];

if (!getCliCommandMode(process.env.PULUMI_COMMAND)) {
  getInfraCommandMode(process.env.PULUMI_COMMAND);
}

if (!args[0].includes("/")) {
  if (!process.env.PULUMI_STACK) {
    process.env.PULUMI_STACK = args[0];
    info(`Set PULUMI_STACK=${process.env.PULUMI_STACK} from args.`);
  } else {
    warn(`⚠ Overriding PULUMI_STACK from ${process.env.PULUMI_STACK} to ${args[0]}`);
    process.env.PULUMI_STACK = args[0];
  }
} else {
  const [pulumiStack, pulumiProject, pulumiOrganization] = args[0].split("/").reverse();
  if (pulumiStack) {
    if (!process.env.PULUMI_STACK) {
      process.env.PULUMI_STACK = pulumiStack;
      info(`Set PULUMI_STACK=${process.env.PULUMI_STACK} from args.`);
    } else {
      warn(`⚠ Overriding PULUMI_STACK from ${process.env.PULUMI_STACK} to ${pulumiStack}`);
      process.env.PULUMI_STACK = pulumiStack;
    }
  }
  if (pulumiProject) {
    if (!process.env.PULUMI_PROJECT) {
      process.env.PULUMI_PROJECT = pulumiProject;
      info(`Set PULUMI_PROJECT=${process.env.PULUMI_PROJECT} from args.`);
    } else {
      warn(`⚠ Overriding PULUMI_PROJECT from ${process.env.PULUMI_PROJECT} to ${pulumiProject}`);
      process.env.PULUMI_PROJECT = pulumiProject;
    }
  }
  if (pulumiOrganization) {
    if (!process.env.PULUMI_ORGANIZATION) {
      process.env.PULUMI_ORGANIZATION = pulumiOrganization;
      process.env.PULUMI_ORG = pulumiOrganization;
      info(`Set PULUMI_ORGANIZATION=${process.env.PULUMI_ORGANIZATION} from args.`);
    } else {
      warn(`⚠ Overriding PULUMI_ORGANIZATION from ${process.env.PULUMI_ORGANIZATION} to ${pulumiOrganization}`);
      process.env.PULUMI_ORGANIZATION = pulumiOrganization;
      process.env.PULUMI_ORG = pulumiOrganization;
    }
  }
}

if (!process.env.PULUMI_WORK_DIR) {
  if (process.env.RUNNER_TEMP) {
    process.env.PULUMI_WORK_DIR = mkdtempSync(join(process.env.RUNNER_TEMP, "pulumi-"));
    ephemeralPulumiDir = true;
  } else {
    process.env.PULUMI_WORK_DIR = mkdtempSync(join(tmpdir(), "pulumi-"));
    ephemeralPulumiDir = true;
  }
} else {
  const pulumiYamlPath = join(process.env.PULUMI_WORK_DIR, "Pulumi.yaml");
  if (existsSync(pulumiYamlPath)) {
    hasPulumiYaml = true;
  } else {
    console.error(`Fatal: Pulumi.yaml not found in PULUMI_WORK_DIR: ${process.env.PULUMI_WORK_DIR}`);
    process.exit(1);
  }
}

const generateZodTypesFromJson = (typeName: string, inputValuesPath: string) => {
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
  const typesCommand = `npx --yes json-to-zod@1.1.2 -s ${inputValuesPath} -t ${outputTypePath} -n ${typeName} && echo '\nexport type ${typeName} = z.infer<typeof ${typeName}>;\n' >> ${outputTypePath}`;
  execSync(typesCommand, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  // Generate module augmentation for typed CloudConfigV2
  if (typeName === "PulumiEscConfig") {
    const dtsPath = join(typesFolder, "pulumi-esc.d.ts");
    const dtsContent = `import type { ${typeName} } from "./${typeName}";\n\ndeclare module "@yai/aws" {\n  interface CloudConfigV2 {\n    requireObject<K extends keyof ${typeName}>(key: K): ${typeName}[K];\n    getObject<K extends keyof ${typeName}>(key: K): ${typeName}[K] | undefined;\n  }\n}\n`;
    writeFileSync(dtsPath, dtsContent);
    info(`Generated module augmentation: ${dtsPath}`, true);

    // Ensure sst.config.ts has the triple-slash reference
    const sstConfigPath = join(SST_WORK_DIR, "sst.config.ts");
    const refDirective = '/// <reference path="./types/pulumi-esc.d.ts" />';
    if (existsSync(sstConfigPath)) {
      try {
        execSync(`grep -qF '${refDirective}' ${sstConfigPath} || sed -i '' '1s|^|${refDirective}\\n|' ${sstConfigPath}`, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        info(`Ensured triple-slash reference in sst.config.ts`, true);
      } catch (e) {
        warn(`Could not add triple-slash reference to sst.config.ts: ${e}`);
      }
    }
  }

  info(`${typeFileExists ? "Updated" : "Generated"} types for ${typeName}: ${outputTypePath}`, true);
};

const allDependencies = Object.keys(packageJson.dependencies || {}).concat(Object.keys(packageJson.devDependencies || {}));

const escReference = [process.env.PULUMI_ORG ?? process.env.PULUMI_ORGANIZATION, process.env.PULUMI_PROJECT, process.env.PULUMI_STACK]
  .filter(Boolean)
  .join("/");

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
    const envValuesPath = join(process.env.PULUMI_WORK_DIR, "pulumiEnvironmentValues.json");
    const escConfigValuesPath = join(process.env.PULUMI_WORK_DIR, "pulumiConfigValues.json");

    try {
      if (environmentVariables) {
        const typeName = "PulumiEscEnvironment";
        writeFileSync(envValuesPath, JSON.stringify(environmentVariables, null, 2));
        info(`Created ${envValuesPath} with ${Object.keys(environmentVariables).length} variables`);
        generateZodTypesFromJson(typeName, envValuesPath);
      }
      if (pulumiConfig) {
        const typeName = "PulumiEscConfig";
        writeFileSync(escConfigValuesPath, JSON.stringify(pulumiConfig, null, 2));
        info(`Created ${escConfigValuesPath} with ${Object.keys(pulumiConfig).length} top-level variables`);
        generateZodTypesFromJson(typeName, escConfigValuesPath);
      }
    } catch (e) {
      cliExecutionErrors = true;
      error(`Failed to create ESC types for ${escReference}`);
      error(e instanceof Error ? e.message : String(e));
    } finally {
      if (existsSync(envValuesPath)) {
        unlinkSync(envValuesPath);
        info(`Unlinked ${envValuesPath}`);
      }
      if (existsSync(escConfigValuesPath)) {
        unlinkSync(escConfigValuesPath);
        info(`Unlinked ${escConfigValuesPath}`);
      }
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

    const escUrl = `https://app.pulumi.com/${process.env.PULUMI_ORGANIZATION}/esc/${escReference}`;
    for (const { schema, data, label, file } of pairs) {
      if (schema !== data) {
        error(
          schema
            ? `./types/${file} exists but "${label}" is missing from ${escUrl}`
            : `./types/${file} is missing but "${label}" exists in ${escUrl}`,
        );
        process.exit(1);
      }
    }

    if (!hasEnvSchema && !hasCfgSchema) {
      warn(`Pulumi ESC is not configured in this project. Skipping`);
      process.exit(0);
    }
    const WORK = process.env.PULUMI_WORK_DIR!;
    const tempFiles: string[] = [];

    try {
      if (userHasZod) {
        const nodeModulesLink = join(WORK, "node_modules");
        if (!existsSync(nodeModulesLink)) {
          symlinkSync(join(SST_WORK_DIR, "node_modules"), nodeModulesLink, "dir");
          info("Zod found, node_modules linked", true);
        }
      } else {
        const workPkgJson = join(WORK, "package.json");
        writeFileSync(
          workPkgJson,
          JSON.stringify(
            {
              name: "pulumi-sst",
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
          cwd: WORK,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        if (!userHasZod) {
          warn(`"npm install zod --save-dev" is recommended to avoid type errors.`);
        }
      }
      if (environmentVariables) {
        const p = join(WORK, "env-data.json");
        writeFileSync(p, JSON.stringify(environmentVariables, null, 2));
        tempFiles.push(p);
      }
      if (pulumiConfig) {
        const p = join(WORK, "config-data.json");
        writeFileSync(p, JSON.stringify(pulumiConfig, null, 2));
        tempFiles.push(p);
      }
      if (existsSync(envSchemaPath)) {
        const dest = join(WORK, "PulumiEscEnvironment.ts");
        copyFileSync(envSchemaPath, dest);
        tempFiles.push(dest);
      }
      if (existsSync(cfgSchemaPath)) {
        const dest = join(WORK, "PulumiEscConfig.ts");
        copyFileSync(cfgSchemaPath, dest);
        tempFiles.push(dest);
      }
      const harnessPath = join(WORK, "validate-esc.ts");
      writeFileSync(harnessPath, VALIDATE_HARNESS_SCRIPT);
      tempFiles.push(harnessPath);

      execSync("npx --yes tsx@4.21.0 validate-esc.ts", {
        cwd: WORK,
        encoding: "utf-8",
        stdio: "inherit",
      });

      info(`✓ ESC validation passed for ${escReference}`);
    } catch (e) {
      cliExecutionErrors = true;
      error(`ESC validation failed for ${escReference}`);
    } finally {
      if (!ephemeralPulumiDir) {
        for (const f of tempFiles) {
          if (existsSync(f)) unlinkSync(f);
        }
        const nodeModules = join(WORK, "node_modules");
        if (existsSync(nodeModules)) {
          rmSync(nodeModules, { recursive: true, force: true });
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
  process.env.AWS_CONFIG_FILE = "/dev/null";
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_DEFAULT_PROFILE;

  if (PULUMI_PROVIDERS) {
    if (!process.env.PULUMI_PROVIDERS) {
      process.env.PULUMI_PROVIDERS = PULUMI_PROVIDERS;
      info(`Set PULUMI_PROVIDERS=${process.env.PULUMI_PROVIDERS} from esc.`);
    } else {
      warn(`⚠ Overriding PULUMI_PROVIDERS from ${process.env.PULUMI_PROVIDERS} to ${PULUMI_PROVIDERS}`);
      process.env.PULUMI_PROVIDERS = PULUMI_PROVIDERS;
    }
  }
  if (STACK_REFERENCES) {
    if (!process.env.STACK_REFERENCES) {
      process.env.STACK_REFERENCES = STACK_REFERENCES;
      STACK_REFERENCES.split(",").forEach((ref: string) => {
        info(`Added Stack Reference: ${ref}`, true);
      });
    } else {
      warn(`⚠ Overriding STACK_REFERENCES from ${process.env.STACK_REFERENCES} to ${STACK_REFERENCES}`);
      process.env.STACK_REFERENCES = STACK_REFERENCES;
    }
  }
} catch (e) {
  error(`Failed to retrieve ESC environment variables for ${args[0]}: ${e}`);
}

const { PULUMI_STACK, PULUMI_PROVIDERS, GITHUB_ACTIONS } = process.env;

if (!PULUMI_STACK) {
  error("PULUMI_STACK is required but not set");
  process.exit(1);
}
if (!process.env.PULUMI_COMMAND) {
  error("PULUMI_COMMAND is required but not set");
  process.exit(1);
}

if (ephemeralPulumiDir) {
  if (!process.env.PULUMI_PROJECT) {
    error("PULUMI_PROJECT could not be inferred (no package.json name). Set PULUMI_PROJECT env var.");
    process.exit(1);
  }
  const programDescription = packageJson.description || "Pulumi program for " + process.env.PULUMI_PROJECT;
  // Generate minimal Pulumi.yaml for ephemeral workspace
  const minimalPulumiYaml = `name: ${process.env.PULUMI_PROJECT}
description: ${programDescription}
runtime:
  name: nodejs
  options:
    typescript: true
`;
  writeFileSync(join(process.env.PULUMI_WORK_DIR!, "Pulumi.yaml"), minimalPulumiYaml);
  const minimalPackageJson = JSON.stringify(
    {
      name: process.env.PULUMI_PROJECT,
      description: programDescription,
      version: "0.0.1",
      private: true,
      main: "index.ts",
    },
    null,
    2,
  );
  writeFileSync(join(process.env.PULUMI_WORK_DIR!, "package.json"), minimalPackageJson);
  hasPulumiYaml = true; // Now we have one
}

const COLOR_ENV = {
  FORCE_COLOR: "1",
  PULUMI_COLOR: "always",
  CLICOLOR_FORCE: "1",
};

const sanitizeAwsEnv = (baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const cleaned = { ...baseEnv };
  delete cleaned.AWS_PROFILE;
  delete cleaned.AWS_DEFAULT_PROFILE;
  cleaned.AWS_CONFIG_FILE = "/dev/null";
  return cleaned;
};

const runWithEnv = (shellCommand: string, extraEnv: Record<string, string>): void => {
  try {
    execSync(shellCommand, {
      encoding: "utf-8",
      stdio: "inherit",
      shell: "/bin/bash",
      env: { ...sanitizeAwsEnv(process.env), ...extraEnv, ...COLOR_ENV },
      cwd: SST_WORK_DIR,
    });
    info(`✓ SST completed successfully`, true);
  } catch (e) {
    error(`Failed to deploy SST: ${e}`);
    process.exit(1);
  }
};

const spawnWithEnv = (shellCommand: string, extraEnv: Record<string, string>): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", shellCommand], {
      stdio: "inherit",
      env: { ...sanitizeAwsEnv(process.env), ...extraEnv, ...COLOR_ENV },
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

const maskSecretsForGithubActions = (environment?: string): void => {
  if (GITHUB_ACTIONS !== "true") {
    return;
  }

  const sensitivePatterns = ["PRIVATE", "SECRET"];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && sensitivePatterns.some((pattern) => key.includes(pattern))) {
      console.log(`::add-mask::${value}`);
    }
  }

  if (environment) {
    const maskFilePath = join(process.env.PULUMI_WORK_DIR!, `.env.${environment}.mask.txt`);
    if (existsSync(maskFilePath)) {
      try {
        const maskContent = readFileSync(maskFilePath, "utf-8");
        const secrets = maskContent.split("\n").filter((line) => line.trim().length > 0);
        for (const secret of secrets) {
          console.log(`::add-mask::${secret}`);
        }
        info(`✓ Masked ${secrets.length} secrets`, true);
      } catch (e) {
        error(`Failed to process mask file ${maskFilePath}: ${e}`);
      } finally {
        unlinkSync(maskFilePath);
        warn(`Unlinked ${maskFilePath}`);
      }
    }
  }
};

(async () => {
  try {
    maskSecretsForGithubActions(); // Initial mask for env vars (must do twice)
    const commandMode = getInfraCommandMode(process.env.PULUMI_COMMAND!);

    const needsPulumiUp = commandMode === "deploy";
    const needsPulumiRefresh = commandMode === "refresh";
    const needsPulumiDestroy = commandMode === "destroy";
    const isDevMode = commandMode === "dev";

    const sstCommandMap: Record<InfraCommands, string | null> = {
      deploy: "deploy",
      preview: "diff",
      dev: "dev",
      refresh: "refresh",
      destroy: "remove", // SST uses 'remove' not 'destroy'
      bash: "bash",
    };

    const sstCommand = sstCommandMap[commandMode];

    info(`Starting ${commandMode} (SST: ${sstCommand}) for ${PULUMI_STACK}`);

    if (!process.env.PULUMI_PROJECT && hasPulumiYaml) {
      const pulumiYamlPath = join(process.env.PULUMI_WORK_DIR!, "Pulumi.yaml");
      try {
        // TODO - check dependency versions in package.json in CWD and fire off warnings if incompatible. Sometimes, hard exit.
        // TODO - add npx 'template init' (copies from repos and renames) for svc- and app-
        const pulumiYamlContent = readFileSync(pulumiYamlPath, "utf-8");
        const pulumiConfig = load(pulumiYamlContent) as Record<string, any>;
        if (pulumiConfig.name) {
          process.env.PULUMI_PROJECT = pulumiConfig.name;
          info(`Inferred PULUMI_PROJECT="${pulumiConfig.name}" from Pulumi.yaml`, true);
        } else {
          error(`Pulumi.yaml does not contain a "name" field: ${pulumiYamlPath}`);
          process.exit(1);
        }
      } catch (e) {
        error(`Failed to read Pulumi.yaml at ${pulumiYamlPath}: ${e}`);
        process.exit(1);
      }
    } else if (!process.env.PULUMI_PROJECT) {
      error("PULUMI_PROJECT is required but not set");
      process.exit(1);
    }

    info(`Working directory: ${process.env.PULUMI_WORK_DIR}`);

    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "pulumi-template.ts"), join(process.env.PULUMI_WORK_DIR!, "index.ts"));

    const PULUMI_WORK_DIR = process.env.PULUMI_WORK_DIR!;
    const nodeModulesTarget = join(SST_WORK_DIR, "node_modules");
    const nodeModulesLink = join(PULUMI_WORK_DIR, "node_modules");

    if (ephemeralPulumiDir && !existsSync(nodeModulesLink)) {
      symlinkSync(nodeModulesTarget, nodeModulesLink, "dir");
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

    await stack.preview({
      color: "always",
      onOutput: (msg: string) => process.stdout.write(msg),
    });

    maskSecretsForGithubActions(PULUMI_STACK);
    const envJsonPath = join(PULUMI_WORK_DIR, `.env.${PULUMI_STACK}.env.json`);

    const {
      PULUMI_ACCESS_TOKEN: HOST_PULUMI_ACCESS_TOKEN,
      PULUMI_BACKEND_URL: HOST_PULUMI_BACKEND_URL,
      PULUMI_ORG: HOST_PULUMI_ORG,
      PULUMI_ORGANIZATION: HOST_PULUMI_ORGANIZATION,
      HOME: HOST_HOME,
      PATH: HOST_PATH,
      USER: HOST_USER,
    } = process.env;

    let envFromPulumi: Record<string, string> = {};

    if (existsSync(envJsonPath)) {
      try {
        const envJson = readFileSync(envJsonPath, "utf-8");
        envFromPulumi = {
          ...JSON.parse(envJson),
          ...{
            HOST_PULUMI_ACCESS_TOKEN,
            HOST_PULUMI_BACKEND_URL,
            HOST_PULUMI_ORG,
            HOST_PULUMI_ORGANIZATION,
            HOST_HOME,
            HOST_PATH,
            HOST_USER,
          },
        };
        info(`✓ Loaded environment`, true);
      } catch (e) {
        error(`Failed to load environment from ${envJsonPath}: ${e}`);
      } finally {
        unlinkSync(envJsonPath);
        warn(`Unlinked ${envJsonPath}`);
      }
    } else {
      warn(`⚠ Environment file not found: ${envJsonPath}`);
    }

    if (process.env.CLI_COMMAND_MODE === "bash") {
      const nvmScript = join(HOST_HOME || process.env.HOME || "", ".nvm", "nvm.sh");
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

      if (isZsh) {
        writeFileSync(
          join(PULUMI_WORK_DIR, ".zshrc"),
          [`export NVM_DIR="$HOME/.nvm"`, `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`].join("\n"),
        );
        await spawnWithEnv(userShell, { ...envFromPulumi, ZDOTDIR: PULUMI_WORK_DIR });
        if (existsSync(join(PULUMI_WORK_DIR, ".zshrc"))) unlinkSync(join(PULUMI_WORK_DIR, ".zshrc"));
      } else {
        const tmpInitPath = join(PULUMI_WORK_DIR, "bash-init.sh");
        writeFileSync(
          tmpInitPath,
          [
            `export BASH_SILENCE_DEPRECATION_WARNING=1`,
            `export NVM_DIR="$HOME/.nvm"`,
            `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`,
          ].join("\n"),
        );
        await spawnWithEnv(`bash --init-file "${tmpInitPath}"`, envFromPulumi);
        if (existsSync(tmpInitPath)) unlinkSync(tmpInitPath);
      }
      return; // skip the normal SST/Pulumi flow
    }

    if (isDevMode) {
      await spawnWithEnv(`npx sst dev --stage ${PULUMI_STACK}`, envFromPulumi);
    } else if (needsPulumiRefresh) {
      // First refresh SST state, then Pulumi state
      runWithEnv(`npx sst refresh --stage ${PULUMI_STACK}`, envFromPulumi);
      await stack.refresh({
        color: "always",
        onOutput: (msg: string) => process.stdout.write(msg),
      });
    } else if (needsPulumiDestroy) {
      // Run SST remove first, then Pulumi destroy
      runWithEnv(`npx sst remove --stage ${PULUMI_STACK}`, envFromPulumi);
      await stack.destroy({
        color: "always",
        onOutput: (msg: string) => process.stdout.write(msg),
      });
    } else {
      // deploy or preview
      runWithEnv(`npx sst ${sstCommand} --stage ${PULUMI_STACK}`, envFromPulumi);

      if (needsPulumiUp) {
        await stack.up({
          color: "always",
          onOutput: (msg: string) => process.stdout.write(msg),
        });
      }
    }
    const outputPath = join(PULUMI_WORK_DIR, `.env.${PULUMI_STACK}.out.json`);
    if (existsSync(outputPath)) {
      unlinkSync(outputPath);
      warn(`Unlinked ${outputPath}`);
    }
    info(`✓ Finished ${commandMode} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
  } catch (e) {
    error(`Error during SST execution: ${e}`);
    process.exitCode = 1;
  } finally {
    cleanup();
  }
  function cleanup(): void {
    const PULUMI_WORK_DIR = process.env.PULUMI_WORK_DIR;
    if (!PULUMI_WORK_DIR) return;

    if (ephemeralPulumiDir) {
      try {
        rmSync(PULUMI_WORK_DIR, { recursive: true, force: true });
        info(`✓ Cleaned up ${PULUMI_WORK_DIR}`, true);
      } catch (e) {
        warn(`⚠ Failed to clean up Pulumi work dir: ${e}`);
      }
    } else {
      // Clean up individual temp files if not ephemeral
      const tempFiles = [
        `.env.${PULUMI_STACK}.env.json`,
        `.env.${PULUMI_STACK}.cfg.json`,
        `.env.${PULUMI_STACK}.mask.txt`,
        `.env.${PULUMI_STACK}.out.json`,
        `.env.${PULUMI_STACK}.refs.json`,
      ];

      for (const file of tempFiles) {
        const fullPath = join(PULUMI_WORK_DIR, file);
        if (existsSync(fullPath)) {
          try {
            unlinkSync(fullPath);
            warn(`Cleaned up ${file}`);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
  }
})();
