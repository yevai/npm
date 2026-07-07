/**
 * Shared helpers for commander-based yaws commands.
 *
 * The legacy entrypoint (src/cli.ts) is env-var driven; during the transition to
 * commander v15 each command action translates its parsed arguments into the same
 * env-var contract (PULUMI_ORGANIZATION / PULUMI_PROJECT / PULUMI_STACK / PULUMI_COMMAND)
 * so the existing runner keeps working while logic is migrated command-by-command.
 */

/** All infra commands understood by the runner. */
export type InfraCommands = "deploy" | "preview" | "dev" | "refresh" | "destroy" | "unlock" | "bash";

/** CLI-only commands that exit before the infra flow runs ("bash" is both). */
export type DxCommands = "generate" | "validate" | "bash";

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

/** Apply a parsed target and command to the env-var contract consumed by the runner. */
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
