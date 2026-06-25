// ─────────────────────────────────────────────────────────────────────────────
// HR Board Studio — compliance filter
//
// Pure, no-I/O helper. Scans generated social copy for prohibited
// promo / profit-promise language and rewrites it into safer "signal board"
// vocabulary. Every generated asset runs its body copy through `applyCompliance`
// before it leaves the server, so risky language never reaches the admin.
//
// Block list and safe-replacement vocabulary are fixed by the product spec.
// ─────────────────────────────────────────────────────────────────────────────

import type { ComplianceResult, ComplianceStatus } from "../../shared/hrBoardStudio";

/**
 * Prohibited terms → safe replacements. Order matters: multi-word phrases are
 * listed before any single-word terms they contain so the longer match wins.
 * Matching is case-insensitive and whole-phrase (word-boundary) to avoid
 * mangling substrings (e.g. "blockbuster" must not match "lock").
 */
const REPLACEMENTS: Array<{ term: string; safe: string }> = [
  { term: "guaranteed", safe: "confirmation" },
  { term: "free money", safe: "watchlist" },
  { term: "can't lose", safe: "not betting advice" },
  { term: "cant lose", safe: "not betting advice" },
  { term: "bet this now", safe: "movement" },
  { term: "max bet", safe: "danger window" },
  { term: "mortgage", safe: "profile" },
  { term: "risk-free", safe: "radar" },
  { term: "risk free", safe: "radar" },
  { term: "sure thing", safe: "setup" },
  // Single word — kept last so phrases above win first.
  { term: "lock", safe: "signal" },
];

/** Public, ordered list of blocked terms (canonical spelling per spec). */
export const HR_BOARD_BLOCKED_TERMS: string[] = [
  "lock",
  "guaranteed",
  "free money",
  "can't lose",
  "bet this now",
  "max bet",
  "mortgage",
  "risk-free",
  "sure thing",
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a word-boundary, case-insensitive matcher for a term. We use lookaround
// rather than \b because some terms contain punctuation/hyphens ("risk-free",
// "can't lose") where \b behaves inconsistently.
function termRegex(term: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(term)}(?![A-Za-z0-9])`, "gi");
}

/**
 * Return the list of blocked terms found in `text` (canonicalized to the
 * spec spelling). Read-only — does not transform the text.
 */
export function scanForBlockedTerms(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const { term } of REPLACEMENTS) {
    if (termRegex(term).test(text)) {
      // Canonicalize "cant lose" → "can't lose", "risk free" → "risk-free".
      const canonical =
        term === "cant lose" ? "can't lose" : term === "risk free" ? "risk-free" : term;
      found.add(canonical);
    }
  }
  return Array.from(found);
}

/**
 * Run compliance over a copy string. Returns the flag status, the list of
 * blocked terms detected, and a rewritten `safeCopy` with every prohibited
 * term replaced by its safe alternative.
 */
export function applyCompliance(text: string): ComplianceResult {
  const input = text ?? "";
  const blockedTerms = scanForBlockedTerms(input);
  let safeCopy = input;
  for (const { term, safe } of REPLACEMENTS) {
    safeCopy = safeCopy.replace(termRegex(term), (match) => preserveCase(match, safe));
  }
  const complianceStatus: ComplianceStatus = blockedTerms.length > 0 ? "flagged" : "clean";
  return { complianceStatus, blockedTerms, safeCopy };
}

// Mirror the leading capitalization of the matched token onto the replacement
// so sentence-start substitutions stay grammatical.
function preserveCase(match: string, replacement: string): string {
  if (match.length > 0 && match[0] === match[0].toUpperCase() && /[a-z]/i.test(match[0])) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
