import { api } from "./client";
import { deleteRecord, getRecord, getRecords, putRecord } from "./offline";
import { offlineAccountId } from "./offline-account";

type Mutation = {
  id: string;
  userId: string;
  kind: "position" | "annotation" | "annotation-edit";
  path: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  savedAt: string;
  revision: string;
  state: "pending" | "conflict";
  lastError?: string;
};
const prefix = "reader-mutation:";
const drains = new Map<string, Promise<void>>();
const receipts = new Map<string, { revision: string; response: Record<string, unknown> }>();
function key(userId: string, kind: Mutation["kind"], id: string) {
  return `${prefix}${userId}:${kind}:${id}`;
}
export async function pendingReaderMutations(userId: string) {
  if (!userId || offlineAccountId() !== userId) return [];
  return (await getRecords<Mutation>("outbox")).filter(
    (item) => item?.id?.startsWith(prefix) && item.userId === userId,
  );
}
async function sendOne(userId: string, row: Mutation): Promise<boolean> {
  if (row.state !== "pending" || offlineAccountId() !== userId) return false;
  const current = await getRecord<Mutation>("outbox", row.id);
  if (!current || current.revision !== row.revision) return true;
  try {
    const response = await api<Record<string, unknown>>(row.path, row.method, row.body);
    if (offlineAccountId() !== userId) return false;
    receipts.set(row.id, { revision: row.revision, response });
    const latest = await getRecord<Mutation>("outbox", row.id);
    if (latest?.revision === row.revision) {
      await deleteRecord("outbox", row.id);
    } else if (
      latest?.state === "pending" &&
      row.kind === "position" &&
      typeof response.version === "number" &&
      latest.body.expectedVersion === row.body.expectedVersion
    ) {
      // Carry the acknowledged version into a newer unsent position without
      // losing that newer CFI. Other devices still receive normal 409 checks.
      await putRecord("outbox", {
        ...latest,
        body: { ...latest.body, expectedVersion: response.version },
      } satisfies Mutation);
    }
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("cove-reader-synced", {
        detail: { userId, kind: row.kind },
      }));
    return true;
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 0);
    const latest = await getRecord<Mutation>("outbox", row.id);
    if (
      latest?.revision === row.revision &&
      [400, 404, 409, 422].includes(status)
    ) {
      await putRecord("outbox", {
        ...row,
        state: "conflict",
        lastError: (error as Error).message,
      } satisfies Mutation);
    }
    return false;
  }
}
export async function flushReaderMutations(userId: string) {
  if (!userId || offlineAccountId() !== userId) return;
  const existing = drains.get(userId);
  if (existing) return existing;
  const promise = (async () => {
    // A new mutation can arrive during an in-flight save. Recheck after each
    // pass so it is never mistaken for the acknowledged version.
    for (let pass = 0; pass < 100; pass++) {
      const rows = (await pendingReaderMutations(userId)).sort((a, b) =>
        a.savedAt.localeCompare(b.savedAt),
      );
      const pending = rows.filter((row) => row.state === "pending");
      if (!pending.length) return;
      for (const row of pending) {
        if (!await sendOne(userId, row)) return;
      }
    }
  })().finally(() => {
    drains.delete(userId);
  });
  drains.set(userId, promise);
  return promise;
}
export async function queueReaderMutation(
  userId: string,
  kind: Mutation["kind"],
  entityId: string,
  path: string,
  method: Mutation["method"],
  body: Record<string, unknown>,
) {
  if (!userId || offlineAccountId() !== userId)
    throw new Error("Reconnect and sign in to save this account's reading changes.");
  const id = key(userId, kind, entityId);
  const prior = await getRecord<Mutation>("outbox", id);
  if (prior?.state === "conflict")
    throw new Error("This reading change conflicts with another device; review it before editing.");
  const row: Mutation = {
    id,
    userId,
    kind,
    path,
    method,
    body,
    savedAt: new Date().toISOString(),
    revision: crypto.randomUUID(),
    state: "pending",
  };
  await putRecord("outbox", row);
  await flushReaderMutations(userId);
  const receipt = receipts.get(id);
  if (receipt?.revision === row.revision) {
    receipts.delete(id);
    return { queued: false, id, response: receipt.response };
  }
  const pending = await getRecord<Mutation>("outbox", id);
  if (pending?.revision === row.revision && pending.state === "conflict")
    throw new Error(pending.lastError || "This change conflicts with another device.");
  return { queued: true, id, response: null };
}
export async function discardReaderConflict(userId: string, mutationId: string) {
  if (offlineAccountId() !== userId || !mutationId.startsWith(prefix + userId + ":"))
    throw new Error("This change belongs to a different account.");
  const row = await getRecord<Mutation>("outbox", mutationId);
  if (!row || row.state !== "conflict")
    throw new Error("Only conflicts can be discarded; pending changes are preserved.");
  await deleteRecord("outbox", mutationId);
}
