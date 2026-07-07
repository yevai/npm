#!/usr/bin/env node
/**
 * yaws CLI entry point: a thin commander v15 shim.
 *
 * Each command lives in its own module under src/commands/ (deploy.ts, bash.ts, ...);
 * cross-command helpers live in src/common.ts and the shared execution flows
 * in src/runner.ts. This file only normalizes legacy invocations onto
 * commander and dispatches.
 */
import { createProgram } from "./commands/index.js";
import { error, warn } from "./common.js";

console.info(""); // Init pipe

/** Legacy PULUMI_COMMAND values (and CLI aliases) mapped to canonical command names. */
const COMMAND_ALIASES: Record<string, string> = {
  up: "deploy",
  deploy: "deploy",
  preview: "preview",
  diff: "preview",
  dev: "dev",
  refresh: "refresh",
  destroy: "destroy",
  remove: "destroy",
  unlock: "unlock",
  cancel: "unlock",
  bash: "bash",
  generate: "generate",
  validate: "validate",
};

const toCanonicalCommand = (command: string): string | undefined => COMMAND_ALIASES[command.toLowerCase()];

/** Zero-arg invocation: derive the command from the PULUMI_COMMAND env var. */
const argsFromEnv = (): string[] => {
  const envCommand = process.env.PULUMI_COMMAND;
  if (!envCommand) {
    return []; // no args, no env command: let commander print help
  }
  const command = toCanonicalCommand(envCommand);
  if (!command) {
    error(`Invalid PULUMI_COMMAND: "${envCommand}"`);
    error(`Valid commands: ${Object.keys(COMMAND_ALIASES).join(", ")}`);
    process.exit(1);
  }
  return [command];
};

/** Detect the deprecated `yaws <target> <command>` argument order. */
const isLegacyTargetFirst = (args: string[]): boolean => args.length === 2 && !!toCanonicalCommand(args[1]) && !toCanonicalCommand(args[0]);

/**
 * Normalize legacy invocations onto commander's `yaws <command> [target]` form:
 * - `yaws` with PULUMI_COMMAND (and PULUMI_STACK etc.) set via env vars
 * - `yaws <project>/<stack> <command>` (target-first argument order)
 */
const normalizeArgs = (args: string[]): string[] => {
  if (args.length === 0) {
    return argsFromEnv();
  }
  if (isLegacyTargetFirst(args)) {
    warn(`⚠ "yaws <target> <command>" is deprecated; use "yaws <command> <target>"`);
    return [args[1].toLowerCase(), args[0]];
  }
  return args;
};

createProgram()
  .parseAsync(normalizeArgs(process.argv.slice(2)), { from: "user" })
  .catch((e: unknown) => {
    error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
