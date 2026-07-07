import { runGenerate } from "../escReflector.js";
import { loadEscContext } from "../runner.js";
import { createTargetCommand } from "../shared.js";

export const generateCommand = createTargetCommand("generate", "Generate Zod types from the target's Pulumi ESC environment", async () => {
  const { ctx, escValues } = loadEscContext();
  runGenerate(ctx, escValues);
});
