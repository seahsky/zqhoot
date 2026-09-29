import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { defaultIsContentTypeBinary, handle } from 'hono/aws-lambda';
import { createHttpApp } from '@zqhoot/service';
import { apiGatewayClientIp } from './client-ip.ts';
import { loadHttpConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { createIds } from './ports/ids.ts';
import { LambdaWarmer } from './ports/lambda-warmer.ts';
import { S3Media } from './ports/s3-media.ts';
import { VERSION } from './version.ts';
import {
  CLIENT_TIMEOUTS,
  createHostAuth,
  createStore,
  engineConfig,
  systemClock,
} from './wiring.ts';

// Built once per execution environment, like the ws function (ADR-0010).
const config = loadHttpConfig(process.env);
const logger = createLogger(config.logLevel);
const ids = createIds();
const { hostAuth, localLogin } = createHostAuth(config.auth, logger);

const app = createHttpApp({
  store: createStore(config),
  clock: systemClock,
  ids,
  hostAuth,
  media: new S3Media({ client: new S3Client({}), bucket: config.mediaBucket, ids }),
  ...(config.warmConcurrency > 0
    ? {
        warmer: new LambdaWarmer(
          new LambdaClient({
            ...(config.lambdaEndpoint !== undefined ? { endpoint: config.lambdaEndpoint } : {}),
            requestHandler: CLIENT_TIMEOUTS,
          }),
          config.wsFunctionName,
          config.warmConcurrency,
        ),
      }
    : {}),
  ...(localLogin !== undefined ? { localLogin } : {}),
  logger,
  engine: engineConfig(config),
  info: { target: 'aws', version: VERSION },
  clientIp: apiGatewayClientIp,
  // API Gateway adds no CORS headers of its own: the API has no `cors_configuration`, so it passes
  // these through (infra/terraform/modules/http-api).
  cors: { origins: config.corsOrigins },
});

// The adapter turns text bodies into strings with Response.text(), which drops the UTF-8 byte
// order mark the results CSV starts with (spreadsheet apps need it to pick the encoding).
// Sending CSV as base64 keeps the bytes intact.
export const handler = handle(app, {
  isContentTypeBinary: (contentType) =>
    defaultIsContentTypeBinary(contentType) || contentType.startsWith('text/csv'),
});
