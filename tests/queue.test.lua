-- Deterministic mocked FXServer: run using any Lua 5.4 interpreter.
local clock=1000
os.time=function()return clock end
local handlers,threads,names,statuses,ids={}, {}, {}, {}, {}
function GetConvar()return string.rep('a',64)end
function GetConvarInt()return 1 end
function GetPlayerIdentifiers(s)return {ids[s]}end
function GetPlayerName(s)return names[s]end
function GetPlayers()return {'999'}end -- one full slot
function Wait()coroutine.yield()end
function SetTimeout()end
function AddEventHandler(e,f)handlers[e]=f end
function CreateThread(f)threads[#threads+1]=coroutine.create(f)end
function GetCurrentResourceName()return 'nexus_queue'end
function DropPlayer(s)names[s]=nil end
json={encode=function(x)return x end,decode=function(x)return x end}
function PerformHttpRequest(url,cb,method,b)
 if url:find('/identity')then cb(200,{registered=true,username='player',priority=0})else statuses[b.license]=b;cb(200,{ok=true})end
end
dofile('resource/nexus_queue/config.lua')
dofile('resource/nexus_queue/server.lua')
local function resume(c)local ok,e=coroutine.resume(c);assert(ok,e)end
local function tick()for _,c in ipairs(threads)do resume(c)end end
local function connect(s,id)
 names[s]='Player';ids[s]='license:'..id;source=s
 local d={defer=function()end,done=function()end,presentCard=function()end}
 local c=coroutine.create(function()handlers.playerConnecting('Player',nil,d)end)
 resume(c);resume(c)
end
-- Start central scheduler, then fill 30 tickets.
tick()
for i=1,30 do connect(i,string.format('%x',i))end
tick();assert(statuses['license:a'].position==10);assert(statuses['license:a'].total==30)
names[10]=nil;source=10;handlers.playerDropped();tick()
assert(statuses['license:a'].status=='grace')
clock=1019;connect(110,'a');tick()
assert(statuses['license:a'].position==10,'reconnect must keep ticket 10')
assert(statuses['license:a'].total==30)
names[110]=nil;source=110;handlers.playerDropped()
clock=1040;tick();assert(statuses['license:a'].status=='expired')
connect(210,'a');tick();assert(statuses['license:a'].position==30,'expired ticket joins tail')
print('PASS: 10/30 restored before 20s; expired ticket joins tail')
