import { runSst, runStackFlow, STREAM_OPTS } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const destroyCommand = createTargetCommand(
  "destroy",
  "Remove SST resources, then run pulumi destroy",
  () =>
    runStackFlow({
      name: "destroy",
      sstCommand: "remove",
      execute: async (run) => {
        await runSst(run);
        await run.stack.destroy(STREAM_OPTS);
      },
    }),
  ["remove"],
);
