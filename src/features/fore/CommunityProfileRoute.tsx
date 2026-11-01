import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, useAccount } from "./client";
import { DiscussionThread } from "./Community";
import { ReaderProfileOverview } from "./ReaderProfileOverview";

export function CommunityProfileRoute({ profileRef, tab }: { profileRef: string; tab: string | null }) {
 const { data, signIn } = useAccount();
 const q = useQuery<any>({
  queryKey: ["social-profile", profileRef, data.user?.id || "guest"],
  queryFn: () => api("/social/profile/" + encodeURIComponent(profileRef)),
 });
 // These published journeys are already filtered by the profile endpoint.
 // Fetch details through the existing authorization-aware journey API; never
 // query the private reading library or invent review/cover metadata.
 const visibleJourneyIds: string[] = (q.data?.journeys || []).slice(0, 8).map(
  (j: { id:string }) => j.id,
 );
 const detail = useQuery({
  queryKey: ["profile-journey-art", profileRef, data.user?.id || "guest", visibleJourneyIds],
  enabled: visibleJourneyIds.length > 0,
  staleTime: 60_000,
  queryFn: async () => Promise.all(visibleJourneyIds.map(async id => {
   try {
    const x = await api<any>("/social/journeys/"+encodeURIComponent(id));
    return { id, ...x };
   } catch { return { id }; }
  })),
 });
 async function follow() {
  if (!data.user) return signIn();
  try {
   const relationship = q.data.relationship;
   const following = !!relationship.following || relationship.followRequestStatus === "pending";
   await api("/social/follow", "POST", { userId:q.data.profile.id, following:!following });
   await q.refetch();
  } catch (error) { toast.error((error as Error).message); }
 }
 async function mute() {
  if (!data.user) return signIn();
  try {
   const muted = !!q.data.relationship.muted;
   await api("/social/mute", "POST", { userId:q.data.profile.id, muted:!muted });
   await q.refetch();
   toast.success(muted ? "Reader unmuted" : "Reader muted");
  } catch (error) { toast.error((error as Error).message); }
 }
 async function block() {
  if (!data.user) return signIn();
  if (!confirm("Block this reader? You will no longer see each other's Community activity.")) return;
  try {
   await api("/social/block", "POST", { userId:q.data.profile.id, blocked:true });
   location.assign("/community?tab=discover");
  } catch (error) { toast.error((error as Error).message); }
 }
 async function report() {
  if (!data.user) return signIn();
  try {
   await api("/social/report", "POST", {
    subjectType:"social_profile", subjectId:q.data.profile.id,
    reason:"other", details:"Reported from reader profile for moderator review.",
   });
   toast.success("Profile report sent to moderation");
  } catch (error) { toast.error((error as Error).message); }
 }
 if (q.isLoading) return <p className="muted" role="status">Loading reader profile…</p>;
 if (q.isError || !q.data?.profile) return <p role="alert" className="notice">Reader not found or unavailable.</p>;
 const relation=q.data.relationship || {};
 const label=relation.following?"Following":relation.followRequestStatus==="pending"?"Requested":"Follow";
 const snapshots = new Map((detail.data || []).map((j) => [j.id, j]));
 const publicJourneys = (q.data.journeys || []).map((j: any) => {
  const detailRow: any = snapshots.get(j.id);
  return detailRow ? {
   ...j,
   product_id: detailRow.book?.productId || j.product_id,
   cover_url: detailRow.cover_url || j.cover_url,
   author_snapshot: detailRow.author_snapshot || j.author_snapshot,
   review_excerpt: detailRow.review_excerpt || j.review_excerpt,
   rating_steps: detailRow.rating_steps ?? j.rating_steps,
  } : j;
 });
 const year = String(new Date().getUTCFullYear());
 const thisYear = publicJourneys.filter((j: any) => String(j.finished_at || "").startsWith(year)).length;
 const result = { ...q.data, journeys: publicJourneys,
  counts: { ...q.data.counts, thisYear } };
 return <ReaderProfileOverview result={result} owner={data.user?.id === q.data.profile.id}
  tab={tab} followLabel={label} follow={follow} mute={mute} block={block} report={report}
  discussion={<DiscussionThread contextType="profile" contextId={q.data.profile.id}
   title={"Replies to "+(q.data.profile.name || "Reader")}/>} />;
}
