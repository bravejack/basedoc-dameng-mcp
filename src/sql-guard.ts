export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

const ALLOWED_LEADING = new Set(["SELECT", "WITH", "EXPLAIN"]);

export function ensureReadOnly(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new SqlGuardError("Empty SQL");
  }

  if (containsAdditionalStatement(trimmed)) {
    throw new SqlGuardError("Multiple statements are not allowed");
  }

  const withoutTrailingSemi = stripTrailingSemicolon(trimmed);
  const head = stripLeadingCommentsAndWhitespace(withoutTrailingSemi);
  const firstWord = head.match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0];

  if (!firstWord) {
    throw new SqlGuardError("Could not determine statement type");
  }
  if (!ALLOWED_LEADING.has(firstWord.toUpperCase())) {
    throw new SqlGuardError(
      `Statement type ${firstWord.toUpperCase()} is not allowed; only SELECT/WITH/EXPLAIN`,
    );
  }

  return withoutTrailingSemi;
}

function stripTrailingSemicolon(s: string): string {
  return s.endsWith(";") ? s.slice(0, -1).trimEnd() : s;
}

function stripLeadingCommentsAndWhitespace(s: string): string {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return "";
      i = end + 2;
      continue;
    }
    return s.slice(i);
  }
  return "";
}

function containsAdditionalStatement(s: string): boolean {
  // Walk the string honoring quotes and comments. If we see a `;` and any
  // non-whitespace, non-comment content follows it, that is a second statement.
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < n) {
        if (s[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          if (s[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    if (ch === ";") {
      const rest = stripLeadingCommentsAndWhitespace(s.slice(i + 1));
      return rest.length > 0;
    }
    i++;
  }
  return false;
}
