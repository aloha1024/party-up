import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const infoPath = fileURLToPath(new URL("../build-info.json", import.meta.url));
const packagePath = new URL("../package.json", import.meta.url);
function sourceInfo() {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  return {
    version: pkg.version,
    revision: process.env.APP_VERSION || "development",
    builtAt: process.env.APP_BUILD_DATE || null,
    node: process.version,
    prisma: pkg.dependencies.prisma,
  };
}
export function buildInfo() {
  const info = existsSync(infoPath)
    ? JSON.parse(readFileSync(infoPath, "utf8"))
    : sourceInfo();
  return { ...info, image: process.env.APP_IMAGE || null };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes("--write")) {
    writeFileSync(infoPath, JSON.stringify(sourceInfo(), null, 2) + "\n");
  } else {
    const info = buildInfo();
    console.log(
      process.argv.includes("--json")
        ? JSON.stringify(info)
        : `Party Up ${info.version} | revision ${info.revision} | Node ${info.node} | Prisma ${info.prisma}`,
    );
  }
}
