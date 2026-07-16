/**
 * Wrap an async Express handler so a thrown/rejected error is forwarded to
 * next() instead of becoming an unhandled promise rejection. Express 4
 * doesn't await async handlers, so without this, an error in a route
 * crashes the whole process rather than just failing that one request.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
