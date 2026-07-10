export const CORE_SKILL_GUIDE_NAMES = [
  "email-scheduling",
  "deals-editing",
  "contacts-editing",
  "accounts-editing"
] as const;

type CoreGuideName = (typeof CORE_SKILL_GUIDE_NAMES)[number];

const CORE_GUIDE_PATTERNS: Array<{ name: CoreGuideName; patterns: RegExp[] }> = [
  {
    name: "email-scheduling",
    patterns: [
      /\bemail(?:s|ing)?\b/i,
      /\bcompose(?:r)?\b/i,
      /\bschedul(?:e|ed|ing)\b/i,
      /\bsubject\b/i,
      /\brecipient\b/i,
      /\bcc\b/i,
      /\bsignature\b/i
    ]
  },
  { name: "deals-editing", patterns: [/\bdeal(?:s)?\b/i, /\bpotential(?:s)?\b/i, /\bnext step\b/i] },
  { name: "contacts-editing", patterns: [/\bcontact(?:s)?\b/i, /\bperson\b/i, /\bpeople\b/i] },
  { name: "accounts-editing", patterns: [/\baccount(?:s)?\b/i, /\bcompan(?:y|ies)\b/i] }
];

function namesForText(text: string) {
  return CORE_GUIDE_PATTERNS.filter((route) => route.patterns.some((pattern) => pattern.test(text))).map(
    (route) => route.name
  );
}

export function routeCoreSkillGuides(currentContent: string, recentUserContents: string[] = []) {
  const currentNames = namesForText(currentContent);
  if (currentNames.length > 0) return { names: currentNames, source: "current" as const };

  for (let index = recentUserContents.length - 1; index >= 0; index -= 1) {
    const names = namesForText(recentUserContents[index] ?? "");
    if (names.length > 0) return { names, source: "recent" as const };
  }

  return { names: [] as CoreGuideName[], source: "none" as const };
}
