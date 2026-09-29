import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Bell, BellOff, ExternalLink, Loader2, Users, Megaphone, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useAccount, type CatalogBook } from "./client";
import { BookCard } from "./Store";

type AuthorProfileResponse = {
  author: {
    id: string;
    slug: string;
    name: string;
    verified: boolean;
    badgeLabel: string;
    biography: string;
    photoUrl: string;
    publisher: { name: string; slug: string } | null;
    imprint: { name: string; slug: string } | null;
    links: { type: string; label: string; url: string }[];
    series: { id: string; slug: string; name: string; description: string; seriesType: string; heroImageUrl: string; books: number }[];
    followers: number;
    following: boolean;
    alertPreferences: { release: boolean; preorder: boolean; inApp: boolean; email: boolean } | null;
  };
  bibliography: CatalogBook[];
  upcoming: CatalogBook[];
  territory: string;
};

function AuthorBooks({ title, books }: { title: string; books: CatalogBook[] }) {
  if (!books.length) return null;
  return <section className="author-books"><div className="section-heading"><h2>{title}</h2><span className="muted">{books.length} {books.length === 1 ? "title" : "titles"}</span></div><div className="book-grid">{books.map((book) => <BookCard key={String(book.productId || book.id)} book={book} />)}</div></section>;
}

