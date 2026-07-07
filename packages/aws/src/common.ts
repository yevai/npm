/**
 * Cross-command helpers shared by every yaws command.
 *
 * Everything here applies to ALL commands: logging, env handling, working-directory
 * context resolution, Pulumi ESC access, and child-process spawning. Command-specific
 * flows live in runner.ts (and eventually in per-command modules).
 */
import { execSync, spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  orange: "\x1b[38;5;208m",
} as const;

export const info = (message: string, secondary = false): void => {
  console.log(`${secondary ? COLORS.green : COLORS.cyan}${message}${COLORS.reset}`);
};

export const warn = (message: string): void => {
  console.warn(`${COLORS.yellow}${message}${COLORS.reset}`);
};

export const alert = (message: string): void => {
  console.warn(`${COLORS.orange}${message}${COLORS.reset}`);
};

export const error = (message: string): void => {
  console.error(`${COLORS.red}${message}${COLORS.reset}`);
};

export const setEnv = (key: string, value: string, source: string): void => {
  const current = process.env[key];
  if (current === undefined) {
    info(`Set ${key}=${value} from ${source}.`);
  } else if (current !== value) {
    warn(`⚠ Overriding ${key} from ${current} to ${value}`);
  }
  process.env[key] = value;
};

export const sanitizeAwsEnv = (baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const cleaned = { ...baseEnv };
  delete cleaned.AWS_PROFILE;
  delete cleaned.AWS_DEFAULT_PROFILE;
  cleaned.AWS_CONFIG_FILE = "/dev/null";
  return cleaned;
};

export const COLOR_ENV = {
  FORCE_COLOR: "1",
  PULUMI_COLOR: "always",
  CLICOLOR_FORCE: "1",
};

/**
 * Build a child-process env from `process.env` plus `extraEnv`, sanitizing the
 * merged result so AWS profile vars from extraEnv (e.g. a restored env snapshot)
 * are also stripped.
 */
export const buildEnv = (extraEnv: Record<string, string>): NodeJS.ProcessEnv =>
  sanitizeAwsEnv({
    ...process.env,
    ...extraEnv,
    ...COLOR_ENV,
  });

export interface PackageJson {
  name: string;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Resolved working directories, project metadata, and ESC reference for a CLI run. */
export interface CliContext {
  sstWorkDir: string;
  sstConfigPath: string;
  packageJson: PackageJson;
  allDependencies: string[];
  pulumiWorkDir: string;
  ephemeralPulumiDir: boolean;
  escParts: string[];
  escReference: string;
}

const fatal = (message: string): never => {
  error(message);
  process.exit(1);
};

const resolveSstWorkDir = (): { sstWorkDir: string; sstConfigPath: string } => {
  if (!process.env.SST_WORK_DIR) {
    process.env.SST_WORK_DIR = process.cwd();
    console.warn(`SST_WORK_DIR defaulting to ${process.env.SST_WORK_DIR}`);
  }
  const sstWorkDir = process.env.SST_WORK_DIR!;
  const sstConfigPath = join(sstWorkDir, "sst.config.ts");

  if (!existsSync(sstConfigPath)) {
    fatal(`sst.config.ts not found in SST_WORK_DIR: ${sstWorkDir}`);
  }
  return { sstWorkDir, sstConfigPath };
};

const loadProjectPackageJson = (sstWorkDir: string): PackageJson => {
  const packageJsonPath = join(sstWorkDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    fatal(`package.json not found in SST_WORK_DIR: ${sstWorkDir}`);
  }

  const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  if (!packageJson.name) {
    fatal(`package.json does not contain the required field "name"`);
  }
  return packageJson;
};

const resolvePulumiWorkDir = (): { pulumiWorkDir: string; ephemeralPulumiDir: boolean } => {
  if (!process.env.PULUMI_WORK_DIR) {
    process.env.PULUMI_WORK_DIR = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "pulumi-"));
    return { pulumiWorkDir: process.env.PULUMI_WORK_DIR, ephemeralPulumiDir: true };
  }
  if (!existsSync(join(process.env.PULUMI_WORK_DIR, "Pulumi.yaml"))) {
    fatal(`Fatal: Pulumi.yaml not found in PULUMI_WORK_DIR: ${process.env.PULUMI_WORK_DIR}`);
  }
  return { pulumiWorkDir: process.env.PULUMI_WORK_DIR!, ephemeralPulumiDir: false };
};

const resolveEscParts = (): string[] =>
  [process.env.PULUMI_ORG ?? process.env.PULUMI_ORGANIZATION, process.env.PULUMI_PROJECT, process.env.PULUMI_STACK].filter(
    Boolean,
  ) as string[];

/**
 * Resolve and validate the CLI context. Call this AFTER the target env vars
 * (PULUMI_ORGANIZATION / PULUMI_PROJECT / PULUMI_STACK) have been applied.
 * Exits the process on fatal misconfiguration.
 */
