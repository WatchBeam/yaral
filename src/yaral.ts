const Limitus = require('limitus');
import { Bucket } from './bucket';
import { tooManyRequests, Output } from 'boom';
import { Server, Request, Response, PluginFunction, ServerRequestExtPoints } from 'hapi';
import * as Joi from 'joi';

import { build as buildLimitus } from './limitus';
import { all } from './util';
import { PluginRegistrationObject } from "hapi";

const schema = Joi.object().keys({
    buckets: Joi.array().required(),
    default: Joi.array().items(Joi.string()).required(),
    includeHeaders: Joi.bool().required(),
    enabled: Joi.bool().required(),
    cache: Joi.string().optional(),
    limitus: Joi.object().optional(),
    exclude: Joi.func().required(),
    onLimit: Joi.func().required(),
    onPass: Joi.func().required(),
    event: Joi.string().valid(["onRequest", "onPreAuth", "onPostAuth"])
}).required();

declare module 'hapi' {
    export interface PluginSpecificConfiguration {
        yaral?: IYaralRouteOptions | string | string[];
    }
}

export interface IYaralRouteOptions {
    /**
     * specifies the bucket `name` or array of of the rate limit buckets to use in addition to the configured `default` rules.
     * Buckets are matched first to last.
     */
    buckets?: string | string[];
    /**
     * `enabled` is a boolean which allows you to override a true `enabled` global configuration.
     * This can be used to exclude routes from global rate limits.
     * Defaults to `true`.
     */
    enabled?: boolean;
    /**
     * If both a route-level and a global exclude passed, the request will be excluded if _either_ return true.
     */
    exclude? (req: Request): boolean;
}

/**
 * cancel is a symbol that can be returned from onLimit in order to abort
 * rate limiting the provided request.
 */
export const cancel = Symbol('cancel');

/**
 * Describes a rate limit bucket.
 */
export interface IBucketOptions {
    /**
     * Identifier
     */
    name: string;
    /**
     * An `interval` that allows a `max` number of requests.
     */
    interval: number;
    max: number;
    /**
     * A `mode` as described in the Limitus documentation.
     * Defaults to `interval`.
     */
    mode: 'interval' | 'continious';
    /**
     * Function that takes a Hapi request object and returns a string, number or object that identifies the requester.
     */
    id (req: Request): string | number | object;
    /**
     * A list of `codes` that specify response codes that count towards this bucket's limit.
     * Responses not in this range will not be limited.
     * Defaults to `['2xx', '3xx']`.
     * *Tip:* to limit all responses, use `['xxx']`.
     */
    codes?: string[];
}

/**
 * Options that are available when you register Yaral.
 */
export interface IYaralOptions {
    /**
     * is a bucket `name` or array of names of the bucket applied to all routes.
     * Defaults to `[]`. Buckets are matched first to last.
     */
    default?: string | string[];
    /**
     * is the cache name (as configured in the Hapi server) used to store rate limiting data.
     * Defaults to the server's default cache.
     */
    cache?: string;
    /**
     * is a boolean whether to enable rate limiting.
     * Useful to disable limiting in tests and development.
     * Default to `true`.
     */
    enabled?: boolean;
    /**
     * specifies whether rate limit headers should be included in the response.
     */
    includeHeaders?: boolean;
    /**
     * A Limitus instance to use for this rate limiting. Defaults to `new Limitus()`.
     */
    limitus?: any;

    /**
     * A function, called with the `request` object that returns true if the provided request should be omitted from limiting.
     */
    exclude? (req: Request): boolean;

    /**
     * A function called with the `request` object with a successful request is made which is not rate limited.
     */
    onPass? (req: Request): void;

    /**
     * A function called with the `request` object, `rule` name that failed, and extra `data` that rule returns when a request is made which does get rate limited.
     * You may return `yaral.cancel` from this method to cause the specific request not to be rate limited.
     */
    onLimit? (req: Request, data: any, name: string): Symbol | void;

    /**
     * is an array of interval/mode config for [Limitus](https://github.com/MCProHosting/limitus#limitusrulename-rule) intervals. Each item should have:
     */
    buckets: IBucketOptions[];
    /**
     * A string representing when in the request lifecycle the limit checks should occur
     */
    event?: ServerRequestExtPoints;
}

