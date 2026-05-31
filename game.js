// Dungeon Fragments — main game logic.
// Depends on music.js (MusicEngine global).

// Game configuration
const TILESIZE = 32;
const GRIDSIZE = 20;
const CANVASSIZE = TILESIZE * GRIDSIZE;

// Tunable constants. Group by system; change here, see effect everywhere.
const CONFIG = {
    difficulty: {
        linearPerFloor: 0.3,          // floor scaling: + (f * linearPerFloor)
        polyDivisor: 50,              // + (f / polyDivisor) ^ polyExponent
        polyExponent: 2.2,
        cubicThreshold: 100,          // past this floor, add cubic kicker
        cubicDivisor: 40,
        cubicExponent: 2.5,
        enemySafeRadius: 3,           // tiles from player where enemies cannot spawn
    },
    enemies: {
        baseCount: 5,                 // floor 1 enemy count
        countPerFloorEarly: 1.6,      // enemies added per floor up to 50
        countPerFloorLate: 0.5,       // enemies added per floor after 50
        countRampThreshold: 50,
        bossMinFloorRamp: 8,          // bosses start ramping past this floor
        bossLogMultiplier: 1.5,       // log2(floor-8) * this = extra bosses
        bossMaxCount: 8,
        rareBossMinFloor: 5,
        rareBossBaseChance: 0.3,
        rareBossChancePerFloor: 0.1,
        rareBossDoubleSpawnFloor: 12,
        eliteMinFloor: 15,
        eliteBaseChance: 0.3,
        eliteChancePerFloor: 0.05,
        eliteMaxChance: 0.8,
        eliteDoubleSpawnFloor: 30,
        // Enemy stat multipliers vs base
        bossHpMult: 3, bossAtkMult: 1.7,
        rareBossHpMult: 5, rareBossAtkMult: 2.5,
        normalAtkMult: 1.15,
    },
    combat: {
        aoeBaseRadius: 3,
        aoeBaseCost: 10,
        aoeFloorCostPer: 15,          // +1 MP per N floors
        aoeMultiplier: 1.5,
        arcaneWardAoeReduction: 0.25, // dmg multiplier (so they take 25%)
        manaBurnPerStack: 3,          // +MP per stacked AOE without moving
        psychicFlareExtraCost: 5,
        kineticStackMax: 4,
        kineticPerStack: 0.6,         // additive: damage *= 1 + perStack * stacks (was 2^stacks pre-overhaul)
        bulwarkDmgPerStack: 0.20,     // +20% damage per stack
        bulwarkDefPerStack: 0.05,     // +5% DEF per stack
        bulwarkStackMax: 5,
        ironRootsDmgPerStack: 0.08,   // +8% damage per stack — gentler than bulwark
        ironRootsDefPerStack: 0.04,   // +4% DEF per stack
        ironRootsStackMax: 5,         // stacks alongside bulwark (different passive, same archetype)
        bleedFraction: 1 / 5,         // bleed dmg = maxHp * this
        bleedDuration: 3,
        chronoStrikeCadence: 4,       // every Nth attack triggers
        chronoStrikeDmgFraction: 0.5,
        berserkerLowHpThreshold: 0.3, // <30% maxHp
        executionerLowHpThreshold: 0.4,
        lastStandThreshold: 0.25,
        siphonMaxPerKill: 15,         // hard cap on MP restore per kill
        defendDefMult: 1.5,           // Wait/Defend action: +50% effective DEF this turn
    },
    enemyKinds: {
        // Spawn weights — relative odds vs Grunt(100)
        chargerWeight: 35,
        rangerWeight: 20,
        healerWeight: 20,             // bumped from 10 — was too rare to shape encounters
        // Behaviour tuning
        chargerDashDist: 3,           // tiles per dash
        rangerFireRange: 6,           // max orthogonal range to fire
        healerHealPct: 0.08,          // % of ally's maxHp restored per heal
        healerHealRange: 2,           // manhattan range
    },
    items: {
        maxPotions: 50,
    },
    terrain: {
        // Walls — random impassable tiles. Blocks player + enemies, blocks ranger LOS,
        // halts charger dashes. Scales with floor up to a cap. No walls on F1-2 (intro).
        wallMinFloor: 3,
        wallBaseCount: 3,
        wallPerFloor: 0.4,
        wallMaxCount: 18,
        wallSafeRadiusFromPlayer: 2, // walls won't spawn within this manhattan dist of the player
    },
};

// Grid walkability helpers. Used by player movement, enemy AIs, charger dash, ranger LOS.
function isInBounds(x, y) {
    return x >= 0 && x < GRIDSIZE && y >= 0 && y < GRIDSIZE;
}
function isWall(x, y) {
    const walls = gameState.walls;
    if (!walls) return false;
    for (let i = 0; i < walls.length; i++) {
        if (walls[i].x === x && walls[i].y === y) return true;
    }
    return false;
}
function isWalkable(x, y) {
    return isInBounds(x, y) && !isWall(x, y);
}
// Orthogonal line-of-sight check — true if no walls between (fromX,fromY) and (toX,toY).
// Only meaningful when one of dx/dy is 0 (caller's responsibility).
function hasLineOfSight(fromX, fromY, toX, toY) {
    const dx = Math.sign(toX - fromX);
    const dy = Math.sign(toY - fromY);
    let x = fromX + dx, y = fromY + dy;
    while (x !== toX || y !== toY) {
        if (isWall(x, y)) return false;
        x += dx; y += dy;
    }
    return true;
}

// Game state
let gameState = {
    selectedClass: null, // set by selectClass(); read by startGame() to apply class kit
    lastLevelUpAlloc: null, // snapshot of last confirmed stat allocation; powers the REPEAT LAST button
    player: {
        x: 10,
        y: 10,
        hp: 100,
        maxHp: 100,
        mp: 50,
        maxMp: 50,
        atk: 10,
        def: 5,
        spd: 3,
        luck: 0,
        level: 1,
        xp: 0,
        xpToNext: 100,
        crit: 5,
        inventory: [],
        equipped: {
            weapon: null,
            helmet: null,
            chest: null,
            legs: null,
            gloves: null,
            boots: null,
            cape: null,
            relic: null
        },
        potions: 3,
        passiveEffects: {},
        recentMoves: 0,
        turnsSinceHit: 0,
        kineticStacks: 0,
        medallions: [],
        affinities: { ATK: 0, DEF: 0, SPD: 0, CRIT: 0, LUCK: 0 },
        bulwarkStacks: 0,
        ironRootsStacks: 0,
        defendingTurns: 0, // set to 1 by defend(), read by getEffectivePlayerDef during enemy turn, cleared after
        guardianShellStacks: 0,
        adrenalineTurns: 0,
        precisionStacks: 0,
        enemiesHitThisFight: [],
        chronoCounter: 0,
        dualPassives: [],
        unyieldingForceStacks: 0,
        blitzStrikeMoves: 0,
        blitzStrikeCharged: false,
        evasiveBulwarkShield: 0,
        evasiveBulwarkTurns: 0,
        phantomAssaultMoves: 0,
        phantomAssaultCharged: false,
        fortunesGuardUsed: false,
        plundererBonusLuck: 0,
        // Mastery state
        masteries: [],
        berserkersFuryStacks: 0,
        flashPointAttacks: 0,
        flashPointFirstAttack: true,
        stormDancerCooldown: 0,
        stormDancerMoves: 0,
        livingFortressSpdTurns: 0,
        luckyStarUsed: false,
        mirageCharged: false,
        goldTiles: [],
        bastionStuns: {},
        chaosEngineLastStat: null,
        chaosEngineLastBonus: 0,
        convergenceStacks: 0,
        manaBurnStacks: 0
    },
    enemies: [],
    floorModifiers: [],
    playerDebuffs: [],
    sacrificeAltar: null,
    altarUsed: false,
    deathsCountdownTurns: 0,
    treasureTiles: [],
    floor: 1,
    floorsCleared: 0, // counts stairs + warps as 1 each (telemetry; warps shouldn't inflate +10/+30)
    walls: [],
    gameRunning: false,
    overlayOpen: false,
    lastMoveTime: 0,
    enemyMoveTime: 0,
    particles: [],
    stairs: null,
    stats: {
        kills: 0,
        bossKills: 0,
        rareBossKills: 0,
        itemsCollected: 0,
        legendaryItems: 0,
        mythicItems: 0,
        ascendedItems: 0
    },
    discardCounts: {
        COMMON: 0,
        UNCOMMON: 0,
        RARE: 0,
        EPIC: 0,
        LEGENDARY: 0,
        MYTHIC: 0,
        ASCENDED: 0
    },
    pendingStatPoints: 0,
    tempAllocations: {
        maxHp: 0,
        maxMp: 0,
        atk: 0,
        def: 0,
        spd: 0,
        crit: 0
        // luck removed — never offered as a level-up stat row
    }
};

// ═══════════════════════════════════════════════════════
// PRESTIGE / META-PROGRESSION SYSTEM
// ═══════════════════════════════════════════════════════

const PRESTIGE_UPGRADES = {
    // Iron Foundation
    hardenedBody:      { name: "Hardened Body",      desc: "+10 starting Max HP per tier",           maxTier: 5, costs: [50, 120, 250, 500, 1000],  category: "iron" },
    sharpenedEdge:     { name: "Sharpened Edge",     desc: "+2 starting ATK per tier",               maxTier: 5, costs: [75, 175, 350, 700, 1400],  category: "iron" },
    thickSkin:         { name: "Thick Skin",         desc: "+2 starting DEF per tier",               maxTier: 3, costs: [80, 200, 500],             category: "iron" },
    quickFeet:         { name: "Quick Feet",         desc: "+1 starting SPD per tier",               maxTier: 3, costs: [100, 250, 600],            category: "iron" },
    potionSatchel:     { name: "Potion Satchel",     desc: "+1 starting potion per tier",            maxTier: 3, costs: [60, 175, 400],             category: "iron" },
    manaWell:          { name: "Mana Well",          desc: "+10 starting Max MP per tier",           maxTier: 3, costs: [60, 150, 350],             category: "iron" },
    // Fortune's Favor
    luckyStars:        { name: "Lucky Stars",        desc: "+3 starting Luck per tier",              maxTier: 5, costs: [80, 200, 450, 900, 1800],  category: "fortune" },
    keenEye:           { name: "Keen Eye",           desc: "+1 starting Crit per tier",              maxTier: 3, costs: [120, 300, 700],            category: "fortune" },
    rarityBoost:       { name: "Rarity Boost",       desc: "5% chance per tier for drops to upgrade one rarity", maxTier: 3, costs: [200, 600, 1500], category: "fortune" },
    scavenger:         { name: "Scavenger",          desc: "+5% potion drop rate per tier",          maxTier: 3, costs: [100, 275, 650],            category: "fortune" },
    experienced:       { name: "Experienced",        desc: "+10% XP gained per tier",                maxTier: 3, costs: [150, 400, 900],            category: "fortune" },
    // Dungeon Mastery
    warriorsGrowth:    { name: "Warrior's Growth",   desc: "+5% ATK from level-ups per tier",        maxTier: 5, costs: [100, 250, 550, 1100, 2200], category: "mastery" },
    survivorsInstinct: { name: "Survivor's Instinct",desc: "+5% DEF from level-ups per tier",        maxTier: 5, costs: [100, 250, 550, 1100, 2200], category: "mastery" },
    momentumBuilder:   { name: "Momentum Builder",   desc: "+5% damage per floor cleared (caps at floor 10)", maxTier: 3, costs: [200, 600, 1500], category: "mastery" },
    potionMastery:     { name: "Potion Mastery",     desc: "Potions heal +10% more per tier",        maxTier: 3, costs: [120, 325, 750],            category: "mastery" },
    criticalEscalation:{ name: "Critical Escalation",desc: "+3% crit damage multiplier per tier",    maxTier: 3, costs: [225, 600, 1400],           category: "mastery" },
    // Arcane Secrets
    affinityInitiate:  { name: "Affinity Initiate",  desc: "Start each run with 1 free Affinity point", maxTier: 1, costs: [750],                   category: "arcane" },
    thirdEye:          { name: "Third Eye",          desc: "Unlock a 3rd dual passive slot",         maxTier: 1, costs: [2000],                     category: "arcane" },
    headStart:         { name: "Head Start",         desc: "Start on a higher floor (2/3/4)",        maxTier: 3, costs: [300, 800, 2000],           category: "arcane" },
    weaponCache:       { name: "Weapon Cache",       desc: "Starter weapon guaranteed better rarity", maxTier: 2, costs: [250, 800],                category: "arcane" },
    fragmentMagnet:    { name: "Fragment Magnet",    desc: "+15% fragments earned per tier",          maxTier: 3, costs: [175, 500, 1200],           category: "arcane" }
};

const PRESTIGE_ECHOES = {
    // Tier 1 — Early milestones (first few runs)
    endurance:    { name: "Echo: Endurance",    desc: "+5 Max HP permanently",                          condition: "Reach floor 15",              check: (d) => d.lifetimeStats.highestFloor >= 15 },
    slayer:       { name: "Echo: Slayer",       desc: "+2 ATK permanently",                             condition: "100 lifetime kills",          check: (d) => d.lifetimeStats.totalKills >= 100 },
    bossHunter:   { name: "Echo: Boss Hunter",  desc: "+1 DEF permanently",                             condition: "10 lifetime boss kills",      check: (d) => d.lifetimeStats.totalBossKills >= 10 },
    collector:    { name: "Echo: Collector",    desc: "+3 Luck permanently",                            condition: "5 lifetime legendary+ items", check: (d) => d.lifetimeStats.totalLegendaryItems + d.lifetimeStats.totalMythicItems + d.lifetimeStats.totalAscendedItems >= 5 },
    // Tier 2 — Mid milestones (dedicated runs)
    delver:       { name: "Echo: Delver",       desc: "+1 stat point per level-up (6 instead of 5)",    condition: "Reach floor 30",              check: (d) => d.lifetimeStats.highestFloor >= 30 },
    ascendant:    { name: "Echo: Ascendant",    desc: "Ascended items unlock at 70 Luck instead of 80", condition: "Reach floor 50",             check: (d) => d.lifetimeStats.highestFloor >= 50 },
    veteran:      { name: "Echo: Veteran",      desc: "+1 SPD permanently",                             condition: "Complete 5 runs",             check: (d) => d.totalRuns >= 5 },
    hoarder:      { name: "Echo: Hoarder",      desc: "+2 starting potions permanently",                condition: "Collect 50 lifetime items",   check: (d) => d.lifetimeStats.totalItemsCollected >= 50 },
    // Tier 3 — Hard milestones (require good builds)
    deepDiver:    { name: "Echo: Deep Diver",   desc: "+3 ATK and +3 DEF permanently",                  condition: "Reach floor 100",             check: (d) => d.lifetimeStats.highestFloor >= 100 },
    massacre:     { name: "Echo: Massacre",      desc: "+2 Crit permanently",                            condition: "500 lifetime kills",          check: (d) => d.lifetimeStats.totalKills >= 500 },
    mythicHunter: { name: "Echo: Mythic Hunter", desc: "+5 Luck permanently",                           condition: "Find 3 mythic+ items total",  check: (d) => d.lifetimeStats.totalMythicItems + d.lifetimeStats.totalAscendedItems >= 3 },
    persistent:   { name: "Echo: Persistent",   desc: "+10 Max HP and +5 Max MP permanently",           condition: "Complete 15 runs",            check: (d) => d.totalRuns >= 15 },
    // Tier 4 — Very hard milestones (optimized play)
    abyssWalker:  { name: "Echo: Abyss Walker", desc: "+5 ATK and +2 SPD permanently",                  condition: "Reach floor 200",             check: (d) => d.lifetimeStats.highestFloor >= 200 },
    warlord:      { name: "Echo: Warlord",      desc: "+3 Crit and +3 DEF permanently",                 condition: "Kill 25 rare bosses total",   check: (d) => d.lifetimeStats.totalRareBossKills >= 25 },
    relicMaster:  { name: "Echo: Relic Master",  desc: "Start with +5 to all stats permanently",        condition: "Find 10 ascended items total", check: (d) => d.lifetimeStats.totalAscendedItems >= 10 },
    grinder:      { name: "Echo: Grinder",       desc: "+2 to all stats permanently",                   condition: "Complete 30 runs",            check: (d) => d.totalRuns >= 30 },
    // Tier 5 — Elite milestones (true dedication)
    voidConqueror:{ name: "Echo: Void Conqueror", desc: "+8 ATK and +5 Crit permanently",               condition: "Reach floor 350",             check: (d) => d.lifetimeStats.highestFloor >= 350 },
    legendSlayer: { name: "Echo: Legend Slayer",  desc: "+5 to all stats permanently",                   condition: "2000 lifetime kills",         check: (d) => d.lifetimeStats.totalKills >= 2000 },
    trueCollector:{ name: "Echo: True Collector", desc: "Start with +10 Luck permanently",              condition: "25 ascended items total",     check: (d) => d.lifetimeStats.totalAscendedItems >= 25 },
    undying:      { name: "Echo: Undying",        desc: "+20 Max HP and +3 DEF permanently",             condition: "Complete 50 runs",            check: (d) => d.totalRuns >= 50 }
};

const PRESTIGE_CATEGORIES = [
    { key: "iron",    name: "Iron Foundation",  color: "#4ecdc4", desc: "Starting Bonuses" },
    { key: "fortune", name: "Fortune's Favor",  color: "#ffd93d", desc: "Loot & Quality of Life" },
    { key: "mastery", name: "Dungeon Mastery",  color: "#ff6b9d", desc: "Scaling Bonuses" },
    { key: "arcane",  name: "Arcane Secrets",   color: "#cc66ff", desc: "Unlocks & Meta" }
];

const defaultPrestigeData = {
    version: 1,
    fragments: 0,
    totalFragmentsEarned: 0,
    totalRuns: 0,
    upgrades: {
        hardenedBody: 0, sharpenedEdge: 0, thickSkin: 0, quickFeet: 0, potionSatchel: 0, manaWell: 0,
        luckyStars: 0, keenEye: 0, rarityBoost: 0, scavenger: 0, experienced: 0,
        warriorsGrowth: 0, survivorsInstinct: 0, momentumBuilder: 0, potionMastery: 0, criticalEscalation: 0,
        affinityInitiate: 0, thirdEye: 0, headStart: 0, weaponCache: 0, fragmentMagnet: 0
    },
    echoes: {
        endurance: false, slayer: false, bossHunter: false, collector: false,
        delver: false, ascendant: false, veteran: false, hoarder: false,
        deepDiver: false, massacre: false, mythicHunter: false, persistent: false,
        abyssWalker: false, warlord: false, relicMaster: false, grinder: false,
        voidConqueror: false, legendSlayer: false, trueCollector: false, undying: false
    },
    lifetimeStats: {
        highestFloor: 0, highestLevel: 0, totalKills: 0, totalBossKills: 0, totalRareBossKills: 0,
        totalItemsCollected: 0, totalLegendaryItems: 0, totalMythicItems: 0, totalAscendedItems: 0,
        bestRunFragments: 0,
        // Per-class telemetry — see incrementClassRun / recordClassDeath.
        // Keys match CLASSES ids. Lets future balance passes work from data, not vibes.
        runsByClass:        { brawler: 0, trickster: 0, sentinel: 0, mage: 0 },
        floorsByClass:      { brawler: 0, trickster: 0, sentinel: 0, mage: 0 },
        highestFloorByClass:{ brawler: 0, trickster: 0, sentinel: 0, mage: 0 }
    },
    bestRun: { floor: 0, level: 0, kills: 0, fragments: 0 }
};

let prestigeData = null;

function loadPrestige() {
    try {
        const raw = localStorage.getItem('dungeonFragments_prestige');
        if (raw) {
            const loaded = JSON.parse(raw);
            const mergedLifetimeStats = { ...defaultPrestigeData.lifetimeStats, ...(loaded.lifetimeStats || {}) };
            // Deep-merge per-class stat sub-objects so new classes (mage, etc.) get a 0 entry on existing saves.
            ['runsByClass', 'floorsByClass', 'highestFloorByClass'].forEach(k => {
                mergedLifetimeStats[k] = { ...defaultPrestigeData.lifetimeStats[k], ...(mergedLifetimeStats[k] || {}) };
            });
            prestigeData = {
                ...JSON.parse(JSON.stringify(defaultPrestigeData)),
                ...loaded,
                upgrades: { ...defaultPrestigeData.upgrades, ...(loaded.upgrades || {}) },
                echoes: { ...defaultPrestigeData.echoes, ...(loaded.echoes || {}) },
                lifetimeStats: mergedLifetimeStats,
                bestRun: { ...defaultPrestigeData.bestRun, ...(loaded.bestRun || {}) }
            };
        } else {
            prestigeData = JSON.parse(JSON.stringify(defaultPrestigeData));
        }
    } catch(e) {
        prestigeData = JSON.parse(JSON.stringify(defaultPrestigeData));
    }
}

function savePrestige() {
    try {
        localStorage.setItem('dungeonFragments_prestige', JSON.stringify(prestigeData));
    } catch(e) {}
}

function getPrestigeLevel(key) {
    return prestigeData ? (prestigeData.upgrades[key] || 0) : 0;
}

function calculateFragments() {
    const s = gameState.stats;
    const p = gameState.player;
    const floor = gameState.floor;
    let base = 0;
    if (floor <= 5) base = floor * 2;
    else if (floor <= 15) base = 10 + (floor - 5) * 3;
    else base = 40 + (floor - 15) * 5;
    const killBonus = Math.floor(Math.sqrt(s.kills) * 2);
    const bossBonus = s.bossKills * 3 + s.rareBossKills * 8;
    const levelBonus = p.level * 2;
    const itemBonus = s.legendaryItems * 2 + s.mythicItems * 5 + s.ascendedItems * 10;
    let total = base + killBonus + bossBonus + levelBonus + itemBonus;
    const multiplier = 1.0 + (getPrestigeLevel('fragmentMagnet') * 0.15);
    return Math.floor(total * multiplier);
}

function checkEchoMilestones() {
    let newEchoes = [];
    for (const [key, echo] of Object.entries(PRESTIGE_ECHOES)) {
        if (!prestigeData.echoes[key] && echo.check(prestigeData)) {
            prestigeData.echoes[key] = true;
            newEchoes.push(echo.name);
        }
    }
    return newEchoes;
}

function exportSave() {
    try {
        const data = btoa(JSON.stringify(prestigeData));
        const textarea = document.getElementById('export-import-text');
        if (textarea) {
            textarea.value = data;
            textarea.select();
        }
        navigator.clipboard.writeText(data).catch(() => {});
        return data;
    } catch(e) { return ""; }
}

function importSave() {
    try {
        const textarea = document.getElementById('export-import-text');
        if (!textarea || !textarea.value.trim()) return false;
        const data = JSON.parse(atob(textarea.value.trim()));
        if (data.version) {
            const mergedLifetimeStats = { ...defaultPrestigeData.lifetimeStats, ...(data.lifetimeStats || {}) };
            ['runsByClass', 'floorsByClass', 'highestFloorByClass'].forEach(k => {
                mergedLifetimeStats[k] = { ...defaultPrestigeData.lifetimeStats[k], ...(mergedLifetimeStats[k] || {}) };
            });
            prestigeData = {
                ...JSON.parse(JSON.stringify(defaultPrestigeData)),
                ...data,
                upgrades: { ...defaultPrestigeData.upgrades, ...(data.upgrades || {}) },
                echoes: { ...defaultPrestigeData.echoes, ...(data.echoes || {}) },
                lifetimeStats: mergedLifetimeStats,
                bestRun: { ...defaultPrestigeData.bestRun, ...(data.bestRun || {}) }
            };
            savePrestige();
            renderPrestigeShop();
            return true;
        }
    } catch(e) {}
    return false;
}

// Load prestige data on init
loadPrestige();
updateTitleFragments();

// Canvas setup
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');


// Item rarities and passive effects
const RARITIES = {
    COMMON: { name: "Common", color: "#aaa", dropChance: 0.45, statMult: 1, numPassives: 0 },
    UNCOMMON: { name: "Uncommon", color: "#1eff00", dropChance: 0.28, statMult: 1.3, numPassives: 0 },
    RARE: { name: "Rare", color: "#0070dd", dropChance: 0.15, statMult: 1.7, numPassives: 1 },
    EPIC: { name: "Epic", color: "#a335ee", dropChance: 0.07, statMult: 2.2, numPassives: 1 },
    LEGENDARY: { name: "Legendary", color: "#ff8000", dropChance: 0.035, statMult: 3, numPassives: 2 },
    MYTHIC: { name: "Mythic", color: "#ff4444", dropChance: 0.005, statMult: 4, numPassives: 3 },
    ASCENDED: { name: "Ascended", color: "#00ffcc", dropChance: 0.001, statMult: 5.5, requiresLuck: 80, numPassives: 4 }
};

// Single source of truth for rarity ordering. Used by drop rolls, upgrades, displays.
const RARITY_ORDER = [
    RARITIES.COMMON, RARITIES.UNCOMMON, RARITIES.RARE, RARITIES.EPIC,
    RARITIES.LEGENDARY, RARITIES.MYTHIC, RARITIES.ASCENDED
];

// Returns the next-tier rarity, or null if already at max.
function nextRarity(rarity) {
    const idx = RARITY_ORDER.indexOf(rarity);
    return (idx >= 0 && idx < RARITY_ORDER.length - 1) ? RARITY_ORDER[idx + 1] : null;
}

// Legendary tier and above (the "rare passives" cutoff).
function isLegendaryPlus(rarity) {
    return rarity === RARITIES.LEGENDARY || rarity === RARITIES.MYTHIC || rarity === RARITIES.ASCENDED;
}

const PASSIVEEFFECTS = [
    // ATK affinity
    { name: "Berserker", desc: "More ATK at low HP + flat % damage per adjacent enemy", stat: "berserker", range: [20, 60], affinity: "ATK" },
    { name: "Executioner", desc: "Deal 25-50% more damage to enemies below 40% HP", stat: "executioner", range: [25, 50], affinity: "ATK" },
    { name: "Overwhelm", desc: "First hit on a target deals 15-35% bonus damage", stat: "overwhelm", range: [15, 35], affinity: "ATK" },
    { name: "Redundant Force", desc: "Increased ATK based on base ATK stat", stat: "redundantForce", range: [5, 20], affinity: "ATK" },
    { name: "Overcharge", desc: "Base ATK from level-ups multiplied by 1.5-3x (gear ATK unaffected)", stat: "overcharge", range: [150, 300], affinity: "ATK" },

    // DEF affinity
    { name: "Fortified", desc: "Bonus defense", stat: "fortify", range: [5, 20], affinity: "DEF" },
    { name: "Regeneration", desc: "Heal % of max HP per turn", stat: "regen", range: [4, 8], affinity: "DEF" },
    { name: "Bulwark", desc: "Each turn standing still: +20% damage AND +5% DEF (max 5 stacks, resets on move)", stat: "bulwark", range: [1, 1], affinity: "DEF" },
    { name: "Last Stand", desc: "Gain 50-80% DEF when below 25% HP", stat: "lastStand", range: [50, 80], affinity: "DEF" },
    { name: "Guardian Shell", desc: "Taking damage grants stacking 2-5% damage reduction (max 5 stacks)", stat: "guardianShell", range: [2, 5], affinity: "DEF" },
    { name: "Iron Will", desc: "Increased ATK based on base DEF stat", stat: "ironWill", range: [5, 20], affinity: "DEF" },
    { name: "Ironheart", desc: "Base DEF from level-ups grants 1-3% damage reduction cap per point", stat: "ironheart", range: [1, 3], affinity: "DEF" },
    { name: "Tenacity", desc: "Start each floor with a shield equal to 15-40% of base DEF. Unspent shield converts to bonus XP", stat: "tenacity", range: [15, 40], affinity: "DEF" },
    { name: "Iron Roots", desc: "Each turn standing still: +8% damage AND +4% DEF (max 5 stacks, resets on move). Stacks alongside Bulwark", stat: "ironRoots", range: [1, 1], affinity: "DEF" },

    // SPD affinity
    { name: "Swift", desc: "Increase movement speed", stat: "speed", range: [5, 10], affinity: "SPD" },
    { name: "Evasion", desc: "Chance to dodge attacks based on SPD", stat: "evasion", range: [5, 25], affinity: "SPD" },
    { name: "Momentum", desc: "Deal more damage based on SPD + bonus speed", stat: "momentum", range: [5, 25], affinity: "SPD" },
    { name: "Adrenaline", desc: "Gain 10-25% SPD after killing an enemy (3 turns)", stat: "adrenaline", range: [10, 25], affinity: "SPD" },
    { name: "Phantom Step", desc: "Moving through enemies deals 10-30% ATK as damage", stat: "phantomStep", range: [10, 30], affinity: "SPD" },
    { name: "Fleetfoot Strikes", desc: "Increased ATK based on base SPD stat", stat: "fleetfootStrikes", range: [5, 20], affinity: "SPD" },
    { name: "Battle Tempo", desc: "Move 3-6 tiles without taking damage to deal 50-100% bonus on next attack. Resets on hit taken", stat: "battleTempo", range: [50, 100], affinity: "SPD" },
    { name: "Adrenaline Surge", desc: "On kill, gain 1 bonus move (max 1-3 per turn, scales with SPD). Doesn't trigger enemy movement", stat: "adrenalineSurge", range: [1, 3], affinity: "SPD" },

    // CRIT affinity
    { name: "Critical", desc: "Increase crit chance", stat: "crit", range: [5, 25], affinity: "CRIT" },
    { name: "Deadeye", desc: "Crit damage increased by 25-75%", stat: "deadeye", range: [25, 75], affinity: "CRIT" },
    { name: "Precision", desc: "Gain 5-20% crit chance after not critting, resets on crit", stat: "precision", range: [5, 20], affinity: "CRIT" },
    { name: "Weakpoint Specialist", desc: "10-30% more damage to bosses and rare bosses", stat: "weakpointSpecialist", range: [10, 30], affinity: "CRIT" },
    { name: "Shatterpoint", desc: "Crits reduce enemy DEF by 10-30% for 2 turns", stat: "shatterpoint", range: [10, 30], affinity: "CRIT" },
    { name: "Assassin", desc: "Increased ATK based on base crit stat", stat: "assassin", range: [5, 20], affinity: "CRIT" },
    { name: "Lethal Focus", desc: "Every 3rd consecutive crit guarantees a Legendary+ drop from next kill", stat: "lethalFocus", range: [1, 1], affinity: "CRIT" },

    // LUCK affinity
    { name: "Lucky", desc: "Better loot drops", stat: "luck", range: [2, 15], affinity: "LUCK" },
    { name: "Chemist", desc: "% chance to not consume potion on use (caps at 50%)", stat: "chemist", range: [1, 10], affinity: "LUCK" },
    { name: "Scrapper", desc: "50% chance to give 2 towards discard progression instead of 1", stat: "scrapper", range: [1, 1], affinity: "LUCK" },
    { name: "Lucky Ascension", desc: "1-5% chance gear drops as next rarity up (mythic/ascended excluded)", stat: "luckyAscension", range: [1, 5], affinity: "LUCK" },
    { name: "Fortunate Strikes", desc: "Increased ATK based on base luck stat", stat: "fortunateStrikes", range: [5, 20], affinity: "LUCK" },

    // No affinity (utility)
    { name: "Vampiric", desc: "Heal % of damage dealt", stat: "lifesteal", range: [5, 35], affinity: null },
    { name: "Arcane", desc: "MP cost reduction", stat: "arcane", range: [10, 40], affinity: null }
];

// Dual Skill Passives — unlocked by reaching affinity thresholds in two stats
// Player can have max 2 active dual passives at a time
const DUAL_PASSIVES = [
    { name: "Unyielding Force", stat: "unyieldingForce", affinities: ["ATK", "DEF"], threshold: 5,
      desc: "Damage taken charges next attack for 20-40% bonus. Stacks up to 3 hits." },
    { name: "Blitz Strike", stat: "blitzStrike", affinities: ["ATK", "SPD"], threshold: 5,
      desc: "Move 4 tiles without attacking to charge a Blitz: 80-150% bonus damage + 1 free move." },
    { name: "Executioner's Mark", stat: "executionersMark", affinities: ["ATK", "CRIT"], threshold: 5,
      desc: "Enemies below 30% HP take 50-100% bonus damage. Crit kills on marked enemies always drop gear." },
    { name: "Evasive Bulwark", stat: "evasiveBulwark", affinities: ["DEF", "SPD"], threshold: 5,
      desc: "Dodging grants a shield equal to 10-25% max HP for 3 turns. Stacks with Tenacity." },
    { name: "Thorned Armor", stat: "thornedArmor", affinities: ["DEF", "CRIT"], threshold: 5,
      desc: "Reflect 15-30% of incoming damage back to attacker. Reflected damage can crit." },
    { name: "Fortune's Guard", stat: "fortunesGuard", affinities: ["DEF", "LUCK"], threshold: 5,
      desc: "10-20% chance to survive lethal damage at 1 HP and gain a free potion. Once per floor." },
    { name: "Phantom Assault", stat: "phantomAssault", affinities: ["SPD", "CRIT"], threshold: 5,
      desc: "After moving 2+ tiles, next attack has +20-40% crit chance. Crit grants +1 free move." },
    { name: "Windfall", stat: "windfall", affinities: ["SPD", "LUCK"], threshold: 5,
      desc: "Free moves have 15-30% chance to spawn a potion or gear drop on your tile." },
    { name: "Plunderer", stat: "plunderer", affinities: ["ATK", "LUCK"], threshold: 5,
      desc: "Overkill damage converts to bonus LUCK at 100:1 ratio for the current floor." },
    { name: "Jackpot", stat: "jackpot", affinities: ["CRIT", "LUCK"], threshold: 5,
      desc: "Crit kills have 5-15% chance to drop TWO items. Lethal Focus kills guarantee double drop." }
];