export const initContext = (): CliContext => {
  const { sstWorkDir, sstConfigPath } = resolveSstWorkDir();
  const packageJson = loadProjectPackageJson(sstWorkDir);

  process.env.PULUMI_PROJECT ??= packageJson.name;

  const { pulumiWorkDir, ephemeralPulumiDir } = resolvePulumiWorkDir();
  const escParts = resolveEscParts();

  return {
    sstWorkDir,
    sstConfigPath,
    packageJson,
    allDependencies: Object.keys(packageJson.dependencies ?? {}).concat(Object.keys(packageJson.devDependencies ?? {})),
    pulumiWorkDir,
    ephemeralPulumiDir,
    escParts,
    escReference: escParts.join("/"),
  };
};

/** Remove the Pulumi work dir when it was created ephemerally; no-op otherwise. */
export const cleanupEphemeralWorkDir = (ctx: CliContext): void => {
  if (!ctx.ephemeralPulumiDir) return;
  try {
    rmSync(ctx.pulumiWorkDir, { recursive: true, force: true });
    info(`✓ Cleaned up ${ctx.pulumiWorkDir}`, true);
  } catch (e) {
    warn(`⚠ Failed to clean up Pulumi work dir: ${e}`);
  }
};

/** Resolved values of a Pulumi ESC environment. */
export interface EscValues {
  environmentVariables?: Record<string, string>;
  pulumiConfig?: Record<string, unknown>;
}

/** Fetch the resolved ESC environment for the context's reference. Throws on failure. */
export const fetchEscValues = (ctx: CliContext): EscValues =>
  JSON.parse(
    execSync(`pulumi esc get ${ctx.escReference} --value json --show-secrets`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );

/**
 * Merge ESC environmentVariables into process.env, handling PULUMI_PROVIDERS and
 * STACK_REFERENCES specially. Target identity vars (PULUMI_STACK, PULUMI_COMMAND,
 * PULUMI_PROJECT, PULUMI_ORG*) are never adopted from ESC.
 */
export const applyEscEnvironment = (values: EscValues): void => {
  const { PULUMI_PROVIDERS, STACK_REFERENCES, PULUMI_STACK, PULUMI_COMMAND, PULUMI_PROJECT, PULUMI_ORGANIZATION, PULUMI_ORG, ...otherEnv } =
    values.environmentVariables ?? {};
  (void PULUMI_STACK, PULUMI_COMMAND, PULUMI_PROJECT, PULUMI_ORGANIZATION, PULUMI_ORG);

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
};

/** Resolve the environmentVariables of each ESC provider environment directly. */
export const resolveProviderEnvVars = (organization: string | undefined, providers: string[]): Record<string, string> => {
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

/** Spawn a bash shell command with inherited stdio and a sanitized, color-forced env. */
export const spawnWithEnv = (shellCommand: string, extraEnv: Record<string, string>, cwd: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", shellCommand], {
      stdio: "inherit",
      env: buildEnv(extraEnv),
      cwd,
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

export const runSstWithEnv = async (shellCommand: string, extraEnv: Record<string, string>, cwd: string): Promise<void> => {
  try {
    await spawnWithEnv(shellCommand, extraEnv, cwd);
    info(`✓ SST completed successfully`, true);
  } catch (e) {
    throw new Error(`Failed to run SST: ${e}`);
  }
};

/** Mask env var values whose keys look sensitive when running in GitHub Actions. */
export const maskSecretsForGithubActions = (): void => {
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
export const extractStringValues = (obj: unknown): string[] => {
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

/** Extract maskable strings from a secret config value, expanding embedded JSON when possible. */
const extractSecretValues = (value: string): string[] => {
  const looksLikeJson = value.startsWith("{") || value.startsWith("[");
  if (looksLikeJson) {
    try {
      return extractStringValues(JSON.parse(value));
    } catch {
      return extractStringValues(value);
    }
  }
  return extractStringValues(value);
};

/** Collect the unique maskable strings across all secret config entries. */
const collectSecretConfigValues = (allConfig: Record<string, { value: string; secret?: boolean }>): Set<string> => {
  const secretValues = new Set<string>();
  for (const { value, secret } of Object.values(allConfig)) {
    if (!secret || !value) continue;
    extractSecretValues(value).forEach((v) => secretValues.add(v));
  }
  return secretValues;
};

/** Mask secret stack config values directly from the Automation API. */
export const maskStackSecretsForGithubActions = async (stack: {
  getAllConfig(): Promise<Record<string, { value: string; secret?: boolean }>>;
}): Promise<void> => {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return;
  }

  try {
    const secretValues = collectSecretConfigValues(await stack.getAllConfig());
    for (const secret of secretValues) {
      console.log(`::add-mask::${secret}`);
    }
    info(`✓ Masked ${secretValues.size} secrets`, true);
  } catch (e) {
    error(`Failed to mask stack config secrets: ${e}`);
  }
};
