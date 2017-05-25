# Yaral 

[![Build Status](https://img.shields.io/travis/mixer/yaral.svg?style=flat-square)](https://travis-ci.org/mixer/yaral)

Yaral is Yet Another RAte Limit plugin for Hapi. But, unlike others, it does several nice things!
 - Integrates with you server's Catbox cache
 - Allows you to limit with custom attributes, not just the user's IP.
 - Allows you to limit certain responses, add limiting globally, and adjust the limiting endpoint-by-endpoint

### Concepts

 * The entire server can be limited under one rule, and additionally routes can provide their own limiting rules that are _appended_ to the global rule.
 * Each rule has a list of status codes that it can limit. This allows you to, for example, limit invalid response codes at a lower rate than successful response codes. Responses "bubble up" to the first rule that can handle them. If no rules handle that code, it will not be limited.
 * Limit rules are specified using a maximum number of requests per unit time, similar to the way the Twitter API works.

### Configuration

The following options are available when you register Yaral:
 - `buckets` is an array of interval/mode config for [Limitus](https://github.com/MCProHosting/limitus#limitusrulename-rule) intervals. Each item should have:
    - An identifying `name`
    - An `interval` that allows a `max` number of requests.
    - A `mode` as described in the Limitus documentation. Either `interval` or `continuous`. Defaults to `interval`.
    - An `id` function that takes a Hapi request object and returns a string, number or object that identifies the requester.
    - A list of `codes` that specify response codes that count towards this bucket's limit. Responses not in this range will not be limited. Defaults to `['2xx', '3xx']`. *Tip:* to limit all responses, use `['xxx']`.
 - `default` is a bucket `name` or array of names of the bucket applied to all routes. Defaults to `[]`. Buckets are matched first to last.
 - `cache` is the cache name (as configured in the Hapi server) used to store rate limiting data. Defaults to the server's default cache.
 - `enabled` is a boolean whether to enable rate limiting. Useful to disable limiting in tests and development. Default to `true`.
 - `includeHeaders` specifies whether rate limit headers should be included in the response.
 - `limitus` is a Limitus instance to use for this rate limiting. Defaults to `new Limitus()`.
 - `exclude` is a function, called with the `request` object that returns true if the provided request should be omitted from limiting.
 - `onPass` is a function called with the `request` object with a successful request is made which is not rate limited.
 - `onLimit` is a function called with the `request` object, `rule` name that failed, and extra `data` that rule returns when a request is made which does get rate limited. You may return `yaral.cancel` from this method to cause the specific request not to be rate limited.

You can also configure options on a per-route basis in `config.plugins.yaral`:
 - `buckets` specifies the bucket `name` or array of of the rate limit buckets to use in addition to the configured `default` rules. Buckets are matched first to last.
 - `enabled` is a boolean which allows you to override a true `enabled` global configuration. This can be used to exclude routes from global rate limits. Defaults to `true`.
 - `exclude` functions similarly to the `exclude` above. If both a route-level and a global exclude passed, the request will be excluded if _either_ return true.

Alternately, for routes, you can specify a single string or array as a shorthand for buckets.
