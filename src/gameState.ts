/**
 * GameStateManager - Server-authoritative game state for multiplayer
 *
 * Handles:
 * - Map generation with fixed seed (same for all players)
 * - Dig spot locations (shared state)
 * - Player positions (broadcast to all)
 * - Treasure/jackpot locations
 */

// Seeded random number generator for deterministic map generation
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

// Game configuration (must match client CONFIG)
export const GAME_CONFIG = {
  MAP_WIDTH: 100,
  MAP_HEIGHT: 100,
  TILE_SIZE: 32,
  NUM_DIG_SPOTS: 150,
  NUM_TREASURES: 20,       // Hidden jackpot locations
  DIG_COOLDOWN: 2000,
  MIN_YIELD: 1,
  MAX_YIELD: 15,
  TREASURE_MIN_YIELD: 50,
  TREASURE_MAX_YIELD: 500,
  POSITION_UPDATE_INTERVAL: 50,  // ms between position broadcasts
};

// Tile types
export enum TileType {
  WATER = 0,
  SAND = 1,
  GRASS = 2,
  TREE = 3,
}

// Player state
export interface Player {
  odId: string;           // Socket ID
  privyUserId: string;
  wallet: string | null;
  x: number;
  y: number;
  lastUpdate: number;
  lastDig: number;
  totalDug: number;
  digCount: number;
}

// Dig spot state
export interface DigSpot {
  id: number;
  x: number;
  y: number;
  depleted: boolean;
  depletedBy: string | null;  // privyUserId who depleted it
  depletedAt: number | null;
}

// Treasure (hidden jackpot)
export interface Treasure {
  id: number;
  x: number;
  y: number;
  found: boolean;
  foundBy: string | null;
  foundAt: number | null;
  yield: number;
}

// Persistent player stats (survives disconnection)
export interface PersistentPlayerStats {
  privyUserId: string;
  wallet: string | null;
  totalDug: number;
  digCount: number;
  lastX: number;
  lastY: number;
  lastSeen: number;
}

// Full game state
export interface GameState {
  seed: number;
  mapData: number[][];
  digSpots: DigSpot[];
  treasures: Treasure[];
  players: Map<string, Player>;  // keyed by socket ID
  persistentStats: Map<string, PersistentPlayerStats>;  // keyed by privyUserId - survives disconnection
  syncActive: boolean;
  syncStartTime: number | null;
  syncEndTime: number | null;
}

export class GameStateManager {
  private state: GameState;
  private rng: SeededRandom;

  constructor(seed?: number) {
    const actualSeed = seed || Date.now();
    this.rng = new SeededRandom(actualSeed);

    this.state = {
      seed: actualSeed,
      mapData: [],
      digSpots: [],
      treasures: [],
      players: new Map(),
      persistentStats: new Map(),
      syncActive: false,
      syncStartTime: null,
      syncEndTime: null,
    };

    this.generateMap();
    this.generateDigSpots();
    this.generateTreasures();

    console.log(`[GAME] GameStateManager initialized with seed: ${actualSeed}`);
    console.log(`[GAME] Map: ${GAME_CONFIG.MAP_WIDTH}x${GAME_CONFIG.MAP_HEIGHT}`);
    console.log(`[GAME] Dig spots: ${this.state.digSpots.length}`);
    console.log(`[GAME] Treasures: ${this.state.treasures.length}`);
  }

  // ============================================
  // MAP GENERATION
  // ============================================

  private generateMap(): void {
    const data: number[][] = [];
    const centerX = GAME_CONFIG.MAP_WIDTH / 2;
    const centerY = GAME_CONFIG.MAP_HEIGHT / 2;
    const maxRadius = Math.min(GAME_CONFIG.MAP_WIDTH, GAME_CONFIG.MAP_HEIGHT) / 2 - 3;

    for (let y = 0; y < GAME_CONFIG.MAP_HEIGHT; y++) {
      const row: number[] = [];
      for (let x = 0; x < GAME_CONFIG.MAP_WIDTH; x++) {
        const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
        const noise = Math.sin(x * 0.3) * Math.cos(y * 0.3) * 3;

        if (dist > maxRadius + noise) {
          row.push(TileType.WATER);
        } else if (dist > maxRadius - 2 + noise) {
          row.push(TileType.SAND);
        } else {
          row.push(this.rng.next() < 0.08 ? TileType.TREE : TileType.GRASS);
        }
      }
      data.push(row);
    }

    this.state.mapData = data;
  }

