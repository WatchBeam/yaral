'use strict';

const Joi = require('joi');

const schema = Joi.object().keys({
    name: Joi.string().required(),
    interval: Joi.number().integer().required(),
    mode: Joi.string().optional(),
    max: Joi.number().integer().required(),
    id: Joi.func().required(),
    codes: Joi.array().items(Joi.string().regex(/^[0-9x]{3}$/)).required(),
});


/**
 * Returns whether the status code matches the pattern, which can contain
 * placeholder `x`'s.
 *
 * @param  {String} pattern
 * @param  {String} code
 * @return {Boolean}
 */
function codeMatches (pattern, code) {
    for (let k = 0; k < 3; k++) {
        if (pattern[k] !== 'x' && code[k] !== pattern[k]) {
            return false;
        }
    }

    return true;
}


module.exports = class Bucket {

    constructor (_options, limitus) {
        const options = Object.assign({ codes: ['2xx', '3xx'] }, _options);

        Joi.assert(options, schema);

        this.limitus = limitus;
        this.options = options;
        this.mode = options.mode || 'interval';

        limitus.rule(options.name, {
            max: options.max,
            interval: options.interval,
            mode: this.mode,
        });
    }

    /**
     * headers is invoked after a successful limitus.drop() and is
     * used to insert information about the limit into the response.
     * @param {Object} [data] from limitus.drop's callback
     * @return {Object}
     */
    headers (data) {
        const headers = { 'X-Rate-Limit': this.options.max };
        if (this.mode === 'interval') {
            headers['X-RateLimit-Remaining'] = Math.max(this.options.max - data.count, 0);
            headers['X-RateLimit-Reset'] = data.bucket;
        }

        return headers;
    }

    /**
     * Returns this bucket's name.
     * @return {String}
     */
    name () {
        return this.options.name;
    }

    /**
     * Returns this bucket's max requests per interval.
     * @return {String}
     */
    max () {
        return this.options.max;
    }

    /**
     * Returns an identifying value for the provided request.
     * @param  {Hapi.Request} req
     * @return {*}
     */
    identify (req) {
        return this.options.id(req);
    }

    /**
     * Returns whether this bucket can handle the provided status code.
     * @param  {Number} status
     * @return {Boolean}
     */
    matches (status) {
        const target = String(status);
        const codes = this.options.codes;
        for (let i = 0; i < codes.length; i++) {
            if (codeMatches(codes[i], target)) {
                return true;
            }
        }

        return false;
    }
};
