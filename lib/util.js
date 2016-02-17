'use strict';

/**
 * Like async.parallel.
 * @param  {[]Function}   fns
 * @param  {Function} callback
 */
exports.all = function (fns, callback) {
    let todo = fns.length;
    const cb = function (err) {
        if (err) {
            todo = -1;
            return callback.apply(this, arguments);
        }

        todo--;
        if (todo === 0) {
            callback();
        }
    };

    for (let i = 0; i < fns.length; i++) {
        // return values from async functions are generally meaningless
        fns[i](cb);
    }
};
