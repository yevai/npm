import { Command } from "commander";

import { applyTargetEnv, parseTarget } from "./shared.js";
import type { DxCommands } from "./shared.js";

interface DxCommandSpec {
  name: Exclude<DxCommands, "bash">;
  description: string;
}

const DX_COMMAND_SPECS: DxCommandSpec[] = [
  { name: "generate", description: "Generate Zod types from the target's Pulumi ESC environment" },
  { name: "validate", description: "Validate the Pulumi ESC environment against generated Zod schemas" },
];

/** Build the developer-experience commands that exit before the infra flow runs. */
export const createDxCommands = (run: (command: DxCommands) => Promise<void>): Command[] =>
  DX_COMMAND_SPECS.map(({ name, description }) =>
    new Command(name)
      .description(description)
      .argument("[target]", "[org/]project/stack (also a valid ESC env); defaults to PULUMI_* env vars")
      .action(async (target?: string) => {
        if (target) {
          applyTargetEnv(parseTarget(target), name);
        } else {
          process.env.PULUMI_COMMAND = name;
        }
        await run(name);
      }),
  );
