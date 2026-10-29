import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createApplications,DISCORD_DEFAULTS,createDiscord} from '../applications.mjs';
const owner='1445069224899907709',id='111111111111111111';
const answers={character:'عمر منصور',age:'23',experience:'لعبت رول بلاي قبل كده وبفصل معلوماتي عن معلومات الشخصية.',story:'شخصيتي جاية المدينة عشان تبدأ شغل جديد وتتعرف على ناس وتبني مستقبلها خطوة بخطوة وتساعد أصحابها وقت الحاجة.',scenario:'هحترم قيمة حياة شخصيتي وأسلم المطلوب مني ومش هستخدم معلومات من بره السيناريو.',rules:true};
function fixture(){const db=new DatabaseSync(':memory:'),calls=[];let dmBlocked=false,missing=false;
 const discord={ready:true,async member(){return missing?null:{joined_at:'2026-10-01',user:{bot:false}}},async role(...args){calls.push(['role',...args])},async message(...args){calls.push(['message',...args]);return {id:'msg'}},async dm(...args){calls.push(['dm',...args]);if(dmBlocked)throw Object.assign(Error('closed'),{status:403})},async call(path,method,body){calls.push(['call',path,method,body]);return {id:'review-message'}}};
 return {db,calls,discord,blockDM:()=>dmBlocked=true,leave:()=>missing=true,app:createApplications({db,discord,owner,siteURL:'https://omen-rp2.github.io/Omen_Web/'})}}
