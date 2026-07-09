import { runValidate } from "../escReflector.js";
import { loadEscContext } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const validateCommand = createTargetCommand(
  "validate",
  "Validate the Pulumi ESC environment against generated Zod schemas",
  async () => {
    const { ctx, escValues } = loadEscContext();
    runValidate(ctx, escValues);
  },
);
