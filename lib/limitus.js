'use strict';

const Limitus = require('limitus');

/**
 * Transform the key so that Catbox won't complain about storing it.
 * @param  {String} key
 * @return {Object}
 */
function transformKey (key) {
    return { segment: 'yaral', id: String(key) };
}

/**
 * Builds a Limitus instance set up to use the provided cache
 * policy on the server.
 * @param  {Hapi.Server} server
 * @param  {String} policy
 * @return {Limitus}
 */
exports.build = (server, policy) => {
    const limitus = new Limitus();
    const cache = server.cache({ cache: policy });

    limitus.extend({
        set (key, value, expiration, callback) {
            cache._cache.set(transformKey(key), value, expiration, callback);
        },
        get (key, callback) {
            cache._cache.get(transformKey(key), (err, item) => {
                callback(err, item && item.item);
            });
        },
    });

    return limitus;
};
