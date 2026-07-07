import { Command } from "commander";

import { createDxCommands } from "./dx.js";
import { createInfraCommands } from "./infra.js";
import type { DxCommands, InfraCommands } from "./shared.js";

export type { DxCommands, InfraCommands, Target } from "./shared.js";
export { applyTargetEnv, parseTarget } from "./shared.js";

export interface ProgramRunners {
  /** Executes an infra command (deploy/preview/dev/refresh/destroy/unlock/bash). */
  runInfra: (command: InfraCommands) => Promise<void>;
  /** Executes a DX command (generate/validate). */
  runDx: (command: DxCommands) => Promise<void>;
}

/**
 * Build the yaws commander program.
 *
 * The runners are injected so src/cli.ts can wire its existing env-var driven flow
 * in during the commander v15 transition without circular imports.
 */
export const createProgram = ({ runInfra, runDx }: ProgramRunners): Command => {
  const program = new Command("yaws")
    .description("SST + Pulumi deployment wrapper driven by Pulumi ESC environments")
    .configureHelp({ showGlobalOptions: true });

  createInfraCommands(runInfra).forEach((cmd) => program.addCommand(cmd));
  createDxCommands(runDx).forEach((cmd) => program.addCommand(cmd));

  return program;
};
