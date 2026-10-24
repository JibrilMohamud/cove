import { lazy, Suspense, useEffect, useRef, useState } from "react";

// Keeping the social graph out of the book-detail bootstrap avoids loading
// discussion JS or querying canonical D1 until the reader approaches it.
const DiscussionThread = lazy(() =>
  import("./Community").then((module) => ({ default: module.DiscussionThread })),
);

export function BookDiscussionDeferred({ workId }: { workId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = host.current;
    if (!node || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "650px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);

  return (
    <div id="book-discussion" className="cove-book-discussion" ref={host}>
      {near ? (
        <Suspense fallback={<p role="status">Opening reader discussion…</p>}>
          <DiscussionThread
            contextType="work"
            contextId={workId}
            bookThread
            title="Reader discussion & comments"
          />
        </Suspense>
      ) : (
        <div className="section-heading">
          <h2>Reader discussion & comments</h2>
          <p className="muted">Discussions load when you scroll to them.</p>
        </div>
      )}
    </div>
  );
}
