/* eslint-disable prettier/prettier -- Source containment evidence, never deployed production certification. */
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import {dirname,join,normalize} from "node:path";
import ts from "typescript";
export const PRIVATE_SETTLEMENT_MODULES=new Map([
  ["src/storefront-strangler/publication-materialization-command.ts",new Set(["src/storefront-strangler/legal-authority.worker.ts"])],
  ["src/features/fore/paid-settlement-transaction.server.ts",new Set(["src/storefront-strangler/paid-settlement-owner-executor.ts"])],
  ["src/storefront-strangler/paid-settlement-owner-executor.ts",new Set(["src/storefront-strangler/legal-authority.worker.ts"])],
  ["src/storefront-strangler/refund-reservation-owner-executor.ts",new Set(["src/storefront-strangler/legal-authority.worker.ts"])],
]);
function sourceFiles(dir="src",result=[]){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())sourceFiles(path,result);
    else if(/\.[cm]?[jt]sx?$/.test(entry.name))result.push(path);
  }
  return result;
}
/** New SQL in these private modules is owner-executor QA code, not a removed
 * legacy production finding. Any new runtime importer invalidates that
 * classification, even when the protected SQL itself did not change.
 */
export function assertPrivateSettlementSourceBoundary(sources=new Map(sourceFiles().map(p=>[p,readFileSync(p,"utf8")]))){
  const incoming=new Map([...PRIVATE_SETTLEMENT_MODULES.keys()].map(p=>[p,new Set()]));
  for(const [file,text] of sources){
    const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
    assert.equal(source.parseDiagnostics.length,0,"Invalid executor-boundary source");
    const inspect=specifier=>{
      if(!specifier||!ts.isStringLiteralLike(specifier))return;
      const path=specifier.text;
      const resolved=path.startsWith(".")?normalize(join(dirname(file),path)):
        path.startsWith("@/")?normalize("src/"+path.slice(2)):path;
      const target=[...PRIVATE_SETTLEMENT_MODULES.keys()].find(p=>p===resolved||p===resolved+".ts"||p===resolved.replace(/\.js$/,".ts"));
      if(!target)return;
      assert.ok(PRIVATE_SETTLEMENT_MODULES.get(target).has(file),"Non-owner runtime importer of settlement executor: "+file);
      incoming.get(target).add(file);
    };
    function visit(node){
      if(ts.isImportDeclaration(node)&&!node.importClause?.isTypeOnly){
        // A named import whose EVERY element uses `type` also erases at build.
        const bindings=node.importClause?.namedBindings;
        if(!(bindings&&ts.isNamedImports(bindings)&&!node.importClause.name&&bindings.elements.length&&bindings.elements.every(x=>x.isTypeOnly)))inspect(node.moduleSpecifier);
      }
      if(ts.isExportDeclaration(node)&&!node.isTypeOnly)inspect(node.moduleSpecifier);
      if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||
        ts.isIdentifier(node.expression)&&node.expression.text==="require"))inspect(node.arguments[0]);
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
  for(const [target,expected] of PRIVATE_SETTLEMENT_MODULES)
    assert.deepEqual([...incoming.get(target)].sort(),[...expected].sort(),"Private owner execution edge missing: "+target);
  return true;
}