test('membership check, one active application, durable review delivery and pending role',async()=>{const f=fixture();try{
 await f.app.requireMember(id);f.app.onboard(id,{joined_at:'2026-10-01'});f.app.onboard(id,{joined_at:'2026-10-01'});await f.app.drain();assert.equal(f.calls.filter(x=>x[0]==='message').length,1);
 assert.throws(()=>f.app.submit(id,{...answers,story:'short'}),/كمّل/);
 const a=f.app.submit(id,answers);assert.equal(a.status,'pending');assert.throws(()=>f.app.submit(id,answers),/عندك طلب/);await f.app.drain();
 assert.ok(f.calls.some(x=>x[0]==='role'&&x[2]===DISCORD_DEFAULTS.pendingRole&&x[3]===true));
 const msg=f.calls.find(x=>x[0]==='call'&&x[1].endsWith('/messages'));assert.ok(msg[1].includes(DISCORD_DEFAULTS.reviewChannel));const form=msg[3];assert.ok(form instanceof FormData);const payload=JSON.parse(form.get('payload_json'));assert.equal(payload.components[0].components[0].custom_id,`omen:accept:${a.id}`);assert.match(await form.get('files[0]').text(),/عمر منصور/);
 f.leave();await assert.rejects(f.app.requireMember(id),e=>e.status===403);
}finally{f.db.close()}});
test('review authorization, required rejection reason, closed DMs do not erase result',async()=>{const f=fixture();try{
 const a=f.app.submit(id,answers);await f.app.drain();assert.throws(()=>f.app.decide({discord_id:id},{id:a.id,status:'accepted'}),e=>e.status===403);
 assert.throws(()=>f.app.decide({discord_id:owner},{id:a.id,status:'rejected',reason:''}),e=>e.status===400);
 f.blockDM();f.app.decideFromChannel(id,{id:a.id,status:'rejected',reason:'إجابات السيناريو محتاجة توضيح أكتر.'});await f.app.drain();
 assert.equal(f.app.latest(id).status,'rejected');assert.equal(f.app.latest(id).reviewer,id);assert.match(f.app.latest(id).reason,/توضيح/);
 assert.ok(f.calls.some(x=>x[0]==='role'&&x[2]===DISCORD_DEFAULTS.pendingRole&&x[3]===false));assert.ok(f.calls.some(x=>x[0]==='role'&&x[2]===DISCORD_DEFAULTS.acceptedRole&&x[3]===false));
 assert.ok(f.app.health().jobs.some(x=>x.status==='blocked'));assert.throws(()=>f.app.decideFromChannel(id,{id:a.id,status:'accepted'}),e=>e.status===409);assert.throws(()=>f.app.submit(id,answers),/24 ساعة/);
 const update=f.calls.find(x=>x[0]==='call'&&x[2]==='PATCH');assert.deepEqual(update[3].components,[]);
}finally{f.db.close()}});
test('acceptance grants accepted role, removes pending and prevents resubmission',async()=>{const f=fixture();try{
 const a=f.app.submit(id,answers);await f.app.drain();f.app.decide({discord_id:owner},{id:a.id,status:'accepted'});await f.app.drain();assert.equal(f.app.approved(id),true);
 assert.ok(f.calls.some(x=>x[0]==='role'&&x[2]===DISCORD_DEFAULTS.acceptedRole&&x[3]===true));assert.ok(f.calls.some(x=>x[0]==='role'&&x[2]===DISCORD_DEFAULTS.pendingRole&&x[3]===false));assert.ok(f.calls.some(x=>x[0]==='dm'&&x[2].includes('قبول')));assert.throws(()=>f.app.submit(id,answers),/مقبول/);
}finally{f.db.close()}});
test('Discord outage retries survive workflow recreation and never leak bot token to body',async()=>{
 const db=new DatabaseSync(':memory:');let fail=true;const calls=[];const discord={ready:true,role:async()=>{if(fail)throw Error('offline')},call:async(...x)=>{calls.push(x);return {id:'m'}}};
 try{const app=createApplications({db,discord,owner,siteURL:'https://example.test'});app.submit(id,answers);await app.drain();assert.ok(app.health().jobs.some(x=>x.status==='waiting'));fail=false;db.prepare("UPDATE discord_jobs SET next_at=0").run();const reloaded=createApplications({db,discord,owner,siteURL:'https://example.test'});await reloaded.drain();assert.ok(!reloaded.health().jobs.some(x=>x.status==='waiting'));
 let request;const rest=createDiscord({token:'test-only-token',fetcher:async(url,options)=>{request={url,options};return {ok:true,status:204}}});await rest.role(id,DISCORD_DEFAULTS.memberRole,true);assert.equal(request.options.headers.Authorization,'Bot test-only-token');assert.equal(request.options.body,undefined);
 const missing=createDiscord({token:'test-only-token',fetcher:async()=>({ok:false,status:404})});assert.equal(await missing.member(id),null);
 }finally{db.close()}
});
test('review-channel buttons allow ordinary viewers, block other channels, and collect rejection reason',async()=>{
 const {handleReviewInteraction}=await import('../applications.mjs');const decisions=[];let modal;
 const app={decideFromChannel:(...x)=>decisions.push(x),drain:async()=>{}};
 const make=()=>({customId:'omen:accept:7',guildId:DISCORD_DEFAULTS.guildId,channelId:DISCORD_DEFAULTS.reviewChannel,member:{},user:{id},channel:{permissionsFor:()=>({has:()=>true})},isButton:()=>true,reply:async function(x){this.response=x},deferReply:async function(){this.deferred=true},editReply:async function(x){this.response=x},showModal:async x=>{modal=x}});
 let i=make();i.channelId='111111111111111112';await handleReviewInteraction(i,{guildId:DISCORD_DEFAULTS.guildId,applications:app});assert.equal(decisions.length,0);
 i=make();i.channel.permissionsFor=()=>({has:()=>false});await handleReviewInteraction(i,{guildId:DISCORD_DEFAULTS.guildId,applications:app});assert.equal(decisions.length,0);
 i=make();await handleReviewInteraction(i,{guildId:DISCORD_DEFAULTS.guildId,applications:app});assert.deepEqual(decisions[0],[id,{id:7,status:'accepted',reason:''}]);
 i=make();i.customId='omen:reject:8';await handleReviewInteraction(i,{guildId:DISCORD_DEFAULTS.guildId,applications:app});assert.equal(modal.toJSON().custom_id,'omen:reason:8');assert.equal(decisions.length,1);
 i=make();i.customId='omen:reason:8';i.fields={getTextInputValue:()=> 'الإجابات محتاجة توضيح.'};await handleReviewInteraction(i,{guildId:DISCORD_DEFAULTS.guildId,applications:app});assert.equal(decisions[1][1].status,'rejected');assert.equal(decisions[1][1].reason,'الإجابات محتاجة توضيح.');
});
