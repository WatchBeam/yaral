import { Policy, PolicyOptionVariants } from '@hapi/catbox';
import { Server } from '@hapi/hapi';
import * as Limitus from 'limitus';

/**
 * Transform the key so that Catbox won't complain about storing it.
 */
function transformKey(key: string): { segment: string; id: string } {
  return { segment: 'yaral', id: String(key) };
}

/**
 * Builds a Limitus instance set up to use the provided cache
 * policy on the server.
 */
export function build(server: Server, policy: string): Limitus {
  const limitusInstance = new Limitus();
  const cache = server.cache({ cache: policy });
  // Access of internal cache
  // Using cache directly results in errors.
  const internalCache: Policy<string, PolicyOptionVariants<string>> = (<any>cache)._cache;

  limitusInstance.extend({
    async set(key, value, expiration, callback) {
      try {
        await internalCache.set(transformKey(key), value, expiration);
        callback(null);
      } catch (e) {
        callback(e);
      }
    },
    async get(key, callback) {
      try {
        const res = await internalCache.get(transformKey(key));
        callback(null, res && (<any>res).item);
      } catch (e) {
        callback(e);
      }
    },
  });

  return limitusInstance;
}
