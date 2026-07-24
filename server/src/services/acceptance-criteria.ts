function extractMarkdownSection(markdown: string | null | undefined, heading: string): string | null {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionPattern = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const section = sectionPattern.exec(markdown)?.[1]?.trim();
  return section || null;
}

export function extractExplicitAcceptanceCriteria(markdown: string | null | undefined): string[] {
  const section = extractMarkdownSection(markdown, "Acceptance Criteria");
  if (!section) return [];

  const criteria: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const match = /^(?:[-*+]|\d+[.)])[ \t]+(.+?)\s*$/.exec(line);
    if (match?.[1]) criteria.push(match[1].trim());
  }
  return criteria;
}

export { extractMarkdownSection };
