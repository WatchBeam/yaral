import * as Boom from 'boom';
import {
  Lifecycle,
  Plugin,
  Request,
  ResponseObject,
  ResponseToolkit,
  ServerRequestExtType,
} from 'hapi';
import * as Joi from 'joi';
import * as Limitus from 'limitus';
import { Bucket } from './bucket';
import { build as buildLimitus } from './limitus';

const schema = Joi.object()
  .keys({
    buckets: Joi.array().required(),
    default: Joi.array()
      .items(Joi.string())
      .required(),
    includeHeaders: Joi.bool().required(),
    enabled: Joi.bool().required(),
    cache: Joi.string().optional(),
    limitus: Joi.object().optional(),
    exclude: Joi.func().required(),
    onLimit: Joi.func().required(),
    onPass: Joi.func().required(),
    event: Joi.string().valid(['onRequest', 'onPreAuth', 'onPostAuth']),
    timeout: Joi.object().optional(),
  })
  .required();

declare module 'hapi' {
  export interface PluginSpecificConfiguration {
    yaral?: IYaralRouteOptions | string | string[];
  }
  export interface PluginsStates {
    yaral?: IYaralInternalData & {
      limited: boolean;
    };
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
  exclude?(req: Request): boolean;
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
  mode: 'continuous' | 'interval';
  /**
   * Function that takes a Hapi request object and returns a string, number or object that identifies the requester.
   */
  id(req: Request): string | number | object;
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
  limitus?: Limitus;

  /**
   * A function, called with the `request` object that returns true if the provided request should be omitted from limiting.
   */
  exclude?(req: Request): boolean;

  /**
   * A function called with the `request` object with a successful request is made which is not rate limited.
   */
  onPass?(req: Request): void;

  /**
   * A function called with the `request` object, `rule` name that failed, and extra `data` that rule
   * returns when a request is made which does get rate limited.
   * You may return `yaral.cancel` from this method to cause the specific request not to be rate limited.
   */
  onLimit?(req: Request, data: Limitus.DropInfo, name: string): Symbol | void;

  /**
   * is an array of interval/mode config for [Limitus](https://github.com/MCProHosting/limitus#limitusrulename-rule) intervals.
   * Each item should have:
   */
  buckets: IBucketOptions[];
  /**
   * A string representing when in the request lifecycle the limit checks should occur
   */
  event?: ServerRequestExtType;

