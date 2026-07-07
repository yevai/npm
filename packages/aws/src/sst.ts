import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

let DEFAULT_HOST_PULUMI_ORG = "";
let DEFAULT_PROJECT_NAMESPACE = "";

/**
 * Executes a shell command using the Pulumi CLI with the appropriate environment context.
 *
 * This helper ensures that Pulumi commands are run with the correct environment variables
 * (tokens, backend URLs, organization settings) propagated from the host environment.
 * It handles the differences between running in a local development environment versus
 * a test environment (Vitest).
 *
 * @param command - The shell command to execute (e.g., "pulumi stack output ...")
 * @returns The trimmed string output from stdout.
 * @example
 * ```typescript
 *     const stackId = `${this.organization}/${this.name}`;
 *
 *  if (CloudStackReferenceV2.stackCache.has(stackId)) {
 *    this.outputs = CloudStackReferenceV2.stackCache.get(stackId);
 *  } else {
 *    this.outputs = JSON.parse(
 *      pulumiCloudExecSyncShell(`pulumi stack output --stack ${stackId} --json --show-secrets`)
 *    );
 *    CloudStackReferenceV2.stackCache.set(stackId, this.outputs);
 *  }
 *```
 * @throws {Error} If the command execution fails or times out.
 */
export const pulumiCloudExecSyncShell = (command: string): string => {
  return execSync(command, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    cwd: process.env.VITEST ? undefined : process.env.PULUMI_WORK_DIR,
    env: process.env.VITEST
      ? process.env
      : {
          PULUMI_ACCESS_TOKEN: process.env.HOST_PULUMI_ACCESS_TOKEN,
          PULUMI_BACKEND_URL: process.env.HOST_PULUMI_BACKEND_URL,
          PULUMI_ORG: process.env.HOST_PULUMI_ORG,
          PULUMI_ORGANIZATION: process.env.HOST_PULUMI_ORGANIZATION,
          HOME: process.env.HOST_HOME,
          PATH: process.env.HOST_PATH,
          USER: process.env.HOST_USER,
        },
  }).trim();
};

const getEffectivePulumiOrganization = () => {
  if (DEFAULT_HOST_PULUMI_ORG) {
    return DEFAULT_HOST_PULUMI_ORG;
  }

  const envOrg = process.env.PULUMI_ORG ?? process.env.PULUMI_ORGANIZATION;

  if (envOrg) {
    DEFAULT_HOST_PULUMI_ORG = envOrg;
    return envOrg;
  }

  const hostOrg = process.env.HOST_PULUMI_ORG ?? process.env.HOST_PULUMI_ORGANIZATION;

  if (hostOrg) {
    DEFAULT_HOST_PULUMI_ORG = hostOrg;
    return hostOrg;
  }

  try {
    const result = pulumiCloudExecSyncShell("pulumi org get-default");
    if (result) {
      DEFAULT_HOST_PULUMI_ORG = result;
      return DEFAULT_HOST_PULUMI_ORG;
    }
  } catch (e) {
    throw new Error(`Failed to get Pulumi host context: ${e}`);
  }

  return "";
};

const getProjectNamespace = (): string => {
  if (DEFAULT_PROJECT_NAMESPACE) {
    return DEFAULT_PROJECT_NAMESPACE;
  }

  const { PULUMI_PROJECT, SST_WORK_DIR } = process.env;

  if (PULUMI_PROJECT) {
    DEFAULT_PROJECT_NAMESPACE = PULUMI_PROJECT;
    return PULUMI_PROJECT;
  }

  const pkgPath = join(SST_WORK_DIR ?? process.cwd(), "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.name) {
        DEFAULT_PROJECT_NAMESPACE = pkg.name;
        return pkg.name;
      }
    } catch {
      // Fall through
    }
  }

  throw new Error("PULUMI_PROJECT not set and could not read name from package.json");
};

const getStage = (stageArg?: string): string => {
  const stage = stageArg ?? process.env.PULUMI_STACK;
  if (!stage) {
    throw new Error("Stage must be provided as argument or via PULUMI_STACK env var");
  }
  return stage;
};

/**
 * CloudConfigV2 - Enhanced Pulumi Config API for SST
 *
 * Provides typed access to Pulumi ESC configuration and secrets within SST applications.
 * Unlike the original CloudConfig, this version directly queries Pulumi Environments
 * using the CLI, ensuring access to the most up-to-date configuration values.
 *
 * It handles caching of configuration outputs to minimize CLI execution overhead.
 *
 * @example
 * ```typescript
 * const config = new CloudConfigV2();
 *
 * // Optional values
 * const logLevel = config.get("logLevel") ?? "info";
 *
 * // Required values (throws if missing)
 * const apiKey = config.require("apiKey");
 *
 * // Typed values
 * const port = config.requireNumber("port");
 * const debug = config.getBoolean("debug") ?? false;
 * const settings = config.requireObject<Settings>("settings");
 * ```
 */
export class CloudConfigV2 {
  private static configCache = new Map<string, Record<string, unknown>>();
  private config: Record<string, unknown>;
  readonly organization: string;
  readonly project: string;
  readonly stage: string;

