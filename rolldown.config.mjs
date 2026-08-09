const external = (id) =>
  id === "ws" ||
  id === "openclaw" ||
  id.startsWith("openclaw/") ||
  id.startsWith("node:");

export default {
  input: ["index.ts", "setup-entry.ts", "runtime-api.ts"],
  external,
  platform: "node",
  treeshake: false,
  output: {
    dir: "dist",
    format: "esm",
    preserveModules: true,
    preserveModulesRoot: ".",
    entryFileNames: "[name].js",
  },
};