// Mastery passives — require affinity level 8+ in 2-3 stats, only roll on Legendary+
const MASTERY_PASSIVES_DUAL = [
    { name: "War Machine", stat: "warMachine", affinities: ["ATK", "DEF"], threshold: 8, range: [1, 1],
      desc: "Damage adds 25% of total DEF. Attacks bypass Phase Shift dodge." },
    { name: "Berserker's Fury", stat: "berserkersFury", affinities: ["ATK", "SPD"], threshold: 8, range: [1, 1],
      desc: "Each kill grants +3% ATK for the floor (max +30%). Kills grant 1 free move." },
    { name: "Lethal Precision", stat: "lethalPrecision", affinities: ["ATK", "CRIT"], threshold: 8, range: [1, 1],
      desc: "Crits deal 3x base damage. Non-crit attacks deal +15% bonus." },
    { name: "Blood Tithe", stat: "bloodTithe", affinities: ["ATK", "LUCK"], threshold: 8, range: [1, 1],
      desc: "Kills have 25% chance to drop a potion. Overkill heals 10% of overkill amount." },
    { name: "Living Fortress", stat: "livingFortress", affinities: ["DEF", "SPD"], threshold: 8, range: [1, 1],
      desc: "Attacks dealing <10% max HP deal 0 damage. Taking 0 damage grants +2 SPD for 2 turns." },
    { name: "Iron Retaliation", stat: "ironRetaliation", affinities: ["DEF", "CRIT"], threshold: 8, range: [1, 1],
      desc: "When hit, counterattack for 100% DEF as damage. Counterattacks can crit." },
    { name: "Providence", stat: "providence", affinities: ["DEF", "LUCK"], threshold: 8, range: [1, 1],
      desc: "20% chance incoming damage is halved. Gear drops gain +1 passive slot." },
    { name: "Flash Point", stat: "flashPoint", affinities: ["SPD", "CRIT"], threshold: 8, range: [1, 1],
      desc: "First attack each floor is guaranteed crit. Every 3rd attack is guaranteed crit." },
    { name: "Treasure Sense", stat: "treasureSense", affinities: ["SPD", "LUCK"], threshold: 8, range: [1, 1],
      desc: "3-5 hidden treasure tiles per floor. Visible within detection range. Walking over them drops Rare+ gear." },
    { name: "Fortune's Edge", stat: "fortunesEdge", affinities: ["CRIT", "LUCK"], threshold: 8, range: [1, 1],
      desc: "Crit kills have 30% chance to upgrade dropped gear's rarity by 1 tier." }
];

const MASTERY_PASSIVES_TRI = [
    { name: "Warlord", stat: "warlord", affinities: ["ATK", "DEF", "SPD"], threshold: 8, range: [1, 1],
      desc: "ATK and DEF each gain +15% of the average of the other two. +1 SPD per 50 (ATK+DEF)." },
    { name: "Deathbringer", stat: "deathbringer", affinities: ["ATK", "DEF", "CRIT"], threshold: 8, range: [1, 1],
      desc: "Enemies below 50% HP take 2x damage. Killing enemies with DEF > yours heals 25% max HP." },
    { name: "Pirate King", stat: "pirateKing", affinities: ["ATK", "DEF", "LUCK"], threshold: 8, range: [1, 1],
      desc: "All gear drops guaranteed Rare+. Boss kills always drop 2 items." },
    { name: "Storm Dancer", stat: "stormDancer", affinities: ["ATK", "SPD", "CRIT"], threshold: 8, range: [1, 1],
      desc: "After moving 3+ tiles, next attack hits all enemies in 2-tile radius as a crit. 5-turn cooldown." },
    { name: "Gambler's Ruin", stat: "gamblersRuin", affinities: ["ATK", "SPD", "LUCK"], threshold: 8, range: [1, 1],
      desc: "10% chance for 3x damage, 5% chance for 0. Free moves spawn gold tiles (+2 ATK when stepped on)." },
    { name: "Bastion", stat: "bastion", affinities: ["DEF", "SPD", "CRIT"], threshold: 8, range: [1, 1],
      desc: "Moving through enemies deals 50% DEF as damage. This damage can crit and stuns 1 turn on crit." },
    { name: "Lucky Star", stat: "luckyStar", affinities: ["DEF", "SPD", "LUCK"], threshold: 8, range: [1, 1],
      desc: "Dodging has 30% chance to spawn a potion. Lethal damage teleports to random safe tile (1/floor)." },
    { name: "Assassin's Creed", stat: "assassinsCreed", affinities: ["ATK", "CRIT", "LUCK"], threshold: 8, range: [1, 1],
      desc: "Crits ignore 100% enemy DEF. Doubled crit chance vs full-HP enemies." },
    { name: "Mirage", stat: "mirage", affinities: ["SPD", "CRIT", "LUCK"], threshold: 8, range: [1, 1],
      desc: "15% chance attacks phase through you (0 damage). After phasing, next crit deals +50%." },
    { name: "Chaos Engine", stat: "chaosEngine", affinities: ["DEF", "CRIT", "LUCK"], threshold: 8, range: [1, 1],
      desc: "Each turn, one random stat gets +10%. Blocking (DEF > damage) counterattacks and stuns 1 turn." }
];

const ALL_MASTERY_PASSIVES = [...MASTERY_PASSIVES_DUAL, ...MASTERY_PASSIVES_TRI];

// Legendary+ exclusive passives — only roll on Legendary, Mythic, Ascended
const LEGENDARY_PASSIVES = [
    { name: "Soulrend", desc: "Attacks ignore % of enemy DEF", stat: "soulrend", range: [20, 50] },
    { name: "Undying", desc: "Survive lethal hit with 1 HP (cooldown)", stat: "undying", range: [1, 1] },
    { name: "Speedster", desc: "20% base speed + 50% bonus damage from speed", stat: "speedster", range: [20, 20] },
    { name: "Kinetic Reserve", desc: "Moving without attacking grants +60% damage per stack (max 4 stacks)", stat: "kineticReserve", range: [1, 1] },
    { name: "Goldblood", desc: "Luck also boosts ATK and DEF", stat: "goldblood", range: [10, 30] },
    { name: "Siphon", desc: "Kills restore MP", stat: "siphon", range: [10, 30] },
    { name: "Psychic Flare", desc: "AOE range +1 tile, but costs 5 more MP", stat: "psychicFlare", range: [1, 1] },
    { name: "Doom Aura", desc: "Enemies near you take scaling damage each turn", stat: "doomAura", range: [5, 20] }
];

// Ascended Medallion buffs — earned by discarding 10 Ascended items
const MEDALLION_BUFFS = [
    { name: "Double Up", desc: "Equip additional Weapon, Cape, and Relic", stat: "doubleUp" },
    { name: "Lacerating Blows", desc: "All hits crit + bleed (1/5 maxHP/turn for 3 turns)", stat: "laceratingBlows" },
    { name: "Time Dilation", desc: "Speed cannot be lower than 1.5x fastest enemy", stat: "timeDilation" },
    { name: "8-Leaf Clover", desc: "Items always spawn with max base and buff values", stat: "eightLeafClover" },
    { name: "Soul Forge", desc: "Discarding items grants +1 to a random base stat", stat: "soulForge" },
    { name: "Chrono Strike", desc: "Every 4th attack hits twice (2nd hit at 50% damage)", stat: "chronoStrike" }
];

// Endgame enemy modifiers — rolled per floor starting at floor 35, every 5 floors
const ENEMY_MODIFIERS = [
    { name: "Ironclad", desc: "All enemies gain +50% DEF", stat: "ironclad", color: "#8899aa" },
    { name: "Frenzied", desc: "Enemies attack twice per turn", stat: "frenzied", color: "#ff4444" },
    { name: "Vampiric Horde", desc: "Enemies heal 10% of damage dealt", stat: "vampiricHorde", color: "#cc44cc" },
    { name: "Phase Shift", desc: "Enemies have 20% chance to dodge attacks", stat: "phaseShift", color: "#44aaff" },
    { name: "Convergence", desc: "Enemies gain +15% ATK per turn you stand still (max 5)", stat: "convergence", color: "#ff6600" }
];

// AI helpers shared by all ENEMY_KINDS behaviours.
function manhattan(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
}
function clampToGrid(e) {
    e.x = Math.max(0, Math.min(GRIDSIZE - 1, e.x));
    e.y = Math.max(0, Math.min(GRIDSIZE - 1, e.y));
}
// Pick a single-axis step from `e` toward `target`, biased to the dominant axis.
// sign = +1 to approach, -1 to retreat. Wall-aware: if the preferred axis is
// blocked, fall back to the other axis. If both blocked, don't move.
function stepAlongDominantAxis(e, target, sign) {
    const dx = target.x - e.x, dy = target.y - e.y;
    if (dx === 0 && dy === 0) return;
    const sx = sign * (dx > 0 ? 1 : dx < 0 ? -1 : 0);
    const sy = sign * (dy > 0 ? 1 : dy < 0 ? -1 : 0);
    // Prefer dominant axis; fall back to perpendicular if blocked.
    const preferX = Math.abs(dx) >= Math.abs(dy);
    if (preferX && sx !== 0 && isWalkable(e.x + sx, e.y)) { e.x += sx; return; }
    if (!preferX && sy !== 0 && isWalkable(e.x, e.y + sy)) { e.y += sy; return; }
    // Preferred axis blocked — try the other.
    if (sy !== 0 && isWalkable(e.x, e.y + sy)) { e.y += sy; return; }
    if (sx !== 0 && isWalkable(e.x + sx, e.y)) { e.x += sx; return; }
}

// Enemy kinds — each defines stat overrides + AI behaviour.
// AI behaviour signature: ai(enemy, p, helpers) where helpers = { attack }.
// Default kind is "grunt" (legacy chase-and-melee behaviour). Bosses keep grunt AI.
const ENEMY_KINDS = {
    grunt: {
        id: "grunt",
        name: "Grunt",
        color: "#e74c3c",
        hpMult: 1, atkMult: 1, defMult: 1,
        minFloor: 1, weight: 100,
        ai: function(enemy, p, h) {
            const dist = manhattan(enemy.x, enemy.y, p.x, p.y);
            if (dist <= 1) {
                h.attack(enemy);
                return;
            }
            // Step diagonally toward player, but respect walls — try x first, then y,
            // dropping a step if both are blocked.
            const sx = enemy.x < p.x ? 1 : enemy.x > p.x ? -1 : 0;
            const sy = enemy.y < p.y ? 1 : enemy.y > p.y ? -1 : 0;
            if (sx !== 0 && isWalkable(enemy.x + sx, enemy.y)) enemy.x += sx;
            if (sy !== 0 && isWalkable(enemy.x, enemy.y + sy)) enemy.y += sy;
        }
    },
    charger: {
        // Telegraph one turn, then dash N tiles toward player on the dominant axis.
        // Dash direction is recomputed at dash time (not telegraph time) so walking
        // perpendicular doesn't trivially escape — the warning is "I will attack",
        // not "I will attack along this specific arrow".
        id: "charger",
        name: "Charger",
        color: "#a0522d",
        hpMult: 1.5, atkMult: 1.2, defMult: 0.7,
        minFloor: 5,
        get weight() { return CONFIG.enemyKinds.chargerWeight; },
        ai: function(enemy, p, h) {
            const dist = manhattan(enemy.x, enemy.y, p.x, p.y);
            // Adjacent — melee like a grunt and clear any windup.
            if (dist <= 1) {
                h.attack(enemy);
                enemy.chargeWindup = 0; enemy.chargeDx = 0; enemy.chargeDy = 0;
                return;
            }
            // Charge release: recompute dominant axis NOW and dash up to N tiles.
            if (enemy.chargeWindup > 0) {
                enemy.chargeWindup = 0;
                const adx = p.x - enemy.x, ady = p.y - enemy.y;
                let dx, dy;
                if (Math.abs(adx) >= Math.abs(ady)) { dx = adx > 0 ? 1 : -1; dy = 0; }
                else                                 { dx = 0; dy = ady > 0 ? 1 : -1; }
                enemy.chargeDx = dx; enemy.chargeDy = dy;
                let steps = 0;
                for (let i = 0; i < CONFIG.enemyKinds.chargerDashDist; i++) {
                    const nx = enemy.x + dx, ny = enemy.y + dy;
                    if (!isInBounds(nx, ny)) break;
                    // Player can be in path; that's the attack target. Walls aren't.
                    if (isWall(nx, ny)) break;
                    enemy.x = nx; enemy.y = ny;
                    steps++;
                    if (enemy.x === p.x && enemy.y === p.y) {
                        h.attack(enemy);
                        enemy.x -= dx; enemy.y -= dy; // back off so we're adjacent, not overlapping
                        break;
                    }
                }
                if (steps > 0) addLog("Charger dashes!", "log-damage");
                return;
            }
            // Telegraph (no committed direction — that's resolved at dash time).
            enemy.chargeWindup = 1;
            enemy.chargeDx = 0; enemy.chargeDy = 0;
        }
    },
    ranger: {
        // Keeps distance; fires orthogonal projectile if in line of sight.
        // Anti-grouping — forces movement.
        id: "ranger",
        name: "Ranger",
        color: "#ff9933",
        hpMult: 0.7, atkMult: 0.9, defMult: 0.8,
        minFloor: 8,
        get weight() { return CONFIG.enemyKinds.rangerWeight; },
        ai: function(enemy, p, h) {
            const dx = p.x - enemy.x, dy = p.y - enemy.y;
            const dist = Math.abs(dx) + Math.abs(dy);
            const aligned = (dx === 0 || dy === 0);
            // Fire if orthogonal-aligned, in range, AND no walls blocking the line.
            if (aligned && dist > 0 && dist <= CONFIG.enemyKinds.rangerFireRange
                && hasLineOfSight(enemy.x, enemy.y, p.x, p.y)) {
                enemy.arrowFlash = 2;
                enemy.arrowDx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
                enemy.arrowDy = dy === 0 ? 0 : (dy > 0 ? 1 : -1);
                enemy.arrowDist = dist;
                addLog("Ranger fires an arrow!", "log-damage");
                h.attack(enemy);
                return;
            }
            // Reposition: keep distance 3-5; sidestep to align if already in range.
            if (dist < 3)              stepAlongDominantAxis(enemy, p, -1);
            else if (dist > 5)         stepAlongDominantAxis(enemy, p, +1);
            else {
                // In range but not aligned — sidestep on the *minor* axis to align orthogonally.
                if (Math.abs(dx) < Math.abs(dy)) enemy.x += dx > 0 ? 1 : (dx < 0 ? -1 : 0);
                else                              enemy.y += dy > 0 ? 1 : (dy < 0 ? -1 : 0);
            }
            clampToGrid(enemy);
        }
    },
    healer: {
        // Heals adjacent allies. Stays near other enemies. Priority target.
        id: "healer",
        name: "Healer",
        color: "#27ae60",
        hpMult: 0.6, atkMult: 0.5, defMult: 1.0,
        minFloor: 12,
        get weight() { return CONFIG.enemyKinds.healerWeight; },
        ai: function(enemy, p, h) {
            // Heal nearby enemies (excluding self).
            let healed = 0;
            const healPct = CONFIG.enemyKinds.healerHealPct;
            const healRange = CONFIG.enemyKinds.healerHealRange;
            gameState.enemies.forEach(other => {
                if (other === enemy || other.hp <= 0) return;
                if (manhattan(other.x, other.y, enemy.x, enemy.y) <= healRange && other.hp < other.maxHp) {
                    const heal = Math.max(1, Math.floor(other.maxHp * healPct));
                    other.hp = Math.min(other.maxHp, other.hp + heal);
                    healed++;
                }
            });
            if (healed > 0) {
                enemy.healFlash = 2;
                addLog(`Healer mends ${healed} ally${healed > 1 ? "ies" : ""}!`, "log-loot");
            }
            // Movement: keep distance from player; cluster with allies.
            const distp = manhattan(enemy.x, enemy.y, p.x, p.y);
            if (distp <= 2) {
                stepAlongDominantAxis(enemy, p, -1); // back away
            } else {
                // Find nearest ally and drift toward them.
                let nearest = null, nd = Infinity;
                gameState.enemies.forEach(other => {
                    if (other === enemy || other.hp <= 0) return;
                    const d = manhattan(other.x, other.y, enemy.x, enemy.y);
                    if (d < nd) { nd = d; nearest = other; }
                });
                if (nearest && nd > 2) stepAlongDominantAxis(enemy, nearest, +1);
            }
            clampToGrid(enemy);
        }
    }
};

// Pick a kind id for a non-boss regular enemy, weighted by availability and weight.
function pickEnemyKind(floor) {
    const available = Object.values(ENEMY_KINDS).filter(k => floor >= k.minFloor);
    const totalWeight = available.reduce((s, k) => s + k.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const k of available) {
        roll -= k.weight;
        if (roll <= 0) return k.id;
    }
    return "grunt";
}

// Player classes — each defines starting Affinity boosts and a starter kit item with a baked-in passive.
// Picked at the title screen before the run begins.
const CLASSES = {
    brawler: {
        id: "brawler",
        name: "Brawler",
        color: "#ff6b6b",
        tagline: "Wade in. Hit harder when surrounded.",
        desc: "Direct, aggressive. Damage scales with adjacent enemies. Punishes positioning errors — yours and theirs.",
        startingAffinity: { ATK: 5, DEF: 0, SPD: 0, CRIT: 0, LUCK: 0 },
        starterItem: {
            name: "Cracked Hatchet",
            type: "weapon",
            atk: 6, def: 0,
            passives: [{ name: "Berserker", stat: "berserker", value: 25, desc: "More ATK at low HP + flat % damage per adjacent enemy" }]
        }
    },
    trickster: {
        id: "trickster",
        name: "Trickster",
        color: "#ffd93d",
        tagline: "Keep moving. The dungeon rewards motion.",
        desc: "Hit-and-run. Speed + Luck for drops; Phantom Step damages adjacent enemies after every move.",
        startingAffinity: { ATK: 0, DEF: 0, SPD: 3, CRIT: 5, LUCK: 2 },
        starterItem: {
            name: "Loaded Dice",
            type: "relic",
            atk: 0, def: 0,
            passives: [
                { name: "Lucky", stat: "luck", value: 5, desc: "+5 effective LUCK" },
                { name: "Swift", stat: "speed", value: 5, desc: "+5 effective SPD" },
                { name: "Phantom Step", stat: "phantomStep", value: 15, desc: "After moving, deal 15% ATK to adjacent enemies" }
            ]
        }
    },
    sentinel: {
        id: "sentinel",
        name: "Sentinel",
        color: "#4ecdc4",
        tagline: "Hold the line. Reward patience.",
        desc: "Stationary archetype. Damage and defence grow each turn you don't move. Slow start, devastating endgame.",
        startingAffinity: { ATK: 0, DEF: 5, SPD: 0, CRIT: 0, LUCK: 0 },
        starterItem: {
            name: "Battered Cuirass",
            type: "chest",
            atk: 0, def: 4,
            passives: [
                { name: "Bulwark", stat: "bulwark", value: 1, desc: "Stacking +20% damage and +5% DEF per turn standing still (max 5)" },
                { name: "Fortified", stat: "fortify", value: 10, desc: "+10% DEF" }
            ]
        }
    },
    mage: {
        id: "mage",
        name: "Mage",
        color: "#9966ff",
        tagline: "Spend MP. Kill rooms. Repeat.",
        desc: "AOE-focused. Cheaper specials, MP back on kill — built to fire the R key turn after turn.",
        startingAffinity: { ATK: 3, DEF: 0, SPD: 0, CRIT: 0, LUCK: 2 },
        starterItem: {
            name: "Arcane Tome",
            type: "relic",
            atk: 0, def: 0,
            passives: [
                { name: "Arcane", stat: "arcane", value: 20, desc: "AOE costs 20% less MP" },
                { name: "Siphon", stat: "siphon", value: 8, desc: "Kills restore 8% of max MP (capped)" }
            ]
        }
    }
};

// Player debuffs — permanent per floor threshold, stacking
const PLAYER_DEBUFFS = [
    { floor: 35, name: "Corrosion", desc: "DEF reduced by 15%", stat: "corrosion", color: "#aa8844" },
    { floor: 40, name: "Fatigue", desc: "Potions heal 25% less", stat: "fatigue", color: "#886644" },
    { floor: 45, name: "Entropy", desc: "Passive effect values reduced by 10%", stat: "entropy", color: "#664488" },
    { floor: 50, name: "Cursed Blood", desc: "All healing reduced by 40%", stat: "cursedBlood", color: "#880044" },
    { floor: 55, name: "Withering", desc: "ATK reduced by 10%", stat: "withering", color: "#cc6622" },
    { floor: 60, name: "Void Siphon", desc: "Lose 1 MP per tile moved", stat: "voidSiphon", color: "#440088" },
    { floor: 65, name: "Death's Countdown", desc: "40-turn timer per floor", stat: "deathsCountdown", color: "#ff0000" }
];

// Affinity milestone bonuses — innate bonuses at level 5 and 10
const AFFINITY_MILESTONES = {
    ATK:  { 5: { type: "baseDamage", value: 0.05, desc: "+5% base damage" },
            10: { type: "baseDamage", value: 0.10, desc: "+10% base damage" } },
    DEF:  { 5: { type: "baseDef", value: 0.05, desc: "+5% base DEF" },
            10: { type: "baseDef", value: 0.10, desc: "+10% base DEF" } },
    SPD:  { 5: { type: "moveRange", value: 1, desc: "+1 move range" },
            10: { type: "moveRange", value: 1, desc: "+1 move range" } },
    CRIT: { 5: { type: "critDamage", value: 0.10, desc: "+10% crit damage" },
            10: { type: "critDamage", value: 0.20, desc: "+20% crit damage" } },
    LUCK: { 5: { type: "rarityBonus", value: 0.05, desc: "+5% rarity bonus" },
            10: { type: "rarityBonus", value: 0.10, desc: "+10% rarity bonus" } }
};

// Get total affinity milestone bonus for a given type
function getAffinityBonus(type) {
    let total = 0;
    const aff = gameState.player.affinities;
    for (const [stat, milestones] of Object.entries(AFFINITY_MILESTONES)) {
        for (const [level, bonus] of Object.entries(milestones)) {
            if (aff[stat] >= parseInt(level) && bonus.type === type) {
                total += bonus.value;
            }
        }
    }
    return total;
}

const WEAPONNAMES = ["Sword", "Axe", "Spear", "Dagger", "Mace", "Katana", "Scythe", "Blade", "Staff", "Wand"];
const HELMETNAMES = ["Helm", "Crown", "Hood", "Mask", "Circlet", "Visor"];
const CHESTNAMES = ["Chestplate", "Robe", "Tunic", "Cuirass", "Vest", "Mail"];
const LEGSNAMES = ["Greaves", "Leggings", "Pants", "Tassets", "Trousers"];
const GLOVESNAMES = ["Gauntlets", "Gloves", "Handwraps", "Bracers", "Grips"];

const BOOTSNAMES = [
    "Boots", "Greaves", "Sabatons", "Shoes", "Treads",
    "Thunder Treads",
    "Shadow Treads"
];

const CAPENAMES = [
    "Cape", "Cloak", "Mantle", "Shroud", "Wings",
    "Mantle of Haste",
    "Wind Shroud"
];

const RELICNAMES = [
    "Amulet", "Ring", "Talisman", "Orb", "Charm", "Medallion", "Crystal",
    "Chrono Charm",
    "Lightning Sigil"
];

const PREFIXES = ["Ancient", "Cursed", "Divine", "Infernal", "Glacial", "Thunder", "Shadow", "Radiant", "Mystic", "Eternal"];

// Loot generation
function rollPassiveForItemType(itemType, isLegendaryPlus = false) {
    const speedStats = ["speed", "momentum", "evasion", "adrenaline", "phantomStep", "fleetfootStrikes", "battleTempo", "adrenalineSurge"];
    let pool = [...PASSIVEEFFECTS];

    // Legendary+ items can also roll from the exclusive pool
    if (isLegendaryPlus) {
        pool = pool.concat(LEGENDARY_PASSIVES);
        // Mastery passives — only roll if player meets affinity requirements
        const aff = gameState.player.affinities;
        ALL_MASTERY_PASSIVES.forEach(m => {
            if (m.affinities.every(a => aff[a] >= m.threshold)) {
                pool.push(m);
            }
        });
    }

    // Build weighted pool based on affinities + item type bonuses
    const weighted = [];
    const affinities = gameState.player.affinities;
    pool.forEach(eff => {
        // Base weight = 1
        let weight = 1;

        // Affinity weighting: each affinity point adds +1 weight to matching passives
        if (eff.affinity && affinities[eff.affinity]) {
            weight += affinities[eff.affinity];
        }

        // Boots, Cape, Relic get 3x weight on speed-related passives
        if ((itemType === "boots" || itemType === "cape" || itemType === "relic") && speedStats.includes(eff.stat)) {
            weight *= 3;
        }

        for (let i = 0; i < weight; i++) weighted.push(eff);
    });

    return weighted[Math.floor(Math.random() * weighted.length)];
}

function generateLoot(isBoss = false, dropPotion = false, minRarity = null) {
    // Potion drop (skip if minRarity is set — guaranteed gear drop)
    const potionDropRate = 0.15 + (getPrestigeLevel('scavenger') * 0.05);
    if (!minRarity && dropPotion && Math.random() < potionDropRate && !isBoss) {
        return {
            name: "Health Potion",
            type: "potion",
            healHp: 50,
            healMp: 25
        };
    }

    // Determine rarity
    let rarity = RARITIES.COMMON;
    const roll = Math.random();
    let cumulative = 0;

    const luckPassive = gameState.player.passiveEffects.luck || 0;
    const luckStat = gameState.player.luck || 0;
    const plundererLuck = gameState.player.plundererBonusLuck || 0;
    const totalLuck = luckPassive + luckStat + plundererLuck;
    // Affinity milestone: LUCK — bonus rarity chance
    const luckAffinityBonus = getAffinityBonus("rarityBonus");
    const luckBonus = Math.log(1 + totalLuck / 30) * 0.15 + luckAffinityBonus;
    const bossBonus = isBoss ? 0.15 : 0;

    // Ascended only drops if effective luck >= threshold (80, or 70 with Echo: Ascendant)
    const ascendedThreshold = (prestigeData && prestigeData.echoes.ascendant) ? 70 : 80;
    const effectiveLuck = (gameState.player.luck || 0) + (gameState.player.passiveEffects.luck || 0) + plundererLuck;
    // Roll highest-rarity-first. Ascended is gated by luck threshold.
    const reversed = RARITY_ORDER.slice().reverse();
    const ordered = effectiveLuck >= ascendedThreshold ? reversed : reversed.filter(r => r !== RARITIES.ASCENDED);

    for (let r of ordered) {
        cumulative += r.dropChance * (1 + luckBonus + bossBonus);
        if (roll < cumulative) {
            rarity = r;
            break;
        }
    }

    // Lucky Ascension — chance to bump rarity up one tier (excludes mythic/ascended)
    if (gameState.player.passiveEffects.luckyAscension && rarity !== RARITIES.MYTHIC && rarity !== RARITIES.ASCENDED) {
        if (Math.random() * 100 < gameState.player.passiveEffects.luckyAscension) {
            const next = nextRarity(rarity);
            // Don't promote into Mythic via this effect (Mythic is excluded above-as-guard,
            // but we also need to skip the jump from Legendary→Mythic).
            if (next && next !== RARITIES.MYTHIC && next !== RARITIES.ASCENDED) {
                rarity = next;
                addLog(`Lucky Ascension! Gear upgraded to ${rarity.name}!`, "log-loot");
            }
        }
    }

    // Prestige: Rarity Boost — chance to upgrade Common/Uncommon one tier
    const rarityBoostLevel = getPrestigeLevel('rarityBoost');
    if (rarityBoostLevel > 0 && (rarity === RARITIES.COMMON || rarity === RARITIES.UNCOMMON)) {
        if (Math.random() < rarityBoostLevel * 0.05) {
            // Only boost up to Epic (don't auto-promote to Legendary tier from prestige RNG)
            const next = nextRarity(rarity);
            if (next && next !== RARITIES.LEGENDARY && next !== RARITIES.MYTHIC && next !== RARITIES.ASCENDED) {
                rarity = next;
            }
        }
    }

    // Enforce minimum rarity floor
    if (minRarity && rarity.statMult < minRarity.statMult) {
        rarity = minRarity;
    }

    // Determine type
    const types = ["weapon", "helmet", "chest", "legs", "gloves", "boots", "cape", "relic"];
    const typeRoll = Math.random();
    let itemType;
    if (typeRoll < 0.25) itemType = "weapon";
    else if (typeRoll < 0.35) itemType = "helmet";
    else if (typeRoll < 0.45) itemType = "chest";
    else if (typeRoll < 0.55) itemType = "legs";
    else if (typeRoll < 0.65) itemType = "gloves";
    else if (typeRoll < 0.75) itemType = "boots";
    else if (typeRoll < 0.9) itemType = "cape";
    else itemType = "relic";

    // Base name
    let baseName;
    switch (itemType) {
        case "weapon":
            baseName = WEAPONNAMES[Math.floor(Math.random() * WEAPONNAMES.length)];
            break;
        case "helmet":
            baseName = HELMETNAMES[Math.floor(Math.random() * HELMETNAMES.length)];
            break;
        case "chest":
            baseName = CHESTNAMES[Math.floor(Math.random() * CHESTNAMES.length)];
            break;
        case "legs":
            baseName = LEGSNAMES[Math.floor(Math.random() * LEGSNAMES.length)];
            break;
        case "gloves":
            baseName = GLOVESNAMES[Math.floor(Math.random() * GLOVESNAMES.length)];
            break;
        case "boots":
            baseName = BOOTSNAMES[Math.floor(Math.random() * BOOTSNAMES.length)];
            break;
        case "cape":
            baseName = CAPENAMES[Math.floor(Math.random() * CAPENAMES.length)];
            break;
        case "relic":
            baseName = RELICNAMES[Math.floor(Math.random() * RELICNAMES.length)];
            break;
    }

    const prefix = Math.random() < 0.5 ? PREFIXES[Math.floor(Math.random() * PREFIXES.length)] : null;

    const baseAtk =
        itemType === "weapon"
            ? Math.floor(5 + gameState.floor * 2)
            : itemType === "relic"
            ? Math.floor(3 + gameState.floor)
            : 0;

    const baseDef =
        (itemType !== "weapon" && itemType !== "relic")
            ? Math.floor(1.5 + gameState.floor * 0.5)
            : itemType === "relic"
            ? Math.floor(1 + gameState.floor * 0.4)
            : 0;

    const item = {
        name: prefix ? `${prefix} ${baseName}` : baseName,
        type: itemType,
        rarity: rarity,
        atk: Math.floor(baseAtk * rarity.statMult),
        def: Math.floor(baseDef * rarity.statMult),
        passives: []
    };

    // Passive effects by rarity
    let passiveCount =
        rarity === RARITIES.ASCENDED ? 4 :
        rarity === RARITIES.MYTHIC ? 3 :
        rarity === RARITIES.LEGENDARY ? 2 :
        rarity === RARITIES.EPIC ? 1 :
        rarity === RARITIES.RARE ? 1 : 0;

    // Providence mastery — +1 passive slot on drops
    if (hasMastery("providence") && passiveCount > 0) {
        passiveCount += 1;
    }

    const isLegendaryPlus = (rarity === RARITIES.LEGENDARY || rarity === RARITIES.MYTHIC || rarity === RARITIES.ASCENDED);
    const useMaxValues = (rarity === RARITIES.ASCENDED) || hasMedallion("eightLeafClover");
    for (let i = 0; i < passiveCount; i++) {
        const effect = rollPassiveForItemType(itemType, isLegendaryPlus);
        let value = useMaxValues ? effect.range[1] * 2 : Math.floor(effect.range[0] + Math.random() * (effect.range[1] - effect.range[0]));
        item.passives.push({
            name: effect.name,
            stat: effect.stat,
            value,
            desc: effect.desc
        });
    }

    return item;
}

// Apply passives from equipped items
function applyPassiveEffects() {
    const p = gameState.player;
    p.passiveEffects = {};
    Object.values(p.equipped).forEach(item => {
        if (!item || !item.passives) return;
        item.passives.forEach(passive => {
            if (!p.passiveEffects[passive.stat]) p.passiveEffects[passive.stat] = 0;
            p.passiveEffects[passive.stat] += passive.value;
        });
    });

    // Entropy debuff — reduce all passive effect values by 10% per stack
    const entropyStacks = countDebuff("entropy");
    if (entropyStacks > 0) {
        const entropyMult = Math.pow(0.9, entropyStacks);
        Object.keys(p.passiveEffects).forEach(key => {
            p.passiveEffects[key] = Math.floor(p.passiveEffects[key] * entropyMult);
        });
    }

    // Chemist — cap at 50% max
    if (p.passiveEffects.chemist && p.passiveEffects.chemist > 50) {
        p.passiveEffects.chemist = 50;
    }

    // Speedster — 20% base speed bonus
    if (p.passiveEffects.speedster) {
        const spdBonus = Math.floor((p.spd || 0) * 0.2);
        if (!p.passiveEffects.speed) p.passiveEffects.speed = 0;
        p.passiveEffects.speed += spdBonus;
    }

    // Momentum — also grants bonus speed (scales with momentum value, 1-5 range)
    if (p.passiveEffects.momentum) {
        const spdBonus = Math.max(1, Math.min(5, Math.floor(p.passiveEffects.momentum / 5)));
        if (!p.passiveEffects.speed) p.passiveEffects.speed = 0;
        p.passiveEffects.speed += spdBonus;
    }

    // Rebuild mastery list from equipped gear
    p.masteries = [];
    const aff = p.affinities;
    Object.values(p.equipped).forEach(item => {
        if (!item || !item.passives) return;
        item.passives.forEach(passive => {
            const mastery = ALL_MASTERY_PASSIVES.find(m => m.stat === passive.stat);
            if (mastery) {
                // Only active if player meets affinity thresholds
                const meetsReqs = mastery.affinities.every(a => aff[a] >= mastery.threshold);
                if (meetsReqs && !p.masteries.find(m => m.stat === mastery.stat)) {
                    p.masteries.push(mastery);
                }
            }
        });
    });

    // Warlord — ATK/DEF gain +15% of avg of others, +1 SPD per 50 (ATK+DEF)
    if (hasMastery("warlord")) {
        let totalAtk = p.atk;
        let totalDef = p.def;
        Object.values(p.equipped).forEach(item => {
            if (item) { totalAtk += item.atk || 0; totalDef += item.def || 0; }
        });
        const totalSpd = p.spd + (p.passiveEffects.speed || 0);
        p.passiveEffects.warlordAtkBonus = Math.floor((totalDef + totalSpd) / 2 * 0.15);
        p.passiveEffects.warlordDefBonus = Math.floor((totalAtk + totalSpd) / 2 * 0.15);
        p.passiveEffects.warlordSpdBonus = Math.floor((totalAtk + totalDef) / 50);
        if (!p.passiveEffects.speed) p.passiveEffects.speed = 0;
        p.passiveEffects.speed += p.passiveEffects.warlordSpdBonus;
    }

    updateBuffsPanel();
}

