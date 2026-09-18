// One-time Accomack release verification. Launch window is intentionally bounded.
// Uses existing service credentials internally; logs receipts, never credentials.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const origin = "https://mcp-zoning-scraper-production.up.railway.app";
const emit = (event, data={}) => console.log(JSON.stringify({canary:"accomack-20260918",event,...data}));
let phase="preflight", jobId=null;
const guard=setTimeout(()=>{emit("timeout",{phase,job_id:jobId});process.exit(1)},720000);
const client=new Client({name:"sitehawk-accomack-verification",version:"1.0.0"});
function failureCode(error) {
 const s=String(error?.message||error);
 if(/external zoning ingest is frozen/i.test(s))return "BASE44_EXTERNAL_INGEST_FROZEN";
 if(/Base44 ingest failed \(401\)/i.test(s))return "BASE44_UNAUTHORIZED";
 if(/Base44 ingest failed \(403\)/i.test(s))return "BASE44_FORBIDDEN";
 if(/401|Unauthorized/i.test(s))return "AUTHENTICATION_REJECTED";
 if(/No usable source content/i.test(s))return "SOURCE_RETRIEVAL_FAILED";
 if(/rejected.*evidence|evidence.*rejected/i.test(s))return "EVIDENCE_REJECTED";
 if(/notion/i.test(s))return "NOTION_ERROR";
 if(/supabase/i.test(s))return "SUPABASE_ERROR";
 if(/Base44/i.test(s))return "BASE44_ERROR";
 return "CANARY_FAILED";
}
async function call(name,args) {
 const r=await client.callTool({name,arguments:args},undefined,{timeout:60000});
 const t=r.content?.find(x=>x.type==="text")?.text;
 const p=t?JSON.parse(t):null;
 if(r.isError||!p||p.ok===false)throw Error(p?.error||"MCP request failed");
 return p;
}
try {
 if(Date.now()>Date.parse("2026-09-18T16:15:00Z"))throw Error("Canary launch window expired");
 if(!process.env.MCP_AUTH_TOKEN)throw Error("Missing existing service authentication");
 const h=await fetch(origin+"/health",{signal:AbortSignal.timeout(15000)}).then(r=>r.json());
 if(!h.ok||h.active_job||h.active_enrichment_job||h.triple_destination?.broad_sweep_blocked!==true||h.triple_destination?.configured!==true)throw Error("Preflight not clear");
 emit("preflight_passed",{broad_sweep_blocked:true,active_jobs:0});
 phase="mcp_initialize";
 await client.connect(new StreamableHTTPClientTransport(new URL(origin+"/mcp"),{requestInit:{headers:{Authorization:"Bearer "+process.env.MCP_AUTH_TOKEN}}}));
 const discovered=await client.listTools();
 const names=discovered.tools.map(t=>t.name);
 if(!names.includes("startJurisdictionEnrichment")||!names.includes("getJurisdictionEnrichmentStatus"))throw Error("Required tools missing");
 emit("mcp_connected",{tool_names:names});
 phase="start_accomack";
 const start=await call("startJurisdictionEnrichment",{jurisdiction:"Accomack County",state:"VA",urls:[{url:"https://library.municode.com/va/accomack_county/codes/code_of_ordinances?nodeId=CO_CH106ZO_ARTXGEPR_S106-237STANTO",authority_level:"tower_rules"}],writeToNotion:true,replaceExisting:true});
 jobId=start.job_id;
 emit("job_started",{job_id:jobId,existing:start.existing,started:start.started});
 if(!jobId)throw Error("No job ID");
 phase="poll";
 for(let n=0;n<80;n++){
   const p=await call("getJurisdictionEnrichmentStatus",{job_id:jobId});
   if(p.status==="failed")throw Error(p.error||"Job failed");
   if(p.status==="done"){
     const d=p.result?.destination_proof;
     if(d?.verified!==true||d.base44?.verified!==true||d.notion?.verified!==true||d.supabase?.verified!==true)throw Error("Destination proofs incomplete");
     emit("verified",{job_id:jobId,run_id:p.result.run_id,destination_proof:d,sources:p.result.sources?.map(s=>({url:s.url,ok:s.ok,method:s.method,chars:s.chars})),verification_status:p.result.stats?.verification_status,review_required:p.result.stats?.review_required});
     phase="complete";break;
   }
   if(n%6===0)emit("running",{job_id:jobId});
   await new Promise(r=>setTimeout(r,8000));
 }
 if(phase!=="complete")throw Error("Job polling deadline exceeded");
}catch(error){
 emit("failed",{phase,job_id:jobId,code:failureCode(error)});
 process.exitCode=1;
}finally{
 clearTimeout(guard);
 await client.close().catch(()=>{});
}
