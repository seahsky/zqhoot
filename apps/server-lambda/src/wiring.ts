import { TIMING } from '@zqhoot/protocol';
import type { EngineConfig } from '@zqhoot/engine';
import { DynamoStore } from '@zqhoot/store';
import type { Clock, HostAuth, LocalLogin, Logger } from '@zqhoot/service';
import type { AuthConfig, BaseConfig } from './config.ts';
import { CognitoHostAuth, createCognitoVerifier } from './ports/cognito-host-auth.ts';
import { LocalAuth } from './ports/local-auth.ts';

export const systemClock: Clock = { now: () => Date.now() };

export function createStore(cfg: BaseConfig): DynamoStore {
  return new DynamoStore({
    tableName: cfg.tableName,
    ...(cfg.ddbEndpoint !== undefined ? { endpoint: cfg.ddbEndpoint } : {}),
  });
}

export function engineConfig(cfg: BaseConfig): EngineConfig {
  return {
    minLeadMs: TIMING.minLeadMs.lambda,
    answerGraceMs: TIMING.answerGraceMs,
    sessionTtlMs: cfg.sessionTtlMs,
  };
}

/**
 * Bounds for the management API and Lambda clients. The SDK sets none, and one hung socket would
 * hold a slot of the 50-call pool, and with it the whole invocation, until the Lambda timeout.
 */
export const CLIENT_TIMEOUTS = { connectionTimeout: 2000, requestTimeout: 5000 } as const;

export function createHostAuth(
  auth: AuthConfig,
  logger: Logger,
): { hostAuth: HostAuth; localLogin?: LocalLogin } {
  if (auth.mode === 'cognito') {
    return {
      hostAuth: new CognitoHostAuth(
        createCognitoVerifier({ userPoolId: auth.userPoolId, clientId: auth.clientId }),
        logger,
      ),
    };
  }
  const local = new LocalAuth({
    adminUser: auth.adminUser,
    adminPassword: auth.adminPassword,
    adminPasswordHash: auth.adminPasswordHash,
    jwtSecret: auth.jwtSecret,
  });
  logger.warn({}, 'local auth is enabled: this process is the emulator, not AWS');
  return { hostAuth: local, localLogin: local };
}
