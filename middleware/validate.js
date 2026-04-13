const { ZodError } = require('zod');

// Generic validator factory — validates req.body against a Zod schema.
// On success, replaces req.body with the parsed (coerced + stripped) result.
const validateBody = (schema) => (req, res, next) => {
  try {
    req.body = schema.parse(req.body);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      return res.status(400).json({ message: 'Validation failed.', errors: details });
    }
    next(err);
  }
};

const validateParams = (schema) => (req, res, next) => {
  try {
    req.params = schema.parse(req.params);
    next();
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      return res.status(400).json({ message: 'Validation failed.', errors: details });
    }
    next(err);
  }
};

module.exports = { validateBody, validateParams };
