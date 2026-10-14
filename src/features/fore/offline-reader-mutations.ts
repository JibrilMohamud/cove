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
  state: "pending" | "conflict";
  lastError?: string;
};
const prefix = "reader-mutation:";
let draining: Promise<void> | null = null;
function key(userId: string, kind: Mutation["kind"], id: string) {
  return `${prefix}${userId}:${kind}:${id}`;
}
export async function pendingReaderMutations(userId: string) {
  if (!userId || offlineAccountId() !== userId) return [];
  return (await getRecords<Mutation>("outbox")).filter(
    (item) => item?.id?.startsWith(prefix) && item.userId === userId,
  );
}
export async function flushReaderMutations(userId: string) {
  if (!userId || offlineAccountId() !== userId) return;
  if (draining) return draining;
  draining = (async () => {
    const rows = (await pendingReaderMutations(userId)).sort((a, b) =>
      a.savedAt.localeCompare(b.savedAt),
    );
    for (const row of rows) {
      if (row.state === "conflict" || offlineAccountId() !== userId) break;
      try {
        await api(row.path, row.method, row.body);
        if (offlineAccountId() !== userId) break;
        // Only remove the exact queued version: the user may have edited it while sending.
        const current = await getRecord<Mutation>("outbox", row.id);
        if (current?.savedAt === row.savedAt) await deleteRecord("outbox", row.id);
      } catch (error) {
        const status = Number((error as { status?: number })?.status || 0);
        if ([400, 404, 409, 422].includes(status)) {
          await putRecord("outbox", {
            ...row,
            state: "conflict",
            lastError: (error as Error).message,
          } satisfies Mutation);
        }
        // 401/403: keep the item for the owner, never replay in another account.
        // 429/5xx/offline: retry on the next opportunity without losing the payload.
        break;
      }
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
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
    state: "pending",
  };
  await putRecord("outbox", row);
  try {
    const response = await api<Record<string, unknown>>(path, method, body);
    if (offlineAccountId() !== userId)
      throw new Error("Your account changed while this update was in flight.");
    const current = await getRecord<Mutation>("outbox", id);
    if (current?.savedAt === row.savedAt) await deleteRecord("outbox", id);
    return { queued: false, id, response };
  } catch (error) {
    const status = Number((error as { status?: number })?.status || 0);
    if ([400, 404, 409, 422].includes(status)) {
      await putRecord("outbox", {
        ...row,
        state: "conflict",
        lastError: (error as Error).message,
      } satisfies Mutation);
      throw error;
    }
    return { queued: true, id, response: null };
  }
}
export async function discardReaderConflict(userId: string, mutationId: string) {
  if (offlineAccountId() !== userId || !mutationId.startsWith(prefix + userId + ":"))
    throw new Error("This change belongs to a different account.");
  await deleteRecord("outbox", mutationId);
}
