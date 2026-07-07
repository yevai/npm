import { spawnWithEnv } from "../common.js";
import { runStackFlow } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const devCommand = createTargetCommand("dev", "Start sst dev against the target stack", () =>
  runStackFlow({
    name: "dev",
    sstCommand: "dev",
    execute: async ({ ctx, stackName, envFromPulumi }) => {
      await spawnWithEnv(`npx sst dev --stage ${stackName}`, envFromPulumi, ctx.sstWorkDir);
    },
  }),
);
