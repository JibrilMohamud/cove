const CACHE='cove-shell-v1';
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/','/manifest.webmanifest','/icons/cove-192.png'])).catch(()=>{}))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('fore-')||k.startsWith('cove-'))&&k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',event=>{
 const r=event.request,u=new URL(r.url);
 if(r.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/')||/signin|signout|callback/.test(u.pathname))return;
 // Never cache account responses, ratings, private reviews, shelf data, or auth routes.
 if(r.mode==='navigate'||u.pathname.startsWith('/assets/')||u.pathname.startsWith('/covers/')||u.pathname.startsWith('/icons/'))event.respondWith((async()=>{const c=await caches.open(CACHE);try{const response=await fetch(r);if(response.ok&&!response.redirected)await c.put(r,response.clone());return response}catch{const match=await c.match(r);return match||(r.mode==='navigate'?await c.match('/'):null)||Response.error()}})());
});
self.addEventListener('push',event=>{let data={};try{data=event.data?.json()||{}}catch{data={body:event.data?.text()||''}}const n=data.notification||data;event.waitUntil(self.registration.showNotification(n.title||'Cove',{body:n.body||'',icon:'/icons/cove-192.png',badge:'/icons/cove-192.png',data:{url:n.actionUrl||'/notifications'},tag:n.id||n.type||undefined,renotify:false}))});
self.addEventListener('notificationclick',event=>{event.notification.close();const url=event.notification.data?.url||'/notifications';event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{for(const c of clients){if('focus' in c){c.navigate?.(url);return c.focus()}}return self.clients.openWindow(url)}))});