  constructor() {
    const { VITEST, PULUMI_WORK_DIR } = process.env;

    if (!VITEST && !PULUMI_WORK_DIR) {
      throw new Error("PULUMI_WORK_DIR environment variable is required");
    }

    this.organization = getEffectivePulumiOrganization();
    if (!this.organization) {
      throw new Error("Could not determine Pulumi organization for CloudConfig");
    }

    this.stage = getStage();
    this.project = getProjectNamespace();

    const escPath = `${this.organization}/${this.project}/${this.stage}`;

    if (CloudConfigV2.configCache.has(escPath)) {
      this.config = CloudConfigV2.configCache.get(escPath)!;
    } else {
      this.config = JSON.parse(pulumiCloudExecSyncShell(`pulumi esc get ${escPath} --show-secrets --value json`)).pulumiConfig ?? {};
      CloudConfigV2.configCache.set(escPath, this.config);
    }
  }

  private getValue(key: string): unknown {
    return this.config[key];
  }

  get(key: string): string | undefined {
    const value = this.getValue(key);
    return value !== undefined ? String(value) : undefined;
  }

  require(key: string): string {
    const value = this.get(key);
    if (value === undefined) throw new Error(`Missing required config '${key}'`);
    return value;
  }

  getBoolean(key: string): boolean | undefined {
    const v = this.getValue(key);
    if (v === undefined) return undefined;
    return typeof v === "boolean" ? v : String(v).toLowerCase() === "true";
  }

  requireBoolean(key: string): boolean {
    const v = this.getBoolean(key);
    if (v === undefined) throw new Error(`Missing required config '${key}'`);
    return v;
  }

  getNumber(key: string): number | undefined {
    const v = this.getValue(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }

  requireNumber(key: string): number {
    const v = this.getNumber(key);
    if (v === undefined) throw new Error(`Missing required config '${key}'`);
    return v;
  }

  getObject<T>(key: string): T | undefined {
    const v = this.getValue(key);
    if (v === undefined) return undefined;
    if (typeof v === "string") {
      try {
        return JSON.parse(v) as T;
      } catch {
        return undefined;
      }
    }
    return v as T;
  }

  requireObject<T>(key: string): T {
    const v = this.getObject<T>(key);
    if (v === undefined) throw new Error(`Missing required config '${key}'`);
    return v;
  }
}

/**
 * CloudStackReferenceV2 - Enhanced Stack Reference for SST
 *
 * Provides typed access to outputs from other Pulumi stacks within SST applications.
 * Unlike the original CloudStackReference, this version directly queries the Pulumi
 * Cloud backend using the CLI, ensuring access to the most up-to-date stack outputs.
 *
 * It handles caching of stack outputs to minimize CLI calls and supports resolution
 * of stack names across organizations and stages.
 *
 * @example
 * ```typescript
 * // Reference a stack in the same project, inferring stage
 * const appStack = new CloudStackReferenceV2("my-app");
 *
 * // Reference a stack with explicit stage
 * const dbStack = new CloudStackReferenceV2("database", { stage: "prod" });
 *
 * // Reference a fully qualified stack name
 * const authStack = new CloudStackReferenceV2("my-org/auth-service/dev");
 *
 * // Access outputs
 * const apiUrl = appStack.requireOutput<string>("apiUrl");
 * const dbConfig = dbStack.getOutput<DbConfig>("config");
 * ```
 */
export class CloudStackReferenceV2 {
  private static stackCache = new Map<string, any>();
  readonly organization: string;
  readonly stage: string;
  readonly name: string;
  readonly outputs: any;

  /**
   * Creates a new CloudStackReferenceV2 instance.
   *
   * @param name - The name of the stack to reference. Can be a short name (e.g., "my-stack")
   *               or a fully qualified name (e.g., "org/project/stage").
   * @param options - Configuration options for the reference.
   * @param options.stage - The stage to target. Required if using a short stack name, unless
   *                        implied by the current environment (e.g., PULUMI_STACK).
   * @throws {Error} If the Pulumi organization cannot be determined or if required arguments are missing.
   */
  constructor(name: string, { stage }: { stage?: string } = {}) {
    const { VITEST, PULUMI_WORK_DIR } = process.env;

    if (!VITEST && !PULUMI_WORK_DIR) {
      throw new Error("PULUMI_WORK_DIR environment variable is required");
    }

    this.organization = getEffectivePulumiOrganization();

    if (!this.organization) {
      throw new Error("Could not determine Pulumi organization for StackReference");
    } else if (!name.includes("/") && !stage) {
      throw new Error("Stage must be provided as argument or via PULUMI_STACK env var when using short stack name");
    }
    this.stage = getStage(stage);
    this.name = name.includes("/") ? name : `${name}/${this.stage}`;

    const stackId = `${this.organization}/${this.name}`;

    if (CloudStackReferenceV2.stackCache.has(stackId)) {
      this.outputs = CloudStackReferenceV2.stackCache.get(stackId);
    } else {
      this.outputs = JSON.parse(pulumiCloudExecSyncShell(`pulumi stack output --stack ${stackId} --json --show-secrets`));
      CloudStackReferenceV2.stackCache.set(stackId, this.outputs);
    }
  }

  /**
   * Retrieves an output value from the referenced stack.
   *
   * @param key - The name of the output to retrieve.
   * @returns The output value typed as T, or undefined if the output does not exist.
   * @template T - The expected type of the output value. Defaults to `any`.
   */
  getOutput<T = any>(key: string): T | undefined {
    return this.outputs[key] as T | undefined;
  }

  /**
   * Retrieves a required output value from the referenced stack.
   *
   * @param key - The name of the output to retrieve.
   * @returns The output value typed as T.
   * @throws {Error} If the output with the specified key does not exist.
   * @template T - The expected type of the output value. Defaults to `any`.
   */
  requireOutput<T = any>(key: string): T {
    const v = this.getOutput<T>(key);
    if (v === undefined) throw new Error(`Missing required output '${key}' from stack '${this.name}'`);
    return v;
  }
}
