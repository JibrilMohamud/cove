import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

type Book = {
  id: number;
  title: string;
  cover_url: string | null;
  authors: { name: string }[] | null;
};

export function BookCover({
  book,
  size = "md",
  showMeta = true,
  progress,
}: {
  book: Book;
  size?: "sm" | "md" | "lg";
  showMeta?: boolean;
  progress?: number;
}) {
  const dims = { sm: "w-24", md: "w-32", lg: "w-40" }[size];
  const author = book.authors?.[0]?.name?.split(",")[0] ?? "Unknown";

  return (
    <Link
      to="/book/$id"
      params={{ id: String(book.id) }}
      className={cn("group block shrink-0", dims)}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-md shadow-book transition-transform duration-300 group-active:scale-95 group-hover:-translate-y-0.5">
        {book.cover_url ? (
          <img
            src={book.cover_url}
            alt={`Cover of ${book.title}`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-navy p-3 text-center">
            <span className="font-serif text-sm leading-tight text-primary line-clamp-4">
              {book.title}
            </span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-r from-black/40 to-transparent" />
        {progress != null && progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/35">
            <div
              className="h-full bg-white/90"
              style={{ width: `${Math.max(2, Math.min(100, progress * 100))}%` }}
            />
          </div>
        )}
      </div>
      {showMeta && (
        <div className="mt-2 space-y-0.5">
          <p className="text-sm font-medium leading-tight line-clamp-2">{book.title}</p>
          <p className="text-xs text-muted-foreground line-clamp-1">{author}</p>
          {progress != null && progress > 0 && progress < 1 && (
            <p className="text-[10px] font-semibold text-primary">
              {Math.round(progress * 100)}% complete
            </p>
          )}
        </div>
      )}
    </Link>
  );
}
