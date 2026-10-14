const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('/app/node_modules/typescript');
process.chdir(__dirname);
const cache=new Map();
function load(file){
 const absolute=path.resolve(file);if(cache.has(absolute))return cache.get(absolute);
 const source=fs.readFileSync(absolute,'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.equal((compiled.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,absolute);
 const exp={};cache.set(absolute,exp);
 vm.runInNewContext(compiled.outputText,{exports:exp,module:{exports:exp},require(name){if(!name.startsWith('.'))throw Error('Unexpected dependency '+name);return load(path.resolve(path.dirname(absolute),name));},
 URLSearchParams,AbortSignal,URL,Response,Request,console,Date,TextEncoder,TextDecoder,fetch(){throw Error('No live retrieval allowed');}},{filename:absolute});return exp;
}
const {buildRailwayPatch,missingColumns,approvedOrdinanceUrl,compareAndSetMaster}=load('base44/shared/railwayZoning.ts');
const {parseHarvest,planHarvest}=load('base44/shared/harvestedZoningUrls.ts');
const row={id:'master',updated_date:'v1',state:'OH',county:'Licking',jurisdiction_kind:'county',verification_status:'needs_confirmation',ordinance_url:'https://lickingcounty.gov/code'};
const quote='Sec. 12.4. The maximum tower height shall be 150 ft.';
const retrieval={final_url:row.ordinance_url,raw_ordinance_text:quote,text_sha256:'digest',retrieved_at:'2026-10-13T15:00:00Z',page_title:'Licking County Code'};
const extraction={jurisdiction_name:'Licking',state:'OH',fields:[{column:'maximum_tower_height',value:'150 ft',quote,section_ref:'Sec. 12.4'}]};
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
test('real quoted height fills only a pending master cell',()=>{
 const r=buildRailwayPatch(row,extraction,retrieval,'admin','run');assert.equal(r.filled.join(','),'maximum_tower_height');
 assert.equal(r.patch.maximum_tower_height,'150 ft');assert.equal(r.patch.field_release_policy,'reviewed_fields_only');
 const evidence=JSON.parse(r.patch.field_confidence_json);assert.ok(Object.values(evidence).some(e=>e.status==='pending'&&e.quote===quote));
 assert.equal(r.patch.verified_fields,undefined);assert.equal(r.patch.verification_status,undefined);
});
test('filled cells and alternate height columns are preserved',()=>{
 for(const old of [{maximum_tower_height:'199 ft'},{height_by_right_ft:199}]){
 const r=buildRailwayPatch({...row,...old},extraction,retrieval,'admin','run');assert.equal(r.filled.length,0);assert.equal(r.patch.maximum_tower_height,undefined);}
});
test('URL or rule intake preserves owner-accepted row policy',()=>{
 const r=buildRailwayPatch({...row,verification_status:'master_accepted'},extraction,retrieval,'admin','run');
 assert.equal(r.patch.field_release_policy,undefined);assert.equal(r.patch.verification_status,undefined);
});
test('invented quote is rejected',()=>{const r=buildRailwayPatch(row,extraction,{...retrieval,raw_ordinance_text:'Unrelated source text'},'admin','run');assert.equal(r.filled.length,0);});
test('invented value is rejected even when quote is real',()=>{const x=structuredClone(extraction);x.fields[0].value='250 ft';assert.equal(buildRailwayPatch(row,x,retrieval,'admin','run').filled.length,0);});
test('invented section is rejected',()=>{const x=structuredClone(extraction);x.fields[0].section_ref='Sec. 99';assert.equal(buildRailwayPatch(row,x,retrieval,'admin','run').filled.length,0);});
test('wrong state and wrong jurisdiction cannot fill cells',()=>{
 assert.throws(()=>buildRailwayPatch(row,{...extraction,state:'FL'},retrieval,'admin','run'));
 assert.throws(()=>buildRailwayPatch(row,{...extraction,jurisdiction_name:'Orange'},retrieval,'admin','run'));
});
test('retired rows cannot be enriched',()=>assert.throws(()=>buildRailwayPatch({...row,archived:true},extraction,retrieval,'admin','run')));
test('unlisted columns are ignored',()=>{const x=structuredClone(extraction);x.fields[0].column='submittal_deadlines';assert.equal(buildRailwayPatch(row,x,retrieval,'admin','run').filled.length,0);});
test('publisher hostname spoof is refused',()=>assert.throws(()=>approvedOrdinanceUrl('https://municode.com.evil.example/code')));
const payload={platforms:{government:{municipalities:[{state:'OH',municipality:'Licking',jurisdiction_type:'county',url:row.ordinance_url}]}}};
test('repeated incoming URL is deduplicated',()=>{const x=structuredClone(payload);x.platforms.government.municipalities.push(x.platforms.government.municipalities[0]);assert.equal(parseHarvest(x).length,1);});
test('actual user package uses ordinance_source_url and preserves all reference URLs',()=>{
 const x=parseHarvest({municipalities:[{jurisdiction:'Licking',state:'OH',kind:'county',url:'',ordinance_source_url:row.ordinance_url,all_urls:['https://lickingcounty.gov/planning']}]});
 assert.equal(x[0].url,row.ordinance_url);assert.equal(x[0].reference_urls.length,2);
});
test('missing and unclassified URLs are held without aborting the batch',()=>{
 const x=parseHarvest({municipalities:[{jurisdiction:'Licking',state:'OH',kind:'county',url:'https://example.org/planning'},{jurisdiction:'Orange',state:'FL',kind:'county',url:''}]});
 assert.equal(planHarvest(x,[row])[0].action,'needs_source_review');assert.equal(x[1].url,'');
});
test('conflicting incoming URL fails before intake',()=>{const x=structuredClone(payload);x.platforms.government.municipalities.push({...x.platforms.government.municipalities[0],url:'https://lickingcounty.gov/other'});assert.throws(()=>parseHarvest(x));});
test('city and county are not interchanged',()=>{const p=planHarvest(parseHarvest(payload),[{...row,jurisdiction_kind:'city'}]);assert.equal(p[0].action,'needs_identity');});
test('duplicate active master identities are held',()=>{const p=planHarvest(parseHarvest(payload),[row,{...row,id:'other'}]);assert.equal(p[0].action,'ambiguous');});
test('existing source URLs are preserved',()=>{const p=planHarvest(parseHarvest(payload),[{...row,ordinance_url:'https://lickingcounty.gov/old'}]);assert.equal(p[0].action,'preserve_existing');});
test('Bay Lake is never assigned Bay County ordinance',()=>{
 const items=parseHarvest({municipalities:[{jurisdiction:'Bay Lake',state:'FL',kind:'municipality',ordinance_source_url:'https://library.municode.com/fl/bay_county/codes/code_of_ordinances'}]});
 const out=planHarvest(items,[{id:'baylake',state:'FL',county:'Bay Lake',jurisdiction_kind:'city'}]);assert.equal(out[0].action,'needs_source_review');
});
test('an exact Municode state and municipality may fill a blank source URL',()=>{
 const items=parseHarvest({municipalities:[{jurisdiction:'Alachua',state:'FL',kind:'municipality',ordinance_source_url:'https://library.municode.com/fl/alachua/codes/code_of_ordinances'}]});
 assert.equal(planHarvest(items,[{id:'alachua',state:'FL',county:'Alachua',jurisdiction_kind:'city'}])[0].action,'fill_missing_url');
});
test('unmatched jurisdiction never creates a row',()=>assert.equal(planHarvest(parseHarvest(payload),[])[0].action,'needs_identity'));
test('five-digit county FIPS remains text and scopes identity',()=>{
 const x=structuredClone(payload);x.platforms.government.municipalities[0].county_fips='01001';
 const parsed=parseHarvest(x);assert.equal(parsed[0].county_fips,'01001');assert.equal(planHarvest(parsed,[{...row,county_fips:'01003'}])[0].action,'needs_identity');
});
test('compare-and-set requires a row version',async()=>{
 let writes=0;await assert.rejects(()=>compareAndSetMaster({updateMany:async()=>writes++},{id:'master'},{maximum_tower_height:'x'}));assert.equal(writes,0);
});
test('compare-and-set uses the version and lease owner',async()=>{
 let q;await compareAndSetMaster({updateMany:async(query)=>{q=query},get:async()=>row},row,{maximum_tower_height:'150 ft'},'run');
 assert.equal(q.updated_date,'v1');assert.equal(q['railway_enrichment.request_id'],'run');
});
(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name)}catch(e){failed++;console.error('FAIL '+name+': '+e.message)}}console.log(`${tests.length-failed}/${tests.length} checks passed`);if(failed)process.exitCode=1})();