// Check and update dual passives based on current affinities
// Shows a selection screen when new dual passives are qualified
function checkDualPassives() {
    const p = gameState.player;
    const aff = p.affinities;
    const maxSlots = 2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0);

    // Find all dual passives the player qualifies for
    const qualified = DUAL_PASSIVES.filter(dp => {
        return aff[dp.affinities[0]] >= dp.threshold && aff[dp.affinities[1]] >= dp.threshold;
    });

    // Find newly qualified ones not already equipped
    const newlyQualified = qualified.filter(dp => !p.dualPassives.find(d => d.stat === dp.stat));

    if (newlyQualified.length > 0) {
        showDualPassiveSelection(newlyQualified, qualified);
    }

    updateBuffsPanel();
}

// Show the dual passive selection screen
function showDualPassiveSelection(newlyQualified, allQualified) {
    const overlay = document.getElementById('dual-passive-overlay');
    const optionsDiv = document.getElementById('dual-passive-options');
    const subtitle = document.getElementById('dual-passive-subtitle');
    const p = gameState.player;
    const maxSlots = 2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0);
    const hasOpenSlot = p.dualPassives.length < maxSlots;
    const affColors = { ATK: "#ff6b6b", DEF: "#4ecdc4", SPD: "#ffd93d", CRIT: "#ff8800", LUCK: "#2ecc71" };

    optionsDiv.innerHTML = "";

    if (hasOpenSlot) {
        subtitle.textContent = `You have ${maxSlots - p.dualPassives.length} open slot${maxSlots - p.dualPassives.length > 1 ? 's' : ''}. Choose a dual passive to equip:`;
    } else {
        subtitle.textContent = `All ${maxSlots} slots are full. Equip a new passive by swapping one out, or skip:`;
    }

    // Show currently equipped passives
    if (p.dualPassives.length > 0) {
        const equippedHeader = document.createElement('div');
        equippedHeader.style.cssText = "font-size: 0.55em; color: #888; margin-bottom: 8px; text-align: left; font-family: 'Press Start 2P', cursive;";
        equippedHeader.textContent = "EQUIPPED:";
        optionsDiv.appendChild(equippedHeader);

        p.dualPassives.forEach(dp => {
            const div = document.createElement('div');
            const c1 = affColors[dp.affinities[0]] || "#fff";
            const c2 = affColors[dp.affinities[1]] || "#fff";
            div.style.cssText = "font-size: 0.5em; padding: 8px 10px; margin: 4px 0; background: rgba(255,0,255,0.15); border: 2px solid rgba(255,0,255,0.4); font-family: 'VT323', monospace; text-align: left;";
            div.innerHTML = `<span style="color: #ff00ff; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${dp.name}</span> ` +
                `<span style="color:${c1}">${dp.affinities[0]}</span>+<span style="color:${c2}">${dp.affinities[1]}</span><br>` +
                `<span style="color: #ccc; font-size: 0.9em;">${dp.desc}</span>`;
            optionsDiv.appendChild(div);
        });

        const spacer = document.createElement('div');
        spacer.style.cssText = "height: 12px; border-bottom: 1px solid #333; margin-bottom: 12px;";
        optionsDiv.appendChild(spacer);
    }

    // Show newly qualified passives with equip/swap buttons
    const newHeader = document.createElement('div');
    newHeader.style.cssText = "font-size: 0.55em; color: #ff00ff; margin-bottom: 8px; text-align: left; font-family: 'Press Start 2P', cursive; text-shadow: 0 0 8px rgba(255,0,255,0.3);";
    newHeader.textContent = "NEW:";
    optionsDiv.appendChild(newHeader);

    newlyQualified.forEach(dp => {
        const div = document.createElement('div');
        const c1 = affColors[dp.affinities[0]] || "#fff";
        const c2 = affColors[dp.affinities[1]] || "#fff";
        div.style.cssText = "font-size: 0.5em; padding: 10px; margin: 6px 0; background: rgba(255,0,255,0.1); border: 2px solid #ff00ff; font-family: 'VT323', monospace; text-align: left;";

        let buttonsHtml = '';
        if (hasOpenSlot) {
            buttonsHtml = `<button onclick="equipDualPassive('${dp.stat}')" style="font-size: 0.7em; padding: 6px 14px; margin-top: 6px; background: linear-gradient(135deg, #ff00ff, #aa00aa); border: 2px solid #ff66ff; box-shadow: 0 3px 0 #660066;">EQUIP</button>`;
        } else {
            buttonsHtml = `<div style="margin-top: 6px; font-size: 0.8em; color: #aaa;">Swap with:</div>`;
            p.dualPassives.forEach(equipped => {
                buttonsHtml += `<button onclick="swapDualPassive('${dp.stat}', '${equipped.stat}')" style="font-size: 0.6em; padding: 5px 10px; margin: 3px 3px 0 0; background: linear-gradient(135deg, #880088, #550055); border: 2px solid #aa44aa; box-shadow: 0 3px 0 #440044;">${equipped.name}</button>`;
            });
        }

        div.innerHTML = `<span style="color: #ff00ff; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${dp.name}</span> ` +
            `<span style="color:${c1}">${dp.affinities[0]}</span>+<span style="color:${c2}">${dp.affinities[1]}</span><br>` +
            `<span style="color: #ccc; font-size: 0.9em;">${dp.desc}</span><br>` +
            buttonsHtml;
        optionsDiv.appendChild(div);
    });

    // Skip button
    const skipBtn = document.createElement('button');
    skipBtn.className = 'levelup-confirm';
    skipBtn.style.cssText = "background: linear-gradient(135deg, #444, #333); margin-top: 15px; font-size: 0.7em; padding: 10px 20px;";
    skipBtn.textContent = hasOpenSlot ? "SKIP" : "KEEP CURRENT";
    skipBtn.onclick = closeDualPassiveSelection;
    optionsDiv.appendChild(skipBtn);

    overlay.style.display = "flex";
    gameState.overlayOpen = true;
}

// Equip a dual passive into an open slot
function equipDualPassive(stat) {
    const p = gameState.player;
    const dp = DUAL_PASSIVES.find(d => d.stat === stat);
    if (!dp) return;

    p.dualPassives.push(dp);
    addLog(`DUAL PASSIVE EQUIPPED: ${dp.name}! (${dp.affinities[0]}+${dp.affinities[1]})`, "log-boss");

    // Check if more newly qualified passives still need choosing
    const maxSlots = 2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0);
    const aff = p.affinities;
    const qualified = DUAL_PASSIVES.filter(d => aff[d.affinities[0]] >= d.threshold && aff[d.affinities[1]] >= d.threshold);
    const remaining = qualified.filter(d => !p.dualPassives.find(eq => eq.stat === d.stat));

    if (remaining.length > 0 && p.dualPassives.length < maxSlots) {
        showDualPassiveSelection(remaining, qualified);
    } else {
        closeDualPassiveSelection();
    }
}

// Swap an equipped dual passive with a new one
function swapDualPassive(newStat, oldStat) {
    const p = gameState.player;
    const newDp = DUAL_PASSIVES.find(d => d.stat === newStat);
    if (!newDp) return;

    const idx = p.dualPassives.findIndex(d => d.stat === oldStat);
    if (idx === -1) return;

    const oldDp = p.dualPassives[idx];
    p.dualPassives[idx] = newDp;
    addLog(`DUAL PASSIVE SWAPPED: ${oldDp.name} → ${newDp.name}!`, "log-boss");

    // Check remaining
    const aff = p.affinities;
    const qualified = DUAL_PASSIVES.filter(d => aff[d.affinities[0]] >= d.threshold && aff[d.affinities[1]] >= d.threshold);
    const remaining = qualified.filter(d => !p.dualPassives.find(eq => eq.stat === d.stat));
    const maxSlots = 2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0);

    if (remaining.length > 0 && p.dualPassives.length < maxSlots) {
        showDualPassiveSelection(remaining, qualified);
    } else {
        closeDualPassiveSelection();
    }
}

// Close the dual passive selection screen
function closeDualPassiveSelection() {
    document.getElementById('dual-passive-overlay').style.display = "none";
    gameState.overlayOpen = false;
    updateBuffsPanel();
}

// Helper: check if a dual passive is active
function hasDualPassive(stat) {
    return gameState.player.dualPassives.some(dp => dp.stat === stat);
}

// Helper: check if a mastery is active (equipped on gear)
function hasMastery(stat) {
    return gameState.player.masteries.some(m => m.stat === stat);
}