  private getGrassPositions(): { x: number; y: number }[] {
    const positions: { x: number; y: number }[] = [];
    for (let y = 0; y < GAME_CONFIG.MAP_HEIGHT; y++) {
      for (let x = 0; x < GAME_CONFIG.MAP_WIDTH; x++) {
        if (this.state.mapData[y][x] === TileType.GRASS) {
          positions.push({ x, y });
        }
      }
    }
    return positions;
  }

  private generateDigSpots(): void {
    const grassPositions = this.getGrassPositions();

    // Shuffle using seeded RNG
    for (let i = grassPositions.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [grassPositions[i], grassPositions[j]] = [grassPositions[j], grassPositions[i]];
    }

    // Take first N positions
    const spotPositions = grassPositions.slice(0, GAME_CONFIG.NUM_DIG_SPOTS);

    this.state.digSpots = spotPositions.map((pos, index) => ({
      id: index,
      x: pos.x * GAME_CONFIG.TILE_SIZE + GAME_CONFIG.TILE_SIZE / 2,
      y: pos.y * GAME_CONFIG.TILE_SIZE + GAME_CONFIG.TILE_SIZE / 2,
      depleted: false,
      depletedBy: null,
      depletedAt: null,
    }));
  }

  private generateTreasures(): void {
    const grassPositions = this.getGrassPositions();

    // Shuffle differently for treasures (use remaining positions)
    for (let i = grassPositions.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [grassPositions[i], grassPositions[j]] = [grassPositions[j], grassPositions[i]];
    }

    // Take positions after dig spots to avoid overlap
    const treasurePositions = grassPositions.slice(
      GAME_CONFIG.NUM_DIG_SPOTS,
      GAME_CONFIG.NUM_DIG_SPOTS + GAME_CONFIG.NUM_TREASURES
    );

    this.state.treasures = treasurePositions.map((pos, index) => ({
      id: index,
      x: pos.x * GAME_CONFIG.TILE_SIZE + GAME_CONFIG.TILE_SIZE / 2,
      y: pos.y * GAME_CONFIG.TILE_SIZE + GAME_CONFIG.TILE_SIZE / 2,
      found: false,
      foundBy: null,
      foundAt: null,
      yield: this.rng.nextInt(GAME_CONFIG.TREASURE_MIN_YIELD, GAME_CONFIG.TREASURE_MAX_YIELD),
    }));
  }

  // ============================================
  // PLAYER MANAGEMENT
  // ============================================

  addPlayer(socketId: string, privyUserId: string, wallet: string | null): Player {
    const centerX = Math.floor(GAME_CONFIG.MAP_WIDTH / 2) * GAME_CONFIG.TILE_SIZE;
    const centerY = Math.floor(GAME_CONFIG.MAP_HEIGHT / 2) * GAME_CONFIG.TILE_SIZE;

    // Check if player has existing stats from previous connection
    const existingStats = this.state.persistentStats.get(privyUserId);

    const player: Player = {
      odId: socketId,
      privyUserId,
      wallet,
      x: existingStats?.lastX ?? centerX,
      y: existingStats?.lastY ?? centerY,
      lastUpdate: Date.now(),
      lastDig: 0,
      totalDug: existingStats?.totalDug ?? 0,
      digCount: existingStats?.digCount ?? 0,
    };

    this.state.players.set(socketId, player);

    // Update or create persistent stats
    this.state.persistentStats.set(privyUserId, {
      privyUserId,
      wallet,
      totalDug: player.totalDug,
      digCount: player.digCount,
      lastX: player.x,
      lastY: player.y,
      lastSeen: Date.now(),
    });

    if (existingStats) {
      console.log(`[GAME] Player reconnected: ${wallet || privyUserId} - restored score: ${existingStats.totalDug} (${this.state.players.size} players)`);
    } else {
      console.log(`[GAME] Player joined: ${wallet || privyUserId} (${this.state.players.size} players)`);
    }

    return player;
  }

