function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'missing authorization header' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: 'invalid authorization format' });
  }

  const token = parts[1].trim();
  if (!token) {
    return res.status(401).json({ error: 'empty token' });
  }

  // Simple auth: token IS the user_id
  req.userId = token;
  next();
}

module.exports = authMiddleware;
