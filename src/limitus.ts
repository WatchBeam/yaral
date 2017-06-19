import { Server } from 'hapi';

const Limitus = require('limitus');

/**
 * Transform the key so that Catbox won't complain about storing it.
 */
function transformKey (key: string): { segment: string, id: string } {
    return { segment: 'yaral', id: String(key) };
}

/**
 * Builds a Limitus instance set up to use the provided cache
 * policy on the server.
 */
export function build (server: Server, policy: string): any {
    const limitus = new Limitus();
    const cache = server.cache({ cache: policy });

    limitus.extend({
        set (key: any, value: any, expiration: any, callback: any) {
            cache.set(transformKey(key), value, expiration, callback);
        },
        get (key: any, callback: any) {
            cache.get(transformKey(key), (err, item) => {
                callback(err, item && item.item);
            });
        },
    });

    return limitus;
};