// Buff display panel — shows all active passive effects and medallions
function updateBuffsPanel() {
    const panel = document.getElementById('buffs-list');
    if (!panel) return;
    panel.innerHTML = "";

    const p = gameState.player;

    // Build lookup from stat key → name, desc, color
    const allPassives = [...PASSIVEEFFECTS, ...LEGENDARY_PASSIVES];
    const lookup = {};
    allPassives.forEach(eff => {
        lookup[eff.stat] = { name: eff.name, desc: eff.desc, legendary: LEGENDARY_PASSIVES.includes(eff) };
    });

    // Display passive effects from equipment
    const effects = p.passiveEffects;
    const statKeys = Object.keys(effects);

    if (statKeys.length === 0 && p.medallions.length === 0) {
        panel.innerHTML = '<div style="font-size: 0.5em; color: #666; text-align: center; padding: 10px;">No buffs active.<br>Equip gear with passives!</div>';
        return;
    }

    // Passive effects from gear
    if (statKeys.length > 0) {
        statKeys.forEach(stat => {
            const val = effects[stat];
            if (val === 0) return;
            const info = lookup[stat];
            if (!info) return; // skip derived stats like momentumSpd

            const isLeg = info.legendary;
            const color = isLeg ? "#ff8000" : "var(--accent-secondary)";
            const nameColor = isLeg ? "#ff8000" : "var(--accent-gold)";

            // Determine display format
            let displayVal = "";
            const activeStats = ["undying", "kineticReserve", "psychicFlare", "speedster", "bulwark", "ironRoots", "scrapper", "lethalFocus"];
            const percentStats = ["lifesteal", "berserker", "arcane", "soulrend", "goldblood", "siphon",
                "chemist", "evasion", "momentum", "fortify", "executioner", "overwhelm", "redundantForce",
                "lastStand", "guardianShell", "ironWill", "adrenaline", "phantomStep", "fleetfootStrikes",
                "deadeye", "precision", "weakpointSpecialist", "shatterpoint", "assassin", "fortunateStrikes",
                "luckyAscension", "overcharge", "ironheart", "tenacity", "battleTempo", "adrenalineSurge"];
            if (activeStats.includes(stat)) {
                displayVal = "Active";
            } else if (stat === "regen") {
                displayVal = `${val}% HP/turn`;
            } else if (percentStats.includes(stat)) {
                displayVal = `${val}%`;
            } else {
                displayVal = `+${val}`;
            }

            const div = document.createElement('div');
            div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(0,0,0,0.3); border-left: 3px solid ${color}; font-family: 'VT323', monospace;`;
            div.innerHTML = `<span style="color:${nameColor}; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${info.name}</span><br>` +
                `<span style="color: #ccc;">${displayVal}</span> <span style="color: #888; font-size: 0.9em;">— ${info.desc}</span>`;
            panel.appendChild(div);
        });
    }

    // Kinetic Reserve stacks indicator (additive multiplier — see attack())
    if (effects.kineticReserve && p.kineticStacks > 0) {
        const stackDiv = document.createElement('div');
        const mult = 1 + CONFIG.combat.kineticPerStack * p.kineticStacks;
        stackDiv.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,128,0,0.15); border-left: 3px solid #ff8000; font-family: 'VT323', monospace; color: #ff8000;";
        stackDiv.innerHTML = `⚡ Kinetic Reserve: ${p.kineticStacks}/${CONFIG.combat.kineticStackMax} stacks (x${mult.toFixed(1)} next hit)`;
        panel.appendChild(stackDiv);
    }

    // Bulwark stacks
    if (effects.bulwark && p.bulwarkStacks > 0) {
        const div = document.createElement('div');
        div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(78,205,196,0.1); border-left: 3px solid var(--accent-secondary); font-family: 'VT323', monospace; color: var(--accent-secondary);";
        div.innerHTML = `🛡 Bulwark: ${p.bulwarkStacks}/${CONFIG.combat.bulwarkStackMax} stacks (+${(p.bulwarkStacks * CONFIG.combat.bulwarkDmgPerStack * 100).toFixed(0)}% damage, +${(p.bulwarkStacks * CONFIG.combat.bulwarkDefPerStack * 100).toFixed(0)}% DEF)`;
        panel.appendChild(div);
    }
    // Iron Roots stacks
    if (effects.ironRoots && p.ironRootsStacks > 0) {
        const div = document.createElement('div');
        div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(120,200,120,0.15); border-left: 3px solid #7fffaa; font-family: 'VT323', monospace; color: #7fffaa;";
        div.innerHTML = `🌿 Iron Roots: ${p.ironRootsStacks}/${CONFIG.combat.ironRootsStackMax} stacks (+${(p.ironRootsStacks * CONFIG.combat.ironRootsDmgPerStack * 100).toFixed(0)}% damage, +${(p.ironRootsStacks * CONFIG.combat.ironRootsDefPerStack * 100).toFixed(0)}% DEF)`;
        panel.appendChild(div);
    }

    // Guardian Shell stacks
    if (effects.guardianShell && p.guardianShellStacks > 0) {
        const div = document.createElement('div');
        const reduction = p.guardianShellStacks * effects.guardianShell;
        div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(78,205,196,0.1); border-left: 3px solid var(--accent-secondary); font-family: 'VT323', monospace; color: var(--accent-secondary);";
        div.innerHTML = `🛡 Guardian Shell: ${p.guardianShellStacks}/5 stacks (-${reduction}% damage taken)`;
        panel.appendChild(div);
    }

    // Tenacity shield
    if (effects.tenacity && p.tenacityShield > 0) {
        const div = document.createElement('div');
        div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(78,205,196,0.1); border-left: 3px solid #44ccaa; font-family: 'VT323', monospace; color: #44ccaa;";
        div.innerHTML = `🛡 Tenacity Shield: ${p.tenacityShield} HP remaining`;
        panel.appendChild(div);
    }

    // Battle Tempo status
    if (effects.battleTempo) {
        const div = document.createElement('div');
        const threshold = Math.max(3, 5 - Math.floor(p.spd / 5));
        const moves = p.battleTempoMoves || 0;
        const charged = p.battleTempoCharged;
        const color = charged ? "#ffd93d" : "var(--accent-secondary)";
        div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,217,61,0.1); border-left: 3px solid ${color}; font-family: 'VT323', monospace; color: ${color};`;
        div.innerHTML = charged ? `⚡ Battle Tempo: CHARGED! +${effects.battleTempo}% next attack` : `⚡ Battle Tempo: ${moves}/${threshold} safe moves`;
        panel.appendChild(div);
    }

    // Lethal Focus stacks
    if (effects.lethalFocus) {
        const stacks = p.lethalFocusStacks || 0;
        const charged = p.lethalFocusCharged;
        const div = document.createElement('div');
        const color = charged ? "#ff8000" : "#ff8800";
        div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,128,0,0.1); border-left: 3px solid ${color}; font-family: 'VT323', monospace; color: ${color};`;
        div.innerHTML = charged ? `🎯 Lethal Focus: CHARGED! Next kill = Legendary+ drop` : `🎯 Lethal Focus: ${stacks}/3 consecutive crits`;
        panel.appendChild(div);
    }

    // Adrenaline active
    if (effects.adrenaline && p.adrenalineTurns > 0) {
        const div = document.createElement('div');
        div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,217,61,0.1); border-left: 3px solid #ffd93d; font-family: 'VT323', monospace; color: #ffd93d;";
        div.innerHTML = `⚡ Adrenaline: +${effects.adrenaline}% SPD (${p.adrenalineTurns} turns)`;
        panel.appendChild(div);
    }

    // Precision stacks
    if (effects.precision && p.precisionStacks > 0) {
        const div = document.createElement('div');
        div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,136,0,0.1); border-left: 3px solid #ff8800; font-family: 'VT323', monospace; color: #ff8800;";
        div.innerHTML = `🎯 Precision: +${p.precisionStacks}% bonus crit chance`;
        panel.appendChild(div);
    }

    // Affinities section
    const hasAffinities = Object.values(p.affinities).some(v => v > 0);
    if (hasAffinities) {
        const header = document.createElement('div');
        header.style.cssText = "font-size: 0.55em; color: var(--accent-gold); margin-top: 10px; padding-top: 8px; border-top: 2px solid var(--accent-gold); margin-bottom: 5px; font-family: 'Press Start 2P', cursive;";
        header.textContent = "AFFINITIES";
        panel.appendChild(header);

        const affColors = { ATK: "#ff6b6b", DEF: "#4ecdc4", SPD: "#ffd93d", CRIT: "#ff8800", LUCK: "#2ecc71" };
        Object.keys(p.affinities).forEach(key => {
            if (p.affinities[key] > 0) {
                const div = document.createElement('div');
                div.style.cssText = `font-size: 0.5em; padding: 3px 6px; margin: 2px 0; font-family: 'VT323', monospace;`;
                div.innerHTML = `<span style="color:${affColors[key]}">${key}</span>: Lv ${p.affinities[key]}`;
                panel.appendChild(div);
            }
        });
    }

    // Dual Passives section
    if (p.dualPassives && p.dualPassives.length > 0) {
        const header = document.createElement('div');
        header.style.cssText = "font-size: 0.55em; color: #ff00ff; margin-top: 10px; padding-top: 8px; border-top: 2px solid #ff00ff; margin-bottom: 5px; font-family: 'Press Start 2P', cursive; text-shadow: 0 0 8px rgba(255,0,255,0.3);";
        header.textContent = "DUAL PASSIVES";
        panel.appendChild(header);

        const affColors = { ATK: "#ff6b6b", DEF: "#4ecdc4", SPD: "#ffd93d", CRIT: "#ff8800", LUCK: "#2ecc71" };
        p.dualPassives.forEach(dp => {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,255,0.08); border-left: 3px solid #ff00ff; font-family: 'VT323', monospace;";
            const c1 = affColors[dp.affinities[0]] || "#fff";
            const c2 = affColors[dp.affinities[1]] || "#fff";
            div.innerHTML = `<span style="color: #ff00ff; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${dp.name}</span><br>` +
                `<span style="color:${c1}">${dp.affinities[0]}</span>+<span style="color:${c2}">${dp.affinities[1]}</span> — <span style="color: #ccc; font-size: 0.9em;">${dp.desc}</span>`;
            panel.appendChild(div);
        });

        // Unyielding Force stacks indicator
        if (hasDualPassive("unyieldingForce") && p.unyieldingForceStacks > 0) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,255,0.15); border-left: 3px solid #ff00ff; font-family: 'VT323', monospace; color: #ff6bff;";
            div.innerHTML = `⚔ Unyielding Force: ${p.unyieldingForceStacks}/3 stacks (+${30 * p.unyieldingForceStacks}% next attack)`;
            panel.appendChild(div);
        }

        // Blitz Strike charge indicator
        if (hasDualPassive("blitzStrike")) {
            const div = document.createElement('div');
            const charged = p.blitzStrikeCharged;
            const color = charged ? "#ffd93d" : "#ff6bff";
            div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,255,0.15); border-left: 3px solid ${color}; font-family: 'VT323', monospace; color: ${color};`;
            div.innerHTML = charged ? `⚡ Blitz Strike: CHARGED! +100% damage + free move` : `⚡ Blitz Strike: ${p.blitzStrikeMoves || 0}/4 moves`;
            panel.appendChild(div);
        }

        // Evasive Bulwark shield indicator
        if (hasDualPassive("evasiveBulwark") && p.evasiveBulwarkShield > 0) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,255,0.15); border-left: 3px solid #4ecdc4; font-family: 'VT323', monospace; color: #4ecdc4;";
            div.innerHTML = `🛡 Evasive Bulwark: ${p.evasiveBulwarkShield} HP shield (${p.evasiveBulwarkTurns} turns)`;
            panel.appendChild(div);
        }

        // Phantom Assault charge indicator
        if (hasDualPassive("phantomAssault")) {
            const div = document.createElement('div');
            const charged = p.phantomAssaultCharged;
            const color = charged ? "#ff8800" : "#ff6bff";
            div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,255,0.15); border-left: 3px solid ${color}; font-family: 'VT323', monospace; color: ${color};`;
            div.innerHTML = charged ? `🎯 Phantom Assault: CHARGED! +30% crit chance` : `🎯 Phantom Assault: ${p.phantomAssaultMoves || 0}/2 moves`;
            panel.appendChild(div);
        }

        // Plunderer bonus LUCK indicator
        if (hasDualPassive("plunderer") && p.plundererBonusLuck > 0) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,255,0.15); border-left: 3px solid #2ecc71; font-family: 'VT323', monospace; color: #2ecc71;";
            div.innerHTML = `💰 Plunderer: +${p.plundererBonusLuck} temp LUCK this floor`;
            panel.appendChild(div);
        }

        // Slots remaining indicator
        if (p.dualPassives.length < (2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0))) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.45em; padding: 3px 6px; margin: 3px 0; font-family: 'VT323', monospace; color: #888;";
            const maxDualSlots = 2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0);
            const slotsLeft = maxDualSlots - p.dualPassives.length;
            div.innerHTML = `(${slotsLeft} dual passive slot${slotsLeft === 1 ? '' : 's'} remaining)`;
            panel.appendChild(div);
        }
    }

    // Masteries section
    if (p.masteries && p.masteries.length > 0) {
        const header = document.createElement('div');
        header.style.cssText = "font-size: 0.55em; color: #ffaa00; margin-top: 10px; padding-top: 8px; border-top: 2px solid #ffaa00; margin-bottom: 5px; font-family: 'Press Start 2P', cursive; text-shadow: 0 0 8px rgba(255,170,0,0.3);";
        header.textContent = "MASTERIES";
        panel.appendChild(header);

        const affColors = { ATK: "#ff6b6b", DEF: "#4ecdc4", SPD: "#ffd93d", CRIT: "#ff8800", LUCK: "#2ecc71" };
        p.masteries.forEach(m => {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,170,0,0.08); border-left: 3px solid #ffaa00; font-family: 'VT323', monospace;";
            const affTags = m.affinities.map(a => `<span style="color:${affColors[a] || '#fff'}">${a}</span>`).join('+');
            div.innerHTML = `<span style="color: #ffaa00; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${m.name}</span> ${affTags}<br>` +
                `<span style="color: #ccc; font-size: 0.9em;">${m.desc}</span>`;
            panel.appendChild(div);
        });

        // Berserker's Fury stacks indicator
        if (hasMastery("berserkersFury") && p.berserkersFuryStacks > 0) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,170,0,0.15); border-left: 3px solid #ffaa00; font-family: 'VT323', monospace; color: #ff6b6b;";
            div.innerHTML = `⚔ Berserker's Fury: +${p.berserkersFuryStacks * 3}% ATK (${p.berserkersFuryStacks}/10 stacks)`;
            panel.appendChild(div);
        }

        // Storm Dancer cooldown
        if (hasMastery("stormDancer") && p.stormDancerCooldown > 0) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,170,0,0.15); border-left: 3px solid #ffaa00; font-family: 'VT323', monospace; color: #ffd93d;";
            div.innerHTML = `⚡ Storm Dancer: ${p.stormDancerCooldown} turn cooldown`;
            panel.appendChild(div);
        } else if (hasMastery("stormDancer") && p.stormDancerMoves >= 3) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,170,0,0.15); border-left: 3px solid #ffd93d; font-family: 'VT323', monospace; color: #ffd93d;";
            div.innerHTML = `⚡ Storm Dancer: CHARGED! Next attack will AOE!`;
            panel.appendChild(div);
        }

        // Mirage charge indicator
        if (hasMastery("mirage") && p.mirageCharged) {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,170,0,0.15); border-left: 3px solid #ffaa00; font-family: 'VT323', monospace; color: #44aaff;";
            div.innerHTML = `🌀 Mirage: Next crit deals +50% damage!`;
            panel.appendChild(div);
        }
    }

    // Medallions section
    if (p.medallions.length > 0) {
        const header = document.createElement('div');
        header.style.cssText = "font-size: 0.55em; color: #00ffcc; margin-top: 10px; padding-top: 8px; border-top: 2px solid #00ffcc; margin-bottom: 5px; font-family: 'Press Start 2P', cursive; text-shadow: 0 0 8px rgba(0,255,204,0.5);";
        header.textContent = "MEDALLIONS";
        panel.appendChild(header);

        p.medallions.forEach(m => {
            const div = document.createElement('div');
            div.style.cssText = "font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(0,255,204,0.08); border-left: 3px solid #00ffcc; font-family: 'VT323', monospace;";
            div.innerHTML = `<span style="color: #00ffcc; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${m.name}</span><br>` +
                `<span style="color: #aaffee; font-size: 0.9em;">${m.desc}</span>`;
            panel.appendChild(div);
        });
    }

    // Active debuffs section
    if (gameState.playerDebuffs && gameState.playerDebuffs.length > 0) {
        const header = document.createElement('div');
        header.style.cssText = "font-size: 0.55em; color: #ff4444; margin-top: 10px; padding-top: 8px; border-top: 2px solid #ff4444; margin-bottom: 5px; font-family: 'Press Start 2P', cursive;";
        header.textContent = "DEBUFFS";
        panel.appendChild(header);

        gameState.playerDebuffs.forEach(d => {
            const div = document.createElement('div');
            div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,0,0,0.06); border-left: 3px solid ${d.color}; font-family: 'VT323', monospace;`;
            let extra = "";
            if (d.stat === "deathsCountdown" && gameState.deathsCountdownTurns > 0) {
                extra = ` (${gameState.deathsCountdownTurns} turns left)`;
            }
            div.innerHTML = `<span style="color:${d.color}; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">☠ ${d.name}</span><br>` +
                `<span style="color: #cc8888; font-size: 0.9em;">${d.desc}${extra}</span>`;
            panel.appendChild(div);
        });
    }

    // Active floor modifiers section
    if (gameState.floorModifiers && gameState.floorModifiers.length > 0) {
        const header = document.createElement('div');
        header.style.cssText = "font-size: 0.55em; color: #ff8844; margin-top: 10px; padding-top: 8px; border-top: 2px solid #ff8844; margin-bottom: 5px; font-family: 'Press Start 2P', cursive;";
        header.textContent = "FLOOR MODS";
        panel.appendChild(header);

        gameState.floorModifiers.forEach(m => {
            const div = document.createElement('div');
            div.style.cssText = `font-size: 0.5em; padding: 5px 6px; margin: 3px 0; background: rgba(255,100,0,0.06); border-left: 3px solid ${m.color}; font-family: 'VT323', monospace;`;
            div.innerHTML = `<span style="color:${m.color}; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">⚠ ${m.name}</span><br>` +
                `<span style="color: #ccaa88; font-size: 0.9em;">${m.desc}</span>`;
            panel.appendChild(div);
        });
    }
}

// Inventory UI (unchanged except for new passives auto-showing)
function updateInventoryDisplay() {
    const inv = document.getElementById('inventory');
    inv.innerHTML = "";

    // Medallions section
    if (gameState.player.medallions.length > 0) {
        const medalDiv = document.createElement('div');
        medalDiv.style.marginBottom = "15px";
        medalDiv.style.fontSize = "0.45em";
        medalDiv.innerHTML = `<div style="color: #00ffcc; margin-bottom: 8px; font-size: 1.2em; text-shadow: 0 0 10px #00ffcc;">MEDALLIONS</div>`;
        gameState.player.medallions.forEach(m => {
            const mDiv = document.createElement('div');
            mDiv.style.padding = "5px";
            mDiv.style.margin = "3px 0";
            mDiv.style.background = "rgba(0, 255, 204, 0.1)";
            mDiv.style.border = "1px solid #00ffcc";
            mDiv.style.color = "#00ffcc";
            mDiv.innerHTML = `<strong>${m.name}</strong><br><span style="font-size: 0.85em; color: #aaffee;">${m.desc}</span>`;
            medalDiv.appendChild(mDiv);
        });
        inv.appendChild(medalDiv);
    }

    // Equipped section
    const slotsDiv = document.createElement('div');
    slotsDiv.style.marginBottom = "15px";
    slotsDiv.style.fontSize = "0.45em";
    slotsDiv.innerHTML = `<div style="color: var(--accent-gold); margin-bottom: 8px; font-size: 1.2em;">EQUIPPED</div>`;

    let slotOrder = ["weapon", "helmet", "chest", "legs", "gloves", "boots", "cape", "relic"];
    if (hasMedallion("doubleUp")) {
        slotOrder = ["weapon", "weapon2", "helmet", "chest", "legs", "gloves", "boots", "cape", "cape2", "relic", "relic2"];
    }
    slotOrder.forEach(slot => {
        const item = gameState.player.equipped[slot];
        const slotDiv = document.createElement('div');
        slotDiv.style.padding = "5px";
        slotDiv.style.margin = "3px 0";
        slotDiv.style.background = "rgba(0,0,0,0.3)";
        slotDiv.style.border = "1px solid #333";
        const displayName = slot.replace("2", " 2").toUpperCase();
        if (item) {
            slotDiv.style.borderColor = item.rarity.color;
            slotDiv.style.color = item.rarity.color;
            slotDiv.innerHTML = `${displayName}: ${item.name}`;
        } else {
            slotDiv.style.color = "#555";
            slotDiv.innerHTML = `${displayName}: Empty`;
        }
        slotsDiv.appendChild(slotDiv);
    });
    inv.appendChild(slotsDiv);

    // Separator
    const separator = document.createElement('div');
    separator.style.borderTop = "2px solid var(--accent-secondary)";
    separator.style.margin = "15px 0";
    inv.appendChild(separator);

    // Discard counter
    const discardDiv = document.createElement('div');
    discardDiv.className = "discard-counter";
    let discardHTML = "<strong>DISCARD PROGRESS</strong><br>";
    Object.entries(gameState.discardCounts).forEach(([rarity, count]) => {
        const rarityObj = RARITIES[rarity];
        const needed = rarity === "MYTHIC" ? 20 : 10;
        const label = rarity === "ASCENDED" ? `${rarity}: ${count}/${needed} (→ Medallion)` : `${rarity}: ${count}/${needed}`;
        discardHTML += `<span style="color:${rarityObj.color}">${label}</span><br>`;
    });
    discardDiv.innerHTML = discardHTML;
    inv.appendChild(discardDiv);

    // Potions
    const potionDiv = document.createElement('div');
    potionDiv.style.fontSize = "0.5em";
    potionDiv.style.padding = "8px";
    potionDiv.style.background = "rgba(46, 204, 113, 0.2)";
    potionDiv.style.border = "2px solid #2ecc71";
    potionDiv.style.marginBottom = "10px";
    potionDiv.innerHTML = `<strong>POTIONS: ${gameState.player.potions}</strong><br><span style="font-size: 0.9em; font-family: VT323, monospace;">Restores 50 HP & 25 MP</span>`;
    inv.appendChild(potionDiv);

    // Equip Best button
    const equipBestBtn = document.createElement('button');
    equipBestBtn.className = "inv-action-btn";
    equipBestBtn.style.width = "100%";
    equipBestBtn.style.padding = "6px";
    equipBestBtn.style.marginBottom = "10px";
    equipBestBtn.style.background = "var(--accent-gold)";
    equipBestBtn.style.borderColor = "#b8860b";
    equipBestBtn.style.color = "#000";
    equipBestBtn.style.fontWeight = "bold";
    equipBestBtn.style.fontSize = "0.55em";
    equipBestBtn.textContent = "⚔ EQUIP BEST";
    equipBestBtn.title = "Auto-equip items with highest ATK + DEF per slot";
    equipBestBtn.onclick = (e) => { e.stopPropagation(); equipBestItems(); };
    inv.appendChild(equipBestBtn);

    // Inventory items
    const invTitle = document.createElement('div');
    invTitle.style.color = "var(--accent-gold)";
    invTitle.style.fontSize = "0.5em";
    invTitle.style.marginBottom = "8px";
    invTitle.innerHTML = "INVENTORY (Hover to compare)";
    inv.appendChild(invTitle);

    // Sort button
    const actionsDiv = document.createElement('div');
    actionsDiv.className = "inv-actions";

    const sortBtn = document.createElement('button');
    sortBtn.className = "inv-action-btn";
    sortBtn.style.background = "var(--accent-secondary)";
    sortBtn.style.borderColor = "#2a8a83";
    sortBtn.style.color = "#000";
    sortBtn.textContent = "SORT";
    sortBtn.onclick = (e) => { e.stopPropagation(); sortInventory(); };
    actionsDiv.appendChild(sortBtn);

    // Discard-all buttons per rarity (skip Ascended — can't discard)
    const discardableRarities = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY", "MYTHIC", "ASCENDED"];
    discardableRarities.forEach(rKey => {
        const r = RARITIES[rKey];
        const btn = document.createElement('button');
        btn.className = "inv-action-btn";
        btn.style.background = r.color;
        btn.style.borderColor = r.color;
        // Dark text for light bg colors
        if (rKey === "COMMON" || rKey === "UNCOMMON" || rKey === "LEGENDARY") {
            btn.style.color = "#000";
        }
        btn.textContent = "🗑 " + rKey.slice(0, 3);
        btn.title = `Discard all unequipped ${r.name} items`;
        btn.onclick = (e) => { e.stopPropagation(); discardAllOfRarity(rKey); };
        actionsDiv.appendChild(btn);
    });

    inv.appendChild(actionsDiv);

    gameState.player.inventory.forEach((item, index) => {
        if (item.type === "potion") return;
        const div = document.createElement('div');
        div.className = "item";
        div.style.position = "relative";
        const isEquipped = gameState.player.equipped[item.type] === item || gameState.player.equipped[item.type + "2"] === item;
        if (isEquipped) div.classList.add("equipped");

        let html = `<div class="item-name" style="color:${item.rarity.color}">${item.name}</div>`;
        html += `<div class="item-stats">[${item.type.toUpperCase()}]`;
        if (item.atk > 0) html += ` ATK ${item.atk}`;
        if (item.def > 0) html += ` DEF ${item.def}`;
        html += `</div>`;

        if (item.passives && item.passives.length > 0) {
            item.passives.forEach(p => {
                html += `<div class="passive-effect">${p.name} +${p.value}</div>`;
            });
        }

        if (isEquipped) {
            html += `<div style="margin-top: 5px; color:${item.rarity.color}">EQUIPPED</div>`;
        } else {
            html += `<button class="discard-btn" onclick="event.stopPropagation(); discardItem(${index})">DISCARD</button>`;
        }

        div.innerHTML = html;
        div.onclick = () => equipItem(item);

        // Comparison hover
        div.onmouseenter = e => showComparison(div, item);
        div.onmouseleave = hideComparison;

        inv.appendChild(div);
    });
}

// Comparison
function showComparison(itemDiv, newItem) {
    if (newItem.type === "potion") return;
    const equippedItem = gameState.player.equipped[newItem.type];
    const comparisonArea = document.getElementById('comparison-area');
    const comparisonContent = document.getElementById('comparison-content');

    if (!equippedItem) {
        comparisonArea.style.display = "none";
        return;
    }

    comparisonArea.style.display = "block";

    let html = "";

    // New item
    html += `<div class="comparison-item-name" style="color:${newItem.rarity.color}">NEW: ${newItem.name}</div>`;
    const newAtk = newItem.atk || 0;
    const oldAtk = equippedItem.atk || 0;
    const atkDiff = newAtk - oldAtk;
    const atkClass = atkDiff > 0 ? "stat-better" : atkDiff < 0 ? "stat-worse" : "stat-same";
    html += `<div class="stat-comparison ${atkClass}">ATK: ${newAtk} (${atkDiff >= 0 ? "+" : ""}${atkDiff})</div>`;

    const newDef = newItem.def || 0;
    const oldDef = equippedItem.def || 0;
    const defDiff = newDef - oldDef;
    const defClass = defDiff > 0 ? "stat-better" : defDiff < 0 ? "stat-worse" : "stat-same";
    html += `<div class="stat-comparison ${defClass}">DEF: ${newDef} (${defDiff >= 0 ? "+" : ""}${defDiff})</div>`;

    if (newItem.passives && newItem.passives.length > 0) {
        html += `<div style="font-size:1em; margin-top:8px; color:var(--accent-secondary);">NEW PASSIVES</div>`;
        newItem.passives.forEach(p => {
            html += `<div style="font-size:0.95em; color:var(--accent-secondary); margin-left:5px;">${p.name} +${p.value}</div>`;
        });
    }

    html += `<div style="border-top:1px solid #555; margin:10px 0;"></div>`;

    // Old item
    html += `<div class="comparison-item-name" style="color:${equippedItem.rarity.color}">OLD: ${equippedItem.name}</div>`;
    html += `<div class="stat-comparison" style="color:#aaa;">ATK: ${oldAtk}</div>`;
    html += `<div class="stat-comparison" style="color:#aaa;">DEF: ${oldDef}</div>`;

    if (equippedItem.passives && equippedItem.passives.length > 0) {
        html += `<div style="font-size:1em; margin-top:8px; color:#888;">OLD PASSIVES</div>`;
        equippedItem.passives.forEach(p => {
            html += `<div style="font-size:0.95em; color:#888; margin-left:5px;">${p.name} +${p.value}</div>`;
        });
    }

    comparisonContent.innerHTML = html;
}

function hideComparison() {
    const comparisonArea = document.getElementById('comparison-area');
    comparisonArea.style.display = "none";
}

// Discard / crafting
function discardItem(index) {
    const item = gameState.player.inventory[index];
    if (!item || item.type === "potion") return;

    const rarityName = item.rarity.name.toUpperCase();

    gameState.player.inventory.splice(index, 1);

    // Scrapper — 50% chance to give 2 towards discard progression instead of 1
    let discardAmount = 1;
    if (gameState.player.passiveEffects.scrapper && Math.random() < 0.5) {
        discardAmount = 2;
        addLog("Scrapper! Double discard progress!", "log-loot");
    }
    gameState.discardCounts[rarityName] += discardAmount;

    addLog(`Discarded ${item.name}`, "log-loot");

    // Soul Forge — discarding grants +1 to a random base stat
    if (hasMedallion("soulForge")) {
        const statOptions = ["atk", "def", "spd", "luck", "crit", "maxHp", "maxMp"];
        const chosen = statOptions[Math.floor(Math.random() * statOptions.length)];
        gameState.player[chosen] += 1;
        const displayName = chosen === "maxHp" ? "Max HP" : chosen === "maxMp" ? "Max MP" : chosen.toUpperCase();
        addLog(`Soul Forge! +1 ${displayName}!`, "log-level");
        updateStats();
    }

    // Ascended discards → medallion (10 required)
    if (rarityName === "ASCENDED") {
        if (gameState.discardCounts.ASCENDED >= 10) {
            gameState.discardCounts.ASCENDED -= 10;
            craftMedallion();
        }
        updateInventoryDisplay();
        return;
    }

    // Mythic requires 20 discards to craft Ascended; all others require 10
    const requiredDiscards = rarityName === "MYTHIC" ? 20 : 10;

    if (gameState.discardCounts[rarityName] >= requiredDiscards) {
        gameState.discardCounts[rarityName] -= requiredDiscards;
        const nextR = nextRarity(RARITIES[rarityName]);

        if (nextR) {
            const craftedItem = generateLoot(false);
            craftedItem.rarity = nextR;
            craftedItem.atk = Math.floor(craftedItem.atk * nextR.statMult);
            craftedItem.def = Math.floor(craftedItem.def * nextR.statMult);
            craftedItem.passives = [];
            // Discard-craft uses simplified passive count: Rare/Epic = 1
            const passiveCount = nextR === RARITIES.EPIC ? 1
                : nextR === RARITIES.RARE ? 1
                : nextR.numPassives;
            const isLegPlus = isLegendaryPlus(nextR);
            const useMaxValues = (nextR === RARITIES.ASCENDED) || hasMedallion("eightLeafClover");
            for (let i = 0; i < passiveCount; i++) {
                const effect = rollPassiveForItemType(craftedItem.type, isLegPlus);
                const value = useMaxValues ? effect.range[1] * 2 : Math.floor(effect.range[0] + Math.random() * (effect.range[1] - effect.range[0]));
                craftedItem.passives.push({
                    name: effect.name,
                    stat: effect.stat,
                    value,
                    desc: effect.desc
                });
            }

            gameState.player.inventory.push(craftedItem);
            addLog(`CRAFTED ${nextR.name.toUpperCase()} ${craftedItem.name}!`, "log-loot");

            if (nextR === RARITIES.ASCENDED) gameState.stats.ascendedItems++;
            else if (nextR === RARITIES.MYTHIC) gameState.stats.mythicItems++;
            else if (nextR === RARITIES.LEGENDARY) gameState.stats.legendaryItems++;
        }
    }

    updateInventoryDisplay();
}

// Check if player has a specific medallion buff
function hasMedallion(stat) {
    return gameState.player.medallions.some(m => m.stat === stat);
}

// Craft a new medallion from 10 Ascended discards
function craftMedallion() {
    const p = gameState.player;
    const ownedStats = p.medallions.map(m => m.stat);
    const available = MEDALLION_BUFFS.filter(b => !ownedStats.includes(b.stat));

    if (available.length === 0) {
        addLog("You already own all Ascended Medallions!", "log-loot");
        return;
    }

    const chosen = available[Math.floor(Math.random() * available.length)];
    const medallion = {
        name: chosen.name,
        desc: chosen.desc,
        stat: chosen.stat
    };
    p.medallions.push(medallion);

    addLog(`ASCENDED MEDALLION FORGED: ${chosen.name}!`, "log-level");
    addLog(`${chosen.desc}`, "log-level");
    createParticles(p.x, p.y, "#00ffcc", 50);

    // Double Up — add extra equipment slots
    if (chosen.stat === "doubleUp") {
        if (!p.equipped.weapon2) p.equipped.weapon2 = null;
        if (!p.equipped.cape2) p.equipped.cape2 = null;
        if (!p.equipped.relic2) p.equipped.relic2 = null;
    }

    applyPassiveEffects();
    updateStats();
    updateInventoryDisplay();
}

// Sort inventory by base stats (ATK + DEF), highest first
function sortInventory() {
    gameState.player.inventory.sort((a, b) => {
        if (a.type === "potion" && b.type !== "potion") return 1;
        if (a.type !== "potion" && b.type === "potion") return -1;
        if (a.type === "potion" && b.type === "potion") return 0;
        const aTotal = (a.atk || 0) + (a.def || 0);
        const bTotal = (b.atk || 0) + (b.def || 0);
        return bTotal - aTotal;
    });
    updateInventoryDisplay();
    addLog("Inventory sorted by base stats.", "log-loot");
}

// Discard all unequipped items of a specific rarity
function discardAllOfRarity(rarityKey) {
    const rarityObj = RARITIES[rarityKey];
    if (!rarityObj) return;

    const equipped = Object.values(gameState.player.equipped);
    let discardedCount = 0;

    // Build a list of items to discard (skip equipped and potions)
    const toDiscard = gameState.player.inventory.filter(item => {
        if (item.type === "potion") return false;
        if (equipped.includes(item)) return false;
        return item.rarity === rarityObj;
    });

    if (toDiscard.length === 0) {
        addLog(`No unequipped ${rarityObj.name} items to discard.`);
        return;
    }

    toDiscard.forEach(item => {
        gameState.player.inventory = gameState.player.inventory.filter(i => i !== item);
        gameState.discardCounts[rarityKey]++;
        discardedCount++;
    });

    addLog(`Discarded ${discardedCount} ${rarityObj.name} items!`, "log-loot");

    // Soul Forge — +1 random base stat per item discarded
    if (hasMedallion("soulForge") && discardedCount > 0) {
        const statOptions = ["atk", "def", "spd", "luck", "crit", "maxHp", "maxMp"];
        let totalGains = {};
        for (let i = 0; i < discardedCount; i++) {
            const chosen = statOptions[Math.floor(Math.random() * statOptions.length)];
            gameState.player[chosen] += 1;
            totalGains[chosen] = (totalGains[chosen] || 0) + 1;
        }
        const summary = Object.entries(totalGains).map(([k, v]) => {
            const name = k === "maxHp" ? "Max HP" : k === "maxMp" ? "Max MP" : k.toUpperCase();
            return `+${v} ${name}`;
        }).join(", ");
        addLog(`Soul Forge! ${summary}`, "log-level");
        updateStats();
    }

    // Ascended discards → medallions
    if (rarityKey === "ASCENDED") {
        while (gameState.discardCounts.ASCENDED >= 10) {
            gameState.discardCounts.ASCENDED -= 10;
            craftMedallion();
        }
        updateInventoryDisplay();
        return;
    }

    // Check for crafting (may trigger multiple times)
    const requiredDiscards = rarityKey === "MYTHIC" ? 20 : 10;
    while (gameState.discardCounts[rarityKey] >= requiredDiscards) {
        gameState.discardCounts[rarityKey] -= requiredDiscards;
        const nextR = nextRarity(RARITIES[rarityKey]);

        if (nextR) {
            const craftedItem = generateLoot(false);
            craftedItem.rarity = nextR;
            craftedItem.atk = Math.floor(craftedItem.atk * nextR.statMult);
            craftedItem.def = Math.floor(craftedItem.def * nextR.statMult);
            craftedItem.passives = [];
            const passiveCount = nextR === RARITIES.EPIC ? 1
                : nextR === RARITIES.RARE ? 1
                : nextR.numPassives;
            const isLegPlus = isLegendaryPlus(nextR);
            const useMaxValues = (nextR === RARITIES.ASCENDED) || hasMedallion("eightLeafClover");
            for (let i = 0; i < passiveCount; i++) {
                const effect = rollPassiveForItemType(craftedItem.type, isLegPlus);
                const value = useMaxValues ? effect.range[1] * 2 : Math.floor(effect.range[0] + Math.random() * (effect.range[1] - effect.range[0]));
                craftedItem.passives.push({ name: effect.name, stat: effect.stat, value, desc: effect.desc });
            }
            gameState.player.inventory.push(craftedItem);
            addLog(`CRAFTED ${nextR.name.toUpperCase()} ${craftedItem.name}!`, "log-loot");

            if (nextR === RARITIES.ASCENDED) gameState.stats.ascendedItems++;
            else if (nextR === RARITIES.MYTHIC) gameState.stats.mythicItems++;
            else if (nextR === RARITIES.LEGENDARY) gameState.stats.legendaryItems++;
        }
    }

    updateInventoryDisplay();
}

// Equip / use
function equipItem(item) {
    if (item.type === "potion") {
        gameState.player.hp = Math.min(gameState.player.maxHp, gameState.player.hp + item.healHp);
        gameState.player.mp = Math.min(gameState.player.maxMp, gameState.player.mp + item.healMp);
        gameState.player.inventory = gameState.player.inventory.filter(i => i !== item);
        addLog("Used potion! Restored HP and MP", "log-loot");
        updateBars();
        updateInventoryDisplay();
        return;
    }

    const slot = item.type;
    const p = gameState.player;

    // Check if already equipped in primary or secondary slot
    if (p.equipped[slot] === item) {
        p.equipped[slot] = null;
        addLog(`Unequipped ${item.name}`, "log-loot");
    } else if (hasMedallion("doubleUp") && p.equipped[slot + "2"] === item) {
        p.equipped[slot + "2"] = null;
        addLog(`Unequipped ${item.name}`, "log-loot");
    } else {
        // Double Up: if primary slot full and secondary exists, try secondary
        const hasDoubleSlot = hasMedallion("doubleUp") && (slot === "weapon" || slot === "cape" || slot === "relic");
        if (hasDoubleSlot && p.equipped[slot] && !p.equipped[slot + "2"]) {
            p.equipped[slot + "2"] = item;
        } else if (hasDoubleSlot && !p.equipped[slot]) {
            p.equipped[slot] = item;
        } else {
            p.equipped[slot] = item;
        }
        addLog(`Equipped ${item.name}`, "log-loot");
    }

    updateStats();
    updateInventoryDisplay();
    applyPassiveEffects();
}

function equipBestItems() {
    const p = gameState.player;
    const inventory = p.inventory.filter(i => i.type !== "potion");
    if (inventory.length === 0) return;

    // Determine all valid slots (including Double Up secondary slots)
    const baseSlots = ["weapon", "helmet", "chest", "legs", "gloves", "boots", "cape", "relic"];
    const hasDouble = hasMedallion("doubleUp");
    const doubleSlots = hasDouble ? ["weapon2", "cape2", "relic2"] : [];
    const allSlots = [...baseSlots, ...doubleSlots];

    // Clear all equipment first
    allSlots.forEach(slot => { p.equipped[slot] = null; });

    // For each base slot, find the best item(s) by ATK + DEF
    baseSlots.forEach(baseSlot => {
        const candidates = inventory.filter(i => i.type === baseSlot);
        if (candidates.length === 0) return;

        // Sort by combined ATK + DEF descending
        candidates.sort((a, b) => ((b.atk || 0) + (b.def || 0)) - ((a.atk || 0) + (a.def || 0)));

        // Equip best to primary slot
        p.equipped[baseSlot] = candidates[0];

        // If Double Up applies to this slot and there's a second item, equip it
        if (hasDouble && (baseSlot === "weapon" || baseSlot === "cape" || baseSlot === "relic") && candidates.length > 1) {
            p.equipped[baseSlot + "2"] = candidates[1];
        }
    });

    addLog("Auto-equipped best items by ATK + DEF!", "log-loot");
    updateStats();
    updateInventoryDisplay();
    applyPassiveEffects();
}

// Stats / bars
function updateStats() {
    const p = gameState.player;
    let totalAtk = getBaseAttackPower();
    let totalDef = getEffectivePlayerDef();

    // Berserker low-HP bonus (display hint; adjacency bonus is per-hit, not shown)
    if (p.passiveEffects.berserker && p.hp <= p.maxHp * 0.3) {
        totalAtk = Math.floor(totalAtk * (1 + p.passiveEffects.berserker / 100));
    }

    // Goldblood — luck also boosts DEF
    if (p.passiveEffects.goldblood) {
        const totalLuck = (p.luck || 0) + (p.passiveEffects.luck || 0);
        totalDef += Math.floor(totalLuck * p.passiveEffects.goldblood / 100);
    }

    // Adrenaline SPD display bonus
    let spdDisplay = p.spd + (p.passiveEffects.speed || 0);
    if (p.adrenalineTurns > 0 && p.passiveEffects.adrenaline) {
        spdDisplay += Math.floor(spdDisplay * p.passiveEffects.adrenaline / 100);
    }

    document.getElementById('atk').textContent = totalAtk;
    document.getElementById('def').textContent = totalDef;
    document.getElementById('spd').textContent = spdDisplay;
    document.getElementById('crit').textContent = p.crit + (p.passiveEffects.crit || 0);
    document.getElementById('luck').textContent = p.luck + (p.passiveEffects.luck || 0);
    document.getElementById('level').textContent = p.level;

    updateBars();
}

function updateBars() {
    const p = gameState.player;
    document.getElementById('hp-text').textContent = `${p.hp}/${p.maxHp}`;
    document.getElementById('hp-bar').style.width = `${(p.hp / p.maxHp) * 100}%`;

    document.getElementById('mp-text').textContent = `${p.mp}/${p.maxMp}`;
    document.getElementById('mp-bar').style.width = `${(p.mp / p.maxMp) * 100}%`;

    document.getElementById('xp-text').textContent = `${p.xp}/${p.xpToNext}`;
    document.getElementById('xp-bar').style.width = `${(p.xp / p.xpToNext) * 100}%`;
}

// Log
function addLog(message, className) {
    const log = document.getElementById('log');
    const entry = document.createElement('div');
    entry.textContent = message;
    if (className) entry.className = className;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 20) {
        log.removeChild(log.firstChild);
    }
}

// Enemies
function createEnemy(isBoss = false, isRareBoss = false, kindId = null) {
    const f = gameState.floor;
    // Scaling: linear + polynomial + cubic kicker (see CONFIG.difficulty)
    const D = CONFIG.difficulty;
    const floorMultiplier = 1 + (f * D.linearPerFloor)
        + Math.pow(f / D.polyDivisor, D.polyExponent)
        + (f > D.cubicThreshold ? Math.pow((f - D.cubicThreshold) / D.cubicDivisor, D.cubicExponent) : 0);

    const E = CONFIG.enemies;
    // Bosses always use grunt AI; regular enemies roll a kind.
    const kind = ENEMY_KINDS[isBoss || isRareBoss ? "grunt" : (kindId || "grunt")] || ENEMY_KINDS.grunt;

    const baseHpMult = isRareBoss ? E.rareBossHpMult : isBoss ? E.bossHpMult : 1;
    const baseAtkMult = isRareBoss ? E.rareBossAtkMult : isBoss ? E.bossAtkMult : E.normalAtkMult;
    const hpMult = baseHpMult * kind.hpMult;
    const atkMult = baseAtkMult * kind.atkMult;

    const floorDefScale = Math.min(gameState.floor / 10, 1);
    const bossDefBase = isRareBoss ? 1.5 : isBoss ? 1.2 : 1;
    const bossDefMax = isRareBoss ? 4 : isBoss ? 2.5 : 1;
    const defMult = (bossDefBase + (bossDefMax - bossDefBase) * floorDefScale) * kind.defMult;

    // Ensure enemies don't spawn adjacent to player or inside walls.
    const px = gameState.player.x;
    const py = gameState.player.y;
    let ex, ey, tries = 0;
    do {
        ex = Math.floor(Math.random() * GRIDSIZE);
        ey = Math.floor(Math.random() * GRIDSIZE);
        tries++;
    } while (tries < 200 && (
        Math.abs(ex - px) + Math.abs(ey - py) <= CONFIG.difficulty.enemySafeRadius
        || isWall(ex, ey)
    ));

    return {
        x: ex,
        y: ey,
        hp: Math.floor(20 + Math.random() * 20 * floorMultiplier * hpMult),
        maxHp: Math.floor(20 + Math.random() * 20 * floorMultiplier * hpMult),
        atk: Math.floor(8 + Math.random() * 7 * floorMultiplier * atkMult),
        def: Math.floor(2 + Math.random() * 3 * floorMultiplier * defMult),
        xp: isRareBoss ? gameState.player.xpToNext : Math.floor(10 + Math.random() * 10 * floorMultiplier * hpMult),
        isBoss,
        isRareBoss,
        kind: kind.id,
        // Boss colors override kind color
        color: isRareBoss ? "#ffd93d" : isBoss ? "#ff6b9d" : kind.color
    };
}

function generateFloor() {
    gameState.enemies = [];
    gameState.walls = [];

    const p = gameState.player;

    // Walls — scaled per floor, never adjacent to player spawn.
    if (gameState.floor >= CONFIG.terrain.wallMinFloor) {
        const T = CONFIG.terrain;
        const count = Math.min(T.wallMaxCount, Math.floor(T.wallBaseCount + T.wallPerFloor * gameState.floor));
        const placed = new Set();
        let tries = 0;
        while (gameState.walls.length < count && tries < count * 20) {
            tries++;
            const wx = Math.floor(Math.random() * GRIDSIZE);
            const wy = Math.floor(Math.random() * GRIDSIZE);
            const key = wx + ',' + wy;
            if (placed.has(key)) continue;
            if (Math.abs(wx - p.x) + Math.abs(wy - p.y) <= T.wallSafeRadiusFromPlayer) continue;
            placed.add(key);
            gameState.walls.push({ x: wx, y: wy });
        }
    }

    // Floor resets for passives

    // Tenacity — convert leftover shield to bonus XP before resetting
    if (p.passiveEffects.tenacity && p.tenacityShield > 0) {
        const bonusXp = Math.floor(p.tenacityShield * 2);
        p.xp += bonusXp;
        if (bonusXp > 0) addLog(`Tenacity shield converted to ${bonusXp} bonus XP!`, "log-level");
    }

    p.bulwarkStacks = 0;
    p.ironRootsStacks = 0;
    p.guardianShellStacks = 0;
    p.enemiesHitThisFight = [];
    p.adrenalineTurns = 0;
    p.battleTempoMoves = 0;
    p.battleTempoCharged = false;
    p.lethalFocusStacks = 0;
    p.lethalFocusCharged = false;
    p.adrenalineSurgeMoves = 0;

    // Dual passive floor resets
    p.unyieldingForceStacks = 0;
    p.blitzStrikeMoves = 0;
    p.blitzStrikeCharged = false;
    p.phantomAssaultMoves = 0;
    p.phantomAssaultCharged = false;
    p.evasiveBulwarkShield = 0;
    p.evasiveBulwarkTurns = 0;
    p.fortunesGuardUsed = false;
    p.plundererBonusLuck = 0;

    // Mastery floor resets
    p.berserkersFuryStacks = 0;
    p.flashPointAttacks = 0;
    p.flashPointFirstAttack = true;
    p.stormDancerCooldown = 0;
    p.stormDancerMoves = 0;
    p.livingFortressSpdTurns = 0;
    p.luckyStarUsed = false;
    p.mirageCharged = false;
    p.goldTiles = [];
    p.bastionStuns = {};
    p.convergenceStacks = 0;
    p.manaBurnStacks = 0;
    // Undo chaos engine stat bonus from previous turn
    if (p.chaosEngineLastStat) {
        p[p.chaosEngineLastStat] -= p.chaosEngineLastBonus;
        p.chaosEngineLastStat = null;
        p.chaosEngineLastBonus = 0;
    }

    // Tenacity — grant shield at floor start based on base DEF (from level-ups)
    if (p.passiveEffects.tenacity) {
        p.tenacityShield = Math.floor(p.def * p.passiveEffects.tenacity / 100);
        if (p.tenacityShield > 0) addLog(`Tenacity shield: ${p.tenacityShield} HP!`, "log-level");
    } else {
        p.tenacityShield = 0;
    }

    // Regular enemies — scales fast to countRampThreshold, slower after to avoid grid saturation
    const f_ec = gameState.floor;
    const E = CONFIG.enemies;
    const enemyCount = E.baseCount + Math.floor(
        Math.min(f_ec, E.countRampThreshold) * E.countPerFloorEarly +
        Math.max(0, f_ec - E.countRampThreshold) * E.countPerFloorLate
    );
    for (let i = 0; i < enemyCount; i++) {
        const kindId = pickEnemyKind(gameState.floor);
        gameState.enemies.push(createEnemy(false, false, kindId));
    }

    // Bosses — logarithmic scaling, caps so bosses stay meaningful
    let bossCount = Math.random() < 0.5 ? 2 : 1;
    if (gameState.floor > E.bossMinFloorRamp) {
        bossCount += Math.min(E.bossMaxCount,
            Math.floor(Math.log2(Math.max(1, gameState.floor - E.bossMinFloorRamp)) * E.bossLogMultiplier));
    }
    for (let i = 0; i < bossCount; i++) {
        gameState.enemies.push(createEnemy(true, false));
    }

    // Rare bosses
    if (gameState.floor >= E.rareBossMinFloor) {
        const rareBossChance = Math.min(
            E.rareBossBaseChance + (gameState.floor - E.rareBossMinFloor) * E.rareBossChancePerFloor,
            1.0
        );
        if (Math.random() < rareBossChance) {
            const rareBossCount = gameState.floor >= E.rareBossDoubleSpawnFloor ? 2 : 1;
            for (let i = 0; i < rareBossCount; i++) {
                gameState.enemies.push(createEnemy(false, true));
            }
            addLog("A RARE BOSS has appeared!", "log-boss");
        }
    }

    // Elite enemies — separate stream past eliteMinFloor
    if (gameState.floor >= E.eliteMinFloor) {
        const eliteChance = Math.min(
            E.eliteBaseChance + (gameState.floor - E.eliteMinFloor) * E.eliteChancePerFloor,
            E.eliteMaxChance
        );
        if (Math.random() < eliteChance) {
            const eliteCount = gameState.floor >= E.eliteDoubleSpawnFloor ? 2 : 1;
            for (let i = 0; i < eliteCount; i++) {
                const elite = createEnemy(false, false);
                elite.isElite = true;
                elite.hp = Math.floor(elite.hp * 2.5);
                elite.maxHp = elite.hp;
                elite.atk = Math.floor(elite.atk * 1.8);
                elite.def = Math.floor(elite.def * 1.5);
                elite.xp = Math.floor(elite.xp * 2);
                elite.color = "#ff00ff";
                // Give elite a random personal modifier
                const mod = ENEMY_MODIFIERS[Math.floor(Math.random() * ENEMY_MODIFIERS.length)];
                elite.modifier = mod.stat;
                elite.modifierName = mod.name;
                gameState.enemies.push(elite);
            }
            addLog("An ELITE enemy has appeared!", "log-boss");
        }
    }

    // Arcane Ward enemies — AOE-resistant, must be killed with melee (floor 25+)
    if (gameState.floor >= 25) {
        const wardCount = 1 + Math.floor(Math.min(gameState.floor, 100) / 50); // 1-2 at F25-49, 2-3 at F50+
        for (let i = 0; i < wardCount; i++) {
            const ward = createEnemy(false, false);
            ward.isArcaneWard = true;
            ward.hp = Math.floor(ward.hp * 0.7); // Less HP to compensate for AOE resistance
            ward.maxHp = ward.hp;
            ward.atk = Math.floor(ward.atk * 1.3); // Slightly more dangerous
            ward.color = "#9966ff";
            gameState.enemies.push(ward);
        }
        addLog("Arcane Warded enemies lurk on this floor...", "log-boss");
    }

    // Endgame floor modifiers — every 5 floors starting at 35, stack beyond 100
    gameState.floorModifiers = [];
    if (gameState.floor >= 35) {
        // Base modifiers: one per 5-floor threshold from 35-100 (capped at all 4 unique mods)
        const baseModCount = Math.min(Math.floor((gameState.floor - 30) / 5), ENEMY_MODIFIERS.length);
        const shuffled = [...ENEMY_MODIFIERS].sort(() => Math.random() - 0.5);
        for (let i = 0; i < baseModCount; i++) {
            gameState.floorModifiers.push(shuffled[i]);
        }
        // Beyond floor 100: stack extra mods every 15 floors (exclude Frenzied from stacking)
        if (gameState.floor > 100) {
            const extraStacks = Math.floor((gameState.floor - 100) / 15);
            const stackableMods = ENEMY_MODIFIERS.filter(m => m.stat !== "frenzied");
            for (let i = 0; i < extraStacks; i++) {
                const mod = stackableMods[Math.floor(Math.random() * stackableMods.length)];
                gameState.floorModifiers.push(mod);
            }
        }
        if (gameState.floorModifiers.length > 0) {
            gameState.floorModifiers.forEach(m => {
                addLog(`⚠ Floor Modifier: ${m.name} — ${m.desc}`, "log-boss");
            });
        }
    }

    // Player debuffs — permanent per floor threshold, stack beyond 100
    gameState.playerDebuffs = [];
    PLAYER_DEBUFFS.forEach(debuff => {
        if (gameState.floor >= debuff.floor) {
            gameState.playerDebuffs.push(debuff);
        }
    });
    // Beyond floor 100: stack extra debuffs every 10 floors (exclude Death's Countdown)
    if (gameState.floor > 100) {
        const extraStacks = Math.floor((gameState.floor - 100) / 10);
        const stackableDebuffs = PLAYER_DEBUFFS.filter(d => d.stat !== "deathsCountdown");
        for (let i = 0; i < extraStacks; i++) {
            const debuff = stackableDebuffs[Math.floor(Math.random() * stackableDebuffs.length)];
            gameState.playerDebuffs.push(debuff);
        }
    }

    // Death's Countdown timer reset
    if (hasDebuff("deathsCountdown")) {
        gameState.deathsCountdownTurns = 40;
    }

    // Sacrifice altar — chance to appear beyond floor 60
    gameState.sacrificeAltar = null;
    gameState.altarUsed = false;
    if (gameState.floor >= 60 && Math.random() < 0.3) {
        let ax, ay;
        do {
            ax = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
            ay = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        } while ((ax === gameState.stairs.x && ay === gameState.stairs.y) ||
                 (ax === gameState.warpExit.x && ay === gameState.warpExit.y) ||
                 (gameState.blueWarpExit && ax === gameState.blueWarpExit.x && ay === gameState.blueWarpExit.y));
        gameState.sacrificeAltar = { x: ax, y: ay };
        addLog("A SACRIFICE ALTAR glows ominously...", "log-boss");
    }

    // Normal stairs — must not overlap a wall.
    let sx, sy, sTries = 0;
    do {
        sx = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        sy = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        sTries++;
    } while (sTries < 100 && isWall(sx, sy));
    gameState.stairs = { x: sx, y: sy };

    // Red warp exit — always spawns, different position from stairs, not on a wall.
    let wx, wy, wTries = 0;
    do {
        wx = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        wy = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        wTries++;
    } while (wTries < 100 && ((wx === gameState.stairs.x && wy === gameState.stairs.y) || isWall(wx, wy)));
    gameState.warpExit = { x: wx, y: wy };

    // Blue warp exit — always spawns, different position from stairs and red portal, not on a wall.
    let bx, by, bTries = 0;
    do {
        bx = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        by = Math.floor(Math.random() * (GRIDSIZE - 4)) + 2;
        bTries++;
    } while (bTries < 100 && (
        (bx === gameState.stairs.x && by === gameState.stairs.y) ||
        (bx === gameState.warpExit.x && by === gameState.warpExit.y) ||
        isWall(bx, by)
    ));
    gameState.blueWarpExit = { x: bx, y: by };

    // Reset undying on new floor
    gameState.player.undyingUsed = false;

    // Treasure tiles — hidden loot tiles spawned by Treasure Sense mastery
    gameState.treasureTiles = [];
    if (hasMastery("treasureSense")) {
        const tileCount = 3 + Math.floor(Math.random() * 3); // 3-5 tiles
        for (let i = 0; i < tileCount; i++) {
            let tx, ty;
            do {
                tx = Math.floor(Math.random() * (GRIDSIZE - 2)) + 1;
                ty = Math.floor(Math.random() * (GRIDSIZE - 2)) + 1;
            } while (
                (tx === gameState.stairs.x && ty === gameState.stairs.y) ||
                (tx === gameState.warpExit.x && ty === gameState.warpExit.y) ||
                (gameState.blueWarpExit && tx === gameState.blueWarpExit.x && ty === gameState.blueWarpExit.y) ||
                (gameState.sacrificeAltar && tx === gameState.sacrificeAltar.x && ty === gameState.sacrificeAltar.y) ||
                gameState.treasureTiles.some(t => t.x === tx && t.y === ty) ||
                (tx === p.x && ty === p.y)
            );
            gameState.treasureTiles.push({ x: tx, y: ty, collected: false });
        }
        addLog("You sense hidden treasures on this floor...", "log-loot");
    }

    document.getElementById('floor-indicator').textContent = `FLOOR ${gameState.floor}`;
    updateFloorModifiersDisplay();
    addLog(`Entered Floor ${gameState.floor}`, "log-level");
    addLog("A mysterious RED PORTAL has appeared...", "log-boss");
    addLog("A shimmering BLUE PORTAL beckons...", "log-boss");
}

function hasFloorModifier(stat) {
    return gameState.floorModifiers.some(m => m.stat === stat);
}

function countFloorModifier(stat) {
    return gameState.floorModifiers.filter(m => m.stat === stat).length;
}

function hasDebuff(stat) {
    return gameState.playerDebuffs.some(d => d.stat === stat);
}

function countDebuff(stat) {
    return gameState.playerDebuffs.filter(d => d.stat === stat).length;
}

function countEnemyModifier(enemy, stat) {
    let count = countFloorModifier(stat);
    if (enemy.modifier === stat) count++;
    return count;
}

function hasEnemyModifier(enemy, stat) {
    return enemy.modifier === stat || hasFloorModifier(stat);
}

function updateFloorModifiersDisplay() {
    const el = document.getElementById('floor-modifiers');
    if (!el) return;
    const parts = [];
    gameState.floorModifiers.forEach(m => {
        parts.push(`<span style="color:${m.color}">⚠ ${m.name.toUpperCase()}</span>`);
    });
    gameState.playerDebuffs.forEach(d => {
        parts.push(`<span style="color:${d.color}">☠ ${d.name.toUpperCase()}</span>`);
    });
    if (gameState.deathsCountdownTurns > 0 && hasDebuff("deathsCountdown")) {
        parts.push(`<span style="color:#ff0000">⏱ ${gameState.deathsCountdownTurns} TURNS</span>`);
    }
    el.innerHTML = parts.length > 0 ? parts.join(" | ") : "";
}

// Drawing
function drawGame() {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVASSIZE, CANVASSIZE);

    // Grid
    ctx.strokeStyle = "#111";
    for (let i = 0; i < GRIDSIZE; i++) {
        ctx.beginPath();
        ctx.moveTo(i * TILESIZE, 0);
        ctx.lineTo(i * TILESIZE, CANVASSIZE);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, i * TILESIZE);
        ctx.lineTo(CANVASSIZE, i * TILESIZE);
        ctx.stroke();
    }

    // AOE range highlight
    const px = gameState.player.x;
    const py = gameState.player.y;
    const aoeRange = 3 + (gameState.player.passiveEffects.psychicFlare ? 1 : 0);
    ctx.fillStyle = "rgba(78, 205, 196, 0.08)";
    for (let gx = 0; gx < GRIDSIZE; gx++) {
        for (let gy = 0; gy < GRIDSIZE; gy++) {
            const dist = Math.sqrt(Math.pow(gx - px, 2) + Math.pow(gy - py, 2));
            if (dist <= aoeRange && dist > 1) {
                ctx.fillRect(gx * TILESIZE, gy * TILESIZE, TILESIZE, TILESIZE);
            }
        }
    }
    // AOE range border ring
    ctx.strokeStyle = "rgba(78, 205, 196, 0.2)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx < GRIDSIZE; gx++) {
        for (let gy = 0; gy < GRIDSIZE; gy++) {
            const dist = Math.sqrt(Math.pow(gx - px, 2) + Math.pow(gy - py, 2));
            if (dist <= aoeRange && dist > aoeRange - 1) {
                ctx.strokeRect(gx * TILESIZE, gy * TILESIZE, TILESIZE, TILESIZE);
            }
        }
    }

    // Stairs
    if (gameState.stairs) {
        ctx.fillStyle = "#ffd93d";
        ctx.fillRect(
            gameState.stairs.x * TILESIZE + 8,
            gameState.stairs.y * TILESIZE + 8,
            16, 16
        );
        ctx.fillStyle = "#000";
        ctx.fillRect(
            gameState.stairs.x * TILESIZE + 10,
            gameState.stairs.y * TILESIZE + 10,
            12, 12
        );
    }

    // Red warp exit
    if (gameState.warpExit) {
        const wx = gameState.warpExit.x * TILESIZE;
        const wy = gameState.warpExit.y * TILESIZE;
        // Pulsing red glow
        const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 200);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = "#ff2222";
        ctx.fillRect(wx + 4, wy + 4, 24, 24);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#880000";
        ctx.fillRect(wx + 8, wy + 8, 16, 16);
        ctx.fillStyle = "#ff6666";
        ctx.fillRect(wx + 12, wy + 12, 8, 8);
    }

    // Blue warp exit
    if (gameState.blueWarpExit) {
        const bx = gameState.blueWarpExit.x * TILESIZE;
        const by = gameState.blueWarpExit.y * TILESIZE;
        // Pulsing blue glow
        const bPulse = 0.6 + 0.4 * Math.sin(Date.now() / 250);
        ctx.globalAlpha = bPulse;
        ctx.fillStyle = "#2266ff";
        ctx.fillRect(bx + 4, by + 4, 24, 24);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#001188";
        ctx.fillRect(bx + 8, by + 8, 16, 16);
        ctx.fillStyle = "#66aaff";
        ctx.fillRect(bx + 12, by + 12, 8, 8);
    }

    // Walls — drawn under enemies so dead enemies still appear on top during fades.
    if (gameState.walls && gameState.walls.length) {
        gameState.walls.forEach(w => {
            const wx = w.x * TILESIZE, wy = w.y * TILESIZE;
            // Base block — dark stone
            ctx.fillStyle = "#3a3548";
            ctx.fillRect(wx + 1, wy + 1, TILESIZE - 2, TILESIZE - 2);
            // Top-light bevel
            ctx.fillStyle = "#5a5470";
            ctx.fillRect(wx + 1, wy + 1, TILESIZE - 2, 3);
            ctx.fillRect(wx + 1, wy + 1, 3, TILESIZE - 2);
            // Bottom shadow
            ctx.fillStyle = "#1f1c2c";
            ctx.fillRect(wx + 1, wy + TILESIZE - 4, TILESIZE - 2, 3);
            ctx.fillRect(wx + TILESIZE - 4, wy + 1, 3, TILESIZE - 2);
            // Brick-line accent
            ctx.fillStyle = "#28253a";
            ctx.fillRect(wx + 5, wy + (TILESIZE / 2) - 1, TILESIZE - 10, 2);
        });
    }

    // Enemies
    gameState.enemies.forEach(enemy => {
        // Elite enemies get a pulsing outline
        if (enemy.isElite) {
            const elitePulse = 0.4 + 0.3 * Math.sin(Date.now() / 300);
            ctx.globalAlpha = elitePulse;
            ctx.fillStyle = "#ff00ff";
            ctx.fillRect(enemy.x * TILESIZE + 1, enemy.y * TILESIZE + 1, 30, 30);
            ctx.globalAlpha = 1;
        }
        // Arcane Ward enemies get a pulsing purple shield
        if (enemy.isArcaneWard) {
            const wardPulse = 0.3 + 0.3 * Math.sin(Date.now() / 400);
            ctx.globalAlpha = wardPulse;
            ctx.fillStyle = "#9966ff";
            ctx.fillRect(enemy.x * TILESIZE + 1, enemy.y * TILESIZE + 1, 30, 30);
            ctx.globalAlpha = 1;
        }

        ctx.fillStyle = enemy.color;
        ctx.fillRect(
            enemy.x * TILESIZE + 4,
            enemy.y * TILESIZE + 4,
            24, 24
        );
        ctx.fillStyle = "#fff";
        ctx.fillRect(enemy.x * TILESIZE + 8, enemy.y * TILESIZE + 10, 6, 6);
        ctx.fillRect(enemy.x * TILESIZE + 18, enemy.y * TILESIZE + 10, 6, 6);

        const hpPercent = enemy.hp / enemy.maxHp;
        ctx.fillStyle = "#000";
        ctx.fillRect(enemy.x * TILESIZE + 2, enemy.y * TILESIZE - 6, 28, 4);
        ctx.fillStyle = enemy.isRareBoss ? "#ffd93d" : enemy.isBoss ? "#ff6b9d" : enemy.isElite ? "#ff00ff" : enemy.isArcaneWard ? "#9966ff" : "#e74c3c";
        ctx.fillRect(enemy.x * TILESIZE + 2, enemy.y * TILESIZE - 6, 28 * hpPercent, 4);

        if (enemy.isRareBoss) {
            ctx.fillStyle = "#ffd93d";
            ctx.fillRect(enemy.x * TILESIZE + 6, enemy.y * TILESIZE - 4, 20, 5);
            ctx.fillStyle = "#ff6b9d";
            ctx.fillRect(enemy.x * TILESIZE + 8, enemy.y * TILESIZE - 7, 4, 4);
            ctx.fillRect(enemy.x * TILESIZE + 14, enemy.y * TILESIZE - 7, 4, 4);
            ctx.fillRect(enemy.x * TILESIZE + 20, enemy.y * TILESIZE - 7, 4, 4);
        } else if (enemy.isBoss) {
            ctx.fillStyle = "#ffd93d";
            ctx.fillRect(enemy.x * TILESIZE + 10, enemy.y * TILESIZE - 2, 12, 3);
        } else if (enemy.isElite) {
            // Elite diamond marker above
            ctx.fillStyle = "#ff00ff";
            ctx.fillRect(enemy.x * TILESIZE + 13, enemy.y * TILESIZE - 8, 6, 6);
            ctx.fillStyle = "#fff";
            ctx.fillRect(enemy.x * TILESIZE + 14, enemy.y * TILESIZE - 7, 4, 4);
        } else if (enemy.isArcaneWard) {
            // Arcane Ward shield marker above
            ctx.fillStyle = "#9966ff";
            ctx.fillRect(enemy.x * TILESIZE + 11, enemy.y * TILESIZE - 8, 10, 6);
            ctx.fillStyle = "#ccaaff";
            ctx.fillRect(enemy.x * TILESIZE + 13, enemy.y * TILESIZE - 6, 6, 3);
        }

        // Kind-specific markers (only for non-boss regular enemies)
        if (!enemy.isBoss && !enemy.isRareBoss && !enemy.isElite) {
            const ex = enemy.x * TILESIZE;
            const ey = enemy.y * TILESIZE;
            if (enemy.kind === "charger") {
                // Two horn-spikes above head
                ctx.fillStyle = "#5a2a0e";
                ctx.fillRect(ex + 8, ey, 3, 5);
                ctx.fillRect(ex + 21, ey, 3, 5);
                // Telegraph: pulsing red warning ring during windup (no committed direction —
                // the dash axis is recomputed at dash time so an arrow would be a lie).
                if (enemy.chargeWindup > 0) {
                    const pulse = 0.4 + 0.4 * Math.sin(Date.now() / 120);
                    ctx.globalAlpha = pulse;
                    ctx.strokeStyle = "#ff3030";
                    ctx.lineWidth = 3;
                    ctx.strokeRect(ex + 1, ey + 1, TILESIZE - 2, TILESIZE - 2);
                    ctx.globalAlpha = 1;
                    ctx.lineWidth = 1;
                }
            } else if (enemy.kind === "ranger") {
                // Bow arch above head
                ctx.fillStyle = "#cc6600";
                ctx.fillRect(ex + 10, ey + 1, 12, 2);
                ctx.fillRect(ex + 10, ey + 3, 2, 3);
                ctx.fillRect(ex + 20, ey + 3, 2, 3);
                // Arrow trail when firing
                if (enemy.arrowFlash > 0) {
                    ctx.fillStyle = "#ffe680";
                    const dx = enemy.arrowDx || 0, dy = enemy.arrowDy || 0;
                    for (let i = 1; i <= (enemy.arrowDist || 1); i++) {
                        const tx = (enemy.x + dx * i) * TILESIZE;
                        const ty = (enemy.y + dy * i) * TILESIZE;
                        if (tx < 0 || ty < 0 || tx >= GRIDSIZE * TILESIZE || ty >= GRIDSIZE * TILESIZE) break;
                        ctx.fillRect(tx + 14, ty + 14, 4, 4);
                    }
                }
            } else if (enemy.kind === "healer") {
                // Green plus sign above
                ctx.fillStyle = "#7fffaa";
                ctx.fillRect(ex + 14, ey - 1, 4, 8);
                ctx.fillRect(ex + 12, ey + 1, 8, 4);
                if (enemy.healFlash > 0) {
                    ctx.globalAlpha = 0.5;
                    ctx.fillStyle = "#27ae60";
                    ctx.fillRect(ex, ey, TILESIZE, TILESIZE);
                    ctx.globalAlpha = 1;
                }
            }
        }
    });

    // Sacrifice Altar
    if (gameState.sacrificeAltar && !gameState.altarUsed) {
        const ax = gameState.sacrificeAltar.x * TILESIZE;
        const ay = gameState.sacrificeAltar.y * TILESIZE;
        const altarPulse = 0.5 + 0.3 * Math.sin(Date.now() / 400);
        ctx.globalAlpha = altarPulse;
        ctx.fillStyle = "#8800aa";
        ctx.fillRect(ax + 2, ay + 2, 28, 28);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#cc44ff";
        ctx.fillRect(ax + 6, ay + 6, 20, 20);
        ctx.fillStyle = "#fff";
        ctx.fillRect(ax + 12, ay + 8, 8, 4);
        ctx.fillRect(ax + 14, ay + 6, 4, 8);
        // Skull-like face
        ctx.fillStyle = "#000";
        ctx.fillRect(ax + 10, ay + 16, 4, 4);
        ctx.fillRect(ax + 18, ay + 16, 4, 4);
        ctx.fillRect(ax + 12, ay + 22, 8, 2);
    }

    // Treasure tiles (Treasure Sense mastery) — show shimmer if within detection range
    if (gameState.treasureTiles && gameState.treasureTiles.length > 0) {
        const p = gameState.player;
        const totalSpd = p.spd + (p.passiveEffects.speed || 0);
        const detectRange = 2 + Math.floor(totalSpd / 10);
        gameState.treasureTiles.forEach(t => {
            if (t.collected) return;
            const dist = Math.abs(t.x - p.x) + Math.abs(t.y - p.y);
            if (dist <= detectRange) {
                const shimmer = 0.3 + 0.2 * Math.sin(Date.now() / 300 + t.x * 7 + t.y * 13);
                ctx.globalAlpha = shimmer;
                ctx.fillStyle = "#ffd93d";
                ctx.fillRect(t.x * TILESIZE + 6, t.y * TILESIZE + 6, 20, 20);
                ctx.globalAlpha = 0.8;
                ctx.fillStyle = "#ffaa00";
                ctx.fillRect(t.x * TILESIZE + 10, t.y * TILESIZE + 10, 12, 12);
                ctx.fillStyle = "#fff";
                ctx.fillRect(t.x * TILESIZE + 13, t.y * TILESIZE + 13, 6, 6);
                ctx.globalAlpha = 1;
            }
        });
    }

    // Gold tiles (Gambler's Ruin mastery)
    if (gameState.player.goldTiles && gameState.player.goldTiles.length > 0) {
        gameState.player.goldTiles.forEach(gt => {
            const goldPulse = 0.5 + 0.3 * Math.sin(Date.now() / 200 + gt.x * 5);
            ctx.globalAlpha = goldPulse;
            ctx.fillStyle = "#ffd93d";
            ctx.fillRect(gt.x * TILESIZE + 8, gt.y * TILESIZE + 8, 16, 16);
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#aa7700";
            ctx.fillRect(gt.x * TILESIZE + 11, gt.y * TILESIZE + 11, 10, 10);
        });
    }

    // Player
    const p = gameState.player;
    ctx.fillStyle = "#4ecdc4";
    ctx.fillRect(p.x * TILESIZE + 4, p.y * TILESIZE + 4, 24, 24);
    ctx.fillStyle = "#fff";
    ctx.fillRect(p.x * TILESIZE + 8, p.y * TILESIZE + 10, 6, 6);
    ctx.fillRect(p.x * TILESIZE + 18, p.y * TILESIZE + 10, 6, 6);

    if (p.equipped.weapon) {
        ctx.fillStyle = p.equipped.weapon.rarity.color;
        ctx.fillRect(p.x * TILESIZE + 26, p.y * TILESIZE + 18, 4, 8);
    }

}

// Visual particle effect (currently disabled).
// Was removed when canvas-based particles caused lag at F50+.
// Signature preserved so future DOM/CSS-based reimplementation can drop in.
// Call sites: see grep `createParticles(`.
function createParticles(_gridX, _gridY, _color, _count) {
    // no-op
}

// Movement
function movePlayer(dx, dy) {
    const newX = gameState.player.x + dx;
    const newY = gameState.player.y + dy;

    if (!isWalkable(newX, newY)) return;

    gameState.player.x = newX;
    gameState.player.y = newY;

    gameState.player.recentMoves = (gameState.player.recentMoves || 0) + 1;

    // Convergence — moving resets stacks and Mana Burn
    gameState.player.convergenceStacks = 0;
    gameState.player.manaBurnStacks = 0;

    // Bulwark — moving resets stacks
    if (gameState.player.passiveEffects.bulwark) {
        gameState.player.bulwarkStacks = 0;
    }
    // Iron Roots — moving resets stacks (mirror of Bulwark; stacks via attack when standing)
    if (gameState.player.passiveEffects.ironRoots) {
        gameState.player.ironRootsStacks = 0;
    }

    // Adrenaline — decrement timer on move
    if (gameState.player.adrenalineTurns > 0) {
        gameState.player.adrenalineTurns--;
    }

    // Battle Tempo — track moves without taking damage
    if (gameState.player.passiveEffects.battleTempo) {
        gameState.player.battleTempoMoves = (gameState.player.battleTempoMoves || 0) + 1;
        // Threshold scales with SPD: base 5 tiles, reduced by 1 per 5 SPD (min 3)
        const tempoThreshold = Math.max(3, 5 - Math.floor(gameState.player.spd / 5));
        if (gameState.player.battleTempoMoves >= tempoThreshold && !gameState.player.battleTempoCharged) {
            gameState.player.battleTempoCharged = true;
            addLog(`Battle Tempo charged! Next attack deals +${gameState.player.passiveEffects.battleTempo}% damage!`, "log-level");
            updateBuffsPanel();
        }
    }

    // Blitz Strike (ATK+SPD dual) — track moves without attacking
    if (hasDualPassive("blitzStrike")) {
        gameState.player.blitzStrikeMoves = (gameState.player.blitzStrikeMoves || 0) + 1;
        if (gameState.player.blitzStrikeMoves >= 4 && !gameState.player.blitzStrikeCharged) {
            gameState.player.blitzStrikeCharged = true;
            addLog("Blitz Strike charged! Next attack deals massive bonus damage!", "log-boss");
            updateBuffsPanel();
        }
    }

    // Phantom Assault (SPD+CRIT dual) — track consecutive moves for crit bonus
    if (hasDualPassive("phantomAssault")) {
        gameState.player.phantomAssaultMoves = (gameState.player.phantomAssaultMoves || 0) + 1;
        if (gameState.player.phantomAssaultMoves >= 2 && !gameState.player.phantomAssaultCharged) {
            gameState.player.phantomAssaultCharged = true;
        }
    }

    // Evasive Bulwark (DEF+SPD dual) — decrement shield duration
    if (hasDualPassive("evasiveBulwark") && gameState.player.evasiveBulwarkTurns > 0) {
        gameState.player.evasiveBulwarkTurns--;
        if (gameState.player.evasiveBulwarkTurns <= 0) {
            gameState.player.evasiveBulwarkShield = 0;
        }
    }

    // Phantom Step — deal damage to adjacent enemies after moving
    if (gameState.player.passiveEffects.phantomStep) {
        let totalAtk = gameState.player.atk;
        Object.values(gameState.player.equipped).forEach(item => {
            if (item) totalAtk += item.atk || 0;
        });
        gameState.enemies.forEach(enemy => {
            const dist = Math.abs(enemy.x - newX) + Math.abs(enemy.y - newY);
            if (dist <= 1) {
                const phantomDmg = Math.max(1, Math.floor(totalAtk * gameState.player.passiveEffects.phantomStep / 100));
                enemy.hp -= phantomDmg;
                addLog(`Phantom Step deals ${phantomDmg} damage!`, "log-damage");
                createParticles(enemy.x, enemy.y, "#aa44ff");
            }
        });
        // Clean up enemies killed by Phantom Step
        gameState.enemies = gameState.enemies.filter(e => {
            if (e.hp <= 0) {
                gameState.player.xp += e.xp;
                gameState.stats.kills++;
                addLog("Phantom Step killed an enemy!", "log-boss");
                return false;
            }
            return true;
        });
    }

    // Kinetic Reserve — stack on movement (cap per CONFIG.combat.kineticStackMax)
    if (gameState.player.passiveEffects.kineticReserve) {
        if (gameState.player.kineticStacks < CONFIG.combat.kineticStackMax) {
            gameState.player.kineticStacks++;
            updateBuffsPanel();
        }
    }

    // Storm Dancer (ATK+SPD+CRIT tri) — track moves for AOE crit
    if (hasMastery("stormDancer")) {
        gameState.player.stormDancerMoves = (gameState.player.stormDancerMoves || 0) + 1;
        if (gameState.player.stormDancerCooldown > 0) gameState.player.stormDancerCooldown--;
    }

    // Living Fortress (DEF+SPD) — decay SPD bonus turns
    if (hasMastery("livingFortress") && gameState.player.livingFortressSpdTurns > 0) {
        gameState.player.livingFortressSpdTurns--;
    }

    // Bastion (DEF+SPD+CRIT tri) — deal damage when moving through enemy tiles
    if (hasMastery("bastion")) {
        let totalDef = gameState.player.def;
        Object.values(gameState.player.equipped).forEach(item => {
            if (item) totalDef += item.def || 0;
        });
        gameState.enemies.forEach(enemy => {
            if (enemy.x === newX && enemy.y === newY) {
                let bastionDmg = Math.floor(totalDef * 0.5);
                const critChance = gameState.player.crit + (gameState.player.passiveEffects.crit || 0);
                let bastionCrit = false;
                if (Math.random() * 100 < critChance) {
                    bastionDmg = Math.floor(bastionDmg * 2);
                    bastionCrit = true;
                    // Stun on crit
                    enemy.bastionStunned = 1;
                    addLog(`Bastion CRIT! ${bastionDmg} damage + stun!`, "log-boss");
                } else {
                    addLog(`Bastion deals ${bastionDmg} damage!`, "log-damage");
                }
                enemy.hp -= bastionDmg;
            }
        });
        gameState.enemies = gameState.enemies.filter(e => {
            if (e.hp <= 0) {
                gameState.player.xp += e.xp;
                gameState.stats.kills++;
                addLog("Bastion killed an enemy!", "log-boss");
                return false;
            }
            return true;
        });
    }

    // Treasure tile pickup (Treasure Sense mastery) — guaranteed Rare+ gear
    if (gameState.treasureTiles && gameState.treasureTiles.length > 0) {
        gameState.treasureTiles.forEach(t => {
            if (!t.collected && t.x === newX && t.y === newY) {
                t.collected = true;
                const loot = generateLoot(false, false, RARITIES.RARE);
                gameState.player.inventory.push(loot);
                gameState.stats.itemsCollected++;
                if (loot.rarity === RARITIES.ASCENDED) gameState.stats.ascendedItems++;
                else if (loot.rarity === RARITIES.MYTHIC) gameState.stats.mythicItems++;
                else if (loot.rarity === RARITIES.LEGENDARY) gameState.stats.legendaryItems++;
                addLog(`Hidden treasure! ${loot.rarity.name.toUpperCase()} ${loot.name}!`, "log-boss");
                createParticles(newX, newY, "#ffd93d", 25);
                updateInventoryDisplay();
            }
        });
    }

    // Gold tile pickup (Gambler's Ruin mastery)
    if (gameState.player.goldTiles && gameState.player.goldTiles.length > 0) {
        const remaining = [];
        gameState.player.goldTiles.forEach(gt => {
            if (gt.x === newX && gt.y === newY) {
                gameState.player.atk += 2;
                addLog("Gold tile! +2 ATK!", "log-level");
            } else {
                remaining.push(gt);
            }
        });
        gameState.player.goldTiles = remaining;
    }

    if (gameState.stairs && newX === gameState.stairs.x && newY === gameState.stairs.y) {
        gameState.floor++;
        gameState.floorsCleared = (gameState.floorsCleared || 0) + 1;
        gameState.player.x = 10;
        gameState.player.y = 10;
        generateFloor();
        addLog("Descended to the next floor!", "log-level");
    }

    // Red warp exit — skip 10 floors, flat stat boost
    if (gameState.warpExit && newX === gameState.warpExit.x && newY === gameState.warpExit.y) {
        gameState.floor += 10;
        // Warp = the reward, not 10 floors of play. Count as +1 for telemetry.
        gameState.floorsCleared = (gameState.floorsCleared || 0) + 1;
        gameState.player.atk += 2;
        gameState.player.def += 2;
        gameState.player.spd += 2;
        gameState.player.crit += 2;
        gameState.player.maxHp += 2;
        gameState.player.maxMp += 2;
        gameState.player.luck += 2;
        gameState.player.hp = gameState.player.maxHp;
        gameState.player.mp = gameState.player.maxMp;
        gameState.player.x = 10;
        gameState.player.y = 10;
        generateFloor();
        addLog("You stepped through the RED PORTAL!", "log-boss");
        addLog("Warped 10 floors ahead! All stats boosted!", "log-level");
        createParticles(10, 10, "#ff2222", 40);
        updateStats();
        showAffinityScreen();
    }

    // Blue warp exit — skip 30 floors, bigger stat boost + 2 affinities
    if (gameState.blueWarpExit && newX === gameState.blueWarpExit.x && newY === gameState.blueWarpExit.y) {
        gameState.floor += 30;
        gameState.floorsCleared = (gameState.floorsCleared || 0) + 1;
        gameState.player.atk += 3;
        gameState.player.def += 3;
        gameState.player.spd += 3;
        gameState.player.crit += 3;
        gameState.player.maxHp += 3;
        gameState.player.maxMp += 3;
        gameState.player.luck += 7;
        gameState.player.hp = gameState.player.maxHp;
        gameState.player.mp = gameState.player.maxMp;
        gameState.player.x = 10;
        gameState.player.y = 10;
        generateFloor();
        addLog("You stepped through the BLUE PORTAL!", "log-boss");
        addLog("Warped 30 floors ahead! Major stat boost!", "log-level");
        createParticles(10, 10, "#2266ff", 50);
        updateStats();
        // 2 affinity levels
        gameState.pendingAffinityPoints = 2;
        showAffinityScreen();
    }

    // Sacrifice Altar interaction
    if (gameState.sacrificeAltar && !gameState.altarUsed &&
        newX === gameState.sacrificeAltar.x && newY === gameState.sacrificeAltar.y) {
        showSacrificeScreen();
    }

    if (gameState.player.passiveEffects.regen) {
        let regenAmount = Math.floor(gameState.player.maxHp * gameState.player.passiveEffects.regen / 100);
        regenAmount = Math.max(1, regenAmount);
        const cbRegenStacks = countDebuff("cursedBlood");
        if (cbRegenStacks > 0) regenAmount = Math.floor(regenAmount * Math.pow(0.6, cbRegenStacks));
        gameState.player.hp = Math.min(
            gameState.player.maxHp,
            gameState.player.hp + Math.max(1, regenAmount)
        );
    }

    // Void Siphon — lose 1 MP per tile moved per stack
    const voidStacks = countDebuff("voidSiphon");
    if (voidStacks > 0) {
        gameState.player.mp = Math.max(0, gameState.player.mp - voidStacks);
    }

    // Death's Countdown — decrement timer on move
    if (hasDebuff("deathsCountdown") && gameState.deathsCountdownTurns > 0) {
        gameState.deathsCountdownTurns--;
        updateFloorModifiersDisplay();
        if (gameState.deathsCountdownTurns <= 0) {
            gameState.player.hp = 0;
            addLog("DEATH'S COUNTDOWN reached zero! You perish!", "log-damage");
            gameOver();
            return;
        }
        if (gameState.deathsCountdownTurns <= 10) {
            addLog(`⏱ Death's Countdown: ${gameState.deathsCountdownTurns} turns remaining!`, "log-damage");
        }
    }
}

