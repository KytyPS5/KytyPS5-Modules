import path from "node:path";
import { readdir } from "node:fs/promises";

// Matches: PPSA01325_01_905_000_Astros_Playroom_1.json
// Accommodates unindexed PPSA01325_01_905_000_Astros_Playroom.json gracefully
export const FILENAME_REGEX =
  /^([A-Z]{4}\d{5})_(\d{2}_\d{3}_\d{3})_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*?)(?:_([1-9]\d{0,4}))?\.json$/;

// Strict regex where numeric index suffix is required (_1, _2, ...)
export const STRICT_FILENAME_REGEX =
  /^([A-Z]{4}\d{5})_(\d{2}_\d{3}_\d{3})_([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)_([1-9]\d{0,4})\.json$/;

export const CATEGORIES = ["patches", "cheats", "configs"];

export const CATEGORY_SINGULAR = {
  patches: "patch",
  cheats: "cheat",
  configs: "config",
};

/**
 * Strips surrounding backticks, single/double quotes, and whitespace.
 */
export function cleanInputString(val) {
  if (val === null || val === undefined) return "";
  return String(val)
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .trim();
}

/**
 * Normalizes a game title into a clean filename slug.
 * e.g. "Astro's Playroom" -> "Astros_Playroom"
 * "God of War: Ragnarök" -> "God_of_War_Ragnarok"
 */
export function sanitizeGameName(name, fallback = "Unknown_Game") {
  const cleaned = cleanInputString(name);
  if (!cleaned || cleaned.toLowerCase() === "_no response_") return fallback;
  const sanitized = cleaned
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/['’]/g, "") // remove quotes
    .replace(/[^A-Za-z0-9]+/g, "_") // replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, ""); // trim underscores
  return sanitized || fallback;
}

/**
 * Normalizes version strings, automatically converting any dots to underscores.
 * Automatically converts '01.905.000' -> '01_905_000'.
 * Also flexibly handles user input variations like '1.905.000', '1.018', '01.018', '1.0',
 * and normalizes them into the standard 8-digit underscore format '01_905_000'.
 */
export function normalizeVersionToFilename(ver) {
  const clean = cleanInputString(ver).replace(/\./g, "_");
  if (/^\d{2}_\d{3}_\d{3}$/.test(clean)) {
    return clean;
  }

  // Parse versions separated by dots or underscores
  const parts = clean.split("_").filter(Boolean);
  if (parts.length >= 1 && parts.length <= 3 && parts.every((p) => /^\d+$/.test(p))) {
    if (parts[0].length > 2 || (parts[1] && parts[1].length > 3) || (parts[2] && parts[2].length > 3)) {
      throw new Error(`Invalid version format: "${ver}". Component numbers exceed allowed length.`);
    }
    const p1 = parts[0].padStart(2, "0");
    const p2 = (parts[1] || "0").padStart(3, "0");
    const p3 = (parts[2] || "0").padStart(3, "0");
    return `${p1}_${p2}_${p3}`;
  }

  throw new Error(`Invalid version format: "${ver}". Expected format like 01.905.000 or 01_905_000.`);
}

/**
 * Returns the normalized version with standard dots (e.g. '01.905.000').
 * Accepts dots, underscores, and variable component lengths (e.g. '1.018' -> '01.018.000').
 */
export function normalizeVersionToDisplay(ver) {
  return normalizeVersionToFilename(ver).replace(/_/g, ".");
}

/**
 * Validates a title ID (e.g. PPSA01325).
 */
export function validateTitleId(id) {
  const clean = cleanInputString(id).toUpperCase().replace(/[-_\s]/g, "");
  if (!/^[A-Z]{4}\d{5}$/.test(clean)) {
    throw new Error(`Invalid Title ID: "${id}". Expected format like PPSA01325.`);
  }
  return clean;
}

/**
 * Finds the next available incrementing filename for a PPSA and version.
 * Checks all existing files for the PPSA and version to ensure no duplicate indices.
 */
export async function getNextModuleFilename(categoryDir, ppsa, versionUnderScore, gameName) {
  let existingFiles = [];
  try {
    existingFiles = await readdir(categoryDir);
  } catch {
    existingFiles = [];
  }

  let maxIndex = 0;

  for (const file of existingFiles) {
    const match = file.match(STRICT_FILENAME_REGEX);
    if (match && match[1] === ppsa && match[2] === versionUnderScore) {
      const idx = parseInt(match[4], 10);
      if (idx > maxIndex) maxIndex = idx;
    }
  }

  const nextIndex = maxIndex + 1;
  return `${ppsa}_${versionUnderScore}_${gameName}_${nextIndex}.json`;
}

/**
 * Validates module JSON content structure.
 */
export function validateModuleJson(parsed, expectedId = null, expectedVersion = null, { isStrict = true, category = null } = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Module file must be a JSON object.");
  }

  if (parsed.name !== undefined && typeof parsed.name !== "string") {
    throw new Error("Field 'name' in module JSON must be a string.");
  }
  if (parsed.title !== undefined && typeof parsed.title !== "string") {
    throw new Error("Field 'title' in module JSON must be a string.");
  }

  const rawTitle = typeof parsed.name === "string" ? parsed.name : typeof parsed.title === "string" ? parsed.title : "";
  const title = rawTitle.trim();

  if (isStrict) {
    if (!parsed.id) throw new Error("Missing required field 'id' in module JSON.");
    if (!parsed.version) throw new Error("Missing required field 'version' in module JSON.");
    if (typeof parsed.version === "string" && parsed.version.includes("_")) {
      throw new Error(
        `Version in JSON ("${parsed.version}") must not use underscores; use standard dot notation (e.g. "${normalizeVersionToDisplay(parsed.version)}").`
      );
    }
    if (!title) throw new Error("Missing required field 'name' or 'title' in module JSON.");
  }

  if (expectedId && parsed.id) {
    const jsonId = String(parsed.id).trim().toUpperCase().replace(/[-_\s]/g, "");
    if (jsonId !== expectedId) {
      throw new Error(`Title ID in JSON ("${jsonId}") does not match expected "${expectedId}".`);
    }
  }

  if (expectedVersion && parsed.version) {
    // Automatically converts dots to underscores before comparing
    const jsonVer = normalizeVersionToFilename(parsed.version);
    const expVer = normalizeVersionToFilename(expectedVersion);
    if (jsonVer !== expVer) {
      throw new Error(`Version in JSON ("${parsed.version}") does not match expected "${expectedVersion}".`);
    }
  }

  if (category === "patches" || category === "cheats") {
    if (isStrict && (!Array.isArray(parsed.mods) || parsed.mods.length === 0)) {
      throw new Error(`Field 'mods' must be a non-empty array for ${category}.`);
    }
  }

  // If mods array is present in any module, validate structure
  if (parsed.mods !== undefined) {
    if (!Array.isArray(parsed.mods)) {
      throw new Error("Field 'mods' must be an array.");
    }
    for (const [i, mod] of parsed.mods.entries()) {
      if (!mod || typeof mod !== "object" || Array.isArray(mod)) {
        throw new Error(`mods[${i}] must be an object.`);
      }
      if (typeof mod.name !== "string" || !mod.name.trim()) {
        throw new Error(`mods[${i}].name must be a non-empty string.`);
      }
      if (mod.enabled !== undefined && typeof mod.enabled !== "boolean") {
        throw new Error(`mods[${i}].enabled must be a boolean.`);
      }
      if (mod.memory !== undefined) {
        if (!Array.isArray(mod.memory)) {
          throw new Error(`mods[${i}].memory must be an array.`);
        }
        for (const [j, mem] of mod.memory.entries()) {
          if (!mem || typeof mem !== "object" || Array.isArray(mem)) {
            throw new Error(`mods[${i}].memory[${j}] must be an object.`);
          }
          if (typeof mem.offset !== "string" || !/^0x[0-9a-fA-F]+$/i.test(mem.offset.trim())) {
            throw new Error(`mods[${i}].memory[${j}].offset must be a hex address string like '0x1234'.`);
          }
          const addr = BigInt(mem.offset.trim());
          if (addr <= 0n || addr > 0x7FFFFFFFFFFFn) {
            throw new Error(`mods[${i}].memory[${j}].offset (${mem.offset.trim()}) is out of valid memory range.`);
          }
          if (typeof mem.on !== "string" || !/^[0-9a-fA-F]+$/.test(mem.on.trim()) || mem.on.trim().length % 2 !== 0) {
            throw new Error(`mods[${i}].memory[${j}].on must be an even-length hex string.`);
          }
          if (typeof mem.off !== "string" || !/^[0-9a-fA-F]+$/.test(mem.off.trim()) || mem.off.trim().length % 2 !== 0) {
            throw new Error(`mods[${i}].memory[${j}].off must be an even-length hex string.`);
          }
          if (mem.on.trim().length !== mem.off.trim().length) {
            throw new Error(`mods[${i}].memory[${j}]: 'on' length (${mem.on.length}) must equal 'off' length (${mem.off.length}).`);
          }
        }
      }
    }
  }

  return true;
}
