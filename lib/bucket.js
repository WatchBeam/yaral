'use strict';

const Joi = require('joi');

const assign = require('lodash.assign');


const schema = Joi.object().keys({
    name: Joi.string().required(),
    interval: Joi.number().integer().required(),
    max: Joi.number().integer().required(),
    id: Joi.func().required(),
    codes: Joi.array().items(Joi.string().regex(/^[0-9x]{3}$/)).required(),
});


/**
 * Returns whether the status code matches the pattern, which can contain
 * placeholder `x`'s.
 *
 * @param  {Strign} pattern
 * @param  {String} code
 * @return {Boolean}
 */
function codeMatches(pattern, code) {
    for (let k = 0; k < 3; k++) {
        if (pattern[k] !== 'x' && code[k] !== pattern[k]) {
            return false;
        }
    }

    return true;
}


module.exports = class Bucket {

    constructor(_options, limitus) {
        const options = assign({ codes: ['2xx', '3xx'] }, _options);

        Joi.assert(options, schema);

        this.limitus = limitus;
        this.options = options;

        limitus.rule(options.name, {
            max: options.max,
            interval: options.interval,
            mode: 'interval'
        });
    }

    /**
     * Returns this bucket's name.
     * @return {String}
     */
    name() {
        return this.options.name;
    }

    /**
     * Returns this bucket's max requests per interval.
     * @return {String}
     */
    max() {
        return this.options.max;
    }

    /**
     * Returns an identifying value for the provided request.
     * @param  {Hapi.Request} req
     * @return {*}
     */
    identify(req) {
        return this.options.id(req);
    }

    /**
     * Returns whether this bucket can handle the provided status code.
     * @param  {Number} status
     * @return {Boolean}
     */
    matches(status) {
        const target = String(status);
        const codes = this.options.codes;
        for (let i = 0; i < codes.length; i++) {
            if (codeMatches(codes[i], target)) {
                return true;
            }
        }

        return false;
    }
}
