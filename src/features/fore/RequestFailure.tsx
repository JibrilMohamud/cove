import { useUiText } from "./ui-text";
import { CoveRequestError } from "./api-transport";

export function RequestFailure({ error, retry }: { error: unknown; retry: () => void }) {
  const ui = useUiText();
  const reference = error instanceof CoveRequestError ? error.requestId : null;
  return (
    <div className="empty-state" role="alert">
      <h2>{ui("We couldn’t load this right now.")}</h2>
      <p>{error instanceof Error ? error.message : ui("Please try again.")}</p>
      {reference && <p>{ui("Request reference: {reference}", { reference })}</p>}
      <button className="button gold" onClick={retry}>
        {ui("Try again")}
      </button>
      <a
        className="button"
        href={reference ? `/help?reference=${encodeURIComponent(reference)}` : "/help"}
      >
        {ui("Get help")}
      </a>
    </div>
  );
}
