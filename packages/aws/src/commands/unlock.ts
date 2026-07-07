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
      skipPreview: true, // the stack is locked; a preview would fail
      execute: async (run) => {
        // First unlock SST state, then cancel any in-flight Pulumi operation (releases the lock)
        await runSst(run);
        await run.stack.cancel();
        info(`✓ Cancelled pending Pulumi operations for ${run.stackName}`, true);
      },
    }),
  ["cancel"],
);
