/** Population planning assumptions, not a promise about an individual reader. */
export const READING_TIME_POLICY = "cove-reading-time-v2";
const cjkLanguage = (language: string) => /^(zh|ja|ko)(-|$)/i.test(language);
const dictionaryLocale = (language: string) =>
  /^(th|lo|km|my)(-|$)/i.exec(language)?.[1].toLowerCase();
function dictionaryAvailable(language: string) {
  const locale = dictionaryLocale(language);
  return (
    !!locale &&
    typeof Intl.Segmenter === "function" &&
    Intl.Segmenter.supportedLocalesOf([locale]).length > 0
  );
}
const wordTokens = (text: string) =>
  (text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu) || [])
    .length;
export function countReadingUnits(text: string, language: string) {
  if (cjkLanguage(language)) {
    const script = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
    return (text.match(script) || []).length + wordTokens(text.replace(script, " "));
  }
  const locale = dictionaryLocale(language);
  if (locale) {
    if (dictionaryAvailable(language)) {
      let count = 0;
      for (const segment of new Intl.Segmenter(locale, { granularity: "word" }).segment(text))
        if (segment.isWordLike) count++;
      return count;
    }
    // Never label a dictionary-unavailable character fallback as measured words.
    return (text.match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
  }
  return wordTokens(text);
}
export type ReadingTimeInput = {
  language: string;
  wordCount?: number | null;
  pageEstimate?: number | null;
  textUnits?: number;
  truncated?: boolean;
};
export function estimateReadingTime(input: ReadingTimeInput) {
  const cjk = cjkLanguage(input.language);
  const text = input.textUnits !== undefined;
  const characterFallback =
    text && !!dictionaryLocale(input.language) && !dictionaryAvailable(input.language);
  const characters = cjk || characterFallback;
  const rate = characters ? 500 : 250,
    slow = characters ? 300 : 180,
    fast = characters ? 700 : 320;
  const suppliedWords = !cjk && !!input.wordCount && input.wordCount > 0;
  const pages = !!input.pageEstimate && input.pageEstimate > 0;
  const units = text
    ? input.textUnits!
    : suppliedWords
      ? input.wordCount!
      : pages
        ? input.pageEstimate! * (cjk ? 600 : 250)
        : cjk
          ? 180000
          : 75000;
  const method = text
    ? input.truncated
      ? "partial_text_lower_bound"
      : "epub_text"
    : suppliedWords
      ? "publisher_word_count"
      : pages
        ? "publisher_page_estimate"
        : "catalog_prior";
  const uncertainty = text || suppliedWords ? [1, 1] : pages ? [0.7, 1.3] : [0.2, 2.5];
  const seconds = (count: number, speed: number) =>
    Math.max(1, Number(((count * 60) / speed).toFixed(3)));
  return {
    policy: READING_TIME_POLICY,
    method,
    estimatedMinutes: Math.max(1, Math.ceil(units / rate)),
    estimatedSeconds: seconds(units, rate),
    rangeMinutes: [
      Math.max(1, Math.ceil((units * uncertainty[0]) / fast)),
      input.truncated ? null : Math.max(1, Math.ceil((units * uncertainty[1]) / slow)),
    ],
    rangeSeconds: [
      seconds(units * uncertainty[0], fast),
      input.truncated ? null : seconds(units * uncertainty[1], slow),
    ],
    lowerBoundOnly: !!input.truncated,
    measuredUnits: text ? units : null,
    wordCount: text && !characters ? units : suppliedWords ? input.wordCount! : null,
    unit: cjk
      ? "characters_and_non_cjk_words"
      : characterFallback
        ? "unicode_code_points"
        : "words",
    segmentation: cjk
      ? "script_characters"
      : characterFallback
        ? "character_fallback"
        : dictionaryLocale(input.language)
          ? "dictionary_word_boundaries"
          : "unicode_word_tokens",
    assumedUnitsPerMinute: rate,
    confidence: text
      ? characterFallback
        ? 0.25
        : input.truncated
          ? 0.35
          : 0.9
      : suppliedWords
        ? 0.65
        : pages
          ? 0.35
          : 0.1,
    language: input.language,
    personalized: false,
  };
}
