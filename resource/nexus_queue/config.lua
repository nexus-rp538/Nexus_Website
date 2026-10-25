Config = {
    Brand = 'NEXUS',
    Website = 'https://queue.example.com',
    Api = 'http://127.0.0.1:3000',
    GraceSeconds = 20,
    MaxPlayers = 48, -- must match sv_maxclients
    JoinTimeoutSeconds = 120,
    HttpTimeoutSeconds = 8,
    -- Existing entries are never overtaken. Priority is a stable ticket, not paid overtaking.
}
