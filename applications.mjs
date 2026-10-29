// Discord REST access and durable application workflow. No credentials reach the browser.
export const DISCORD_DEFAULTS = Object.freeze({
 guildId:'1561064547853402234',welcomeChannel:'1561064550303015088',
 memberRole:'1561064547895222275',acceptedRole:'1561064547895222278',pendingRole:'1561064547895222277',reviewChannel:'1561064552764936308'
});
export function createDiscord({token,fetcher=fetch,guildId=DISCORD_DEFAULTS.guildId}={}) {
 async function call(path,method='GET',data){
  if(!token)throw Error('ربط Discord غير مكتمل.');
  const r=await fetcher('https://discord.com/api/v10'+path,{method,signal:AbortSignal.timeout(12000),headers:{Authorization:'Bot '+token,...(data instanceof FormData?{}:{'Content-Type':'application/json'})},body:data instanceof FormData?data:data?JSON.stringify(data):undefined});
  if(!r.ok){const e=Error(r.status===403?'البوت لا يمتلك الصلاحيات اللازمة.':r.status===429?'Discord مشغول، سيتم إعادة المحاولة.':'تعذر التواصل مع Discord.');e.status=r.status;throw e;}
  return r.status===204?null:r.json();
 }
 return {ready:!!token,guildId,call,
  async member(id){try{return await call(`/guilds/${guildId}/members/${id}`)}catch(e){if(e.status===404)return null;throw e}},
  async role(id,role,add){return call(`/guilds/${guildId}/members/${id}/roles/${role}`,add?'PUT':'DELETE')},
  async message(channel,content,mentionId){return call(`/channels/${channel}/messages`,'POST',{content,allowed_mentions:{parse:[],users:mentionId?[mentionId]:[]}})},
  async dm(id,content){const c=await call('/users/@me/channels','POST',{recipient_id:id});return this.message(c.id,content)}
 };
}
export function createApplications({db,discord,owner,reviewers=[],siteURL,roles=DISCORD_DEFAULTS}){
 db.exec(`CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT,discord_id TEXT NOT NULL,answers TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,reviewed_at INTEGER,reviewer TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS application_active ON applications(discord_id) WHERE status IN ('pending','accepted');
 CREATE TABLE IF NOT EXISTS discord_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,job_key TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'waiting',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '');`);
 if(!db.prepare('PRAGMA table_info(applications)').all().some(c=>c.name==='review_message'))db.exec('ALTER TABLE applications ADD COLUMN review_message TEXT');
 const latest=id=>db.prepare('SELECT * FROM applications WHERE discord_id=? ORDER BY id DESC LIMIT 1').get(id)||null;
 const reviewer=u=>!!u?.discord_id&&(u.discord_id===owner||reviewers.includes(u.discord_id));
 function enqueue(key,kind,payload){db.prepare('INSERT OR IGNORE INTO discord_jobs(job_key,kind,payload) VALUES(?,?,?)').run(key,kind,JSON.stringify(payload))}
 async function requireMember(id){if(!discord.ready)throw Object.assign(Error('تسجيل الدخول والتقديم ينتظران تفعيل ربط Discord.'),{status:503});const m=await discord.member(id);if(!m||m.user?.bot)throw Object.assign(Error('لازم تنضم لسيرفر أومن على Discord الأول، وبعدها تسجّل الدخول.'),{status:403});return m}
 function onboard(id,m){
  enqueue(`member:${id}:${m.joined_at||'first'}`,'welcome',{id});
  enqueue(`roles:${id}:${m.joined_at||'first'}:login:${latest(id)?.id||0}:${latest(id)?.status||'new'}`,'roles',{id});
 }
 async function syncRoles(id){
  const a=latest(id);await discord.role(id,roles.memberRole,true);
  // Apply the target role before removing a previous state. Operations are idempotent.
  if(a?.status==='pending'){await discord.role(id,roles.pendingRole,true);await discord.role(id,roles.acceptedRole,false)}
  else {if(a?.status==='accepted')await discord.role(id,roles.acceptedRole,true);else await discord.role(id,roles.acceptedRole,false);await discord.role(id,roles.pendingRole,false)}
 }
 let draining=false;
 async function drain(){if(draining||!discord.ready)return;draining=true;try{
  const jobs=db.prepare("SELECT * FROM discord_jobs WHERE status='waiting' AND next_at<=? ORDER BY id LIMIT 15").all(Date.now());
  for(const job of jobs){try{
   const p=JSON.parse(job.payload);
   if(job.kind==='welcome'){await discord.role(p.id,roles.memberRole,true);await discord.message(roles.welcomeChannel,`أهلًا <@${p.id}> في OMEN ROLEPLAY 🟠\nحكايتك بتبدأ هنا. قدّم بدون مقابلة وتابع نتيجة طلبك من الموقع:\n${siteURL}`,p.id)}
   if(job.kind==='roles')await syncRoles(p.id);
   if(job.kind==='review'){
    const a=db.prepare('SELECT * FROM applications WHERE id=?').get(p.applicationId);const answers=JSON.parse(a.answers);
    const payload={
     content:`تقديم جديد من <@${a.discord_id}> · طلب #${a.id}`,
     allowed_mentions:{parse:[]},embeds:[{title:'OMEN | تقديم بدون مقابلة',color:0xff792f,
      description:'المراجعة متاحة لأي عضو يقدر يشوف الروم. الرفض يحتاج سبب.',
      fields:[{name:'الشخصية',value:answers.character},{name:'العمر',value:answers.age},
       {name:'الخبرة',value:answers.experience.slice(0,1024)},{name:'قصة الشخصية',value:answers.story.slice(0,1024)},
       {name:'التصرف في السيناريو',value:answers.scenario.slice(0,1024)}],footer:{text:`Discord ID: ${a.discord_id} • الإجابات الكاملة في الملف المرفق`}}],
     components:a.status==='pending'?[{type:1,components:[{type:2,style:3,label:'قبول',custom_id:`omen:accept:${a.id}`},{type:2,style:4,label:'رفض مع السبب',custom_id:`omen:reject:${a.id}`}]}]:[]};
    const full=`OMEN — طلب #${a.id}\nDiscord ID: ${a.discord_id}\n\n`+Object.entries({character:'الشخصية',age:'العمر',experience:'الخبرة',story:'القصة',scenario:'السيناريو'}).map(([k,label])=>label+':\n'+answers[k]).join('\n\n');
    const form=new FormData();form.append('payload_json',JSON.stringify(payload));form.append('files[0]',new Blob([full],{type:'text/plain;charset=utf-8'}),`omen-application-${a.id}.txt`);
    const msg=await discord.call(`/channels/${roles.reviewChannel}/messages`,'POST',form);
    db.prepare('UPDATE applications SET review_message=? WHERE id=?').run(msg.id,a.id);
   }
   if(job.kind==='review-update'){
    const a=db.prepare('SELECT * FROM applications WHERE id=?').get(p.applicationId);
    if(!a.review_message)throw Error('رسالة المراجعة لم تصل بعد.');
    await discord.call(`/channels/${roles.reviewChannel}/messages/${a.review_message}`,'PATCH',{content:`طلب #${a.id} من <@${a.discord_id}> · ${a.status==='accepted'?'تم القبول ✅':'تم الرفض ❌'}\nبواسطة <@${a.reviewer}>${a.reason?'\nالسبب: '+a.reason:''}`,allowed_mentions:{parse:[]},components:[]});
   }
   if(job.kind==='decision'){
    const a=db.prepare('SELECT * FROM applications WHERE id=?').get(p.applicationId);
    await discord.dm(p.id,a.status==='accepted'?`مبروك! تم قبول تقديمك في OMEN ROLEPLAY 🟠\nرقم الطلب: #${a.id}\n${siteURL}`:`تم رفض طلبك #${a.id} في OMEN ROLEPLAY.\nالسبب: ${a.reason}\nتقدر تتابع التفاصيل من الموقع: ${siteURL}`);
   }
   db.prepare("UPDATE discord_jobs SET status='done',last_error='' WHERE id=?").run(job.id);
  }catch(e){
   // Closed DMs are recorded; the decision remains available in the user's account.
   const permanent=job.kind==='decision'&&e.status===403;
   db.prepare('UPDATE discord_jobs SET status=?,attempts=attempts+1,next_at=?,last_error=? WHERE id=?').run(permanent?'blocked':'waiting',Date.now()+Math.min(3600000,30000*2**Math.min(job.attempts,7)),String(e.message).slice(0,200),job.id);
  }}
 }finally{draining=false}}
 function submit(id,b){
  const fields={character: [3,80],age:[1,3],experience:[20,1800],story:[80,3000],scenario:[40,2000]};const answers={};
  for(const [key,[min,max]] of Object.entries(fields)){const value=typeof b[key]==='string'?b[key].trim():'';if(value.length<min||value.length>max)throw Object.assign(Error('كمّل إجابات التقديم بالطول المطلوب.'),{status:400});answers[key]=value}
  if(!/^\d{1,3}$/.test(answers.age)||Number(answers.age)<1||Number(answers.age)>120||b.rules!==true)throw Object.assign(Error('راجع العمر ووافق على قوانين السيرفر.'),{status:400});
  const previous=latest(id);if(previous&&previous.status!=='rejected')throw Object.assign(Error('عندك طلب قيد المراجعة أو مقبول بالفعل.'),{status:409});
  if(previous&&Date.now()-previous.reviewed_at<86400000)throw Object.assign(Error('تقدر تقدم تاني بعد 24 ساعة من قرار الرفض.'),{status:409});
  db.exec('BEGIN IMMEDIATE');try{
   const r=db.prepare("INSERT INTO applications(discord_id,answers,status,created_at) VALUES(?,?,'pending',?)").run(id,JSON.stringify(answers),Date.now());
   enqueue(`application:${r.lastInsertRowid}:pending`,'roles',{id});enqueue(`application:${r.lastInsertRowid}:review`,'review',{applicationId:Number(r.lastInsertRowid)});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}return latest(id);
 }
 function decide(u,b,channelAuthorized=false){
  if(!reviewer(u)&&!channelAuthorized)throw Object.assign(Error('ليس لديك صلاحية مراجعة الطلبات.'),{status:403});
  if(!Number.isSafeInteger(b.id)||!['accepted','rejected'].includes(b.status))throw Object.assign(Error('قرار غير صحيح.'),{status:400});
  const reason=String(b.reason||'').trim();if(b.status==='rejected'&&(reason.length<5||reason.length>1000))throw Object.assign(Error('اكتب سبب الرفض من 5 إلى 1000 حرف.'),{status:400});
  db.exec('BEGIN IMMEDIATE');try{
   const a=db.prepare('SELECT * FROM applications WHERE id=?').get(b.id);if(!a)throw Object.assign(Error('الطلب غير موجود.'),{status:404});if(a.status!=='pending')throw Object.assign(Error('الطلب اتراجع بالفعل.'),{status:409});
   db.prepare('UPDATE applications SET status=?,reason=?,reviewed_at=?,reviewer=? WHERE id=?').run(b.status,b.status==='rejected'?reason:'',Date.now(),u.discord_id,b.id);
   enqueue(`application:${b.id}:decision-roles`,'roles',{id:a.discord_id});enqueue(`application:${b.id}:decision-dm`,'decision',{id:a.discord_id,applicationId:b.id});enqueue(`application:${b.id}:review-update`,'review-update',{applicationId:b.id});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}return db.prepare('SELECT * FROM applications WHERE id=?').get(b.id);
 }
 const health=()=>({ready:discord.ready,jobs:db.prepare("SELECT status,COUNT(*) AS count FROM discord_jobs GROUP BY status").all()});
 return {decideFromChannel:(actor,b)=>decide({discord_id:actor},b,true),latest,reviewer,requireMember,onboard,drain,submit,decide,health,
  list(status='pending'){return db.prepare('SELECT * FROM applications WHERE status=? ORDER BY created_at LIMIT 200').all(status)},
  approved:id=>latest(id)?.status==='accepted',
  retry(){db.prepare("UPDATE discord_jobs SET status='waiting',next_at=0 WHERE status='blocked'").run()}
 };
}
export async function startWelcomeBot({token,guildId,applications}){
 if(!token)return null;
 const {Client,GatewayIntentBits,Events}=await import('discord.js');
 const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers]});
 client.on(Events.GuildMemberAdd,member=>{if(member.guild.id!==guildId||member.user.bot)return;applications.onboard(member.id,{joined_at:member.joinedAt?.toISOString()});void applications.drain()});
 client.on(Events.InteractionCreate,interaction=>void handleReviewInteraction(interaction,{guildId,applications}));
 client.on(Events.Error,()=>console.error('Discord gateway connection error.'));
 try{await client.login(token)}catch{console.error('Discord bot login failed. Check token and Server Members Intent.');client.destroy()}
 return client;
}

