import "dotenv/config";
import { createServer } from "http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { PrivyClient } from "@privy-io/node";
import { Server as SocketIOServer } from "socket.io";
import { ethers } from "ethers";
import * as jose from "jose";
import {
  getGameState,
  resetGameState,
  GAME_CONFIG,
  type Player,
} from "./gameState.js";

// ============================================
// PRODUCTION LOGGING UTILITY
// ============================================
const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG; // Set to INFO in production

function formatTimestamp(): string {
  return new Date().toISOString();
}

const log = {
  debug: (category: string, message: string, data?: any) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.DEBUG) {
      console.log(
        `[${formatTimestamp()}] [DEBUG] [${category}] ${message}`,
        data ? JSON.stringify(data, null, 2) : "",
      );
    }
  },
  info: (category: string, message: string, data?: any) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.INFO) {
      console.log(
        `[${formatTimestamp()}] [INFO] [${category}] ${message}`,
        data ? JSON.stringify(data, null, 2) : "",
      );
    }
  },
  warn: (category: string, message: string, data?: any) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.WARN) {
      console.warn(
        `[${formatTimestamp()}] [WARN] [${category}] ${message}`,
        data ? JSON.stringify(data, null, 2) : "",
      );
    }
  },
  error: (category: string, message: string, error?: any) => {
    if (CURRENT_LOG_LEVEL <= LOG_LEVELS.ERROR) {
      console.error(
        `[${formatTimestamp()}] [ERROR] [${category}] ${message}`,
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : error,
      );
    }
  },
};

// EIP-712 Domain for JBMClaim contract (deployed on Base mainnet)
const EIP712_DOMAIN = {
  name: "JungleBayMemes",
  version: "1",
  chainId: 8453, // Base mainnet
  verifyingContract:
    process.env.CLAIM_CONTRACT_ADDRESS ||
    "0x06C9bEE0909e856f98134D3Ac998B9a5Db21B94C",
};

// EIP-712 Types for Claim (matches deployed contract - no sessionId)
const CLAIM_TYPES = {
  Claim: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// Game signer wallet (for signing claims)
let gameSigner: ethers.Wallet | null = null;
if (process.env.GAME_SIGNER_PRIVATE_KEY) {
  gameSigner = new ethers.Wallet(process.env.GAME_SIGNER_PRIVATE_KEY);
  console.log(`🔑 Game signer loaded: ${gameSigner.address}`);
}

// Initialize Privy client
const PRIVY_APP_ID = process.env.PRIVY_APP_ID!;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET!;
const PRIVY_VERIFICATION_KEY = process.env.PRIVY_VERIFICATION_KEY;

const privyConfig: any = {
  appId: PRIVY_APP_ID,
  appSecret: PRIVY_APP_SECRET,
};

// Add verification key if provided (recommended for faster token verification)
if (PRIVY_VERIFICATION_KEY) {
  privyConfig.jwtVerificationKey = PRIVY_VERIFICATION_KEY;
}

const privy = new PrivyClient(privyConfig);

// Manual JWT verification function using jose library
// NOTE: The Privy SDK's verifyAccessToken() fails with "Failed to verify authentication token"
// even with valid tokens and verification key. This manual verification is a reliable fallback.
async function manualVerifyToken(token: string, verificationKey: string): Promise<any> {
  const publicKey = await jose.importSPKI(verificationKey, 'ES256');
  const { payload } = await jose.jwtVerify(token, publicKey, {
    issuer: 'privy.io',
    audience: PRIVY_APP_ID,
  });

  return {
    userId: payload.sub,
    appId: payload.aud,
    issuer: payload.iss,
  };
}

// Log Privy configuration
log.info("STARTUP", "Privy client initialized", {
  appId: PRIVY_APP_ID,
  hasVerificationKey: !!PRIVY_VERIFICATION_KEY,
});

// Types
interface Message {
  content: string;
  bungalowId: number;
  timestamp: number;
  author: string;
  privyUserId?: string;
}

interface AuthUser {
  privyUserId: string;
  wallet: string | null;
}

// Extend Hono context to include authenticated user
type AuthenticatedContext = import("hono").Context & {
  get: (key: "user") => AuthUser;
  set: (key: "user", value: AuthUser) => void;
};

const app = new Hono();

// Token Pool Configuration
const TOKEN_POOL = {
  total: parseInt(process.env.TOKEN_POOL_TOTAL || "100000000", 10),
  symbol: process.env.TOKEN_SYMBOL || "JBM",
  distributed: 0,
  distributions: new Map<string, number>(),
};

// Session tracking for claims
interface SessionClaim {
  sessionId: string;
  startTime: number;
  endTime: number;
  distributions: Map<
    string,
    { wallet: string; tokens: number; claimed: boolean }
  >;
}

const sessions: Map<string, SessionClaim> = new Map();
let currentSessionId: string | null = null;

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://memetics.lat",
  "https://jbi.memetics.lat",
  "https://miniapp.anky.app",
  "https://poiesis.anky.app",
  "https://anky.app",
];

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }),
);

