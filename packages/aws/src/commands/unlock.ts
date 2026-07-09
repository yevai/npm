import { info } from "../common.js";
import { runSst, runStackFlow } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const unlockCommand = createTargetCommand(
  "unlock",
  "Unlock SST state and cancel pending Pulumi operations",
  () =>
    runStackFlow({
      name: "unlock",
      sstCommand: "unlock",
      skipPreview: true,
      execute: async (run) => {
        await runSst(run);
        await run.stack.cancel();
        info(
          `✓ Cancelled pending Pulumi operations for ${run.stackName}`,
          true,
        );
      },
    }),
  ["cancel"],
);
