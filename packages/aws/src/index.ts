import * as pulumi from "@pulumi/pulumi";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Read an env var, computing and caching it when unset so child processes inherit it. */
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
const { PULUMI_WORK_DIR, SST_WORK_DIR } = process.env;

if (!PULUMI_WORK_DIR) {
  console.error("Fatal: PULUMI_WORK_DIR is required but not set");
  process.exit(1);
}
if (!SST_WORK_DIR) {
  console.error("Fatal: SST_WORK_DIR is required but not set");
  process.exit(1);
}

// PULUMI_CONFIG, PULUMI_CONFIG_SECRET_KEYS, and STACK_REFERENCES are consumed via the
// destructuring below; npm_* keys are excluded by prefix in the filter.
const EXCLUDED_ENV_KEYS = new Set(["PWD", "CWD", "OLDPWD", "HOME", "SHELL", "TERM", "TMPDIR", "SHLVL", "_", "INIT_CWD"]);

const { PULUMI_CONFIG, PULUMI_CONFIG_SECRET_KEYS, STACK_REFERENCES, ...rawEnv } = process.env;

const parsedConfig = JSON.parse(PULUMI_CONFIG || "{}");

function recursivelyParseJson(obj: any): any {
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return recursivelyParseJson(JSON.parse(obj));
      } catch {
        // Not valid JSON, keep original string
      }
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(recursivelyParseJson);
  }

  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, recursivelyParseJson(v)]));
  }

  return obj;
}

if (IS_PREVIEW) {
  const otherEnv = Object.fromEntries(Object.entries(rawEnv).filter(([key]) => !EXCLUDED_ENV_KEYS.has(key) && !key.startsWith("npm_")));

  // The ESC config is only needed to write the .cfg.json snapshot, so fetch it during preview only
  let auxiliaryConfig: Record<string, unknown> = {};
  try {
    auxiliaryConfig = Object.fromEntries(
      Object.entries(
        JSON.parse(
          execSync(`pulumi esc get ${PULUMI_ORG}/${PULUMI_PROJECT}/${PULUMI_STACK} --show-secrets --value json`, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        ).pulumiConfig,
      ).map(([key, value]) => [`${PULUMI_PROJECT}:config:${key}`, value]),
    );
  } catch {
    // A malformed or non-existent ESC config is fine; fall back to PULUMI_CONFIG only
  }

  writeFileSync(`.env.${PULUMI_STACK}.env.json`, JSON.stringify(otherEnv, null, 2));
  writeFileSync(`.env.${PULUMI_STACK}.cfg.json`, JSON.stringify(recursivelyParseJson({ ...parsedConfig, ...auxiliaryConfig }), null, 2));
}

function extractStringValues(obj: unknown): string[] {
  const values: string[] = [];

  if (typeof obj === "string") {
    if (obj.length > 10 && !obj.includes("@")) {
      values.push(obj);
    }
  } else if (typeof obj === "object" && obj !== null) {
    for (const value of Object.values(obj)) {
      values.push(...extractStringValues(value));
    }
  }

  return values;
}

if (PULUMI_CONFIG_SECRET_KEYS && process.env.GITHUB_ACTIONS === "true") {
  const secretKeys: string[] = JSON.parse(PULUMI_CONFIG_SECRET_KEYS);
  const allSecretValues: string[] = [];

  for (const shortKey of secretKeys) {
    const [namespace, ...rest] = shortKey.split(":");
    const configKey = `${namespace}:config:${rest.join(":")}`;

    const value = parsedConfig[shortKey] ?? parsedConfig[configKey];

    if (value === undefined || value === "") continue;

    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        allSecretValues.push(...extractStringValues(JSON.parse(value)));
      } catch {
        allSecretValues.push(value);
      }
    } else {
      allSecretValues.push(...extractStringValues(value));
    }
  }

  const uniqueValues = [...new Set(allSecretValues)].filter((v) => v.length > 0);

  if (uniqueValues.length > 0) {
    writeFileSync(`.env.${PULUMI_STACK}.mask.txt`, uniqueValues.join("\n"));
  }
}

// Stack references must be registered during both preview and up so they persist in stack state
const STACK_REF_KEYS = [...new Set([`${PULUMI_PROJECT}/${PULUMI_STACK}`, ...(STACK_REFERENCES ? STACK_REFERENCES.split(",") : [])])];
const STACK_REFS_ACTUAL = STACK_REF_KEYS.map((ref) => new pulumi.StackReference(`${PULUMI_ORG}/${ref}`));

if (IS_PREVIEW) {
  const selfRef = STACK_REFS_ACTUAL[0];
  pulumi.all(STACK_REFS_ACTUAL.map((ref) => ref.outputs)).apply((outputArray) => {
    const refOutputs = Object.fromEntries(STACK_REF_KEYS.map((refName, index) => [refName, outputArray[index]]));
    writeFileSync(`.env.${PULUMI_STACK}.refs.json`, JSON.stringify(refOutputs, null, 2));
    writeFileSync(`.env.${PULUMI_STACK}.out.json`, JSON.stringify(outputArray[0], null, 2));
  });
  // Re-export this stack's own outputs so they survive the preview run
  module.exports = selfRef.outputs.apply((outputs) => ({
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