// State (in-memory for now)
const state = {
  connectedUsers: new Map<
    string,
    { privyUserId: string; wallet: string | null; joinedAt: number }
  >(),
  digHistory: new Map<string, { total: number; digs: number }>(),
  bungalowMessages: new Map<string, Message[]>(),
  syncActive: false,
  syncEndTime: 0,
  maxConcurrentUsers: 100,
};

// ============================================
// AUTH MIDDLEWARE (for REST API)
// ============================================

async function authMiddleware(
  c: import("hono").Context,
  next: import("hono").Next,
) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json(
      { error: "Unauthorized: Missing or invalid authorization header" },
      401,
    );
  }

  const accessToken = authHeader.replace("Bearer ", "");

  try {
    // Try different verification methods based on SDK version
    let verifiedClaims: any;

    if (typeof (privy as any).utils === 'function') {
      verifiedClaims = await (privy as any).utils().auth().verifyAccessToken({
        access_token: accessToken,
      });
    } else if (typeof (privy as any).verifyAuthToken === 'function') {
      verifiedClaims = await (privy as any).verifyAuthToken(accessToken);
    } else {
      throw new Error("No verification method available on Privy client");
    }

    // Try different user fetch methods
    let user: any;
    if (typeof (privy as any).users === 'function') {
      const users = (privy as any).users();
      if (typeof users._get === 'function') {
        user = await users._get(verifiedClaims.userId);
      } else if (typeof users.get === 'function') {
        user = await users.get(verifiedClaims.userId);
      } else {
        user = { id: verifiedClaims.userId };
      }
    } else if (typeof (privy as any).getUser === 'function') {
      user = await (privy as any).getUser(verifiedClaims.userId);
    } else {
      user = { id: verifiedClaims.userId };
    }

    let wallet: string | null = null;
    if (user?.wallet) {
      wallet = user.wallet.address?.toLowerCase() || null;
    } else if (user?.linked_accounts) {
      const walletAccount = user.linked_accounts.find(
        (account: any) => account.type === "wallet",
      );
      if (walletAccount && "address" in walletAccount) {
        wallet = (walletAccount as any).address.toLowerCase();
      }
    } else if (user?.linkedAccounts) {
      const walletAccount = user.linkedAccounts.find(
        (account: any) => account.type === "wallet",
      );
      if (walletAccount && "address" in walletAccount) {
        wallet = (walletAccount as any).address.toLowerCase();
      }
    }

    c.set("user", { privyUserId: verifiedClaims.userId, wallet } as AuthUser);
    await next();
  } catch (error) {
    console.error("Auth verification failed:", error);
    return c.json({ error: "Unauthorized: Invalid or expired token" }, 401);
  }
}

// ============================================
// REST API ROUTES
// ============================================

// Health check
app.get("/health", (c) => {
  const gameState = getGameState();
  const socketCount = io?.sockets?.sockets?.size || 0;

  log.debug("HEALTH", "Health check requested", {
    players: gameState.getAllPlayers().length,
    sockets: socketCount,
  });

  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    connectedPlayers: gameState.getAllPlayers().length,
    connectedSockets: socketCount,
    tokenPool: {
      total: TOKEN_POOL.total,
      distributed: TOKEN_POOL.distributed,
      remaining: TOKEN_POOL.total - TOKEN_POOL.distributed,
      symbol: TOKEN_POOL.symbol,
    },
    gameConfig: GAME_CONFIG,
    allowedOrigins: ALLOWED_ORIGINS,
  });
});

// Server config endpoint (for debugging client-server mismatch)
app.get("/api/debug/config", (c) => {
  return c.json({
    timestamp: new Date().toISOString(),
    privyAppId: PRIVY_APP_ID,
    allowedOrigins: ALLOWED_ORIGINS,
    serverPort: process.env.PORT || "3000",
    nodeEnv: process.env.NODE_ENV || "development",
  });
});

