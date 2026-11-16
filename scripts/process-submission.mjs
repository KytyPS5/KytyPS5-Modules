import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  cleanInputString,
  sanitizeGameName,
  validateTitleId,
  normalizeVersionToFilename,
  normalizeVersionToDisplay,
  getNextModuleFilename,
  validateModuleJson,
  CATEGORY_SINGULAR,
} from "./lib/schema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB max
const ERROR_FILE =
  process.env.SUBMISSION_ERROR_FILE ||
  path.join(os.tmpdir(), "submission-error.txt");

const KNOWN_FIELDS = new Set([
  "title id",
  "game id",
  "game version",
  "version",
  "game name",
  "patch title",
  "cheat title",
  "config title",
  "title",
  "detailed description",
  "description",
  "json file attachment",
]);

function parseIssueFormBody(body) {
  const sections = Object.create(null);
  const escapedFields = Array.from(KNOWN_FIELDS).map((f) =>
    f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  const regex = new RegExp(
    `^###\\s+(${escapedFields.join("|")})\\r?\\n([\\s\\S]*?)(?=^###\\s+(?:${escapedFields.join("|")})|$)`,
    "gim"
  );
  let match;
  while ((match = regex.exec(body)) !== null) {
    const key = match[1].trim().toLowerCase();
    if (!(key in sections)) {
      sections[key] = match[2].trim();
    }
  }
  return sections;
}

function cleanFieldValue(val) {
  if (val === null || val === undefined) return undefined;
  const cleaned = cleanInputString(val);
  if (!cleaned || cleaned.toLowerCase() === "_no response_") return undefined;
  return cleaned;
}

function extractAttachmentUrl(text) {
  if (!text) return null;
  // Match markdown link [label](url) or bare URL
  const mdMatch = text.match(
    /\[[^\]]*\]\((https:\/\/github\.com\/(?:[^\s)]+?)\.json(?:[?#][^\s)]*)?)\)/i
  );
  const candidate = mdMatch ? mdMatch[1] : null;

  const urlToTest = candidate || (text.match(/https:\/\/github\.com\/[^\s)]+?\.json(?:[?#][^\s)]*)?/i)?.[0] ?? null);
  if (!urlToTest) return null;

  try {
    const parsed = new URL(urlToTest);
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "github.com") return null;

    // Disallow path traversal
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.includes("..") || segments.includes(".")) return null;

    // Must be either user-attachments/files/... or <owner>/<repo>/files/...
    const isUserAttachments = segments[0] === "user-attachments" && segments[1] === "files";
    const isRepoFiles = segments.length >= 4 && segments[2] === "files";
    if (!isUserAttachments && !isRepoFiles) return null;

    // Path must end with .json before any query parameters
    if (!parsed.pathname.toLowerCase().endsWith(".json")) return null;

    return parsed.href;
  } catch {
    return null;
  }
}

async function writeFailure(msg) {
  try {
    const sanitized = String(msg || "")
      .replace(/[`$"\\<>{}]/g, "")
      .trim()
      .slice(0, 500);
    await writeFile(ERROR_FILE, sanitized, "utf8");
  } catch {}
}

function formatOutput(key, value) {
  const str = String(value ?? "");
  if (str.includes("\n")) {
    const delimiter = `EOF_${randomUUID().replace(/-/g, "")}`;
    return `${key}<<${delimiter}\n${str}\n${delimiter}`;
  }
  return `${key}=${str}`;
}

async function run() {
  const eventName = process.env.EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  let event = {};
  if (eventPath) {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  }

  if (eventName !== "issues") {
    throw new Error(`Only Issue Form submissions are supported. Received event: ${eventName}`);
  }

  const issue = event.issue || {};
  const author = issue.user?.login || "community";
  const authorAssociation = issue.author_association || "NONE";
  const issueNumber = issue.number || 0;

  const sections = parseIssueFormBody(issue.body || "");
  const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));

  let category = "patches";
  if (labels.includes("cheat")) {
    category = "cheats";
  } else if (labels.includes("config")) {
    category = "configs";
  } else if (labels.includes("patch")) {
    category = "patches";
  } else if (issue.title?.toLowerCase().includes("[cheat]")) {
    category = "cheats";
  } else if (issue.title?.toLowerCase().includes("[config]")) {
    category = "configs";
  } else {
    category = "patches";
  }

  const rawTitleId = cleanFieldValue(sections["title id"] || sections["game id"]);
  const rawVersion = cleanFieldValue(sections["game version"] || sections["version"]);
  const gameNameInput = cleanFieldValue(sections["game name"]);
  const modTitle = cleanFieldValue(
    sections["patch title"] || sections["cheat title"] || sections["config title"] || sections["title"]
  );
  const description = cleanFieldValue(sections["detailed description"] || sections["description"]) || "";
  const attachmentField = (sections["json file attachment"] || "").trim();

  if (!rawTitleId) throw new Error("Missing Title ID (e.g. PPSA01325).");
  if (!rawVersion) throw new Error("Missing Version (e.g. 01.905.000 or 01_905_000).");

  const ppsa = validateTitleId(rawTitleId);
  // Automatically convert dots to underscores from the version section
  const version = normalizeVersionToFilename(rawVersion);

  let jsonText = "";

  // Strip markdown code fences if user pasted raw JSON
  const cleanAttachment = attachmentField.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();

  if (cleanAttachment.startsWith("{") && cleanAttachment.endsWith("}")) {
    jsonText = cleanAttachment;
  } else {
    const attachmentUrl =
      extractAttachmentUrl(cleanAttachment) ||
      extractAttachmentUrl(issue.body || "");
    if (!attachmentUrl) {
      throw new Error(
        "No valid GitHub attachment link or inline JSON found in submission. Please upload a .json file or paste valid JSON."
      );
    }

    console.log(`[INFO] Fetching attachment from: ${attachmentUrl}`);
    // Enforce 15-second timeout and DO NOT send auth headers to pre-signed URLs
    const res = await fetch(attachmentUrl, {
      headers: { "User-Agent": "kytyps5-modules-bot" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`Failed to download attached JSON (${res.status} ${res.statusText}).`);
    }

    // Stream download with byte counter to prevent memory exhaustion even if Content-Length is missing
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of res.body) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `Attachment exceeds maximum allowed size of 5 MB (${(totalBytes / 1024 / 1024).toFixed(1)} MB).`
        );
      }
      chunks.push(chunk);
    }
    jsonText = Buffer.concat(chunks).toString("utf8");
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Attached file is not valid JSON: ${err.message}`);
  }

  if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    throw new Error("Attached file must be a JSON object.");
  }

  // Populate/enrich basic metadata if missing before strict validation
  if (!parsedJson.id) parsedJson.id = ppsa;
  // Store version in JSON payload normally with dots
  parsedJson.version = normalizeVersionToDisplay(parsedJson.version || version);
  if (modTitle && !parsedJson.name && !parsedJson.title) parsedJson.name = modTitle;
  if (description && !parsedJson.description) parsedJson.description = description;
  // Preserve original author/creator if already specified in JSON
  if (!parsedJson.author && !parsedJson.creator) {
    parsedJson.author = author;
  }

  validateModuleJson(parsedJson, ppsa, version, { isStrict: true, category });

  // If game name wasn't explicitly supplied, try parsing from JSON name or fallback to PPSA
  const resolvedGameName = sanitizeGameName(
    gameNameInput || parsedJson.name || parsedJson.gameName || ppsa,
    ppsa
  );

  const categoryDir = path.join(root, category, "json");
  await mkdir(categoryDir, { recursive: true });

  const filename = await getNextModuleFilename(categoryDir, ppsa, version, resolvedGameName);
  const targetFilePath = path.join(categoryDir, filename);

  await writeFile(targetFilePath, JSON.stringify(parsedJson, null, 2) + "\n");
  console.log(`[INFO] Successfully written module to ${category}/json/${filename}`);

  const singular = CATEGORY_SINGULAR[category] || category;
  // Only grant collaborator status to repository owners or direct collaborators (not blanket organization members)
  const isCollaborator = ["OWNER", "COLLABORATOR"].includes(authorAssociation);
  const branchSuffix = `${singular}-${ppsa}-${version}-i${issueNumber}`;

  // Sanitize PR title: single line, no backticks/quotes, max 80 chars
  const safeModTitle = (modTitle || parsedJson.name || resolvedGameName)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["`]/g, "")
    .trim()
    .slice(0, 80);
  const prTitle = `${category}: ${ppsa} (${version}) - ${safeModTitle} (@${author})`;

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const outputs = [
      formatOutput("category", category),
      formatOutput("title_id", ppsa),
      formatOutput("version", version),
      formatOutput("filename", filename),
      formatOutput("branch_suffix", branchSuffix),
      formatOutput("pr_title", prTitle),
      formatOutput("author", author),
      formatOutput("is_collaborator", isCollaborator ? "true" : "false"),
    ].join("\n") + "\n";
    await writeFile(out, outputs, { flag: "a" });
  }

  console.log("[INFO] Submission processed successfully.");
}

run().catch(async (err) => {
  console.error(`[ERROR] ${err.message}`);
  await writeFailure(err.message);
  process.exit(1);
});