interface IYaralInternalData {
    ids: (string | number | object)[];
    buckets: string[];
}

export const register: PluginFunction<IYaralOptions> = (server: Server, options: IYaralOptions, next: () => void) => {
    options = {
        cache: '_default',
        enabled: true,
        includeHeaders: true,
        default: [],
        exclude: () => false,
        onLimit: () => {},
        onPass: () => {},
        event: 'onPreAuth',
        ...options
    };

    Joi.assert(options, schema);

    // If we aren't enabled, don't bother doing anything.
    if (!options.enabled) {
        return next();
    }

    const limitus = options.limitus || buildLimitus(server, options.cache);
    const buckets: {
        [key: string]: Bucket;
    } = {};
    options.buckets.forEach(bucket => {
        const b = new Bucket(bucket, limitus);
        buckets[b.name()] = b;
    });

    /**
     * Returns a configuration object for the route based on its specific
     * rules.
     */
    function resolveRouteOpts (req: Request): {
        enabled: boolean;
        buckets: string[];
        exclude: (req: Request) => boolean;
    } {
        const routeOpts = req.route.settings.plugins.yaral;

        const opts = {
            enabled: true,
            buckets: <string[]>[],
            exclude: (_req: Request) => false,
        };
        if (!routeOpts) {
            // do nothing
        } else if (typeof routeOpts === 'string') { // specifying bucket as string
            opts.buckets = [routeOpts];
        } else if (Array.isArray(routeOpts)) { // specifying array of buckets
            opts.buckets = routeOpts;
        } else { // providing a literal object
            Object.assign(opts, routeOpts);
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
    const matchBucket = (info: IYaralInternalData, res: Response): {
        bucket: Bucket;
        id: string | number | object;
    } => {
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
     */
    const addHeaders = (res: Output | Response, headers: { [key: string]: string | number }) => {
        if (options.includeHeaders) {
            Object.assign(res.headers, headers);
        }
    };


    server.ext(options.event, (req, reply) => {
        const opts = resolveRouteOpts(req);
        if (opts.enabled === false) {
            return reply.continue();
        }

        const info = {
            buckets: opts.buckets,
            ids: opts.buckets.map(b => buckets[b].identify(req)),
            limited: false,
        };
        req.plugins.yaral = info;

        return all(info.buckets.map((name, i) => {
            return (callback: (err: Error, data?: any, name?: string) => void) => {
                limitus.checkLimited(name, info.ids[i], (err: Error, data: any) => {
                    callback(err, data, name);
                });
            };
        }), (err: Error, data: any, name: string) => {
            if (!err) {
                options.onPass(req);
                reply.continue();
                return;
            }

            // Some internal error occurred. Log an error, but try to
            // continue; don't bring down the entire site
            // if there's some issue here!
            if (!(err instanceof Limitus.Rejected)) {
                server.log(['error', 'ratelimit'], err);
                reply.continue();
                return;
            }

            // Continue the request if onLimit dictates that we cancel limiting.
            if (options.onLimit(req, data, name) === cancel) {
                reply.continue();
                return;
            }

            info.limited = true;
            const res = tooManyRequests();
            addHeaders(res.output, {
                'X-RateLimit-Remaining': 0,
                'X-RateLimit-Reset': data.bucket,
            });

            reply(res);
            return;
        });
    });


    server.ext('onPreResponse', (req, reply) => {
        const res = req.response.output || req.response;
        const opts = req.plugins.yaral && matchBucket(req.plugins.yaral, <Response>res);
        if (!opts || req.plugins.yaral.limited) {
            return reply.continue();
        }

        return limitus.drop(opts.bucket.name(), opts.id, (err: Error, data?: any) => {
            if (err instanceof Limitus.Rejected) {
                reply.continue(); // this'll be sent on their next request
                return;
            }

            // Internal errors should not halt everything.
            if (err) {
                server.log(['error', 'ratelimit'], err);
                reply.continue();
                return;
            }

            addHeaders(res, opts.bucket.headers(data));

            reply.continue();
        });
    });

    next();
};

register.attributes = { pkg: require('../package') };

export const yaral: PluginRegistrationObject<IYaralOptions> = {
    register,
}
