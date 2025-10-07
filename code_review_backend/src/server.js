'use strict';

/**
 * Initialize environment variables early so that any configuration depending on them
 * is available before the server starts.
 */
try {
  // Load .env if available; safe in production and helpful in local/dev
  require('dotenv').config();
} catch (err) {
  // If dotenv isn't available, proceed; log only in non-production to avoid noise
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('dotenv not found or failed to initialize:', err && err.message ? err.message : err);
  }
}

const app = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Track open sockets so we can destroy them if shutdown hangs
const sockets = new Set();

// Idempotent shutdown management
let isShuttingDown = false;
let shutdownTimer = null;
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 10_000;

let server;

// Attach top-level fatal error handlers early
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
  shutdown(1);
});

process.on('unhandledRejection', (reason, promise) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled promise rejection:', {
    reason: reason && reason.stack ? reason.stack : reason,
    promise,
  });
  shutdown(1);
});

/**
 * Configure HTTP server timeouts to guard against slowloris-style connections.
 * Defaults:
 * - keepAliveTimeout: 60s
 * - headersTimeout: max(65s, keepAliveTimeout + 1000ms) to avoid premature header timeouts
 */
function setupServerTimeouts() {
  const keepAliveFromEnv = parseInt(process.env.KEEP_ALIVE_TIMEOUT_MS, 10);
  const headersFromEnv = parseInt(process.env.HEADERS_TIMEOUT_MS, 10);

  const keepAliveMs = Number.isFinite(keepAliveFromEnv) ? keepAliveFromEnv : 60_000;
  const minHeadersMs = keepAliveMs + 1_000; // at least 1s greater than keepAlive
  const headersMsCandidate = Number.isFinite(headersFromEnv) ? headersFromEnv : 65_000;
  const headersMs = Math.max(headersMsCandidate, minHeadersMs);

  // Configure server timeouts
  server.keepAliveTimeout = keepAliveMs;
  server.headersTimeout = headersMs;

  // eslint-disable-next-line no-console
  console.log(`Server timeouts configured: keepAliveTimeout=${keepAliveMs}ms, headersTimeout=${headersMs}ms`);
}

/**
 * Graceful shutdown handler.
 * Attempts to close the HTTP server and allows in-flight requests to complete.
 * If the process doesn't exit within SHUTDOWN_TIMEOUT_MS, destroys remaining sockets and exits.
 */
function shutdown(exitCode = 0) {
  if (isShuttingDown) {
    // eslint-disable-next-line no-console
    console.log('Shutdown already in progress, ignoring subsequent shutdown request.');
    return;
  }
  isShuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`Shutdown initiated with exit code ${exitCode}. Starting graceful close...`);

  // If server hasn't been initialized yet, exit immediately.
  if (!server) {
    // eslint-disable-next-line no-console
    console.warn('HTTP server not initialized; exiting immediately.');
    process.exit(exitCode);
    return;
  }

  // Enforce a maximum shutdown timeout
  shutdownTimer = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn(`Shutdown timeout reached (${SHUTDOWN_TIMEOUT_MS}ms). Destroying ${sockets.size} open socket(s).`);
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Error destroying socket during forced shutdown:', err);
      }
    }
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);

  // Close the server to stop accepting new connections
  try {
    server.close(() => {
      // eslint-disable-next-line no-console
      console.log('HTTP server closed');
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
      }
      process.exit(exitCode);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error while closing HTTP server:', err);
    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
    }
    process.exit(exitCode);
  }
}

// Start the HTTP server
server = app.listen(PORT, HOST, () => {
  // Keep existing log format/message
  // eslint-disable-next-line no-console
  console.log(`Server running at http://${HOST}:${PORT}`);
});

// Configure server timeouts after the server has been created
setupServerTimeouts();

// Track sockets for potential forced shutdown
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => {
    sockets.delete(socket);
  });
});

// Handle server-level errors (e.g., EADDRINUSE, EACCES)
server.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('HTTP server error:', err && err.stack ? err.stack : err);

  if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
    // eslint-disable-next-line no-console
    console.error(
      `Failed to bind to ${HOST}:${PORT}. Reason: ${err.code}. ` +
      'Ensure the port is available and you have sufficient privileges.'
    );
  }

  // Use the shared shutdown path to cleanup and exit
  shutdown(1);
});

// Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM
process.on('SIGINT', () => {
  // eslint-disable-next-line no-console
  console.log('SIGINT signal received: closing HTTP server');
  shutdown(0);
});

process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('SIGTERM signal received: closing HTTP server');
  shutdown(0);
});

module.exports = server;
