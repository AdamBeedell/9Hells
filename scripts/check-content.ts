// Runs the content check against a content folder: npm run check-content [dir]
import path from "node:path";
import { validateContent } from "../src/engine/index.js";
import { loadContentSync } from "../src/server/content.js";

const dir = path.resolve(process.argv[2] ?? "content");
const issues = validateContent(loadContentSync(dir));
for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(7)} ${i.where}: ${i.message}`);
const errors = issues.filter((i) => i.level === "error").length;
console.log(`\n${errors} error(s), ${issues.length - errors} warning(s) in ${dir}`);
process.exit(errors ? 1 : 0);
