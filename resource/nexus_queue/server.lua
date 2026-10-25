local queue, pending, attempts, online = {}, {}, {}, {}
local secret = GetConvar('nexus_queue_secret', '')
local sequence = 0
local function now() return os.time() end
local function licenseOf(src)
    for _, id in ipairs(GetPlayerIdentifiers(src)) do
        if id:sub(1,8) == 'license:' then return id end
    end
end
local function request(path, payload, callback)
    local finished = false
    SetTimeout(Config.HttpTimeoutSeconds * 1000, function()
        if not finished then finished = true; callback(nil) end
    end)
    PerformHttpRequest(Config.Api .. path, function(status, body)
        if finished then return end
        finished = true
        if status ~= 200 then return callback(nil) end
        local ok, data = pcall(json.decode, body or '')
        callback(ok and data or nil)
    end, 'POST', json.encode(payload), {['Content-Type']='application/json', ['Authorization']='Bearer '..secret})
end
local function publish(e, status, position, total)
    request('/bridge/status', {license=e.license,status=status,position=position or 0,total=total or #queue,
        graceUntil=e.expires and e.expires*1000 or 0}, function() end)
end
local function find(id)
    for i,e in ipairs(queue) do if e.license == id then return e,i end end
end
local function card(def, title, text, actions)
    def.presentCard({type='AdaptiveCard',version='1.0',body={
        {type='TextBlock',text=Config.Brand..' / CITY ACCESS',size='Large',weight='Bolder',color='Warning'},
        {type='TextBlock',text=title,size='ExtraLarge',weight='Bolder',wrap=true},
        {type='TextBlock',text=text,wrap=true},
        {type='TextBlock',text='Reconnect protection: '..Config.GraceSeconds..' seconds',isSubtle=true,wrap=true}
    },actions=actions or {{type='Action.OpenUrl',title='Open website',url=Config.Website}}})
end
local function disconnect(e)
    if e.expires then return end
    e.src=nil; e.def=nil; e.expires=now()+Config.GraceSeconds
    publish(e,'grace')
