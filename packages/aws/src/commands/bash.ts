import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { error, info, spawnWithEnv, warn } from "../common.js";
import type { StackRun } from "../runner.js";
import { runStackFlow } from "../runner.js";
import { createTargetCommand } from "../shared.js";

const runBashSession = async ({
  ctx,
  stackName,
  envFromPulumi,
}: StackRun): Promise<void> => {
  const hostHome = envFromPulumi.HOST_HOME || "";
  const nvmScript = join(hostHome, ".nvm", "nvm.sh");
  if (!existsSync(nvmScript)) {
    error(`NVM is required but was not found at ${nvmScript}.`);
    process.exit(1);
  }

  const isZsh = (process.env.SHELL || "bash").endsWith("zsh");
  const userShell = isZsh ? "zsh" : "bash";

  info(`Dropping into AWS state linked shell (${userShell}) for ${stackName}`);
  info(`Helpful tips below. If you're here, good luck!`);
  warn(
    ` npx sst state export --stage ${stackName}        [Export stack state]`,
  );
  warn(` npx sst unlock --stage ${stackName}              [Unlock deployment]`);
  warn(` npx sst state remove <urn> --stage ${stackName}  [Remove resource]`);
  warn(
    ` npx sst state edit --stage ${stackName}          [Interactive editor]`,
  );

  const nvmInitLines = [
    `export NVM_DIR="$HOME/.nvm"`,
    `[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"`,
  ];

  if (isZsh) {
    const zshrcPath = join(ctx.pulumiWorkDir, ".zshrc");
    writeFileSync(zshrcPath, nvmInitLines.join("\n"));
    await spawnWithEnv(
      userShell,
      { ...envFromPulumi, ZDOTDIR: ctx.pulumiWorkDir },
      ctx.sstWorkDir,
    );
    if (existsSync(zshrcPath)) unlinkSync(zshrcPath);
  } else {
    const tmpInitPath = join(ctx.pulumiWorkDir, "bash-init.sh");
    writeFileSync(
      tmpInitPath,
      [`export BASH_SILENCE_DEPRECATION_WARNING=1`, ...nvmInitLines].join("\n"),
    );
    await spawnWithEnv(
      `bash --init-file "${tmpInitPath}"`,
      envFromPulumi,
      ctx.sstWorkDir,
    );
    if (existsSync(tmpInitPath)) unlinkSync(tmpInitPath);
  }
};

export const bashCommand = createTargetCommand(
  "bash",
  "Drop into a shell wired to the target stack's environment",
  () =>
    runStackFlow({
      name: "bash",
      sstCommand: "bash",
      interactive: true,
      execute: runBashSession,
    }),
);