// Diagnostic endpoint for debugging
app.get("/api/debug/connections", (c) => {
  const gameState = getGameState();
  const players = gameState.getAllPlayers();
  const socketCount = io?.sockets?.sockets?.size || 0;

  const socketDetails: Array<{ id: string; connected: boolean }> = [];
  if (io?.sockets?.sockets) {
    io.sockets.sockets.forEach((socket, id) => {
      socketDetails.push({ id, connected: socket.connected });
    });
  }

  log.info("DEBUG", "Connections diagnostic requested", {
    players: players.length,
    sockets: socketCount,
  });

  return c.json({
    timestamp: new Date().toISOString(),
    playerCount: players.length,
    socketCount,
    players: players.map((p) => ({
      odId: p.odId,
      privyUserId: p.privyUserId,
      wallet: p.wallet
        ? `${p.wallet.slice(0, 6)}...${p.wallet.slice(-4)}`
        : null,
      position: { x: p.x, y: p.y },
      totalDug: p.totalDug,
      digCount: p.digCount,
    })),
    sockets: socketDetails,
  });
});

// Get SYNC status
app.get("/api/sync/status", (c) => {
  const gameState = getGameState();
  const sync = gameState.getSyncStatus();
  return c.json({
    active: sync.active,
    endTime: sync.endTime,
    remainingTime: sync.remainingTime,
    connectedPlayers: gameState.getAllPlayers().length,
    treasuresRemaining: gameState.getUndiscoveredTreasureCount(),
    tokenPool: {
      total: TOKEN_POOL.total,
      distributed: TOKEN_POOL.distributed,
      remaining: TOKEN_POOL.total - TOKEN_POOL.distributed,
      symbol: TOKEN_POOL.symbol,
    },
  });
});

// Get leaderboard
app.get("/api/leaderboard", (c) => {
  const gameState = getGameState();
  const entries = gameState.getLeaderboard().slice(0, 20);
  return c.json({ entries });
});

// Get bungalow messages
app.get("/api/bungalow/:id/messages", (c) => {
  const id = c.req.param("id");
  const messages = state.bungalowMessages.get(id) || [];
  return c.json({ messages: messages.slice(-10) });
});

// Connect user (authenticated) - for REST clients
app.post("/api/auth/connect", authMiddleware, async (c) => {
  const user = c.get("user") as AuthUser;
  return c.json({
    success: true,
    message: "Use WebSocket connection for game",
    privyUserId: user.privyUserId,
    wallet: user.wallet,
  });
});

// Record a dig (authenticated) - backup for REST clients
app.post("/api/dig", authMiddleware, async (c) => {
  const user = c.get("user") as AuthUser;
  const { amount } = await c.req.json();

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return c.json({ error: "Valid amount required" }, 400);
  }

  const history = state.digHistory.get(user.privyUserId) || {
    total: 0,
    digs: 0,
  };
  history.total += amount;
  history.digs += 1;
  state.digHistory.set(user.privyUserId, history);

  return c.json({ success: true, total: history.total, digs: history.digs });
});

// Get current user stats
app.get("/api/me", authMiddleware, async (c) => {
  const user = c.get("user") as AuthUser;
  const gameState = getGameState();
  const players = gameState.getAllPlayers();
  const player = players.find((p) => p.privyUserId === user.privyUserId);

  return c.json({
    privyUserId: user.privyUserId,
    wallet: user.wallet,
    isConnected: !!player,
    total: player?.totalDug || 0,
    digs: player?.digCount || 0,
    tokensEarned: TOKEN_POOL.distributions.get(user.privyUserId) || 0,
  });
});

// Post bungalow message
app.post("/api/bungalow/:id/messages", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user") as AuthUser;

  try {
    const { content } = await c.req.json();

    if (!content || typeof content !== "string" || content.length > 280) {
      return c.json({ error: "Invalid content" }, 400);
    }

    if (!state.bungalowMessages.has(id)) {
      state.bungalowMessages.set(id, []);
    }

    const message: Message = {
      content: content.trim(),
      bungalowId: parseInt(id),
      timestamp: Math.floor(Date.now() / 1000),
      author: user.wallet || user.privyUserId,
      privyUserId: user.privyUserId,
    };

    state.bungalowMessages.get(id)!.push(message);
    return c.json({ success: true, message });
  } catch (err) {
    return c.json({ error: "Failed to post message" }, 500);
  }
});

