import { Command } from "commander";

import { applyTargetEnv, parseTarget } from "./shared.js";
import type { InfraCommands } from "./shared.js";

interface InfraCommandSpec {
  name: InfraCommands;
  description: string;
  aliases?: string[];
}

const INFRA_COMMAND_SPECS: InfraCommandSpec[] = [
  { name: "deploy", description: "Deploy SST resources, then run pulumi up", aliases: ["up"] },
  { name: "preview", description: "Show a diff of pending SST and Pulumi changes", aliases: ["diff"] },
  { name: "dev", description: "Start sst dev against the target stack" },
  { name: "refresh", description: "Refresh SST state, then Pulumi state" },
  { name: "destroy", description: "Remove SST resources, then run pulumi destroy", aliases: ["remove"] },
  { name: "unlock", description: "Unlock SST state and cancel pending Pulumi operations", aliases: ["cancel"] },
  { name: "bash", description: "Drop into a shell wired to the target stack's environment" },
];

/** Build one commander subcommand per infra command. */
export const createInfraCommands = (run: (command: InfraCommands) => Promise<void>): Command[] =>
  INFRA_COMMAND_SPECS.map(({ name, description, aliases = [] }) => {
    const cmd = new Command(name)
      .description(description)
      .argument("[target]", "[org/]project/stack (also a valid ESC env); defaults to PULUMI_* env vars")
      .action(async (target?: string) => {
        if (target) {
          applyTargetEnv(parseTarget(target), name);
        } else {
          process.env.PULUMI_COMMAND = name;
        }
        await run(name);
      });
    aliases.forEach((alias) => cmd.alias(alias));
    return cmd;
  });
