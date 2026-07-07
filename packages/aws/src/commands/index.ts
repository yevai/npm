import { Command } from "commander";

import { bashCommand } from "./bash.js";
import { deployCommand } from "./deploy.js";
import { destroyCommand } from "./destroy.js";
import { devCommand } from "./dev.js";
import { generateCommand } from "./generate.js";
import { previewCommand } from "./preview.js";
import { refreshCommand } from "./refresh.js";
import { unlockCommand } from "./unlock.js";
import { validateCommand } from "./validate.js";

export { applyTargetEnv, parseTarget } from "../shared.js";
export type { CommandName, Target } from "../shared.js";

/** Build the yaws commander program from the per-command modules. */
export const createProgram = (): Command => {
  const program = new Command("yaws")
    .description("SST + Pulumi deployment wrapper driven by Pulumi ESC environments")
    .configureHelp({ showGlobalOptions: true });

  [
    deployCommand,
    previewCommand,
    devCommand,
    refreshCommand,
    destroyCommand,
    unlockCommand,
    bashCommand,
    generateCommand,
    validateCommand,
  ].forEach((cmd) => program.addCommand(cmd));

  return program;
};