// Start SYNC
app.post("/api/sync/start", authMiddleware, async (c) => {
  const { duration = 30 * 60 * 1000 } = await c.req.json();
  const gameState = getGameState();
  gameState.startSync(duration);

  // Broadcast to all connected players via Socket.io
  io?.emit("sync:start", {
    endTime: Date.now() + duration,
    duration,
  });

  return c.json({ success: true, endTime: Date.now() + duration });
});

// End SYNC
app.post("/api/sync/end", authMiddleware, async (c) => {
  const gameState = getGameState();
  gameState.endSync();

  // Calculate distributions
  const leaderboard = gameState.getLeaderboard();
  const totalDug = leaderboard.reduce((sum, p) => sum + p.totalDug, 0);

  // Create new session ID for claims
  const sessionId = `session_${Date.now()}`;
  currentSessionId = sessionId;

  const sessionDistributions = new Map<
    string,
    { wallet: string; tokens: number; claimed: boolean }
  >();

  if (totalDug > 0) {
    TOKEN_POOL.distributed = 0;
    TOKEN_POOL.distributions.clear();

    for (const player of leaderboard) {
      const share = player.totalDug / totalDug;
      const tokens = Math.floor(TOKEN_POOL.total * share);
      TOKEN_POOL.distributions.set(player.privyUserId, tokens);
      TOKEN_POOL.distributed += tokens;

      // Add to session distributions for claiming
      if (player.wallet && tokens > 0) {
        sessionDistributions.set(player.privyUserId, {
          wallet: player.wallet,
          tokens,
          claimed: false,
        });
      }
    }
  }

  // Store session for claims
  const session: SessionClaim = {
    sessionId,
    startTime: Date.now() - 30 * 60 * 1000, // Approximate
    endTime: Date.now(),
    distributions: sessionDistributions,
  };
  sessions.set(sessionId, session);

  console.log(
    `[SYNC] Session ${sessionId} ended. ${sessionDistributions.size} players eligible for claims.`,
  );

  // Broadcast to all connected players
  io?.emit("sync:end", {
    sessionId,
    leaderboard: leaderboard.map((p) => ({
      ...p,
      tokensEarned: TOKEN_POOL.distributions.get(p.privyUserId) || 0,
    })),
  });

  return c.json({
    success: true,
    sessionId,
    tokenPool: {
      total: TOKEN_POOL.total,
      distributed: TOKEN_POOL.distributed,
      symbol: TOKEN_POOL.symbol,
    },
    leaderboard,
  });
});

// Get token distribution
app.get("/api/distribution", (c) => {
  const distributions = Array.from(TOKEN_POOL.distributions.entries())
    .map(([privyUserId, tokens]) => ({ privyUserId, tokensEarned: tokens }))
    .sort((a, b) => b.tokensEarned - a.tokensEarned);

  return c.json({
    tokenPool: {
      total: TOKEN_POOL.total,
      distributed: TOKEN_POOL.distributed,
      remaining: TOKEN_POOL.total - TOKEN_POOL.distributed,
      symbol: TOKEN_POOL.symbol,
    },
    distributions,
  });
});

