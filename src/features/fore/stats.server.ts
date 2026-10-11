import { z } from "zod";
import type { CoveEnv } from "./api.server";
import { getCanonicalBook } from "./catalog-model.server";
import { ApiError, json, readBody } from "./service";

type DB = CoveEnv["DB"];
const bookRef = z.string().regex(/^(?:[1-9][0-9]{0,8}|(?:pgca|pgau|pgeu)_[a-z0-9_]{1,100}|(?:upload|fore)_[a-f0-9-]{36}|prd_[a-f0-9]{32})$/);
const sessionInput = z.object({
  id: z.string().uuid(),
  bookId: bookRef,
  mode: z.enum(["read", "listen"]),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  activeSeconds: z.number().int().min(0).max(14400),
  wordsRead: z.number().int().min(0).max(360000),
});
function period(days: string | null) {
  if (days === "all") return "0000-01-01T00:00:00.000Z";
  const amount = z.coerce.number().int().refine((n) => [7,30,90,365].includes(n)).parse(days || "30");
  return new Date(Date.now() - amount * 86400_000).toISOString();
}
const value = (v: unknown) => Number(v || 0);
const dateOnly = (iso: string) => iso.slice(0, 10);

export async function handleReadingStatistics(
  request: Request,
  env: CoveEnv,
  path: string,
  userId: string,
): Promise<Response | null> {
  if (!["/sessions", "/stats", "/goals", "/metrics"].includes(path)) return null;
  const db: DB = env.DB;
  if (!db) throw new ApiError(503,"Reading statistics cannot be saved right now.");
  if (path === "/sessions") {
    if (request.method !== "PUT") throw new ApiError(405, "Use PUT to save a reading session.");
    const data = sessionInput.parse(await readBody(request,4000));
    const from = Date.parse(data.startedAt), to = Date.parse(data.endedAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || from > Date.now()+300_000
        || to > Date.now()+300_000 || to-from > 24*3600_000
        || data.activeSeconds > Math.ceil((to-from)/1000)+15
        || data.wordsRead > data.activeSeconds*25+50) {
      throw new ApiError(400, "Reading session timing is invalid.");
    }
    await db.prepare(
      `INSERT INTO reading_sessions(id,user_id,book_id,mode,started_at,ended_at,active_seconds,words_read)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id,id) DO UPDATE SET
         ended_at=CASE WHEN excluded.ended_at>reading_sessions.ended_at THEN excluded.ended_at ELSE reading_sessions.ended_at END,
         active_seconds=MAX(reading_sessions.active_seconds,excluded.active_seconds),
         words_read=MAX(reading_sessions.words_read,excluded.words_read)
       WHERE reading_sessions.book_id=excluded.book_id
         AND reading_sessions.mode=excluded.mode
         AND reading_sessions.started_at=excluded.started_at`
    ).bind(data.id,userId,data.bookId,data.mode,data.startedAt,data.endedAt,data.activeSeconds,data.wordsRead).run();
    return json({ saved: true });
  }
  if (path === "/metrics") {
    if (request.method !== "PUT") throw new ApiError(405, "Use PUT to save book metrics.");
    const p=z.object({
      bookId: bookRef,wordCount:z.number().int().min(0).max(10_000_000),
      readingLevel:z.number().finite().min(-20).max(100).nullable(),
      language:z.string().min(2).max(20),
    }).parse(await readBody(request,4000));
    await db.prepare(
      `INSERT INTO book_metrics(user_id,book_id,word_count,reading_level,language,method,updated_at)
       VALUES(?,?,?,?,?,'epub-visible-text-v1',?)
       ON CONFLICT(user_id,book_id) DO UPDATE SET
       word_count=excluded.word_count,reading_level=excluded.reading_level,language=excluded.language,
       method=excluded.method,updated_at=excluded.updated_at`
    ).bind(userId,p.bookId,p.wordCount,p.readingLevel,p.language,new Date().toISOString()).run();
    return json({ saved:true });
  }
  if (path === "/goals") {
    if (request.method !== "PUT") throw new ApiError(405, "Use PUT to save reading goals.");
    const p=z.object({year:z.number().int().min(2000).max(2200),books:z.number().int().min(1).max(1000)})
      .parse(await readBody(request,1000));
    await db.prepare("INSERT INTO reading_goals(user_id,year,books) VALUES(?,?,?) ON CONFLICT(user_id,year) DO UPDATE SET books=excluded.books")
      .bind(userId,p.year,p.books).run();
    return json({saved:true,year:p.year,target:p.books});
  }
  if (request.method !== "GET") throw new ApiError(405, "Use GET to view reading statistics.");
  const from=period(new URL(request.url).searchParams.get("days"));
  const year=new Date().getUTCFullYear();
  const [sessions,completionRows,goal,wordRows,metrics,goalCompletions]=await Promise.all([
    db.prepare("SELECT id,book_id,mode,started_at,ended_at,active_seconds,words_read FROM reading_sessions WHERE user_id=? AND started_at>=? ORDER BY started_at DESC LIMIT 2500").bind(userId,from).all<any>(),
    db.prepare("SELECT id,external_book_id,finished_at FROM completion_events WHERE user_id=? AND finished_at>=? ORDER BY finished_at DESC LIMIT 250").bind(userId,from).all<any>(),
    db.prepare("SELECT books FROM reading_goals WHERE user_id=? AND year=?").bind(userId,year).first<any>(),
    db.prepare("SELECT word,COUNT(*) lookups,COUNT(DISTINCT CASE WHEN book_id<>'' THEN book_id END) books FROM definitions WHERE user_id=? GROUP BY lower(word) ORDER BY lookups DESC,word LIMIT 250").bind(userId).all<any>(),
    db.prepare("SELECT book_id,word_count,reading_level,language FROM book_metrics WHERE user_id=?").bind(userId).all<any>(),
    db.prepare("SELECT COUNT(*) count FROM completion_events WHERE user_id=? AND finished_at>=? AND finished_at<?")
      .bind(userId,`${year}-01-01T00:00:00.000Z`,`${year+1}-01-01T00:00:00.000Z`).first<any>(),
  ]);
  const rs=sessions.results, completed=completionRows.results;
  const readSeconds=rs.filter(r=>r.mode==="read").reduce((n,r)=>n+value(r.active_seconds),0);
  const listenSeconds=rs.filter(r=>r.mode==="listen").reduce((n,r)=>n+value(r.active_seconds),0);
  const wordsRead=rs.filter(r=>r.mode==="read").reduce((n,r)=>n+value(r.words_read),0);
  const dayMap=new Map<string,{date:string;read_seconds:number;listen_seconds:number}>();
  for(const s of rs){
    const date=dateOnly(s.started_at);
    const d=dayMap.get(date)||{date,read_seconds:0,listen_seconds:0};
    if(s.mode==="read")d.read_seconds+=value(s.active_seconds);
    else d.listen_seconds+=value(s.active_seconds);
    dayMap.set(date,d);
  }
  const bookMetrics=new Map(metrics.results.map((m:any)=>[m.book_id,m]));
  const genreCounts=new Map<string,number>(),subjectCounts=new Map<string,number>();
  const finished=[];
  let finishedMeasured=0,finishedWords=0;
  for(const event of completed){
    const book=await getCanonicalBook(db,event.external_book_id,userId);
    if(!book)continue;
    const metric:any=bookMetrics.get(event.external_book_id);
    const wordCount=metric?.word_count?value(metric.word_count):null;
    if(wordCount){finishedMeasured++;finishedWords+=wordCount;}
    finished.push({id:event.id,bookId:event.external_book_id,book,wordCount,finishedAt:event.finished_at});
    for(const key of book.bookshelves||[])genreCounts.set(key,(genreCounts.get(key)||0)+1);
    for(const key of book.subjects||[])subjectCounts.set(key,(subjectCounts.get(key)||0)+1);
  }
  const labeled=async(rows:any[])=>{
    const names=new Map<string,string>();
    for(const s of rows.slice(0,100)){
      if(!names.has(s.book_id)){
        const book=await getCanonicalBook(db,s.book_id,userId);
        names.set(s.book_id,book?.title||"Book");
      }
    }
    return rows.slice(0,100).map((s:any)=>({
      id:s.id,bookId:s.book_id,title:names.get(s.book_id)||"Book",mode:s.mode,
      startedAt:s.started_at,seconds:value(s.active_seconds),words:value(s.words_read),
    }));
  };
  const readingLevels=metrics.results.filter((x:any)=>x.reading_level!==null&&String(x.language||"").startsWith("en"));
  const grouped=(m:Map<string,number>)=>[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([name,count])=>({name,count}));
  return json({
    totals:{
      finished:completed.length,readSeconds,listenSeconds,
      wpm:readSeconds>=60?Math.round(wordsRead*60/readSeconds):null,
      sessions:rs.length,
      averageSessionSeconds:rs.length?Math.round((readSeconds+listenSeconds)/rs.length):0,
      averageBookWords:finishedMeasured?Math.round(finishedWords/finishedMeasured):null,
      averageReadingLevel:readingLevels.length?readingLevels.reduce((n:any,m:any)=>n+Number(m.reading_level),0)/readingLevels.length:null,
      measuredBooks:finishedMeasured,leveledBooks:readingLevels.length,
    },
    goal:{year,target:goal?value(goal.books):0,finished:value(goalCompletions?.count)},
    daily:[...dayMap.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    vocabulary:wordRows.results.map((r:any)=>({word:r.word,lookups:value(r.lookups),books:value(r.books)})),
    genres:grouped(genreCounts),subgenres:grouped(subjectCounts),
    sessions:await labeled(rs),completed:finished,
  });
}
