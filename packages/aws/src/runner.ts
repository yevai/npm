/**
 * Shared execution flows for yaws commands.
 *
 * Each command lives in its own file (deploy.ts, generate.ts, ...) and declares its
 * commander subcommand there. This module owns the plumbing that is identical across
 * commands: the SST + Pulumi stack flow (context/ESC setup, workspace preparation,
 * stack selection, secret masking, StackReference-resolving preview) and the ESC
 * context loader used by the reflection commands.
 */
import { copyFileSync, existsSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import type { Stack } from "@pulumi/pulumi/automation";

import type { CliContext, EscValues } from "./common.js";
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
} from "./common.js";
import type { CommandName } from "./shared.js";

export const STREAM_OPTS = {
  color: "always",
  onOutput: (msg: string) => process.stdout.write(msg),
} as const;

export interface StackRun {
  ctx: CliContext;
  stack: Stack;
  stackName: string;
  sstCommand: string;
  envFromPulumi: Record<string, string>;
}

export interface StackFlowOptions {
  name: CommandName;
  /** SST subcommand run for this command (SST uses "remove" and "diff"). */
  sstCommand: string;
  /**
   * Skip the StackReference-resolving preview. Only "unlock" sets this: it targets
   * a stack with a stuck lock/pending operation, so a preview would fail.
   */
  skipPreview?: boolean;
  /** Interactive commands (bash) skip the completion banner. */
  interactive?: boolean;
  execute: (run: StackRun) => Promise<void>;
}

export const runSst = ({ ctx, stackName, sstCommand, envFromPulumi }: StackRun): Promise<void> =>
  runSstWithEnv(`npx sst ${sstCommand} --stage ${stackName}`, envFromPulumi, ctx.sstWorkDir);

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

const prepareWorkDir = (ctx: CliContext): void => {
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "pulumi-template.ts"), join(ctx.pulumiWorkDir, "index.ts"));

  const nodeModulesLink = join(ctx.pulumiWorkDir, "node_modules");
  if (ctx.ephemeralPulumiDir && !existsSync(nodeModulesLink)) {
    symlinkSync(join(ctx.sstWorkDir, "node_modules"), nodeModulesLink, "dir");
    info(`✓ Symlinked node_modules from ${ctx.sstWorkDir}`, true);
  }
};

const openStack = async (ctx: CliContext, stackName: string, providers: string[]): Promise<Stack> => {
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

  return {
    ...resolveProviderEnvVars(HOST_PULUMI_ORG ?? HOST_PULUMI_ORGANIZATION, providers),
    ...(Object.fromEntries(Object.entries(hostEnv).filter(([, v]) => v !== undefined)) as Record<string, string>),
  };
};

/**
 * Run a stack command end to end: SST always runs first, Pulumi second.
 *
 * Sensitive env vars are masked immediately; secret stack config values are masked
 * after stack selection, before any engine output is streamed. Unless skipped, a
 * preview always runs first: it resolves the registered StackReferences against
 * Pulumi Cloud, pulling in upstream stack output changes and persisting them in
 * this stack's state.
 */
export const runStackFlow = async ({ name, sstCommand, skipPreview, interactive, execute }: StackFlowOptions): Promise<void> => {
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
    maskSecretsForGithubActions();

    info(`Starting ${name} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
    info(`Working directory: ${ctx.pulumiWorkDir}`);

    prepareWorkDir(ctx);

    const providers = PULUMI_PROVIDERS ? PULUMI_PROVIDERS.split(",").map((p) => p.trim()) : [];
    const stack = await openStack(ctx, PULUMI_STACK, providers);

    await maskStackSecretsForGithubActions(stack);

    if (!skipPreview) {
      await stack.preview(STREAM_OPTS);
    }

    const envFromPulumi = buildRunEnv(providers);
    info(`✓ Loaded environment`, true);

    await execute({ ctx, stack, stackName: PULUMI_STACK, sstCommand, envFromPulumi });

    if (!interactive) {
      info(`✓ Finished ${name} (SST: ${sstCommand}) for ${PULUMI_STACK}`);
    }
  } catch (e) {
    error(`Error during SST execution: ${e}`);
    process.exitCode = 1;
  } finally {
    cleanupEphemeralWorkDir(ctx);
  }
};

export const loadEscContext = (): { ctx: CliContext; escValues: EscValues } => {
  const ctx = initContext();
  try {
    return { ctx, escValues: fetchEscValues(ctx) };
  } catch (e) {
    error(`Failed to retrieve ESC environment variables for ${ctx.escReference}: ${e}`);
    cleanupEphemeralWorkDir(ctx);
    process.exit(1);
  }
};
