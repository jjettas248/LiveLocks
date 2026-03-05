export const normalizeTier = (raw?: string | null): "free" | "pro_nba" | "pro_all" => {
  if (!raw) return "free";
  const t = raw.toString().toLowerCase().trim();
  if (
    t.includes("all_sports") ||
    t.includes("all sports") ||
    t.includes("pro_all") ||
    t === "all" ||
    t === "elite"
  ) return "pro_all";
  if (
    t.includes("nba") ||
    t.includes("pro") ||
    t.includes("25") ||
    t.includes("40") ||
    t.includes("49") ||
    t.includes("50") ||
    t === "1" ||
    t === "subscriber"
  ) return "pro_nba";
  return "free";
};

export const hasProAccess = (raw?: string | null): boolean => {
  const t = normalizeTier(raw);
  return t === "pro_nba" || t === "pro_all";
};