// Combat
function attack() {
    const p = gameState.player;
    let attacked = false;

    gameState.enemies.forEach((enemy, index) => {
        const dist = Math.abs(enemy.x - p.x) + Math.abs(enemy.y - p.y);
        if (dist <= 1) {
            attacked = true;

            // Phase Shift — enemy has 20% dodge chance per stack (capped at 80%)
            // War Machine mastery bypasses Phase Shift
            const phaseStacks = countEnemyModifier(enemy, "phaseShift");
            if (phaseStacks > 0 && !hasMastery("warMachine")) {
                const dodgeChance = Math.min(0.8, phaseStacks * 0.2);
                if (Math.random() < dodgeChance) {
                    addLog("Enemy Phase Shifted — attack missed!", "log-damage");
                    return;
                }
            }

            // Baseline ATK (overcharge + equipment + affinity + momentum + stat-scaling +
            // speedster + warMachine + warlord + withering). See getBaseAttackPower.
            let damage = getBaseAttackPower();
            // baseAtkVal still needed for some downstream passives that scale off pre-equipment ATK
            let baseAtkVal = p.atk;
            if (p.passiveEffects.overcharge) {
                baseAtkVal = Math.floor(baseAtkVal * p.passiveEffects.overcharge / 100);
            }

            // Berserker — low HP bonus + adjacent enemy bonus
            if (p.passiveEffects.berserker) {
                if (p.hp <= p.maxHp * 0.3) {
                    damage = Math.floor(damage * (1 + p.passiveEffects.berserker / 100));
                }
                let adjacentCount = 0;
                gameState.enemies.forEach(e => {
                    const d = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
                    if (d <= 1) adjacentCount++;
                });
                if (adjacentCount > 1) {
                    damage = Math.floor(damage * (1 + (adjacentCount - 1) * 0.1));
                    addLog(`Berserker! +${(adjacentCount - 1) * 10}% damage (${adjacentCount} adjacent)`, "log-damage");
                }
            }

            // Overwhelm — first hit on a target deals bonus damage
            if (p.passiveEffects.overwhelm) {
                if (!p.enemiesHitThisFight.includes(enemy)) {
                    damage = Math.floor(damage * (1 + p.passiveEffects.overwhelm / 100));
                    addLog(`Overwhelm! +${p.passiveEffects.overwhelm}% first-hit bonus!`, "log-damage");
                    p.enemiesHitThisFight.push(enemy);
                }
            }

            // Executioner — bonus damage to low HP enemies
            if (p.passiveEffects.executioner && enemy.hp < enemy.maxHp * 0.4) {
                damage = Math.floor(damage * (1 + p.passiveEffects.executioner / 100));
                addLog(`Executioner! +${p.passiveEffects.executioner}% damage (enemy low HP)`, "log-damage");
            }

            // Deathbringer mastery (ATK+DEF+CRIT) — 2x damage to enemies below 50% HP
            if (hasMastery("deathbringer") && enemy.hp < enemy.maxHp * 0.5) {
                damage = Math.floor(damage * 2);
                addLog("Deathbringer! 2x damage (enemy below 50% HP)!", "log-boss");
            }

            // Lethal Precision mastery (ATK+CRIT) — non-crits deal +15% bonus
            // (crit multiplier change handled below in crit section)
            let lethalPrecisionNonCritApplied = false;

            // Bulwark — bonus damage from standing still stacks (see CONFIG.combat)
            if (p.passiveEffects.bulwark && p.bulwarkStacks > 0) {
                damage = Math.floor(damage * (1 + p.bulwarkStacks * CONFIG.combat.bulwarkDmgPerStack));
                addLog(`Bulwark! +${p.bulwarkStacks * CONFIG.combat.bulwarkDmgPerStack * 100}% damage (${p.bulwarkStacks} stacks)`, "log-damage");
            }

            // Iron Roots — bonus damage from standing still stacks (mirror of Bulwark; stacks alongside it).
            if (p.passiveEffects.ironRoots && p.ironRootsStacks > 0) {
                damage = Math.floor(damage * (1 + p.ironRootsStacks * CONFIG.combat.ironRootsDmgPerStack));
                addLog(`Iron Roots! +${(p.ironRootsStacks * CONFIG.combat.ironRootsDmgPerStack * 100).toFixed(0)}% damage (${p.ironRootsStacks} stacks)`, "log-damage");
            }

            // Weakpoint Specialist — bonus damage to bosses
            if (p.passiveEffects.weakpointSpecialist && (enemy.isBoss || enemy.isRareBoss)) {
                damage = Math.floor(damage * (1 + p.passiveEffects.weakpointSpecialist / 100));
                addLog(`Weakpoint! +${p.passiveEffects.weakpointSpecialist}% boss damage!`, "log-damage");
            }

            // Momentum — SPD-based damage bonus
            if (p.passiveEffects.momentum) {
                const totalSpd = p.spd + (p.passiveEffects.speed || 0);
                damage = Math.floor(damage * (1 + (totalSpd * p.passiveEffects.momentum) / 1000));
            }

            // Battle Tempo — bonus damage after moving without taking damage
            if (p.passiveEffects.battleTempo && p.battleTempoCharged) {
                damage = Math.floor(damage * (1 + p.passiveEffects.battleTempo / 100));
                addLog(`Battle Tempo! +${p.passiveEffects.battleTempo}% damage!`, "log-damage");
                p.battleTempoCharged = false;
                p.battleTempoMoves = 0;
                updateBuffsPanel();
            }

            // Speedster — 50% bonus damage from total speed
            if (p.passiveEffects.speedster) {
                const totalSpd = p.spd + (p.passiveEffects.speed || 0);
                damage += Math.floor(totalSpd * 0.5);
            }

            // Berserker's Fury mastery (ATK+SPD) — stacking ATK bonus from kills
            if (hasMastery("berserkersFury") && p.berserkersFuryStacks > 0) {
                damage = Math.floor(damage * (1 + p.berserkersFuryStacks * 0.03));
            }

            // Kinetic Reserve — additive damage from movement stacks (see CONFIG.combat).
            if (p.passiveEffects.kineticReserve && p.kineticStacks > 0) {
                const kineticMult = 1 + CONFIG.combat.kineticPerStack * p.kineticStacks;
                damage = Math.floor(damage * kineticMult);
                addLog(`Kinetic Reserve x${kineticMult.toFixed(1)}! (${p.kineticStacks} stacks)`, "log-damage");
                p.kineticStacks = 0;
                updateBuffsPanel();
            }

            // Unyielding Force (ATK+DEF dual) — bonus damage from damage-taken stacks
            if (hasDualPassive("unyieldingForce") && p.unyieldingForceStacks > 0) {
                const ufBonus = 30 * p.unyieldingForceStacks; // ~30% per stack, up to 3
                damage = Math.floor(damage * (1 + ufBonus / 100));
                addLog(`Unyielding Force! +${ufBonus}% damage (${p.unyieldingForceStacks} stacks)!`, "log-damage");
                p.unyieldingForceStacks = 0;
                updateBuffsPanel();
            }

            // Blitz Strike (ATK+SPD dual) — bonus damage after 4 consecutive moves
            if (hasDualPassive("blitzStrike") && p.blitzStrikeCharged) {
                const blitzBonus = 100; // 100% bonus damage
                damage = Math.floor(damage * (1 + blitzBonus / 100));
                addLog(`Blitz Strike! +${blitzBonus}% damage!`, "log-boss");
                createParticles(enemy.x, enemy.y, "#ffd93d", 15);
                p.blitzStrikeCharged = false;
                p.blitzStrikeMoves = 0;
                // Grant 1 free move after Blitz Strike
                p.adrenalineSurgeMoves = (p.adrenalineSurgeMoves || 0) + 1;
                addLog("Blitz Strike grants +1 free move!", "log-level");
            }

            // Executioner's Mark (ATK+CRIT dual) — bonus damage to low HP enemies
            if (hasDualPassive("executionersMark") && enemy.hp < enemy.maxHp * 0.3) {
                const execBonus = 75; // 75% bonus damage to enemies below 30% HP
                damage = Math.floor(damage * (1 + execBonus / 100));
                addLog(`Executioner's Mark! +${execBonus}% damage (enemy below 30% HP)!`, "log-damage");
            }

            // --- Crit system with Precision, Deadeye, Shatterpoint + Masteries ---
            const hasLacerating = hasMedallion("laceratingBlows");
            let critChance = p.crit + (p.passiveEffects.crit || 0);
            // Precision — stacking crit chance after non-crits
            if (p.passiveEffects.precision) {
                critChance += p.precisionStacks;
            }
            // Phantom Assault (SPD+CRIT dual) — bonus crit chance after moving 2+ tiles
            if (hasDualPassive("phantomAssault") && p.phantomAssaultCharged) {
                critChance += 30; // +30% crit chance
            }
            // Flash Point mastery (SPD+CRIT) — first attack is guaranteed crit, every 3rd is guaranteed crit
            let flashPointForced = false;
            if (hasMastery("flashPoint")) {
                if (p.flashPointFirstAttack) {
                    flashPointForced = true;
                    p.flashPointFirstAttack = false;
                }
                p.flashPointAttacks = (p.flashPointAttacks || 0) + 1;
                if (p.flashPointAttacks % 3 === 0) {
                    flashPointForced = true;
                }
            }
            // Assassin's Creed mastery (ATK+CRIT+LUCK) — doubled crit vs full HP enemies
            if (hasMastery("assassinsCreed") && enemy.hp >= enemy.maxHp) {
                critChance *= 2;
            }

            const critEsc = getPrestigeLevel('criticalEscalation') * 0.03;
            // Affinity milestone: CRIT — bonus crit damage multiplier
            const critAffinityBonus = getAffinityBonus("critDamage");
            // Lethal Precision mastery (ATK+CRIT) — base crit is 3x instead of 2x
            const baseCritMult = (hasMastery("lethalPrecision") ? 3 : 2) + critAffinityBonus;
            let didCrit = false;
            if (hasLacerating) {
                didCrit = true;
                if (Math.random() * 100 < critChance || flashPointForced) {
                    const critMult = (baseCritMult + 1) + (p.passiveEffects.deadeye ? p.passiveEffects.deadeye / 100 : 0) + critEsc;
                    damage = Math.floor(damage * critMult);
                    addLog(`LACERATING CRITICAL x${critMult.toFixed(1)}!`, "log-damage");
                } else {
                    const critMult = baseCritMult + (p.passiveEffects.deadeye ? p.passiveEffects.deadeye / 100 : 0) + critEsc;
                    damage = Math.floor(damage * critMult);
                    addLog(`LACERATING HIT x${critMult.toFixed(1)}!`, "log-damage");
                }
                enemy.bleedDuration = CONFIG.combat.bleedDuration;
                enemy.bleedDmg = Math.floor(enemy.maxHp * CONFIG.combat.bleedFraction);
            } else if (Math.random() * 100 < critChance || flashPointForced) {
                didCrit = true;
                const critMult = baseCritMult + (p.passiveEffects.deadeye ? p.passiveEffects.deadeye / 100 : 0) + critEsc;
                // Mirage mastery (SPD+CRIT+LUCK) — post-phase crit +50%
                const mirageBonus = (hasMastery("mirage") && p.mirageCharged) ? 0.5 : 0;
                if (mirageBonus > 0) p.mirageCharged = false;
                damage = Math.floor(damage * (critMult + mirageBonus));
                addLog(`CRITICAL HIT x${(critMult + mirageBonus).toFixed(1)}!`, "log-damage");
            }

            // Lethal Precision — +15% on non-crits
            if (hasMastery("lethalPrecision") && !didCrit) {
                damage = Math.floor(damage * 1.15);
                lethalPrecisionNonCritApplied = true;
            }

            // Gambler's Ruin mastery (ATK+SPD+LUCK) — 10% for 3x, 5% for 0
            if (hasMastery("gamblersRuin")) {
                const roll = Math.random();
                if (roll < 0.05) {
                    damage = 0;
                    addLog("Gambler's Ruin — whiffed! 0 damage!", "log-damage");
                } else if (roll < 0.15) {
                    damage = Math.floor(damage * 3);
                    addLog("Gambler's Ruin — JACKPOT! 3x damage!", "log-boss");
                }
            }

            // Precision stack management
            if (p.passiveEffects.precision) {
                if (didCrit) {
                    p.precisionStacks = 0;
                } else {
                    p.precisionStacks += p.passiveEffects.precision;
                }
            }

            // Shatterpoint — crits reduce enemy DEF for 2 turns
            if (didCrit && p.passiveEffects.shatterpoint) {
                enemy.shatterpointDuration = 2;
                enemy.shatterpointReduction = p.passiveEffects.shatterpoint;
                addLog(`Shatterpoint! Enemy DEF reduced by ${p.passiveEffects.shatterpoint}%!`, "log-damage");
            }

            // Lethal Focus — track consecutive crits
            if (p.passiveEffects.lethalFocus) {
                if (didCrit) {
                    p.lethalFocusStacks = (p.lethalFocusStacks || 0) + 1;
                    if (p.lethalFocusStacks >= 3 && !p.lethalFocusCharged) {
                        p.lethalFocusCharged = true;
                        addLog("Lethal Focus CHARGED! Next kill guarantees Legendary+ drop!", "log-boss");
                        createParticles(p.x, p.y, "#ff8000", 15);
                    }
                } else {
                    p.lethalFocusStacks = 0;
                    p.lethalFocusCharged = false;
                }
            }

            // Phantom Assault (SPD+CRIT dual) — crit grants free move, then reset
            if (hasDualPassive("phantomAssault") && p.phantomAssaultCharged) {
                if (didCrit) {
                    p.adrenalineSurgeMoves = (p.adrenalineSurgeMoves || 0) + 1;
                    addLog("Phantom Assault! Crit grants +1 free move!", "log-level");
                }
                p.phantomAssaultCharged = false;
                p.phantomAssaultMoves = 0;
            }

            // Effective enemy DEF (Ironclad / Shatterpoint / Soulrend / Assassin's Creed).
            const effectiveDef = getEffectiveEnemyDef(enemy, { didCrit });

            // Goldblood — luck boosts damage
            if (p.passiveEffects.goldblood) {
                const totalLuck = (p.luck || 0) + (p.passiveEffects.luck || 0);
                damage += Math.floor(totalLuck * p.passiveEffects.goldblood / 100);
            }

            damage = Math.max(1, damage - effectiveDef);
            enemy.hp -= damage;

            if (p.passiveEffects.lifesteal) {
                let heal = Math.floor(damage * p.passiveEffects.lifesteal / 100);
                const cbStacks1 = countDebuff("cursedBlood");
                if (cbStacks1 > 0) heal = Math.floor(heal * Math.pow(0.6, cbStacks1));
                p.hp = Math.min(p.maxHp, p.hp + heal);
            }

            createParticles(enemy.x, enemy.y, "#ff0000");
            addLog(`Hit ${enemy.isRareBoss ? "RARE BOSS" : enemy.isBoss ? "BOSS" : enemy.isElite ? "ELITE" : "enemy"} for ${damage} damage!`, "log-damage");

            // Chrono Strike — every 4th attack hits twice at 50% damage
            if (hasMedallion("chronoStrike")) {
                p.chronoCounter++;
                if (p.chronoCounter >= 4) {
                    p.chronoCounter = 0;
                    const chronoDmg = Math.max(1, Math.floor(damage * 0.5));
                    enemy.hp -= chronoDmg;
                    addLog(`Chrono Strike! Bonus hit for ${chronoDmg} damage!`, "log-damage");
                    createParticles(enemy.x, enemy.y, "#00ccff");
                    if (p.passiveEffects.lifesteal) {
                        let chronoHeal = Math.floor(chronoDmg * p.passiveEffects.lifesteal / 100);
                        const cbStacks2 = countDebuff("cursedBlood");
                        if (cbStacks2 > 0) chronoHeal = Math.floor(chronoHeal * Math.pow(0.6, cbStacks2));
                        p.hp = Math.min(p.maxHp, p.hp + chronoHeal);
                    }
                }
            }

            if (enemy.hp <= 0) {
                // Siphon — kills restore MP (capped to prevent self-sustaining AOE)
                if (p.passiveEffects.siphon) {
                    const mpRestore = Math.min(CONFIG.combat.siphonMaxPerKill, Math.floor(p.maxMp * p.passiveEffects.siphon / 100));
                    p.mp = Math.min(p.maxMp, p.mp + mpRestore);
                }

                // Adrenaline — SPD boost on kill for 3 turns
                if (p.passiveEffects.adrenaline) {
                    p.adrenalineTurns = 3;
                    addLog(`Adrenaline! +${p.passiveEffects.adrenaline}% SPD for 3 turns!`, "log-level");
                }

                // Adrenaline Surge — grant bonus free moves on kill
                if (p.passiveEffects.adrenalineSurge) {
                    const maxSurgeMoves = p.passiveEffects.adrenalineSurge;
                    if ((p.adrenalineSurgeMoves || 0) < maxSurgeMoves) {
                        p.adrenalineSurgeMoves = (p.adrenalineSurgeMoves || 0) + 1;
                        addLog(`Adrenaline Surge! +1 free move (${p.adrenalineSurgeMoves}/${maxSurgeMoves})!`, "log-level");
                    }
                }

                p.xp += Math.floor(enemy.xp * (1 + getPrestigeLevel('experienced') * 0.10));
                gameState.stats.kills++;
                if (enemy.isRareBoss) gameState.stats.rareBossKills++;
                else if (enemy.isBoss) gameState.stats.bossKills++;

                createParticles(enemy.x, enemy.y, enemy.isElite ? "#ff00ff" : enemy.isRareBoss ? "#ffd93d" : "#ffd93d", enemy.isRareBoss ? 30 : enemy.isElite ? 25 : 20);
                addLog(enemy.isRareBoss ? "RARE BOSS defeated!" : enemy.isBoss ? "BOSS defeated!" : enemy.isElite ? "ELITE defeated!" : "Enemy defeated!", "log-boss");

                const isBoss = enemy.isBoss || enemy.isRareBoss;
                const isElite = enemy.isElite;
                let minRarity = enemy.isRareBoss ? RARITIES.RARE : isElite ? RARITIES.RARE : null;

                // Lethal Focus — guaranteed Legendary+ drop on kill after 3 consecutive crits
                if (p.lethalFocusCharged) {
                    minRarity = RARITIES.LEGENDARY;
                    p.lethalFocusCharged = false;
                    p.lethalFocusStacks = 0;
                    addLog("Lethal Focus! Guaranteed Legendary+ drop!", "log-boss");
                    createParticles(enemy.x, enemy.y, "#ff8000", 20);
                }

                // Executioner's Mark (ATK+CRIT dual) — crit kills on low HP enemies always drop gear
                let execMarkGuaranteeGear = false;
                if (hasDualPassive("executionersMark") && didCrit && enemy.hp <= 0) {
                    execMarkGuaranteeGear = true;
                }

                // Plunderer (ATK+LUCK dual) — overkill damage → temporary LUCK
                if (hasDualPassive("plunderer") && enemy.hp < 0) {
                    const overkill = Math.abs(enemy.hp);
                    const bonusLuck = Math.floor(overkill / 100);
                    if (bonusLuck > 0) {
                        p.plundererBonusLuck = (p.plundererBonusLuck || 0) + bonusLuck;
                        addLog(`Plunderer! Overkill → +${bonusLuck} temp LUCK (total: ${p.plundererBonusLuck})!`, "log-level");
                    }
                }

                // Berserker's Fury mastery (ATK+SPD) — +3% ATK per kill (max +30%), kill grants free move
                if (hasMastery("berserkersFury")) {
                    if (p.berserkersFuryStacks < 10) {
                        p.berserkersFuryStacks++;
                        addLog(`Berserker's Fury! +${p.berserkersFuryStacks * 3}% ATK!`, "log-level");
                    }
                    p.adrenalineSurgeMoves = (p.adrenalineSurgeMoves || 0) + 1;
                }

                // Blood Tithe mastery (ATK+LUCK) — 25% potion on kill + overkill heals
                if (hasMastery("bloodTithe")) {
                    if (Math.random() < 0.25) {
                        addPotions(1);
                        addLog("Blood Tithe! Kill drops a potion!", "log-loot");
                    }
                    if (enemy.hp < 0) {
                        const overkill = Math.abs(enemy.hp);
                        let heal = Math.floor(overkill * 0.10);
                        const cbStacks = countDebuff("cursedBlood");
                        if (cbStacks > 0) heal = Math.floor(heal * Math.pow(0.6, cbStacks));
                        if (heal > 0) {
                            p.hp = Math.min(p.maxHp, p.hp + heal);
                            addLog(`Blood Tithe heals ${heal} HP from overkill!`, "log-level");
                        }
                    }
                }

                // Deathbringer mastery (ATK+DEF+CRIT) — killing enemies with DEF > yours heals 25% max HP
                if (hasMastery("deathbringer")) {
                    let playerTotalDef = p.def;
                    Object.values(p.equipped).forEach(item => { if (item) playerTotalDef += item.def || 0; });
                    if (enemy.def > playerTotalDef) {
                        let heal = Math.floor(p.maxHp * 0.25);
                        const cbStacks = countDebuff("cursedBlood");
                        if (cbStacks > 0) heal = Math.floor(heal * Math.pow(0.6, cbStacks));
                        p.hp = Math.min(p.maxHp, p.hp + heal);
                        addLog(`Deathbringer! Killed tough enemy, healed ${heal} HP!`, "log-boss");
                    }
                }

                // Jackpot (CRIT+LUCK dual) — crit kills have chance for double drops
                let jackpotDoubled = false;
                if (hasDualPassive("jackpot") && didCrit) {
                    const jackpotChance = p.lethalFocusCharged ? 100 : 10; // 10% base, 100% if Lethal Focus was active
                    if (Math.random() * 100 < jackpotChance) {
                        jackpotDoubled = true;
                        addLog("JACKPOT! Double loot drop!", "log-boss");
                        createParticles(enemy.x, enemy.y, "#2ecc71", 20);
                    }
                }

                // Pirate King mastery (ATK+DEF+LUCK) — guaranteed Rare+ on all drops, bosses always drop 2
                if (hasMastery("pirateKing")) {
                    if (!minRarity || minRarity.statMult < RARITIES.RARE.statMult) {
                        minRarity = RARITIES.RARE;
                    }
                }
                let effectiveLootRolls = isBoss ? 2 : isElite ? 1 : 1;
                if (hasMastery("pirateKing") && isBoss) {
                    effectiveLootRolls = Math.max(effectiveLootRolls, 2);
                }

                const totalLootRolls = jackpotDoubled ? effectiveLootRolls * 2 : effectiveLootRolls;
                for (let i = 0; i < totalLootRolls; i++) {
                    let loot;
                    if (execMarkGuaranteeGear) {
                        // Force gear (not potion) on Executioner's Mark crit kills
                        loot = generateLoot(isBoss || isElite, true, minRarity);
                        while (loot.type === "potion") {
                            loot = generateLoot(isBoss || isElite, true, minRarity);
                        }
                    } else {
                        loot = generateLoot(isBoss || isElite, true, minRarity);
                    }

                    // Fortune's Edge mastery (CRIT+LUCK) — 30% chance to upgrade rarity on crit kills
                    if (hasMastery("fortunesEdge") && didCrit && loot.type !== "potion") {
                        if (Math.random() < 0.30) {
                            const newRarity = nextRarity(loot.rarity);
                            // Don't promote to Ascended via this effect
                            if (newRarity && newRarity !== RARITIES.ASCENDED) {
                                const oldStatMult = loot.rarity.statMult || 1;
                                loot.atk = Math.floor((loot.atk / oldStatMult) * newRarity.statMult);
                                loot.def = Math.floor((loot.def / oldStatMult) * newRarity.statMult);
                                loot.rarity = newRarity;
                                addLog(`Fortune's Edge! Gear upgraded to ${newRarity.name}!`, "log-boss");
                            }
                        }
                    }

                    if (loot.type === "potion") {
                        addPotions(1);
                        addLog("Found a Health Potion!", "log-loot");
                    } else {
                        gameState.player.inventory.push(loot);
                        gameState.stats.itemsCollected++;
                        if (loot.rarity === RARITIES.ASCENDED) gameState.stats.ascendedItems++;
                        else if (loot.rarity === RARITIES.MYTHIC) gameState.stats.mythicItems++;
                        else if (loot.rarity === RARITIES.LEGENDARY) gameState.stats.legendaryItems++;
                        addLog(`Found ${loot.rarity.name.toUpperCase()} ${loot.name}!`, "log-loot");
                    }
                }

                updateInventoryDisplay();
            }
        }
    });

    // Sweep dead enemies (replaces splice-in-forEach that skipped iterations)
    gameState.enemies = gameState.enemies.filter(e => e.hp > 0);

    p.recentMoves = 0;
    if (attacked) {
        p.kineticStacks = 0;
        // Bulwark — increment stacks when attacking (standing still)
        if (p.passiveEffects.bulwark && p.bulwarkStacks < CONFIG.combat.bulwarkStackMax) {
            p.bulwarkStacks++;
        }
        // Iron Roots — increment when attacking from standstill
        if (p.passiveEffects.ironRoots && p.ironRootsStacks < CONFIG.combat.ironRootsStackMax) {
            p.ironRootsStacks++;
        }
        // Convergence — increment stacks when not moving (max 5)
        if (hasFloorModifier("convergence") && p.convergenceStacks < 5) {
            p.convergenceStacks++;
            if (p.convergenceStacks >= 3) {
                addLog(`⚠ Convergence x${p.convergenceStacks} — enemies deal +${p.convergenceStacks * 15}% damage!`, "log-damage");
            }
        }
        // Blitz Strike — reset move counter after attacking (unless it was just consumed)
        if (hasDualPassive("blitzStrike") && !p.blitzStrikeCharged) {
            p.blitzStrikeMoves = 0;
        }

        // Storm Dancer mastery (ATK+SPD+CRIT) — AOE crit after 3+ moves, 5-turn cooldown
        if (hasMastery("stormDancer") && p.stormDancerMoves >= 3 && p.stormDancerCooldown <= 0) {
            let totalAtk = p.atk;
            Object.values(p.equipped).forEach(item => { if (item) totalAtk += item.atk || 0; });
            const stormDmg = Math.floor(totalAtk * 2); // crit-level damage
            let stormKills = 0;
            gameState.enemies.forEach(enemy => {
                const dist = Math.sqrt(Math.pow(enemy.x - p.x, 2) + Math.pow(enemy.y - p.y, 2));
                if (dist <= 2) {
                    const finalDmg = Math.max(1, stormDmg - enemy.def);
                    enemy.hp -= finalDmg;
                    addLog(`Storm Dancer hits for ${finalDmg}!`, "log-damage");
                }
            });
            gameState.enemies = gameState.enemies.filter(e => {
                if (e.hp <= 0) {
                    p.xp += e.xp;
                    gameState.stats.kills++;
                    stormKills++;
                    return false;
                }
                return true;
            });
            if (stormKills > 0) addLog(`Storm Dancer killed ${stormKills} enemies!`, "log-boss");
            p.stormDancerCooldown = 5;
            p.stormDancerMoves = 0;
            addLog("Storm Dancer! AOE crit blast!", "log-boss");
        }

        // Gambler's Ruin mastery (ATK+SPD+LUCK) — free moves spawn gold tiles
        if (hasMastery("gamblersRuin") && p.adrenalineSurgeMoves > 0) {
            if (Math.random() < 0.3) {
                p.goldTiles.push({ x: p.x, y: p.y });
            }
        }

        updateBuffsPanel();
    }

    if (!attacked) addLog("No enemy in range!", "log-damage");

    if (p.xp >= p.xpToNext) {
        levelUp();
    }

    // Death's Countdown — decrement on attack turn too
    if (attacked && hasDebuff("deathsCountdown") && gameState.deathsCountdownTurns > 0) {
        gameState.deathsCountdownTurns--;
        updateFloorModifiersDisplay();
        if (gameState.deathsCountdownTurns <= 0) {
            p.hp = 0;
            addLog("DEATH'S COUNTDOWN reached zero! You perish!", "log-damage");
            gameOver();
            return;
        }
        if (gameState.deathsCountdownTurns <= 10) {
            addLog(`⏱ Death's Countdown: ${gameState.deathsCountdownTurns} turns remaining!`, "log-damage");
        }
    }

    updateBars();
}

