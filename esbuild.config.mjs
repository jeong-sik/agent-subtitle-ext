import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const shared = {
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch ? "inline" : false,
  target: "es2022",
};

const configs = [
  { ...shared, entryPoints: ["src/inject.ts"], outfile: "dist/inject.js" },
  { ...shared, entryPoints: ["src/content.ts"], outfile: "dist/content.js" },
  { ...shared, entryPoints: ["src/background.ts"], outfile: "dist/background.js" },
  { ...shared, entryPoints: ["src/popup.ts"], outfile: "dist/popup.js" },
  { ...shared, entryPoints: ["src/sidepanel.ts"], outfile: "dist/sidepanel.js" },
];

async function main() {
  if (isWatch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log("Build complete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