  removePlayer(socketId: string): Player | undefined {
    const player = this.state.players.get(socketId);
    if (player) {
      // Save stats before removing - these persist for reconnection
      this.state.persistentStats.set(player.privyUserId, {
        privyUserId: player.privyUserId,
        wallet: player.wallet,
        totalDug: player.totalDug,
        digCount: player.digCount,
        lastX: player.x,
        lastY: player.y,
        lastSeen: Date.now(),
      });

      this.state.players.delete(socketId);
      console.log(`[GAME] Player left: ${player.wallet || player.privyUserId} - saved score: ${player.totalDug} (${this.state.players.size} players)`);
    }
    return player;
  }

  updatePlayerPosition(socketId: string, x: number, y: number): boolean {
    const player = this.state.players.get(socketId);
    if (!player) return false;

    player.x = x;
    player.y = y;
    player.lastUpdate = Date.now();
    return true;
  }

  getPlayer(socketId: string): Player | undefined {
    return this.state.players.get(socketId);
  }

  getAllPlayers(): Player[] {
    return Array.from(this.state.players.values());
  }

  getOtherPlayers(excludeSocketId: string): Player[] {
    return Array.from(this.state.players.values()).filter(p => p.odId !== excludeSocketId);
  }

  // Update persistent stats for a player (called after score changes)
  private syncPersistentStats(player: Player): void {
    this.state.persistentStats.set(player.privyUserId, {
      privyUserId: player.privyUserId,
      wallet: player.wallet,
      totalDug: player.totalDug,
      digCount: player.digCount,
      lastX: player.x,
      lastY: player.y,
      lastSeen: Date.now(),
    });
  }

  // Get persistent stats for a user (even if not currently connected)
  getPersistentStats(privyUserId: string): PersistentPlayerStats | undefined {
    return this.state.persistentStats.get(privyUserId);
  }

  // ============================================
  // DIG MECHANICS
  // ============================================

  attemptDig(socketId: string, x: number, y: number): {
    success: boolean;
    yield: number;
    isTreasure: boolean;
    digSpotId?: number;
    treasureId?: number;
    cooldownRemaining?: number;
  } {
    const player = this.state.players.get(socketId);
    if (!player) {
      return { success: false, yield: 0, isTreasure: false };
    }

    // Check cooldown
    const now = Date.now();
    const cooldownRemaining = GAME_CONFIG.DIG_COOLDOWN - (now - player.lastDig);
    if (cooldownRemaining > 0) {
      return { success: false, yield: 0, isTreasure: false, cooldownRemaining };
    }

    player.lastDig = now;

    // Check if near a treasure (within 48 pixels)
    const nearbyTreasure = this.state.treasures.find(t =>
      !t.found &&
      Math.sqrt((t.x - x) ** 2 + (t.y - y) ** 2) < 48
    );

    if (nearbyTreasure) {
      nearbyTreasure.found = true;
      nearbyTreasure.foundBy = player.privyUserId;
      nearbyTreasure.foundAt = now;

      player.totalDug += nearbyTreasure.yield;
      player.digCount += 1;
      this.syncPersistentStats(player);

      console.log(`[GAME] TREASURE FOUND! ${player.wallet || player.privyUserId} found ${nearbyTreasure.yield} at treasure #${nearbyTreasure.id}`);

      return {
        success: true,
        yield: nearbyTreasure.yield,
        isTreasure: true,
        treasureId: nearbyTreasure.id,
      };
    }

    // Check if near a dig spot (within 48 pixels)
    const nearbySpot = this.state.digSpots.find(s =>
      !s.depleted &&
      Math.sqrt((s.x - x) ** 2 + (s.y - y) ** 2) < 48
    );

    if (nearbySpot) {
      nearbySpot.depleted = true;
      nearbySpot.depletedBy = player.privyUserId;
      nearbySpot.depletedAt = now;

      const yieldAmount = this.rng.nextInt(GAME_CONFIG.MIN_YIELD, GAME_CONFIG.MAX_YIELD);
      player.totalDug += yieldAmount;
      player.digCount += 1;
      this.syncPersistentStats(player);

      return {
        success: true,
        yield: yieldAmount,
        isTreasure: false,
        digSpotId: nearbySpot.id,
      };
    }

    // Digging anywhere else - small yield with rare jackpot chance
    const jackpotRoll = Math.random(); // Use true random for excitement
    let yieldAmount: number;
    let isTreasure = false;

    if (jackpotRoll < 0.02) {
      // 2% chance of mini jackpot
      yieldAmount = this.rng.nextInt(10, 30);
      isTreasure = true;
      console.log(`[GAME] RANDOM JACKPOT! ${player.wallet || player.privyUserId} found ${yieldAmount}`);
    } else {
      yieldAmount = this.rng.nextInt(1, 5);
    }

    player.totalDug += yieldAmount;
    player.digCount += 1;
    this.syncPersistentStats(player);

    return {
      success: true,
      yield: yieldAmount,
      isTreasure,
    };
  }

