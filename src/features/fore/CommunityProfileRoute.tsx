import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, useAccount } from "./client";
import { DiscussionThread } from "./Community";
import { ReaderProfileOverview } from "./ReaderProfileOverview";

export function CommunityProfileRoute({ profileRef, tab }: { profileRef: string; tab: string | null }) {
 const { data, signIn } = useAccount();
 const q = useQuery<any>({
  queryKey: ["social-profile", profileRef],
  queryFn: () => api("/social/profile/" + encodeURIComponent(profileRef)),
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
 return <ReaderProfileOverview result={q.data} owner={data.user?.id === q.data.profile.id}
  tab={tab} followLabel={label} follow={follow} mute={mute} block={block} report={report}
  discussion={<DiscussionThread contextType="profile" contextId={q.data.profile.id}
   title={"Replies to "+(q.data.profile.name || "Reader")}/>} />;
}
