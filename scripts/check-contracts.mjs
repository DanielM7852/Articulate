import { compileFromFile } from "json-schema-to-typescript";
import { readFile } from "node:fs/promises";
const expected = await compileFromFile("packages/contracts/schema.json");
const actual = await readFile("packages/contracts/generated.d.ts", "utf8");
if (expected.replaceAll("\r\n", "\n") !== actual.replaceAll("\r\n", "\n")) {
  throw new Error(
    "Generated TypeScript contracts drifted. Run npm run contracts.",
  );
}
console.log("Generated TypeScript contracts match canonical schema.");