  // ============================================
  // SYNC MANAGEMENT
  // ============================================

  startSync(duration: number = 30 * 60 * 1000): void {
    this.state.syncActive = true;
    this.state.syncStartTime = Date.now();
    this.state.syncEndTime = Date.now() + duration;

    // Reset player stats (both current and persistent)
    for (const player of this.state.players.values()) {
      player.totalDug = 0;
      player.digCount = 0;
    }

    // Clear persistent stats for new session
    this.state.persistentStats.clear();

    // Reset dig spots
    for (const spot of this.state.digSpots) {
      spot.depleted = false;
      spot.depletedBy = null;
      spot.depletedAt = null;
    }

    // Reset treasures
    for (const treasure of this.state.treasures) {
      treasure.found = false;
      treasure.foundBy = null;
      treasure.foundAt = null;
    }

    console.log(`[GAME] SYNC started! Duration: ${duration / 1000}s`);
  }

  endSync(): void {
    this.state.syncActive = false;
    console.log(`[GAME] SYNC ended!`);
  }

  isSyncActive(): boolean {
    if (!this.state.syncActive) return false;

    // Check if sync has expired
    if (this.state.syncEndTime && Date.now() > this.state.syncEndTime) {
      this.endSync();
      return false;
    }

    return true;
  }

  // ============================================
  // STATE GETTERS
  // ============================================

  getSeed(): number {
    return this.state.seed;
  }

  getMapData(): number[][] {
    return this.state.mapData;
  }

  getDigSpots(): DigSpot[] {
    return this.state.digSpots;
  }

  getActiveDigSpots(): DigSpot[] {
    return this.state.digSpots.filter(s => !s.depleted);
  }

  getTreasures(): Treasure[] {
    return this.state.treasures;
  }

  getUndiscoveredTreasureCount(): number {
    return this.state.treasures.filter(t => !t.found).length;
  }

  getSyncStatus(): {
    active: boolean;
    startTime: number | null;
    endTime: number | null;
    remainingTime: number | null;
  } {
    return {
      active: this.state.syncActive,
      startTime: this.state.syncStartTime,
      endTime: this.state.syncEndTime,
      remainingTime: this.state.syncEndTime ? Math.max(0, this.state.syncEndTime - Date.now()) : null,
    };
  }

  // Get serializable state for sending to clients
  getClientState() {
    return {
      seed: this.state.seed,
      config: GAME_CONFIG,
      digSpots: this.state.digSpots.map(s => ({
        id: s.id,
        x: s.x,
        y: s.y,
        depleted: s.depleted,
      })),
      // Don't send treasure locations - they're hidden!
      treasuresRemaining: this.getUndiscoveredTreasureCount(),
      players: this.getAllPlayers().map(p => ({
        odId: p.odId,
        wallet: p.wallet,
        x: p.x,
        y: p.y,
        totalDug: p.totalDug,
      })),
      sync: this.getSyncStatus(),
    };
  }

  getLeaderboard(): Array<{
    privyUserId: string;
    wallet: string | null;
    totalDug: number;
    digCount: number;
  }> {
    return Array.from(this.state.players.values())
      .map(p => ({
        privyUserId: p.privyUserId,
        wallet: p.wallet,
        totalDug: p.totalDug,
        digCount: p.digCount,
      }))
      .sort((a, b) => b.totalDug - a.totalDug);
  }
}

// Singleton instance
let gameStateInstance: GameStateManager | null = null;

export function getGameState(): GameStateManager {
  if (!gameStateInstance) {
    gameStateInstance = new GameStateManager();
  }
  return gameStateInstance;
}

export function resetGameState(seed?: number): GameStateManager {
  gameStateInstance = new GameStateManager(seed);
  return gameStateInstance;
}
