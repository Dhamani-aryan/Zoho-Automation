import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const ALLOWED_ROOTS = ["imports/samples", "source_docs", "workflows", "reference/heysnap"] as const;
const ALLOWED_EXTENSIONS = new Set([".md", ".txt", ".csv", ".json"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 6000;

export type WorkspaceFileReadArgs = {
  path: string;
  start_line?: number;
  max_lines?: number;
};

export function workspaceRootFromCwd(cwd: string) {
  return cwd;
}

function uniqueRoots(roots: string[]) {
  return [...new Set(roots.map((root) => resolve(root)))];
}

function searchRoots(workspaceRoot: string) {
  const root = resolve(workspaceRoot);
  if (basename(root).toLowerCase() === "zoho-agent") return uniqueRoots([root, dirname(root)]);
  const childRepo = resolve(root, "zoho-agent");
  return existsSync(childRepo) ? uniqueRoots([childRepo, root]) : [root];
}

function isInsideRoot(root: string, candidate: string) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveAttachmentPath(requestedPath: string) {
  const candidate = resolve(requestedPath);
  const attachmentRoot = resolve(homedir(), ".codex", "attachments");
  if (!isInsideRoot(attachmentRoot, candidate)) {
    throw new Error("Absolute workspace file paths are only allowed under the local Codex attachments folder.");
  }
  return candidate;
}

export function resolveWorkspaceFilePath(workspaceRoot: string, requestedPath: string) {
  const normalized = requestedPath.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Workspace file path must be a non-empty relative path.");
  }

  const extension = extname(normalized).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Workspace file type is not allowed: ${extension || "(none)"}.`);
  }

  if (isAbsolute(requestedPath) || /^[a-z]:/i.test(requestedPath)) {
    return resolveAttachmentPath(requestedPath);
  }

  let firstAllowedCandidate: string | null = null;
  for (const root of searchRoots(workspaceRoot)) {
    const candidate = resolve(root, normalized);
    const allowed = ALLOWED_ROOTS.some((allowedRoot) => {
      const absoluteAllowedRoot = resolve(root, allowedRoot);
      return candidate === absoluteAllowedRoot || candidate.startsWith(`${absoluteAllowedRoot}${sep}`);
    });
    if (!allowed || !isInsideRoot(root, candidate)) continue;
    firstAllowedCandidate ??= candidate;
    if (existsSync(candidate)) return candidate;
  }

  if (!firstAllowedCandidate) {
    throw new Error(`Workspace file path is outside allowed roots: ${ALLOWED_ROOTS.join(", ")}.`);
  }
  return firstAllowedCandidate;
}

export async function readWorkspaceTextFile(workspaceRoot: string, args: WorkspaceFileReadArgs) {
  const absolutePath = resolveWorkspaceFilePath(workspaceRoot, args.path);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Workspace path is not a file.");
  if (fileStat.size > MAX_FILE_BYTES) throw new Error(`Workspace file exceeds ${MAX_FILE_BYTES} bytes.`);

  const raw = await readFile(absolutePath, "utf8");
  if (raw.includes("\0")) throw new Error("Workspace file appears to be binary.");
  const lines = raw.split(/\r?\n/);
  const startLine = Math.min(Math.max(Math.floor(args.start_line ?? 1), 1), Math.max(lines.length, 1));
  const maxLines = Math.min(Math.max(Math.floor(args.max_lines ?? 100), 1), 200);
  const selected: string[] = [];
  let chars = 0;
  let index = startLine - 1;
  for (; index < lines.length && selected.length < maxLines; index += 1) {
    const line = lines[index] ?? "";
    const available = MAX_OUTPUT_CHARS - chars;
    if (available <= 0) break;
    if (line.length + 1 > available) {
      if (selected.length === 0) selected.push(line.slice(0, available));
      break;
    }
    selected.push(line);
    chars += line.length + 1;
  }

  const endLine = startLine + selected.length - 1;
  const hasMore = endLine < lines.length;
  return {
    source: "workspace_file",
    path: args.path.replace(/\\/g, "/"),
    start_line: startLine,
    end_line: endLine,
    total_lines: lines.length,
    next_start_line: hasMore ? endLine + 1 : null,
    content: selected.join("\n")
  };
}
