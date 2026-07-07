import * as pulumi from "@pulumi/pulumi";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const syncEnv = <T extends string>(key: T, getter: () => string): string => {
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
  console.error("⚠️  Warning: PULUMI_WORK_DIR is not set. Defaulting to .cicd/pulumi");
  process.exit(1);
}
if (!SST_WORK_DIR) {
  console.error("⚠️  Warning: SST_WORK_DIR is not set. Defaulting to .");
  process.exit(1);
}

const EXCLUDED_ENV_KEYS = [
  "PULUMI_CONFIG",
  "PULUMI_CONFIG_SECRET_KEYS",
  "STACK_REFERENCES", // This consumes STACK_REFERENCES
  "PWD",
  "CWD",
  "OLDPWD",
  "HOME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "npm_config_prefix",
  "npm_execpath",
  "npm_node_execpath",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
  "npm_package_json",
  "SHLVL",
  "_",
  "INIT_CWD",
];

const { PULUMI_CONFIG, PULUMI_CONFIG_SECRET_KEYS, STACK_REFERENCES, ...rawEnv } = process.env;

function recursivelyParseJson(obj: any): any {
  if (typeof obj === "string") {
    try {
      const trimmed = obj.trim();
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        const parsed = JSON.parse(obj);
        return recursivelyParseJson(parsed);
      }
    } catch {
      // Not valid JSON, keep original string
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

const otherEnv = Object.fromEntries(Object.entries(rawEnv).filter(([key]) => !EXCLUDED_ENV_KEYS.includes(key) && !key.startsWith("npm_")));

const parsedConfig = JSON.parse(PULUMI_CONFIG || "{}");

let auxiliaryConfig = {};

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
} catch (e) {
  // We don't need to do anything for a malformed or non-existent config
}

const unifiedConfig = recursivelyParseJson({
  ...parsedConfig,
  ...auxiliaryConfig,
});

if (IS_PREVIEW) {
  writeFileSync(`.env.${PULUMI_STACK}.env.json`, JSON.stringify(otherEnv, null, 2));
  writeFileSync(`.env.${PULUMI_STACK}.cfg.json`, JSON.stringify(unifiedConfig, null, 2));
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

if (PULUMI_CONFIG_SECRET_KEYS && typeof PULUMI_CONFIG_SECRET_KEYS === "string") {
  const secretKeys: string[] = JSON.parse(PULUMI_CONFIG_SECRET_KEYS);
  const allSecretValues: string[] = [];

  for (const shortKey of secretKeys) {
    const [namespace, ...rest] = shortKey.split(":");
    const keyName = rest.join(":");
    const configKey = `${namespace}:config:${keyName}`;

    let value = parsedConfig[shortKey] ?? parsedConfig[configKey];

    if (value === undefined || value === "") continue;

    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        const parsed = JSON.parse(value);
        allSecretValues.push(...extractStringValues(parsed));
      } catch {
        allSecretValues.push(value);
      }
    } else {
      allSecretValues.push(...extractStringValues(value));
    }
  }

  const uniqueValues = [...new Set(allSecretValues)].filter((v) => v.length > 0);

  if (uniqueValues.length > 0 && process.env.GITHUB_ACTIONS === "true") {
    writeFileSync(`.env.${PULUMI_STACK}.mask.txt`, uniqueValues.join("\n"));
  }
}

const STACK_REF_KEYS = [...new Set([`${PULUMI_PROJECT}/${PULUMI_STACK}`].concat(STACK_REFERENCES ? STACK_REFERENCES.split(",") : []))];
const STACK_REFS_ACTUAL = STACK_REF_KEYS.map((ref) => new pulumi.StackReference(`${PULUMI_ORG}/${ref}`));

if (IS_PREVIEW) {
  pulumi
    .all(STACK_REFS_ACTUAL.map((ref) => ref.outputs))
    .apply((outputArray) => {
      return STACK_REF_KEYS.reduce(
        (acc, refName, index) => {
          acc[refName] = outputArray[index];
          return acc;
        },
        {} as Record<string, Record<string, any>>,
      );
    })
    .apply((outputs) => {
      writeFileSync(`.env.${PULUMI_STACK}.refs.json`, JSON.stringify(outputs, null, 2));
    });
  const selfRef = STACK_REFS_ACTUAL[0]; // This variable is necessary for pulumi resolution
  selfRef.outputs.apply((outputs) => {
    writeFileSync(`.env.${PULUMI_STACK}.out.json`, JSON.stringify(outputs, null, 2));
  });
  module.exports = selfRef.outputs.apply((outputs) => ({
    ...module.exports,
    ...Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, pulumi.output(value)])),
  }));
} else {
  const outputsPath = join(SST_WORK_DIR!, ".sst/outputs.json");
  const newOutputs = JSON.parse(readFileSync(outputsPath, "utf-8")) as Record<string, any>;
  for (const [key, value] of Object.entries(newOutputs)) {
    module.exports[key] = pulumi.output(value);
  }
}