export function AuthorProfilePage({ authorRef }: { authorRef: string }) {
  const { data: account, signIn } = useAccount();
  const profile = useQuery<AuthorProfileResponse>({ queryKey: ["commercial-author", authorRef, account.user?.id], queryFn: () => api(`/authors/${encodeURIComponent(authorRef)}`), retry: 1 });
  const [busy, setBusy] = useState(false);
  const [socialBody,setSocialBody]=useState("");
  const [editingPost,setEditingPost]=useState<string|null>(null);
  const [editingBody,setEditingBody]=useState("");
  const author = profile.data?.author;
  const social=useQuery<any>({queryKey:["author-social",authorRef,account.user?.id],queryFn:()=>api(`/social/authors/${encodeURIComponent(authorRef)}/posts`),retry:1});

  async function updateFollow(follow: boolean, overrides?: Partial<NonNullable<AuthorProfileResponse["author"]["alertPreferences"]>>) {
    if (!account.user) return signIn();
    if (!author) return;
    const current = author.alertPreferences || { release: true, preorder: true, inApp: true, email: false };
    setBusy(true);
    try {
      await api("/authors/follow", "POST", { contributorId: author.id, follow, alerts: { ...current, ...overrides } });
      await profile.refetch();
      toast.success(follow ? "Author follow preferences updated" : "Author unfollowed");
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  async function publishAuthorPost(){if(!account.user)return signIn();if(!socialBody.trim())return;setBusy(true);try{await api(`/social/authors/${encodeURIComponent(authorRef)}/posts`,"POST",{postType:"update",body:socialBody});setSocialBody("");await social.refetch();toast.success("Author update published");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
  async function saveAuthorPost(post:any){if(!editingBody.trim())return;setBusy(true);try{await api(`/social/authors/${encodeURIComponent(authorRef)}/posts/${encodeURIComponent(post.id)}`,"PATCH",{body:editingBody,expectedVersion:Number(post.version||1)});setEditingPost(null);setEditingBody("");await social.refetch();toast.success("Author update edited");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}
  async function removeAuthorPost(post:any){if(!confirm("Remove this author update? Existing follower notifications may remain, but the post will no longer be visible."))return;setBusy(true);try{await api(`/social/authors/${encodeURIComponent(authorRef)}/posts/${encodeURIComponent(post.id)}`,"DELETE",{expectedVersion:Number(post.version||1)});await social.refetch();toast.success("Author update removed");}catch(e){toast.error((e as Error).message);}finally{setBusy(false);}}

  if (profile.isLoading) return <main className="author-profile-page"><p role="status"><Loader2 className="spin" size={18} /> Loading author…</p></main>;
  if (profile.error || !author) return <main className="author-profile-page"><p className="notice">{profile.error?.message || "Author not found."}</p></main>;
  const prefs = author.alertPreferences || { release: true, preorder: true, inApp: true, email: false };

  return <main className="author-profile-page">
    <section className="author-profile-hero">
      <div className="author-profile-photo" aria-hidden={!author.photoUrl}>{author.photoUrl ? <img src={author.photoUrl} alt={`Portrait of ${author.name}`} /> : <span>{author.name.slice(0, 1).toUpperCase()}</span>}</div>
      <div className="author-profile-copy">
        <div className="author-name-line"><h1>{author.name}</h1>{author.verified && <span className="verified-author" title="Cove verified this commercial author identity"><BadgeCheck size={19} /> {author.badgeLabel}</span>}</div>
        {(author.imprint || author.publisher) && <p className="author-publisher">Published by {author.imprint?.name || author.publisher?.name}{author.imprint && author.publisher ? ` · ${author.publisher.name}` : ""}</p>}
        {author.biography ? <p className="author-biography">{author.biography}</p> : <p className="muted">No biography has been published yet.</p>}
        <div className="author-profile-actions">
          <button className={`button ${author.following ? "outline" : "gold"}`} disabled={busy} onClick={() => updateFollow(!author.following)}>{busy ? <Loader2 className="spin" size={16} /> : author.following ? <BellOff size={16} /> : <Bell size={16} />} {author.following ? "Following" : "Follow author"}</button>
          <span className="muted author-follow-count"><Users size={15} /> {author.followers.toLocaleString()} followers</span>
        </div>
        {author.following && <div className="author-alert-preferences" aria-label="Release alert preferences">
          <strong>Alerts</strong>
          <label><input type="checkbox" checked={prefs.release} onChange={(e) => updateFollow(true, { release: e.target.checked })} /> New releases</label>
          <label><input type="checkbox" checked={prefs.preorder} onChange={(e) => updateFollow(true, { preorder: e.target.checked })} /> Preorders</label>
          <label><input type="checkbox" checked={prefs.inApp} onChange={(e) => updateFollow(true, { inApp: e.target.checked })} /> In-app</label>
        </div>}
        {!!author.links.length && <nav className="author-links" aria-label={`${author.name} links`}>{author.links.map((link) => <a key={`${link.type}:${link.url}`} href={link.url} target="_blank" rel="nofollow noopener noreferrer">{link.label || link.type}<ExternalLink size={13} /></a>)}</nav>}
      </div>
    </section>
    {(social.data?.posts?.length||social.data?.canPost)&&<section className="author-social"><div className="section-heading"><div><span className="small-label">FROM THE AUTHOR</span><h2>Updates & reading lists</h2></div></div>{social.data?.canPost&&<div className="social-composer"><textarea value={socialBody} onChange={e=>setSocialBody(e.target.value)} placeholder="Share an update with readers who follow this author…" maxLength={12000}/><button className="button gold" disabled={busy||!socialBody.trim()} onClick={publishAuthorPost}><Megaphone size={16}/> Publish update</button></div>}<div className="author-social-feed">{social.data?.posts?.map((post:any)=><article key={post.id}><header><BadgeCheck size={15}/><strong>{author.name}</strong><span>{new Date(post.created_at).toLocaleDateString()}{post.version>1?" · edited":""}</span></header>{editingPost===post.id?<div className="author-social-edit"><textarea value={editingBody} onChange={e=>setEditingBody(e.target.value)} maxLength={12000}/><div><button className="button gold" disabled={busy||!editingBody.trim()} onClick={()=>saveAuthorPost(post)}>Save</button><button className="button outline" onClick={()=>{setEditingPost(null);setEditingBody("");}}>Cancel</button></div></div>:<p>{post.body}</p>}{post.product_public_id&&<a className="text-link" href={`/books/${encodeURIComponent(post.product_public_id)}`}>{post.product_title||"View book"}</a>}{post.list_id&&<a className="text-link" href={`/community?list=${encodeURIComponent(post.list_id)}`}>{post.list_title||"View reading list"}</a>}{social.data?.canPost&&editingPost!==post.id&&<div className="author-social-controls"><button className="text-link" onClick={()=>{setEditingPost(post.id);setEditingBody(post.body);}}><Pencil size={14}/> Edit</button><button className="text-link" onClick={()=>removeAuthorPost(post)}><Trash2 size={14}/> Remove</button></div>}</article>)}</div></section>}
    {!!author.series.length && <section className="author-series"><div className="section-heading"><h2>Series</h2></div><div className="author-series-grid">{author.series.map((series) => <a className="author-series-card" key={series.id} href={`/series/${encodeURIComponent(series.slug || series.id)}`}><strong>{series.name}</strong><span>{series.books} {series.books === 1 ? "book" : "books"}</span>{series.description && <p>{series.description}</p>}</a>)}</div></section>}
    <AuthorBooks title="Upcoming releases" books={profile.data?.upcoming || []} />
    <AuthorBooks title="Bibliography" books={profile.data?.bibliography || []} />
  </main>;
}
