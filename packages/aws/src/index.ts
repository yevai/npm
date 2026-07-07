/**
 * Pulumi program template (shipped as dist/pulumi-template.ts and copied into the
 * Pulumi work dir by the runner). It exports the SST outputs of the target stack:
 * during previews by resolving StackReferences against Pulumi Cloud, otherwise by
 * reading the freshly written .sst/outputs.json.
 *
 * @packageDocumentation
 */
import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "fs";
import { join } from "path";

/** Return the env var if set; otherwise compute it via `getter` and persist it to the env. */
const syncEnv = (key: string, getter: () => string): string => {
  const value = process.env[key];
  if (value !== undefined) {
    return value;
  }
  const newValue = getter();
  process.env[key] = newValue;
  return newValue;
};

const PULUMI_STACK = syncEnv("PULUMI_STACK", pulumi.getStack);
const PULUMI_ORG = syncEnv("PULUMI_ORG", pulumi.getOrganization);
const PULUMI_PROJECT = syncEnv("PULUMI_PROJECT", pulumi.getProject);
const IS_PREVIEW = pulumi.runtime.isDryRun();
const { SST_WORK_DIR, STACK_REFERENCES } = process.env;

if (!SST_WORK_DIR) {
  console.error("Fatal: SST_WORK_DIR is required but not set");
  process.exit(1);
}

const STACK_REF_KEYS = [...new Set([`${PULUMI_PROJECT}/${PULUMI_STACK}`, ...(STACK_REFERENCES ? STACK_REFERENCES.split(",") : [])])];
const STACK_REFS_ACTUAL = STACK_REF_KEYS.map((ref) => new pulumi.StackReference(`${PULUMI_ORG}/${ref}`));

if (IS_PREVIEW) {
  module.exports = STACK_REFS_ACTUAL[0].outputs.apply((outputs) => ({
    ...module.exports,
    ...Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, pulumi.output(value)])),
  }));
} else {
  const outputsPath = join(SST_WORK_DIR, ".sst/outputs.json");
  const newOutputs = JSON.parse(readFileSync(outputsPath, "utf-8")) as Record<string, any>;
  for (const [key, value] of Object.entries(newOutputs)) {
    module.exports[key] = pulumi.output(value);
  }
}
