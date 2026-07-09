import { runSst, runStackFlow, STREAM_OPTS } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const deployCommand = createTargetCommand(
  "deploy",
  "Deploy SST resources, then run pulumi up",
  () =>
    runStackFlow({
      name: "deploy",
      sstCommand: "deploy",
      execute: async (run) => {
        await runSst(run);
        await run.stack.up(STREAM_OPTS);
      },
    }),
  ["up"],
);
