'use strict';

const Limitus = require('limitus');
const Bucket = require('./bucket');
const Boom = require('boom');
const Joi = require('joi');

const buildLimitus = require('./limitus').build;
const assign = require('lodash.assign');
const all = require('./util').all;


const schema = Joi.object().keys({
    buckets: Joi.array().required(),
    default: Joi.array().items(Joi.string()).required(),
    includeHeaders: Joi.bool().required(),
    enabled: Joi.bool().required(),
    cache: Joi.string().optional(),
    limitus: Joi.object().optional(),
    exclude: Joi.func().required(),
}).required();


exports.register = function (server, options, next) {
    options = assign({
        cache: '_default',
        enabled: true,
        includeHeaders: true,
        default: [],
        exclude: (req) => false,
    }, options);

    Joi.assert(options, schema);

    const limitus = options.limitus || buildLimitus(server, options.cache);
    const buckets = {};
    options.buckets.forEach((bucket) => {
        const b = new Bucket(bucket, limitus);
        buckets[b.name()] = b;
    });


    // If we aren't enabled, don't bother doing anything.
    if (!options.enabled) {
        return next();
    }

    /**
     * Returns a configuration object for the route based on its specific
     * rules.
     * @param  {Hapi.Request} req
     * @return {Object}
     */
    const resolveRouteOpts = (req) => {
        const routeOpts = req.route.settings.plugins.yaral;

        let opts = { enabled: true, buckets: [], exclude: () => false };
        if (!routeOpts) {
            // do nothing
        } else if (typeof routeOpts === 'string') { // specifying bucket as string
            opts.buckets = [routeOpts];
        } else if (routeOpts.length) { // specifying array of buckets
            opts.buckets = routeOpts;
        } else { // providing a literal object
            assign(opts, routeOpts);
        }

        if (opts.enabled) {
            opts.buckets = opts.buckets.concat(options.default);
            opts.enabled =
                !(options.exclude(req) || opts.exclude(req)) &&
                (opts.buckets.length + options.default.length > 0);
        }

        return opts;
    };

    /**
     * Returns the bucket used to rate limit the specified response.
     * @param  {Object} info
     * @param  {Hapi.Response} res
     * @return {Bucket}      undefined if none matching
     */
    const matchBucket = (info, res) => {
        for (let i = 0; i < info.buckets.length; i++) {
            const bucket = buckets[info.buckets[i]];
            if (bucket.matches(res.statusCode)) {
                return { bucket: bucket, id: info.ids[i] };
            }
        }

        return undefined;
    };

    /**
     * Adds rate limit headers to the response if they're set.
     * @param {Hapi.Response} res
     * @param {Object} headers
     */
    const addHeaders = (res, headers) => {
        if (options.includeHeaders) {
            assign(res.headers, headers);
        }
    };


    server.ext('onPostAuth', (req, reply) => {
        let opts = resolveRouteOpts(req);
        if (opts.enabled === false) {
            return reply.continue();
        }

        const info = {
            buckets: opts.buckets,
            ids: opts.buckets.map(b => buckets[b].identify(req)),
        };
        req.plugins.yaral = info;

        return all(info.buckets.map((name, i) => {
            return (callback) => {
                limitus.checkLimited(name, info.ids[i], callback);
            };
        }), (err, data) => {
            if (!err) {
                return reply.continue();
            }

            if (err instanceof Limitus.Rejected) {
                info.limited = true;
                const res = Boom.tooManyRequests();
                addHeaders(res.output, {
                    'X-RateLimit-Remaining': 0,
                    'X-RateLimit-Reset': data.bucket,
                });

                return reply(res);
            }

            // Otherwise, some internal error occurred.
            // log an error, but try to continue; don't bring down the
            // entire site if there's some issue here!
            server.log(['error', 'ratelimit'], err);
            reply.continue();
        });
    });


    server.ext('onPreResponse', (req, reply) => {
        const res = req.response.output || req.response;
        const opts = req.plugins.yaral && matchBucket(req.plugins.yaral, res);
        if (!opts || req.plugins.yaral.limited) {
            return reply.continue();
        }

        return limitus.drop(opts.bucket.name(), opts.id, (err, data) => {
            if (err instanceof Limitus.Rejected) {
                return reply.continue(); // this'll be sent on their next request
            }

            // Internal errors should not halt everthing.
            if (err) {
                server.log(['error', 'ratelimit'], err);
                return reply.continue();
            }

            addHeaders(res, {
                'X-Rate-Limit': opts.bucket.max(),
                'X-RateLimit-Remaining': Math.max(opts.bucket.max() - data.count, 0),
                'X-RateLimit-Reset': data.bucket
            });

            reply.continue();
        });
    });

    next();
};

exports.register.attributes = { pkg: require('../package') };