end
AddEventHandler('playerConnecting', function(name, _, def)
    local src=source
    def.defer(); Wait(0)
    if #secret<32 then def.done('Queue configuration error. Contact staff.'); return end
    local id=licenseOf(src)
    if not id then def.done('Rockstar license unavailable. Restart FiveM.'); return end
    if attempts[id] or pending[id] or online[id] then def.done('A connection for your account is already active.'); return end
    local old=find(id)
    -- A reconnect can precede playerDropped. Only replace an already absent transport.
    if old and old.src then
        if GetPlayerName(old.src) then def.done('Your previous connection is still active. Close it and retry.'); return end
        disconnect(old)
    end
    if old and old.expires and old.expires<=now() then
        local _,i=find(id);table.remove(queue,i);old=nil
    end
    local token={src=src};attempts[id]=token
    local function finish(reason)
        if attempts[id]==token then attempts[id]=nil end
        Wait(0);def.done(reason)
    end
    local identity
    local function lookup()
        local result=false
        request('/bridge/identity',{license=id,discord=GetPlayerIdentifierByType(src,'discord')},function(data) result=data or {error=true} end)
        while not result do Wait(50) end
        return result
    end
    identity=lookup()
    if identity.error then finish('Website unavailable. Please retry shortly.'); return end
    if not identity.registered then
        local retry=false
        def.presentCard({type='AdaptiveCard',version='1.0',body={
            {type='TextBlock',text=Config.Brand..' / LINK ACCOUNT',size='Large',weight='Bolder',color='Warning'},
            {type='TextBlock',text='Register on our website and enter this code:',wrap=true},
            {type='TextBlock',text=identity.code,size='ExtraLarge',weight='Bolder'},
            {type='TextBlock',text='Code expires in 5 minutes. Then press Verify.',wrap=true}
        },actions={{type='Action.OpenUrl',title='Open website',url=Config.Website},{type='Action.Submit',title='Verify account',data={verify=true}}}},function(data) if data and data.verify then retry=true end end)
        local deadline=now()+300
        while not retry and now()<deadline and GetPlayerName(src) do Wait(250) end
        if not retry then finish('Link timed out. Connect again for a new code.'); return end
        identity=lookup()
        if identity.error or not identity.registered then finish('Account not linked yet. Finish linking on the website and reconnect.');return end
    end
    if not GetPlayerName(src) then attempts[id]=nil; return end
    -- Re-read after HTTP yields: expired reservations may have been cleaned meanwhile.
    local e=find(id)
    if not e then
        sequence=sequence+1;e={license=id,ticket=sequence,bypass=identity.bypass==true}
        if e.bypass then
            local at=#queue+1
            for i,q in ipairs(queue) do if not q.bypass then at=i;break end end
            table.insert(queue,at,e)
        else queue[#queue+1]=e end
    end
    e.src=src;e.def=def;e.expires=nil;e.name=name;e.rank=identity.priority;e.username=identity.username
    attempts[id]=nil
    -- Central loop alone mutates admission state. No per-connection slot race.
end)
AddEventHandler('playerDropped',function()
    local src=source
    for _,e in ipairs(queue) do if e.src==src then disconnect(e);return end end
    for id,p in pairs(pending) do
        if p.src==src then pending[id]=nil;p.def=nil;p.src=nil;p.expires=now()+Config.GraceSeconds;table.insert(queue,1,p);publish(p,'grace');return end
    end
    for id,s in pairs(online) do if s==src then online[id]=nil;publish({license=id},'expired');return end end
end)
AddEventHandler('playerJoining',function(oldID)
    local src=source
    for id,p in pairs(pending) do
        if tostring(p.src)==tostring(oldID) then pending[id]=nil;online[id]=src;publish(p,'online');return end
    end
end)
CreateThread(function()
    -- Track players already connected after a resource restart.
    for _,s in ipairs(GetPlayers()) do local id=licenseOf(s);if id then online[id]=tonumber(s) end end
    while true do
        Wait(1000)
        for i=#queue,1,-1 do
            local e=queue[i]
            if e.src and not GetPlayerName(e.src) then disconnect(e) end
            if e.expires and e.expires<=now() then table.remove(queue,i);publish(e,'expired') end
        end
        for id,p in pairs(pending) do
            if not GetPlayerName(p.src) or p.deadline<=now() then
                pending[id]=nil
                if GetPlayerName(p.src) then DropPlayer(p.src,'Connection timed out. Reconnect within 20 seconds to restore your place.') end
                p.src=nil;p.expires=now()+Config.GraceSeconds
                -- An admitted ticket belonged before every remaining waiter.
                table.insert(queue,1,p);publish(p,'grace')
            end
        end
        local excluded={}
        for _,q in ipairs(queue) do if q.src then excluded[tostring(q.src)]=true end end
        for _,a in pairs(attempts) do excluded[tostring(a.src)]=true end
        local occupied=0
        local listed={}
        for _,s in ipairs(GetPlayers()) do
            if not excluded[tostring(s)] then occupied=occupied+1;listed[tostring(s)]=true end
        end
        for _,p in pairs(pending) do if not listed[tostring(p.src)] then occupied=occupied+1 end end
        local cap=math.min(Config.MaxPlayers,GetConvarInt('sv_maxclients',Config.MaxPlayers))
        -- A grace ticket blocks overtaking until reconnect or expiry.
        local e=queue[1]
        local admissionCap=e and e.bypass and cap or math.max(0,cap-(Config.ReservedSlots or 0))
        if e and not e.expires and e.src and occupied<admissionCap then
            table.remove(queue,1);e.deadline=now()+Config.JoinTimeoutSeconds;pending[e.license]=e
            publish(e,'connecting');local def=e.def;e.def=nil;def.done()
        end
        for i,p in ipairs(queue) do
            publish(p,p.expires and 'grace' or 'waiting',i,#queue)
            if p.def then
                card(p.def,'Position '..i..' / '..#queue,
                    'Welcome '..p.username..'\nYour ticket: #'..p.ticket..'\nYour place is reserved for 20 seconds after a detected disconnect.\nKeep this window open.')
            end
        end
    end
end)
AddEventHandler('onResourceStop',function(resource)
    if resource~=GetCurrentResourceName() then return end
    for _,e in ipairs(queue) do if e.def then e.def.done('Queue restarting. Please reconnect.') end end
end)
