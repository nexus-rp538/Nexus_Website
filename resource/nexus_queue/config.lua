Config = {
    Brand = 'QUEUE',
    Website = 'https://nexus-rp538.github.io/Nexus_Website/',
    Api = 'http://127.0.0.1:3000',
    GraceSeconds = 20,
    ReservedSlots = 2, -- keep slots available for owner / bypass accounts
    MaxPlayers = 48, -- must match sv_maxclients
    JoinTimeoutSeconds = 120,
    HttpTimeoutSeconds = 8,
    -- Existing entries are never overtaken. Priority is a stable ticket, not paid overtaking.
}
