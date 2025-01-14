import { ChildProcess, fork } from 'child_process';
import path = require('path');

import { PluginConfiguration } from '../../config/nx-json';

// TODO (@AgentEnder): After scoped verbose logging is implemented, re-add verbose logs here.
// import { logger } from '../../utils/logger';

import { RemotePlugin, nxPluginCache } from './internal-api';
import { PluginWorkerResult, consumeMessage, createMessage } from './messaging';

const cleanupFunctions = new Set<() => void>();

const pluginNames = new Map<ChildProcess, string>();

interface PendingPromise {
  promise: Promise<unknown>;
  resolver: (result: any) => void;
  rejector: (err: any) => void;
}

export function loadRemoteNxPlugin(plugin: PluginConfiguration, root: string) {
  // this should only really be true when running unit tests within
  // the Nx repo. We still need to start the worker in this case,
  // but its typescript.
  const isWorkerTypescript = path.extname(__filename) === '.ts';
  const workerPath = path.join(__dirname, 'plugin-worker');
  const worker = fork(workerPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      ...(isWorkerTypescript
        ? {
            // Ensures that the worker uses the same tsconfig as the main process
            TS_NODE_PROJECT: path.join(__dirname, '../../../tsconfig.lib.json'),
          }
        : {}),
    },
    execArgv: [
      ...process.execArgv,
      // If the worker is typescript, we need to register ts-node
      ...(isWorkerTypescript ? ['-r', 'ts-node/register'] : []),
    ],
  });
  worker.send(createMessage({ type: 'load', payload: { plugin, root } }));

  // logger.verbose(`[plugin-worker] started worker: ${worker.pid}`);

  const pendingPromises = new Map<string, PendingPromise>();

  const exitHandler = createWorkerExitHandler(worker, pendingPromises);

  const cleanupFunction = () => {
    worker.off('exit', exitHandler);
    shutdownPluginWorker(worker, pendingPromises);
  };

  cleanupFunctions.add(cleanupFunction);

  return [
    new Promise<RemotePlugin>((res, rej) => {
      worker.on(
        'message',
        createWorkerHandler(worker, pendingPromises, res, rej)
      );
      worker.on('exit', exitHandler);
    }),
    () => {
      cleanupFunction();
      cleanupFunctions.delete(cleanupFunction);
    },
  ] as const;
}

async function shutdownPluginWorker(
  worker: ChildProcess,
  pendingPromises: Map<string, PendingPromise>
) {
  // Clears the plugin cache so no refs to the workers are held
  nxPluginCache.clear();

  // logger.verbose(`[plugin-pool] starting worker shutdown`);

  // Other things may be interacting with the worker.
  // Wait for all pending promises to be done before killing the worker
  await Promise.all(
    Array.from(pendingPromises.values()).map(({ promise }) => promise)
  );

  worker.kill('SIGINT');
}

/**
 * Creates a message handler for the given worker.
 * @param worker Instance of plugin-worker
 * @param pending Set of pending promises
 * @param onload Resolver for RemotePlugin promise
 * @param onloadError Rejecter for RemotePlugin promise
 * @returns Function to handle messages from the worker
 */
function createWorkerHandler(
  worker: ChildProcess,
  pending: Map<string, PendingPromise>,
  onload: (plugin: RemotePlugin) => void,
  onloadError: (err?: unknown) => void
) {
  let pluginName: string;

  return function (message: string) {
    const parsed = JSON.parse(message);
    // logger.verbose(
    //   `[plugin-pool] received message: ${parsed.type} from ${
    //     pluginName ?? worker.pid
    //   }`
    // );
    consumeMessage<PluginWorkerResult>(parsed, {
      'load-result': (result) => {
        if (result.success) {
          const { name, createNodesPattern } = result;
          pluginName = name;
          pluginNames.set(worker, pluginName);
          onload({
            name,
            createNodes: createNodesPattern
              ? [
                  createNodesPattern,
                  (configFiles, ctx) => {
                    const tx = pluginName + ':createNodes:' + performance.now();
                    return registerPendingPromise(tx, pending, () => {
                      worker.send(
                        createMessage({
                          type: 'createNodes',
                          payload: { configFiles, context: ctx, tx },
                        })
                      );
                    });
                  },
                ]
              : undefined,
            createDependencies: result.hasCreateDependencies
              ? (opts, ctx) => {
                  const tx =
                    pluginName + ':createDependencies:' + performance.now();
                  return registerPendingPromise(tx, pending, () => {
                    worker.send(
                      createMessage({
                        type: 'createDependencies',
                        payload: { context: ctx, tx },
                      })
                    );
                  });
                }
              : undefined,
            processProjectGraph: result.hasProcessProjectGraph
              ? (graph, ctx) => {
                  const tx =
                    pluginName + ':processProjectGraph:' + performance.now();
                  return registerPendingPromise(tx, pending, () => {
                    worker.send(
                      createMessage({
                        type: 'processProjectGraph',
                        payload: { graph, ctx, tx },
                      })
                    );
                  });
                }
              : undefined,
          });
        } else if (result.success === false) {
          onloadError(result.error);
        }
      },
      createDependenciesResult: ({ tx, ...result }) => {
        const { resolver, rejector } = pending.get(tx);
        if (result.success) {
          resolver(result.dependencies);
        } else if (result.success === false) {
          rejector(result.error);
        }
      },
      createNodesResult: ({ tx, ...result }) => {
        const { resolver, rejector } = pending.get(tx);
        if (result.success) {
          resolver(result.result);
        } else if (result.success === false) {
          rejector(result.error);
        }
      },
      processProjectGraphResult: ({ tx, ...result }) => {
        const { resolver, rejector } = pending.get(tx);
        if (result.success) {
          resolver(result.graph);
        } else if (result.success === false) {
          rejector(result.error);
        }
      },
    });
  };
}

function createWorkerExitHandler(
  worker: ChildProcess,
  pendingPromises: Map<string, PendingPromise>
) {
  return () => {
    for (const [_, pendingPromise] of pendingPromises) {
      pendingPromise.rejector(
        new Error(
          `Plugin worker ${
            pluginNames.get(worker) ?? worker.pid
          } exited unexpectedly with code ${worker.exitCode}`
        )
      );
    }
  };
}

process.on('exit', () => {
  for (const fn of cleanupFunctions) {
    fn();
  }
});

function registerPendingPromise(
  tx: string,
  pending: Map<string, PendingPromise>,
  callback: () => void
): Promise<any> {
  let resolver, rejector;

  const promise = new Promise((res, rej) => {
    resolver = res;
    rejector = rej;

    callback();
  }).finally(() => {
    pending.delete(tx);
  });

  pending.set(tx, {
    promise,
    resolver,
    rejector,
  });

  return promise;
}
