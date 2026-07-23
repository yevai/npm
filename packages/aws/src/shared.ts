/**
 * Shared helpers for commander-based pulumi-sst commands.
 *
 * The legacy entrypoint (src/cli.ts) is env-var driven; each command action
 * translates its parsed arguments into the same env-var contract
 * (PULUMI_ORGANIZATION / PULUMI_PROJECT / PULUMI_STACK / PULUMI_COMMAND)
 * so env-var driven invocations (e.g. CI) keep working.
 */
import { Command } from "commander";

/** All pulumi-sst commands, one module per command in src/commands/. */
export type CommandName =
  | "deploy"
  | "preview"
  | "dev"
  | "refresh"
  | "destroy"
  | "unlock"
  | "bash"
  | "generate"
  | "validate";

export interface Target {
  organization?: string;
  project?: string;
  stack: string;
}

/** Parse a `[org/]project/stack` (also a valid ESC env) target reference. */
export const parseTarget = (target: string): Target => {
  const [stack, project, organization] = target.split("/").reverse();
  if (!stack) {
    throw new Error(`Invalid target "${target}". Expected [org/]project/stack`);
  }
  return { organization, project, stack };
};

/** Apply a parsed target and command to the env-var contract consumed by the command flows. */
export const applyTargetEnv = (target: Target, command: string): void => {
  process.env.PULUMI_COMMAND = command;
  process.env.PULUMI_STACK = target.stack;
  if (target.project) {
    process.env.PULUMI_PROJECT = target.project;
  }
  if (target.organization) {
    process.env.PULUMI_ORGANIZATION = target.organization;
    process.env.PULUMI_ORG = target.organization;
  }
};

/**
 * Build a command with the standard `[target]` argument shared by every pulumi-sst
 * command, wiring the parsed target into the env-var contract before running.
 */
export const createTargetCommand = (
  name: CommandName,
  description: string,
  run: () => Promise<void>,
  aliases: string[] = [],
): Command => {
  const cmd = new Command(name)
    .description(description)
    .argument(
      "[target]",
      "[org/]project/stack (also a valid ESC env); defaults to PULUMI_* env vars",
    )
    .action(async (target?: string) => {
      if (target) {
        applyTargetEnv(parseTarget(target), name);
      } else {
        process.env.PULUMI_COMMAND = name;
      }
      await run();
    });
  aliases.forEach((alias) => cmd.alias(alias));
  return cmd;
};
