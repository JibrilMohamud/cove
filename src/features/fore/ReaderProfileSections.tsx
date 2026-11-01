import { ArrowRight, BookOpen } from "lucide-react";
import {
  ReaderCover,
  ModuleHead,
  JourneyEntry,
  ShelfGrid,
  bookLink,
  dateLabel,
} from "./ReaderProfileBits";
import type { ProfileBook, ProfileJourney, ProfileShelf } from "./ReaderProfileBits";

export function ReaderProfileSections({
  top,
  journeys,
  shelves,
  tab,
  owner,
  url,
}: {
  top: { position: number; book: ProfileBook | null }[];
  journeys: ProfileJourney[];
  shelves: ProfileShelf[];
  tab: string;
  owner: boolean;
  url: string;
}) {
  const selected = top.filter((x) => !!x.book?.productId).slice(0, 3);
  const reviews = journeys.filter((x) => !!x.review_excerpt?.trim());
  const to = (name: string) => url + "&profileTab=" + encodeURIComponent(name);
  const empty = !selected.length && !journeys.length && !shelves.length;
  return (
    <div className="cove-reader-main">
      {["Profile", "Library"].includes(tab) && selected.length > 0 && (
        <section>
          <ModuleHead title="The Three" />
          <p className="cove-reader-intro">Three books that say the most.</p>
          <div className="cove-reader-three">
            {selected.map(({ position, book }) => (
              <a key={position} href={bookLink(book)}>
                <ReaderCover book={book} />
                <strong>{book?.title}</strong>
                <small>{book?.authors}</small>
              </a>
            ))}
          </div>
        </section>
      )}
      {["Profile", "Activity", "Library"].includes(tab) && journeys.length > 0 && (
        <section>
          <ModuleHead
            title={tab === "Library" ? "Shared finished books" : "Recent activity"}
            href={to("Journal")}
          />
          <div className="cove-reader-recent">
            {journeys.slice(0, 5).map((x) => (
              <a key={x.id} title={x.title_snapshot} href={bookLink({ productId: x.product_id })}>
                <ReaderCover
                  book={{
                    productId: x.product_id,
                    title: x.title_snapshot,
                    authors: x.author_snapshot,
                    coverUrl: x.cover_url,
                  }}
                />
                <small>{dateLabel(x.finished_at)}</small>
              </a>
            ))}
          </div>
        </section>
      )}
      {["Profile", "Reviews"].includes(tab) && reviews.length > 0 && (
        <section>
          <ModuleHead title="Recent reviews" href={to("Reviews")} />
          {reviews.slice(0, tab === "Profile" ? 3 : 20).map((x) => (
            <JourneyEntry key={x.id} item={x} />
          ))}
        </section>
      )}
      {["Journal", "Activity"].includes(tab) && journeys.length > 0 && (
        <section>
          <ModuleHead title="Reading journal" />
          {journeys.map((x) => (
            <JourneyEntry key={x.id} item={x} />
          ))}
        </section>
      )}
      {["Profile", "Shelves"].includes(tab) && shelves.length > 0 && (
        <section>
          <ModuleHead title="Recent shelves" href={to("Shelves")} />
          <ShelfGrid items={shelves.slice(0, tab === "Profile" ? 3 : 40)} />
        </section>
      )}
      {tab === "Profile" && empty && (
        <section className="cove-reader-empty">
          <BookOpen size={40} aria-hidden="true" />
          <h2>{owner ? "Your story is just beginning." : "A story still being written."}</h2>
          <p>
            {owner
              ? "Find a book, then choose your favorite three."
              : "This reader hasn't shared books or shelves yet."}
          </p>
          {owner && (
            <div>
              <a href="/bookstore">
                Explore books <ArrowRight size={15} />
              </a>
              <a href="/profile?section=me">Choose The Three</a>
            </div>
          )}
        </section>
      )}
      {["Library", "Activity", "Journal", "Reviews", "Shelves"].includes(tab) &&
        ((tab === "Library" && !selected.length && !journeys.length) ||
          (tab === "Activity" && !journeys.length) ||
          (tab === "Journal" && !journeys.length) ||
          (tab === "Reviews" && !reviews.length) ||
          (tab === "Shelves" && !shelves.length)) && (
          <section className="cove-reader-empty">
            <h2>Nothing shared here yet.</h2>
            <p>Only reading activity shared with you appears here.</p>
            {owner && (
              <a href="/profile?section=me">
                Manage profile <ArrowRight size={15} />
              </a>
            )}
          </section>
        )}
    </div>
  );
}