// Wait/Defend — costs nothing, advances enemy turn, grants +50% effective DEF
// for the incoming attack(s). Counts as standing-still for stacking passives
// (Bulwark, Iron Roots, Convergence-counter). Gives Sentinel a real verb and
// makes Charger telegraphs play-able instead of just lethal.
function defend() {
    const p = gameState.player;
    p.defendingTurns = 1;
    // Standing-still passives accumulate just like attacking would.
    if (p.passiveEffects.bulwark && p.bulwarkStacks < CONFIG.combat.bulwarkStackMax) {
        p.bulwarkStacks++;
    }
    if (p.passiveEffects.ironRoots && p.ironRootsStacks < CONFIG.combat.ironRootsStackMax) {
        p.ironRootsStacks++;
    }
    p.adrenalineSurgeMoves = 0;
    addLog("You brace. (+50% DEF this turn)", "log-level");
    enemyTurn();
    // Defence only applied to the enemy turn that just resolved.
    p.defendingTurns = 0;
    updateBuffsPanel();
    forecastDamage();
    updateBars();
}

function specialAttack() {
    const C = CONFIG.combat;
    let mpCost = C.aoeBaseCost;
    // Floor scaling
    mpCost += Math.floor(gameState.floor / C.aoeFloorCostPer);
    // Psychic Flare — +cost but +1 range
    if (gameState.player.passiveEffects.psychicFlare) mpCost += C.psychicFlareExtraCost;
    // Mana Burn — consecutive AOE casts without moving cost more
    mpCost += gameState.player.manaBurnStacks * C.manaBurnPerStack;
    const reduction = gameState.player.passiveEffects.arcane || 0;
    const actualCost = Math.floor(mpCost * (1 - reduction / 100));

    if (gameState.player.mp < actualCost) {
        addLog("Not enough MP!", "log-damage");
        return;
    }

    gameState.player.mp -= actualCost;
    gameState.player.manaBurnStacks++;

    const p = gameState.player;
    let hitCount = 0;
    const aoeRange = C.aoeBaseRadius + (p.passiveEffects.psychicFlare ? 1 : 0);

    gameState.enemies.forEach((enemy, index) => {
        const dist = Math.sqrt(Math.pow(enemy.x - p.x, 2) + Math.pow(enemy.y - p.y, 2));
        if (dist <= aoeRange) {
            hitCount++;
            // Baseline ATK in AOE mode: equipment + overcharge + affinity + withering only.
            let damage = getBaseAttackPower({ aoe: true });

            // AOE multiplier
            damage = Math.floor(damage * C.aoeMultiplier);

            // Arcane Ward — takes reduced damage from AOE
            if (enemy.isArcaneWard) {
                damage = Math.floor(damage * C.arcaneWardAoeReduction);
            }

            // Lacerating Blows — auto crit + bleed on AOE too
            if (hasMedallion("laceratingBlows")) {
                const critChance = p.crit + (p.passiveEffects.crit || 0);
                damage *= (Math.random() * 100 < critChance) ? 3 : 2;
                enemy.bleedDuration = CONFIG.combat.bleedDuration;
                enemy.bleedDmg = Math.floor(enemy.maxHp * CONFIG.combat.bleedFraction);
            }

            // AOE now respects Ironclad / Shatterpoint / Soulrend (parity with melee).
            // didCrit:false → AOE can't trigger Assassin's Creed (intentional; AC is a melee-crit identity).
            damage = Math.max(1, damage - getEffectiveEnemyDef(enemy, { didCrit: false }));
            enemy.hp -= damage;
            if (enemy.hp <= 0) {
                p.xp += Math.floor(enemy.xp * (1 + getPrestigeLevel('experienced') * 0.10));
                gameState.stats.kills++;
                if (enemy.isRareBoss) gameState.stats.rareBossKills++;
                else if (enemy.isBoss) gameState.stats.bossKills++;

                // Drop loot from special attack kills too
                const isBossKill = enemy.isBoss || enemy.isRareBoss;
                const isEliteKill = enemy.isElite;
                const lootRolls = isBossKill ? 2 : isEliteKill ? 1 : 1;
                const minRarity = enemy.isRareBoss ? RARITIES.RARE : isEliteKill ? RARITIES.RARE : null;
                for (let d = 0; d < lootRolls; d++) {
                    if (Math.random() > 0.3 || isBossKill || isEliteKill) {
                        const loot = generateLoot(isBossKill || isEliteKill, true, minRarity);
                        if (loot.type === "potion") {
                            addPotions(1);
                        } else {
                            p.inventory.push(loot);
                            gameState.stats.itemsCollected++;
                            if (loot.rarity === RARITIES.ASCENDED) gameState.stats.ascendedItems++;
                            else if (loot.rarity === RARITIES.MYTHIC) gameState.stats.mythicItems++;
                            else if (loot.rarity === RARITIES.LEGENDARY) gameState.stats.legendaryItems++;
                            addLog(`Found ${loot.rarity.name.toUpperCase()} ${loot.name}!`, "log-loot");
                        }
                    }
                }
                updateInventoryDisplay();
            }
        }
    });

    // Sweep dead enemies (replaces splice-in-forEach that skipped iterations)
    gameState.enemies = gameState.enemies.filter(e => e.hp > 0);

    p.kineticStacks = 0; // Reset kinetic stacks on attack
    // Convergence — increment stacks when not moving (max 5)
    if (hasFloorModifier("convergence") && p.convergenceStacks < 5) {
        p.convergenceStacks++;
        if (p.convergenceStacks >= 3) {
            addLog(`⚠ Convergence x${p.convergenceStacks} — enemies deal +${p.convergenceStacks * 15}% damage!`, "log-damage");
        }
    }
    updateBuffsPanel();
    addLog(`Special attack hit ${hitCount} enemies!`, "log-damage");

    if (gameState.player.xp >= gameState.player.xpToNext) {
        levelUp();
    }

    // Death's Countdown — decrement on special attack turn
    if (hasDebuff("deathsCountdown") && gameState.deathsCountdownTurns > 0) {
        gameState.deathsCountdownTurns--;
        updateFloorModifiersDisplay();
        if (gameState.deathsCountdownTurns <= 0) {
            gameState.player.hp = 0;
            addLog("DEATH'S COUNTDOWN reached zero! You perish!", "log-damage");
            gameOver();
            return;
        }
        if (gameState.deathsCountdownTurns <= 10) {
            addLog(`⏱ Death's Countdown: ${gameState.deathsCountdownTurns} turns remaining!`, "log-damage");
        }
    }

    updateBars();
}

function addPotions(amount) {
    gameState.player.potions = Math.min(CONFIG.items.maxPotions, gameState.player.potions + amount);
}

function usePotion() {
    if (gameState.player.potions <= 0) {
        addLog("No potions left!", "log-loot");
        return;
    }

    // Chemist — chance to not consume potion
    let consumed = true;
    if (gameState.player.passiveEffects.chemist) {
        if (Math.random() * 100 < gameState.player.passiveEffects.chemist) {
            consumed = false;
            addLog("Chemist proc! Potion not consumed!", "log-level");
        }
    }
    if (consumed) gameState.player.potions--;

    // Prestige: Potion Mastery — potions heal more
    const potionMasteryMult = 1 + (getPrestigeLevel('potionMastery') * 0.10);
    let hpHeal = Math.floor(50 * potionMasteryMult);
    let mpHeal = Math.floor(25 * potionMasteryMult);
    // Fatigue — potions heal 25% less per stack
    const fatigueStacks = countDebuff("fatigue");
    if (fatigueStacks > 0) {
        const fatigueMult = Math.pow(0.75, fatigueStacks);
        hpHeal = Math.floor(hpHeal * fatigueMult);
        mpHeal = Math.floor(mpHeal * fatigueMult);
    }
    // Cursed Blood — all healing reduced by 40% per stack
    const cursedBloodPotionStacks = countDebuff("cursedBlood");
    if (cursedBloodPotionStacks > 0) {
        const cbMult = Math.pow(0.6, cursedBloodPotionStacks);
        hpHeal = Math.floor(hpHeal * cbMult);
        mpHeal = Math.floor(mpHeal * cbMult);
    }
    gameState.player.hp = Math.min(gameState.player.maxHp, gameState.player.hp + hpHeal);
    gameState.player.mp = Math.min(gameState.player.maxMp, gameState.player.mp + mpHeal);
    addLog(`Used potion! Restored ${hpHeal} HP & ${mpHeal} MP`, "log-loot");
    updateBars();
    updateInventoryDisplay();
}

// Level up
function levelUp() {
    const p = gameState.player;
    p.level++;
    p.xp -= p.xpToNext;
    p.xpToNext = Math.floor(p.xpToNext * 1.5);

    p.maxHp += 10;
    p.maxMp += 5;
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    addPotions(2);

    gameState.pendingStatPoints = 5 + (prestigeData && prestigeData.echoes.delver ? 1 : 0);
    gameState.tempAllocations = {
        maxHp: 0,
        maxMp: 0,
        atk: 0,
        def: 0,
        spd: 0,
        crit: 0
        // luck removed — never offered as a level-up stat row
    };

    addLog("LEVEL UP! Choose your stats!", "log-level");
    createParticles(p.x, p.y, "#2ecc71", 30);
    showLevelUpScreen();
}

function showLevelUpScreen() {
    const overlay = document.getElementById('levelup-overlay');
    const optionsDiv = document.getElementById('stat-alloc-options');
    const remainingSpan = document.getElementById('stat-points-remaining');
    const confirmBtn = document.getElementById('levelup-confirm-btn');

    overlay.classList.add('active');
    gameState.overlayOpen = true;
    optionsDiv.innerHTML = "";

    function updateBtnStates() {
        remainingSpan.textContent = gameState.pendingStatPoints;
        confirmBtn.disabled = gameState.pendingStatPoints > 0;
    }

    function createRow(statKey, label, cost) {
        cost = cost || 1;
        const row = document.createElement('div');
        row.className = "stat-alloc-row";
        const spanLabel = document.createElement('span');
        spanLabel.textContent = label + (cost > 1 ? ` (${cost} pts)` : "");

        const minusBtn = document.createElement('button');
        minusBtn.className = "stat-alloc-btn";
        minusBtn.textContent = "−";
        minusBtn.onclick = () => {
            if (gameState.tempAllocations[statKey] <= 0) return;
            gameState.tempAllocations[statKey]--;
            gameState.pendingStatPoints += cost;
            spanValue.textContent = gameState.tempAllocations[statKey];
            updateBtnStates();
        };

        const spanValue = document.createElement('span');
        spanValue.textContent = gameState.tempAllocations[statKey];
        spanValue.style.minWidth = "20px";
        spanValue.style.textAlign = "center";

        const plusBtn = document.createElement('button');
        plusBtn.className = "stat-alloc-btn";
        plusBtn.textContent = "+";
        plusBtn.onclick = () => {
            if (gameState.pendingStatPoints < cost) return;
            gameState.tempAllocations[statKey]++;
            gameState.pendingStatPoints -= cost;
            spanValue.textContent = gameState.tempAllocations[statKey];
            updateBtnStates();
        };

        row.appendChild(spanLabel);
        row.appendChild(minusBtn);
        row.appendChild(spanValue);
        row.appendChild(plusBtn);
        optionsDiv.appendChild(row);
    }

    createRow("maxHp", "Max HP");
    createRow("maxMp", "Max MP");
    createRow("atk", "ATK");
    createRow("def", "DEF");
    createRow("spd", "SPD");
    createRow("crit", "Crit");

    remainingSpan.textContent = gameState.pendingStatPoints;
    confirmBtn.disabled = gameState.pendingStatPoints > 0;

    // REPEAT LAST button — only show if there's a snapshot from a previous level-up this run.
    const repeatBtn = document.getElementById('levelup-repeat-btn');
    if (repeatBtn) {
        repeatBtn.style.display = gameState.lastLevelUpAlloc ? 'inline-block' : 'none';
    }
}

