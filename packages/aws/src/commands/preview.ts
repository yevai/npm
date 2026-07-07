import { runSst, runStackFlow } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const previewCommand = createTargetCommand(
  "preview",
  "Show a diff of pending SST and Pulumi changes",
  () =>
    runStackFlow({
      name: "preview",
      sstCommand: "diff",
      execute: (run) => runSst(run),
    }),
  ["diff"],
);
