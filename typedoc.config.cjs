/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
  entryPoints: ["packages/*"],
  entryPointStrategy: "packages",
  out: "docs",
  name: "Yevai NPM Packages",
  includeVersion: true,
  includeHierarchySummary: true,
  searchInComments: true,
  logLevel: 3,
  searchInDocuments: true,
  theme: "default",
  emit: "both",
  exclude: ["**/dist/**", "**/node_modules/**", "**/*.test.ts", "**/*.spec.ts", "**/test/**", "**/build.config.ts"],
  navigationLinks: {
    GitHub: "https://github.com/yevai/npm"
  },
  tsconfig: "tsconfig.json",
};