// Re-apply the previous level-up's stat allocation in one click.
// Caps at total available points (handles edge case where Echo: Delver changed
// between level-ups, though it shouldn't mid-run). Player still clicks CONFIRM.
function repeatLastAllocation() {
    const last = gameState.lastLevelUpAlloc;
    if (!last) return;
    const t = gameState.tempAllocations;
    const alreadyAllocated = t.maxHp + t.maxMp + t.atk + t.def + t.spd + t.crit;
    // Total points available = currently-pending + already-allocated this session.
    const total = gameState.pendingStatPoints + alreadyAllocated;
    let remaining = total;
    // Luck isn't an allocatable stat in level-up (removed from the row list);
    // skipped here even though older snapshots may carry a `luck` key.
    const order = ['maxHp', 'maxMp', 'atk', 'def', 'spd', 'crit'];
    const newAlloc = { maxHp: 0, maxMp: 0, atk: 0, def: 0, spd: 0, crit: 0 };
    order.forEach(k => {
        const want = last[k] || 0;
        const give = Math.min(want, remaining);
        newAlloc[k] = give;
        remaining -= give;
    });
    // If the user had manually allocated something, log the overwrite so it
    // doesn't feel like their click vanished into the void.
    if (alreadyAllocated > 0) {
        addLog("REPEAT LAST replaced your manual allocation.", "log-level");
    }
    gameState.tempAllocations = newAlloc;
    gameState.pendingStatPoints = remaining;
    // Rebuild the rows so the visible values reflect the new allocation.
    showLevelUpScreen();
}
window.repeatLastAllocation = repeatLastAllocation;
window.defend = defend;

function confirmLevelUp() {
    const p = gameState.player;
    const t = gameState.tempAllocations;

    const atkMult = 1 + (getPrestigeLevel('warriorsGrowth') * 0.05);
    const defMult = 1 + (getPrestigeLevel('survivorsInstinct') * 0.05);
    p.maxHp += t.maxHp * 5;
    p.maxMp += t.maxMp * 3;
    p.atk += Math.floor(t.atk * 2 * atkMult);
    p.def += Math.floor(t.def * 2 * defMult);
    p.spd += t.spd;
    p.crit += t.crit * 2;

    p.hp = p.maxHp;
    p.mp = p.maxMp;

    // Snapshot for REPEAT LAST button. Skip an all-zeros allocation (which would
    // happen if the player got forced through with no points — defensive).
    const allocTotal = t.maxHp + t.maxMp + t.atk + t.def + t.spd + t.crit;
    if (allocTotal > 0) {
        gameState.lastLevelUpAlloc = { ...t };
    }

    gameState.pendingStatPoints = 0;
    gameState.tempAllocations = {
        maxHp: 0,
        maxMp: 0,
        atk: 0,
        def: 0,
        spd: 0,
        crit: 0
        // luck removed — never offered as a level-up stat row
    };

    document.getElementById('levelup-overlay').classList.remove('active');
    gameState.overlayOpen = false;
    updateStats();
    updateInventoryDisplay();

    // Show affinity allocation screen every other level (even levels)
    if (gameState.player.level % 2 === 0) {
        showAffinityScreen();
    }
}

function showAffinityScreen() {
    const overlay = document.getElementById('affinity-overlay');
    const optionsDiv = document.getElementById('affinity-alloc-options');
    const remainingSpan = document.getElementById('affinity-points-remaining');
    const confirmBtn = document.getElementById('affinity-confirm-btn');

    gameState.pendingAffinityPoints = gameState.pendingAffinityPoints > 0 ? gameState.pendingAffinityPoints : 1;
    gameState.tempAffinityAlloc = { ATK: 0, DEF: 0, SPD: 0, CRIT: 0, LUCK: 0 };

    overlay.classList.add('active');
    gameState.overlayOpen = true;
    optionsDiv.innerHTML = "";

    const affinityInfo = {
        ATK: { label: "ATK", desc: "Berserker, Executioner, Overwhelm, Redundant Force", color: "#ff6b6b" },
        DEF: { label: "DEF", desc: "Fortified, Regeneration, Bulwark, Iron Roots, Last Stand, Guardian Shell, Iron Will", color: "#4ecdc4" },
        SPD: { label: "SPD", desc: "Swift, Evasion, Momentum, Adrenaline, Phantom Step, Fleetfoot Strikes", color: "#ffd93d" },
        CRIT: { label: "CRIT", desc: "Critical, Deadeye, Precision, Weakpoint Specialist, Shatterpoint, Assassin", color: "#ff8800" },
        LUCK: { label: "LUCK", desc: "Lucky, Chemist, Scrapper, Lucky Ascension, Fortunate Strikes", color: "#2ecc71" }
    };

    function updateBtnStates() {
        remainingSpan.textContent = gameState.pendingAffinityPoints;
        confirmBtn.disabled = gameState.pendingAffinityPoints > 0;
    }

    Object.keys(affinityInfo).forEach(key => {
        const info = affinityInfo[key];
        const row = document.createElement('div');
        row.className = "stat-alloc-row";
        row.style.flexWrap = "wrap";

        const spanLabel = document.createElement('span');
        spanLabel.innerHTML = `<span style="color:${info.color}">${info.label}</span> <span style="color:#888; font-size:0.7em;">(Lv ${gameState.player.affinities[key]})</span>`;
        spanLabel.style.minWidth = "120px";

        const minusBtn = document.createElement('button');
        minusBtn.className = "stat-alloc-btn";
        minusBtn.textContent = "−";
        minusBtn.onclick = () => {
            if (gameState.tempAffinityAlloc[key] <= 0) return;
            gameState.tempAffinityAlloc[key]--;
            gameState.pendingAffinityPoints++;
            spanValue.textContent = gameState.tempAffinityAlloc[key];
            updateBtnStates();
        };

        const spanValue = document.createElement('span');
        spanValue.textContent = gameState.tempAffinityAlloc[key];
        spanValue.style.minWidth = "20px";
        spanValue.style.textAlign = "center";

        const plusBtn = document.createElement('button');
        plusBtn.className = "stat-alloc-btn";
        plusBtn.textContent = "+";
        plusBtn.onclick = () => {
            if (gameState.pendingAffinityPoints <= 0) return;
            gameState.tempAffinityAlloc[key]++;
            gameState.pendingAffinityPoints--;
            spanValue.textContent = gameState.tempAffinityAlloc[key];
            updateBtnStates();
        };

        row.appendChild(spanLabel);
        row.appendChild(minusBtn);
        row.appendChild(spanValue);
        row.appendChild(plusBtn);

        // Description below
        const descRow = document.createElement('div');
        descRow.style.cssText = "width: 100%; font-size: 0.65em; color: #777; margin-top: 2px; padding-left: 4px;";
        descRow.textContent = info.desc;
        row.appendChild(descRow);

        // Affinity milestone hints
        const currentLv = gameState.player.affinities[key] + (gameState.tempAffinityAlloc[key] || 0);
        const milestones = AFFINITY_MILESTONES[key];
        [5, 10].forEach(threshold => {
            const milestone = milestones[threshold];
            if (!milestone) return;
            const msRow = document.createElement('div');
            msRow.style.cssText = "width: 100%; font-size: 0.55em; margin-top: 1px; padding-left: 8px;";
            if (currentLv >= threshold) {
                msRow.style.color = info.color;
                msRow.innerHTML = `★ Lv ${threshold}: ${milestone.desc} <span style="color:#4ecdc4;">✓ ACTIVE</span>`;
            } else {
                const needed = threshold - currentLv;
                msRow.style.color = "#555";
                msRow.innerHTML = `☆ Lv ${threshold}: ${milestone.desc} <span style="color:#888;">(need +${needed})</span>`;
            }
            row.appendChild(msRow);
        });

        // Dual passive hints — show what's available or close for this affinity
        const relevantDuals = DUAL_PASSIVES.filter(dp => dp.affinities.includes(key));
        const p = gameState.player;
        relevantDuals.forEach(dp => {
            const otherAff = dp.affinities[0] === key ? dp.affinities[1] : dp.affinities[0];
            const thisLv = p.affinities[key] + (gameState.tempAffinityAlloc[key] || 0);
            const otherLv = p.affinities[otherAff];
            const alreadyActive = p.dualPassives.some(d => d.stat === dp.stat);
            const maxDualSlots = 2 + (getPrestigeLevel('thirdEye') >= 1 ? 1 : 0);
            const atMax = p.dualPassives.length >= maxDualSlots && !alreadyActive;

            if (alreadyActive) return; // Don't show already-active ones

            const thisNeeds = Math.max(0, dp.threshold - thisLv);
            const otherNeeds = Math.max(0, dp.threshold - otherLv);
            if (thisNeeds <= 2 || otherNeeds === 0) { // Show if close to unlocking
                const dualRow = document.createElement('div');
                dualRow.style.cssText = "width: 100%; font-size: 0.55em; color: #ff00ff; margin-top: 1px; padding-left: 8px; opacity: 0.8;";
                let status = (thisNeeds === 0 && otherNeeds === 0) ? "✓ READY"
                    : `Need ${thisNeeds > 0 ? key + ' +' + thisNeeds : ''} ${otherNeeds > 0 ? otherAff + ' +' + otherNeeds : ''}`;
                if (atMax && thisNeeds === 0 && otherNeeds === 0) status = "✓ READY (swap)";
                dualRow.innerHTML = `↳ <span style="color:#ff00ff">${dp.name}</span> (${key}+${otherAff}) — ${status.trim()}`;
                row.appendChild(dualRow);
            }
        });

        optionsDiv.appendChild(row);
    });

    remainingSpan.textContent = gameState.pendingAffinityPoints;
    confirmBtn.disabled = gameState.pendingAffinityPoints > 0;
}

function confirmAffinityAlloc() {
    const p = gameState.player;
    const t = gameState.tempAffinityAlloc;

    Object.keys(t).forEach(key => {
        p.affinities[key] += t[key];
    });

    gameState.pendingAffinityPoints = 0;
    gameState.tempAffinityAlloc = { ATK: 0, DEF: 0, SPD: 0, CRIT: 0, LUCK: 0 };

    document.getElementById('affinity-overlay').classList.remove('active');
    gameState.overlayOpen = false;
    addLog(`Affinity upgraded! ATK:${p.affinities.ATK} DEF:${p.affinities.DEF} SPD:${p.affinities.SPD} CRIT:${p.affinities.CRIT} LUCK:${p.affinities.LUCK}`, "log-level");
    checkDualPassives();
    updateBuffsPanel();
}

// Sacrifice Altar
function showSacrificeScreen() {
    const overlay = document.getElementById('sacrifice-overlay');
    overlay.style.display = "flex";
    gameState.overlayOpen = true;
    const list = document.getElementById('sacrifice-item-list');
    list.innerHTML = "";

    const p = gameState.player;
    const slots = ["weapon", "helmet", "chest", "legs", "gloves", "boots", "cape", "relic", "weapon2", "cape2", "relic2"];

    let hasItems = false;
    slots.forEach(slot => {
        const item = p.equipped[slot];
        if (!item) return;
        hasItems = true;

        const div = document.createElement('div');
        div.style.cssText = "padding: 8px; margin: 4px 0; background: rgba(0,0,0,0.5); border: 1px solid " + item.rarity.color + "; border-radius: 4px; cursor: pointer; transition: background 0.2s;";
        div.onmouseover = () => div.style.background = "rgba(136, 0, 170, 0.3)";
        div.onmouseout = () => div.style.background = "rgba(0,0,0,0.5)";

        let passiveText = "";
        if (item.passives && item.passives.length > 0) {
            passiveText = item.passives.map(p => `${p.name}: ${p.value}`).join(", ");
        }

        div.innerHTML = `
            <div style="color:${item.rarity.color}; font-size: 0.7em; font-weight: bold;">${item.name} [${item.rarity.name}]</div>
            <div style="font-size: 0.5em; color: #aaa;">ATK: ${item.atk || 0} | DEF: ${item.def || 0}</div>
            <div style="font-size: 0.5em; color: #cc88ff;">${passiveText || "No passives"}</div>
        `;
        div.onclick = () => sacrificeItem(slot);
        list.appendChild(div);
    });

    if (!hasItems) {
        list.innerHTML = '<div style="font-size: 0.6em; color: #aaa; text-align: center; padding: 20px;">No equipped items to sacrifice</div>';
    }
}

function sacrificeItem(slot) {
    const p = gameState.player;
    const item = p.equipped[slot];
    if (!item) return;

    // Calculate stat gains: 1-5% of each buff value as permanent stats
    const gains = {};
    const statMapping = {
        berserker: "atk", executioner: "atk", overwhelm: "atk", redundantForce: "atk", overcharge: "atk",
        fortify: "def", regen: "def", bulwark: "def", lastStand: "def", guardianShell: "def", ironWill: "def", ironheart: "def", tenacity: "def", ironRoots: "def",
        speed: "spd", evasion: "spd", momentum: "spd", adrenaline: "spd", phantomStep: "spd", fleetfootStrikes: "spd", battleTempo: "spd", adrenalineSurge: "spd",
        crit: "crit", deadeye: "crit", precision: "crit", weakpointSpecialist: "crit", shatterpoint: "crit", assassin: "crit", lethalFocus: "crit",
        luck: "luck", chemist: "luck", scrapper: "luck", luckyAscension: "luck", fortunateStrikes: "luck",
        lifesteal: "maxHp", arcane: "maxMp",
        soulrend: "atk", undying: "maxHp", speedster: "spd", kineticReserve: "atk",
        goldblood: "luck", siphon: "maxMp", psychicFlare: "maxMp", doomAura: "atk"
    };

    if (item.passives) {
        item.passives.forEach(passive => {
            const pct = (1 + Math.random() * 4) / 100; // 1-5%
            const gain = Math.max(1, Math.floor(passive.value * pct));
            const targetStat = statMapping[passive.stat] || "atk";
            if (!gains[targetStat]) gains[targetStat] = 0;
            gains[targetStat] += gain;
        });
    }

    // Also absorb a fraction of item ATK/DEF
    if (item.atk) gains.atk = (gains.atk || 0) + Math.max(1, Math.floor(item.atk * 0.02));
    if (item.def) gains.def = (gains.def || 0) + Math.max(1, Math.floor(item.def * 0.02));

    // Apply gains
    const gainMessages = [];
    Object.entries(gains).forEach(([stat, val]) => {
        p[stat] = (p[stat] || 0) + val;
        const displayNames = { atk: "ATK", def: "DEF", spd: "SPD", crit: "CRIT", luck: "LUCK", maxHp: "Max HP", maxMp: "Max MP" };
        gainMessages.push(`+${val} ${displayNames[stat] || stat}`);
    });

    // Destroy the item — remove from both equipped slot and inventory
    p.equipped[slot] = null;
    p.inventory = p.inventory.filter(i => i !== item);
    gameState.altarUsed = true;

    addLog(`Sacrificed ${item.name}! Item destroyed. Gained: ${gainMessages.join(", ")}`, "log-level");
    createParticles(gameState.sacrificeAltar.x, gameState.sacrificeAltar.y, "#cc44ff", 30);

    applyPassiveEffects();
    updateStats();
    updateInventoryDisplay();
    closeSacrificeScreen();
}

function closeSacrificeScreen() {
    document.getElementById('sacrifice-overlay').style.display = "none";
    gameState.overlayOpen = false;
}

// Enemy turn with Evasion & Sprint Guard
function enemyTurn() {
    const p = gameState.player;
    let playerWasHit = false;

    // Chaos Engine mastery (DEF+CRIT+LUCK) — random stat +10% each turn
    if (hasMastery("chaosEngine")) {
        const stats = ["atk", "def", "spd", "crit", "luck"];
        const chosen = stats[Math.floor(Math.random() * stats.length)];
        const bonus = Math.max(1, Math.floor(p[chosen] * 0.10));
        p[chosen] += bonus;
        // Track so we can undo next turn
        if (p.chaosEngineLastStat) {
            p[p.chaosEngineLastStat] -= p.chaosEngineLastBonus;
        }
        p.chaosEngineLastStat = chosen;
        p.chaosEngineLastBonus = bonus;
    }

    function processEnemyAttack(enemy) {
        let incoming = enemy.atk;

        // Convergence — enemies gain +15% ATK per stack (from standing still)
        if (hasFloorModifier("convergence") && p.convergenceStacks > 0) {
            incoming = Math.floor(incoming * (1 + p.convergenceStacks * 0.15));
        }

        // Mirage mastery (SPD+CRIT+LUCK) — 15% chance attacks phase through
        if (hasMastery("mirage")) {
            if (Math.random() < 0.15) {
                addLog("Mirage! Attack phased through you!", "log-level");
                p.mirageCharged = true;
                return 0;
            }
        }

        // Evasion
        if (p.passiveEffects.evasion) {
            const totalSpd = p.spd + (p.passiveEffects.speed || 0);
            const dodgeChance = (totalSpd * p.passiveEffects.evasion) / 100;
            if (Math.random() * 100 < dodgeChance) {
                addLog("You DODGED the attack!", "log-damage");
                // Evasive Bulwark (DEF+SPD dual) — gain shield on dodge
                if (hasDualPassive("evasiveBulwark")) {
                    const shieldAmount = Math.floor(p.maxHp * 0.15); // 15% max HP
                    p.evasiveBulwarkShield = (p.evasiveBulwarkShield || 0) + shieldAmount;
                    p.evasiveBulwarkTurns = 3;
                    addLog(`Evasive Bulwark! +${shieldAmount} shield from dodge!`, "log-level");
                    updateBuffsPanel();
                }
                // Lucky Star mastery (DEF+SPD+LUCK) — 30% chance to spawn potion on dodge
                if (hasMastery("luckyStar") && Math.random() < 0.30) {
                    addPotions(1);
                    addLog("Lucky Star! Dodge spawns a potion!", "log-loot");
                }
                return 0;
            }
        }

        // Calculate effective DEF (shared with forecastDamage)
        let effectivePlayerDef = getEffectivePlayerDef();

        // Chaos Engine mastery (DEF+CRIT+LUCK) — block check (DEF > incoming)
        const chaosBlocked = hasMastery("chaosEngine") && effectivePlayerDef >= incoming;

        incoming = Math.max(0, incoming - effectivePlayerDef);

        // Providence mastery (DEF+LUCK) — 20% chance incoming damage is halved
        if (incoming > 0 && hasMastery("providence")) {
            if (Math.random() < 0.20) {
                incoming = Math.floor(incoming / 2);
                addLog("Providence! Damage halved!", "log-level");
            }
        }

        // Living Fortress mastery (DEF+SPD) — attacks dealing <10% max HP deal 0
        if (incoming > 0 && hasMastery("livingFortress") && incoming < p.maxHp * 0.10) {
            incoming = 0;
            p.livingFortressSpdTurns = 2;
            addLog("Living Fortress! Trivial damage negated! +2 SPD!", "log-level");
        }

        // Guardian Shell — stacking damage reduction
        if (incoming > 0 && p.passiveEffects.guardianShell && p.guardianShellStacks > 0) {
            const reduction = p.guardianShellStacks * p.passiveEffects.guardianShell;
            incoming = Math.floor(incoming * (1 - reduction / 100));
            incoming = Math.max(0, incoming);
        }

        // Ironheart — flat damage reduction based on base DEF from level-ups
        // Each point of base DEF grants ironheart% damage reduction, capped at 50%
        if (incoming > 0 && p.passiveEffects.ironheart) {
            const ironheartReduction = Math.min(50, p.def * p.passiveEffects.ironheart / 100);
            incoming = Math.floor(incoming * (1 - ironheartReduction / 100));
            incoming = Math.max(0, incoming);
        }

        // Tenacity shield — absorb damage before HP
        if (incoming > 0 && p.tenacityShield > 0) {
            const absorbed = Math.min(incoming, p.tenacityShield);
            p.tenacityShield -= absorbed;
            incoming -= absorbed;
            if (absorbed > 0) addLog(`Tenacity shield absorbed ${absorbed} damage! (${p.tenacityShield} remaining)`, "log-level");
        }

        // Evasive Bulwark (DEF+SPD dual) shield — absorb damage before HP
        if (incoming > 0 && p.evasiveBulwarkShield > 0) {
            const absorbed = Math.min(incoming, p.evasiveBulwarkShield);
            p.evasiveBulwarkShield -= absorbed;
            incoming -= absorbed;
            if (absorbed > 0) addLog(`Evasive Bulwark shield absorbed ${absorbed} damage! (${p.evasiveBulwarkShield} remaining)`, "log-level");
        }

        // Thorned Armor (DEF+CRIT dual) — reflect damage back to attacker
        if (incoming > 0 && hasDualPassive("thornedArmor")) {
            let reflectDmg = Math.floor(incoming * 0.20); // 20% reflect
            // Reflected damage can crit
            const critChance = p.crit + (p.passiveEffects.crit || 0);
            if (Math.random() * 100 < critChance) {
                reflectDmg = Math.floor(reflectDmg * 2);
                addLog(`Thorned Armor CRIT reflect: ${reflectDmg} damage!`, "log-damage");
            } else if (reflectDmg > 0) {
                addLog(`Thorned Armor reflects ${reflectDmg} damage!`, "log-damage");
            }
            if (reflectDmg > 0) {
                enemy.hp -= reflectDmg;
                createParticles(enemy.x, enemy.y, "#4ecdc4", 8);
            }
        }

        // Iron Retaliation mastery (DEF+CRIT) — counterattack for 100% DEF, can crit
        if (hasMastery("ironRetaliation")) {
            let counterDmg = effectivePlayerDef;
            const critChance = p.crit + (p.passiveEffects.crit || 0);
            if (Math.random() * 100 < critChance) {
                counterDmg = Math.floor(counterDmg * 2);
                addLog(`Iron Retaliation CRIT counter: ${counterDmg}!`, "log-boss");
            } else {
                addLog(`Iron Retaliation counter: ${counterDmg}!`, "log-damage");
            }
            enemy.hp -= counterDmg;
        }

        // Chaos Engine mastery (DEF+CRIT+LUCK) — block counterattack + stun
        if (chaosBlocked && hasMastery("chaosEngine")) {
            const counterDmg = Math.floor(effectivePlayerDef * 0.5);
            enemy.hp -= counterDmg;
            enemy.bastionStunned = 1;
            addLog(`Chaos Engine block! Counter ${counterDmg} + stun!`, "log-boss");
        }

        if (incoming > 0) {
            // Unyielding Force (ATK+DEF dual) — stack damage taken for next attack bonus
            if (hasDualPassive("unyieldingForce") && p.unyieldingForceStacks < 3) {
                p.unyieldingForceStacks++;
            }

            p.hp -= incoming;
            playerWasHit = true;
            addLog(`You took ${incoming} damage!`, "log-damage");

            // Guardian Shell — gain stacks on taking damage
            if (p.passiveEffects.guardianShell && p.guardianShellStacks < 5) {
                p.guardianShellStacks++;
            }

            // Vampiric Horde — enemy heals 10% of damage dealt per stack
            const vampStacks = countEnemyModifier(enemy, "vampiricHorde");
            if (vampStacks > 0) {
                const healAmt = Math.floor(incoming * 0.1 * vampStacks);
                enemy.hp = Math.min(enemy.maxHp, enemy.hp + healAmt);
            }

            // Undying — survive lethal hit once
            if (p.hp <= 0 && p.passiveEffects.undying && !p.undyingUsed) {
                p.hp = 1;
                p.undyingUsed = true;
                addLog("UNDYING triggers! You survive with 1 HP!", "log-level");
                createParticles(p.x, p.y, "#00ffcc", 30);
            // Fortune's Guard (DEF+LUCK dual) — chance to survive lethal at 1 HP + free potion
            } else if (p.hp <= 0 && hasDualPassive("fortunesGuard") && !p.fortunesGuardUsed) {
                const fgChance = 15; // 15% chance
                if (Math.random() * 100 < fgChance) {
                    p.hp = 1;
                    p.fortunesGuardUsed = true;
                    addPotions(1);
                    addLog("Fortune's Guard! Survived lethal damage at 1 HP + free potion!", "log-boss");
                    createParticles(p.x, p.y, "#2ecc71", 30);
                } else if (p.hp <= 0) {
                    p.hp = 0;
                }
            // Lucky Star mastery (DEF+SPD+LUCK) — lethal teleport (once per floor)
            } else if (p.hp <= 0 && hasMastery("luckyStar") && !p.luckyStarUsed) {
                p.hp = 1;
                p.luckyStarUsed = true;
                // Teleport to random safe tile
                let safeTries = 0;
                let sx, sy;
                do {
                    sx = Math.floor(Math.random() * GRIDSIZE);
                    sy = Math.floor(Math.random() * GRIDSIZE);
                    safeTries++;
                } while (safeTries < 100 && gameState.enemies.some(e => Math.abs(e.x - sx) + Math.abs(e.y - sy) <= 2));
                p.x = sx;
                p.y = sy;
                addLog("Lucky Star! Teleported to safety at 1 HP!", "log-boss");
            } else if (p.hp <= 0) {
                p.hp = 0;
            }
        }
        return incoming;
    }

    // Decrement transient visual timers each turn (arrowFlash, healFlash).
    gameState.enemies.forEach(enemy => {
        if (enemy.arrowFlash > 0) enemy.arrowFlash--;
        if (enemy.healFlash > 0) enemy.healFlash--;
    });

    // Helper bag passed to each kind's AI.
    const aiHelpers = {
        attack: function(enemy) {
            if (enemy.bastionStunned && enemy.bastionStunned > 0) {
                enemy.bastionStunned--;
                addLog("Enemy is stunned!", "log-level");
                return;
            }
            processEnemyAttack(enemy);
            // Frenzied — enemies attack twice
            if (hasEnemyModifier(enemy, "frenzied") && p.hp > 0) {
                processEnemyAttack(enemy);
            }
        }
    };

    gameState.enemies.forEach(enemy => {
        // Bastion-stunned enemies skip their entire turn (no movement either).
        if (enemy.bastionStunned && enemy.bastionStunned > 0) {
            enemy.bastionStunned--;
            addLog("Enemy is stunned!", "log-level");
            return;
        }
        const kind = ENEMY_KINDS[enemy.kind] || ENEMY_KINDS.grunt;
        kind.ai(enemy, p, aiHelpers);
    });

    if (playerWasHit) {
        p.turnsSinceHit = 0;
        p.recentMoves = 0;
        // Battle Tempo — reset on taking damage
        if (p.passiveEffects.battleTempo) {
            p.battleTempoMoves = 0;
            p.battleTempoCharged = false;
        }
    } else {
        p.turnsSinceHit = (p.turnsSinceHit || 0) + 1;
    }

    // Bleed tick — Lacerating Blows medallion
    gameState.enemies.forEach(enemy => {
        if (enemy.bleedDuration && enemy.bleedDuration > 0) {
            enemy.hp -= enemy.bleedDmg;
            enemy.bleedDuration--;
            addLog(`Bleed deals ${enemy.bleedDmg} to ${enemy.isRareBoss ? "RARE BOSS" : enemy.isBoss ? "BOSS" : "enemy"}!`, "log-damage");
            createParticles(enemy.x, enemy.y, "#cc0000", 5);
        }
    });
    // Clean up bleed kills
    gameState.enemies = gameState.enemies.filter(e => {
        if (e.hp <= 0) {
            p.xp += Math.floor(e.xp * (1 + getPrestigeLevel('experienced') * 0.10));
            gameState.stats.kills++;
            createParticles(e.x, e.y, "#cc0000", 10);
            addLog("Bleed killed an enemy!", "log-boss");
            return false;
        }
        return true;
    });

    // Shatterpoint — tick down duration on enemies
    gameState.enemies.forEach(enemy => {
        if (enemy.shatterpointDuration && enemy.shatterpointDuration > 0) {
            enemy.shatterpointDuration--;
        }
    });

    // Doom Aura — damage nearby enemies each turn, scales with floor
    if (p.passiveEffects.doomAura) {
        gameState.enemies.forEach(enemy => {
            const dist = Math.abs(enemy.x - p.x) + Math.abs(enemy.y - p.y);
            if (dist <= 2) {
                const floorScale = 1 + gameState.floor * 0.15;
                const auraDmg = Math.floor(p.passiveEffects.doomAura * floorScale);
                enemy.hp -= auraDmg;
                if (enemy.hp <= 0) {
                    // Don't fully handle death here — just mark for cleanup
                }
            }
        });
        // Clean up dead enemies from doom aura
        gameState.enemies = gameState.enemies.filter(e => {
            if (e.hp <= 0) {
                p.xp += Math.floor(e.xp * (1 + getPrestigeLevel('experienced') * 0.10));
                gameState.stats.kills++;
                createParticles(e.x, e.y, "#8800aa", 10);
                addLog("Doom Aura destroyed an enemy!", "log-boss");
                return false;
            }
            return true;
        });
    }

    updateBars();

    if (gameState.player.hp <= 0) {
        gameOver();
    }
}

// Deterministic baseline attack power.
// Shared by updateStats() (display), attack() (per-hit), specialAttack() (AOE).
// Excludes context-specific modifiers (crit, berserker adjacency, executioner low-HP,
// overwhelm first-hit, AOE x1.5, ArcaneWard x0.25) — callers add those on top.
//
// opts.aoe=true preserves the historical AOE damage formula, which only applies
// equipment + overcharge + affinity + withering (no stat-scaling passives,
// warMachine, warlord, momentum, speedster). Kept for balance compatibility.
function getBaseAttackPower(opts) {
    opts = opts || {};
    const p = gameState.player;
    let baseAtk = p.atk;
    if (p.passiveEffects.overcharge) {
        baseAtk = Math.floor(baseAtk * p.passiveEffects.overcharge / 100);
    }
    let damage = baseAtk;
    Object.values(p.equipped).forEach(item => {
        if (item) damage += item.atk || 0;
    });
    const atkAffinityBonus = getAffinityBonus("baseDamage");
    if (atkAffinityBonus > 0) {
        damage = Math.floor(damage * (1 + atkAffinityBonus));
    }
    if (!opts.aoe) {
        const momLevel = getPrestigeLevel('momentumBuilder');
        if (momLevel > 0) {
            const momFloors = Math.min(gameState.floor - 1, 10);
            damage = Math.floor(damage * (1 + momFloors * momLevel * 0.05));
        }
        if (p.passiveEffects.redundantForce) damage += Math.floor(baseAtk * p.passiveEffects.redundantForce / 100);
        if (p.passiveEffects.ironWill)        damage += Math.floor(p.def * p.passiveEffects.ironWill / 100);
        if (p.passiveEffects.fleetfootStrikes) damage += Math.floor(p.spd * p.passiveEffects.fleetfootStrikes / 100);
        if (p.passiveEffects.assassin)        damage += Math.floor(p.crit * p.passiveEffects.assassin / 100);
        if (p.passiveEffects.fortunateStrikes) damage += Math.floor(p.luck * p.passiveEffects.fortunateStrikes / 100);
        if (p.passiveEffects.speedster) {
            const totalSpd = p.spd + (p.passiveEffects.speed || 0);
            damage += Math.floor(totalSpd * 0.5);
        }
        if (hasMastery("warMachine")) {
            let totalDef = p.def;
            Object.values(p.equipped).forEach(item => { if (item) totalDef += item.def || 0; });
            damage += Math.floor(totalDef * 0.25);
        }
        if (hasMastery("warlord") && p.passiveEffects.warlordAtkBonus) {
            damage += p.passiveEffects.warlordAtkBonus;
        }
    }
    const witheringStacks = countDebuff("withering");
    if (witheringStacks > 0) {
        damage = Math.floor(damage * Math.pow(0.9, witheringStacks));
    }
    return damage;
}

// Deterministic effective player DEF — used by both processEnemyAttack and forecastDamage.
// Excludes RNG-based effects (Providence, Mirage, Evasion, etc.).
function getEffectivePlayerDef() {
    const p = gameState.player;
    let def = p.def;
    Object.values(p.equipped).forEach(item => {
        if (item) def += item.def || 0;
    });
    const defAffinityBonus = getAffinityBonus("baseDef");
    if (defAffinityBonus > 0) {
        def = Math.floor(def * (1 + defAffinityBonus));
    }
    if (p.passiveEffects.fortify) {
        def = Math.floor(def * (1 + p.passiveEffects.fortify / 100));
    }
    if (p.passiveEffects.lastStand && p.hp < p.maxHp * 0.25) {
        def = Math.floor(def * (1 + p.passiveEffects.lastStand / 100));
    }
    const corrosionStacks = countDebuff("corrosion");
    if (corrosionStacks > 0) {
        def = Math.floor(def * Math.pow(0.85, corrosionStacks));
    }
    if (hasMastery("warlord") && p.passiveEffects.warlordDefBonus) {
        def += p.passiveEffects.warlordDefBonus;
    }
    // Bulwark — stationary stacks grant DEF in addition to damage (CONFIG.combat).
    // Damage portion is applied in attack().
    if (p.passiveEffects.bulwark && p.bulwarkStacks > 0) {
        def = Math.floor(def * (1 + p.bulwarkStacks * CONFIG.combat.bulwarkDefPerStack));
    }
    // Iron Roots — gentler stationary DEF bonus (stacks alongside Bulwark).
    if (p.passiveEffects.ironRoots && p.ironRootsStacks > 0) {
        def = Math.floor(def * (1 + p.ironRootsStacks * CONFIG.combat.ironRootsDefPerStack));
    }
    // Wait/Defend — active +50% DEF for the upcoming enemy turn only.
    if (p.defendingTurns > 0) {
        def = Math.floor(def * CONFIG.combat.defendDefMult);
    }
    return def;
}

