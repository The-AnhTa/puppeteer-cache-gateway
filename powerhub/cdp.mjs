import fs from 'node:fs/promises';
import path from 'node:path';

import {
  POWERHUB_ORIGIN
} from './routes.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;

function devToolsActivePortPath() {
  const localAppData =
    process.env.LOCALAPPDATA;

  if (!localAppData) {
    throw new Error(
      'LOCALAPPDATA is not set; cannot locate Edge DevToolsActivePort'
    );
  }

  return path.join(
    localAppData,
    'Microsoft',
    'Edge',
    'User Data',
    'DevToolsActivePort'
  );
}

async function readEndpoint() {
  const contents =
    await fs.readFile(
      devToolsActivePortPath(),
      'utf8'
    );

  const [port, browserPath] =
    contents
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

  if (!/^\d{1,5}$/.test(port ?? '')) {
    throw new Error(
      'Edge DevToolsActivePort contains an invalid port'
    );
  }

  const portNumber = Number(port);

  if (
    portNumber < 1 ||
    portNumber > 65_535
  ) {
    throw new Error(
      'Edge DevToolsActivePort contains an out-of-range port'
    );
  }

  if (
    !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(
      browserPath ?? ''
    )
  ) {
    throw new Error(
      'Edge DevToolsActivePort contains an invalid browser path'
    );
  }

  return `ws://127.0.0.1:${port}${browserPath}`;
}

function waitForOpen(
  socket,
  timeoutMs
) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();

      try {
        socket.close();
      } catch {
        // The socket may still be in its initial connection state.
      }

      reject(
        new Error(
          'Timed out connecting to the existing Edge debugging endpoint'
        )
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener(
        'open',
        onOpen
      );
      socket.removeEventListener(
        'error',
        onError
      );
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();

      try {
        socket.close();
      } catch {
        // Nothing else owns this failed connection.
      }

      reject(
        new Error(
          'Could not connect to the existing Edge debugging endpoint'
        )
      );
    };

    socket.addEventListener(
      'open',
      onOpen,
      { once: true }
    );
    socket.addEventListener(
      'error',
      onError,
      { once: true }
    );
  });
}

export async function connectToPowerhub({
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const endpoint =
    await readEndpoint();

  const socket =
    new WebSocket(endpoint);

  await waitForOpen(
    socket,
    timeoutMs
  );

  let nextId = 1;
  let sessionId;
  let closed = false;
  const pending = new Map();

  const rejectPending = message => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(message)
      );
    }

    pending.clear();
  };

  socket.addEventListener(
    'message',
    event => {
      let message;

      try {
        message = JSON.parse(
          String(event.data)
        );
      } catch {
        rejectPending(
          'Edge returned an invalid CDP message'
        );
        return;
      }

      if (!message.id) {
        return;
      }

      const entry =
        pending.get(message.id);

      if (!entry) {
        return;
      }

      pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.error) {
        entry.reject(
          new Error(
            `CDP ${entry.method} failed: ${message.error.message ?? 'unknown error'}`
          )
        );
      } else {
        entry.resolve(message.result);
      }
    }
  );

  socket.addEventListener(
    'close',
    () => {
      closed = true;
      rejectPending(
        'The Edge debugging connection closed unexpectedly'
      );
    }
  );

  socket.addEventListener(
    'error',
    () => {
      rejectPending(
        'The Edge debugging connection failed'
      );
    }
  );

  const command = (
    method,
    params = {},
    commandSessionId = undefined
  ) => {
    if (closed || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          'The Edge debugging connection is not open'
        )
      );
    }

    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `CDP command timed out: ${method}`
          )
        );
      }, timeoutMs);

      pending.set(
        id,
        {
          method,
          resolve,
          reject,
          timer
        }
      );

      const message = {
        id,
        method,
        params
      };

      if (commandSessionId) {
        message.sessionId =
          commandSessionId;
      }

      socket.send(
        JSON.stringify(message)
      );
    });
  };

  try {
    const { targetInfos = [] } =
      await command(
        'Target.getTargets'
      );

    const powerhubTargets =
      targetInfos.filter(target => {
        if (target.type !== 'page') {
          return false;
        }

        try {
          return (
            new URL(target.url).origin ===
            POWERHUB_ORIGIN
          );
        } catch {
          return false;
        }
      });

    if (powerhubTargets.length === 0) {
      throw new Error(
        'No open Powerhub page exists in the current Edge session'
      );
    }

    const target =
      powerhubTargets[0];

    const attached =
      await command(
        'Target.attachToTarget',
        {
          targetId: target.targetId,
          flatten: true
        }
      );

    sessionId = attached.sessionId;

    return {
      command(
        method,
        params = {}
      ) {
        return command(
          method,
          params,
          sessionId
        );
      },

      async detach() {
        if (closed) {
          return;
        }

        if (sessionId) {
          try {
            await command(
              'Target.detachFromTarget',
              { sessionId }
            );
          } finally {
            sessionId = undefined;
          }
        }

        closed = true;
        socket.close();
      }
    };
  } catch (error) {
    closed = true;
    socket.close();
    rejectPending(
      'Powerhub CDP setup failed'
    );
    throw error;
  }
}
