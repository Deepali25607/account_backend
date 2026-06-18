/**
 * Opt-in pagination helper. List endpoints stay backward-compatible: with no
 * `page` query param they return a plain array (as before); with `?page=` they
 * return { rows, total, page, pageSize }. Keeps dropdowns, tests and the demo
 * generator working unchanged while the main list screens paginate.
 */
const wantsPage = (req) => req.query.page !== undefined;

function pageParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

module.exports = { wantsPage, pageParams };
