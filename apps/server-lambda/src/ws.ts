import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import { GameService } from '@zqhoot/service';
import { loadWsConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { ApiGatewayTransport } from './ports/api-gateway-transport.ts';
import { createIds } from './ports/ids.ts';
import {
  CLIENT_TIMEOUTS,
  createHostAuth,
  createStore,
  engineConfig,
  systemClock,
} from './wiring.ts';
import { createWsHandler } from './ws-handler.ts';

// Everything below runs once per execution environment, so warm invocations reuse the SDK
// clients, their keep-alive sockets and the Cognito JWKS (ADR-0010).
const config = loadWsConfig(process.env);
const logger = createLogger(config.logLevel);

const transport = new ApiGatewayTransport({
  client: new ApiGatewayManagementApiClient({
    endpoint: config.wsCallbackUrl,
    requestHandler: CLIENT_TIMEOUTS,
  }),
  clock: systemClock,
  logger,
});

const service = new GameService({
  store: createStore(config),
  transport,
  clock: systemClock,
  ids: createIds(),
  hostAuth: createHostAuth(config.auth, logger).hostAuth,
  logger,
  config: {
    engine: engineConfig(config),
    revealSettleMs: 1000,
    allowedOrigins: [config.siteOrigin],
    nicknameAttemptsPerConnection: 10,
  },
});

export const handler = createWsHandler({ service, logger });