  /**
   * JSON object containing redis-connection-timeout settings (enabled, timeout in ms)
   */
  timeout?: { enabled: boolean; timeout: number; ontimeout?: Lifecycle.Method };
}

export interface IYaralInternalData {
  ids: (string | number | object)[];
  buckets: string[];
}

export const plugin: Plugin<IYaralOptions> = {
  async register(server, options) {
    options = {
      cache: '_default',
      enabled: true,
      includeHeaders: true,
      default: [],
      exclude: () => false,
      onLimit: () => {
        /*do nothing*/
      },
      onPass: () => {
        /*do nothing*/
      },
      event: 'onPreAuth',
      //Timeout enabled by default with a value of 1000 ms. On timeout, by default we continue.
      timeout: {
        enabled: true,
        timeout: 1000,
        ontimeout: (_request, reply) => reply.continue,
      },
      ...options,
    };

    Joi.assert(options, schema);

    // If we aren't enabled, don't bother doing anything.
    if (!options.enabled) {
      return;
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
    function resolveRouteOpts(
      req: Request,
    ): {
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
      } else if (typeof routeOpts === 'string') {
        // specifying bucket as string
        opts.buckets = [routeOpts];
      } else if (Array.isArray(routeOpts)) {
        // specifying array of buckets
        opts.buckets = routeOpts;
      } else {
        // providing a literal object
        Object.assign(opts, routeOpts);
      }

      if (opts.enabled) {
        opts.buckets = opts.buckets.concat(options.default);
        opts.enabled =
          !(options.exclude(req) || opts.exclude(req)) &&
          opts.buckets.length + options.default.length > 0;
      }
      return opts;
    }

    /**
     * Returns the bucket used to rate limit the specified response.
     */
    const matchBucket = (
      info: IYaralInternalData,
      res: ResponseObject,
    ): {
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
    const addHeaders = (
      res: Boom.Output | ResponseObject,
      headers: { [key: string]: string | number },
    ) => {
      if (options.includeHeaders) {
        Object.assign(res.headers, headers);
      }
    };

    class TimeoutError extends Error {}

    const getRequestLogDetails = (
      err: Error,
      req: Request,
      isTimedout: boolean,
      duration: number,
    ) => {
      return {
        name: 'yaral-timeout',
        url: req.url.href || '',
        duration: duration,
        success: !err,
        properties: {
          error: err ? err.stack : '',
          isTimedout: isTimedout,
        },
      };
    };

    async function createTimeout<T>(call: () => Promise<T>, req: Request): Promise<T> {
      const startTime = Date.now();
      const p = call();
      if (!options.timeout.enabled) {
        return p;
      }
      try {
        const v = await Promise.race([
          p,
          new Promise<never>((_res, reject) => {
            setTimeout(() => {
              // handle the request timeout
              reject(new TimeoutError('Call Timed Out'));
            }, options.timeout.timeout);
          }),
        ]);
        server.log(
          ['ratelimit', 'timeout'],
          getRequestLogDetails(null, req, false, Date.now() - startTime),
        );
        return v;
      } catch (e) {
        server.log(
          ['ratelimit', 'timeout'],
          getRequestLogDetails(e, req, true, Date.now() - startTime),
        );
        throw e;
      }
    }

    //Appropriately handles different types of Errors
    const handleError = (err: Error, req: Request, reply: ResponseToolkit) => {
      //In case there is a redis timeout continue executing
      //did not put it in the same block as Limitus.Rejected for the sake of future logging
      if (err instanceof TimeoutError) {
        options.timeout.ontimeout.call(this, req, reply);
        server.log(
          ['ratelimit', 'timeout'],
          getRequestLogDetails(err, req, true, options.timeout.timeout),
        );
        // REVIEW: Bad?
        return reply.continue;
      }

      if (!(err instanceof Limitus.Rejected)) {
        server.log(['error', 'ratelimit'], err);
      }

      // Internal errors should not halt everything.
      return reply.continue;
    };

    server.ext(options.event, async (req: Request, reply) => {
      const opts = resolveRouteOpts(req);
      if (opts.enabled === false) {
        return reply.continue;
      }

      const info = {
        buckets: opts.buckets,
        ids: opts.buckets.map(b => buckets[b].identify(req)),
        limited: false,
      };
      req.plugins.yaral = info;
      try {
        await Promise.all(
          info.buckets.map((name, i) =>
            createTimeout(() => limitus.checkLimited(name, info.ids[i]), req),
          ),
        );
        options.onPass(req);
        return reply.continue;
      } catch (err) {
        //Internal Error or Timeout Error
        if (!(err instanceof Limitus.Rejected)) {
          return handleError(err, req, reply);
        }

        // Continue the request if onLimit dictates that we cancel limiting.
        if (options.onLimit(req, err.info, err.bucketName) === cancel) {
          return reply.continue;
        }

        info.limited = true;
        const res = Boom.tooManyRequests();
        addHeaders(res.output, {
          'X-RateLimit-Remaining': 0,
          'X-RateLimit-Reset': err.bucketName,
        });
        throw res;
      }
    });

    server.ext('onPreResponse', async (req, reply) => {
      const res = (<Boom<any>>req.response).output || <ResponseObject>req.response;
      const opts = req.plugins.yaral && matchBucket(req.plugins.yaral, <ResponseObject>res);
      if (!opts || req.plugins.yaral.limited) {
        return reply.continue;
      }
      try {
        const data = await createTimeout(() => limitus.drop(opts.bucket.name(), opts.id), req);
        addHeaders(res, opts.bucket.headers(data));
        return reply.continue;
      } catch (err) {
        return handleError(err, req, reply);
      }
    });
  },
  pkg: require('../package'),
};