export async function handleReviewInteraction(interaction,{guildId,applications}){
 const {ModalBuilder,TextInputBuilder,TextInputStyle,ActionRowBuilder,MessageFlags,PermissionFlagsBits}=await import('discord.js');
  const match=/^omen:(accept|reject|reason):(\d+)$/.exec(interaction.customId||'');if(!match)return;
  try{
   if(interaction.guildId!==guildId||interaction.channelId!==DISCORD_DEFAULTS.reviewChannel||!interaction.member)return interaction.reply({content:'راجع الطلب من روم التقديمات الأصلي.',flags:MessageFlags.Ephemeral});
   const channel=interaction.channel||await interaction.guild.channels.fetch(interaction.channelId);
   if(!channel?.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel))return interaction.reply({content:'لا يمكنك مراجعة هذا الطلب.',flags:MessageFlags.Ephemeral});
   const id=Number(match[2]);
   if(match[1]==='reject'&&interaction.isButton()){
    const input=new TextInputBuilder().setCustomId('reason').setLabel('سبب الرفض').setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1000).setRequired(true);
    const modal=new ModalBuilder().setCustomId(`omen:reason:${id}`).setTitle(`رفض الطلب #${id}`).addComponents(new ActionRowBuilder().addComponents(input));return interaction.showModal(modal);
   }
   await interaction.deferReply({flags:MessageFlags.Ephemeral});
   const reason=match[1]==='reason'?interaction.fields.getTextInputValue('reason'):'';
   applications.decideFromChannel(interaction.user.id,{id,status:match[1]==='accept'?'accepted':'rejected',reason});
   void applications.drain();await interaction.editReply('تم حفظ القرار. هتتحدث الرتب والنتيجة، والبوت هيحاول يبعت رسالة خاصة للاعب.');
  }catch(e){const content=e.status?e.message:'تعذر تنفيذ القرار. حاول تاني.';if(interaction.deferred||interaction.replied)await interaction.editReply(content).catch(()=>{});else await interaction.reply({content,flags:MessageFlags.Ephemeral}).catch(()=>{})}
}
