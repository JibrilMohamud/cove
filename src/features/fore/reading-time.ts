/** Population planning assumptions, not a promise about an individual reader. */
export const READING_TIME_POLICY = "cove-reading-time-v1";
export function countReadingUnits(text: string, language: string) {
  const cjk = /^(zh|ja|ko)(-|$)/i.test(language);
  if (cjk) {
    const characters =
      text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
    const rest = text.replace(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
      " ",
    );
    return characters.length + (rest.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  }
  return (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
}
export type ReadingTimeInput = {
  language: string;
  wordCount?: number | null;
  pageEstimate?: number | null;
  textUnits?: number;
  truncated?: boolean;
};
export function estimateReadingTime(input: ReadingTimeInput) {
  const cjk = /^(zh|ja|ko)(-|$)/i.test(input.language);
  const rate = cjk ? 500 : 250,
    slow = cjk ? 300 : 180,
    fast = cjk ? 700 : 320;
  const text = input.textUnits !== undefined;
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
  return {
    policy: READING_TIME_POLICY,
    method,
    estimatedMinutes: Math.max(1, Math.ceil(units / rate)),
    rangeMinutes: [
      Math.max(1, Math.ceil((units * uncertainty[0]) / fast)),
      input.truncated ? null : Math.max(1, Math.ceil((units * uncertainty[1]) / slow)),
    ],
    lowerBoundOnly: !!input.truncated,
    measuredUnits: text ? units : null,
    wordCount: text && !cjk ? units : suppliedWords ? input.wordCount! : null,
    unit: cjk ? "characters_and_non_cjk_words" : "words",
    assumedUnitsPerMinute: rate,
    confidence: text ? (input.truncated ? 0.35 : 0.9) : suppliedWords ? 0.65 : pages ? 0.35 : 0.1,
    language: input.language,
    personalized: false,
  };
}