// Get claim signature for a user
app.get("/api/claim/signature", authMiddleware, async (c) => {
  const user = c.get("user") as AuthUser;

  if (!gameSigner) {
    return c.json({ error: "Claim signing not configured" }, 503);
  }

  if (!user.wallet) {
    return c.json({ error: "No wallet connected" }, 400);
  }

  if (!currentSessionId) {
    return c.json({ error: "No session available for claiming" }, 400);
  }

  const session = sessions.get(currentSessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  const userDistribution = session.distributions.get(user.privyUserId);
  if (!userDistribution) {
    return c.json({ error: "No tokens to claim for this session" }, 400);
  }

  if (userDistribution.claimed) {
    return c.json({ error: "Already claimed signature for this session" }, 400);
  }

  try {
    // Prepare claim data (no sessionId - matches deployed contract)
    const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const amount = ethers.parseUnits(userDistribution.tokens.toString(), 18); // Assuming 18 decimals

    // Create typed data
    const domain = {
      ...EIP712_DOMAIN,
      verifyingContract:
        process.env.CLAIM_CONTRACT_ADDRESS ||
        "0x06C9bEE0909e856f98134D3Ac998B9a5Db21B94C",
    };

    const message = {
      recipient: user.wallet,
      amount: amount.toString(),
      deadline,
    };

    // Sign with EIP-712
    const signature = await gameSigner.signTypedData(
      domain,
      CLAIM_TYPES,
      message,
    );

    // Mark as signature generated (but not claimed on-chain yet)
    userDistribution.claimed = true;

    return c.json({
      success: true,
      claim: {
        recipient: user.wallet,
        amount: amount.toString(),
        amountFormatted: userDistribution.tokens,
        deadline,
        signature,
        contractAddress: domain.verifyingContract,
        chainId: domain.chainId,
      },
    });
  } catch (error) {
    console.error("Claim signature error:", error);
    return c.json({ error: "Failed to generate signature" }, 500);
  }
});

// Get user's claim status
app.get("/api/claim/status", authMiddleware, async (c) => {
  const user = c.get("user") as AuthUser;

  const result: {
    sessionId: string | null;
    canClaim: boolean;
    tokens: number;
    wallet: string | null;
    signatureClaimed: boolean;
  } = {
    sessionId: currentSessionId,
    canClaim: false,
    tokens: 0,
    wallet: user.wallet,
    signatureClaimed: false,
  };

  if (currentSessionId && user.wallet) {
    const session = sessions.get(currentSessionId);
    if (session) {
      const userDistribution = session.distributions.get(user.privyUserId);
      if (userDistribution) {
        result.canClaim = !userDistribution.claimed;
        result.tokens = userDistribution.tokens;
        result.signatureClaimed = userDistribution.claimed;
      }
    }
  }

  return c.json(result);
});

// ============================================
// SOCKET.IO SERVER
// ============================================

let io: SocketIOServer | null = null;

function setupSocketIO(httpServer: ReturnType<typeof createServer>) {
  log.info("SOCKET", "Setting up Socket.IO server", {
    allowedOrigins: ALLOWED_ORIGINS,
  });

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST"],
      credentials: true,
    },
    transports: ["websocket", "polling"],
  });

  // Track connection attempts for debugging
  let connectionAttempts = 0;
  let authFailures = 0;
  let successfulConnections = 0;

  // Authentication middleware for Socket.io
  io.use(async (socket, next) => {
    connectionAttempts++;
    const token = socket.handshake.auth.token;
    const socketId = socket.id;
    const clientIp = socket.handshake.address;
    const transport = socket.conn.transport.name;

    log.info("SOCKET_AUTH", "Connection attempt", {
      socketId,
      clientIp,
      transport,
      hasToken: !!token,
      tokenLength: token ? token.length : 0,
      attemptNumber: connectionAttempts,
    });

    if (!token) {
      authFailures++;
      log.warn("SOCKET_AUTH", "Connection rejected - no token", {
        socketId,
        clientIp,
        totalAuthFailures: authFailures,
      });
      return next(new Error("Authentication required"));
    }

    try {
      // Try different verification methods based on SDK version
      let verifiedClaims: any;

      // First, try the Privy SDK (may fail due to SDK issues)
      try {
        if (typeof (privy as any).utils === 'function') {
          const auth = (privy as any).utils().auth();
          verifiedClaims = await auth.verifyAccessToken({ access_token: token });
        } else if (typeof (privy as any).verifyAuthToken === 'function') {
          verifiedClaims = await (privy as any).verifyAuthToken(token);
        } else {
          throw new Error("No Privy SDK verification method available");
        }
        log.debug("SOCKET_AUTH", "Privy SDK verification succeeded", { socketId });
      } catch (sdkError: any) {
        // Privy SDK fails with valid tokens - use manual verification as fallback
        if (PRIVY_VERIFICATION_KEY) {
          try {
            const manualResult = await manualVerifyToken(token, PRIVY_VERIFICATION_KEY);
            verifiedClaims = {
              userId: manualResult.userId,
              appId: manualResult.appId,
            };
            log.debug("SOCKET_AUTH", "Manual JWT verification succeeded", { socketId });
          } catch (manualError: any) {
            log.error("SOCKET_AUTH", "All verification methods failed", {
              socketId,
              sdkError: sdkError?.message,
              manualError: manualError?.message,
            });
            throw manualError;
          }
        } else {
          log.error("SOCKET_AUTH", "SDK failed and no verification key for fallback", {
            socketId,
            error: sdkError?.message,
          });
          throw sdkError;
        }
      }

      // Fetch user details from Privy
      let user: any = { id: verifiedClaims.userId };
      try {
        if (typeof (privy as any).users === 'function') {
          const users = (privy as any).users();
          if (typeof users._get === 'function') {
            user = await users._get(verifiedClaims.userId);
          } else if (typeof users.get === 'function') {
            user = await users.get(verifiedClaims.userId);
          }
        } else if (typeof (privy as any).getUser === 'function') {
          user = await (privy as any).getUser(verifiedClaims.userId);
        }
      } catch (userFetchError) {
        // Continue with basic user object if fetch fails
        log.warn("SOCKET_AUTH", "Failed to fetch full user, using basic", { socketId });
      }

      let wallet: string | null = null;
      if (user?.wallet) {
        wallet = user.wallet.address?.toLowerCase() || null;
      } else if (user?.linked_accounts) {
        const walletAccount = user.linked_accounts.find(
          (account: any) => account.type === "wallet",
        );
        if (walletAccount && "address" in walletAccount) {
          wallet = (walletAccount as any).address.toLowerCase();
        }
      } else if (user?.linkedAccounts) {
        // Try camelCase version too
        const walletAccount = user.linkedAccounts.find(
          (account: any) => account.type === "wallet",
        );
        if (walletAccount && "address" in walletAccount) {
          wallet = (walletAccount as any).address.toLowerCase();
        }
      }

      // Attach user data to socket
      (socket as any).user = {
        privyUserId: verifiedClaims.userId,
        wallet,
      };

      successfulConnections++;
      log.info("SOCKET_AUTH", "Authentication successful", {
        socketId,
        userId: verifiedClaims.userId,
        wallet: wallet ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}` : null,
        totalSuccessful: successfulConnections,
      });

      next();
    } catch (error: any) {
      authFailures++;
      log.error("SOCKET_AUTH", "Authentication failed", {
        socketId,
        clientIp,
        error: error?.message || String(error),
        totalAuthFailures: authFailures,
      });
      next(new Error("Invalid authentication token"));
    }
  });

  // Connection handler
  io.on("connection", (socket) => {
    const user = (socket as any).user as AuthUser;
    const gameState = getGameState();
    const playersBefore = gameState.getAllPlayers().length;

    log.info("SOCKET_CONNECT", "Player connected", {
      socketId: socket.id,
      userId: user.privyUserId,
      wallet: user.wallet
        ? `${user.wallet.slice(0, 6)}...${user.wallet.slice(-4)}`
        : null,
      playersBefore,
    });

    // Add player to game state
    const player = gameState.addPlayer(
      socket.id,
      user.privyUserId,
      user.wallet,
    );
    const playersAfter = gameState.getAllPlayers().length;

    log.info("SOCKET_CONNECT", "Player added to game state", {
      socketId: socket.id,
      playerPosition: { x: player.x, y: player.y },
      playersAfter,
      playerCountDelta: playersAfter - playersBefore,
    });

    // Send initial game state to the new player, including their own restored stats
    const clientState = gameState.getClientState();
    socket.emit("game:init", {
      ...clientState,
      myStats: {
        totalDug: player.totalDug,
        digCount: player.digCount,
      },
    });
    log.debug("SOCKET_EMIT", "Sent game:init to player", {
      socketId: socket.id,
      playersInState: clientState.players.length,
      restoredScore: player.totalDug,
    });

    // Send sync status if active
    const syncStatus = gameState.getSyncStatus();
    if (syncStatus.active && syncStatus.endTime) {
      socket.emit("sync:start", {
        endTime: syncStatus.endTime,
        duration: syncStatus.endTime - (syncStatus.startTime || Date.now()),
      });
      log.debug("SOCKET_EMIT", "Sent sync:start to player", {
        socketId: socket.id,
        endTime: syncStatus.endTime,
      });
    }

    // Broadcast new player to all others
    socket.broadcast.emit("player:join", {
      odId: socket.id,
      wallet: user.wallet,
      x: player.x,
      y: player.y,
      totalDug: player.totalDug,
    });
    log.debug("SOCKET_BROADCAST", "Broadcast player:join", {
      socketId: socket.id,
    });

    // Immediately broadcast updated player count
    io!.emit("game:playerCount", { count: playersAfter });
    log.info("SOCKET_BROADCAST", "Broadcast updated player count", {
      count: playersAfter,
    });

    // Handle player position updates
    socket.on("player:move", (data: { x: number; y: number }) => {
      gameState.updatePlayerPosition(socket.id, data.x, data.y);
      socket.broadcast.emit("player:moved", {
        odId: socket.id,
        wallet: user.wallet,
        x: data.x,
        y: data.y,
      });
    });

    // Handle dig attempts
    socket.on("player:dig", (data: { x: number; y: number }) => {
      const result = gameState.attemptDig(socket.id, data.x, data.y);
      socket.emit("dig:result", result);

      if (result.success) {
        log.debug("GAME_DIG", "Successful dig", {
          socketId: socket.id,
          position: data,
          yield: result.yield,
          isTreasure: result.isTreasure,
        });

        io!.emit("player:dug", {
          odId: socket.id,
          wallet: user.wallet,
          x: data.x,
          y: data.y,
          yield: result.yield,
          isTreasure: result.isTreasure,
          digSpotId: result.digSpotId,
          treasureId: result.treasureId,
        });

        if (result.digSpotId !== undefined) {
          io!.emit("digspot:depleted", { id: result.digSpotId });
        }

        io!.emit("leaderboard:update", gameState.getLeaderboard().slice(0, 10));
      }
    });

    // Handle disconnection
    socket.on("disconnect", (reason) => {
      const playersBeforeDisconnect = gameState.getAllPlayers().length;
      gameState.removePlayer(socket.id);
      const playersAfterDisconnect = gameState.getAllPlayers().length;

      log.info("SOCKET_DISCONNECT", "Player disconnected", {
        socketId: socket.id,
        userId: user.privyUserId,
        wallet: user.wallet
          ? `${user.wallet.slice(0, 6)}...${user.wallet.slice(-4)}`
          : null,
        reason,
        playersBefore: playersBeforeDisconnect,
        playersAfter: playersAfterDisconnect,
      });

      socket.broadcast.emit("player:leave", { odId: socket.id });

      // Immediately broadcast updated player count
      io!.emit("game:playerCount", { count: playersAfterDisconnect });
      log.info(
        "SOCKET_BROADCAST",
        "Broadcast updated player count after disconnect",
        { count: playersAfterDisconnect },
      );
    });

    // Handle ping for latency measurement
    socket.on("ping", (timestamp: number) => {
      socket.emit("pong", timestamp);
    });

    // Log any socket errors
    socket.on("error", (error) => {
      log.error("SOCKET_ERROR", "Socket error", {
        socketId: socket.id,
        error: error.message,
      });
    });
  });

  // Log when new transport is established
  io.engine.on("connection", (rawSocket) => {
    log.debug("ENGINE", "Raw connection established", {
      transport: rawSocket.transport.name,
      remoteAddress: rawSocket.remoteAddress,
    });
  });

  // Broadcast player positions periodically (50ms) - but log less frequently
  let broadcastCount = 0;
  setInterval(() => {
    if (!io) return;
    const gameState = getGameState();
    const players = gameState.getAllPlayers();
    broadcastCount++;

    // Always emit player count
    io.emit("game:playerCount", { count: players.length });

    // Log every 100th broadcast (every 5 seconds) to avoid spam
    if (broadcastCount % 100 === 0) {
      log.debug("SOCKET_PERIODIC", "Broadcasting player count", {
        count: players.length,
        broadcastNumber: broadcastCount,
        connectedSockets: io.sockets.sockets.size,
      });
    }

    if (players.length > 0) {
      io.emit(
        "players:positions",
        players.map((p) => ({
          odId: p.odId,
          wallet: p.wallet,
          x: p.x,
          y: p.y,
          totalDug: p.totalDug,
        })),
      );
    }
  }, GAME_CONFIG.POSITION_UPDATE_INTERVAL);

  log.info("SOCKET", "Socket.IO server initialized successfully");
}

// ============================================
// START SERVER
// ============================================

const port = parseInt(process.env.PORT || "3000", 10);

// Create HTTP server that handles both Hono and Socket.io
const httpServer = createServer(async (req, res) => {
  // Let Hono handle HTTP requests
  const response = await app.fetch(
    new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as any,
      body: req.method !== "GET" && req.method !== "HEAD" ? req : undefined,
    }),
  );

  // Convert Hono response to Node.js response
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (response.body) {
    const reader = response.body.getReader();
    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) {
        res.end();
        return;
      }
      res.write(value);
      pump();
    };
    pump();
  } else {
    res.end();
  }
});

// Setup Socket.IO
setupSocketIO(httpServer);

// Initialize game state
getGameState();

httpServer.listen(port, () => {
  // ASCII Art banner
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║       🌴  JUNGLE BAY ISLAND - SESSION STARTED  🌴                ║
║                                                                  ║
║   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ║
║   ░░  ████████╗██╗███╗   ███╗███████╗██████╗     ██████╗   ░░   ║
║   ░░  ╚══██╔══╝██║████╗ ████║██╔════╝██╔══██╗   ██╔═████╗  ░░   ║
║   ░░     ██║   ██║██╔████╔██║█████╗  ██████╔╝   ██║██╔██║  ░░   ║
║   ░░     ██║   ██║██║╚██╔╝██║██╔══╝  ██╔══██╗   ████╔╝██║  ░░   ║
║   ░░     ██║   ██║██║ ╚═╝ ██║███████╗██║  ██║██╗╚██████╔╝  ░░   ║
║   ░░     ╚═╝   ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝╚═╝ ╚═════╝   ░░   ║
║   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ║
║                                                                  ║
║         ⏱️  30 MINUTE GAME SESSION NOW ACTIVE  ⏱️                 ║
║                                                                  ║
║         💰 Prize Pool: 100,000,000 $JBM                          ║
║         🎮 Max Players: 88                                       ║
║         🗺️  Island: ${GAME_CONFIG.MAP_WIDTH}x${GAME_CONFIG.MAP_HEIGHT} tiles                                   ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
  `);

  console.log(`🌐 Server: http://localhost:${port}`);
  console.log(`📍 Health: http://localhost:${port}/health`);

  // Auto-start the game session
  const gameState = getGameState();
  const THIRTY_MINUTES = 30 * 60 * 1000;
  gameState.startSync(THIRTY_MINUTES);

  // Create session for claims
  const sessionId = `session_${Date.now()}`;
  currentSessionId = sessionId;

  console.log(`\n🎮 Game session ${sessionId} started!`);
  console.log(
    `⏰ Session ends at: ${new Date(Date.now() + THIRTY_MINUTES).toLocaleTimeString()}`,
  );

  // Countdown timer - prints every 30 seconds
  const sessionEndTime = Date.now() + THIRTY_MINUTES;
  const countdownInterval = setInterval(() => {
    const remaining = sessionEndTime - Date.now();

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      return;
    }

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const gameState = getGameState();
    const playerCount = gameState.getAllPlayers().length;

    console.log(`
┌─────────────────────────────────────┐
│  ⏱️  SESSION COUNTDOWN              │
│                                     │
│      ${String(mins).padStart(2, "0")} : ${String(secs).padStart(2, "0")}                      │
│     mins   secs                     │
│                                     │
│  👥 Players: ${String(playerCount).padStart(2, " ")} / 88                 │
│  💰 Pool: 100M $JBM                 │
└─────────────────────────────────────┘`);
  }, 30000);

  // Auto-end session after 30 minutes
  setTimeout(() => {
    console.log("\n⏰ Session time expired! Ending game...");

    const gameState = getGameState();
    gameState.endSync();

    // Calculate distributions
    const leaderboard = gameState.getLeaderboard();
    const totalDug = leaderboard.reduce((sum, p) => sum + p.totalDug, 0);

    const sessionDistributions = new Map<
      string,
      { wallet: string; tokens: number; claimed: boolean }
    >();

    if (totalDug > 0) {
      TOKEN_POOL.distributed = 0;
      TOKEN_POOL.distributions.clear();

      for (const player of leaderboard) {
        const share = player.totalDug / totalDug;
        const tokens = Math.floor(TOKEN_POOL.total * share);
        TOKEN_POOL.distributions.set(player.privyUserId, tokens);
        TOKEN_POOL.distributed += tokens;

        if (player.wallet && tokens > 0) {
          sessionDistributions.set(player.privyUserId, {
            wallet: player.wallet,
            tokens,
            claimed: false,
          });
        }
      }
    }

    // Store session for claims
    const session: SessionClaim = {
      sessionId: currentSessionId!,
      startTime: Date.now() - THIRTY_MINUTES,
      endTime: Date.now(),
      distributions: sessionDistributions,
    };
    sessions.set(currentSessionId!, session);

    console.log(
      `\n🏁 Session ended! ${sessionDistributions.size} players eligible for claims.`,
    );
    console.log(
      `💰 Total distributed: ${TOKEN_POOL.distributed.toLocaleString()} ${TOKEN_POOL.symbol}`,
    );

    // Broadcast to all connected players
    io?.emit("sync:end", {
      sessionId: currentSessionId,
      leaderboard: leaderboard.map((p) => ({
        ...p,
        tokensEarned: TOKEN_POOL.distributions.get(p.privyUserId) || 0,
      })),
    });
  }, THIRTY_MINUTES);
});
