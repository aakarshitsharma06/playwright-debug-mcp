import * as path from 'path';
import * as fs from 'fs';

// Only allow reading these file extensions
const ALLOWED_EXTENSIONS = new Set(['.zip', '.json']);

// Known dangerous sensitive paths that should never be read
const SENSITIVE_PATH_PATTERNS = [
  /\/\.ssh\//i,
  /\/\.aws\//i,
  /\/\.gnupg\//i,
  /\/\.env/i,
  /\/\.git\//i,
  /\/Library\/Keychains\//i,
  /\/Library\/Application Support\/.*credentials/i,
  /\/\.config\/gcloud\//i,
  /mcp_config\.json$/i,
];

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Validates that a given file path is safe to read.
 * Throws a SecurityError if any check fails.
 */
export function validateFilePath(rawPath: string, expectedExtension: '.zip' | '.json'): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new SecurityError('File path must be a non-empty string.');
  }

  // Resolve to an absolute, canonical path (eliminates ../ traversal tricks)
  const resolved = path.resolve(rawPath);

  // Block if the canonical path is different from what was resolved
  // (this catches tricks like /foo/../../../etc/passwd)
  if (resolved.includes('..')) {
    throw new SecurityError(`Path traversal detected in path: ${rawPath}`);
  }

  // Enforce allowed extension
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new SecurityError(
      `Disallowed file extension "${ext}". Only ${[...ALLOWED_EXTENSIONS].join(', ')} are permitted.`
    );
  }

  // Enforce the specific expected extension for this call
  if (ext !== expectedExtension) {
    throw new SecurityError(
      `Expected a ${expectedExtension} file but received a ${ext} file.`
    );
  }

  // Block known sensitive paths
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      throw new SecurityError(
        `Access denied: the path "${resolved}" matches a protected system path.`
      );
    }
  }

  // Ensure the file actually exists before returning
  if (!fs.existsSync(resolved)) {
    throw new SecurityError(`File not found at path: ${resolved}`);
  }

  return resolved;
}
