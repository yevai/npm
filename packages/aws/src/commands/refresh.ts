import { runSst, runStackFlow, STREAM_OPTS } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const refreshCommand = createTargetCommand(
  "refresh",
  "Refresh SST state, then Pulumi state",
  () =>
    runStackFlow({
      name: "refresh",
      sstCommand: "refresh",
      execute: async (run) => {
        await runSst(run);
        await run.stack.refresh(STREAM_OPTS);
      },
    }),
);
