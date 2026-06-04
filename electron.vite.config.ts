import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// Native/runtime modules that must NOT be bundled into the main/preload output:
// `electron` is provided by the runtime, and `better-sqlite3` is a native addon.
//
// electron-vite's automatic externalization (`build.externalizeDeps` / the
// deprecated externalizeDepsPlugin) does not externalize third-party deps under
// the current electron-vite 5 + Vite 8 combo, so we externalize at the Rollup
// level, which is reliable regardless of electron-vite version.
const externals = ["electron", "better-sqlite3"];

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: externals,
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: externals,
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    plugins: [react()],
  },
});
