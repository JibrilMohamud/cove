import fs from 'node:fs';import path from 'node:path';
const root=process.cwd(),skip=new Set(['.git','node_modules','dist','.output','coverage','artifacts']),ext=new Set(['.ts','.tsx','.js','.mjs','.cjs','.json','.md','.yml','.yaml','.toml','.env','.example','.sql']);
const patterns=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
 ['aws-access-key',/\bAKIA[0-9A-Z]{16}\b/g],
 ['github-token',/\bgh[pousr]_[A-Za-z0-9_]{24,}\b/g],
 ['stripe-secret',/\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
 ['fore-service-credential',/\bfore_svc_[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}\b/g],
];
const findings=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(skip.has(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p);else{const bn=path.basename(p),x=path.extname(p);if(!(ext.has(x)||bn==='.env.example'))continue;const text=fs.readFileSync(p,'utf8');for(const [name,re] of patterns){re.lastIndex=0;for(const m of text.matchAll(re)){const line=text.slice(0,m.index).split('\n').length,context=text.split('\n')[line-1]||'';if(/REPLACE_|example|placeholder/i.test(context))continue;findings.push({file:path.relative(root,p),line,type:name});}}}}}
walk(root);if(findings.length){console.error('Potential checked-in secrets found:',findings);process.exit(1)}console.log('Secret scan passed; no high-confidence credential material found.');
