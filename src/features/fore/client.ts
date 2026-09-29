import { createContext, useContext } from "react";
export type CatalogBook = {
  /** Canonical Cove public product identifier. Source-system identifiers live in sourceExternalId. */
  id: string | number;
  sourceExternalId?: string;
  productId?: string;
  editionId?: string;
  workId?: string;
  publicProductId?: string;
  publicEditionId?: string;
  publicWorkId?: string;
  externalIdentifiers?: { product?: Record<string,string>; edition?: Record<string,string>; work?: Record<string,string> };
  sourceName?: string;
  sourceProject?: string;
  sourceUrl?: string;
  sourceLicenseUrl?: string;
  title: string;
  subtitle?: string;
  authors: { id?: string; slug?: string; name: string }[];
  contributors?: { id?: string; slug?: string; name: string; role?: string; position?: number }[];
  summaries?: string[];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  formats: Record<string, string>;
  download_count: number;
  copyright?: boolean;
  uploaded?: boolean;
  publisher?: string;
  publisherId?: string;
  publisherSlug?: string;
  imprint?: string;
  imprintId?: string;
  imprintSlug?: string;
  isbn13?: string;
  publicationDate?: string;
  originalPublicationDate?: string;
  releaseDate?: string;
  preorderDate?: string;
  editionNumber?: string;
  originalLanguage?: string;
  ageRange?: { min?: number; max?: number };
  contentWarnings?: string[];
  pageEstimate?: number;
  wordCount?: number;
  readingTimeMinutes?: number;
  fileSizeBytes?: number;
  epubVersion?: string;
  layout?: string;
  drmStatus?: string;
  downloadable?: boolean;
  releaseStatus?: string;
  subscriptionEligible?: boolean;
  libraryEligible?: boolean;
  publisherDescription?: string;
  editorialReviews?: string;
  series?: { id: string; slug?: string; name: string; position?: number; label?: string; relationship?: string; readingOrder?: number }[];
  accessibility?: Record<string, unknown>;
  formatProfile?: Record<string, unknown>;
  offer?: { type?: string; currency?: string; amountMinor?: number };
  aiDisclosure?: { policyVersion?: string; textOrigin?: string; coverOrigin?: string; narrationOrigin?: string; translationOrigin?: string; syntheticVoiceLabel?: string; publicBadges?: { key: string; label: string }[] };
};
export type LibraryBook = {
  bookId: string;
  productId: string;
  book: CatalogBook;
  status: string;
  progress: number;
  cfi: string;
  shelves: string[];
  rating: number | null;
  review: string;
  updatedAt: string;
  version: number;
};
export type Annotation = {
  id: string;
  bookId: string;
  bookTitle: string;
  author: string;
  quote: string;
  cfi: string;
  chapter: string;
  color: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};
export type TextBookmark = {
  id: string;
  bookId: string;
  productId: string;
  cfi: string;
  chapter: string;
  label: string;
  excerpt: string;
  progress: number;
  publicationVersionId?: string | null;
  assetVersionId?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type Definition = {
  id: string;
  word: string;
  phonetic: string;
  meaning: string;
  partOfSpeech: string;
  bookId: string;
  bookTitle: string;
  cfi: string;
  context: string;
  source: string;
  createdAt: string;
};
export type User = { id: string; email: string; name: string; registered: boolean; username?:string };
export type AccountData = {
  user: User | null;
  library: LibraryBook[];
  annotations: Annotation[];
  bookmarks: TextBookmark[];
  definitions: Definition[];
};
export const AccountContext = createContext<{
  data: AccountData;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  signIn: () => void;
  signUp: () => void;
}>({
  data: { user: null, library: [], annotations: [], bookmarks: [], definitions: [] },
  loading: true,
  error: "",
  reload: async () => {},
  signIn: () => {},
  signUp: () => {},
});
export const useAccount = () => useContext(AccountContext);
export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch("/api/fore" + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r
    .json()
    .catch(() => ({ error: "The service returned an unreadable response." }));
  if (!r.ok)
    throw Object.assign(new Error(data.error || "Something went wrong. Please try again."), {
      status: r.status,
    });
  return data;
}
export const authorOf = (b: CatalogBook) =>
  b.authors
    ?.map((a) => {
      const p = a.name.split(",");
      return p.length > 1 ? `${p.slice(1).join(",").trim()} ${p[0]}` : a.name;
    })
    .join(", ") || "Unknown author";
const localCovers = new Set([
  "1342",
  "2701",
  "1661",
  "2641",
  "11",
  "345",
  "1260",
  "84",
  "2852",
  "64317",
  "768",
  "2591",
  "74",
  "98",
  "174",
  "5200",
  "2600",
  "16",
  "4300",
  "120",
  "1400",
  "205",
  "1080",
  "46",
]);
export const coverOf = (b: CatalogBook) => {
  const sourceRef = String(b.sourceExternalId ?? b.id);
  return localCovers.has(sourceRef)
    ? "/covers/" + sourceRef + ".jpg"
    : b.formats?.["image/jpeg"] || b.formats?.["image/png"] || "";
};
export const bookPath = (id: string | number) => { const ref=String(id); return (ref.startsWith("prd_") ? "/books/" : "/book/") + encodeURIComponent(ref); };
export const productPath = (book: Pick<CatalogBook,"id"|"publicProductId">) => book.publicProductId ? "/books/" + encodeURIComponent(book.publicProductId) : bookPath(book.id);
export const editionPath = (book: Pick<CatalogBook,"id"|"editionId"|"publicEditionId"|"publicProductId">) => book.publicEditionId ? "/edition/" + encodeURIComponent(book.publicEditionId) : book.editionId ? "/edition/" + encodeURIComponent(book.editionId) : productPath(book);
export const authorPath = (author:{id?:string;slug?:string}) => author.id ? "/author/" + encodeURIComponent(author.slug||author.id) : "/store";
export const publisherPath = (book:Pick<CatalogBook,"publisherId"|"publisherSlug">) => book.publisherId ? "/publisher/" + encodeURIComponent(book.publisherSlug||book.publisherId) : "/store";
export const imprintPath = (book:Pick<CatalogBook,"imprintId"|"imprintSlug">) => book.imprintId ? "/imprint/" + encodeURIComponent(book.imprintSlug||book.imprintId) : "/store";
export const seriesPath = (series:{id:string;slug?:string}) => "/series/" + encodeURIComponent(series.slug||series.id);
export const readPath = (id: string | number, cfi?: string) =>
  "/read/" + encodeURIComponent(id) + (cfi ? "?cfi=" + encodeURIComponent(cfi) : "");
export const colors: Record<string, string> = {
  yellow: "#efca62",
  green: "#80bc9b",
  blue: "#7da9e7",
  pink: "#df91a9",
  purple: "#b697df",
};
export function downloadBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}
