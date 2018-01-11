/**
 * Like async.parallel.
 */
export function all(
  fns: ((cb: (err?: Error) => void) => void)[],
  callback: (error?: Error, ...args: any[]) => void,
) {
  let todo = fns.length;
  const cb = function(err: Error) {
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
}
