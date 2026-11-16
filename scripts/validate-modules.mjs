import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  STRICT_FILENAME_REGEX,
  validateModuleJson,
  normalizeVersionToDisplay,
} from "./lib/schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function validate() {
  let errors = 0;
  let totalChecked = 0;
  const seenIndices = new Set();
  const errorMessages = [];

  for (const cat of CATEGORIES) {
    const dir = path.join(root, cat, "json");
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      totalChecked++;

      const match = entry.name.match(STRICT_FILENAME_REGEX);
      if (!match) {
        const msg = `[INVALID FILENAME] ${cat}/json/${entry.name}: Expected strict format <PPSA>_<XX_XXX_XXX>_<Game_Name>_<Index>.json`;
        console.error(msg);
        errorMessages.push(msg);
        errors++;
        continue;
      }

      const [, ppsa, verScore, , indexNum] = match;
      const indexKey = `${cat}_${ppsa}_${verScore}_${indexNum}`;
      if (seenIndices.has(indexKey)) {
        const msg = `[DUPLICATE INDEX] ${cat}/json/${entry.name}: index ${indexNum} already exists for ${ppsa} ${verScore}.`;
        console.error(msg);
        errorMessages.push(msg);
        errors++;
      }
      seenIndices.add(indexKey);

      const fullPath = path.join(dir, entry.name);
      try {
        const raw = await readFile(fullPath, "utf8");
        const parsed = JSON.parse(raw);
        validateModuleJson(parsed, ppsa, verScore, { isStrict: true, category: cat });
        if (typeof parsed.version === "string" && parsed.version.includes("_")) {
          throw new Error(
            `Version in JSON ("${parsed.version}") must not use underscores; use standard dot notation (e.g. "${normalizeVersionToDisplay(parsed.version)}").`
          );
        }
      } catch (err) {
        const msg = `[INVALID CONTENT] ${cat}/json/${entry.name}: ${err.message}`;
        console.error(msg);
        errorMessages.push(msg);
        errors++;
      }
    }
  }

  if (totalChecked === 0) {
    const msg = "[ERROR] No module files found to validate. Check repository directory structure.";
    console.error(msg);
    errorMessages.push(msg);
    errors++;
  }

  if (errors > 0) {
    if (process.env.SUBMISSION_ERROR_FILE) {
      try {
        await writeFile(process.env.SUBMISSION_ERROR_FILE, errorMessages.join("\n"), "utf8");
      } catch (_) {}
    }
    console.error(`\nValidation failed with ${errors} error(s) out of ${totalChecked} files.`);
    process.exit(1);
  } else {
    console.log(`\nValidation passed: ${totalChecked} file(s) verified cleanly.`);
  }
}

validate().catch((err) => {
  console.error(err);
  process.exit(1);
});
