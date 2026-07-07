/**
 * Command execution flows for yaws.
 *
 * cli.ts is a thin commander shim; the actual work happens here using the
 * cross-command helpers from common.ts. ESC type extraction, generation, and
 * validation live in escReflector.ts.
 */
import { copyFileSync, existsSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { Stack } from "@pulumi/pulumi/automation";

import {
  alert,
  applyEscEnvironment,
  cleanupEphemeralWorkDir,
  error,
  fetchEscValues,
  info,
  initContext,
  maskSecretsForGithubActions,
  maskStackSecretsForGithubActions,
  resolveProviderEnvVars,
  runSstWithEnv,
  sanitizeAwsEnv,
  spawnWithEnv,
  warn,
} from "./common.js";
import type { CliContext, EscValues } from "./common.js";
import { runGenerate, runValidate } from "./escReflector.js";
import type { DxCommands, InfraCommands } from "./shared.js";

/** SST subcommand for each infra command (SST uses 'remove' and 'diff'). */
const SST_COMMAND_MAP: Record<InfraCommands, string> = {
  deploy: "deploy",
  preview: "diff",
  dev: "dev",
  refresh: "refresh",
  destroy: "remove",
  unlock: "unlock",
  bash: "bash",
};

const STREAM_OPTS = {
  color: "always",
  onOutput: (msg: string) => process.stdout.write(msg),
} as const;

/** Everything an infra command executor needs. */
interface InfraRun {
  ctx: CliContext;
  stack: Stack;
  stackName: string;
  sstCommand: string;
  envFromPulumi: Record<string, string>;
}

/** Run a DX command (generate/validate). Exits the process when done. */
export const runDx = async (command: DxCommands): Promise<void> => {
  if (command === "bash") {
    // "bash" is both a CLI and infra command; the infra flow owns it
    return runInfra("bash");
  }
  const ctx = initContext();

  let escValues: EscValues;
  try {
    escValues = fetchEscValues(ctx);
  } catch (e) {
    error(`Failed to retrieve ESC environment variables for ${ctx.escReference}: ${e}`);
    cleanupEphemeralWorkDir(ctx);
    process.exit(1);
  }

  if (command === "generate") {
    runGenerate(ctx, escValues);
  } else {
    runValidate(ctx, escValues);
  }
};

/** Generate minimal Pulumi.yaml and package.json for an ephemeral workspace. */
const writeEphemeralWorkspaceFiles = (ctx: CliContext): void => {
  if (!ctx.ephemeralPulumiDir) return;

  const programDescription = ctx.packageJson.description || "Pulumi program for " + process.env.PULUMI_PROJECT;
  const minimalPulumiYaml = `name: ${process.env.PULUMI_PROJECT}
description: ${programDescription}
runtime:
  name: nodejs
  options:
    typescript: true
`;
  writeFileSync(join(ctx.pulumiWorkDir, "Pulumi.yaml"), minimalPulumiYaml);
  writeFileSync(
    join(ctx.pulumiWorkDir, "package.json"),
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
};

/** Copy the Pulumi program template and link node_modules into the work dir. */
const prepareWorkDir = (ctx: CliContext): void => {
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "pulumi-template.ts"), join(ctx.pulumiWorkDir, "index.ts"));

  const nodeModulesLink = join(ctx.pulumiWorkDir, "node_modules");
  if (ctx.ephemeralPulumiDir && !existsSync(nodeModulesLink)) {
    symlinkSync(join(ctx.sstWorkDir, "node_modules"), nodeModulesLink, "dir");
    info(`✓ Symlinked node_modules from ${ctx.sstWorkDir}`, true);
  }
};

/** Select the stack via the Automation API and attach the provider ESC environments. */
const openStack = async (ctx: CliContext, stackName: string, providers: string[]): Promise<Stack> => {
  // Use explicit index.js for ESM compatibility
  const { LocalWorkspace } = await import("@pulumi/pulumi/automation/index.js");

  const stack = await LocalWorkspace.createOrSelectStack(
    {
      stackName,
      workDir: ctx.pulumiWorkDir,
    },
    {
      envVars: {
        ...(process.env as Record<string, string>),
      },
    },
  );

  if (providers.length > 0) {
    providers.forEach((provider) => info(`Added ESC Environment: ${provider}`, true));
    await stack.addEnvironments(...providers);
  } else {
    alert("Environment variable PULUMI_PROVIDERS is not set. This is likely unintended.");
  }

  return stack;
};

/** Build the child-process env: provider ESC env vars plus HOST_*-prefixed host credentials. */
const buildRunEnv = (providers: string[]): Record<string, string> => {
  const {
    PULUMI_ACCESS_TOKEN: HOST_PULUMI_ACCESS_TOKEN,
    PULUMI_BACKEND_URL: HOST_PULUMI_BACKEND_URL,
    PULUMI_ORG: HOST_PULUMI_ORG,
    PULUMI_ORGANIZATION: HOST_PULUMI_ORGANIZATION,
    HOME: HOST_HOME,
    PATH: HOST_PATH,
    USER: HOST_USER,
  } = process.env;

  const hostEnv = {
    HOST_PULUMI_ACCESS_TOKEN,
    HOST_PULUMI_BACKEND_URL,
    HOST_PULUMI_ORG,
    HOST_PULUMI_ORGANIZATION,
    HOST_HOME,
    HOST_PATH,
    HOST_USER,
  };

  // Resolve provider ESC env vars directly instead of snapshotting them from inside the preview run
  return {
    ...resolveProviderEnvVars(HOST_PULUMI_ORG ?? HOST_PULUMI_ORGANIZATION, providers),
    ...(Object.fromEntries(Object.entries(hostEnv).filter(([, v]) => v !== undefined)) as Record<string, string>),
  };
};