// Deterministic effective enemy DEF for a player attack.
// Shared by attack() and specialAttack() — previously specialAttack used raw enemy.def
// and silently undersold against Ironclad/Shatterpoint/Soulrend.
// opts.didCrit enables Assassin's Creed (ATK+CRIT+LUCK mastery) DEF bypass.
function getEffectiveEnemyDef(enemy, opts) {
    opts = opts || {};
    const p = gameState.player;
    let def = enemy.def;
    const ironcladStacks = countEnemyModifier(enemy, "ironclad");
    if (ironcladStacks > 0) {
        def = Math.floor(def * Math.pow(1.5, ironcladStacks));
    }
    if (enemy.shatterpointDuration && enemy.shatterpointDuration > 0) {
        def = Math.floor(def * (1 - enemy.shatterpointReduction / 100));
    }
    if (p.passiveEffects.soulrend) {
        def = Math.floor(def * (1 - p.passiveEffects.soulrend / 100));
    }
    if (opts.didCrit && hasMastery("assassinsCreed")) {
        def = 0;
    }
    return def;
}

// Forecast incoming damage for next turn
function forecastDamage() {
    const p = gameState.player;
    let totalIncoming = 0;
    let threatCount = 0;
    let closingCount = 0;
    const effDef = getEffectivePlayerDef();
    const totalShield = (p.tenacityShield || 0) + (p.evasiveBulwarkShield || 0);

    gameState.enemies.forEach(enemy => {
        const dist = Math.abs(enemy.x - p.x) + Math.abs(enemy.y - p.y);
        if (dist <= 1) {
            // Adjacent — will attack next turn
            let raw = enemy.atk;
            if (hasFloorModifier("convergence") && p.convergenceStacks > 0) {
                raw = Math.floor(raw * (1 + p.convergenceStacks * 0.15));
            }
            raw = Math.max(0, raw - effDef);
            // Ironheart flat reduction (deterministic)
            if (raw > 0 && p.passiveEffects.ironheart) {
                const ironheartReduction = Math.min(50, p.def * p.passiveEffects.ironheart / 100);
                raw = Math.floor(raw * (1 - ironheartReduction / 100));
            }
            // Guardian Shell stacking reduction (deterministic)
            if (raw > 0 && p.passiveEffects.guardianShell && p.guardianShellStacks > 0) {
                const reduction = p.guardianShellStacks * p.passiveEffects.guardianShell;
                raw = Math.max(0, Math.floor(raw * (1 - reduction / 100)));
            }
            totalIncoming += raw;
            threatCount++;
        } else if (dist <= 2) {
            // Closing in — will be adjacent next turn
            closingCount++;
        }
    });

    // Subtract shields from forecast (they absorb damage before HP)
    const incomingAfterShields = Math.max(0, totalIncoming - totalShield);

    if (threatCount > 0) {
        const warnColor = incomingAfterShields >= p.hp ? "log-damage" : "log-loot";
        const deathWarn = incomingAfterShields >= p.hp ? " ⚠ LETHAL!" : "";
        const shieldNote = totalShield > 0 ? ` (shield: ${totalShield})` : "";
        addLog(`⚔ ${threatCount} enemy${threatCount > 1 ? "ies" : ""} adjacent! ~${incomingAfterShields} incoming damage${shieldNote} (HP: ${p.hp})${deathWarn}`, warnColor);
    }
    if (closingCount > 0) {
        addLog(`→ ${closingCount} enemy${closingCount > 1 ? "ies" : ""} closing in next turn`, "log-boss");
    }
}

// Game over
function gameOver() {
    gameState.gameRunning = false;
    document.body.classList.remove('in-game'); // hide mobile touch overlay
    MusicEngine.stop();
    document.getElementById('game-screen').style.display = "none";
    const over = document.getElementById('game-over-screen');
    over.style.display = "block";

    document.getElementById('final-floor').textContent = gameState.floor;
    document.getElementById('final-level').textContent = gameState.player.level;
    document.getElementById('final-kills').textContent = gameState.stats.kills;
    document.getElementById('final-bosses').textContent = gameState.stats.bossKills;
    document.getElementById('final-items').textContent = gameState.stats.itemsCollected;
    document.getElementById('final-rare-bosses').textContent = gameState.stats.rareBossKills;
    document.getElementById('final-legendary').textContent = gameState.stats.legendaryItems;
    document.getElementById('final-mythic').textContent = gameState.stats.mythicItems;
    document.getElementById('final-ascended').textContent = gameState.stats.ascendedItems;

    const bestItemContainer = document.getElementById('best-item-container');
    bestItemContainer.innerHTML = "";
    let best = null;
    gameState.player.inventory.forEach(item => {
        if (item.type === "potion") return;
        if (!best) best = item;
        else if (item.rarity.statMult > best.rarity.statMult) best = item;
    });
    if (best) {
        const div = document.createElement('div');
        div.className = "best-item-display";
        div.innerHTML = `
            <div class="best-item-title">BEST ITEM</div>
            <div style="color:${best.rarity.color}; font-size:0.9em;">${best.name} [${best.rarity.name}]</div>
        `;
        bestItemContainer.appendChild(div);
    }

    // Prestige system — calculate fragments and update lifetime stats
    const earnedFragments = calculateFragments();
    prestigeData.fragments += earnedFragments;
    prestigeData.totalFragmentsEarned += earnedFragments;
    prestigeData.totalRuns++;

    // Update lifetime stats
    const ls = prestigeData.lifetimeStats;
    ls.totalKills += gameState.stats.kills;
    ls.totalBossKills += gameState.stats.bossKills;
    ls.totalRareBossKills += gameState.stats.rareBossKills;
    ls.totalItemsCollected += gameState.stats.itemsCollected;
    ls.totalLegendaryItems += gameState.stats.legendaryItems;
    ls.totalMythicItems += gameState.stats.mythicItems;
    ls.totalAscendedItems += gameState.stats.ascendedItems;
    if (gameState.floor > ls.highestFloor) ls.highestFloor = gameState.floor;
    if (gameState.player.level > ls.highestLevel) ls.highestLevel = gameState.player.level;
    if (earnedFragments > ls.bestRunFragments) ls.bestRunFragments = earnedFragments;

    // Per-class telemetry — runsByClass counted on startGame; record floors
    // CLEARED on death (using floorsCleared, not gameState.floor, so warp portals
    // don't inflate Trickster/LUCK classes by 10/30 per warp).
    const cls = gameState.selectedClass;
    if (cls && ls.floorsByClass && cls in ls.floorsByClass) {
        ls.floorsByClass[cls] += (gameState.floorsCleared || 0);
        if (gameState.floor > (ls.highestFloorByClass[cls] || 0)) {
            ls.highestFloorByClass[cls] = gameState.floor;
        }
    }

    // Update best run
    if (gameState.floor > prestigeData.bestRun.floor) {
        prestigeData.bestRun = {
            floor: gameState.floor,
            level: gameState.player.level,
            kills: gameState.stats.kills,
            fragments: earnedFragments
        };
    }

    // Check echo milestones
    const newEchoes = checkEchoMilestones();
    const echoContainer = document.getElementById('new-echoes-container');
    echoContainer.innerHTML = "";
    if (newEchoes.length > 0) {
        newEchoes.forEach(name => {
            const div = document.createElement('div');
            div.style.cssText = "color: #ff00ff; font-size: 0.7em; margin: 5px 0; text-shadow: 0 0 10px #ff00ff;";
            div.textContent = "NEW! " + name + " unlocked!";
            echoContainer.appendChild(div);
        });
    }

    savePrestige();

    // Display fragment tally
    document.getElementById('fragments-earned').textContent = earnedFragments;
    document.getElementById('total-fragments').textContent = prestigeData.fragments;
    document.getElementById('total-runs').textContent = prestigeData.totalRuns;
    document.getElementById('best-floor-ever').textContent = ls.highestFloor;
}

// Start / retry
function applyPrestigeBonuses() {
    if (!prestigeData) return;
    const p = gameState.player;
    const u = prestigeData.upgrades;

    // Iron Foundation — starting stat bonuses
    p.maxHp += u.hardenedBody * 10;
    p.hp = p.maxHp;
    p.atk += u.sharpenedEdge * 2;
    p.def += u.thickSkin * 2;
    p.spd += u.quickFeet * 1;
    p.potions += u.potionSatchel * 1;
    p.maxMp += u.manaWell * 10;
    p.mp = p.maxMp;

    // Fortune's Favor — starting stat bonuses
    p.luck += u.luckyStars * 3;
    p.crit += u.keenEye * 1;

    // Arcane Secrets — Head Start (higher starting floor)
    if (u.headStart > 0) {
        gameState.floor = 1 + u.headStart;
    }

    // Echo bonuses — Tier 1
    if (prestigeData.echoes.endurance) p.maxHp += 5;
    if (prestigeData.echoes.slayer) p.atk += 2;
    if (prestigeData.echoes.bossHunter) p.def += 1;
    if (prestigeData.echoes.collector) p.luck += 3;
    // Echo bonuses — Tier 2
    if (prestigeData.echoes.veteran) p.spd += 1;
    if (prestigeData.echoes.hoarder) p.potions += 2;
    // Echo bonuses — Tier 3
    if (prestigeData.echoes.deepDiver) { p.atk += 3; p.def += 3; }
    if (prestigeData.echoes.massacre) p.crit += 2;
    if (prestigeData.echoes.mythicHunter) p.luck += 5;
    if (prestigeData.echoes.persistent) { p.maxHp += 10; p.maxMp += 5; }
    // Echo bonuses — Tier 4
    if (prestigeData.echoes.abyssWalker) { p.atk += 5; p.spd += 2; }
    if (prestigeData.echoes.warlord) { p.crit += 3; p.def += 3; }
    if (prestigeData.echoes.relicMaster) { p.atk += 5; p.def += 5; p.spd += 5; p.crit += 5; p.luck += 5; }
    if (prestigeData.echoes.grinder) { p.atk += 2; p.def += 2; p.spd += 2; p.crit += 2; p.luck += 2; }
    // Echo bonuses — Tier 5
    if (prestigeData.echoes.voidConqueror) { p.atk += 8; p.crit += 5; }
    if (prestigeData.echoes.legendSlayer) { p.atk += 5; p.def += 5; p.spd += 5; p.crit += 5; p.luck += 5; }
    if (prestigeData.echoes.trueCollector) p.luck += 10;
    if (prestigeData.echoes.undying) { p.maxHp += 20; p.def += 3; }

    // Apply all HP/MP after bonuses
    p.hp = p.maxHp;
    p.mp = p.maxMp;
}

// Class select flow — START GAME now goes here first.
function showClassScreen() {
    document.getElementById('title-screen').style.display = "none";
    const screen = document.getElementById('class-screen');
    screen.style.display = "block";
    const cards = document.getElementById('class-cards');
    cards.innerHTML = '';
    Object.values(CLASSES).forEach(cls => {
        const card = document.createElement('div');
        card.className = 'class-card';
        card.style.borderColor = cls.color;
        const affLines = Object.entries(cls.startingAffinity)
            .filter(([k, v]) => v > 0)
            .map(([k, v]) => `+${v} ${k}`)
            .join(', ');
        const passiveLines = cls.starterItem.passives.map(p =>
            `<div class="kit-line passive">• ${p.name} ${p.value}</div>`
        ).join('');
        const statLine = (cls.starterItem.atk > 0 ? `+${cls.starterItem.atk} ATK` : '')
            + (cls.starterItem.atk > 0 && cls.starterItem.def > 0 ? ', ' : '')
            + (cls.starterItem.def > 0 ? `+${cls.starterItem.def} DEF` : '');
        card.innerHTML =
            `<h3 style="color: ${cls.color}">${cls.name.toUpperCase()}</h3>` +
            `<div class="tagline">"${cls.tagline}"</div>` +
            `<div class="desc">${cls.desc}</div>` +
            `<div class="kit-label">STARTING AFFINITY</div>` +
            `<div class="kit-line affinity">${affLines}</div>` +
            `<div class="kit-label">STARTER ITEM</div>` +
            `<div class="kit-line item">${cls.starterItem.name} (${statLine})</div>` +
            passiveLines;
        card.onclick = () => selectClass(cls.id);
        cards.appendChild(card);
    });
}

function hideClassScreen() {
    document.getElementById('class-screen').style.display = "none";
    document.getElementById('title-screen').style.display = "block";
}

function selectClass(classId) {
    gameState.selectedClass = classId;
    document.getElementById('class-screen').style.display = "none";
    startGame();
}

function startGame() {
    document.getElementById('title-screen').style.display = "none";
    document.getElementById('class-screen').style.display = "none";
    document.getElementById('prestige-shop-screen').style.display = "none";
    document.getElementById('game-screen').style.display = "block";
    gameState.gameRunning = true;
    document.body.classList.add('in-game'); // gates mobile touch controls + drawer visibility

    // Apply prestige bonuses before anything else
    applyPrestigeBonuses();

    // Apply class kit: starting Affinity + starter item.
    // Default to Brawler if no class was selected (e.g. legacy entry points).
    const cls = CLASSES[gameState.selectedClass] || CLASSES.brawler;
    // Telemetry — record class pick.
    if (prestigeData && prestigeData.lifetimeStats.runsByClass && cls.id in prestigeData.lifetimeStats.runsByClass) {
        prestigeData.lifetimeStats.runsByClass[cls.id]++;
    }
    Object.entries(cls.startingAffinity).forEach(([stat, val]) => {
        gameState.player.affinities[stat] = (gameState.player.affinities[stat] || 0) + val;
    });
    if (cls.starterItem) {
        // Build a real inventory item from the class definition.
        const item = {
            name: cls.starterItem.name,
            type: cls.starterItem.type,
            rarity: RARITIES.COMMON,
            atk: cls.starterItem.atk || 0,
            def: cls.starterItem.def || 0,
            passives: (cls.starterItem.passives || []).map(p => ({ ...p }))
        };
        gameState.player.inventory.push(item);
        // Auto-equip the starter into its slot if empty.
        if (!gameState.player.equipped[item.type]) {
            gameState.player.equipped[item.type] = item;
        }
    }

    // Always start with a random weapon (Brawler already has one — they get two)
    const starterWeapon = generateLoot(false);
    starterWeapon.type = "weapon";
    starterWeapon.name = WEAPONNAMES[Math.floor(Math.random() * WEAPONNAMES.length)];
    // Weapon Cache — guarantee better starter rarity
    const wc = getPrestigeLevel('weaponCache');
    if (wc >= 2) starterWeapon.rarity = RARITIES.RARE;
    else if (wc >= 1) starterWeapon.rarity = RARITIES.UNCOMMON;
    starterWeapon.atk = Math.floor((5 + gameState.floor * 2) * starterWeapon.rarity.statMult);
    starterWeapon.def = 0;
    gameState.player.inventory.push(starterWeapon);
    updateInventoryDisplay();
    generateFloor();
    applyPassiveEffects();
    updateStats();
    gameLoop();

    // Start background music
    if (!MusicEngine.audioCtx) {
        MusicEngine.init();
    }
    MusicEngine.start();

    // Affinity Initiate — free affinity point at game start
    if (getPrestigeLevel('affinityInitiate') >= 1) {
        gameState.pendingAffinityPoints = gameState.pendingAffinityPoints > 0 ? gameState.pendingAffinityPoints : 1;
        showAffinityScreen();
    }
}

function retryGame() {
    location.reload();
}

// Instructions
function showInstructions() {
    document.getElementById('title-screen').style.display = "none";
    document.getElementById('instructions-screen').style.display = "block";
}

function backToTitleFromInstructions() {
    document.getElementById('instructions-screen').style.display = "none";
    document.getElementById('title-screen').style.display = "block";
}

function backToTitle() {
    location.reload();
}

// ═══════════════════════════════════════════════════════
// PRESTIGE SHOP SCREEN
// ═══════════════════════════════════════════════════════

let currentPrestigeCategory = "iron";

function showPrestigeShop() {
    document.getElementById('title-screen').style.display = "none";
    document.getElementById('game-over-screen').style.display = "none";
    document.getElementById('prestige-shop-screen').style.display = "block";
    renderPrestigeShop();
}

function backToTitleFromPrestige() {
    location.reload();
}

function renderPrestigeShop() {
    // Update fragment counter
    document.getElementById('shop-fragments').textContent = prestigeData.fragments;
    document.getElementById('shop-total-earned').textContent = prestigeData.totalFragmentsEarned;
    document.getElementById('shop-total-runs').textContent = prestigeData.totalRuns;

    // Update category tabs
    const tabsContainer = document.getElementById('prestige-tabs');
    tabsContainer.innerHTML = "";
    PRESTIGE_CATEGORIES.forEach(cat => {
        const btn = document.createElement('button');
        btn.textContent = cat.name;
        btn.style.cssText = `font-family: 'Press Start 2P', cursive; font-size: 0.45em; padding: 8px 12px; margin: 3px; border: 2px solid ${cat.color}; background: ${currentPrestigeCategory === cat.key ? cat.color : 'transparent'}; color: ${currentPrestigeCategory === cat.key ? '#000' : cat.color}; cursor: pointer;`;
        btn.onclick = () => { currentPrestigeCategory = cat.key; renderPrestigeShop(); };
        tabsContainer.appendChild(btn);
    });

    // Render upgrades for current category
    const upgradesContainer = document.getElementById('prestige-upgrades');
    upgradesContainer.innerHTML = "";

    for (const [key, upgrade] of Object.entries(PRESTIGE_UPGRADES)) {
        if (upgrade.category !== currentPrestigeCategory) continue;
        const currentTier = getPrestigeLevel(key);
        const isMaxed = currentTier >= upgrade.maxTier;
        const nextCost = isMaxed ? null : upgrade.costs[currentTier];
        const canAfford = !isMaxed && prestigeData.fragments >= nextCost;

        const row = document.createElement('div');
        row.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 10px; margin: 5px 0; background: rgba(0,0,0,0.4); border-left: 3px solid " + (isMaxed ? "#2ecc71" : PRESTIGE_CATEGORIES.find(c => c.key === upgrade.category).color) + ";";

        // Tier pips
        let pips = "";
        for (let i = 0; i < upgrade.maxTier; i++) {
            pips += i < currentTier
                ? '<span style="color: #2ecc71;">&#9679;</span>'
                : '<span style="color: #444;">&#9679;</span>';
        }

        row.innerHTML = `
            <div style="flex: 1;">
                <div style="font-size: 0.55em; color: ${isMaxed ? '#2ecc71' : '#f0f4f8'}; margin-bottom: 4px;">${upgrade.name} <span style="font-size: 0.8em;">${pips}</span></div>
                <div style="font-size: 0.4em; color: #888;">${upgrade.desc}</div>
            </div>
            <div style="text-align: right; min-width: 120px;">
                ${isMaxed
                    ? '<span style="font-size: 0.5em; color: #2ecc71;">MAXED</span>'
                    : `<button onclick="purchaseUpgrade('${key}')" style="font-family: 'Press Start 2P', cursive; font-size: 0.4em; padding: 6px 10px; border: 2px solid ${canAfford ? '#ffd93d' : '#444'}; background: ${canAfford ? 'rgba(255,217,61,0.2)' : 'rgba(0,0,0,0.3)'}; color: ${canAfford ? '#ffd93d' : '#666'}; cursor: ${canAfford ? 'pointer' : 'not-allowed'};">${nextCost} Fragments</button>`
                }
            </div>
        `;
        upgradesContainer.appendChild(row);
    }

    // Render echoes section
    renderEchoes();

    // Render best run
    renderBestRun();
}

function renderEchoes() {
    const container = document.getElementById('prestige-echoes');
    container.innerHTML = '<div style="font-size: 0.6em; color: #cc66ff; margin-bottom: 10px; border-bottom: 1px solid #cc66ff; padding-bottom: 5px;">ECHOES (Milestone Rewards)</div>';
    for (const [key, echo] of Object.entries(PRESTIGE_ECHOES)) {
        const unlocked = prestigeData.echoes[key];
        const div = document.createElement('div');
        div.style.cssText = `font-size: 0.4em; padding: 6px; margin: 3px 0; background: rgba(0,0,0,0.3); border-left: 3px solid ${unlocked ? '#2ecc71' : '#444'}; opacity: ${unlocked ? '1' : '0.6'};`;
        div.innerHTML = `
            <span style="color: ${unlocked ? '#2ecc71' : '#888'};">${unlocked ? '&#10003;' : '&#9679;'} ${echo.name}</span>
            <span style="color: #666; margin-left: 10px;">${echo.condition}</span>
            <br><span style="color: ${unlocked ? '#4ecdc4' : '#555'}; font-size: 0.9em;">${echo.desc}</span>
        `;
        container.appendChild(div);
    }
}

function renderBestRun() {
    const container = document.getElementById('prestige-best-run');
    const br = prestigeData.bestRun;
    const ls = prestigeData.lifetimeStats;
    container.innerHTML = `
        <div style="font-size: 0.6em; color: var(--accent-gold); margin-bottom: 10px; border-bottom: 1px solid var(--accent-gold); padding-bottom: 5px;">BEST RUN</div>
        <div style="font-size: 0.4em; color: #aaa;">
            <div style="margin: 4px 0;">Floor: <span style="color: #f0f4f8;">${br.floor}</span> | Level: <span style="color: #f0f4f8;">${br.level}</span> | Kills: <span style="color: #f0f4f8;">${br.kills}</span> | Fragments: <span style="color: var(--accent-gold);">${br.fragments}</span></div>
        </div>
        <div style="font-size: 0.6em; color: var(--accent-secondary); margin: 15px 0 10px 0; border-bottom: 1px solid var(--accent-secondary); padding-bottom: 5px;">LIFETIME STATS</div>
        <div style="font-size: 0.4em; color: #aaa; line-height: 1.8;">
            Total Kills: <span style="color: #f0f4f8;">${ls.totalKills}</span> |
            Boss Kills: <span style="color: #f0f4f8;">${ls.totalBossKills}</span> |
            Items Found: <span style="color: #f0f4f8;">${ls.totalItemsCollected}</span><br>
            Legendary: <span style="color: #ff8000;">${ls.totalLegendaryItems}</span> |
            Mythic: <span style="color: #ff4444;">${ls.totalMythicItems}</span> |
            Ascended: <span style="color: #00ffcc;">${ls.totalAscendedItems}</span>
        </div>
    `;

    // CLASS STATS panel — surfaces the per-class telemetry tracked in lifetimeStats.
    const classStatsEl = document.getElementById('prestige-class-stats');
    if (classStatsEl) {
        const runsByClass = ls.runsByClass || {};
        const floorsByClass = ls.floorsByClass || {};
        const highestByClass = ls.highestFloorByClass || {};
        const totalClassRuns = Object.values(runsByClass).reduce((s, v) => s + v, 0);
        let rows = '';
        Object.values(CLASSES).forEach(c => {
            const runs = runsByClass[c.id] || 0;
            const totalFloors = floorsByClass[c.id] || 0;
            const highest = highestByClass[c.id] || 0;
            const avg = runs > 0 ? (totalFloors / runs).toFixed(1) : '—';
            const pickPct = totalClassRuns > 0 ? ((runs / totalClassRuns) * 100).toFixed(0) + '%' : '—';
            rows += `
                <div style="display: flex; align-items: center; padding: 6px 8px; margin: 3px 0; background: rgba(0,0,0,0.3); border-left: 3px solid ${c.color}; font-size: 0.4em;">
                    <div style="flex: 0 0 90px; color: ${c.color}; font-family: 'Press Start 2P', cursive; font-size: 0.85em;">${c.name.toUpperCase()}</div>
                    <div style="flex: 1; color: #aaa;">
                        Runs: <span style="color: #f0f4f8;">${runs}</span>
                        <span style="color: #555;"> (${pickPct})</span>
                        &nbsp;|&nbsp; Highest: <span style="color: var(--accent-gold);">F${highest}</span>
                        &nbsp;|&nbsp; Avg: <span style="color: #f0f4f8;">F${avg}</span>
                    </div>
                </div>`;
        });
        classStatsEl.innerHTML = `
            <div style="font-size: 0.6em; color: #ff9eb5; margin-bottom: 10px; border-bottom: 1px solid #ff9eb5; padding-bottom: 5px;">CLASS STATS</div>
            ${rows || '<div style="font-size: 0.4em; color: #555;">Play a run to populate.</div>'}
        `;
    }
}

function purchaseUpgrade(key) {
    const upgrade = PRESTIGE_UPGRADES[key];
    if (!upgrade) return;
    const currentTier = getPrestigeLevel(key);
    if (currentTier >= upgrade.maxTier) return;
    const cost = upgrade.costs[currentTier];
    if (prestigeData.fragments < cost) return;
    prestigeData.fragments -= cost;
    prestigeData.upgrades[key] = currentTier + 1;
    savePrestige();
    renderPrestigeShop();
}

function updateTitleFragments() {
    const el = document.getElementById('title-fragments');
    if (el && prestigeData) {
        el.textContent = prestigeData.fragments > 0 ? `Fragments: ${prestigeData.fragments}` : "";
    }
}

// Main loop
function gameLoop() {
    if (!gameState.gameRunning) return;
    drawGame();
    requestAnimationFrame(gameLoop);
}

// Input with SPD-based delay
document.addEventListener('keydown', (e) => {
    // Prevent arrow keys and space from scrolling the page
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) {
        e.preventDefault();
    }

    if (!gameState.gameRunning) return;
    if (gameState.overlayOpen) return;

    const now = Date.now();
    const p = gameState.player;

    let spdBonus = p.spd + (p.passiveEffects.speed || 0);
    // Affinity milestone: SPD — bonus move range (+1 per milestone)
    spdBonus += getAffinityBonus("moveRange");
    // Adrenaline — temporary SPD boost after kills
    if (p.adrenalineTurns > 0 && p.passiveEffects.adrenaline) {
        spdBonus += Math.floor(spdBonus * p.passiveEffects.adrenaline / 100);
    }
    // Living Fortress mastery — +2 SPD after negating damage
    if (hasMastery("livingFortress") && p.livingFortressSpdTurns > 0) {
        spdBonus += 2;
    }
    const minDelay = 70;
    const maxDelay = 150;
    let moveDelay = Math.max(minDelay, maxDelay - spdBonus * 10);

    // Time Dilation medallion — speed cannot be lower than 1.5x fastest enemy
    if (hasMedallion("timeDilation")) {
        moveDelay = Math.min(moveDelay, 45);
    }

    if (now - gameState.lastMoveTime < moveDelay) return;
    gameState.lastMoveTime = now;

    const key = e.key.toLowerCase();
    let moved = false;
    if (key === "w" || key === "arrowup") {
        movePlayer(0, -1);
        moved = true;
    } else if (key === "s" || key === "arrowdown") {
        movePlayer(0, 1);
        moved = true;
    } else if (key === "a" || key === "arrowleft") {
        movePlayer(-1, 0);
        moved = true;
    } else if (key === "d" || key === "arrowright") {
        movePlayer(1, 0);
        moved = true;
    } else if (key === " ") {
        e.preventDefault();
        attack();
        // Reset surge moves after attacking (new turn)
        p.adrenalineSurgeMoves = 0;
        enemyTurn();
        forecastDamage();
    } else if (key === "r") {
        specialAttack();
        p.adrenalineSurgeMoves = 0;
        enemyTurn();
        forecastDamage();
    } else if (key === "e") {
        usePotion();
    } else if (key === "f") {
        defend();
    }

    if (moved) {
        // Adrenaline Surge — free moves don't trigger enemy turn
        if (p.adrenalineSurgeMoves > 0) {
            p.adrenalineSurgeMoves--;
            addLog(`Adrenaline Surge! Free move! (${p.adrenalineSurgeMoves} remaining)`, "log-level");
            // Windfall (SPD+LUCK dual) — free moves can spawn loot
            if (hasDualPassive("windfall")) {
                const windfallChance = 20; // 20% chance
                if (Math.random() * 100 < windfallChance) {
                    if (Math.random() < 0.5) {
                        addPotions(1);
                        addLog("Windfall! A potion appeared!", "log-loot");
                        createParticles(p.x, p.y, "#2ecc71", 10);
                    } else {
                        const windfallLoot = generateLoot(false, true, null);
                        if (windfallLoot.type === "potion") {
                            addPotions(1);
                            addLog("Windfall! Found a potion!", "log-loot");
                        } else {
                            p.inventory.push(windfallLoot);
                            gameState.stats.itemsCollected++;
                            addLog(`Windfall! Found ${windfallLoot.rarity.name.toUpperCase()} ${windfallLoot.name}!`, "log-loot");
                        }
                        createParticles(p.x, p.y, "#2ecc71", 10);
                    }
                }
            }
            updateBuffsPanel();
            forecastDamage();
        } else {
            enemyTurn();
            forecastDamage();
        }
    }
});

// Expose some functions to buttons
window.startGame = startGame;
window.showClassScreen = showClassScreen;
window.hideClassScreen = hideClassScreen;
window.selectClass = selectClass;
window.showInstructions = showInstructions;
window.backToTitleFromInstructions = backToTitleFromInstructions;
window.retryGame = retryGame;
window.confirmLevelUp = confirmLevelUp;
window.showPrestigeShop = showPrestigeShop;
window.backToTitleFromPrestige = backToTitleFromPrestige;
window.backToTitle = backToTitle;
window.exportSave = exportSave;
window.importSave = importSave;
window.purchaseUpgrade = purchaseUpgrade;
window.confirmAffinityAlloc = confirmAffinityAlloc;
window.closeSacrificeScreen = closeSacrificeScreen;
window.discardItem = discardItem;
window.equipDualPassive = equipDualPassive;
window.swapDualPassive = swapDualPassive;
window.closeDualPassiveSelection = closeDualPassiveSelection;

// =============================================================================
// MOBILE / TOUCH SUPPORT
// =============================================================================
// Touch controls dispatch synthetic keydown events into the existing handler,
// so we don't have to refactor the keydown logic at all. The drawer relocates
// the four desktop side-panels into tabbed wrappers when on a small viewport.

const MOBILE_BREAKPOINT_QUERY = '(max-width: 768px)';

function isMobileViewport() {
    return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

function toggleMobileDrawer() {
    const drawer = document.getElementById('mobile-drawer');
    if (!drawer) return;
    drawer.classList.toggle('open');
}
window.toggleMobileDrawer = toggleMobileDrawer;

function switchMobileTab(name) {
    const tabs = document.querySelectorAll('#mobile-drawer-tabs button');
    tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('#mobile-drawer-content > [data-mobile-tab]').forEach(w => {
        w.style.display = (w.dataset.mobileTab === name) ? 'block' : 'none';
    });
}
window.switchMobileTab = switchMobileTab;

// Move desktop panels into the drawer under tab-specific wrappers. Called once
// on first mobile detection (or viewport change). Safe to call multiple times —
// it bails if the panels are already in the drawer.
function setupMobileDrawer() {
    const drawerContent = document.getElementById('mobile-drawer-content');
    if (!drawerContent) return;
    if (drawerContent.dataset.populated === '1') return;
    drawerContent.dataset.populated = '1';

    const tabMap = {
        stats: 'stats-panel',
        buffs: 'buffs-panel',
        inv:   'inventory-panel',
        log:   'log'
    };
    Object.entries(tabMap).forEach(([tab, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        const wrapper = document.createElement('div');
        wrapper.dataset.mobileTab = tab;
        wrapper.style.display = (tab === 'stats') ? 'block' : 'none';
        // Stash original location so resize-to-desktop can restore it.
        wrapper._originalParent = el.parentNode;
        wrapper._originalNextSibling = el.nextSibling;
        wrapper.appendChild(el);
        drawerContent.appendChild(wrapper);
    });
}

// Reverse setupMobileDrawer — used when user resizes mobile→desktop so the
// panels aren't stuck inside a closed drawer in the new layout.
function teardownMobileDrawer() {
    const drawerContent = document.getElementById('mobile-drawer-content');
    if (!drawerContent || drawerContent.dataset.populated !== '1') return;
    drawerContent.dataset.populated = '0';
    drawerContent.querySelectorAll('[data-mobile-tab]').forEach(wrapper => {
        const el = wrapper.firstChild;
        if (!el || !wrapper._originalParent) return;
        // Clear our inline display:none so original CSS takes over.
        el.style.display = '';
        if (wrapper._originalNextSibling && wrapper._originalNextSibling.parentNode === wrapper._originalParent) {
            wrapper._originalParent.insertBefore(el, wrapper._originalNextSibling);
        } else {
            wrapper._originalParent.appendChild(el);
        }
        wrapper.remove();
    });
}

// Refresh the slim stat strip above the canvas on every bar update.
// Hooks the existing updateBars() by wrapping it.
const _origUpdateBars = typeof updateBars === 'function' ? updateBars : null;
if (_origUpdateBars) {
    updateBars = function() {
        _origUpdateBars.apply(this, arguments);
        const p = gameState.player;
        const hp = document.getElementById('mobile-hp');
        const mp = document.getElementById('mobile-mp');
        const lv = document.getElementById('mobile-level');
        const po = document.getElementById('mobile-potions');
        const fl = document.getElementById('mobile-floor');
        if (hp) hp.textContent = `${p.hp}/${p.maxHp}`;
        if (mp) mp.textContent = `${p.mp}/${p.maxMp}`;
        if (lv) lv.textContent = p.level;
        if (po) po.textContent = p.potions;
        if (fl) fl.textContent = gameState.floor;
    };
}

// Wire each .touch-btn to dispatch a synthetic keydown matching data-key.
// pointerdown fires for touch, mouse, and pen — single handler covers all.
function setupTouchControls() {
    document.querySelectorAll('.touch-btn').forEach(btn => {
        if (btn.dataset.wired === '1') return;
        btn.dataset.wired = '1';
        const fire = (e) => {
            e.preventDefault();
            const key = btn.dataset.key;
            if (!key) return;
            document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        };
        btn.addEventListener('pointerdown', fire);
        // Suppress the synthetic mousedown that follows touchstart on some browsers.
        btn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    });
}

// Initialise mobile-specific UI on load and on viewport changes.
function initMobileUI() {
    if (isMobileViewport()) {
        setupMobileDrawer();
        setupTouchControls();
    } else {
        // Wire touch controls even on desktop so DevTools-mobile-simulation works
        // without a reload.
        setupTouchControls();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileUI);
} else {
    initMobileUI();
}
window.matchMedia(MOBILE_BREAKPOINT_QUERY).addEventListener('change', (e) => {
    if (e.matches) setupMobileDrawer();
    else teardownMobileDrawer();
});
