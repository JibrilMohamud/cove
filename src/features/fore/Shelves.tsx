import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Lock, Globe, ArrowUp, ArrowDown, Trash2, Share2, Library } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { api, useAccount, bookPath, type CatalogBook } from "./client";
import { AccountGuard } from "./Collections";
import { BookArt } from "./Store";
import type { Shelf } from "./domain";
export function ShelfEditor({
  shelf,
  onClose,
  onSaved,
}: {
  shelf: Partial<Shelf> | null;
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [name, setName] = useState(shelf?.name || ""),
    [description, setDescription] = useState(shelf?.description || ""),
    [visibility, setVisibility] = useState(shelf?.visibility || "private"),
    [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="fore-dialog">
        <DialogTitle>{shelf?.id ? "Edit shelf" : "Create a shelf"}</DialogTitle>
        <DialogDescription>Make a reading list of your own.</DialogDescription>
        <label htmlFor="shelf-name">Name</label>
        <input
          id="shelf-name"
          className="fore-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder="Books for a rainy weekend"
        />
        <label htmlFor="shelf-description">Description</label>
        <textarea
          id="shelf-description"
          className="note-input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
        />
        <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)}>
          <SelectTrigger aria-label="Shelf visibility">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">Private · only you</SelectItem>
            <SelectItem value="public">Public · shareable</SelectItem>
          </SelectContent>
        </Select>
        <button
          className="button gold"
          disabled={busy || !name.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api(
                "/shelves" + (shelf?.id ? "/" + shelf.id : ""),
                shelf?.id ? "PATCH" : "POST",
                { name, description, visibility, ...(shelf?.id ? {expectedVersion:shelf.version} : {}) },
              );
              onSaved(r.id);
              onClose();
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save shelf"}
        </button>
      </DialogContent>
    </Dialog>
  );
}
export function ShelvesPage() {
  const { data } = useAccount();
  const result = useQuery<{ shelves: Shelf[] }>({
    queryKey: ["shelves", data.user?.id],
    queryFn: () => api("/shelves"),
    enabled: !!data.user,
  });
  const [create, setCreate] = useState(false);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="page-eyebrow">YOUR READING LISTS</span>
          <h1>
            Shelves<span className="gold-text">.</span>
          </h1>
          <p>Give your books a place, a theme, a little order.</p>
        </div>
        {data.user && (
          <button className="button gold" onClick={() => setCreate(true)}>
            <Plus size={17} />
            New shelf
          </button>
        )}
      </div>
      <AccountGuard>
        {result.error ? (
          <p className="notice">{result.error.message}</p>
        ) : result.isLoading ? (
          <p>Loading shelves…</p>
        ) : result.data?.shelves.length ? (
          <div className="shelf-grid">
            {result.data.shelves.map((s) => (
              <a className="shelf-card" href={"/shelf/" + s.id} key={s.id}>
                <span className="privacy-label">
                  {s.visibility === "private" ? <Lock size={14} /> : <Globe size={14} />}{" "}
                  {s.visibility}
                </span>
                <Library size={28} />
                <h2>{s.name}</h2>
                <p>{s.description || "A collection of stories."}</p>
                <span>{s.count} books</span>
              </a>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <Library />
            <h2>A shelf for every mood.</h2>
            <p>Create a list, then add books from any book page or your library.</p>
            <button className="button gold" onClick={() => setCreate(true)}>
              Create your first shelf
            </button>
          </div>
        )}
      </AccountGuard>
      {create && (
        <ShelfEditor
          shelf={null}
          onClose={() => setCreate(false)}
          onSaved={() => result.refetch()}
        />
      )}
    </>
  );
}
type ShelfData = {
  shelf: Shelf & { mine: boolean; ownerName: string };
  books: { bookId: string; book: CatalogBook; position: number; note: string }[];
};
export function ShelfPage({ id }: { id: string }) {
  const { data } = useAccount();
  const result = useQuery<ShelfData>({
    queryKey: ["shelf", id, data.user?.id],
    queryFn: () => api("/shelves/" + id),
  });
  const [edit, setEdit] = useState(false),
    [remove, setRemove] = useState(false),
    [choose, setChoose] = useState(""),
    [busy, setBusy] = useState(false);
  async function order(index: number, delta: number) {
    if (!result.data) return;
    const ids = result.data.books.map((b) => b.bookId);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    setBusy(true);
    try {
      await api("/shelves/" + id + "/order", "PUT", { bookIds: ids, expectedVersion:result.data.shelf.version });
      await result.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (result.isLoading) return <p>Opening shelf…</p>;
  if (!result.data)
    return (
      <div className="empty-state">
        <h1>Shelf unavailable</h1>
        <p>{result.error?.message}</p>
        <a href="/shelves" className="button outline">
          Your shelves
        </a>
      </div>
    );
  const { shelf, books } = result.data;
  return (
    <>
      <a className="text-link" href="/shelves">
        ← All shelves
      </a>
      <div className="page-heading shelf-heading">
        <div>
          <span className="privacy-label">
            {shelf.visibility === "private" ? <Lock size={14} /> : <Globe size={14} />}{" "}
            {shelf.visibility} · {shelf.ownerName}
          </span>
          <h1>{shelf.name}</h1>
          <p>{shelf.description}</p>
        </div>
        <div className="inline-actions">
          {shelf.visibility === "public" && (
            <button
              className="button outline"
              onClick={() =>
                navigator.clipboard
                  .writeText(location.href)
                  .then(() => toast.success("Shelf link copied"))
                  .catch(() => toast.error("Copy this page’s address to share."))
              }
            >
              <Share2 size={16} />
              Share
            </button>
          )}
          {shelf.mine && (
            <>
              <button className="button outline" onClick={() => setEdit(true)}>
                Edit shelf
              </button>
              <button
                className="icon-button"
                aria-label="Delete shelf"
                onClick={() => setRemove(true)}
              >
                <Trash2 size={18} />
              </button>
            </>
          )}
        </div>
      </div>
      {shelf.mine && (
        <div className="collection-toolbar">
          <Select value={choose} onValueChange={setChoose}>
            <SelectTrigger aria-label="Choose a library book to add">
              <SelectValue placeholder="Add from your library" />
            </SelectTrigger>
            <SelectContent>
              {data.library
                .filter((b) => !books.some((x) => x.bookId === b.bookId))
                .map((b) => (
                  <SelectItem key={b.bookId} value={b.bookId}>
                    {b.book.title}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <button
            className="button gold"
            disabled={!choose || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/shelves/" + id + "/books", "PUT", { bookId: choose, expectedVersion:shelf.version });
                setChoose("");
                await result.refetch();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Add book
          </button>
          <a href="/" className="text-link">
            Find more books
          </a>
        </div>
      )}
      <div className="shelf-book-list">
        {books.map((row, i) => (
          <article className="shelf-book" key={row.bookId}>
            <span className="shelf-number">{String(i + 1).padStart(2, "0")}</span>
            <a href={bookPath(row.bookId)}>
              <BookArt book={row.book} />
            </a>
            <div>
              <a href={bookPath(row.bookId)}>
                <h2>{row.book.title}</h2>
              </a>
              <p className="muted">{row.book.authors.map((a) => a.name).join(", ")}</p>
              {row.note && <p>{row.note}</p>}
            </div>
            {shelf.mine && (
              <div className="shelf-order">
                <button
                  className="icon-button"
                  disabled={i === 0 || busy}
                  onClick={() => order(i, -1)}
                  aria-label={"Move " + row.book.title + " up"}
                >
                  <ArrowUp size={17} />
                </button>
                <button
                  className="icon-button"
                  disabled={i === books.length - 1 || busy}
                  onClick={() => order(i, 1)}
                  aria-label={"Move " + row.book.title + " down"}
                >
                  <ArrowDown size={17} />
                </button>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label={"Remove " + row.book.title + " from shelf"}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api("/shelves/" + id + "/books/" + row.bookId, "DELETE", {expectedVersion:shelf.version});
                      await result.refetch();
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {!books.length && <p className="quiet-empty">This shelf is ready for its first book.</p>}
      {edit && (
        <ShelfEditor
          shelf={shelf}
          onClose={() => setEdit(false)}
          onSaved={() => result.refetch()}
        />
      )}
      <AlertDialog open={remove} onOpenChange={setRemove}>
        <AlertDialogContent className="fore-dialog">
          <AlertDialogTitle>Delete this shelf?</AlertDialogTitle>
          <AlertDialogDescription>Your books remain in your library.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await api("/shelves/" + id, "DELETE", {expectedVersion:shelf.version});
                  location.assign("/shelves");
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Delete shelf
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
export function AddToShelf({ bookId }: { bookId: string }) {
  const { data, signIn } = useAccount();
  const [open, setOpen] = useState(false),
    [create, setCreate] = useState(false),
    [busy, setBusy] = useState("");
  const result = useQuery<{ shelves: Shelf[] }>({
    queryKey: ["shelves", data.user?.id],
    queryFn: () => api("/shelves"),
    enabled: open && !!data.user,
  });
  async function add(id: string, expectedVersion: number) {
    setBusy(id);
    try {
      await api("/shelves/" + id + "/books", "PUT", { bookId, expectedVersion });
      toast.success("Added to shelf");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <button
        className="button outline"
        onClick={() => {
          if (!data.user) return signIn();
          setOpen(true);
        }}
      >
        <Library size={16} />
        Add to shelf
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="fore-dialog">
          <DialogTitle>Add to a shelf</DialogTitle>
          <DialogDescription>Choose one of your reading lists.</DialogDescription>
          {result.error && <p className="notice">{result.error.message}</p>}
          {result.data?.shelves.map((s) => (
            <button
              className="button outline"
              key={s.id}
              disabled={!!busy}
              onClick={() => add(s.id, s.version)}
            >
              {s.visibility === "private" ? <Lock size={15} /> : <Globe size={15} />} {s.name}
            </button>
          ))}
          <button
            className="button gold"
            onClick={() => {
              setOpen(false);
              setCreate(true);
            }}
          >
            <Plus size={16} />
            Create a new shelf
          </button>
        </DialogContent>
      </Dialog>
      {create && (
        <ShelfEditor
          shelf={null}
          onClose={() => setCreate(false)}
          onSaved={(id) => {
            if (id) add(id, 1);
          }}
        />
      )}
    </>
  );
}
