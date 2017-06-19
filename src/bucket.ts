import { IBucketOptions } from './yaral';
import * as Joi from 'joi';
import { Request } from 'hapi';

const schema = Joi.object().keys({
    name: Joi.string().required(),
    interval: Joi.number().integer().positive().required(),
    mode: Joi.string().valid('continuous', 'interval').optional(),
    max: Joi.number().integer().positive().required(),
    id: Joi.func().required(),
    codes: Joi.array().items(Joi.string().regex(/^[0-9x]{3}$/)).required(),
});

/**
 * Returns whether the status code matches the pattern, which can contain
 * placeholder `x`'s.
 */
function codeMatches (pattern: string, code: string): boolean {
    for (let k = 0; k < 3; k++) {
        if (pattern[k] !== 'x' && code[k] !== pattern[k]) {
            return false;
        }
    }

    return true;
}

export class Bucket {
    private mode: 'interval' | 'continious';

    constructor (private options: IBucketOptions, limitus: any) {
        options.codes = options.codes || ['2xx', '3xx'];

        Joi.assert(options, schema);

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
     * @param [data] from limitus.drop's callback
     */
    public headers (data: { bucket: string; count: number; }): {
        [key: string]: string | number;
    } {
        const headers: {
            [key: string]: string | number;
        } = { 'X-Rate-Limit': this.options.max };
        if (this.mode === 'interval') {
            headers['X-RateLimit-Remaining'] = Math.max(this.options.max - data.count, 0);
            headers['X-RateLimit-Reset'] = data.bucket;
        }

        return headers;
    }

    /**
     * Returns this bucket's name.
     */
    public name (): string {
        return this.options.name;
    }

    /**
     * Returns this bucket's max requests per interval.
     */
    public max (): number {
        return this.options.max;
    }

    /**
     * Returns an identifying value for the provided request.
     */
    public identify (req: Request): string | number | object {
        return this.options.id(req);
    }

    /**
     * Returns whether this bucket can handle the provided status code.
     */
    public matches (status: number): boolean {
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
