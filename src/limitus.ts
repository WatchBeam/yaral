import { PolicyAPI } from 'catbox';
import { Server } from 'hapi';

const limitus = require('limitus');

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
export function build(server: Server, policy: string): any {
  const limitusInstance = new limitus();
  const cache = server.cache({ cache: policy });
  // Access of internal cache
  // Using cache directly results in errors.
  const internalCache: PolicyAPI = (<any>cache)._cache;

  limitusInstance.extend({
    set(key: any, value: any, expiration: any, callback: any) {
      internalCache.set(transformKey(key), value, expiration, callback);
    },
    get(key: any, callback: any) {
      internalCache.get(transformKey(key), (err, item) => {
        callback(err, item && item.item);
      });
    },
  });

  return limitusInstance;
}
