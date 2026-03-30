function asyncRoute(handler) {
  return function wrappedAsyncRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = {
  asyncRoute,
};