/** Drop into an interactive shell wired to the target stack's environment. */
const runBashSession = async ({ ctx, stackName, envFromPulumi }: InfraRun): Promise<void> => {
  const hostHome = envFromPulumi.HOST_HOME || "";
  const nvmScript = join(hostHome, ".nvm", "nvm.sh");
  if (!existsSync(nvmScript)) {
    error(`NVM is required but was not found at ${nvmScript}.`);
    process.exit(1);
  }

  const isZsh = (process.env.SHELL || "bash").endsWith("zsh");
  const userShell = isZsh ? "zsh" : "bash";

  info(`Dropping into AWS state linked shell (${userShell}) for ${stackName}`);
  info(`Helpful tips below. If you're here, good luck!`);
  warn(` npx sst state export --stage ${stackName}        [Export stack state]`);
  warn(` npx sst unlock --stage ${stackName}              [Unlock deployment]`);
  warn(` npx sst state remove <urn> --stage ${stackName}  [Remove resource]`);
  warn(` npx sst state edit --stage ${stackName}          [Interactive editor]`);

  const nvmInitLines = [`export NVM_DIR="$HOME/.nvm"`, `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`];

  if (isZsh) {
    const zshrcPath = join(ctx.pulumiWorkDir, ".zshrc");
    writeFileSync(zshrcPath, nvmInitLines.join("\n"));
    await spawnWithEnv(userShell, { ...envFromPulumi, ZDOTDIR: ctx.pulumiWorkDir }, ctx.sstWorkDir);
    if (existsSync(zshrcPath)) unlinkSync(zshrcPath);
  } else {
    const tmpInitPath = join(ctx.pulumiWorkDir, "bash-init.sh");
    writeFileSync(tmpInitPath, [`export BASH_SILENCE_DEPRECATION_WARNING=1`, ...nvmInitLines].join("\n"));
    await spawnWithEnv(`bash --init-file "${tmpInitPath}"`, envFromPulumi, ctx.sstWorkDir);
    if (existsSync(tmpInitPath)) unlinkSync(tmpInitPath);
  }
};

/** Run the SST side of a command in SST_WORK_DIR. */
const runSst = ({ ctx, stackName, envFromPulumi }: InfraRun, sstCommand: string): Promise<void> =>
  runSstWithEnv(`npx sst ${sstCommand} --stage ${stackName}`, envFromPulumi, ctx.sstWorkDir);

/** One executor per infra command; SST always runs first, Pulumi second. */
const INFRA_EXECUTORS: Record<InfraCommands, (run: InfraRun) => Promise<void>> = {
  bash: runBashSession,
  dev: async ({ ctx, stackName, envFromPulumi }) => {
    await spawnWithEnv(`npx sst dev --stage ${stackName}`, envFromPulumi, ctx.sstWorkDir);
  },
  unlock: async (run) => {
    // First unlock SST state, then cancel any in-flight Pulumi operation (releases the lock)
    await runSst(run, "unlock");
    await run.stack.cancel();
    info(`✓ Cancelled pending Pulumi operations for ${run.stackName}`, true);
  },
  refresh: async (run) => {
    await runSst(run, "refresh");
    await run.stack.refresh(STREAM_OPTS);
  },
  destroy: async (run) => {
    await runSst(run, "remove");
    await run.stack.destroy(STREAM_OPTS);
  },
  preview: async (run) => {
    await runSst(run, "diff");
  },
  deploy: async (run) => {
    await runSst(run, "deploy");
    await run.stack.up(STREAM_OPTS);
  },
};

/** Run an infra command (deploy/preview/dev/refresh/destroy/unlock/bash). */
export const runInfra = async (commandMode: InfraCommands): Promise<void> => {
  const ctx = initContext();

  try {
    applyEscEnvironment(fetchEscValues(ctx));
  } catch (e) {
    error(`Failed to retrieve ESC environment variables for ${ctx.escReference}: ${e}`);
  }

  process.env = sanitizeAwsEnv(process.env);

  const { PULUMI_STACK, PULUMI_PROVIDERS } = process.env;
  if (!PULUMI_STACK) {
    error("PULUMI_STACK is required but not set");
    process.exit(1);
  }

  writeEphemeralWorkspaceFiles(ctx);

  try {
    maskSecretsForGithubActions(); // Mask sensitive env vars (config secrets are masked after stack selection)

    const sstCommand = SST_COMMAND_MAP[commandMode];
    info(`Starting ${commandMode} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
    info(`Working directory: ${ctx.pulumiWorkDir}`);

    prepareWorkDir(ctx);

    const providers = PULUMI_PROVIDERS ? PULUMI_PROVIDERS.split(",").map((p) => p.trim()) : [];
    const stack = await openStack(ctx, PULUMI_STACK, providers);

    // Mask secret config values before any engine output is streamed
    await maskStackSecretsForGithubActions(stack);

    // Preview must always run: it resolves the registered StackReferences against Pulumi Cloud,
    // pulling in upstream stack output changes and persisting them in this stack's state.
    // Exception: "unlock" targets a stack with a stuck lock/pending operation, so a preview would fail.
    if (commandMode !== "unlock") {
      await stack.preview(STREAM_OPTS);
    }

    const envFromPulumi = buildRunEnv(providers);
    info(`✓ Loaded environment`, true);

    await INFRA_EXECUTORS[commandMode]({ ctx, stack, stackName: PULUMI_STACK, sstCommand, envFromPulumi });

    if (commandMode !== "bash") {
      info(`✓ Finished ${commandMode} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
    }
  } catch (e) {
    error(`Error during SST execution: ${e}`);
    process.exitCode = 1;
  } finally {
    cleanupEphemeralWorkDir(ctx);
  }
};
